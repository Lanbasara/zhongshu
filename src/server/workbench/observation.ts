// Layer 3 (ADR 0024): the observation kernel. One in-memory runtime per observed conversation holds native
// events, the latest native page (ADR 0014) and the live stream (ADR 0019). The kernel knows no capability:
// it rings participants (participant.ts) after each fact and asks them whether a conversation must stay observed.
import type { NativeItem } from '../../harness/types.ts';
import type { ConversationUsage, LiveCursor, LiveEvent, WorkbenchItem } from '../../shared/workbench.ts';
import { StoreError, type Conversation, type Operation, type WorkbenchStore } from '../workbench-store.ts';
import type { Bindings } from './bindings.ts';
import type { Gate } from './gate.ts';
import type { History } from './history.ts';
import { TERMINAL, type Ledger } from './ledger.ts';
import { LiveStream, type SentBodies } from './live.ts';
import { historyErrorCode, liveMark, pageMark, readPage, viewItem, wrapCursor } from './pages.ts';
import type { Participant, Ports } from './participant.ts';
import type { Tasks } from './tasks.ts';

/** Live items beyond this count prompt a fresh latest-page read; the hard limit drops settled copies. */
const LIVE_SYNC_THRESHOLD = 64;
const LIVE_LIMIT = 256;
const LIVE_VIEW_LIMIT = 100;
/** Consecutive latest pages that overlap are joined in memory up to this many items. */
const TAIL_LIMIT = 200;
/** An unobserved latest page is reused only briefly; observed pages follow native events. */
const TAIL_FRESH_MS = 2000;
const LOOKUP_PAGES = 5;
const RUNTIME_LIMIT = 64;

/** The latest native page and in-flight items live only in memory (ADR 0014). */
export type Tail = { items: NativeItem[]; olderCursor: string | null; at: number; error?: string };
export type TailRead = { items: NativeItem[]; olderCursor: string | null; startedAt: number; usage?: ConversationUsage };
type Runtime = {
  stop?: () => void; watching?: Promise<void>; syncing?: Promise<void>; reading?: Promise<void>;
  timer?: NodeJS.Timeout; retry?: NodeJS.Timeout; flush?: NodeJS.Timeout; release?: NodeJS.Timeout;
  retryAttempt: number;
  live: Map<string, NativeItem>; generation: number; stateGeneration: number; dirty: boolean;
  /** Last body mark announced for each live item, so unchanged items are not re-announced. */
  flushed: Map<string, string>;
  /** When each live item last changed; settled copies older than a latest-page read retire. */
  liveAt: Map<string, number>;
  tail?: Tail;
  /** Bodies last sent per live item, so the next frame carries only what was appended (ADR 0019). */
  sent: SentBodies;
};
/** What other modules may read of a runtime; only the kernel changes it. */
export type RuntimeView = Readonly<Pick<Runtime, 'stop' | 'watching' | 'syncing' | 'reading' | 'dirty' | 'stateGeneration' | 'tail'>>;

type Deps = { store: WorkbenchStore; tasks: Tasks; bindings: Bindings; gate: Gate; ledger: Ledger; history: History };

export class Observation {
  private readonly store: WorkbenchStore;
  private readonly tasks: Tasks;
  private readonly bindings: Bindings;
  private readonly gate: Gate;
  private readonly ledger: Ledger;
  private readonly history: History;
  private readonly runtimes = new Map<string, Runtime>();
  private participants: readonly Participant[] = [];
  private ports?: Ports;
  private readonly live = new LiveStream();
  /** Items observed in a conversation, for matchers such as agent notifications (ADR 0021). Never stores bodies. */
  private readonly observedListeners = new Set<(id: string, items: NativeItem[]) => void>();
  private recoveryCursor = '';
  private recoveryComplete = false;

  constructor(deps: Deps) {
    this.store = deps.store; this.tasks = deps.tasks; this.bindings = deps.bindings;
    this.gate = deps.gate; this.ledger = deps.ledger; this.history = deps.history;
  }
  connect(ports: Ports, participants: readonly Participant[]): void { this.ports = ports; this.participants = participants; }

  onLive(listener: (frames: LiveEvent[]) => void): () => void { return this.live.onLive(listener); }
  liveCursor(): LiveCursor { return this.live.cursor(); }
  onObserved(listener: (id: string, items: NativeItem[]) => void): () => void { this.observedListeners.add(listener); return () => { this.observedListeners.delete(listener); }; }

  has(id: string): boolean { return this.runtimes.has(id); }
  slot(id: string): RuntimeView | undefined { return this.runtimes.get(id); }
  /** A caller that just published a native state it read itself fences reads started before it. */
  bumpState(id: string): void { const runtime = this.runtimes.get(id); if (runtime) runtime.stateGeneration++; }
  /** The latest page and the live items in memory, or nothing when no runtime is open. */
  items(id: string): NativeItem[] | undefined {
    const runtime = this.runtimes.get(id);
    return runtime ? [...(runtime.tail?.items ?? []), ...runtime.live.values()] : undefined;
  }
  messageAllowed(conversation: Conversation, current?: Operation, freshState = false): boolean {
    return this.ledger.messageAllowed(conversation, !!this.runtimes.get(conversation.id)?.dirty, current, freshState);
  }
  idleWithConfigurationMismatch(conversation: Conversation): boolean {
    return this.ledger.idleWithConfigurationMismatch(conversation, !!this.runtimes.get(conversation.id)?.dirty);
  }

  /**
   * Native activity Zhongshu did not start, such as an automation delivery (ADR 0021). Observe it like a sent
   * message: the native state read here keeps observation while it runs, so running, unread and push follow.
   */
  async noticeActivity(id: string): Promise<void> {
    if (this.tasks.closed || this.gate.isDeleting(id)) return;
    const conversation = this.store.getConversation(id);
    if (!conversation?.binding || conversation.archived || !this.bindings.configured(conversation) || this.gate.executionBlocked(conversation.cwd)) return;
    await this.observe(id); await this.sync(id);
  }

  /** The conversation still owes execution facts, so it must stay observed. */
  responsible(id: string): boolean {
    const conversation = this.store.getConversation(id);
    if (!conversation) return false;
    if ([...(this.runtimes.get(id)?.live.values() ?? [])].some(item => item.status === 'running')) return true;
    if (this.gate.preparing(id) || this.gate.busy(id) || conversation.state.pendingInputs ||
      ['running', 'waiting', 'unknown'].includes(conversation.state.status)) return true;
    return this.participants.some(participant => participant.responsible?.(id, conversation));
  }
  private reading(id: string): boolean { return this.participants.some(participant => participant.reading?.(id)); }
  private retains(id: string): boolean { return this.participants.some(participant => participant.retains?.(id)); }

  /** Re-establish observation for a conversation with execution responsibility, or finish its creation. */
  restore(id: string): Promise<void> {
    if (this.gate.isDeleting(id)) return Promise.resolve();
    const conversation = this.bindings.conversation(id);
    if (conversation.nativePreparationId) return this.ports!.prepare(conversation);
    return this.tasks.task(async () => {
      try {
        await this.observe(id); await this.sync(id);
        for (const participant of this.participants) participant.restored?.(id);
      }
      catch { if (!this.tasks.closed) { this.unknown(id, 'native_observation_unavailable'); const runtime = this.runtimes.get(id); if (runtime) this.retryUnknown(id, runtime); } }
    });
  }
  /** One bounded recovery pass: all execution responsibility once after startup, then only the durable queue. */
  restorePending(): void {
    if (this.tasks.closed) return;
    // Idle history is never restored.
    const pending = this.recoveryComplete
      ? this.store.queuedConversations(this.recoveryCursor)
      : this.store.recoverableConversations(this.recoveryCursor);
    for (const id of pending) {
      if (this.runtimes.has(id) || this.gate.isDeleting(id)) { this.recoveryCursor = id; continue; }
      const conversation = this.bindings.conversation(id);
      if (!conversation.binding && !conversation.nativePreparationId && conversation.readiness === 'preparing') {
        this.store.setConversationState(id, { readiness: 'blocked', error: 'native_creation_result_unknown' });
        this.recoveryCursor = id; continue;
      }
      if (!this.bindings.configured(conversation)) {
        try { this.bindings.adapter(conversation); } catch { /* saved blocked state */ }
        this.recoveryCursor = id; continue;
      }
      if ((!conversation.binding && !conversation.nativePreparationId) || this.bindings.workspaceUnavailable(conversation.workspaceId) ||
        this.gate.executionBlocked(conversation.cwd)) { this.recoveryCursor = id; continue; }
      try { this.runtime(id); } catch { return; }
      this.recoveryCursor = id;
      this.tasks.launch(this.restore(id));
    }
    if (pending.length < 64) { this.recoveryCursor = ''; this.recoveryComplete = true; }
  }

  /** The memory view of a conversation for its snapshot; `direct` is a page read without a runtime. */
  view(id: string, direct?: Tail) {
    const runtime = this.runtimes.get(id); const tail = runtime?.tail ?? direct;
    const items = (tail?.items ?? []).map(viewItem);
    const live = [...(runtime?.live.values() ?? [])];
    const liveItems = live.slice(-LIVE_VIEW_LIMIT).map(viewItem);
    const runIds = new Set<string>();
    for (const item of [...items, ...liveItems].reverse()) if (item.runId) runIds.add(item.runId);
    const history = { items, liveItems, liveItemsLimited: live.length > LIVE_VIEW_LIMIT,
      olderCursor: wrapCursor(id, tail?.olderCursor ?? null), loaded: !!tail && !tail.error, ...(tail?.error ? { error: tail.error } : {}) };
    return { history, items: [...items, ...liveItems], runIds: [...runIds] };
  }
  /** The newest version of a live or latest-page item, for change frames. */
  liveItem(id: string, itemId: string): WorkbenchItem | null {
    const runtime = this.runtimes.get(id);
    const item = runtime?.live.get(itemId) ?? runtime?.tail?.items.find(value => value.id === itemId);
    return item ? viewItem(item) : null;
  }
  private findItem(id: string, itemId: string): NativeItem | undefined {
    const runtime = this.runtimes.get(id);
    return runtime?.live.get(itemId) ?? runtime?.tail?.items.find(item => item.id === itemId) ?? this.history.served(id, itemId);
  }
  /** Verify against native history: memory first, then a bounded walk back from the latest page. */
  async locateItem(id: string, itemId: string): Promise<NativeItem | undefined> {
    const found = this.findItem(id, itemId); if (found) return found;
    const conversation = this.bindings.conversation(id); const adapter = this.bindings.historyAdapter(conversation);
    if (!adapter) return undefined;
    let cursor: string | undefined;
    for (let number = 0; number < LOOKUP_PAGES; number++) {
      const page = await readPage(conversation, adapter, cursor);
      const item = page.items.find(value => value.id === itemId);
      if (item) { this.history.remember(id, [item]); return item; }
      if (!page.olderCursor) return undefined;
      cursor = page.olderCursor;
    }
    return undefined;
  }

  ensureTail(id: string): Promise<void> {
    const conversation = this.bindings.conversation(id);
    if (!this.bindings.historyAdapter(conversation) || this.gate.isDeleting(id) || this.tasks.closed) return Promise.resolve();
    let runtime: Runtime;
    try { runtime = this.runtime(id); } catch { return Promise.resolve(); }
    const tail = runtime.tail;
    if (tail && !tail.error && (runtime.stop || Date.now() - tail.at < TAIL_FRESH_MS)) return Promise.resolve();
    if (runtime.syncing) return runtime.syncing.catch(() => {});
    if (!runtime.reading) {
      const reading = this.tasks.task(async () => {
        try { this.applyTail(id, runtime, await this.readTail(id)); }
        catch (error) { this.failTail(id, runtime, error); }
      });
      runtime.reading = reading;
      void reading.finally(() => { if (runtime.reading === reading) runtime.reading = undefined; this.release(id); });
    }
    return runtime.reading;
  }
  async readTail(id: string): Promise<TailRead> {
    const conversation = this.bindings.conversation(id); const adapter = this.bindings.historyAdapter(conversation);
    if (!adapter) throw new StoreError('conversation_not_ready', 409);
    const startedAt = Date.now();
    const page = await readPage(conversation, adapter, undefined);
    this.tasks.assertOpen();
    return { items: await this.history.present(conversation, page.items), olderCursor: page.olderCursor, startedAt, ...(page.usage ? { usage: page.usage } : {}) };
  }
  private applyTail(id: string, runtime: Runtime, read: TailRead): void {
    if (this.tasks.closed || this.runtimes.get(id) !== runtime || this.gate.isDeleting(id)) return;
    const previous = runtime.tail;
    let items = read.items; let olderCursor = read.olderCursor;
    // Join an overlapping previous latest page so items that scrolled out of the newest page stay contiguous.
    if (previous && !previous.error && items.length) {
      const overlap = previous.items.findIndex(item => item.id === items[0]!.id);
      if (overlap > 0 && overlap + items.length <= TAIL_LIMIT) { items = [...previous.items.slice(0, overlap), ...items]; olderCursor = previous.olderCursor; }
    }
    const present = new Map(items.map(item => [item.id, item]));
    for (const [key, live] of runtime.live) {
      const item = present.get(key);
      if (!item) {
        // A settled copy that predates this read and is absent from the contiguous latest page is older history now.
        if (live.status !== 'running' && (runtime.liveAt.get(key) ?? 0) < read.startedAt) this.retireLive(runtime, key);
        continue;
      }
      // A completed canonical item retires its live copy; a newer live body otherwise keeps precedence by identity.
      const sameBody = item.kind === live.kind && item.text === live.text && item.runId === live.runId && item.operationId === live.operationId;
      if ((live.status === 'running' && item.status === 'completed') || (sameBody && (item.status === live.status || item.status === 'completed'))) this.retireLive(runtime, key);
      else if (item.fileEdits && live.runId === item.runId && live.status === 'completed') runtime.live.set(key, { ...live, fileEdits: item.fileEdits });
    }
    runtime.tail = { items, olderCursor, at: Date.now() };
    // Compared with the durable mark, not this runtime's previous page: a fresh runtime re-reading unchanged history announces nothing.
    const changed = this.store.markNative(id, pageMark(items, olderCursor));
    // A run can finish before observation starts (a fast automation run in a new session); what it did is then only in
    // history, so a changed latest page is shown to the observers too (ADR 0021).
    if (changed) for (const listener of this.observedListeners) { try { listener(id, items); } catch { /* a matcher cannot break observation */ } }
    for (const participant of this.participants) participant.noticed?.(id);
  }
  private retireLive(runtime: Runtime, key: string): void { runtime.live.delete(key); runtime.flushed.delete(key); runtime.liveAt.delete(key); runtime.sent.delete(key); }
  private failTail(id: string, runtime: Runtime, error: unknown): void {
    if (this.tasks.closed || this.runtimes.get(id) !== runtime || this.gate.isDeleting(id)) return;
    // Reading failures keep already loaded content and never fence execution by themselves.
    const code = historyErrorCode(error);
    if (runtime.tail?.error === code) { runtime.tail.at = Date.now(); return; }
    runtime.tail = { items: runtime.tail?.items ?? [], olderCursor: runtime.tail?.olderCursor ?? null, at: Date.now(), error: code };
    this.store.markNative(id, 'error:' + code);
  }

  private unknown(id: string, reason: string): void {
    const current = this.bindings.conversation(id);
    this.store.setConversationState(id, { error: reason, ...(reason === 'codex_configuration_mismatch' ? { readiness: 'blocked' as const } : {}),
      state: { status: 'unknown', pendingInputs: current.state.pendingInputs,
      configurationVerified: false, reason, ...(current.state.runId ? { runId: current.state.runId } : {}) } });
    // What came from the same lost observation can no longer be vouched for.
    for (const participant of this.participants) participant.lost?.(id);
  }
  private retryUnknown(id: string, runtime: Runtime): void {
    if (this.tasks.closed || this.gate.isDeleting(id) || this.runtimes.get(id) !== runtime || runtime.retry) return;
    const current = this.store.getConversation(id);
    // Recovery only: ordinary live execution relies on native events, never timer silence.
    if (!current || (!this.responsible(id) && current.state.status !== 'unknown') || ['running', 'waiting'].includes(current.state.status)) return;
    runtime.retry = setTimeout(() => {
      runtime.retry = undefined;
      if (this.runtimes.get(id) === runtime && !this.gate.isDeleting(id)) this.tasks.launch(this.ports!.recover(id).catch(() => {
        if (!this.tasks.closed && this.runtimes.get(id) === runtime) { this.unknown(id, 'native_observation_unavailable'); this.retryUnknown(id, runtime); }
      }));
    }, Math.min(60_000, 1000 * 2 ** Math.min(runtime.retryAttempt++, 6)));
    runtime.retry.unref();
  }
  /** Close the runtime shortly once nothing needs it; any later need reopens it. */
  release(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime || this.tasks.closed || runtime.release || this.gate.isDeleting(id)) return;
    if (this.needed(id, runtime)) return;
    runtime.release = setTimeout(() => {
      runtime.release = undefined;
      if (this.runtimes.get(id) !== runtime || this.needed(id, runtime)) return;
      this.flushLive(id, runtime);
      this.dispose(id);
    }, 250);
    runtime.release.unref();
  }
  private needed(id: string, runtime: Runtime): boolean {
    return !!(runtime.syncing || runtime.watching || runtime.reading || runtime.dirty) || this.reading(id) || this.retains(id) || this.responsible(id);
  }
  private runtime(id: string): Runtime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      if (this.runtimes.size >= RUNTIME_LIMIT) {
        const idle = [...this.runtimes].find(([key, value]) => !value.syncing && !value.watching && !value.reading && !this.gate.preparing(key) &&
          !this.gate.busy(key) && !this.reading(key) && !this.responsible(key));
        if (!idle) throw new StoreError('active_conversation_limit', 429);
        this.dispose(idle[0]);
      }
      runtime = { live: new Map(), flushed: new Map(), liveAt: new Map(), generation: 0, stateGeneration: 0, dirty: false, retryAttempt: 0, sent: new Map() };
      this.runtimes.set(id, runtime);
      for (const participant of this.participants) participant.created?.(id);
    }
    return runtime;
  }
  /** Announce in-flight changes of this conversation now. */
  flush(id: string): void { const runtime = this.runtimes.get(id); if (runtime) this.flushLive(id, runtime); }
  private flushLive(id: string, runtime: Runtime): void {
    if (this.tasks.closed || this.runtimes.get(id) !== runtime) return;
    runtime.flush = undefined;
    // Live bodies stay in memory; only change hints (and edited paths) are persisted (ADR 0014).
    try {
      const changed: NativeItem[] = [];
      for (const item of runtime.live.values()) {
        const mark = liveMark(item);
        if (runtime.flushed.get(item.id) === mark) continue;
        runtime.flushed.set(item.id, mark); changed.push(item);
      }
      if (changed.length) {
        this.store.recordTurnFiles(id, changed);
        for (const listener of this.observedListeners) { try { listener(id, changed); } catch { /* a matcher cannot break observation */ } }
        // In-flight growth is not a durable fact: it travels as appended text on the live stream and is never stored (ADR 0019).
        this.live.publish(id, runtime.sent, changed);
      }
      for (const participant of this.participants) participant.noticed?.(id);
    } catch { this.scheduleSync(id); }
  }
  observe(id: string): Promise<void> {
    if (this.tasks.closed) return Promise.resolve();
    const conversation = this.bindings.conversation(id); const adapter = this.bindings.adapter(conversation);
    if (!conversation.binding) return Promise.resolve();
    const runtime = this.runtime(id);
    if (runtime.release) { clearTimeout(runtime.release); runtime.release = undefined; }
    if (runtime.stop) return Promise.resolve(); if (runtime.watching) return runtime.watching;
    runtime.watching = this.tasks.task(async () => {
      const stop = await adapter.watch(conversation.binding!, change => {
        if (this.tasks.closed || this.gate.isDeleting(id) || this.runtimes.get(id) !== runtime) return;
        try {
          if (change.type === 'usage') { this.store.setUsage(id, change.usage); return; }
          if (change.type === 'subagents' || change.type === 'requests') { for (const participant of this.participants) participant.hint?.(id, change); return; }
          runtime.generation++;
          if (change.type === 'item') {
            if (change.item.imageSources?.length) { this.scheduleSync(id); return; }
            if (change.item.kind === 'user' && change.item.operationId) {
              const operation = this.store.getOperation(change.item.operationId);
              if (operation?.type === 'message' && operation.conversationId === id) {
                change.item.text = operation.payload.text;
                change.item.images = operation.payload.images;
                change.item.references = operation.payload.references;
              }
            }
            const prior = runtime.live.get(change.item.id);
            if (change.item.tool && prior?.tool) {
              change.item.tool = { ...prior.tool, ...change.item.tool, name: prior.tool.name };
              if (!change.item.text) change.item.text = prior.text;
              if (change.item.tool.exitCode !== undefined && change.item.tool.exitCode !== 0) change.item.status = 'failed';
            }
            runtime.live.set(change.item.id, change.item); runtime.liveAt.set(change.item.id, Date.now());
            // Many in-flight items prompt a fresh latest page, which retires settled live copies.
            if (runtime.live.size >= LIVE_SYNC_THRESHOLD) this.scheduleSync(id);
            if (runtime.live.size > LIVE_LIMIT) for (const [key, value] of runtime.live) {
              if (runtime.live.size <= LIVE_LIMIT) break;
              if (value.status !== 'running') this.retireLive(runtime, key);
            }
            if (!runtime.flush) { runtime.flush = setTimeout(() => this.flushLive(id, runtime), 40); runtime.flush.unref(); }
            if (runtime.syncing) runtime.dirty = true;
          } else {
            runtime.stateGeneration++;
            if (change.type === 'state') {
              // A live event never carries the result Workbench verified for a later run; keep it while that run is current.
              const kept = this.store.getConversation(id)?.state.latest;
              this.store.setConversationState(id, { state: kept && kept.runId === change.state.runId && !change.state.latest ? { ...change.state, latest: kept } : change.state });
              // An unknown native state means the same observation cannot vouch for what came with it either.
              if (change.state.status === 'unknown') for (const participant of this.participants) participant.lost?.(id);
              if (change.state.configurationVerified && ['running', 'waiting'].includes(change.state.status)) return;
            }
            // Transport loss is a fact, not a hint to wait for a successful read.
            // Keep saved history/identity while fencing reads from before loss.
            if (change.type === 'unavailable') this.unknown(id, change.reason);
            this.scheduleSync(id);
          }
        } catch { this.unknown(id, 'native_update_requires_sync'); this.scheduleSync(id); }
      });
      if (this.tasks.closed || this.runtimes.get(id) !== runtime) stop();
      else { runtime.stop = stop; }
    });
    void runtime.watching.then(() => { runtime.watching = undefined; }, () => { runtime.watching = undefined; });
    return runtime.watching;
  }
  private scheduleSync(id: string): void {
    if (this.tasks.closed || this.gate.isDeleting(id)) return;
    const runtime = this.runtime(id); runtime.dirty = true;
    if (runtime.syncing || runtime.timer) return;
    runtime.timer = setTimeout(() => { runtime.timer = undefined; this.tasks.launch(this.sync(id)); }, 120); runtime.timer.unref();
  }
  sync(id: string): Promise<void> {
    if (this.tasks.closed) return Promise.resolve();
    const conversation = this.bindings.conversation(id); if (!conversation.binding) return Promise.resolve();
    const runtime = this.runtime(id); runtime.dirty = true;
    if (runtime.syncing) return runtime.syncing;
    runtime.syncing = this.tasks.task(async () => {
      if (runtime.reading) await runtime.reading.catch(() => {});
      for (let pass = 0; pass < 3 && runtime.dirty && !this.tasks.closed; pass++) {
        runtime.dirty = false; const stateGeneration = runtime.stateGeneration;
        try {
          const current = this.bindings.conversation(id); const adapter = this.bindings.adapter(current);
          const target = this.ledger.observationTarget(id);
          // Execution state and the latest native page are read together; there is no gap to fill (ADR 0014).
          const [state, history] = await Promise.allSettled([adapter.state(current.binding!, target), this.readTail(id)]);
          if (this.tasks.closed || this.runtimes.get(id) !== runtime) return;
          if (history.status === 'fulfilled') this.applyTail(id, runtime, history.value); else this.failTail(id, runtime, history.reason);
          const currentTarget = this.ledger.observationTarget(id);
          if (runtime.stateGeneration !== stateGeneration || currentTarget !== target) { runtime.dirty = true; continue; }
          if (state.status === 'rejected') throw state.reason;
          // An unverified unknown read never erases last-known run and pending facts; it takes the recovery path.
          if (state.value.status === 'unknown' && !state.value.configurationVerified)
            throw new StoreError(/^[a-z][a-z0-9_]{0,99}$/.test(state.value.reason ?? '') ? state.value.reason! : 'native_state_unavailable', 502);
          // ADR 0021: a later run nobody here started (an automation delivery) has its own verified result. It is read
          // for that exact run and kept apart, so the settled checks of Zhongshu's own messages stay as they were.
          const later = state.value.runId;
          const own = this.ledger.latestAcceptedMessage(id);
          if (later && later !== target && later !== state.value.terminalRunId && TERMINAL.has(state.value.status) &&
            (!own || own.runId === state.value.terminalRunId) && this.ledger.startedElsewhere(id, later)) {
            const verified = await adapter.state(current.binding!, later).catch(() => undefined);
            if (this.tasks.closed || this.runtimes.get(id) !== runtime) return;
            if (verified?.terminalRunId === later && verified.terminalStatus) state.value.latest = { runId: later, status: verified.terminalStatus };
          }
          this.bindings.adapter(this.bindings.conversation(id));
          // Text can arrive faster than native reads. It invalidates history, not a
          // verified state read; newer state/invalidate events still fence both.
          this.store.setConversationState(id, { state: state.value, readiness: state.value.configurationVerified ? 'ready' : 'blocked',
            error: state.value.configurationVerified ? null : state.value.reason === 'codex_configuration_mismatch' ? state.value.reason : 'native_configuration_unverified' });
          for (const participant of this.participants) participant.verified?.(id, state.value, runtime.tail?.items ?? [], current);
          if (state.value.configurationVerified && history.status === 'fulfilled' && history.value.usage) this.store.setUsage(id, history.value.usage);
          if (runtime.flush) { clearTimeout(runtime.flush); this.flushLive(id, runtime); }
          for (const participant of this.participants) participant.synced?.(id, state.value, runtime.tail?.items ?? [], current);
          if (state.value.status !== 'unknown' && !this.responsible(id)) runtime.retryAttempt = 0;
        } catch (error) {
          if (!this.tasks.closed && this.runtimes.get(id) === runtime) this.unknown(id, error instanceof StoreError ? error.code : 'native_state_unavailable');
        }
      }
    });
    const result = runtime.syncing;
    this.tasks.launch(result.then(() => {
      runtime.syncing = undefined;
      if (this.tasks.closed || this.runtimes.get(id) !== runtime) return;
      if (runtime.dirty) this.scheduleSync(id); else for (const participant of this.participants) participant.settled?.(id);
      this.release(id);
      this.retryUnknown(id, runtime);
    }, () => { runtime.syncing = undefined; if (!this.tasks.closed) this.scheduleSync(id); }));
    return result;
  }
  dispose(id: string): void {
    for (const participant of this.participants) participant.disposed?.(id);
    const runtime = this.runtimes.get(id); if (!runtime) return;
    if (runtime.timer) clearTimeout(runtime.timer); if (runtime.retry) clearTimeout(runtime.retry);
    if (runtime.release) clearTimeout(runtime.release); if (runtime.flush) clearTimeout(runtime.flush);
    try { runtime.stop?.(); } finally { this.runtimes.delete(id); }
  }
  /** On shutdown: in-flight bodies are memory only; the native Harness keeps the authoritative history (ADR 0014). */
  disposeAll(): void {
    for (const id of [...this.runtimes.keys()]) {
      try { this.dispose(id); } catch { /* adapter.close still runs */ }
    }
  }
}

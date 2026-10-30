import type { Catalog, HarnessAdapter, HarnessId, HistoryPage, NativeItem, NativeState, Receipt } from '../harness/types.ts';
import type { Workspace } from './harness-config.ts';
import { StoreError, type WorkbenchStore, type CreateConversation, type OperationInput, type Conversation, type Operation } from './workbench-store.ts';

const TERMINAL = new Set<NativeState['status']>(['idle', 'interrupted', 'failed']);
const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_PAGES = 10;
const HISTORY_MAX_BYTES = 16 * 1024 * 1024;
type Runtime = {
  stop?: () => void; watching?: Promise<void>; syncing?: Promise<void>; older?: Promise<void>;
  timer?: NodeJS.Timeout; poll?: NodeJS.Timeout; flush?: NodeJS.Timeout;
  live: Map<string, NativeItem>; generation: number; stateGeneration: number; dirty: boolean;
};
type HistoryRead = { items: NativeItem[]; cursor: string | null; establishCursor: boolean };

/** One application writer. Native execution outlives browser observers and application connections. */
export class Workbench {
  readonly store: WorkbenchStore;
  readonly workspaces: Workspace[];
  private readonly adapters: Map<HarnessId, HarnessAdapter>;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly processing = new Map<string, Promise<void>>();
  private readonly busyConversations = new Map<string, number>();
  private readonly preparing = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;
  private catalogCache?: Catalog[];
  private catalogAt = 0;
  private catalogLoading?: Promise<Catalog[]>;

  constructor(store: WorkbenchStore, workspaces: Workspace[], adapters: Map<HarnessId, HarnessAdapter>) {
    this.store = store; this.workspaces = workspaces; this.adapters = adapters;
  }
  private task<T>(action: () => Promise<T>): Promise<T> {
    const promise = action(); this.tasks.add(promise);
    void promise.then(() => this.tasks.delete(promise), () => this.tasks.delete(promise));
    return promise;
  }
  private launch(promise: Promise<unknown>): void { void promise.catch(() => {}); }
  private assertOpen(): void { if (this.closed) throw new StoreError('workbench_closed', 503); }
  private conversation(id: string): Conversation {
    const conversation = this.store.getConversation(id);
    if (!conversation) throw new StoreError('conversation_not_found', 404);
    return conversation;
  }
  private configured(conversation: Conversation): boolean {
    const workspace = this.workspaces.find(item => item.id === conversation.workspaceId);
    const adapter = this.adapters.get(conversation.harnessId);
    return workspace?.directory === conversation.cwd && adapter?.id === conversation.harnessId;
  }
  private adapter(conversation: Conversation): HarnessAdapter {
    if (!this.configured(conversation)) {
      this.store.setConversationState(conversation.id, { readiness: 'blocked', error: 'conversation_configuration_changed',
        state: { status: 'unknown', pendingInputs: conversation.state.pendingInputs, configurationVerified: false, reason: 'conversation_configuration_changed' } });
      throw new StoreError('conversation_configuration_changed', 409);
    }
    return this.adapters.get(conversation.harnessId)!;
  }
  private unknown(id: string, reason: string): void {
    const current = this.conversation(id);
    this.store.setConversationState(id, { error: reason, state: { status: 'unknown', pendingInputs: current.state.pendingInputs,
      configurationVerified: false, reason, ...(current.state.runId ? { runId: current.state.runId } : {}) } });
  }

  catalogs(): Promise<Catalog[]> {
    this.assertOpen();
    if (this.catalogCache && Date.now() - this.catalogAt < 30_000) return Promise.resolve(this.catalogCache);
    if (!this.catalogLoading) {
      this.catalogLoading = this.task(async () => {
        const values = await Promise.all((['codex', 'dsh'] as const).map(async id => {
          const adapter = this.adapters.get(id);
          if (!adapter) return { id, available: false, reason: '尚未连接此 Harness。', models: [], permissions: [] } satisfies Catalog;
          try { return await adapter.catalog(); }
          catch { return { id, available: false, reason: '原生服务暂时不可用。', models: [], permissions: [] } satisfies Catalog; }
        }));
        this.catalogCache = values; this.catalogAt = Date.now(); return values;
      });
      void this.catalogLoading.then(() => { this.catalogLoading = undefined; }, () => { this.catalogLoading = undefined; });
    }
    return this.catalogLoading;
  }

  async create(input: Omit<CreateConversation, 'cwd'>): Promise<Conversation> {
    this.assertOpen();
    const workspace = this.workspaces.find(item => item.id === input.workspaceId);
    if (!workspace || this.adapters.get(input.harnessId)?.id !== input.harnessId) throw new StoreError('configuration_unavailable', 400);
    const result = this.store.createConversation({ ...input, cwd: workspace.directory });
    if (result.created) this.launch(this.prepare(result.conversation));
    return result.conversation;
  }
  private prepare(conversation: Conversation): Promise<void> {
    this.preparing.add(conversation.id);
    return this.task(async () => {
      let acceptingBinding = true;
      try {
        const adapter = this.adapter(conversation);
        const catalog = (await this.catalogs()).find(item => item.id === conversation.harnessId);
        this.assertOpen();
        if (!catalog?.available || !catalog.models.some(item => item.id === conversation.configuration.modelId) || !catalog.permissions.some(item => item.id === conversation.configuration.permissionId))
          throw new StoreError('configuration_unavailable', 409);
        const binding = await adapter.create({ cwd: conversation.cwd, configuration: conversation.configuration, title: conversation.title }, value => {
          // During shutdown this task remains tracked: a native identity already created must still be saved.
          if (acceptingBinding) this.store.saveBinding(conversation.id, value);
        });
        this.store.saveBinding(conversation.id, binding);
        if (this.closed) throw new StoreError('workbench_closed', 503);
        await this.observe(conversation.id); await this.sync(conversation.id);
      } catch {
        this.store.setConversationState(conversation.id, { readiness: 'blocked', error: 'conversation_preparation_incomplete' });
      } finally { acceptingBinding = false; this.preparing.delete(conversation.id); }
    });
  }

  start(): Promise<void> {
    this.assertOpen();
    return this.task(async () => {
      this.store.recoverDispatching();
      // The most recent bounded set restores eagerly. Other conversations restore when opened.
      for (const conversation of this.store.listConversations({ limit: 16 })) {
        if (!this.configured(conversation)) { try { this.adapter(conversation); } catch { /* durable blocked state */ } continue; }
        if (conversation.binding) this.launch(this.restoreConversation(conversation.id));
        else if (conversation.readiness === 'preparing') this.store.setConversationState(conversation.id, { readiness: 'blocked', error: 'native_creation_result_unknown' });
      }
    });
  }
  private restoreConversation(id: string): Promise<void> {
    return this.task(async () => {
      try { await this.observe(id); await this.sync(id); }
      catch { if (!this.closed) this.unknown(id, 'native_observation_unavailable'); }
    });
  }
  async open(id: string) {
    this.assertOpen(); const conversation = this.conversation(id);
    if (conversation.binding) this.launch(this.restoreConversation(id));
    return this.snapshot(id);
  }
  snapshot(id: string, beforeItemId?: string) {
    this.assertOpen(); let conversation = this.conversation(id);
    if (!this.configured(conversation)) { try { this.adapter(conversation); } catch { conversation = this.conversation(id); } }
    const history = this.store.readHistory(id, { limit: 100, ...(beforeItemId ? { beforeItemId } : {}) });
    return { conversation, history, operations: this.store.listOperations({ conversationId: id, order: 'desc', limit: 100 }), revision: history.revision };
  }

  older(id: string, beforeItemId?: string) {
    this.assertOpen();
    return this.task(async () => {
      await this.sync(id); this.assertOpen();
      const runtime = this.runtime(id);
      if (!runtime.older) {
        runtime.older = this.task(async () => {
          const conversation = this.conversation(id); const adapter = this.adapter(conversation);
          const local = this.store.readHistory(id, { ...(beforeItemId ? { beforeItemId } : {}), limit: 100 });
          if (local.items.length >= 100 || !conversation.binding || !local.nativeOlderCursor || !local.nativeOlderBeforeItemId) return;
          const generation = runtime.generation;
          let cursor = local.nativeOlderCursor; const seen = new Set([cursor]);
          for (let number = 0; number < HISTORY_MAX_PAGES; number++) {
            const page = await adapter.history(conversation.binding, cursor, HISTORY_PAGE_SIZE);
            this.assertOpen();
            if (runtime.generation !== generation) { this.scheduleSync(id); throw new StoreError('history_changed_retry', 409); }
            if (page.items.length > HISTORY_PAGE_SIZE || page.items.reduce((total, item) => total + Buffer.byteLength(item.text), 0) > HISTORY_MAX_BYTES)
              throw new StoreError('native_history_page_limit', 502);
            if (page.olderCursor && seen.has(page.olderCursor)) throw new StoreError('history_no_progress', 502);
            if (page.items.length || !page.olderCursor) {
              this.store.mergeHistory(id, page.items, local.nativeOlderBeforeItemId);
              this.store.setHistoryCursor(id, { loaded: true, olderCursor: page.olderCursor, beforeItemId: page.olderCursor ? (page.items[0]?.id ?? local.nativeOlderBeforeItemId) : null });
              return;
            }
            // Native record pages can contain only non-display events; an advancing cursor is still progress.
            cursor = page.olderCursor; seen.add(cursor);
          }
          throw new StoreError('history_gap_limit', 502);
        });
        void runtime.older.then(() => { runtime.older = undefined; }, () => { runtime.older = undefined; });
      }
      await runtime.older; return this.snapshot(id, beforeItemId);
    });
  }

  private messageAllowed(conversation: Conversation, current?: Operation): boolean {
    if (!conversation.binding || conversation.readiness !== 'ready' || !conversation.state.configurationVerified ||
      !TERMINAL.has(conversation.state.status) || conversation.state.pendingInputs !== 0 || this.runtimes.get(conversation.id)?.dirty) return false;
    for (const status of ['queued', 'dispatching', 'unknown'] as const) {
      const pending = this.store.listOperations({ conversationId: conversation.id, status, limit: 2 });
      if (pending.some(operation => operation.id !== current?.id && (status !== 'queued' || !current || operation.sequence < current.sequence))) return false;
    }
    const previous = this.store.listOperations({ conversationId: conversation.id, status: 'accepted', type: 'message', order: 'desc', limit: 1 })[0];
    return !previous || (previous.runId !== null && (previous.runId === conversation.state.runId || previous.runId === conversation.state.terminalRunId));
  }
  async enqueue(input: OperationInput) {
    this.assertOpen();
    if (this.store.getOperation(input.id)) return this.store.enqueueOperation(input).operation;
    const conversation = this.conversation(input.conversationId); this.adapter(conversation);
    if (!conversation.binding) throw new StoreError('conversation_not_ready', 409);
    if (input.type === 'message' && !this.messageAllowed(conversation)) throw new StoreError('operation_needs_reconciliation', 409);
    if (input.type === 'stop' && (!['running', 'waiting'].includes(conversation.state.status) || conversation.state.runId !== input.payload.runId))
      throw new StoreError('native_run_changed', 409);
    const result = this.store.enqueueOperation(input);
    if (result.created) this.launch(this.dispatch(result.operation.id));
    return result.operation;
  }
  private dispatch(id: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const existing = this.processing.get(id); if (existing) return existing;
    const queued = this.store.getOperation(id); if (!queued || queued.status !== 'queued') return Promise.resolve();
    this.busyConversations.set(queued.conversationId, (this.busyConversations.get(queued.conversationId) ?? 0) + 1);
    const task = this.task(async () => {
      let claimed = false;
      try {
        const operation = this.store.getOperation(id); if (!operation || operation.status !== 'queued') return;
        let conversation = this.conversation(operation.conversationId); this.adapter(conversation);
        if (!conversation.binding) return;
        await this.observe(conversation.id); await this.sync(conversation.id); if (this.closed) return;
        conversation = this.conversation(conversation.id); const adapter = this.adapter(conversation);
        if (operation.type === 'message' && !this.messageAllowed(conversation, operation)) return;
        if (operation.type === 'stop' && (!['running', 'waiting'].includes(conversation.state.status) || conversation.state.runId !== operation.payload.runId)) {
          this.store.settleOperation(id, { outcome: 'rejected', reason: 'native_run_changed' }); return;
        }
        if (!conversation.binding || !this.store.claimOperation(id)) return;
        claimed = true;
        let receipt: Receipt;
        try {
          receipt = operation.type === 'message'
            ? await adapter.submit(conversation.binding, { id: operation.id, text: operation.payload.text })
            : await adapter.stop(conversation.binding, operation.payload.runId);
        } catch { receipt = { outcome: 'unknown', reason: 'native_receipt_unknown' }; }
        this.store.settleOperation(id, receipt); claimed = false;
        if (!this.closed) await this.sync(conversation.id);
      } catch {
        if (claimed) this.store.settleOperation(id, { outcome: 'unknown', reason: 'native_receipt_unknown' });
      }
    });
    this.processing.set(id, task);
    const settled = () => {
      this.processing.delete(id);
      const count = (this.busyConversations.get(queued.conversationId) ?? 1) - 1;
      if (count) this.busyConversations.set(queued.conversationId, count); else this.busyConversations.delete(queued.conversationId);
    };
    void task.then(settled, settled);
    return task;
  }
  private drain(id: string): void {
    if (this.closed) return;
    for (const operation of this.store.listOperations({ conversationId: id, status: 'queued', limit: 100 })) {
      if (!this.processing.has(operation.id)) this.launch(this.dispatch(operation.id));
    }
  }
  private enrichReceipts(id: string): void {
    const pending = this.store.listOperations({ conversationId: id, status: 'unknown', order: 'desc', limit: 100 });
    const latest = this.store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 1 })[0];
    if (latest?.runId === null) pending.push(latest);
    for (const operation of pending) if (operation.type === 'message') {
      const runId = this.store.operationRunId(id, operation.id);
      if (runId) this.store.settleOperation(operation.id, { outcome: 'accepted', runId });
    }
  }
  reconcile(id: string): Promise<void> {
    this.assertOpen();
    return this.task(async () => {
      let conversation = this.conversation(id); const adapter = this.adapter(conversation); if (!conversation.binding) return;
      await this.observe(id); await this.sync(id); this.assertOpen(); conversation = this.conversation(id);
      for (const operation of this.store.listOperations({ conversationId: id, status: 'unknown', order: 'desc', limit: 100 })) {
        this.assertOpen(); this.adapter(this.conversation(id));
        if (operation.type === 'message') {
          const runId = this.store.operationRunId(id, operation.id);
          const receipt = runId ? { outcome: 'accepted' as const, runId } : await adapter.reconcile(conversation.binding!, operation.id);
          this.store.settleOperation(operation.id, receipt);
        } else {
          await this.sync(id); this.assertOpen();
          const current = this.conversation(id);
          if (current.state.configurationVerified && TERMINAL.has(current.state.status) && current.state.runId === operation.payload.runId)
            this.store.settleOperation(operation.id, { outcome: 'accepted', runId: operation.payload.runId });
        }
      }
      const latest = this.store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 1 })[0];
      if (latest?.runId === null) {
        this.assertOpen(); this.adapter(this.conversation(id));
        const receipt = await adapter.reconcile(conversation.binding!, latest.id);
        // An inconclusive lookup cannot revoke an already established acceptance.
        if (receipt.outcome === 'accepted' && receipt.runId) this.store.settleOperation(latest.id, receipt);
      }
      if (!this.closed) await this.sync(id);
    });
  }

  private runtime(id: string): Runtime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      if (this.runtimes.size >= 16) {
        const idle = [...this.runtimes].find(([key, value]) => !value.syncing && !value.watching && !value.older && !this.preparing.has(key) && !this.busyConversations.has(key) &&
          !['running', 'waiting', 'unknown'].includes(this.conversation(key).state.status));
        if (!idle) throw new StoreError('active_conversation_limit', 429);
        this.disposeRuntime(idle[0]);
      }
      runtime = { live: new Map(), generation: 0, stateGeneration: 0, dirty: false }; this.runtimes.set(id, runtime);
    }
    return runtime;
  }
  private flushLive(id: string, runtime: Runtime): void {
    if (this.closed || this.runtimes.get(id) !== runtime) return;
    runtime.flush = undefined;
    try { for (const item of runtime.live.values()) this.store.saveLiveItem(id, item); this.enrichReceipts(id); }
    catch { this.scheduleSync(id); }
    // Keep the last complete live body until a canonical read acknowledges it. A lagging read must not regress it.
  }
  private observe(id: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const conversation = this.conversation(id); const adapter = this.adapter(conversation); if (!conversation.binding) return Promise.resolve();
    const runtime = this.runtime(id);
    if (runtime.stop) return Promise.resolve(); if (runtime.watching) return runtime.watching;
    runtime.watching = this.task(async () => {
      const stop = await adapter.watch(conversation.binding!, change => {
        if (this.closed || this.runtimes.get(id) !== runtime) return;
        runtime.generation++;
        try {
          if (change.type === 'item') {
            if (runtime.live.size >= 64 && !runtime.live.has(change.item.id)) throw new StoreError('live_item_limit', 429);
            runtime.live.set(change.item.id, change.item);
            if (!runtime.flush) { runtime.flush = setTimeout(() => this.flushLive(id, runtime), 40); runtime.flush.unref(); }
            if (runtime.syncing) runtime.dirty = true;
          } else {
            runtime.stateGeneration++;
            if (change.type === 'state') this.store.setConversationState(id, { state: change.state });
            this.scheduleSync(id);
          }
        } catch { this.unknown(id, 'native_update_requires_sync'); this.scheduleSync(id); }
      });
      if (this.closed || this.runtimes.get(id) !== runtime) stop();
      else { runtime.stop = stop; runtime.poll = setInterval(() => this.scheduleSync(id), 5000); runtime.poll.unref(); }
    });
    void runtime.watching.then(() => { runtime.watching = undefined; }, () => { runtime.watching = undefined; });
    return runtime.watching;
  }
  private scheduleSync(id: string): void {
    if (this.closed) return;
    const runtime = this.runtime(id); runtime.dirty = true;
    if (runtime.syncing || runtime.timer) return;
    runtime.timer = setTimeout(() => { runtime.timer = undefined; this.launch(this.sync(id)); }, 120); runtime.timer.unref();
  }
  private async readHistory(conversation: Conversation, adapter: HarnessAdapter): Promise<HistoryRead> {
    const existing = this.store.readHistory(conversation.id, { limit: 1 }).items.length > 0;
    const establishCursor = !conversation.historyLoaded || !existing;
    let cursor: string | undefined; let lastCursor: string | null = null; let bytes = 0;
    const seenCursors = new Set<string>(); const pages: NativeItem[][] = []; let count = 0;
    for (let number = 0; number < HISTORY_MAX_PAGES; number++) {
      const page: HistoryPage = await adapter.history(conversation.binding!, cursor, HISTORY_PAGE_SIZE);
      this.assertOpen();
      if (!Array.isArray(page.items) || page.items.length > HISTORY_PAGE_SIZE) throw new StoreError('native_history_page_limit', 502);
      bytes += page.items.reduce((total, item) => total + Buffer.byteLength(item.text), 0); count += page.items.length;
      if (bytes > HISTORY_MAX_BYTES || count > HISTORY_MAX_PAGES * HISTORY_PAGE_SIZE) throw new StoreError('history_gap_limit', 502);
      pages.push(page.items); lastCursor = page.olderCursor;
      const intersects = page.items.some(item => this.store.hasHistoryItem(conversation.id, item.id));
      if (intersects || (establishCursor && (count > 0 || !page.olderCursor))) return { items: pages.reverse().flat(), cursor: lastCursor, establishCursor };
      if (!page.olderCursor) {
        if (!existing) return { items: pages.reverse().flat(), cursor: null, establishCursor: true };
        throw new StoreError('native_history_diverged', 502);
      }
      if (seenCursors.has(page.olderCursor)) throw new StoreError('history_no_progress', 502);
      seenCursors.add(page.olderCursor); cursor = page.olderCursor;
    }
    throw new StoreError('history_gap_limit', 502);
  }
  private sync(id: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const conversation = this.conversation(id); if (!conversation.binding) return Promise.resolve();
    const runtime = this.runtime(id); runtime.dirty = true;
    if (runtime.syncing) return runtime.syncing;
    runtime.syncing = this.task(async () => {
      if (runtime.older) await runtime.older.catch(() => {});
      for (let pass = 0; pass < 3 && runtime.dirty && !this.closed; pass++) {
        runtime.dirty = false; const generation = runtime.generation; const stateGeneration = runtime.stateGeneration;
        try {
          const current = this.conversation(id); const adapter = this.adapter(current);
          const target = this.store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 1 })[0]?.runId ?? undefined;
          const results = await Promise.allSettled([adapter.state(current.binding!, target), this.readHistory(current, adapter)]);
          if (this.closed || this.runtimes.get(id) !== runtime) return;
          const currentTarget = this.store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 1 })[0]?.runId ?? undefined;
          if (runtime.stateGeneration !== stateGeneration || currentTarget !== target) { runtime.dirty = true; continue; }
          const [state, history] = results;
          if (state.status === 'rejected') throw state.reason;
          if (history.status === 'rejected') throw history.reason;
          this.adapter(this.conversation(id));
          // Text can arrive faster than native reads. It invalidates history, not a
          // verified state read; newer state/invalidate events still fence both.
          this.store.setConversationState(id, { state: state.value, readiness: state.value.configurationVerified ? 'ready' : 'blocked',
            error: state.value.configurationVerified ? null : 'native_configuration_unverified' });
          if (runtime.generation !== generation) { runtime.dirty = true; continue; }
          const items = history.value.items.map(item => {
            const live = runtime.live.get(item.id);
            if (!live) return item;
            const sameBody = item.kind === live.kind && item.text === live.text && item.runId === live.runId && item.operationId === live.operationId;
            if (sameBody && (item.status === live.status || item.status === 'completed')) { runtime.live.delete(item.id); return item; }
            return live;
          });
          this.store.mergeHistory(id, items);
          if (history.value.establishCursor) this.store.setHistoryCursor(id, { loaded: true, olderCursor: history.value.cursor,
            beforeItemId: history.value.cursor ? history.value.items[0]?.id ?? null : null });
          // A newer complete live projection must win over an older history body captured before this sync.
          for (const item of runtime.live.values()) this.store.saveLiveItem(id, item);
          if (runtime.flush) { clearTimeout(runtime.flush); runtime.flush = undefined; }
          this.enrichReceipts(id);
        } catch (error) {
          if (!this.closed && this.runtimes.get(id) === runtime) this.unknown(id, error instanceof StoreError ? error.code : 'native_state_unavailable');
        }
      }
    });
    const result = runtime.syncing;
    void result.then(() => {
      runtime.syncing = undefined;
      if (this.closed || this.runtimes.get(id) !== runtime) return;
      if (runtime.dirty) this.scheduleSync(id); else this.drain(id);
    }, () => { runtime.syncing = undefined; if (!this.closed) this.scheduleSync(id); });
    return result;
  }
  private disposeRuntime(id: string): void {
    const runtime = this.runtimes.get(id); if (!runtime) return;
    if (runtime.timer) clearTimeout(runtime.timer); if (runtime.poll) clearInterval(runtime.poll); if (runtime.flush) clearTimeout(runtime.flush);
    try { runtime.stop?.(); } finally { this.runtimes.delete(id); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      for (const [id, runtime] of this.runtimes) {
        try { for (const item of runtime.live.values()) this.store.saveLiveItem(id, item); }
        catch { /* shutdown still closes connections and waits for tasks; no persistence success is reported */ }
        try { this.disposeRuntime(id); } catch { /* adapter.close still runs */ }
      }
      // Closing connections first unblocks pending RPCs. The database owner may close it only after every task settles.
      await Promise.allSettled([...this.adapters.values()].map(adapter => Promise.resolve().then(() => adapter.close())));
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    })();
    return this.closing;
  }
}

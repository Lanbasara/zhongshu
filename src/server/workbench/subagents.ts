// Layer 4 (ADR 0024): native sub-agents (ADR 0013). Observe and stop only; the workbench never spawns or messages them.
import { HarnessError, type NativeChange, type NativeItem, type NativeState, type Receipt } from '../../harness/types.ts';
import { itemSchema, subagentIdSchema, type SubagentList, type WorkbenchItem } from '../../shared/workbench.ts';
import { SubagentStoreError, type SubagentStop } from '../subagent-store.ts';
import { StoreError, type Conversation, type WorkbenchStore } from '../workbench-store.ts';
import type { Bindings } from './bindings.ts';
import type { Gate } from './gate.ts';
import type { Observation } from './observation.ts';
import type { Participant } from './participant.ts';
import type { Tasks } from './tasks.ts';

type SubagentLease = { readers: Map<string, number>; dispose?: () => void; opening?: Promise<void> };
type Deps = { store: WorkbenchStore; tasks: Tasks; bindings: Bindings; gate: Gate; observation: Observation; ensureSweep: () => void };

export class Subagents implements Participant {
  private readonly store: WorkbenchStore;
  private readonly tasks: Tasks;
  private readonly bindings: Bindings;
  private readonly gate: Gate;
  private readonly observation: Observation;
  private readonly ensureSweep: () => void;
  private readonly refreshes = new Map<string, { task: Promise<void>; again: boolean }>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly touches = new Map<string, Set<string>>();
  private readonly leases = new Map<string, SubagentLease>();
  private readonly stops = new Map<string, Promise<void>>();
  /** While a runtime is open: the native tree may differ from the saved index. */
  private readonly dirty = new Set<string>();

  constructor(deps: Deps) {
    this.store = deps.store; this.tasks = deps.tasks; this.bindings = deps.bindings;
    this.gate = deps.gate; this.observation = deps.observation; this.ensureSweep = deps.ensureSweep;
  }

  // Participant: how the observation kernel's facts reach the sub-agent index.
  created(id: string): void { this.dirty.add(id); }
  hint(id: string, change: NativeChange): void { if (change.type === 'subagents') this.schedule(id, change.agentId, change.transcript); }
  verified(id: string, state: NativeState, items: readonly NativeItem[]): void {
    if (state.configurationVerified && (this.dirty.has(id) || this.store.subagents.get(id)?.verified === false ||
      items.some(item => item.collaboration))) { this.dirty.delete(id); this.tasks.launch(this.refresh(id)); }
  }
  /** The sub-agent index came from the same lost observation; no surface may keep calling it running. */
  lost(id: string): void {
    this.store.subagents.markUnverified(id);
    if (this.observation.has(id)) this.dirty.add(id);
  }
  restored(id: string): void {
    for (const stop of this.store.subagents.pendingStops(id)) if (stop.status === 'queued') this.tasks.launch(this.dispatchStop(stop.id));
  }
  disposed(id: string): void {
    const timer = this.timers.get(id); if (timer) { clearTimeout(timer); this.timers.delete(id); this.touches.delete(id); }
    for (const key of [...this.leases.keys()]) if (key.startsWith(`${id}\u0000`)) this.closeLease(key);
    this.dirty.delete(id);
  }
  /** Native sub-agents keep working after the main turn ends; keep observing until they settle, and keep a
   * Codex parent loaded while it holds results it has not read yet. */
  responsible(id: string, conversation: Conversation): boolean {
    return this.store.subagents.busy(id) || (!conversation.archived && this.store.subagents.holdsObservation(id));
  }
  retains(id: string): boolean { return this.hasReaders(id) || this.refreshes.has(id); }

  private key(id: string, agentId: string): string { return `${id}\u0000${agentId}`; }
  private hasReaders(id: string): boolean {
    for (const key of this.leases.keys()) if (key.startsWith(`${id}\u0000`)) return true;
    return false;
  }
  private owned(id: string, agentId: string) {
    if (!subagentIdSchema.safeParse(agentId).success) throw new StoreError('invalid_request', 400);
    const agent = this.store.subagents.get(id)?.agents.find(value => value.id === agentId);
    if (!agent) throw new StoreError('subagent_not_found', 404);
    return agent;
  }
  private target(id: string) {
    const conversation = this.bindings.conversation(id);
    const adapter = this.bindings.adapter(conversation);
    if (!conversation.binding) throw new StoreError('conversation_not_ready', 409);
    return { binding: conversation.binding, adapter };
  }
  /** Coalesce native hints: transcript growth only bumps that agent's revision; other hints re-read the tree. */
  private schedule(id: string, agentId?: string, transcript = false): void {
    if (this.tasks.closed || this.gate.isDeleting(id)) return;
    if (agentId) {
      let touched = this.touches.get(id);
      if (!touched) { touched = new Set(); this.touches.set(id, touched); }
      if (touched.size < 64) touched.add(agentId);
    }
    if (!transcript && this.observation.has(id)) this.dirty.add(id);
    if (this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const touched = this.touches.get(id); this.touches.delete(id);
      if (this.tasks.closed || this.gate.isDeleting(id) || !this.store.getConversation(id)) return;
      try { if (touched?.size) this.store.subagents.touch(id, [...touched]); } catch { /* the next verified read replaces revisions */ }
      if (this.observation.has(id) && this.dirty.has(id)) { this.dirty.delete(id); this.tasks.launch(this.refresh(id)); }
    }, 400);
    timer.unref(); this.timers.set(id, timer);
  }
  /** Single-flight native read of the spawn tree. A failed read revokes verification instead of keeping old states. */
  private refresh(id: string, duringDeletion = false): Promise<void> {
    if (this.tasks.closed) return Promise.resolve();
    const conversation = this.store.getConversation(id);
    if (!conversation || !this.bindings.adapters.get(conversation.harnessId)?.subagents) return Promise.resolve();
    const running = this.refreshes.get(id);
    if (running) { running.again = true; return running.task; }
    // Register before starting so a fast completion can always remove its own entry.
    const entry = { task: Promise.resolve(), again: false };
    this.refreshes.set(id, entry);
    entry.task = this.tasks.task(async () => {
      await Promise.resolve();
      try {
        do {
          entry.again = false;
          const conversation = this.store.getConversation(id);
          // Archived trees were settled before archiving; keep their last verified index.
          if (!conversation?.binding || conversation.archived || (!duringDeletion && this.gate.isDeleting(id))) return;
          const adapter = this.bindings.adapter(conversation);
          if (!adapter.subagents) return;
          let snapshot: Awaited<ReturnType<NonNullable<typeof adapter.subagents>>>;
          try { snapshot = await adapter.subagents(conversation.binding); }
          catch (error) {
            if (!this.tasks.closed && (duringDeletion || !this.gate.isDeleting(id)) && this.store.getConversation(id)) this.store.subagents.markUnverified(id);
            throw error;
          }
          if (this.tasks.closed || (!duringDeletion && this.gate.isDeleting(id)) || !this.store.getConversation(id)) return;
          this.store.subagents.save(id, conversation.binding.id, snapshot);
          // A verified non-running target settles an unknown stop. This reads native state; it never resends.
          const settled = new Map(snapshot.agents.map(agent => [agent.id, agent.status]));
          for (const stop of this.store.subagents.pendingStops(id)) {
            const status = settled.get(stop.agentId);
            if (stop.status === 'unknown' && status && status !== 'running' && status !== 'unknown') this.store.subagents.settleStop(stop.id, { outcome: 'accepted' });
          }
        } while (entry.again && !this.tasks.closed);
      } finally {
        if (this.refreshes.get(id) === entry) this.refreshes.delete(id);
        this.observation.release(id);
      }
    });
    return entry.task;
  }
  /** Archive and deletion cascade natively; they wait until no sub-agent is running or unverified. */
  async assertSettled(id: string): Promise<void> {
    const conversation = this.bindings.conversation(id);
    if (!conversation.binding || !this.bindings.adapters.get(conversation.harnessId)?.subagents) return;
    try { await this.refresh(id, true); }
    catch {
      // Without a readable tree, refuse only when sub-agents are known; never invent ones that were not observed.
      if (this.store.subagents.get(id)?.agents.length) throw new StoreError('subagents_unverified', 409);
      return;
    }
    if (this.store.subagents.busy(id)) throw new StoreError('subagents_running', 409);
  }
  async list(id: string): Promise<SubagentList> {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    const conversation = this.bindings.conversation(id);
    const stored = this.store.subagents.get(id);
    const runtime = this.observation.slot(id);
    if (conversation.binding && this.bindings.configured(conversation) && this.bindings.adapters.get(conversation.harnessId)?.subagents &&
      !this.gate.executionBlocked(conversation.cwd) && (!stored || !stored.verified || !runtime?.stop))
      await this.refresh(id).catch(() => { /* the index reports itself unverified */ });
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    return this.store.subagents.view(id);
  }
  private childItem(item: NativeItem): WorkbenchItem | undefined {
    // Child transcripts are read through and never stored; native image bytes are not materialized here.
    const { imageSources, fileEdits: _fileEdits, images: _images, ...rest } = item;
    const value = imageSources?.length && !rest.text ? { ...rest, text: '子 Agent 生成的图片暂不在此显示。' } : rest;
    const parsed = itemSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }
  async history(id: string, agentId: string, cursor?: string): Promise<{ brief?: string; items: WorkbenchItem[]; olderCursor: string | null }> {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    const { binding, adapter } = this.target(id);
    const agent = this.owned(id, agentId);
    if (agent.external) return { items: [], olderCursor: null };
    if (!adapter.subagentHistory) throw new StoreError('subagent_history_unavailable', 409);
    return this.tasks.task(async () => {
      let page: Awaited<ReturnType<NonNullable<typeof adapter.subagentHistory>>>;
      try { page = await adapter.subagentHistory!(binding, agentId, cursor, 50); }
      catch (error) {
        if (error instanceof HarnessError && error.code === 'subagent_not_owned') throw new StoreError('subagent_not_found', 404);
        throw new StoreError('subagent_history_unavailable', 503);
      }
      this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
      const items = page.items.slice(-100).map(item => this.childItem(item)).filter((item): item is WorkbenchItem => !!item);
      const brief = page.brief && Buffer.byteLength(page.brief) <= 64 * 1024 ? page.brief : page.brief?.slice(0, 16_000);
      return { ...(brief ? { brief } : {}), items, olderCursor: page.olderCursor };
    });
  }
  /** Reading leases for one sub-agent keep its live hints flowing; they never affect native execution. */
  async lease(id: string, agentId: string, readerId: string, active: boolean): Promise<void> {
    const key = this.key(id, agentId);
    if (!active) {
      const lease = this.leases.get(key);
      lease?.readers.delete(readerId);
      if (lease && !lease.readers.size) this.closeLease(key);
      return;
    }
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(readerId)) throw new StoreError('invalid_reader', 400);
    const { binding, adapter } = this.target(id);
    const agent = this.owned(id, agentId);
    let lease = this.leases.get(key);
    if (!lease) {
      if (this.leases.size >= 16) throw new StoreError('reader_limit', 429);
      lease = { readers: new Map() }; this.leases.set(key, lease);
    }
    if (!lease.readers.has(readerId) && lease.readers.size >= 8) throw new StoreError('reader_limit', 429);
    lease.readers.set(readerId, Date.now() + 45_000);
    this.ensureSweep();
    if (agent.external || !adapter.observeSubagent || lease.dispose) return;
    if (lease.opening) return lease.opening;
    const own = lease;
    own.opening = this.tasks.task(async () => {
      try {
        await this.observation.observe(id);
        const dispose = await adapter.observeSubagent!(binding, agentId);
        if (this.tasks.closed || this.leases.get(key) !== own) dispose(); else own.dispose = dispose;
      } catch { /* Explicit reads still work; the next renewal retries live hints. */ }
      finally { own.opening = undefined; }
    });
    return own.opening;
  }
  /** Expire sub-agent reading leases; called by the periodic sweep. */
  sweep(): void {
    for (const [key, lease] of this.leases) {
      for (const [reader, expiry] of lease.readers) if (expiry <= Date.now()) lease.readers.delete(reader);
      if (!lease.readers.size) this.closeLease(key);
    }
  }
  private closeLease(key: string): void {
    const lease = this.leases.get(key); if (!lease) return;
    this.leases.delete(key);
    try { lease.dispose?.(); } catch { /* releasing observation never stops native work */ }
    this.observation.release(key.slice(0, key.indexOf('\u0000')));
  }
  stop(id: string, agentId: string, stopId: string): SubagentStop {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    const { adapter } = this.target(id);
    if (!adapter.stopSubagent) throw new StoreError('subagent_stop_unavailable', 409);
    if (!this.store.subagents.getStop(stopId)) {
      const agent = this.store.subagents.view(id).agents.find(value => value.id === agentId);
      if (!agent) throw new StoreError('subagent_not_found', 404);
      if (agent.status === 'unknown') throw new StoreError('subagent_state_unverified', 409);
      if (agent.status !== 'running') throw new StoreError('subagent_not_running', 409);
      if (agent.stop && ['queued', 'dispatching'].includes(agent.stop.status)) throw new StoreError('subagent_stop_pending', 409);
    }
    let result: ReturnType<typeof this.store.subagents.enqueueStop>;
    try { result = this.store.subagents.enqueueStop({ id: stopId, conversationId: id, agentId }); }
    catch (error) { if (error instanceof SubagentStoreError) throw new StoreError(error.code, error.statusCode); throw error; }
    if (result.stop.status === 'queued') this.tasks.launch(this.dispatchStop(result.stop.id));
    return result.stop;
  }
  private dispatchStop(stopId: string): Promise<void> {
    const existing = this.stops.get(stopId); if (existing) return existing;
    const task = this.tasks.task(async () => {
      const queued = this.store.subagents.getStop(stopId);
      if (!queued || queued.status !== 'queued' || this.tasks.closed || this.gate.isDeleting(queued.conversationId)) return;
      const conversation = this.bindings.conversation(queued.conversationId);
      const adapter = this.bindings.adapters.get(conversation.harnessId);
      if (!conversation.binding || !adapter?.stopSubagent || !this.bindings.configured(conversation)) {
        this.store.subagents.settleStop(stopId, { outcome: 'rejected', reason: 'subagent_stop_unavailable' }); return;
      }
      if (!this.store.subagents.claimStop(stopId)) return;
      let receipt: Receipt;
      try { receipt = await adapter.stopSubagent(conversation.binding, queued.agentId); }
      catch { receipt = { outcome: 'unknown', reason: 'native_receipt_unknown' }; }
      this.store.subagents.settleStop(stopId, receipt);
      if (!this.tasks.closed && !this.gate.isDeleting(queued.conversationId)) await this.refresh(queued.conversationId).catch(() => {});
    });
    this.stops.set(stopId, task);
    void task.then(() => this.stops.delete(stopId), () => this.stops.delete(stopId));
    return task;
  }
  /** Settle an unknown stop only from a verified native read. A still-running agent leaves it unknown; nothing is resent. */
  async reconcileStop(id: string, stopId: string): Promise<SubagentStop> {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    const stop = this.store.subagents.getStop(stopId);
    if (!stop || stop.conversationId !== id) throw new StoreError('operation_not_found', 404);
    if (stop.status === 'queued') { await this.dispatchStop(stopId); return this.store.subagents.getStop(stopId)!; }
    if (stop.status !== 'unknown') return stop;
    await this.refresh(id).catch(() => {});
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    const snapshot = this.store.subagents.get(id);
    const agent = snapshot?.agents.find(value => value.id === stop.agentId);
    if (snapshot?.verified && agent && !['running', 'unknown'].includes(agent.status))
      return this.store.subagents.settleStop(stopId, { outcome: 'accepted' });
    return this.store.subagents.getStop(stopId)!;
  }
}

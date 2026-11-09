// Layer 4 (ADR 0024): questions and approvals (ADR 0016). The request belongs to the native Harness; Zhongshu shows it
// and delivers one answer per request as an operation with a stable identity, never resending an unknown one.
import type { NativeChange, NativeRequest, NativeState, Receipt } from '../../harness/types.ts';
import { answerFits, answerSummary } from '../../shared/requests.ts';
import { requestLimit, type PendingRequest, type RequestAnswer, type RequestAnswerView } from '../../shared/workbench.ts';
import { answerView, RequestStoreError } from '../request-store.ts';
import { StoreError, type Conversation, type WorkbenchStore } from '../workbench-store.ts';
import type { Bindings } from './bindings.ts';
import type { Gate } from './gate.ts';
import type { Participant } from './participant.ts';
import type { Tasks } from './tasks.ts';

/** A resolved request stays visible this long so every device sees that it was answered or expired. */
const RESOLVED_RETENTION = 10 * 60_000;
type RequestEntry = { request: NativeRequest; status: PendingRequest['status']; resolvedAt?: number };
type Deps = { store: WorkbenchStore; tasks: Tasks; bindings: Bindings; gate: Gate };

export class Requests implements Participant {
  private readonly store: WorkbenchStore;
  private readonly tasks: Tasks;
  private readonly bindings: Bindings;
  private readonly gate: Gate;
  /** Requests the native agents wait on, as last read from each adapter. Memory only; the native side owns them. */
  private readonly views = new Map<string, Map<string, RequestEntry>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly refreshes = new Map<string, { task: Promise<void>; again: boolean }>();
  private readonly answers = new Map<string, Promise<void>>();

  constructor(deps: Deps) { this.store = deps.store; this.tasks = deps.tasks; this.bindings = deps.bindings; this.gate = deps.gate; }

  // Participant.
  hint(id: string, change: NativeChange): void { if (change.type === 'requests') this.schedule(id); }
  verified(id: string, _state: NativeState, _items: unknown, conversation: Conversation): void {
    if (conversation.binding && this.bindings.adapters.get(conversation.harnessId)?.requests) this.schedule(id);
  }
  responsible(id: string): boolean { return this.store.requests.busy(id); }

  /** On shutdown: no further native reads are scheduled. */
  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  private schedule(id: string): void {
    if (this.tasks.closed || this.gate.isDeleting(id) || this.timers.has(id)) return;
    const timer = setTimeout(() => { this.timers.delete(id); this.tasks.launch(this.refresh(id)); }, 40);
    timer.unref(); this.timers.set(id, timer);
  }
  private refresh(id: string): Promise<void> {
    const running = this.refreshes.get(id);
    if (running) { running.again = true; return running.task; }
    const entry = { task: Promise.resolve(), again: false };
    entry.task = this.tasks.task(async () => {
      try { do { entry.again = false; await this.read(id); } while (entry.again && !this.tasks.closed); }
      finally { this.refreshes.delete(id); }
    });
    this.refreshes.set(id, entry);
    return entry.task;
  }
  private async read(id: string): Promise<void> {
    const conversation = this.store.getConversation(id);
    if (!conversation?.binding || this.tasks.closed || this.gate.isDeleting(id)) return;
    const adapter = this.bindings.adapters.get(conversation.harnessId);
    if (!adapter?.requests || !this.bindings.configured(conversation)) return;
    let native: NativeRequest[];
    try { native = (await adapter.requests(conversation.binding)).slice(0, requestLimit); } catch { return; }
    if (this.tasks.closed || this.gate.isDeleting(id)) return;
    const now = Date.now(); const current = this.views.get(id) ?? new Map<string, RequestEntry>();
    // While observation is lost the adapter cannot vouch for absence; keep what was open until it is re-verified.
    const verified = this.store.getConversation(id)?.state.status !== 'unknown';
    const next = new Map<string, RequestEntry>(); let changed = false;
    for (const request of native) {
      const previous = current.get(request.id);
      if (!previous || previous.status !== 'open' || JSON.stringify(previous.request) !== JSON.stringify(request)) changed = true;
      next.set(request.id, { request, status: 'open' });
      // Still open after an unconfirmed answer: that answer was not taken. The native side takes one answer
      // per request, so answering again cannot apply twice.
      const latest = this.store.requests.latest(id, request.id);
      if (latest?.status === 'unknown') { this.store.requests.settle(latest.id, { outcome: 'rejected', reason: 'answer_not_delivered' }); changed = true; }
    }
    for (const [key, previous] of current) {
      if (next.has(key)) continue;
      if (previous.status === 'open' && !verified) { next.set(key, previous); continue; }
      if (previous.status === 'open') {
        const latest = this.store.requests.latest(id, key);
        next.set(key, { ...previous, status: latest?.status === 'accepted' ? 'answered' : 'expired', resolvedAt: now }); changed = true;
      } else if (now - (previous.resolvedAt ?? now) < RESOLVED_RETENTION) next.set(key, previous);
      else changed = true;
    }
    while (next.size > requestLimit) {
      const oldest = [...next].find(([, value]) => value.status !== 'open')?.[0] ?? next.keys().next().value!;
      next.delete(oldest); changed = true;
    }
    if (next.size) this.views.set(id, next); else this.views.delete(id);
    if (changed) this.store.touch(id, undefined, 'state');
  }
  list(id: string): PendingRequest[] {
    const entries = [...(this.views.get(id)?.values() ?? [])];
    if (!entries.length) return [];
    const names = new Map(this.store.subagents.view(id).agents.map(agent => [agent.id, agent.name]));
    return entries.sort((left, right) => left.request.createdAt - right.request.createdAt).map(({ request, status }) => {
      const { agentId, ...rest } = request;
      const latest = this.store.requests.latest(id, request.id);
      return { ...rest, status, ...(agentId ? { agent: { id: agentId, name: names.get(agentId) ?? '子 Agent' } } : {}), ...(latest ? { answer: answerView(latest) } : {}) };
    });
  }
  answer(id: string, requestId: string, answerId: string, answer: RequestAnswer): RequestAnswerView {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    const conversation = this.bindings.conversation(id);
    const existing = this.store.requests.get(answerId);
    if (existing) {
      if (existing.conversationId !== id || existing.requestId !== requestId) throw new StoreError('operation_id_conflict', 409);
      return answerView(existing);
    }
    const adapter = this.bindings.adapter(conversation);
    if (!adapter.answer || !conversation.binding) throw new StoreError('request_answer_unavailable', 409);
    const entry = this.views.get(id)?.get(requestId);
    if (!entry) throw new StoreError('request_not_found', 404);
    if (entry.status !== 'open') throw new StoreError('request_not_open', 409);
    const latest = this.store.requests.latest(id, requestId);
    if (latest && latest.status !== 'rejected') throw new StoreError('request_answer_pending', 409);
    if (!answerFits(entry.request, answer)) throw new StoreError('answer_invalid', 400);
    let result;
    try { result = this.store.requests.enqueue({ id: answerId, conversationId: id, requestId, answer, summary: answerSummary(entry.request, answer) }); }
    catch (error) { if (error instanceof RequestStoreError) throw new StoreError(error.code, error.statusCode); throw error; }
    if (result.answer.status === 'queued') this.tasks.launch(this.dispatch(result.answer.id));
    return answerView(result.answer);
  }
  private dispatch(answerId: string): Promise<void> {
    const existing = this.answers.get(answerId); if (existing) return existing;
    const task = this.tasks.task(async () => {
      const queued = this.store.requests.get(answerId);
      if (!queued || queued.status !== 'queued' || !queued.answer || this.tasks.closed || this.gate.isDeleting(queued.conversationId)) return;
      const conversation = this.bindings.conversation(queued.conversationId);
      const adapter = this.bindings.adapters.get(conversation.harnessId);
      if (!conversation.binding || !adapter?.answer || !this.bindings.configured(conversation)) {
        this.store.requests.settle(answerId, { outcome: 'rejected', reason: 'request_answer_unavailable' }); return;
      }
      const answer = queued.answer;
      if (!this.store.requests.claim(answerId)) return;
      let receipt: Receipt;
      try { receipt = await adapter.answer(conversation.binding, queued.requestId, answer); }
      catch { receipt = { outcome: 'unknown', reason: 'native_receipt_unknown' }; }
      this.store.requests.settle(answerId, receipt);
      const entry = this.views.get(queued.conversationId)?.get(queued.requestId);
      if (receipt.outcome === 'accepted' && entry?.status === 'open') {
        entry.status = 'answered'; entry.resolvedAt = Date.now(); this.store.touch(queued.conversationId, undefined, 'state');
      }
      if (!this.tasks.closed && !this.gate.isDeleting(queued.conversationId)) await this.refresh(queued.conversationId).catch(() => {});
    });
    this.answers.set(answerId, task);
    void task.then(() => this.answers.delete(answerId), () => this.answers.delete(answerId));
    return task;
  }
  /** Settle an unknown answer only from a fresh native read; nothing is resent. */
  async reconcile(id: string, answerId: string): Promise<RequestAnswerView> {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    const answer = this.store.requests.get(answerId);
    if (!answer || answer.conversationId !== id) throw new StoreError('operation_not_found', 404);
    if (answer.status === 'queued') { await this.dispatch(answerId); return answerView(this.store.requests.get(answerId)!); }
    if (answer.status === 'unknown') await this.refresh(id).catch(() => {});
    return answerView(this.store.requests.get(answerId)!);
  }
}

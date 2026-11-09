// Layer 4 (ADR 0024): sending, stopping and reconciling operations (ADR 0004), plus Plan mode and skills.
// An operation is persisted before dispatch; an unknown receipt is settled by native reads, never by resending.
import type { Receipt } from '../../harness/types.ts';
import { nativeText } from '../../shared/content.ts';
import type { WorkbenchItem } from '../../shared/workbench.ts';
import { workspacePath } from '../resources.ts';
import { StoreError, planView, type Conversation, type Operation, type OperationInput, type WorkbenchStore } from '../workbench-store.ts';
import type { Bindings } from './bindings.ts';
import type { Gate } from './gate.ts';
import { TERMINAL, type Ledger } from './ledger.ts';
import type { Observation } from './observation.ts';
import type { Participant } from './participant.ts';
import type { Tasks } from './tasks.ts';

type Deps = { store: WorkbenchStore; tasks: Tasks; bindings: Bindings; gate: Gate; ledger: Ledger; observation: Observation };

export class Execution implements Participant {
  private readonly store: WorkbenchStore;
  private readonly tasks: Tasks;
  private readonly bindings: Bindings;
  private readonly gate: Gate;
  private readonly ledger: Ledger;
  private readonly observation: Observation;
  /** Dispatches in progress, by operation. */
  private readonly processing = new Map<string, Promise<void>>();

  constructor(deps: Deps) {
    this.store = deps.store; this.tasks = deps.tasks; this.bindings = deps.bindings;
    this.gate = deps.gate; this.ledger = deps.ledger; this.observation = deps.observation;
  }

  // Participant.
  noticed(id: string): void { this.enrichReceipts(id); }
  /** After a settled sync: dispatch operations still waiting to go out. */
  settled(id: string): void {
    if (this.tasks.closed || this.gate.isDeleting(id) || this.gate.executionBlocked(this.bindings.conversation(id).cwd)) return;
    for (const operation of this.store.listOperations({ conversationId: id, status: 'queued', limit: 100 })) {
      if (!this.processing.has(operation.id)) this.tasks.launch(this.dispatch(operation.id));
    }
  }
  /** An operation is unsettled, or the latest accepted message does not belong to the current run yet. */
  responsible(id: string, conversation: Conversation): boolean {
    if (this.ledger.pendingOperation(id)) return true;
    const latest = this.ledger.latestAcceptedMessage(id);
    return !!latest && (!latest.runId || (latest.runId !== conversation.state.runId && latest.runId !== conversation.state.terminalRunId));
  }

  async validateReferences(conversation: Conversation, input: OperationInput): Promise<void> {
    if (input.type !== 'message') return;
    for (const ref of input.payload.references ?? []) {
      if (ref.type === 'file') await workspacePath(conversation.cwd, ref.path);
      else {
        const item = await this.observation.locateItem(conversation.id, ref.itemId).catch(() => undefined);
        if (!item) throw new StoreError('quote_source_changed', 409);
      }
    }
    let totalImageBytes = 0;
    for (const image of input.payload.images ?? []) {
      const saved = this.store.resources.get(conversation.id, image.id);
      totalImageBytes += saved.data.length;
      if (saved.name !== image.name || saved.mediaType !== image.mediaType) throw new StoreError('image_reference_changed', 409);
    }
    if (totalImageBytes > 4 * 1024 * 1024) throw new StoreError('message_images_too_large', 413);
  }
  /** The native input for a message operation. */
  messageInput(operation: Extract<Operation, { type: 'message' }>) {
    // Per-turn Harnesses take the conversation's Plan choice as it stands when the message is dispatched.
    const plan = !!this.store.getConversation(operation.conversationId)?.planMode;
    return { ...operation.payload, id: operation.id, text: nativeText(operation.payload), ...(plan ? { plan: true } : {}), imageData: operation.payload.images?.map(image => {
      const resource = this.store.resources.get(operation.conversationId, image.id);
      return { mediaType: resource.mediaType, data: resource.data.toString('base64') };
    }) };
  }

  async enqueue(input: OperationInput) {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(input.conversationId);
    if (this.store.getOperation(input.id)) return this.store.enqueueOperation(input).operation;
    const { cwd: directory, workspaceId } = this.bindings.conversation(input.conversationId);
    if (this.gate.removing(workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    this.bindings.assertWorkspaceAvailable(workspaceId);
    if (!this.gate.saving(directory) && this.gate.executionBlocked(directory)) throw new StoreError('workspace_execution_blocked', 409);
    if (this.gate.saving(directory)) throw new StoreError('workspace_save_in_progress', 409);
    const runtime = this.observation.slot(input.conversationId);
    if (input.type === 'message' && (runtime?.dirty || runtime?.syncing)) await this.observation.sync(input.conversationId);
    const conversation = this.bindings.conversation(input.conversationId); this.bindings.adapter(conversation);
    if (conversation.archived) throw new StoreError('conversation_archived', 409);
    if (!conversation.binding) throw new StoreError('conversation_not_ready', 409);
    if (input.type === 'message' && !this.observation.messageAllowed(conversation)) throw new StoreError('operation_needs_reconciliation', 409);
    if (input.type === 'stop' && (!['running', 'waiting'].includes(conversation.state.status) || conversation.state.runId !== input.payload.runId))
      throw new StoreError('native_run_changed', 409);
    await this.validateReferences(conversation, input);
    if (this.gate.removing(workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    this.bindings.assertWorkspaceAvailable(workspaceId);
    if (input.type === 'message' && !this.observation.messageAllowed(this.bindings.conversation(conversation.id))) throw new StoreError('operation_needs_reconciliation', 409);
    if (this.gate.saving(conversation.cwd)) throw new StoreError('workspace_save_in_progress', 409);
    if (this.gate.executionBlocked(conversation.cwd)) throw new StoreError('workspace_execution_blocked', 409);
    this.gate.assertNotDeleting(input.conversationId);
    const result = this.store.enqueueOperation(input);
    if (result.created) this.tasks.launch(this.dispatch(result.operation.id));
    return result.operation;
  }
  private dispatch(id: string): Promise<void> {
    if (this.tasks.closed) return Promise.resolve();
    const existing = this.processing.get(id); if (existing) return existing;
    const queued = this.store.getOperation(id); if (!queued || queued.status !== 'queued') return Promise.resolve();
    this.gate.occupy(queued.conversationId);
    const task = this.tasks.task(async () => {
      let claimed = false;
      try {
        const operation = this.store.getOperation(id); if (!operation || operation.status !== 'queued') return;
        let conversation = this.bindings.conversation(operation.conversationId); this.bindings.adapter(conversation);
        if (!conversation.binding) return;
        await this.observation.observe(conversation.id); await this.observation.sync(conversation.id); if (this.tasks.closed) return;
        conversation = this.bindings.conversation(conversation.id); const adapter = this.bindings.adapter(conversation);
        if (operation.type === 'message' && !this.observation.messageAllowed(conversation, operation)) return;
        if (operation.type === 'stop' && (!['running', 'waiting'].includes(conversation.state.status) || conversation.state.runId !== operation.payload.runId)) {
          this.store.settleOperation(id, { outcome: 'rejected', reason: 'native_run_changed' }); return;
        }
        try { await this.validateReferences(conversation, operation); }
        catch { this.store.settleOperation(id, { outcome: 'rejected', reason: '引用的文件或图片已不可用，请继续编辑。' }); return; }
        if (!conversation.binding || this.bindings.workspaceUnavailable(conversation.workspaceId) ||
          this.gate.executionBlocked(conversation.cwd) || !this.store.claimOperation(id)) return;
        claimed = true;
        let receipt: Receipt;
        try {
          receipt = operation.type === 'message'
            ? await adapter.submit(conversation.binding, this.messageInput(operation))
            : await adapter.stop(conversation.binding, operation.payload.runId);
        } catch { receipt = { outcome: 'unknown', reason: 'native_receipt_unknown' }; }
        this.store.settleOperation(id, receipt); claimed = false;
        if (!this.tasks.closed) await this.observation.sync(conversation.id);
      } catch {
        if (claimed) this.store.settleOperation(id, { outcome: 'unknown', reason: 'native_receipt_unknown' });
      }
    });
    this.processing.set(id, task);
    const settled = () => {
      this.processing.delete(id);
      this.gate.vacate(queued.conversationId);
      this.observation.release(queued.conversationId);
    };
    void task.then(settled, settled);
    return task;
  }
  /** Settle unknown message receipts from what the latest page and live items show. */
  private enrichReceipts(id: string): void {
    const pending = this.store.listOperations({ conversationId: id, status: 'unknown', order: 'desc', limit: 100 });
    const latest = this.store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 1 })[0];
    if (latest?.runId === null) pending.push(latest);
    for (const operation of pending) if (operation.type === 'message') {
      const runId = this.runIdForOperation(id, operation.id);
      if (runId) this.store.settleOperation(operation.id, { outcome: 'accepted', runId });
    }
  }
  /** The native run that received an operation, as seen in the latest page or live items. Older evidence is reconciled natively. */
  private runIdForOperation(id: string, operationId: string): string | null {
    const items = this.observation.items(id); if (!items) return null;
    const runs = new Set<string>();
    for (const item of items) if (item.kind === 'user' && item.operationId === operationId && item.runId) runs.add(item.runId);
    return runs.size === 1 ? [...runs][0]! : null;
  }
  reconcile(id: string): Promise<void> {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    return this.tasks.task(async () => {
      let conversation = this.bindings.conversation(id); const adapter = this.bindings.adapter(conversation); if (!conversation.binding) return;
      await this.observation.observe(id); await this.observation.sync(id);
      this.tasks.assertOpen(); this.gate.assertNotDeleting(id); conversation = this.bindings.conversation(id);
      for (const operation of this.store.listOperations({ conversationId: id, status: 'unknown', order: 'desc', limit: 100 })) {
        this.tasks.assertOpen(); this.gate.assertNotDeleting(id); this.bindings.adapter(this.bindings.conversation(id));
        if (operation.type === 'message') {
          const runId = this.runIdForOperation(id, operation.id);
          const receipt = runId ? { outcome: 'accepted' as const, runId } : await adapter.reconcile(conversation.binding!, operation.id);
          this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
          this.store.settleOperation(operation.id, receipt);
        } else {
          await this.observation.sync(id); this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
          const current = this.bindings.conversation(id);
          if (current.state.configurationVerified && TERMINAL.has(current.state.status) && current.state.runId === operation.payload.runId)
            this.store.settleOperation(operation.id, { outcome: 'accepted', runId: operation.payload.runId });
        }
      }
      const latest = this.store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 1 })[0];
      if (latest?.runId === null) {
        this.tasks.assertOpen(); this.gate.assertNotDeleting(id); this.bindings.adapter(this.bindings.conversation(id));
        const receipt = await adapter.reconcile(conversation.binding!, latest.id);
        this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
        // An inconclusive lookup cannot revoke an already established acceptance.
        if (receipt.outcome === 'accepted' && receipt.runId) this.store.settleOperation(latest.id, receipt);
        else if (receipt.outcome === 'accepted' && latest.type === 'message' && latest.queuedInput?.delivery.mode === 'next' &&
          adapter.wakeQueued && conversation.state.status === 'interrupted') {
          const queue = this.store.readQueue(id);
          if (!queue.pause && !queue.afterRunId && !this.gate.executionBlocked(conversation.cwd)) {
            // A user explicitly resumed this queue before the reply was lost.
            // Start only an already admitted item, using its native queue identity.
            await adapter.wakeQueued(conversation.binding!, latest.id).catch(() => {});
          }
        }
      }
      if (!this.tasks.closed) await this.observation.sync(id);
    });
  }

  async skills(id: string) {
    this.tasks.assertOpen();
    const conversation = this.bindings.conversation(id);
    this.gate.assertDispatchable(conversation);
    const adapter = this.bindings.adapter(conversation);
    if (!adapter.skills) throw new StoreError('skill_catalog_unavailable', 503);
    return this.tasks.task(async () => {
      const skills = await adapter.skills!(conversation.binding!).catch(() => { throw new StoreError('skill_catalog_unavailable', 503); });
      this.tasks.assertOpen();
      this.gate.assertDispatchable(this.bindings.conversation(id));
      return skills;
    });
  }
  planOf(conversation: Conversation) { return planView(conversation, this.bindings.adapters.get(conversation.harnessId)?.planMode); }
  /**
   * A per-turn Plan conversation whose latest turn ended with a proposed plan and nothing after it: the client
   * offers to carry the plan out. Derived from native items and state; it is not a native request.
   */
  planReady(conversation: Conversation, items: WorkbenchItem[]): boolean {
    if (this.bindings.adapters.get(conversation.harnessId)?.planMode !== 'per-turn' || !conversation.planMode) return false;
    const state = conversation.state;
    if (state.status !== 'idle' || !state.configurationVerified || !state.runId || state.pendingInputs) return false;
    if (this.store.listOperations({ conversationId: conversation.id, status: 'queued', limit: 1 }).length || this.store.readQueue(conversation.id).entries.length) return false;
    const last = items.findLastIndex(item => item.plan && item.runId === state.runId && item.status === 'completed');
    return last >= 0 && !items.slice(last + 1).some(item => item.kind === 'user');
  }
  async setPlan(id: string, active: boolean): Promise<Conversation> {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    const conversation = this.bindings.conversation(id); const adapter = this.bindings.adapter(conversation);
    if (!adapter.planMode) throw new StoreError('plan_unavailable', 409);
    if (['running', 'waiting', 'unknown'].includes(conversation.state.status) || this.gate.busy(id)) throw new StoreError('plan_change_while_running', 409);
    if (adapter.planMode === 'per-turn') return this.store.setPlanMode(id, active);
    if (!conversation.binding || !adapter.setPlan) throw new StoreError('plan_unavailable', 409);
    let receipt: Receipt;
    try { receipt = await adapter.setPlan(conversation.binding, active); }
    catch { receipt = { outcome: 'unknown', reason: 'native_receipt_unknown' }; }
    if (receipt.outcome === 'rejected') throw new StoreError(receipt.reason === 'plan_unavailable' ? 'plan_unavailable' : 'plan_rejected', 409);
    // The native session reports what took effect; an unknown receipt is settled by that read, never by resending.
    await this.observation.sync(id).catch(() => {});
    return this.bindings.conversation(id);
  }
}

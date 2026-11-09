// Layer 4 (ADR 0024): messages queued while a run is in progress, delivered next or sent early. Each delivery is an
// operation whose content and delivery mode are frozen when it is claimed.
import { randomUUID } from 'node:crypto';
import type { NativeState, Receipt } from '../../harness/types.ts';
import type { QueueCommand, QueueView } from '../../shared/workbench.ts';
import { StoreError, type Conversation, type Operation, type WorkbenchStore } from '../workbench-store.ts';
import type { Bindings } from './bindings.ts';
import type { Execution } from './execution.ts';
import type { Gate } from './gate.ts';
import { TERMINAL } from './ledger.ts';
import type { Observation } from './observation.ts';
import type { Participant } from './participant.ts';
import type { Tasks } from './tasks.ts';

type Deps = { store: WorkbenchStore; tasks: Tasks; bindings: Bindings; gate: Gate; observation: Observation; execution: Execution };

export class Queue implements Participant {
  private readonly store: WorkbenchStore;
  private readonly tasks: Tasks;
  private readonly bindings: Bindings;
  private readonly gate: Gate;
  private readonly observation: Observation;
  private readonly execution: Execution;

  constructor(deps: Deps) {
    this.store = deps.store; this.tasks = deps.tasks; this.bindings = deps.bindings;
    this.gate = deps.gate; this.observation = deps.observation; this.execution = deps.execution;
  }

  // Participant.
  /** A queue waiting on a run pauses when that run failed or was stopped. */
  verified(id: string, state: NativeState): void {
    const queue = this.store.readQueue(id);
    if (queue.entries.length && !queue.pause && queue.afterRunId && state.configurationVerified) {
      const outcome = state.terminalRunId === queue.afterRunId ? state.terminalStatus : undefined;
      if (outcome === 'failed' || state.status === 'failed') this.store.pauseQueue(id, 'failed');
      else if (outcome === 'interrupted' || state.status === 'interrupted') this.store.pauseQueue(id, 'stopped');
    }
  }
  /** After a settled sync: deliver the queue head when its run has finished. */
  settled(id: string): void {
    if (this.tasks.closed || this.gate.isDeleting(id) || this.gate.executionBlocked(this.bindings.conversation(id).cwd)) return;
    const queue = this.store.readQueue(id);
    const head = queue.entries[0];
    if (!head || queue.pause || this.gate.busy(id)) return;
    const conversation = this.bindings.conversation(id);
    const { state } = conversation;
    if (!state.configurationVerified || conversation.readiness !== 'ready' || conversation.archived ||
      this.bindings.workspaceUnavailable(conversation.workspaceId) || this.gate.removing(conversation.workspaceId)) return;
    const outcome = state.terminalRunId === queue.afterRunId ? state.terminalStatus : undefined;
    if (head.status !== 'waiting' || state.pendingInputs || !TERMINAL.has(state.status)) return;
    if (queue.afterRunId && (state.status !== 'idle' || (state.runId !== queue.afterRunId && outcome !== 'completed'))) return;
    try {
      const operation = this.store.claimQueue(id, head.entryId, head.version, randomUUID(), { mode: 'next' });
      this.tasks.launch(this.deliver(operation));
    } catch (error) {
      if (!(error instanceof StoreError) || !['operation_needs_reconciliation', 'queue_entry_changed'].includes(error.code)) this.store.pauseQueue(id, 'rejected');
    }
  }
  responsible(id: string): boolean {
    const queue = this.store.readQueue(id);
    return !queue.pause && queue.entries.length > 0;
  }

  view(id: string): QueueView {
    const conversation = this.bindings.conversation(id);
    const { entries, pause, version } = this.store.readQueue(id);
    const mode = this.bindings.configured(conversation) ? this.bindings.adapters.get(conversation.harnessId)?.earlyInput ?? null : null;
    return { entries, pause, version, mode };
  }
  async change(id: string, command: QueueCommand): Promise<QueueView> {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    const conversation = this.bindings.conversation(id);
    this.bindings.assertWorkspaceAvailable(conversation.workspaceId);
    if (command.action === 'send') {
      const existing = this.store.getOperation(command.operationId);
      if (existing) {
        const input = existing.type === 'message' ? existing.queuedInput : undefined;
        if (existing.conversationId !== id || input?.entryId !== command.entryId || input.version !== command.version ||
          input.delivery.mode !== command.mode || input.delivery.target !== command.target)
          throw new StoreError('operation_id_conflict', 409);
        return this.view(id);
      }
      const adapter = this.bindings.adapter(conversation);
      if (!adapter.submitQueued || adapter.earlyInput !== command.mode) throw new StoreError('queue_mode_unavailable', 409);
      this.gate.assertDispatchable(conversation);
      if (conversation.state.status === 'unknown') throw new StoreError('operation_needs_reconciliation', 409);
      const operation = this.store.claimQueue(id, command.entryId, command.version, command.operationId, { mode: command.mode, target: command.target });
      this.tasks.launch(this.deliver(operation));
    } else {
      if (command.action === 'add' || command.action === 'edit') {
        if (command.action === 'add' && this.store.queueAdmissionExists(id, command.entryId, command.content)) return this.view(id);
        if (!conversation.binding) throw new StoreError('conversation_not_ready', 409);
        if (!this.bindings.adapter(conversation).submitQueued) throw new StoreError('queue_mode_unavailable', 409);
        await this.execution.validateReferences(conversation, { id: command.entryId, conversationId: id, type: 'message', payload: command.content });
        this.tasks.assertOpen();
      }
      if (command.action === 'resume') {
        this.gate.assertDispatchable(conversation);
        if (conversation.state.status === 'unknown' || !conversation.state.configurationVerified)
          throw new StoreError('operation_needs_reconciliation', 409);
      }
      this.gate.assertNotDeleting(id);
      this.store.changeQueue(id, command);
      if (!this.gate.executionBlocked(conversation.cwd)) this.tasks.launch(this.observation.restore(id));
    }
    return this.view(id);
  }
  private deliver(operation: Operation): Promise<void> {
    if (operation.type !== 'message' || !operation.queuedInput) return Promise.resolve();
    const id = operation.conversationId;
    const delivery = operation.queuedInput.delivery;
    this.gate.occupy(id);
    return this.tasks.task(async () => {
      try {
        let receipt: Receipt;
        let conversation: Conversation;
        try {
          conversation = this.bindings.conversation(id);
          this.gate.assertDispatchable(conversation);
          await this.execution.validateReferences(conversation, operation);
          this.tasks.assertOpen();
          conversation = this.bindings.conversation(id);
          this.gate.assertDispatchable(conversation);
        } catch (error) {
          this.store.settleOperation(operation.id, { outcome: 'rejected', reason: error instanceof StoreError ? error.code : 'queue_content_unavailable' });
          return;
        }
        try {
          const adapter = this.bindings.adapter(conversation);
          receipt = adapter.submitQueued
            ? await adapter.submitQueued(conversation.binding!, this.execution.messageInput(operation), delivery)
            : { outcome: 'rejected', reason: 'queue_mode_unavailable' };
        } catch { receipt = { outcome: 'unknown', reason: 'native_receipt_unknown' }; }
        this.store.settleOperation(operation.id, receipt);
      } finally {
        this.gate.vacate(id);
        if (!this.tasks.closed) await this.observation.sync(id);
      }
    });
  }
}

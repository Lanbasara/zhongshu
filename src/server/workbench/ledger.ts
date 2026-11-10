// Layer 2 (ADR 0024): what Zhongshu itself has asked of native runs, read from its durable operations. No state.
import type { NativeState } from '../../harness/types.ts';
import type { Conversation, Operation, WorkbenchStore } from '../workbench-store.ts';

export const TERMINAL = new Set<NativeState['status']>(['idle', 'interrupted', 'failed']);

export class Ledger {
  private readonly store: WorkbenchStore;
  constructor(store: WorkbenchStore) { this.store = store; }

  latestAcceptedMessage(id: string): Operation | undefined {
    return this.store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 1 })[0];
  }
  /** An operation of this conversation is queued, dispatching or awaiting reconciliation. */
  pendingOperation(id: string): boolean {
    for (const status of ['queued', 'dispatching', 'unknown'] as const) if (this.store.listOperations({ conversationId: id, status, limit: 1 }).length) return true;
    return false;
  }
  /** The run whose state Zhongshu waits on: a queue's run first, then its latest accepted message. */
  observationTarget(id: string): string | undefined {
    const queue = this.store.readQueue(id);
    return (queue.entries.length ? queue.afterRunId : null) ?? this.latestAcceptedMessage(id)?.runId ?? undefined;
  }
  /** A run no message, queue delivery or pending operation of Zhongshu accounts for. */
  startedElsewhere(id: string, runId: string): boolean {
    if (this.pendingOperation(id)) return false;
    return !this.store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 50 }).some(operation => operation.runId === runId);
  }
  /**
   * A new message may be sent: the conversation is ready and settled, nothing of Zhongshu's is still in flight,
   * and the latest accepted message belongs to the current run. `dirty` is the observation's unsynced flag;
   * `freshState` means the caller has just read native state itself, so that flag does not apply.
   */
  messageAllowed(conversation: Conversation, dirty: boolean, current?: Operation, freshState = false): boolean {
    if (!conversation.binding || conversation.readiness !== 'ready' || !conversation.state.configurationVerified ||
      !TERMINAL.has(conversation.state.status) || conversation.state.pendingInputs !== 0 || (!freshState && dirty)) return false;
    if (!current && this.store.readQueue(conversation.id).entries.length) return false;
    for (const status of ['queued', 'dispatching', 'unknown'] as const) {
      const pending = this.store.listOperations({ conversationId: conversation.id, status, limit: 2 });
      if (pending.some(operation => operation.id !== current?.id && (status !== 'queued' || !current || operation.sequence < current.sequence))) return false;
    }
    const previous = this.latestAcceptedMessage(conversation.id);
    return !previous || (previous.runId !== null && (previous.runId === conversation.state.runId || previous.runId === conversation.state.terminalRunId));
  }
}

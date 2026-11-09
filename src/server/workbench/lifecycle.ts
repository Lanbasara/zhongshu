// Layer 4 (ADR 0024): renaming, archiving and deleting conversations (ADR 0012). Archive and deletion cascade
// natively, so they wait until the main agent and its sub-agents have settled.
import { StoreError, type Conversation, type WorkbenchStore } from '../workbench-store.ts';
import type { Bindings } from './bindings.ts';
import type { Gate } from './gate.ts';
import type { History } from './history.ts';
import type { Observation } from './observation.ts';
import type { Readers } from './readers.ts';
import type { Subagents } from './subagents.ts';
import type { Tasks } from './tasks.ts';

type Deps = {
  store: WorkbenchStore; tasks: Tasks; bindings: Bindings; gate: Gate; history: History; observation: Observation;
  subagents: Subagents; readers: Readers;
};

/** A native session no run has ever started in, such as one opened ahead of a first message; set-up commands may
 * still wait in its inbox. Archiving it hides nothing that ran (ADR 0021, 2026-11-09). */
function neverRan(conversation: Conversation) {
  const state = conversation.state;
  return state.status === 'idle' && !state.runId && !state.terminalRunId && !state.latest;
}

export class Lifecycle {
  private readonly store: WorkbenchStore;
  private readonly tasks: Tasks;
  private readonly bindings: Bindings;
  private readonly gate: Gate;
  private readonly history: History;
  private readonly observation: Observation;
  private readonly subagents: Subagents;
  private readonly readers: Readers;
  private readonly deletions = new Map<string, Promise<void>>();

  constructor(deps: Deps) {
    this.store = deps.store; this.tasks = deps.tasks; this.bindings = deps.bindings; this.gate = deps.gate;
    this.history = deps.history; this.observation = deps.observation; this.subagents = deps.subagents; this.readers = deps.readers;
  }

  rename(id: string, title: string): Conversation {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    return this.store.renameConversation(id, title);
  }
  async setArchived(id: string, archived: boolean) {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    const current = this.bindings.conversation(id);
    if (archived && !current.archived && current.binding) {
      await this.observation.observe(id);
      await this.observation.sync(id);
      this.tasks.assertOpen();
      // Native archive stops the spawn tree; it must not hide running sub-agents. A busy main agent is reported first.
      if (this.observation.messageAllowed(this.bindings.conversation(id))) await this.subagents.assertSettled(id);
    }
    this.gate.assertNotDeleting(id);
    return this.store.setArchived(id, archived, conversation =>
      conversation.binding ? this.observation.messageAllowed(conversation) || neverRan(conversation) :
        conversation.readiness === 'blocked' && conversation.state.pendingInputs === 0 &&
        !['running', 'waiting'].includes(conversation.state.status));
  }
  /** Caller persists the deletion intent before cleaning native data. No new work can enter this fence. */
  async quiesceForDeletion(id: string): Promise<Conversation> {
    this.tasks.assertOpen();
    if (this.gate.preparing(id) || this.gate.busy(id)) throw new StoreError('conversation_busy', 409);
    this.gate.fenceDeletion(id);
    try {
      const conversation = this.bindings.conversation(id);
      if (!conversation.binding && (conversation.nativePreparationId || conversation.error === 'native_creation_result_unknown' ||
        conversation.error === 'conversation_preparation_incomplete'))
        throw new StoreError('conversation_preparation_incomplete', 409);
      const runtime = this.observation.slot(id);
      await runtime?.watching; await runtime?.reading?.catch(() => {});
      if (conversation.binding) await this.observation.sync(id);
      await this.observation.slot(id)?.reading?.catch(() => {});
      const current = this.bindings.conversation(id);
      if (this.gate.preparing(id) || this.gate.busy(id) ||
        (current.binding ? !this.observation.messageAllowed(current) : current.readiness === 'preparing') || this.store.readQueue(id).entries.length)
        throw new StoreError('conversation_busy', 409);
      // Native deletion cascades to the spawn tree; running sub-agents keep the conversation busy.
      if (current.binding) await this.subagents.assertSettled(id);
      this.readers.drop(id); this.observation.dispose(id); this.history.forget(id);
      return current;
    } catch (error) { this.gate.releaseDeletion(id); throw error; }
  }
  /** Resume deletions whose intent was persisted before a restart. */
  restoreDeletions(): void {
    if (this.tasks.closed) return;
    for (const id of this.store.deletions.listPending(8)) this.tasks.launch(this.delete(id));
  }
  delete(id: string): Promise<void> {
    this.tasks.assertOpen();
    const existing = this.deletions.get(id);
    if (existing) return existing;
    if (this.store.deletions.get(id)?.status === 'completed') return Promise.resolve();
    const pending = this.tasks.task(async () => {
      try {
        const record = this.store.deletions.get(id);
        if (record?.status !== 'native_done') {
          const conversation = this.bindings.conversation(id);
          if (conversation.harnessId === 'dsh') throw new StoreError('conversation_delete_unsupported', 409);
          const adapter = conversation.binding ? this.bindings.adapter(conversation) : undefined;
          if (conversation.binding && !adapter?.delete) throw new StoreError('native_deletion_unavailable', 409);
          if (!record) {
            await this.quiesceForDeletion(id);
            this.store.deletions.begin(id);
          } else {
            // A persisted intent has already passed quiescence. A missing native identity
            // must reach the idempotent delete, not fail a new state/history preflight.
            this.gate.fenceDeletion(id); this.readers.drop(id); this.observation.dispose(id);
            this.store.deletions.begin(id);
          }
          if (conversation.binding) await adapter!.delete!(conversation.binding);
          this.store.deletions.nativeDone(id);
        }
        this.readers.drop(id); this.observation.dispose(id);
        this.store.deletions.complete(id);
      } catch (error) {
        if (this.store.deletions.get(id)) this.store.deletions.fail(id, 'conversation_deletion_failed');
        else this.gate.releaseDeletion(id);
        throw error;
      }
    });
    this.deletions.set(id, pending);
    void pending.then(() => { this.deletions.delete(id); this.gate.releaseDeletion(id); }, () => this.deletions.delete(id));
    return pending;
  }
}

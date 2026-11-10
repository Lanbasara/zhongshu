// Layer 5 (ADR 0024): the front desk. Callers see the same Workbench as before; it assembles the desks below,
// hands each call to the desk that owns it, composes conversation snapshots, and starts, sweeps and closes.
import type { Catalog, HarnessAdapter, HarnessId, NativeItem } from '../harness/types.ts';
import type { Workspace } from './harness-config.ts';
import type { LiveCursor, LiveEvent, QueueCommand, QueueView, RequestAnswer, RequestAnswerView, SubagentList, WorkbenchConfiguration,
  WorkbenchItem, workspaceAddSchema, workspaceManagementSchema } from '../shared/workbench.ts';
import type { SubagentStop } from './subagent-store.ts';
import type { Conversation, CreateConversation, OperationInput, WorkbenchStore } from './workbench-store.ts';
import type { WorkspaceRegistry } from './workspace-registry.ts';
import type { z } from 'zod';
import { Bindings } from './workbench/bindings.ts';
import { Creation } from './workbench/creation.ts';
import { Execution } from './workbench/execution.ts';
import { Gate } from './workbench/gate.ts';
import { History } from './workbench/history.ts';
import { Ledger } from './workbench/ledger.ts';
import { Lifecycle } from './workbench/lifecycle.ts';
import { Observation, type Tail } from './workbench/observation.ts';
import { historyErrorCode } from './workbench/pages.ts';
import { Queue } from './workbench/queue.ts';
import { Readers } from './workbench/readers.ts';
import { Requests } from './workbench/requests.ts';
import { Subagents } from './workbench/subagents.ts';
import { Tasks } from './workbench/tasks.ts';
import { Transcript } from './workbench/transcript.ts';
import { Workspaces } from './workbench/workspaces.ts';

type Desks = {
  creation: Creation; execution: Execution; queue: Queue; readers: Readers; transcript: Transcript;
  subagents: Subagents; requests: Requests; workspaces: Workspaces; lifecycle: Lifecycle;
};

/** One application writer. Native execution outlives browser observers and application connections. */
export class Workbench {
  readonly store: WorkbenchStore;
  private readonly tasks = new Tasks();
  private readonly bindings: Bindings;
  private readonly gate: Gate;
  private readonly observation: Observation;
  private readonly desks: Desks;
  private sweepTimer?: NodeJS.Timeout;
  /** ADR 0025: retention runs hourly, not on every five-second pass. */
  private archiveSweepAt = 0;
  private closing?: Promise<void>;

  constructor(store: WorkbenchStore, initialWorkspaces: Workspace[], adapters: Map<HarnessId, HarnessAdapter>, registry?: WorkspaceRegistry) {
    this.store = store;
    const tasks = this.tasks;
    const bindings = this.bindings = new Bindings(store, initialWorkspaces, adapters, tasks, registry);
    const gate = this.gate = new Gate(store, bindings);
    const ledger = new Ledger(store);
    const history = new History(store, bindings);
    const observation = this.observation = new Observation({ store, tasks, bindings, gate, ledger, history });
    const base = { store, tasks, bindings, gate };
    const ensureSweep = () => this.ensureSweep();
    const execution = new Execution({ ...base, ledger, observation });
    const subagents = new Subagents({ ...base, observation, ensureSweep });
    const readers = new Readers({ ...base, observation, ensureSweep });
    this.desks = {
      creation: new Creation({ ...base, observation }),
      execution,
      queue: new Queue({ ...base, observation, execution }),
      readers,
      transcript: new Transcript({ ...base, history, observation }),
      subagents,
      requests: new Requests(base),
      workspaces: new Workspaces({ ...base, ledger, observation }),
      lifecycle: new Lifecycle({ ...base, history, observation, subagents, readers }),
    };
    // Bells ring in registration order. A saved state first lets the queue pause; once usage and live items are out
    // too, sub-agents and requests follow. After a settled sync queued operations go out before the queue head.
    observation.connect(
      { recover: id => this.desks.execution.reconcile(id), prepare: conversation => this.desks.creation.prepare(conversation) },
      [this.desks.execution, this.desks.queue, this.desks.subagents, this.desks.requests, this.desks.readers],
    );
  }

  // Start, sweep, close.
  /** ADR 0025: archive idle automation-run conversations past the retention period; the hourly sweep runs this. */
  archiveIdleAutomations(now = Date.now()): number { return this.desks.lifecycle.archiveIdleAutomations(now); }
  start(): Promise<void> {
    this.tasks.assertOpen();
    return this.tasks.task(async () => {
      const phases = this.desks.workspaces.start(); if (phases) await phases;
      this.desks.lifecycle.restoreDeletions();
      this.store.recoverDispatching();
      this.store.subagents.recoverDispatching();
      this.store.requests.recoverDispatching();
      this.observation.restorePending();
      this.ensureSweep();
    });
  }
  /** Every 5 seconds: expire reading leases, resume persisted deletions and recover durable execution responsibility. */
  private ensureSweep(): void {
    this.sweepTimer ??= setInterval(() => {
      if (this.tasks.closed) return;
      this.desks.readers.sweep();
      this.desks.subagents.sweep();
      this.desks.lifecycle.restoreDeletions();
      if (Date.now() - this.archiveSweepAt >= 60 * 60_000) {
        this.archiveSweepAt = Date.now();
        try { this.archiveIdleAutomations(this.archiveSweepAt); } catch { /* the next hourly pass looks again */ }
      }
      try { this.observation.restorePending(); } catch { /* Durable recovery resumes on the next bounded pass. */ }
    }, 5000).unref();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.tasks.close();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.desks.requests.close();
    this.closing = (async () => {
      this.observation.disposeAll();
      // Closing connections first unblocks pending RPCs. The database owner may close it only after every task settles.
      await Promise.allSettled([...this.bindings.adapters.values()].map(adapter => Promise.resolve().then(() => adapter.close())));
      await this.tasks.settle();
    })();
    return this.closing;
  }

  // Conversation view.
  async open(id: string) {
    this.tasks.assertOpen(); const conversation = this.bindings.conversation(id);
    this.gate.assertNotDeleting(id);
    if ((conversation.binding || conversation.nativePreparationId) && !this.bindings.workspaceUnavailable(conversation.workspaceId) &&
      !this.gate.executionBlocked(conversation.cwd)) {
      const runtime = this.observation.slot(id);
      if (this.observation.responsible(id) && !runtime?.stop && !runtime?.watching && !runtime?.syncing) this.tasks.launch(this.observation.restore(id));
    }
    // The first screen is the native latest page; no local copy is consulted (ADR 0014).
    await this.observation.ensureTail(id).catch(() => {});
    if (this.observation.slot(id)?.tail || !this.bindings.historyAdapter(this.bindings.conversation(id))) return this.snapshot(id);
    // No memory slot for this conversation (every slot is busy): still serve one native page directly.
    const direct: Tail = await this.observation.readTail(id).then(read => ({ items: read.items, olderCursor: read.olderCursor, at: Date.now() }),
      error => ({ items: [], olderCursor: null, at: Date.now(), error: historyErrorCode(error) }));
    return this.snapshot(id, direct);
  }
  snapshot(id: string, direct?: Tail) {
    this.tasks.assertOpen(); let conversation = this.bindings.conversation(id);
    const unavailable = this.bindings.workspaceUnavailable(conversation.workspaceId);
    if (unavailable) conversation = { ...conversation, readiness: 'blocked', error: unavailable,
      state: { ...conversation.state, configurationVerified: false } };
    else if (!this.bindings.configured(conversation)) { try { this.bindings.adapter(conversation); } catch { conversation = this.bindings.conversation(id); } }
    const { history, items, runIds } = this.observation.view(id, direct);
    return { conversation, history, turnFiles: this.store.readTurnFiles(id, runIds),
      operations: this.store.listOperations({ conversationId: id, order: 'desc', limit: 100 }), queue: this.desks.queue.view(id), requests: this.desks.requests.list(id),
      ...(this.desks.execution.planReady(conversation, items) ? { planReady: { runId: conversation.state.runId! } } : {}),
      revision: this.store.version(), live: this.observation.liveCursor() };
  }
  history(id: string, cursor: string) { return this.desks.transcript.olderPage(id, cursor); }
  liveItem(id: string, itemId: string): WorkbenchItem | null { return this.observation.liveItem(id, itemId); }
  files(id: string, directory = '') { return this.desks.transcript.files(id, directory); }
  workspaceImage(id: string, itemId: string, source: string) { return this.desks.transcript.workspaceImage(id, itemId, source); }

  // Live stream and native activity.
  onLive(listener: (frames: LiveEvent[]) => void): () => void { return this.observation.onLive(listener); }
  liveCursor(): LiveCursor { return this.observation.liveCursor(); }
  onObserved(listener: (id: string, items: NativeItem[]) => void): () => void { return this.observation.onObserved(listener); }
  noticeActivity(id: string): Promise<void> { return this.observation.noticeActivity(id); }

  // Reading and attention.
  reading(id: string, readerId: string): Promise<void> { return this.desks.readers.read(id, readerId); }
  releaseReading(id: string, readerId: string): void { this.desks.readers.release(id, readerId); }
  unread(conversations: readonly Conversation[]): Set<string> { return this.desks.readers.unread(conversations); }
  attention() { return this.desks.readers.attention(); }
  isReading(id: string): boolean { return this.desks.readers.active(id); }

  // Workspaces.
  get workspaces(): Workspace[] { return this.bindings.workspaces; }
  workspaceView(): Omit<WorkbenchConfiguration, 'harnesses'> { return this.desks.workspaces.view(); }
  browseWorkspaceRoot(id: string, path: string[]) { return this.desks.workspaces.browse(id, path); }
  addWorkspace(input: z.infer<typeof workspaceAddSchema>) { return this.desks.workspaces.add(input); }
  manageWorkspace(id: string, input: z.infer<typeof workspaceManagementSchema>): Promise<void> { return this.desks.workspaces.manage(id, input); }
  changeWorkspaceMaintenance(id: string, action: 'pause' | 'resume') { return this.desks.workspaces.changeMaintenance(id, action); }
  workspaceEditStatus(id: string) { return this.desks.workspaces.editStatus(id); }
  listWorkspaceFiles(id: string, directory: string) { return this.desks.workspaces.listFiles(id, directory); }
  openWorkspaceFile(id: string, path: string) { return this.desks.workspaces.openFile(id, path); }
  saveWorkspaceFile(id: string, path: string, version: string, text: string) { return this.desks.workspaces.saveFile(id, path, version, text); }

  // Drafts and creation.
  catalogs(): Promise<Catalog[]> { return this.desks.creation.catalogs(); }
  conversationDefaults(workspaceId?: string): Conversation | null { return this.desks.creation.conversationDefaults(workspaceId); }
  draftSkills(workspaceId: string, harnessId: HarnessId) { return this.desks.creation.draftSkills(workspaceId, harnessId); }
  prepareDraft(workspaceId: string, harnessId: HarnessId, expectedId?: string) { return this.desks.creation.prepareDraft(workspaceId, harnessId, expectedId); }
  draftFiles(workspaceId: string, harnessId: HarnessId, directory = '') { return this.desks.creation.draftFiles(workspaceId, harnessId, directory); }
  create(input: Omit<CreateConversation, 'cwd'>): Promise<Conversation> { return this.desks.creation.create(input); }

  // Sending, stopping, Plan and skills.
  enqueue(input: OperationInput) { return this.desks.execution.enqueue(input); }
  reconcile(id: string): Promise<void> { return this.desks.execution.reconcile(id); }
  validateReferences(conversation: Conversation, input: OperationInput): Promise<void> { return this.desks.execution.validateReferences(conversation, input); }
  skills(id: string) { return this.desks.execution.skills(id); }
  planOf(conversation: Conversation) { return this.desks.execution.planOf(conversation); }
  setPlan(id: string, active: boolean): Promise<Conversation> { return this.desks.execution.setPlan(id, active); }

  // Queue.
  queue(id: string): QueueView { return this.desks.queue.view(id); }
  changeQueue(id: string, command: QueueCommand): Promise<QueueView> { return this.desks.queue.change(id, command); }

  // Rename, archive, delete.
  renameConversation(id: string, title: string): Conversation { return this.desks.lifecycle.rename(id, title); }
  setArchived(id: string, archived: boolean) { return this.desks.lifecycle.setArchived(id, archived); }
  setDeletionGuard(guard: (id: string) => boolean): void { this.gate.setDeletionGuard(guard); }
  quiesceForDeletion(id: string): Promise<Conversation> { return this.desks.lifecycle.quiesceForDeletion(id); }
  deleteConversation(id: string): Promise<void> { return this.desks.lifecycle.delete(id); }
  releaseDeletion(id: string): void { this.gate.releaseDeletion(id); }

  // Sub-agents.
  subagents(id: string): Promise<SubagentList> { return this.desks.subagents.list(id); }
  subagentHistory(id: string, agentId: string, cursor?: string) { return this.desks.subagents.history(id, agentId, cursor); }
  readingSubagent(id: string, agentId: string, readerId: string, active: boolean): Promise<void> { return this.desks.subagents.lease(id, agentId, readerId, active); }
  stopSubagent(id: string, agentId: string, stopId: string): SubagentStop { return this.desks.subagents.stop(id, agentId, stopId); }
  reconcileSubagentStop(id: string, stopId: string): Promise<SubagentStop> { return this.desks.subagents.reconcileStop(id, stopId); }

  // Questions and approvals.
  answerRequest(id: string, requestId: string, answerId: string, answer: RequestAnswer): RequestAnswerView {
    return this.desks.requests.answer(id, requestId, answerId, answer);
  }
  reconcileAnswer(id: string, answerId: string): Promise<RequestAnswerView> { return this.desks.requests.reconcile(id, answerId); }
}

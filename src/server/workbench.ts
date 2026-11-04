import type { HostPhase } from './workspace-maintenance.ts';
import type { Binding, Catalog, HarnessAdapter, HarnessId, HistoryPage, NativeItem, NativeState, Receipt } from '../harness/types.ts';
import { HarnessError } from '../harness/types.ts';
import type { Workspace } from './harness-config.ts';
import { decodeImage, ResourceError, workspacePath } from './resources.ts';
import { nativeText } from '../shared/content.ts';
import { referenceSchema } from '../shared/content.ts';
import { isAbsolute, relative } from 'node:path';
import { listWorkspaceDocuments, openWorkspaceDocument, saveWorkspaceDocument } from './workspace-documents.ts';
import { createHash, randomUUID } from 'node:crypto';
import { StoreError, type ArchiveJob, type WorkbenchStore, type CreateConversation, type OperationInput, type Conversation, type Operation } from './workbench-store.ts';
import type { WorkspaceRegistry } from './workspace-registry.ts';
import type { QueueCommand, QueueView, WorkbenchConfiguration, workspaceAddSchema, workspaceManagementSchema } from '../shared/workbench.ts';
import { z } from 'zod';
import { storageMethods, storageResourceMethods, type AsyncWorkbenchStore } from './storage-client.ts';
import type { DirectoryIndex, DirectoryPage } from './directory-index.ts';
import type { ManagedWorkspaceExecution } from './execution-workspaces.ts';
import type { WorkspaceFileWriter } from './workspace-writer.ts';
import type { BaselineBinding, BaselineObservation, PendingExecution, HostPendingExecution, ExecutionCursor } from './execution-coordinator.ts';

export type ManagedAdapterContext = { operationId?: string; wakeRequestId?: string; admissionId?: string; baseline?: { groupId: string; through: number; after?: ExecutionCursor } };
export type ManagedWorkbenchOptions = { execution?: ManagedWorkspaceExecution;
  recoverCreation?: (conversation: Conversation) => Promise<Binding | null>; writer?: WorkspaceFileWriter;
  resolveHostPending?: (pending: HostPendingExecution) => Promise<'settled' | 'pending' | 'unknown'>;
  managedAdapter?: (conversation: Conversation, raw: HarnessAdapter, context?: ManagedAdapterContext) => HarnessAdapter | Promise<HarnessAdapter> };

const TERMINAL = new Set<NativeState['status']>(['idle', 'interrupted', 'failed']);
const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_BYTES = 16 * 1024 * 1024;
type Runtime = {
  stop?: () => void; watching?: Promise<void>; syncing?: Promise<void>;
  timer?: NodeJS.Timeout; poll?: NodeJS.Timeout; flush?: NodeJS.Timeout;
  live: Map<string, NativeItem>; generation: number; stateGeneration: number; dirty: boolean; state?: NativeState['status']; stateWrite?: Promise<unknown>;
};
type ArchiveReader = Pick<HarnessAdapter, 'history' | 'historyChanges' | 'readItems' | 'readBodyChunk' | 'releaseBodySource' | 'readImage'>;

/** One application writer. Native execution outlives browser observers and application connections. */
export class Workbench {
  readonly store: AsyncWorkbenchStore;
  private readonly initialWorkspaces: Workspace[];
  private readonly registry?: WorkspaceRegistry;
  private readonly directoryIndex?: DirectoryIndex;
  private readonly execution?: ManagedWorkspaceExecution;
  private readonly writer?: WorkspaceFileWriter;
  private readonly recoverCreation?: ManagedWorkbenchOptions['recoverCreation'];
  private readonly resolveHostPending?: ManagedWorkbenchOptions['resolveHostPending'];
  private readonly managedAdapter?: ManagedWorkbenchOptions['managedAdapter'];
  private readonly adapters: Map<HarnessId, HarnessAdapter>;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly processing = new Map<string, Promise<void>>();
  private readonly busyConversations = new Map<string, number>();
  private readonly maintenancePhases = new Map<string, HostPhase | 'transition'>();
  private readonly savingDirectories = new Set<string>();
  private readonly preparing = new Set<string>();
  private readonly removing = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;
  private catalogCache?: Catalog[];
  private catalogAt = 0;
  private catalogLoading?: Promise<Catalog[]>;
  private queueRecovery?: NodeJS.Timeout;
  private queueRecoveryCursor = '';
  private archiveTimer?: NodeJS.Timeout;
  private archiveAdvancing = false;
  private readonly archiveInFlight = new Map<string, Promise<void>>();
  private indexSweepAt = 0;
  private indexSweepRunning = false;

  constructor(store: WorkbenchStore | AsyncWorkbenchStore, initialWorkspaces: Workspace[], adapters: Map<HarnessId, HarnessAdapter>, registry?: WorkspaceRegistry, directoryIndex?: DirectoryIndex, managed: ManagedWorkbenchOptions = {}) {
    const methods = Object.fromEntries(Object.keys(storageMethods).map(key => [key, (...args: unknown[]) =>
      Promise.resolve().then(() => Reflect.apply(store[key as keyof typeof storageMethods], store, args))]));
    const resources = Object.fromEntries(Object.keys(storageResourceMethods).map(key => [key, (...args: unknown[]) =>
      Promise.resolve().then(() => Reflect.apply(store.resources[key as keyof typeof storageResourceMethods], store.resources, args))]));
    this.store = { ...methods, resources } as AsyncWorkbenchStore; this.adapters = adapters;
    this.initialWorkspaces = initialWorkspaces; this.registry = registry; this.directoryIndex = directoryIndex;
    this.execution = managed.execution; this.managedAdapter = managed.managedAdapter; this.recoverCreation = managed.recoverCreation; this.writer = managed.writer;
    this.resolveHostPending = managed.resolveHostPending;
  }
  get workspaces(): Workspace[] { return this.initialWorkspaces; }
  async workspaceView(): Promise<Omit<WorkbenchConfiguration, 'harnesses'>> {
    return this.registry ? await this.registry.view() : { workspaces: this.workspaces.map(({ id, label }) => ({ id, label })), workspaceCursor: null, removedWorkspaceCursor: null };
  }
  async workspacePage(options: { cursor?: string; query?: string; removed?: boolean } = {}) {
    if (this.registry) return await this.registry.page(options);
    const workspaces = options.removed ? [] : this.workspaces.filter(item => !options.query || item.label.toLocaleLowerCase().includes(options.query.toLocaleLowerCase()));
    return { workspaces: workspaces.map(({ id, label }) => ({ id, label })), nextCursor: null };
  }
  async workspaceMetadata(id: string) {
    if (this.registry) return await this.registry.metadata(id);
    const workspace = this.workspaces.find(item => item.id === id);
    if (!workspace) throw new StoreError('workspace_not_found', 404);
    return { id, label: workspace.label, removed: false };
  }
  async isRegisteredWorkspace(id: string): Promise<boolean> {
    return this.registry ? !!await this.registry.configured(id, true) : this.workspaces.some(item => item.id === id);
  }
  async browseWorkspaceRoot(id: string, path: string[], options: { cursor?: string; limit?: number; refresh?: boolean } = {}) {
    if (!this.registry) throw new StoreError('workspace_root_not_found', 404);
    if (this.directoryIndex) {
      const { currentDirectory, ...target } = this.registry.browseTarget(id, path);
      const { entries, ...page } = await this.directoryIndex.page({ ...target, ...options });
      const reachedFiles = entries.some(entry => !entry.directory);
      return { ...page, names: entries.filter(entry => entry.directory).map(entry => entry.name), currentDirectory,
        nextCursor: reachedFiles ? null : page.nextCursor };
    }
    return this.registry.browse(id, path);
  }
  async addWorkspace(input: z.infer<typeof workspaceAddSchema>) {
    this.assertOpen();
    if (!this.registry) throw new StoreError('workspace_root_not_found', 404);
    const id = await this.registry.add(input); await this.execution?.registerWorkspace(id); return id;
  }
  async manageWorkspace(id: string, input: z.infer<typeof workspaceManagementSchema>): Promise<void> {
    this.assertOpen();
    const registry = this.registry;
    const entry = await registry?.get(id);
    if (registry) await registry.metadata(id);
    if (!registry || !entry) throw new StoreError('workspace_not_found', 404);
    if (this.removing.has(id)) throw new StoreError('workspace_remove_busy', 409);
    if (input.action === 'restore') {
      if (entry.removed) await registry.restore(entry);
      return;
    }
    if (entry.removed) {
      if (input.action === 'remove') return;
      throw new StoreError('workspace_removed', 409);
    }
    if (input.action === 'rename') { await registry.rename(id, input.label); return; }
    if (input.action === 'pin') { await registry.pin(id, input.pinned); return; }
    if (this.execution && await this.execution.managed(id)) {
      this.removing.add(id);
      try {
        const status = await this.execution.change(id, 'pause');
        if (!status.editable) throw new StoreError('workspace_remove_busy', 409);
        // Only the bounded live observation cache needs flushing; completed
        // historical conversations do not participate in removal permission.
        for (const [conversationId, runtime] of this.runtimes) {
          const conversation = await this.store.getConversation(conversationId);
          if (conversation?.workspaceId === id) { await this.flushLive(conversationId, runtime); this.disposeRuntime(conversationId); }
        }
        await registry.remove(id);
        await this.execution.change(id, 'resume');
        return;
      } finally { this.removing.delete(id); }
    }
    if (this.executionBlocked(entry.directory)) throw new StoreError('workspace_remove_busy', 409);
    this.removing.add(id);
    try {
      await this.task(async () => {
        if (!await this.confirmWorkspaceIdle(entry.directory, false, id) || this.executionBlocked(entry.directory))
          throw new StoreError('workspace_remove_busy', 409);
        this.assertOpen();
        for await (const conversation of this.workspaceConversations(entry.directory, id)) {
          const runtime = this.runtimes.get(conversation.id);
          if (runtime) (await this.flushLive(conversation.id, runtime));
        }
        await registry.remove(id);
        for await (const conversation of this.workspaceConversations(entry.directory, id)) this.disposeRuntime(conversation.id);
      });
    } finally { this.removing.delete(id); }
  }
  private async workspaceUnavailable(id: string): Promise<string | undefined> {
    const entry = await this.registry?.get(id);
    if (!entry) return;
    if (entry.removed) return 'workspace_removed';
    try { this.registry!.verify(entry); }
    catch (error) { return error instanceof StoreError ? error.code : 'workspace_directory_unavailable'; }
  }
  private async assertWorkspaceAvailable(id: string): Promise<void> {
    const reason = (await this.workspaceUnavailable(id));
    if (reason) throw new StoreError(reason, 409);
  }
  private task<T>(action: () => Promise<T>): Promise<T> {
    const promise = action(); this.tasks.add(promise);
    void promise.then(() => this.tasks.delete(promise), () => this.tasks.delete(promise));
    return promise;
  }
  private launch(promise: Promise<unknown>): void {
    this.tasks.add(promise);
    void promise.then(() => this.tasks.delete(promise), () => this.tasks.delete(promise));
  }
  private assertOpen(): void { if (this.closed) throw new StoreError('workbench_closed', 503); }
  private async conversation(id: string): Promise<Conversation> {
    await this.runtimes.get(id)?.stateWrite;
    const conversation = (await this.store.getConversation(id));
    if (!conversation) throw new StoreError('conversation_not_found', 404);
    return conversation;
  }
  private async configured(conversation: Conversation): Promise<boolean> {
    const workspace = this.registry ? await this.registry.configured(conversation.workspaceId) : this.workspaces.find(item => item.id === conversation.workspaceId);
    const adapter = this.adapters.get(conversation.harnessId);
    return workspace?.directory === conversation.cwd && adapter?.id === conversation.harnessId &&
      !(await this.workspaceUnavailable(conversation.workspaceId));
  }
  private async adapter(conversation: Conversation, context?: ManagedAdapterContext): Promise<HarnessAdapter> {
    (await this.assertWorkspaceAvailable(conversation.workspaceId));
    if (!(await this.configured(conversation))) {
      this.launch(this.task(async () => { await this.store.setConversationState(conversation.id, { readiness: 'blocked', error: 'conversation_configuration_changed',
        state: { status: 'unknown', pendingInputs: conversation.state.pendingInputs, configurationVerified: false, reason: 'conversation_configuration_changed' } }); }));
      throw new StoreError('conversation_configuration_changed', 409);
    }
    const raw = this.adapters.get(conversation.harnessId)!;
    return this.managedAdapter ? await this.managedAdapter(conversation, raw, context) : raw;
  }
  private async archiveAccess(conversation: Conversation): Promise<{ reader: ArchiveReader; removed: boolean }> {
    const workspace = this.registry ? await this.registry.configured(conversation.workspaceId, true) : this.workspaces.find(value => value.id === conversation.workspaceId);
    const raw = this.adapters.get(conversation.harnessId);
    if (!workspace || workspace.directory !== conversation.cwd || !raw || raw.id !== conversation.harnessId ||
      !conversation.binding || conversation.binding.cwd !== conversation.cwd) throw new StoreError('archive_source_changed', 409);
    const registration = await this.registry?.get(conversation.workspaceId);
    if (registration) this.registry!.verify(registration);
    const removed = Boolean(registration?.removed);
    if (removed && !raw.historyReadOnly) throw new StoreError('archive_read_requires_permission', 409);
    // The connection-wide managed projection exposes read methods only; never
    // create an execution/observation permit merely to archive a removed scope.
    return { reader: raw, removed };
  }
  private unknown(id: string, reason: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (runtime) runtime.state = 'unknown';
    const generation = runtime?.stateGeneration;
    const write = this.task(async () => {
      const current = await this.store.getConversation(id);
      if (!current || this.runtimes.get(id) !== runtime || runtime?.stateGeneration !== generation) return;
      await this.store.setConversationState(id, { error: reason, state: { status: 'unknown', pendingInputs: current.state.pendingInputs,
        configurationVerified: false, reason, ...(current.state.runId ? { runId: current.state.runId } : {}) } });
    });
    if (runtime) runtime.stateWrite = write;
    return write;
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

  private async workspace(id: string): Promise<Workspace> {
    this.assertOpen();
    (await this.assertWorkspaceAvailable(id));
    const workspace = this.registry ? await this.registry.configured(id) : this.workspaces.find(item => item.id === id);
    if (!workspace) throw new StoreError('workspace_not_found', 404);
    return workspace;
  }
  private overlaps(left: string, right: string): boolean {
    const contains = (parent: string, child: string) => {
      const path = relative(parent, child);
      return path !== '..' && !path.startsWith('../') && !isAbsolute(path);
    };
    return contains(left, right) || contains(right, left);
  }
  private saving(directory: string): boolean {
    return [...this.savingDirectories].some(root => this.overlaps(root, directory));
  }
  private executionBlocked(directory: string): boolean {
    return !!this.execution && !this.execution.initialized || this.saving(directory) || this.workspaces.some(workspace => workspace.maintenance &&
      this.overlaps(directory, workspace.directory) && this.maintenancePhases.get(workspace.id) !== 'online');
  }
  async changeWorkspaceMaintenance(id: string, action: 'pause' | 'resume') {
    const workspace = (await this.workspace(id));
    if (this.execution && await this.execution.managed(id)) return this.task(() => this.execution!.change(id, action));
    const controller = workspace.maintenance;
    const { directory } = workspace;
    if (!controller) throw new StoreError('workspace_maintenance_unavailable', 409);
    const previous = this.maintenancePhases.get(id);
    if (previous === 'transition' || this.saving(directory)) throw new StoreError('workspace_maintenance_busy', 409);
    if (action === 'pause' && previous === 'paused') return (await this.workspaceEditStatus(id));
    if (action === 'pause' && previous !== 'online') throw new StoreError('workspace_maintenance_unavailable', 409);
    this.maintenancePhases.set(id, 'transition');
    return this.task(async () => {
      let next: HostPhase = 'unknown';
      try {
        if (action === 'pause' && !await this.confirmWorkspaceIdle(directory)) {
          next = 'online';
          throw new StoreError('workspace_not_idle', 409);
        }
        const expected = action === 'pause' ? 'paused' : 'online';
        if (await controller(action) !== expected || await controller('status') !== expected)
          throw new StoreError('workspace_maintenance_unavailable', 409);
        if (action === 'pause') {
          for await (const conversation of this.workspaceConversations(directory)) {
            const runtime = this.runtimes.get(conversation.id);
            if (runtime) {
              for (const item of runtime.live.values()) (await this.store.saveLiveItem(conversation.id, item));
              this.disposeRuntime(conversation.id);
            }
          }
        }
        if (action === 'resume' && !await this.confirmWorkspaceIdle(directory, true) &&
          !await this.confirmWorkspaceIdle(directory, true))
          throw new StoreError('workspace_maintenance_unavailable', 409);
        next = expected;
      } finally {
        this.maintenancePhases.set(id, next);
      }
      return (await this.workspaceEditStatus(id));
    });
  }
  private async *workspaceConversations(directory: string, workspaceId?: string) {
    let beforeId: string | undefined;
    for (;;) {
      const page: Conversation[] = (await this.store.listConversations({ beforeId, limit: 100, workspaceId }));
      for (const conversation of page) if (workspaceId || this.overlaps(directory, conversation.cwd)) yield conversation;
      if (page.length < 100) return;
      beforeId = page.at(-1)!.id;
    }
  }
  // Maintenance owns the execution gate while reading native state. History
  // delivery and observation-slot eviction do not participate in this proof.
  private async confirmWorkspaceIdle(directory: string, publish = false, removingId?: string): Promise<boolean> {
    const check = async (conversation: Conversation) => {
      if (!conversation.binding || !(await this.configured(conversation)) ||
        this.preparing.has(conversation.id) || this.busyConversations.has(conversation.id)) return false;
      const id = conversation.id;
      const runtime = this.runtimes.get(id);
      const generation = runtime?.stateGeneration;
      const target = (await this.latestAcceptedMessage(id))?.runId;
      try {
        const state = await (await this.adapter(conversation)).state(conversation.binding, target ?? undefined);
        this.assertOpen();
        const current = (await this.conversation(id));
        if (this.runtimes.get(id) !== runtime || runtime?.stateGeneration !== generation ||
          (await this.latestAcceptedMessage(id))?.runId !== target || this.busyConversations.has(id) ||
          !(await this.configured(current)) || current.binding?.id !== conversation.binding.id ||
          !(removingId ? TERMINAL.has(state.status) : state.status === 'idle') ||
          !(await this.messageAllowed({ ...current, state, readiness: 'ready' }, undefined, true))) return false;
        if (publish) {
          if (runtime) runtime.stateGeneration++;
          (await this.store.setConversationState(id, { state, readiness: 'ready', error: null }));
        }
        return true;
      } catch { return false; }
    };
    let batch: Promise<boolean>[] = [];
    for await (const conversation of this.workspaceConversations(directory, removingId)) {
      batch.push(check(conversation));
      if (batch.length === 4) {
        if (!(await Promise.all(batch)).every(Boolean)) return false;
        batch = [];
      }
    }
    return (await Promise.all(batch)).every(Boolean);
  }

  private async idleForEditing(conversation: Conversation): Promise<boolean> {
    const runtime = this.runtimes.get(conversation.id);
    return (await this.configured(conversation)) && !this.preparing.has(conversation.id) &&
      !this.busyConversations.has(conversation.id) && !!runtime?.stop && !runtime.syncing &&
      conversation.state.status === 'idle' && (await this.messageAllowed(conversation));
  }
  private async observeExecutionBaseline(binding: BaselineBinding, context: { groupId: string; through: number; after?: ExecutionCursor }): Promise<BaselineObservation> {
    const conversation = await this.store.getConversation(binding.id);
    const registration = await this.registry?.get(binding.workspaceId);
    if (!conversation || !conversation.binding || conversation.binding.id !== binding.bindingId || conversation.workspaceId !== binding.workspaceId ||
      !registration || registration.identity !== binding.directoryIdentity || registration.directory !== conversation.cwd)
      throw new StoreError('execution_binding_unverified', 409);
    this.registry!.verify(registration);
    const raw = this.adapters.get(conversation.harnessId);
    if (!raw || !this.managedAdapter) throw new StoreError('execution_controller_unavailable', 503);
    const adapter = await this.managedAdapter(conversation, raw, { baseline: context });
    // The managed adapter's private proxy must gate native activation performed
    // by state/reconcile. This is a fresh native observation, never cached idle.
    const observed = await adapter.state(conversation.binding);
    if (!observed.configurationVerified || observed.status === 'unknown') throw new StoreError('execution_native_state_unknown', 409);
    const state = observed.status === 'running' ? 'running' : observed.status === 'waiting' || observed.pendingInputs > 0 ? 'waiting' : 'idle';
    return { ...binding, state, proof: createHash('sha256').update(JSON.stringify([binding, observed])).digest('hex') };
  }
  private async resolveExecutionPending(pending: PendingExecution): Promise<'settled' | 'pending' | 'unknown'> {
    const execution = this.execution; if (!execution || this.closed) return 'unknown';
    if (pending.kind === 'host') return this.resolveHostPending ? this.resolveHostPending(pending) : 'unknown';
    let admission = await execution.port.admission(pending.id);
    if (!admission || admission.kind === 'settled') return 'settled';
    if (!admission.conversationId) return 'unknown';
    let conversation = await this.store.getConversation(admission.conversationId);
    if (!conversation?.binding || conversation.workspaceId !== admission.workspaceId) return 'unknown';
    if (admission.source === 'native' && admission.bindingId === 'create:' + conversation.id) admission = await execution.port.attachNativeBinding(admission.id);
    if (conversation.binding.id !== admission.bindingId) return 'unknown';
    const registration = await this.registry?.get(conversation.workspaceId);
    if (!registration || registration.identity !== admission.directoryIdentity || registration.directory !== conversation.cwd) return 'unknown';
    this.registry!.verify(registration);
    const raw = this.adapters.get(conversation.harnessId); if (!raw) return 'unknown';
    let operation = admission.currentOperation ? await this.store.getOperation(admission.currentOperation) : null;
    if (!this.managedAdapter) return 'unknown';
    const adapter = await this.managedAdapter(conversation, raw, { operationId: operation?.id, admissionId: admission.id });
    const target = operation?.runId ?? (await this.latestAcceptedMessage(conversation.id))?.runId ?? undefined;
    let state = await adapter.state(conversation.binding, target);
    if (!state.configurationVerified || state.status === 'unknown') return 'unknown';
    const terminal = () => TERMINAL.has(state.status) && state.pendingInputs === 0;
    const confirm = async () => {
      await execution.port.confirmTerminal({ admissionId: admission!.id, bindingId: conversation!.binding!.id, operationId: admission!.currentOperation,
        proof: createHash('sha256').update(JSON.stringify([admission!.id, admission!.currentOperation, conversation!.binding!.id, state])).digest('hex') });
      return 'settled' as const;
    };
    if (admission.source === 'native') return terminal() ? confirm() : 'pending';
    if (operation && this.processing.has(operation.id)) return 'pending';
    if (operation && ['dispatching', 'unknown'].includes(operation.status) || operation?.status === 'accepted' && operation.runId === null) {
      const receipt = await adapter.reconcile(conversation.binding, operation!.id);
      if (receipt.outcome === 'unknown') return 'unknown';
      // Reconciliation never revokes an already established acceptance.
      if (operation!.status !== 'accepted' || receipt.outcome === 'accepted') await this.store.settleOperation(operation!.id, receipt);
      operation = await this.store.getOperation(operation!.id);
      admission = await execution.port.admission(admission.id);
      if (!admission || admission.kind === 'settled') return 'settled';
    }
    if (operation?.status === 'accepted') {
      if (!operation.runId) return 'pending';
      state = await adapter.state(conversation.binding, operation.runId);
      if (!state.configurationVerified || state.status === 'unknown') return 'unknown';
      if (terminal() && (state.runId === operation.runId || state.terminalRunId === operation.runId && state.terminalStatus !== undefined)) return confirm();
      return 'pending';
    }
    if (registration.removed || !terminal()) return 'pending';
    // Dispatch uses only the already admitted original input and a fresh state;
    // no history loading or observation slot participates in this proof.
    await this.store.setConversationState(conversation.id, { state, readiness: 'ready', error: null });
    conversation = (await this.store.getConversation(conversation.id))!;
    if (admission.source === 'queue' && (!operation || operation.status === 'rejected')) {
      const queue = await this.store.readQueue(conversation.id); const head = queue.entries[0];
      if (!head || head.entryId !== admission.queueId || head.status !== 'waiting' || queue.pause ||
        queue.afterRunId && (state.status !== 'idle' || state.runId !== queue.afterRunId && (state.terminalRunId !== queue.afterRunId || state.terminalStatus !== 'completed'))) return 'pending';
      try { operation = await this.store.claimQueue(conversation.id, head.entryId, head.version, randomUUID(), { mode: 'next' }); }
      catch (error) { if (error instanceof StoreError && ['execution_dispatch_closed', 'operation_needs_reconciliation', 'queue_entry_changed'].includes(error.code)) return 'pending'; throw error; }
    } else if (operation?.status === 'queued') {
      if (!await this.messageAllowed(conversation, operation, true)) return 'pending';
      try { if (!await this.store.claimOperation(operation.id)) return 'pending'; }
      catch (error) { if (error instanceof StoreError && error.code === 'execution_dispatch_closed') return 'pending'; throw error; }
    } else return 'pending';
    if (!operation || operation.type !== 'message') return 'unknown';
    let receipt: Receipt;
    try {
      await this.validateReferences(conversation, operation);
      const currentAdapter = this.managedAdapter ? await this.managedAdapter(conversation, raw, { operationId: operation.id }) : raw;
      receipt = operation.queuedInput
        ? currentAdapter.submitQueued ? await currentAdapter.submitQueued(conversation.binding!, await this.messageInput(operation), operation.queuedInput.delivery) : { outcome: 'unknown', reason: 'queue_mode_unavailable' }
        : await currentAdapter.submit(conversation.binding!, await this.messageInput(operation));
    } catch { receipt = { outcome: 'unknown', reason: 'native_receipt_unknown' }; }
    await this.store.settleOperation(operation.id, receipt);
    return receipt.outcome === 'unknown' ? 'unknown' : 'pending';
  }
  async workspaceEditStatus(id: string) {
    if (this.execution && await this.execution.managed(id)) { await this.workspace(id); return this.execution.status(id); }
    const { directory, managedWrites, maintenance } = (await this.workspace(id));
    if (!managedWrites) return { editable: false, reason: 'workspace_writes_unmanaged' };
    if (this.saving(directory)) return { editable: false, reason: 'workspace_save_in_progress' };
    const phase = maintenance ? this.maintenancePhases.get(id) ?? 'unknown' : undefined;
    if (phase && phase !== 'online') {
      return { editable: phase === 'paused', reason: phase === 'paused' ? null : 'workspace_maintenance_' + phase, maintenance: phase };
    }
    let idle = true;
    let restoring = 0;
    for await (const conversation of this.workspaceConversations(directory)) {
      if (phase === 'online') {
        if (!(await this.configured(conversation)) || this.preparing.has(conversation.id) || this.busyConversations.has(conversation.id) ||
          ['running', 'waiting', 'interrupted', 'failed'].includes(conversation.state.status) || conversation.state.pendingInputs) idle = false;
        continue;
      }
      if ((await this.idleForEditing(conversation))) continue;
      idle = false;
      if (restoring < 4 && (await this.configured(conversation)) && conversation.binding &&
        !this.runtimes.get(conversation.id)?.stop && !this.runtimes.get(conversation.id)?.watching) {
        restoring++;
        this.launch(this.restoreConversation(conversation.id));
      }
    }
    if (phase === 'online') {
      return { editable: false, reason: idle ? 'workspace_maintenance_online' : 'workspace_not_idle', maintenance: phase, canPause: idle };
    }
    return { editable: idle, reason: idle ? null : 'workspace_not_idle' };
  }
  async listWorkspaceFiles(id: string, directory: string, options: { cursor?: string; limit?: number; refresh?: boolean } = {}): Promise<DirectoryPage> {
    if (this.directoryIndex) {
      const page = await this.directoryIndex.page({ root: (await this.workspace(id)).directory, path: directory, identity: (await this.registry?.get(id))?.identity, ...options });
      (await this.assertWorkspaceAvailable(id));
      return page;
    }
    const result = await listWorkspaceDocuments((await this.workspace(id)).directory, directory, (await this.registry?.get(id))?.identity);
    (await this.assertWorkspaceAvailable(id));
    // Legacy synchronous fixtures retain their limited reader. Production always
    // injects the durable directory index and never labels this fallback complete.
    return { entries: result, nextCursor: null, generation: null, latestGeneration: null, status: 'ready', complete: false,
      refreshing: false, scanned: result.length, discovered: result.length, sourceChanged: false, snapshot: false };
  }
  async openWorkspaceFile(id: string, path: string) {
    const result = await openWorkspaceDocument((await this.workspace(id)).directory, path, (await this.registry?.get(id))?.identity);
    (await this.assertWorkspaceAvailable(id));
    return result;
  }
  async saveWorkspaceFile(id: string, path: string, version: string, text: string, saveId: string = randomUUID()) {
    const { directory, maintenance } = (await this.workspace(id));
    const entry = await this.registry?.get(id);
    const identity = entry?.identity;
    const assertRegistration = () => { if (entry) this.registry!.verify(entry); };
    if (this.removing.has(id)) throw new StoreError('workspace_remove_busy', 409);
    if (this.execution && await this.execution.managed(id)) {
      if (!identity) throw new StoreError('execution_directory_changed', 409);
      if (!this.writer) throw new StoreError('file_writer_unavailable', 503);
      const writerId = await this.writer.owner();
      type Result = { document?: Awaited<ReturnType<typeof openWorkspaceDocument>>; error?: ResourceError };
      const result = await this.task(() => this.execution!.save<Result>(id, saveId, { workspaceId: id, directoryIdentity: identity,
        path, expectedVersion: version, contentDigest: createHash('sha256').update(text).digest('hex') }, async permit => {
        const written = await this.writer!.write({ root: directory, permit, text });
        if (!('proof' in written)) throw new StoreError('execution_save_unresolved', 409);
        return { outcome: written.outcome, proof: written.proof, value: written.outcome === 'committed'
          ? { document: written.document ?? await openWorkspaceDocument(directory, path, identity) }
          : { error: new ResourceError(written.reason ?? 'file_write_rejected', written.reason === 'file_read_only' ? 403 : 409) } };
      }, writerId));
      if (result.status === 'unknown' || result.status === 'duplicate') throw new StoreError(result.status === 'unknown' || result.outcome === 'pending' ? 'execution_save_unresolved' : 'execution_save_already_resolved', 409);
      if (result.value.error) throw result.value.error;
      return result.value.document!;
    }
    const status = (await this.workspaceEditStatus(id));
    if (!status.editable) throw new StoreError(status.reason!, 409);
    if (this.saving(directory)) throw new StoreError('workspace_save_in_progress', 409);
    this.savingDirectories.add(directory);
    return this.task(async () => {
      try {
        if (maintenance) {
          if (await maintenance('status') !== 'paused') {
            this.maintenancePhases.set(id, 'unknown');
            throw new StoreError('workspace_maintenance_unavailable', 409);
          }
          return await saveWorkspaceDocument(directory, path, version, text, () => {
            this.assertOpen(); assertRegistration();
          }, identity);
        }
        const guards: (() => boolean)[] = [];
        for await (const conversation of this.workspaceConversations(directory)) {
          await this.sync(conversation.id);
          const current = await this.conversation(conversation.id);
          const runtime = this.runtimes.get(current.id);
          const generation = runtime?.stateGeneration;
          if (!await this.idleForEditing(current) || runtime?.stateGeneration !== generation) throw new ResourceError('workspace_not_idle', 409);
          guards.push(() => this.runtimes.get(current.id) === runtime && runtime?.stateGeneration === generation &&
            runtime?.state === 'idle' && !runtime.dirty && !this.busyConversations.has(current.id) && !this.preparing.has(current.id));
        }
        const assertWritable = () => {
          this.assertOpen();
          assertRegistration();
          if (!guards.every(check => check())) throw new ResourceError('workspace_not_idle', 409);
        };
        assertWritable();
        return await saveWorkspaceDocument(directory, path, version, text, assertWritable, identity);
      } finally { this.savingDirectories.delete(directory); }
    });
  }

  async files(id: string, directory = '', options: { cursor?: string; limit?: number; refresh?: boolean } = {}) {
    const conversation = (await this.conversation(id)); (await this.adapter(conversation));
    return await this.listWorkspaceFiles(conversation.workspaceId, directory, options);
  }
  async workspaceImage(id: string, itemId: string, source: string) {
    const conversation = (await this.conversation(id));
    const item = (await this.store.getItem(id, itemId));
    if (!item || !item.text.includes(source)) throw new StoreError('image_unavailable', 404);
    const owner = 'markdown:' + createHash('sha256').update(itemId + '\0' + source).digest('hex');
    const cached = (await this.store.resources.owned(id, owner)); if (cached) return cached;
    const reference = referenceSchema.parse({ type: 'file', path: decodeURIComponent(source).replace(/^\.\//, '') });
    if (reference.type !== 'file') throw new StoreError('invalid_request', 400);
    const adapter = (await this.adapter(conversation));
    if (!conversation.binding || !adapter.readImage) throw new StoreError('image_unavailable', 404);
    const path = await workspacePath(conversation.cwd, reference.path);
    // Read in the native Host, never turn Markdown into a host-user filesystem proxy.
    const data = decodeImage(await adapter.readImage(conversation.binding, path));
    (await this.assertWorkspaceAvailable(conversation.workspaceId));
    const image = (await this.store.resources.put(id, reference.path.split('/').at(-1)!.slice(0,120), data, 'archive'));
    (await this.store.resources.pin(id, image.id, owner));
    return (await this.store.resources.get(id, image.id));
  }
  async validateReferences(conversation: Conversation, input: OperationInput): Promise<void> {
    if (input.type !== 'message') return;
    for (const ref of input.payload.references ?? []) {
      if (ref.type === 'file') await workspacePath(conversation.cwd, ref.path);
      else {
        const item = (await this.store.getItem(conversation.id, ref.itemId));
        if (!item) throw new StoreError('quote_source_changed', 409);
      }
    }
    let totalImageBytes = 0;
    for (const image of input.payload.images ?? []) {
      const saved = (await this.store.resources.get(conversation.id, image.id));
      totalImageBytes += saved.data.length;
      if (saved.name !== image.name || saved.mediaType !== image.mediaType) throw new StoreError('image_reference_changed', 409);
    }
    if (totalImageBytes > 4 * 1024 * 1024) throw new StoreError('message_images_too_large', 413);
  }
  private async materialize(conversation: Conversation, items: NativeItem[], adapter: ArchiveReader, allowFileImages: boolean, bodyBudget = Infinity): Promise<NativeItem[]> {
    const output: NativeItem[] = [];
    const leased = new Set(items.flatMap(item => [...Object.values(item.bodySources ?? {}).map(source => source.token),
      ...(item.imageSources ?? []).flatMap(source => source.releaseToken ? [source.releaseToken] : [])]));
    let importedBytes = 0;
    try { for (const raw of items) {
      const { imageSources, bodySources, ...item } = raw;
      const recorded = item.kind === 'user' && item.operationId ? await this.store.getOperation(item.operationId) : null;
      const original = recorded?.type === 'message' && recorded.conversationId === conversation.id ? recorded.payload : undefined;
      if (bodySources) {
        if (!conversation.binding || !adapter.readBodyChunk) throw new StoreError('native_body_reader_unavailable', 502);
        const published = item.sourceRevision ? await this.store.getItem(conversation.id, item.id) : null;
        const newerPublished = published && !published.previewOnly && published.sourceRevision?.generation === item.sourceRevision?.generation &&
          published.sourceRevision!.sequence >= item.sourceRevision!.sequence ? published : null;
        try { for (const field of ['text', 'input', 'output'] as const) {
          const source = bodySources[field];
          if (!source) continue;
          // The message shown to the user is the accepted original input. The
          // native transport may expand quotes/skills into its text; attaching
          // that body's digest to the original preview would mix two versions.
          // The original text and references are archived by mergeHistory.
          if (field === 'text' && original) continue;
          const savedText = newerPublished ? field === 'text' ? newerPublished.text : newerPublished.tool?.[field] : undefined;
          const savedBody = newerPublished?.bodies?.[field];
          // Reverse pages can contain an older revision of an already published
          // tool result. Keep its missing immutable input eligible for import,
          // but do not re-create an obsolete body after a newer one retired it.
          if (newerPublished && (savedText !== undefined || savedBody)) {
            if (field === 'text') item.text = savedText ?? '';
            else if (item.tool) item.tool = { ...item.tool, [field]: savedText ?? '' };
            if (savedBody) item.bodies = { ...item.bodies, [field]: savedBody };
            continue;
          }
          const stage = await this.store.beginBodyStage(conversation.id, item.id, field, { version: source.version, bytes: source.bytes }, item.sourceRevision);
          let offset = stage.nextOffset;
          while (offset < source.bytes) {
            this.assertOpen();
            if (importedBytes >= bodyBudget) throw new StoreError('archive_budget_yield', 503);
            const chunk = await adapter.readBodyChunk(conversation.binding, source.token, offset, 64 * 1024);
            if (chunk.version !== source.version || chunk.bytes !== source.bytes || chunk.offset !== offset ||
              !chunk.data.byteLength || chunk.data.byteLength > 64 * 1024 || offset + chunk.data.byteLength > source.bytes ||
              chunk.nextOffset !== (offset + chunk.data.byteLength === source.bytes ? null : offset + chunk.data.byteLength))
              throw new StoreError('native_body_changed', 502);
            offset = await this.store.stageBodyChunk(stage.stageId, offset, chunk.data);
            importedBytes += chunk.data.byteLength;
            if (importedBytes >= bodyBudget && offset < source.bytes) throw new StoreError('archive_budget_yield', 503);
          }
          while (!(await this.store.validateBodyStage(stage.stageId)).complete) this.assertOpen();
          item.bodies = { ...item.bodies, [field]: await this.store.finishBodyStage(stage.stageId) };
        } } finally {
          if (adapter.releaseBodySource) for (const token of new Set(Object.values(bodySources).map(source => source.token))) {
            try { await adapter.releaseBodySource(conversation.binding, token); } catch { /* Native cache lease expires independently; archive progress must retain its original result. */ }
            leased.delete(token);
          }
        }
      }
      if (imageSources?.length && conversation.binding && item.status === 'completed') {
        const previous = await this.store.getItem(conversation.id, item.id);
        const images = [];
        for (const [index, source] of imageSources.slice(0,4).entries()) {
          const owner = 'native-image:' + createHash('sha256').update(JSON.stringify([item.id, index])).digest('hex');
          try {
            const saved = await this.store.resources.owned(conversation.id, owner);
            if (saved) { images.push({ id: saved.id, name: saved.name, mediaType: saved.mediaType }); continue; }
            const old = !previous?.mediaPending ? previous?.images?.[index] : undefined;
            if (old) { await this.store.resources.pin(conversation.id, old.id, owner); images.push(old); continue; }
            // A removed workspace does not regain arbitrary file reads. Only
            // already materialized media or an immutable native cache lease can
            // be imported there; unavailable file images remain explicitly pending.
            const encoded = source.data ?? (source.path && adapter.readImage && (allowFileImages || source.releaseToken)
              ? await adapter.readImage(conversation.binding, source.path) : undefined);
            if (!encoded) throw new Error('image_unavailable');
            const image = (await this.store.resources.put(conversation.id, 'Agent 图片 ' + (index + 1), decodeImage(encoded.replace(/^data:image\/[a-z]+;base64,/, '')), 'archive'));
            (await this.store.resources.pin(conversation.id, image.id, owner)); images.push(image);
          } catch { item.mediaPending = true; }
        }
        if (images.length === imageSources.length) delete item.mediaPending;
        if (images.length) item.images = images;
      }
      if (original) {
        item.text = original.text;
        item.images = original.images;
        item.references = original.references;
        if (item.bodies) { delete item.bodies.text; delete item.bodies.references; }
      }
      output.push(item);
    }
    return output;
    } finally {
      if (conversation.binding && adapter.releaseBodySource) for (const token of leased) {
        try { await adapter.releaseBodySource(conversation.binding, token); } catch { /* Unvisited page items also release their temporary leases on a yield/failure. */ }
      }
    }
  }

  async create(input: Omit<CreateConversation, 'cwd'>): Promise<Conversation> {
    this.assertOpen();
    if (this.removing.has(input.workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    (await this.assertWorkspaceAvailable(input.workspaceId));
    const workspace = this.registry ? await this.registry.configured(input.workspaceId) : this.workspaces.find(item => item.id === input.workspaceId);
    if (!workspace || this.adapters.get(input.harnessId)?.id !== input.harnessId) throw new StoreError('configuration_unavailable', 400);
    if (!(await this.store.getConversation(input.id))) {
      await this.execution?.assertAdmission(input.workspaceId);
      if (this.executionBlocked(workspace.directory)) throw new StoreError('workspace_execution_blocked', 409);
    }
    const result = (await this.store.createConversation({ ...input, cwd: workspace.directory }));
    if (result.created) this.launch(this.prepare(result.conversation));
    return result.conversation;
  }
  private prepare(conversation: Conversation): Promise<void> {
    this.preparing.add(conversation.id);
    return this.task(async () => {
      let acceptingBinding = true;
      try {
        const adapter = (await this.adapter(conversation));
        const catalog = (await this.catalogs()).find(item => item.id === conversation.harnessId);
        this.assertOpen();
        (await this.assertWorkspaceAvailable(conversation.workspaceId));
        if (this.executionBlocked(conversation.cwd)) throw new StoreError('workspace_execution_blocked', 409);
        if (!catalog?.available || !catalog.models.some(item => item.id === conversation.configuration.modelId) || !catalog.permissions.some(item => item.id === conversation.configuration.permissionId))
          throw new StoreError('configuration_unavailable', 409);
        const binding = await adapter.create({ cwd: conversation.cwd, configuration: conversation.configuration, title: conversation.title }, async value => {
          // During shutdown this task remains tracked: a native identity already created must still be saved.
          if (acceptingBinding) (await this.store.saveBinding(conversation.id, value));
        });
        (await this.store.saveBinding(conversation.id, binding));
        if (this.closed) throw new StoreError('workbench_closed', 503);
        await this.observe(conversation.id); await this.sync(conversation.id);
      } catch {
        (await this.store.setConversationState(conversation.id, { readiness: 'blocked', error: 'conversation_preparation_incomplete' }));
      } finally { acceptingBinding = false; this.preparing.delete(conversation.id); }
    });
  }

  start(): Promise<void> {
    this.assertOpen();
    return this.task(async () => {
      this.execution?.start({ observeBaseline: (binding, context) => this.observeExecutionBaseline(binding, context), resolvePending: pending => this.resolveExecutionPending(pending),
        recoverSaves: windowId => this.recoverWorkspaceSaves(windowId) });
      for (const workspace of this.workspaces) {
        if (workspace.maintenance) this.maintenancePhases.set(workspace.id, await workspace.maintenance('status'));
      }
      (await this.store.recoverDispatching());
      this.archiveTimer ??= setInterval(() => this.launch(this.advanceArchives()), 50).unref();
      (await this.advanceArchives());
      (await this.restoreQueuedConversations());
      this.queueRecovery ??= setInterval(() => this.launch(this.restoreQueuedConversations()), 5000).unref();
      // The most recent bounded set restores eagerly. Other conversations restore when opened.
      for (const conversation of (await this.store.listConversations({ limit: 16, archived: false }))) {
        if ((await this.workspaceUnavailable(conversation.workspaceId))) continue;
        if (!(await this.configured(conversation))) { try { (await this.adapter(conversation)); } catch { /* durable blocked state */ } continue; }
        if (conversation.binding && !this.executionBlocked(conversation.cwd)) this.launch(this.restoreConversation(conversation.id));
        else if (!conversation.binding && conversation.readiness === 'preparing') (await this.store.setConversationState(conversation.id, { readiness: 'blocked', error: 'native_creation_result_unknown' }));
      }
    });
  }
  private async recoverWorkspaceSaves(windowId: string) {
    if (!this.execution || !this.writer || this.closed) return;
    const page = await this.execution.port.pendingSaves({ windowId, limit: 16 });
    for (const permit of page.entries) {
      const registration = await this.registry?.get(permit.write.workspaceId);
      if (!registration || registration.identity !== permit.write.directoryIdentity) continue;
      const recovered = await this.writer.recover({ root: registration.directory, permit });
      if (recovered.outcome === 'committed' || recovered.outcome === 'rejected') await this.execution.port.settleSave(permit.saveId, recovered.outcome, recovered.proof);
    }
  }
  private async restoreQueuedConversations() {
    if (this.closed) return;
    const pending = (await this.store.queuedConversations(this.queueRecoveryCursor));
    this.queueRecoveryCursor = pending.length === 64 ? pending.at(-1)! : '';
    for (const id of pending) {
      if (this.runtimes.has(id)) continue;
      const conversation = (await this.conversation(id));
      if (!conversation.binding || !(await this.configured(conversation)) || (await this.workspaceUnavailable(conversation.workspaceId)) ||
        this.executionBlocked(conversation.cwd)) continue;
      try { this.runtime(id); } catch { this.queueRecoveryCursor = ''; break; }
      this.launch(this.restoreConversation(id));
    }
  }
  private restoreConversation(id: string): Promise<void> {
    return this.task(async () => {
      try { await this.observe(id); await this.sync(id); }
      catch { if (!this.closed) (await this.unknown(id, 'native_observation_unavailable')); }
    });
  }
  async open(id: string) {
    this.assertOpen(); const conversation = (await this.conversation(id));
    const runtime = this.runtimes.get(id);
    // A snapshot is not a refresh command: restarting synchronization on every
    // SSE-triggered GET creates a read → archive progress → SSE → read loop.
    if (!runtime?.stop && !runtime?.watching && !runtime?.syncing && conversation.binding &&
      !(await this.workspaceUnavailable(conversation.workspaceId)) && !this.executionBlocked(conversation.cwd)) this.launch(this.restoreConversation(id));
    return (await this.snapshot(id));
  }
  async skills(id: string) {
    this.assertOpen();
    const conversation = (await this.conversation(id));
    await this.assertQueueDispatchable(conversation);
    const adapter = (await this.adapter(conversation));
    if (!adapter.skills) throw new StoreError('skill_catalog_unavailable', 503);
    return this.task(async () => {
      const skills = await adapter.skills!(conversation.binding!).catch(() => { throw new StoreError('skill_catalog_unavailable', 503); });
      this.assertOpen();
      await this.assertQueueDispatchable((await this.conversation(id)));
      return skills;
    });
  }
  async snapshot(id: string, beforeItemId?: string) {
    this.assertOpen(); let conversation = (await this.conversation(id));
    const unavailable = (await this.workspaceUnavailable(conversation.workspaceId));
    if (unavailable) conversation = { ...conversation, readiness: 'blocked', error: unavailable,
      state: { ...conversation.state, configurationVerified: false } };
    else if (!(await this.configured(conversation))) { try { (await this.adapter(conversation)); } catch { conversation = (await this.conversation(id)); } }
    const history = (await this.store.readHistory(id, { limit: 50, ...(beforeItemId ? { beforeItemId } : {}) }));
    if (unavailable) history.nativeOlderCursor = null;
    const runIds = new Set<string>();
    for (const item of [...history.items, ...history.liveItems].reverse()) {
      if (item.runId) runIds.add(item.runId);
    }
    const mode = (await this.configured(conversation)) ? this.adapters.get(conversation.harnessId)?.earlyInput ?? null : null;
    return { conversation, history, operationState: await this.store.operationState(id), archive: (await this.store.archiveJobs(id)), turnFiles: (await this.store.readTurnFiles(id, [...runIds], true)),
      operations: (await this.store.readOperationViews(id)), queue: { ...await this.store.readQueueSummary(id), mode }, revision: history.revision };
  }

  async older(id: string, beforeItemId?: string) {
    this.assertOpen();
    const value = await this.snapshot(id, beforeItemId);
    // Reading the archive never waits on a native Host or body import. A cold
    // boundary nudges one background page; the durable cursor stays with that job.
    if (value.history.items.length < 50 && value.history.nativeOlderCursor &&
      !(await this.workspaceUnavailable(value.conversation.workspaceId))) this.launch(this.archivePage(id, 'backfill', true));
    return value;
  }

  private async latestAcceptedMessage(id: string): Promise<Operation | undefined> {
    return (await this.store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 1 }))[0];
  }
  async queue(id: string): Promise<QueueView> {
    const conversation = (await this.conversation(id));
    const { entries, pause, version } = (await this.store.readQueue(id));
    const mode = (await this.configured(conversation)) ? this.adapters.get(conversation.harnessId)?.earlyInput ?? null : null;
    return { entries, pause, version, mode };
  }
  async changeQueue(id: string, command: QueueCommand): Promise<QueueView> {
    this.assertOpen();
    const conversation = (await this.conversation(id));
    (await this.assertWorkspaceAvailable(conversation.workspaceId));
    if (command.action === 'send') {
      const existing = (await this.store.getOperation(command.operationId));
      if (existing) {
        const input = existing.type === 'message' ? existing.queuedInput : undefined;
        if (existing.conversationId !== id || input?.entryId !== command.entryId || input.version !== command.version ||
          input.delivery.mode !== command.mode || input.delivery.target !== command.target)
          throw new StoreError('operation_id_conflict', 409);
        return (await this.queue(id));
      }
      const adapter = (await this.adapter(conversation));
      if (!adapter.submitQueued || adapter.earlyInput !== command.mode) throw new StoreError('queue_mode_unavailable', 409);
      await this.assertQueueDispatchable(conversation);
      if (conversation.state.status === 'unknown') throw new StoreError('operation_needs_reconciliation', 409);
      const operation = (await this.store.claimQueue(id, command.entryId, command.version, command.operationId, { mode: command.mode, target: command.target }));
      this.launch(this.deliverQueued(operation));
    } else {
      if (command.action === 'add' || command.action === 'edit') {
        if (command.action === 'add' && (await this.store.queueAdmissionExists(id, command.entryId, command.content))) return (await this.queue(id));
        await this.execution?.assertAdmission(conversation.workspaceId);
        if (!conversation.binding) throw new StoreError('conversation_not_ready', 409);
        if (!(await this.adapter(conversation)).submitQueued) throw new StoreError('queue_mode_unavailable', 409);
        await this.validateReferences(conversation, { id: command.entryId, conversationId: id, type: 'message', payload: command.content });
        this.assertOpen();
      }
      if (command.action === 'resume') {
        await this.assertQueueDispatchable(conversation);
        if (conversation.state.status === 'unknown' || !conversation.state.configurationVerified)
          throw new StoreError('operation_needs_reconciliation', 409);
      }
      (await this.store.changeQueue(id, command));
      if (!this.executionBlocked(conversation.cwd)) this.launch(this.restoreConversation(id));
    }
    return (await this.queue(id));
  }
  private async assertQueueDispatchable(conversation: Conversation) {
    (await this.assertWorkspaceAvailable(conversation.workspaceId));
    if (!conversation.binding || conversation.readiness !== 'ready') throw new StoreError('conversation_not_ready', 409);
    if (conversation.archived) throw new StoreError('conversation_archived', 409);
    if (this.removing.has(conversation.workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    if (this.executionBlocked(conversation.cwd)) throw new StoreError('workspace_execution_blocked', 409);
  }
  private deliverQueued(operation: Operation): Promise<void> {
    if (operation.type !== 'message' || !operation.queuedInput) return Promise.resolve();
    const id = operation.conversationId;
    const delivery = operation.queuedInput.delivery;
    this.busyConversations.set(id, (this.busyConversations.get(id) ?? 0) + 1);
    return this.task(async () => {
      try {
        let receipt: Receipt;
        let conversation: Conversation;
        try {
          conversation = (await this.conversation(id));
          await this.assertQueueDispatchable(conversation);
          await this.validateReferences(conversation, operation);
          this.assertOpen();
          conversation = (await this.conversation(id));
          await this.assertQueueDispatchable(conversation);
        } catch (error) {
          (await this.store.settleOperation(operation.id, { outcome: 'rejected', reason: error instanceof StoreError ? error.code : 'queue_content_unavailable' }));
          return;
        }
        try {
          const adapter = (await this.adapter(conversation));
          receipt = adapter.submitQueued
            ? await adapter.submitQueued(conversation.binding!, await this.messageInput(operation), delivery)
            : { outcome: 'rejected', reason: 'queue_mode_unavailable' };
        } catch { receipt = { outcome: 'unknown', reason: 'native_receipt_unknown' }; }
        (await this.store.settleOperation(operation.id, receipt));
      } finally {
        const count = (this.busyConversations.get(id) ?? 1) - 1;
        if (count) this.busyConversations.set(id, count); else this.busyConversations.delete(id);
        if (!this.closed) await this.sync(id);
      }
    });
  }
  private async messageInput(operation: Extract<Operation, { type: 'message' }>) {
    return { ...operation.payload, id: operation.id, text: nativeText(operation.payload), imageData: operation.payload.images ? await Promise.all(operation.payload.images.map(async image => {
      const resource = (await this.store.resources.get(operation.conversationId, image.id));
      return { mediaType: resource.mediaType, data: resource.data.toString('base64') };
    })) : undefined };
  }
  private async messageAllowed(conversation: Conversation, current?: Operation, freshState = false): Promise<boolean> {
    if (!conversation.binding || conversation.readiness !== 'ready' || !conversation.state.configurationVerified ||
      !TERMINAL.has(conversation.state.status) || conversation.state.pendingInputs !== 0 || (!freshState && this.runtimes.get(conversation.id)?.dirty)) return false;
    if (!current && (await this.store.readQueue(conversation.id)).entries.length) return false;
    for (const status of ['queued', 'dispatching', 'unknown'] as const) {
      const pending = (await this.store.listOperations({ conversationId: conversation.id, status, limit: 2 }));
      if (pending.some(operation => operation.id !== current?.id && (status !== 'queued' || !current || operation.sequence < current.sequence))) return false;
    }
    const previous = (await this.latestAcceptedMessage(conversation.id));
    return !previous || (previous.runId !== null && (previous.runId === conversation.state.runId || previous.runId === conversation.state.terminalRunId));
  }
  async setArchived(id: string, archived: boolean) {
    this.assertOpen();
    const current = (await this.conversation(id));
    if (archived && !current.archived && current.binding) {
      await this.observe(id);
      await this.sync(id);
      this.assertOpen();
    }
    const expected = await this.conversation(id);
    return await this.store.setArchivedChecked(id, archived, { state: expected.state, readiness: expected.readiness, binding: expected.binding });
  }
  async enqueue(input: OperationInput) {
    this.assertOpen();
    if ((await this.store.getOperation(input.id))) return (await this.store.enqueueOperation(input)).operation;
    const { cwd: directory, workspaceId } = (await this.conversation(input.conversationId));
    if (input.type === 'message') await this.execution?.assertAdmission(workspaceId);
    if (this.removing.has(workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    (await this.assertWorkspaceAvailable(workspaceId));
    if (!this.saving(directory) && this.executionBlocked(directory)) throw new StoreError('workspace_execution_blocked', 409);
    if (this.saving(directory)) throw new StoreError('workspace_save_in_progress', 409);
    if (input.type === 'message' && (this.runtimes.get(input.conversationId)?.dirty || this.runtimes.get(input.conversationId)?.syncing)) await this.sync(input.conversationId);
    const conversation = (await this.conversation(input.conversationId)); (await this.adapter(conversation));
    if (conversation.archived) throw new StoreError('conversation_archived', 409);
    if (!conversation.binding) throw new StoreError('conversation_not_ready', 409);
    if (input.type === 'message' && !(await this.messageAllowed(conversation))) throw new StoreError('operation_needs_reconciliation', 409);
    if (input.type === 'stop' && (!['running', 'waiting'].includes(conversation.state.status) || conversation.state.runId !== input.payload.runId))
      throw new StoreError('native_run_changed', 409);
    await this.validateReferences(conversation, input);
    if (this.removing.has(workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    (await this.assertWorkspaceAvailable(workspaceId));
    if (input.type === 'message' && !(await this.messageAllowed((await this.conversation(conversation.id))))) throw new StoreError('operation_needs_reconciliation', 409);
    if (this.saving(conversation.cwd)) throw new StoreError('workspace_save_in_progress', 409);
    if (this.executionBlocked(conversation.cwd)) throw new StoreError('workspace_execution_blocked', 409);
    const result = (await this.store.enqueueOperation(input));
    if (result.created) this.launch(this.dispatch(result.operation.id));
    return result.operation;
  }
  private dispatch(id: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const existing = this.processing.get(id); if (existing) return existing;
    let conversationId: string | undefined;
    const task = this.task(async () => {
      let claimed = false;
      try {
        const operation = (await this.store.getOperation(id)); if (!operation || operation.status !== 'queued') return;
        if (this.closed) return;
        conversationId = operation.conversationId;
        this.busyConversations.set(conversationId, (this.busyConversations.get(conversationId) ?? 0) + 1);
        let conversation = (await this.conversation(operation.conversationId)); (await this.adapter(conversation));
        if (!conversation.binding) return;
        await this.observe(conversation.id); await this.sync(conversation.id); if (this.closed) return;
        conversation = (await this.conversation(conversation.id)); const adapter = (await this.adapter(conversation, { operationId: operation.id }));
        if (operation.type === 'message' && !(await this.messageAllowed(conversation, operation))) return;
        if (operation.type === 'stop' && (!['running', 'waiting'].includes(conversation.state.status) || conversation.state.runId !== operation.payload.runId)) {
          (await this.store.settleOperation(id, { outcome: 'rejected', reason: 'native_run_changed' })); return;
        }
        try { await this.validateReferences(conversation, operation); }
        catch { (await this.store.settleOperation(id, { outcome: 'rejected', reason: '引用的文件或图片已不可用，请继续编辑。' })); return; }
        if (!conversation.binding || (await this.workspaceUnavailable(conversation.workspaceId)) ||
          this.executionBlocked(conversation.cwd) || !(await this.store.claimOperation(id))) return;
        claimed = true;
        let receipt: Receipt;
        try {
          receipt = operation.type === 'message'
            ? await adapter.submit(conversation.binding, await this.messageInput(operation))
            : await adapter.stop(conversation.binding, operation.payload.runId);
        } catch { receipt = { outcome: 'unknown', reason: 'native_receipt_unknown' }; }
        (await this.store.settleOperation(id, receipt)); claimed = false;
        if (!this.closed) await this.sync(conversation.id);
      } catch {
        if (claimed) (await this.store.settleOperation(id, { outcome: 'unknown', reason: 'native_receipt_unknown' }));
      }
    });
    this.processing.set(id, task);
    const settled = () => {
      this.processing.delete(id);
      if (conversationId) {
        const count = (this.busyConversations.get(conversationId) ?? 1) - 1;
        if (count) this.busyConversations.set(conversationId, count); else this.busyConversations.delete(conversationId);
      }
    };
    void task.then(settled, settled);
    return task;
  }
  private async drain(id: string): Promise<void> {
    if (this.closed || this.executionBlocked((await this.conversation(id)).cwd)) return;
    for (const operation of (await this.store.listOperations({ conversationId: id, status: 'queued', limit: 100 }))) {
      if (!this.processing.has(operation.id)) this.launch(this.dispatch(operation.id));
    }
    const queue = (await this.store.readQueue(id));
    const head = queue.entries[0];
    if (!head || queue.pause || this.busyConversations.has(id)) return;
    const conversation = (await this.conversation(id));
    const { state } = conversation;
    if (!state.configurationVerified || conversation.readiness !== 'ready' || conversation.archived ||
      (await this.workspaceUnavailable(conversation.workspaceId)) || this.removing.has(conversation.workspaceId)) return;
    const outcome = state.terminalRunId === queue.afterRunId ? state.terminalStatus : undefined;
    if (head.status !== 'waiting' || state.pendingInputs || !TERMINAL.has(state.status)) return;
    if (queue.afterRunId && (state.status !== 'idle' || (state.runId !== queue.afterRunId && outcome !== 'completed'))) return;
    try {
      const operation = (await this.store.claimQueue(id, head.entryId, head.version, randomUUID(), { mode: 'next' }));
      this.launch(this.deliverQueued(operation));
    } catch (error) {
      if (!(error instanceof StoreError) || !['operation_needs_reconciliation', 'queue_entry_changed', 'execution_dispatch_closed', 'execution_baseline_incomplete', 'execution_scope_registration_pending'].includes(error.code)) (await this.store.pauseQueue(id, 'rejected'));
    }
  }
  private async observationTarget(id: string) {
    const queue = (await this.store.readQueue(id));
    return (queue.entries.length ? queue.afterRunId : null) ?? (await this.latestAcceptedMessage(id))?.runId ?? undefined;
  }
  private async enrichReceipts(id: string): Promise<void> {
    const pending = (await this.store.listOperations({ conversationId: id, status: 'unknown', order: 'desc', limit: 100 }));
    const latest = (await this.store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 1 }))[0];
    if (latest?.runId === null) pending.push(latest);
    for (const operation of pending) if (operation.type === 'message') {
      const runId = (await this.store.operationRunId(id, operation.id));
      if (runId) (await this.store.settleOperation(operation.id, { outcome: 'accepted', runId }));
    }
  }
  reconcile(id: string): Promise<void> {
    this.assertOpen();
    return this.task(async () => {
      let conversation = (await this.conversation(id));
      if (!conversation.binding && this.recoverCreation) { await this.recoverCreation(conversation); conversation = await this.conversation(id); }
      const adapter = (await this.adapter(conversation)); if (!conversation.binding) return;
      await this.observe(id); await this.sync(id); this.assertOpen(); conversation = (await this.conversation(id));
      for (const operation of (await this.store.listOperations({ conversationId: id, status: 'unknown', order: 'desc', limit: 100 }))) {
        this.assertOpen(); (await this.adapter((await this.conversation(id))));
        if (operation.type === 'message') {
          const runId = (await this.store.operationRunId(id, operation.id));
          const receipt = runId ? { outcome: 'accepted' as const, runId } : await adapter.reconcile(conversation.binding!, operation.id);
          (await this.store.settleOperation(operation.id, receipt));
        } else {
          await this.sync(id); this.assertOpen();
          const current = (await this.conversation(id));
          if (current.state.configurationVerified && TERMINAL.has(current.state.status) && current.state.runId === operation.payload.runId)
            (await this.store.settleOperation(operation.id, { outcome: 'accepted', runId: operation.payload.runId }));
        }
      }
      const latest = (await this.store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 1 }))[0];
      if (latest?.runId === null) {
        this.assertOpen(); (await this.adapter((await this.conversation(id))));
        const receipt = await adapter.reconcile(conversation.binding!, latest.id);
        // An inconclusive lookup cannot revoke an already established acceptance.
        if (receipt.outcome === 'accepted' && receipt.runId) (await this.store.settleOperation(latest.id, receipt));
        else if (receipt.outcome === 'accepted' && latest.type === 'message' && latest.queuedInput?.delivery.mode === 'next' &&
          adapter.wakeQueued && conversation.state.status === 'interrupted') {
          const queue = (await this.store.readQueue(id));
          if (!queue.pause && !queue.afterRunId && !this.executionBlocked(conversation.cwd)) {
            // A user explicitly resumed this queue before the reply was lost.
            // Start only an already admitted item, using its native queue identity.
            const waking = await this.adapter(conversation, { operationId: latest.id, wakeRequestId: 'wake:' + latest.id + ':' + queue.version });
            await waking.wakeQueued?.(conversation.binding!, latest.id).catch(() => {});
          }
        }
      }
      if (!this.closed) await this.sync(id);
    });
  }

  private runtime(id: string): Runtime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      if (this.runtimes.size >= 16) {
        const idle = [...this.runtimes].find(([key, value]) => !value.syncing && !value.watching && !this.preparing.has(key) && !this.busyConversations.has(key) &&
          value.state !== undefined && !['running', 'waiting', 'unknown'].includes(value.state));
        if (!idle) throw new StoreError('active_conversation_limit', 429);
        this.disposeRuntime(idle[0]);
      }
      runtime = { live: new Map(), generation: 0, stateGeneration: 0, dirty: false }; this.runtimes.set(id, runtime);
    }
    return runtime;
  }
  private async flushLive(id: string, runtime: Runtime): Promise<void> {
    if (this.closed || this.runtimes.get(id) !== runtime) return;
    runtime.flush = undefined;
    try { for (const item of runtime.live.values()) (await this.store.saveLiveItem(id, item)); (await this.enrichReceipts(id)); }
    catch { this.scheduleSync(id); }
    // Keep the last complete live body until a canonical read acknowledges it. A lagging read must not regress it.
  }
  private async observe(id: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const conversation = (await this.conversation(id)); const adapter = (await this.adapter(conversation)); if (!conversation.binding) return Promise.resolve();
    const runtime = this.runtime(id);
    if (runtime.stop) return Promise.resolve(); if (runtime.watching) return runtime.watching;
    runtime.watching = this.task(async () => {
      const stop = await adapter.watch(conversation.binding!, change => {
        if (this.closed || this.runtimes.get(id) !== runtime) return;
        try {
          if (change.type === 'usage') { this.launch(this.store.setUsage(id, change.usage)); return; }
          runtime.generation++;
          if (change.type === 'item') {
            if (change.item.imageSources?.length || change.item.bodySources) { this.scheduleSync(id); return; }
            const prior = runtime.live.get(change.item.id);
            if (change.item.tool && prior?.tool) { change.item.tool = { ...prior.tool, ...change.item.tool, name: prior.tool.name }; if (!change.item.text) change.item.text = prior.text; if (change.item.tool.exitCode !== undefined && change.item.tool.exitCode !== 0) change.item.status = 'failed'; }
            if (runtime.live.size >= 64 && !runtime.live.has(change.item.id)) throw new StoreError('live_item_limit', 429);
            runtime.live.set(change.item.id, change.item);
            if (change.item.kind === 'user' && change.item.operationId) {
              const item = change.item;
              this.launch(this.task(async () => {
                const operation = await this.store.getOperation(item.operationId!);
                if (this.closed || this.runtimes.get(id) !== runtime || runtime.live.get(item.id) !== item) return;
                if (operation?.type === 'message' && operation.conversationId === id) {
                  item.text = operation.payload.text; item.images = operation.payload.images; item.references = operation.payload.references;
                }
              }));
            }
            if (!runtime.flush) { runtime.flush = setTimeout(() => this.launch(this.flushLive(id, runtime)), 40); runtime.flush.unref(); }
            if (runtime.syncing) runtime.dirty = true;
          } else {
            runtime.stateGeneration++;
            if (change.type === 'state') {
              runtime.state = change.state.status;
              runtime.stateWrite = this.store.setConversationState(id, { state: change.state });
              this.launch(runtime.stateWrite);
            }
            // Transport loss is a fact, not a hint to wait for a successful read.
            // Keep saved history/identity while fencing reads from before loss.
            if (change.type === 'unavailable') this.launch(this.unknown(id, change.reason));
            this.scheduleSync(id);
          }
        } catch { this.launch(this.unknown(id, 'native_update_requires_sync')); this.scheduleSync(id); }
      });
      if (this.closed || this.runtimes.get(id) !== runtime) stop();
      else { runtime.stop = stop; runtime.poll = setInterval(() => this.scheduleSync(id, false), 5000); runtime.poll.unref(); }
    });
    void runtime.watching.then(() => { runtime.watching = undefined; }, () => { runtime.watching = undefined; });
    return runtime.watching;
  }
  private scheduleSync(id: string, invalidated = true): void {
    if (this.closed) return;
    const runtime = this.runtime(id);
    // A periodic refresh is not evidence that the verified native state changed.
    // Marking it dirty can reject an otherwise valid send between its async
    // eligibility checks. Native events still invalidate immediately, and actual
    // dispatch always waits for a fresh state read before reaching the Harness.
    if (invalidated) runtime.dirty = true;
    if (runtime.syncing || runtime.timer) return;
    runtime.timer = setTimeout(() => { runtime.timer = undefined; this.launch(this.sync(id)); }, 120); runtime.timer.unref();
  }
  private async advanceArchives(): Promise<void> {
    if (!this.closed && !this.indexSweepRunning && Date.now() >= this.indexSweepAt) {
      this.indexSweepRunning = true;
      this.launch(this.task(async () => {
        try {
          const garbage = await this.store.advanceStorageMaintenance();
          const archive = await this.store.advanceArchiveMaintenance();
          const index = await this.store.advanceHistoryIndex();
          this.indexSweepAt = Date.now() + (garbage || archive || index ? 0 : 5000);
        }
        catch { this.indexSweepAt = Date.now() + 5000; }
        finally { this.indexSweepRunning = false; }
      }));
    }
    if (this.closed || this.archiveAdvancing || this.archiveInFlight.size >= 2) return;
    this.archiveAdvancing = true;
    try {
      for (const job of (await this.store.dueArchiveJobs(8))) {
        if (this.archiveInFlight.size >= 2) break;
        if (!this.archiveInFlight.has(job.conversationId)) this.launch(this.archivePage(job.conversationId, job.kind));
      }
    } catch { /* A failed storage read cannot advance a durable checkpoint. */ }
    finally { this.archiveAdvancing = false; }
  }
  private async archiveRevisions(conversation: Conversation, job: ArchiveJob, reader: ArchiveReader, removed: boolean) {
    const progress = await this.store.archiveJobs(conversation.id);
    if (!progress.some(value => value.kind === 'backfill' && value.complete) || progress.find(value => value.kind === 'latest')?.cursor !== null) return;
    if (!reader.historyChanges || !reader.readItems) throw new StoreError('archive_updates_unavailable', 503);
    const checkpoint = await this.store.archiveUpdates(conversation.id);
    if (!checkpoint) throw new StoreError('archive_updates_unavailable', 503);
    let page;
    try {
      page = z.object({ itemIds: z.array(z.string().min(1).max(1024)).max(16), cursor: z.string().min(1).max(65_536), hasMore: z.boolean() }).strict()
        .parse(await reader.historyChanges(conversation.binding!, checkpoint.cursor ?? undefined, 16));
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'history_cursor_invalid') await this.store.resetArchiveUpdates(job, checkpoint.cursor);
      throw error;
    }
    if (new Set(page.itemIds).size !== page.itemIds.length || page.hasMore && page.cursor === checkpoint.cursor) throw new StoreError('history_no_progress', 502);
    for (const id of page.itemIds) if (!await this.store.hasHistoryItem(conversation.id, id)) throw new StoreError('archive_update_waiting_for_history', 409);
    const raw = page.itemIds.length ? await reader.readItems(conversation.binding!, page.itemIds) : [];
    if (!Array.isArray(raw) || raw.length !== page.itemIds.length || new Set(raw.map(item => item.id)).size !== raw.length || raw.some(item => !page.itemIds.includes(item.id)))
      throw new StoreError('archive_update_identity_changed', 502);
    const items = await this.materialize(conversation, raw, reader, !removed, 1024 * 1024);
    this.assertOpen(); await this.archiveAccess(await this.conversation(conversation.id));
    await this.store.commitArchiveUpdates(job, checkpoint.cursor, page, items);
  }
  private archivePage(id: string, kind: ArchiveJob['kind'], force = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    const running = this.archiveInFlight.get(id);
    if (running) return running;
    if (this.archiveInFlight.size >= 2) return Promise.resolve();
    const task = this.task(async () => {
      const job = await this.store.claimArchiveJob(id, kind, force);
      if (!job || this.closed) return;
      try {
        const conversation = (await this.conversation(id)); const { reader: adapter, removed } = await this.archiveAccess(conversation);
        if (!conversation.binding || conversation.binding.id !== job.bindingId) throw new StoreError('archive_source_changed', 409);
        const runtime = this.runtimes.get(id); const generation = runtime?.generation;
        const page: HistoryPage = await adapter.history(conversation.binding, job.cursor ?? undefined, HISTORY_PAGE_SIZE);
        this.assertOpen(); await this.archiveAccess(await this.conversation(id));
        if (runtime && (this.runtimes.get(id) !== runtime || runtime.generation !== generation)) throw new StoreError('history_changed_retry', 409);
        if (!Array.isArray(page.items) || page.items.length > HISTORY_PAGE_SIZE ||
          page.items.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0) > HISTORY_MAX_BYTES)
          throw new StoreError('native_history_page_limit', 502);
        const items = (await this.materialize(conversation, page.items, adapter, !removed, 1024 * 1024)).map(item => {
          const live = runtime?.live.get(item.id);
          if (!live) return item;
          if (item.sourceRevision && !item.previewOnly && item.status !== 'running') { runtime!.live.delete(item.id); return item; }
          const sameBody = item.kind === live.kind && item.text === live.text && item.runId === live.runId && item.operationId === live.operationId;
          if (sameBody && (item.status === live.status || item.status === 'completed')) { runtime!.live.delete(item.id); return item; }
          if (item.fileEdits && live.runId === item.runId && live.status === 'completed') return { ...live, fileEdits: item.fileEdits };
          return live;
        });
        if (runtime && (this.runtimes.get(id) !== runtime || runtime.generation !== generation)) throw new StoreError('history_changed_retry', 409);
        await this.archiveAccess(await this.conversation(id));
        if (!(await this.store.commitArchivePage(job, items, page.olderCursor))) return;
        if (kind === 'latest' && adapter.readItems) {
          const pending = await this.store.pendingArchiveItems(id, job.refreshAfter);
          const repaired = pending.length ? await adapter.readItems(conversation.binding, pending) : [];
          if (!Array.isArray(repaired) || repaired.length > 16 || repaired.some(item => !pending.includes(item.id))) throw new StoreError('native_item_identity_changed', 502);
          if (runtime && (this.runtimes.get(id) !== runtime || runtime.generation !== generation)) throw new StoreError('history_changed_retry', 409);
          const refreshed = await this.materialize(conversation, repaired, adapter, !removed, 1024 * 1024);
          await this.archiveAccess(await this.conversation(id));
          await this.store.refreshArchiveItems(job, refreshed, pending);
        }
        if (!job.cursor && page.usage) (await this.store.setUsage(id, page.usage));
        if (runtime) for (const item of runtime.live.values()) (await this.store.saveLiveItem(id, item));
        (await this.enrichReceipts(id));
        if (kind === 'latest') await this.archiveRevisions(conversation, job, adapter, removed);
      } catch (error) {
        if (!this.closed) {
          const reason = error instanceof StoreError || error instanceof HarnessError ? error.code : 'native_archive_unavailable';
          if (reason === 'archive_budget_yield') await this.store.yieldArchiveJob(job);
          else if (reason === 'history_cursor_invalid' && job.cursor) await this.store.restartArchiveJob(job, reason);
          else await this.store.failArchiveJob(job, reason);
        }
      }
    });
    this.archiveInFlight.set(id, task);
    const finished = () => this.archiveInFlight.delete(id);
    void task.then(finished, finished);
    return task;
  }
  private async sync(id: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const conversation = (await this.conversation(id)); if (!conversation.binding) return Promise.resolve();
    const runtime = this.runtime(id); runtime.dirty = true;
    if (runtime.syncing) return runtime.syncing;
    runtime.syncing = this.task(async () => {
      for (let pass = 0; pass < 3 && runtime.dirty && !this.closed; pass++) {
        runtime.dirty = false; const generation = runtime.generation; const stateGeneration = runtime.stateGeneration;
        try {
          const current = (await this.conversation(id)); const adapter = (await this.adapter(current));
          const target = (await this.observationTarget(id));
          const results = await Promise.allSettled([adapter.state(current.binding!, target), this.archivePage(id, 'latest', true)]);
          if (this.closed || this.runtimes.get(id) !== runtime) return;
          const currentTarget = (await this.observationTarget(id));
          if (runtime.stateGeneration !== stateGeneration || currentTarget !== target) { runtime.dirty = true; continue; }
          const [state] = results;
          if (state.status === 'rejected') throw state.reason;
          if (state.value.status === 'unknown' && !state.value.configurationVerified) {
            await this.unknown(id, state.value.reason ?? 'native_state_unavailable');
            continue;
          }
          (await this.adapter((await this.conversation(id))));
          if (runtime.stateGeneration !== stateGeneration || this.runtimes.get(id) !== runtime) { runtime.dirty = true; continue; }
          // Text can arrive faster than native reads. It invalidates history, not a
          // verified state read; newer state/invalidate events still fence both.
          (await this.store.setConversationState(id, { state: state.value, readiness: state.value.configurationVerified ? 'ready' : 'blocked',
            error: state.value.configurationVerified ? null : 'native_configuration_unverified' }));
          if (runtime.stateGeneration === stateGeneration) runtime.state = state.value.status;
          const queue = (await this.store.readQueue(id));
          if (queue.entries.length && !queue.pause && queue.afterRunId && state.value.configurationVerified) {
            const outcome = state.value.terminalRunId === queue.afterRunId ? state.value.terminalStatus : undefined;
            if (outcome === 'failed' || state.value.status === 'failed') (await this.store.pauseQueue(id, 'failed'));
            else if (outcome === 'interrupted' || state.value.status === 'interrupted') (await this.store.pauseQueue(id, 'stopped'));
          }
          if (runtime.generation !== generation) { runtime.dirty = true; continue; }
          // A newer complete live projection must win over an older history body captured before this sync.
          for (const item of runtime.live.values()) (await this.store.saveLiveItem(id, item));
          if (runtime.flush) { clearTimeout(runtime.flush); runtime.flush = undefined; }
          (await this.enrichReceipts(id));
        } catch (error) {
          if (!this.closed && this.runtimes.get(id) === runtime) (await this.unknown(id, error instanceof StoreError ? error.code : 'native_state_unavailable'));
        }
      }
    });
    const result = runtime.syncing;
    this.launch(result.then(async () => {
      runtime.syncing = undefined;
      if (this.closed || this.runtimes.get(id) !== runtime) return;
      if (runtime.dirty) this.scheduleSync(id); else await this.drain(id);
    }, () => { runtime.syncing = undefined; if (!this.closed) this.scheduleSync(id); }));
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
    this.execution?.stop();
    if (this.queueRecovery) clearInterval(this.queueRecovery);
    if (this.archiveTimer) clearInterval(this.archiveTimer);
    this.closing = (async () => {
      for (const [id, runtime] of this.runtimes) {
        try { for (const item of runtime.live.values()) (await this.store.saveLiveItem(id, item)); }
        catch { /* shutdown still closes connections and waits for tasks; no persistence success is reported */ }
        try { this.disposeRuntime(id); } catch { /* adapter.close still runs */ }
      }
      // Closing connections first unblocks pending RPCs. The database owner may close it only after every task settles.
      await Promise.allSettled([...this.adapters.values()].map(adapter => Promise.resolve().then(() => adapter.close())));
      await this.execution?.close();
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
      await this.writer?.close();
    })();
    return this.closing;
  }
}

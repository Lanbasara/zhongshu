import type { HostPhase } from './workspace-maintenance.ts';
import type { Catalog, HarnessAdapter, HarnessId, HistoryPage, NativeItem, NativeState, Receipt } from '../harness/types.ts';
import type { Workspace } from './harness-config.ts';
import { decodeImage, ResourceError, workspacePath, workspaceFiles } from './resources.ts';
import { nativeText } from '../shared/content.ts';
import { referenceSchema } from '../shared/content.ts';
import { isAbsolute, relative } from 'node:path';
import { listWorkspaceDocuments, openWorkspaceDocument, saveWorkspaceDocument } from './workspace-documents.ts';
import { createHash, randomUUID } from 'node:crypto';
import { StoreError, type WorkbenchStore, type CreateConversation, type OperationInput, type Conversation, type Operation } from './workbench-store.ts';
import type { WorkspaceRegistry } from './workspace-registry.ts';
import type { QueueCommand, QueueView, WorkbenchConfiguration, workspaceAddSchema, workspaceManagementSchema } from '../shared/workbench.ts';
import type { z } from 'zod';

const TERMINAL = new Set<NativeState['status']>(['idle', 'interrupted', 'failed']);
const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_PAGES = 250;
const HISTORY_MAX_ITEMS = 1000;
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
  private readonly initialWorkspaces: Workspace[];
  private readonly registry?: WorkspaceRegistry;
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

  constructor(store: WorkbenchStore, initialWorkspaces: Workspace[], adapters: Map<HarnessId, HarnessAdapter>, registry?: WorkspaceRegistry) {
    this.store = store; this.adapters = adapters;
    this.initialWorkspaces = initialWorkspaces; this.registry = registry;
  }
  get workspaces(): Workspace[] { return this.registry?.active() ?? this.initialWorkspaces; }
  workspaceView(): Omit<WorkbenchConfiguration, 'harnesses'> {
    return this.registry?.view() ?? { workspaces: this.workspaces.map(({ id, label }) => ({ id, label })) };
  }
  browseWorkspaceRoot(id: string, path: string[]) {
    if (!this.registry) throw new StoreError('workspace_root_not_found', 404);
    return this.registry.browse(id, path);
  }
  addWorkspace(input: z.infer<typeof workspaceAddSchema>) {
    this.assertOpen();
    if (!this.registry) throw new StoreError('workspace_root_not_found', 404);
    return this.registry.add(input);
  }
  async manageWorkspace(id: string, input: z.infer<typeof workspaceManagementSchema>): Promise<void> {
    this.assertOpen();
    const registry = this.registry;
    const entry = registry?.get(id);
    if (!registry || !entry) throw new StoreError('workspace_not_found', 404);
    if (this.removing.has(id)) throw new StoreError('workspace_remove_busy', 409);
    if (input.action === 'restore') {
      if (entry.removed) registry.restore(entry);
      return;
    }
    if (entry.removed) {
      if (input.action === 'remove') return;
      throw new StoreError('workspace_removed', 409);
    }
    if (input.action === 'rename') { registry.rename(id, input.label); return; }
    if (input.action === 'pin') { registry.pin(id, input.pinned); return; }
    if (this.executionBlocked(entry.directory)) throw new StoreError('workspace_remove_busy', 409);
    this.removing.add(id);
    try {
      await this.task(async () => {
        if (!await this.confirmWorkspaceIdle(entry.directory, false, id) || this.executionBlocked(entry.directory))
          throw new StoreError('workspace_remove_busy', 409);
        this.assertOpen();
        for (const conversation of this.workspaceConversations(entry.directory, id)) {
          const runtime = this.runtimes.get(conversation.id);
          if (runtime) this.flushLive(conversation.id, runtime);
        }
        registry.remove(id);
        for (const conversation of this.workspaceConversations(entry.directory, id)) this.disposeRuntime(conversation.id);
      });
    } finally { this.removing.delete(id); }
  }
  private workspaceUnavailable(id: string): string | undefined {
    const entry = this.registry?.get(id);
    if (!entry) return;
    if (entry.removed) return 'workspace_removed';
    try { this.registry!.verify(entry); }
    catch (error) { return error instanceof StoreError ? error.code : 'workspace_directory_unavailable'; }
  }
  private assertWorkspaceAvailable(id: string): void {
    const reason = this.workspaceUnavailable(id);
    if (reason) throw new StoreError(reason, 409);
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
    return workspace?.directory === conversation.cwd && adapter?.id === conversation.harnessId &&
      !this.workspaceUnavailable(conversation.workspaceId);
  }
  private adapter(conversation: Conversation): HarnessAdapter {
    this.assertWorkspaceAvailable(conversation.workspaceId);
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

  private workspace(id: string): Workspace {
    this.assertOpen();
    this.assertWorkspaceAvailable(id);
    const workspace = this.workspaces.find(item => item.id === id);
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
    return this.saving(directory) || this.workspaces.some(workspace => workspace.maintenance &&
      this.overlaps(directory, workspace.directory) && this.maintenancePhases.get(workspace.id) !== 'online');
  }
  changeWorkspaceMaintenance(id: string, action: 'pause' | 'resume') {
    const workspace = this.workspace(id);
    const controller = workspace.maintenance;
    const { directory } = workspace;
    if (!controller) throw new StoreError('workspace_maintenance_unavailable', 409);
    const previous = this.maintenancePhases.get(id);
    if (previous === 'transition' || this.saving(directory)) throw new StoreError('workspace_maintenance_busy', 409);
    if (action === 'pause' && previous === 'paused') return this.workspaceEditStatus(id);
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
          for (const conversation of this.workspaceConversations(directory)) {
            const runtime = this.runtimes.get(conversation.id);
            if (runtime) {
              for (const item of runtime.live.values()) this.store.saveLiveItem(conversation.id, item);
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
      return this.workspaceEditStatus(id);
    });
  }
  private *workspaceConversations(directory: string, workspaceId?: string) {
    let beforeId: string | undefined;
    for (;;) {
      const page: Conversation[] = this.store.listConversations({ beforeId, limit: 100, workspaceId });
      for (const conversation of page) if (workspaceId || this.overlaps(directory, conversation.cwd)) yield conversation;
      if (page.length < 100) return;
      beforeId = page.at(-1)!.id;
    }
  }
  // Maintenance owns the execution gate while reading native state. History
  // delivery and observation-slot eviction do not participate in this proof.
  private async confirmWorkspaceIdle(directory: string, publish = false, removingId?: string): Promise<boolean> {
    const check = async (conversation: Conversation) => {
      if (!conversation.binding || !this.configured(conversation) ||
        this.preparing.has(conversation.id) || this.busyConversations.has(conversation.id)) return false;
      const id = conversation.id;
      const runtime = this.runtimes.get(id);
      const generation = runtime?.stateGeneration;
      const target = this.latestAcceptedMessage(id)?.runId;
      try {
        const state = await this.adapter(conversation).state(conversation.binding, target ?? undefined);
        this.assertOpen();
        const current = this.conversation(id);
        if (this.runtimes.get(id) !== runtime || runtime?.stateGeneration !== generation ||
          this.latestAcceptedMessage(id)?.runId !== target || this.busyConversations.has(id) ||
          !this.configured(current) || current.binding?.id !== conversation.binding.id ||
          !(removingId ? TERMINAL.has(state.status) : state.status === 'idle') ||
          !this.messageAllowed({ ...current, state, readiness: 'ready' }, undefined, true)) return false;
        if (publish) {
          if (runtime) runtime.stateGeneration++;
          this.store.setConversationState(id, { state, readiness: 'ready', error: null });
        }
        return true;
      } catch { return false; }
    };
    let batch: Promise<boolean>[] = [];
    for (const conversation of this.workspaceConversations(directory, removingId)) {
      batch.push(check(conversation));
      if (batch.length === 4) {
        if (!(await Promise.all(batch)).every(Boolean)) return false;
        batch = [];
      }
    }
    return (await Promise.all(batch)).every(Boolean);
  }

  private idleForEditing(conversation: Conversation): boolean {
    const runtime = this.runtimes.get(conversation.id);
    return this.configured(conversation) && !this.preparing.has(conversation.id) &&
      !this.busyConversations.has(conversation.id) && !!runtime?.stop && !runtime.syncing &&
      conversation.state.status === 'idle' && this.messageAllowed(conversation);
  }
  workspaceEditStatus(id: string) {
    const { directory, managedWrites, maintenance } = this.workspace(id);
    if (!managedWrites) return { editable: false, reason: 'workspace_writes_unmanaged' };
    if (this.saving(directory)) return { editable: false, reason: 'workspace_save_in_progress' };
    const phase = maintenance ? this.maintenancePhases.get(id) ?? 'unknown' : undefined;
    if (phase && phase !== 'online') {
      return { editable: phase === 'paused', reason: phase === 'paused' ? null : 'workspace_maintenance_' + phase, maintenance: phase };
    }
    let idle = true;
    let restoring = 0;
    for (const conversation of this.workspaceConversations(directory)) {
      if (phase === 'online') {
        if (!this.configured(conversation) || this.preparing.has(conversation.id) || this.busyConversations.has(conversation.id) ||
          ['running', 'waiting', 'interrupted', 'failed'].includes(conversation.state.status) || conversation.state.pendingInputs) idle = false;
        continue;
      }
      if (this.idleForEditing(conversation)) continue;
      idle = false;
      if (restoring < 4 && this.configured(conversation) && conversation.binding &&
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
  async listWorkspaceFiles(id: string, directory: string) {
    const result = await listWorkspaceDocuments(this.workspace(id).directory, directory, this.registry?.get(id)?.identity);
    this.assertWorkspaceAvailable(id);
    return result;
  }
  async openWorkspaceFile(id: string, path: string) {
    const result = await openWorkspaceDocument(this.workspace(id).directory, path, this.registry?.get(id)?.identity);
    this.assertWorkspaceAvailable(id);
    return result;
  }
  saveWorkspaceFile(id: string, path: string, version: string, text: string) {
    const { directory, maintenance } = this.workspace(id);
    const identity = this.registry?.get(id)?.identity;
    if (this.removing.has(id)) throw new StoreError('workspace_remove_busy', 409);
    const status = this.workspaceEditStatus(id);
    if (!status.editable) throw new StoreError(status.reason!, 409);
    this.savingDirectories.add(directory);
    return this.task(async () => {
      try {
        if (maintenance) {
          if (await maintenance('status') !== 'paused') {
            this.maintenancePhases.set(id, 'unknown');
            throw new StoreError('workspace_maintenance_unavailable', 409);
          }
          return await saveWorkspaceDocument(directory, path, version, text, () => {
            this.assertOpen(); this.assertWorkspaceAvailable(id);
          }, identity);
        }
        for (const conversation of this.workspaceConversations(directory)) await this.sync(conversation.id);
        const assertWritable = () => {
          this.assertOpen();
          this.assertWorkspaceAvailable(id);
          for (const conversation of this.workspaceConversations(directory)) {
            if (!this.idleForEditing(conversation)) throw new ResourceError('workspace_not_idle', 409);
          }
        };
        assertWritable();
        return await saveWorkspaceDocument(directory, path, version, text, assertWritable, identity);
      } finally { this.savingDirectories.delete(directory); }
    });
  }

  async files(id: string, directory = '') {
    const conversation = this.conversation(id); this.adapter(conversation);
    const result = await workspaceFiles(conversation.cwd, directory);
    this.assertWorkspaceAvailable(conversation.workspaceId);
    return result;
  }
  async workspaceImage(id: string, itemId: string, source: string) {
    const conversation = this.conversation(id);
    const item = this.store.getItem(id, itemId);
    if (!item || !item.text.includes(source)) throw new StoreError('image_unavailable', 404);
    const owner = 'markdown:' + createHash('sha256').update(itemId + '\0' + source).digest('hex');
    const cached = this.store.resources.owned(id, owner); if (cached) return cached;
    const reference = referenceSchema.parse({ type: 'file', path: decodeURIComponent(source).replace(/^\.\//, '') });
    if (reference.type !== 'file') throw new StoreError('invalid_request', 400);
    const adapter = this.adapter(conversation);
    if (!conversation.binding || !adapter.readImage) throw new StoreError('image_unavailable', 404);
    const path = await workspacePath(conversation.cwd, reference.path);
    // Read in the native Host, never turn Markdown into a host-user filesystem proxy.
    const data = decodeImage(await adapter.readImage(conversation.binding, path));
    this.assertWorkspaceAvailable(conversation.workspaceId);
    const image = this.store.resources.put(id, reference.path.split('/').at(-1)!.slice(0,120), data);
    this.store.resources.pin(id, image.id, owner);
    return this.store.resources.get(id, image.id);
  }
  async validateReferences(conversation: Conversation, input: OperationInput): Promise<void> {
    if (input.type !== 'message') return;
    for (const ref of input.payload.references ?? []) {
      if (ref.type === 'file') await workspacePath(conversation.cwd, ref.path);
      else {
        const item = this.store.getItem(conversation.id, ref.itemId);
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
  private async materialize(conversation: Conversation, items: NativeItem[]): Promise<NativeItem[]> {
    const adapter = this.adapter(conversation);
    const output: NativeItem[] = [];
    for (const raw of items) {
      const { imageSources, ...item } = raw;
      if (imageSources?.length && conversation.binding && item.status === 'completed') {
        const images = [];
        for (const [index, source] of imageSources.slice(0,4).entries()) {
          try {
            const old = this.store.getItem(conversation.id, item.id)?.images?.[index];
            if (old) { this.store.resources.get(conversation.id, old.id); images.push(old); continue; }
            const encoded = source.data ?? (source.path && adapter.readImage ? await adapter.readImage(conversation.binding, source.path) : undefined);
            if (!encoded) throw new Error('image_unavailable');
            const image = this.store.resources.put(conversation.id, 'Agent 图片 ' + (index + 1), decodeImage(encoded.replace(/^data:image\/[a-z]+;base64,/, '')));
            this.store.resources.pin(conversation.id, image.id, item.id); images.push(image);
          } catch { item.text = (item.text || '图片') + '\n图片暂时无法读取，请重新查询原生结果。'; }
        }
        if (images.length) item.images = images;
      }
      if (item.operationId && item.kind === 'user') {
        const operation = this.store.getOperation(item.operationId);
        if (operation?.type === 'message' && operation.conversationId === conversation.id) {
          item.text = operation.payload.text;
          item.images = operation.payload.images;
          item.references = operation.payload.references;
        }
      }
      output.push(item);
    }
    return output;
  }

  async create(input: Omit<CreateConversation, 'cwd'>): Promise<Conversation> {
    this.assertOpen();
    if (this.removing.has(input.workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    this.assertWorkspaceAvailable(input.workspaceId);
    const workspace = this.workspaces.find(item => item.id === input.workspaceId);
    if (!workspace || this.adapters.get(input.harnessId)?.id !== input.harnessId) throw new StoreError('configuration_unavailable', 400);
    if (!this.store.getConversation(input.id) && this.executionBlocked(workspace.directory)) throw new StoreError('workspace_execution_blocked', 409);
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
        this.assertWorkspaceAvailable(conversation.workspaceId);
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
      for (const workspace of this.workspaces) {
        if (workspace.maintenance) this.maintenancePhases.set(workspace.id, await workspace.maintenance('status'));
      }
      this.store.recoverDispatching();
      this.restoreQueuedConversations();
      this.queueRecovery ??= setInterval(() => {
        try { this.restoreQueuedConversations(); } catch { /* Retry on the next recovery pass. */ }
      }, 5000).unref();
      // The most recent bounded set restores eagerly. Other conversations restore when opened.
      for (const conversation of this.store.listConversations({ limit: 16, archived: false })) {
        if (this.workspaceUnavailable(conversation.workspaceId)) continue;
        if (!this.configured(conversation)) { try { this.adapter(conversation); } catch { /* durable blocked state */ } continue; }
        if (conversation.binding && !this.executionBlocked(conversation.cwd)) this.launch(this.restoreConversation(conversation.id));
        else if (!conversation.binding && conversation.readiness === 'preparing') this.store.setConversationState(conversation.id, { readiness: 'blocked', error: 'native_creation_result_unknown' });
      }
    });
  }
  private restoreQueuedConversations() {
    if (this.closed) return;
    const pending = this.store.queuedConversations(this.queueRecoveryCursor);
    this.queueRecoveryCursor = pending.length === 64 ? pending.at(-1)! : '';
    for (const id of pending) {
      if (this.runtimes.has(id)) continue;
      const conversation = this.conversation(id);
      if (!conversation.binding || !this.configured(conversation) || this.workspaceUnavailable(conversation.workspaceId) ||
        this.executionBlocked(conversation.cwd)) continue;
      try { this.runtime(id); } catch { this.queueRecoveryCursor = ''; break; }
      this.launch(this.restoreConversation(id));
    }
  }
  private restoreConversation(id: string): Promise<void> {
    return this.task(async () => {
      try { await this.observe(id); await this.sync(id); }
      catch { if (!this.closed) this.unknown(id, 'native_observation_unavailable'); }
    });
  }
  async open(id: string) {
    this.assertOpen(); const conversation = this.conversation(id);
    if (conversation.binding && !this.workspaceUnavailable(conversation.workspaceId) && !this.executionBlocked(conversation.cwd)) this.launch(this.restoreConversation(id));
    return this.snapshot(id);
  }
  snapshot(id: string, beforeItemId?: string) {
    this.assertOpen(); let conversation = this.conversation(id);
    const unavailable = this.workspaceUnavailable(conversation.workspaceId);
    if (unavailable) conversation = { ...conversation, readiness: 'blocked', error: unavailable,
      state: { ...conversation.state, configurationVerified: false } };
    else if (!this.configured(conversation)) { try { this.adapter(conversation); } catch { conversation = this.conversation(id); } }
    const history = this.store.readHistory(id, { limit: 100, ...(beforeItemId ? { beforeItemId } : {}) });
    if (unavailable) history.nativeOlderCursor = null;
    return { conversation, history, operations: this.store.listOperations({ conversationId: id, order: 'desc', limit: 100 }), queue: this.queue(id), revision: history.revision };
  }

  older(id: string, beforeItemId?: string) {
    this.assertOpen();
    if (this.workspaceUnavailable(this.conversation(id).workspaceId)) return Promise.resolve(this.snapshot(id, beforeItemId));
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
              this.store.mergeHistory(id, await this.materialize(conversation, page.items), local.nativeOlderBeforeItemId);
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

  private latestAcceptedMessage(id: string): Operation | undefined {
    return this.store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 1 })[0];
  }
  queue(id: string): QueueView {
    const conversation = this.conversation(id);
    const { entries, pause, version } = this.store.readQueue(id);
    const mode = this.configured(conversation) ? this.adapters.get(conversation.harnessId)?.earlyInput ?? null : null;
    return { entries, pause, version, mode };
  }
  async changeQueue(id: string, command: QueueCommand): Promise<QueueView> {
    this.assertOpen();
    const conversation = this.conversation(id);
    this.assertWorkspaceAvailable(conversation.workspaceId);
    if (command.action === 'send') {
      const existing = this.store.getOperation(command.operationId);
      if (existing) {
        const input = existing.type === 'message' ? existing.queuedInput : undefined;
        if (existing.conversationId !== id || input?.entryId !== command.entryId || input.version !== command.version ||
          input.delivery.mode !== command.mode || input.delivery.target !== command.target)
          throw new StoreError('operation_id_conflict', 409);
        return this.queue(id);
      }
      const adapter = this.adapter(conversation);
      if (!adapter.submitQueued || adapter.earlyInput !== command.mode) throw new StoreError('queue_mode_unavailable', 409);
      this.assertQueueDispatchable(conversation);
      if (conversation.state.status === 'unknown') throw new StoreError('operation_needs_reconciliation', 409);
      const operation = this.store.claimQueue(id, command.entryId, command.version, command.operationId, { mode: command.mode, target: command.target });
      this.launch(this.deliverQueued(operation));
    } else {
      if (command.action === 'add' || command.action === 'edit') {
        if (command.action === 'add' && this.store.queueAdmissionExists(id, command.entryId, command.content)) return this.queue(id);
        if (!conversation.binding) throw new StoreError('conversation_not_ready', 409);
        if (!this.adapter(conversation).submitQueued) throw new StoreError('queue_mode_unavailable', 409);
        await this.validateReferences(conversation, { id: command.entryId, conversationId: id, type: 'message', payload: command.content });
        this.assertOpen();
      }
      if (command.action === 'resume') {
        this.assertQueueDispatchable(conversation);
        if (conversation.state.status === 'unknown' || !conversation.state.configurationVerified)
          throw new StoreError('operation_needs_reconciliation', 409);
      }
      this.store.changeQueue(id, command);
      if (!this.executionBlocked(conversation.cwd)) this.launch(this.restoreConversation(id));
    }
    return this.queue(id);
  }
  private assertQueueDispatchable(conversation: Conversation) {
    this.assertWorkspaceAvailable(conversation.workspaceId);
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
          conversation = this.conversation(id);
          this.assertQueueDispatchable(conversation);
          await this.validateReferences(conversation, operation);
          this.assertOpen();
          conversation = this.conversation(id);
          this.assertQueueDispatchable(conversation);
        } catch (error) {
          this.store.settleOperation(operation.id, { outcome: 'rejected', reason: error instanceof StoreError ? error.code : 'queue_content_unavailable' });
          return;
        }
        try {
          const adapter = this.adapter(conversation);
          receipt = adapter.submitQueued
            ? await adapter.submitQueued(conversation.binding!, this.messageInput(operation), delivery)
            : { outcome: 'rejected', reason: 'queue_mode_unavailable' };
        } catch { receipt = { outcome: 'unknown', reason: 'native_receipt_unknown' }; }
        this.store.settleOperation(operation.id, receipt);
      } finally {
        const count = (this.busyConversations.get(id) ?? 1) - 1;
        if (count) this.busyConversations.set(id, count); else this.busyConversations.delete(id);
        if (!this.closed) await this.sync(id);
      }
    });
  }
  private messageInput(operation: Extract<Operation, { type: 'message' }>) {
    return { ...operation.payload, id: operation.id, text: nativeText(operation.payload), imageData: operation.payload.images?.map(image => {
      const resource = this.store.resources.get(operation.conversationId, image.id);
      return { mediaType: resource.mediaType, data: resource.data.toString('base64') };
    }) };
  }
  private messageAllowed(conversation: Conversation, current?: Operation, freshState = false): boolean {
    if (!conversation.binding || conversation.readiness !== 'ready' || !conversation.state.configurationVerified ||
      !TERMINAL.has(conversation.state.status) || conversation.state.pendingInputs !== 0 || (!freshState && this.runtimes.get(conversation.id)?.dirty)) return false;
    if (!current && this.store.readQueue(conversation.id).entries.length) return false;
    for (const status of ['queued', 'dispatching', 'unknown'] as const) {
      const pending = this.store.listOperations({ conversationId: conversation.id, status, limit: 2 });
      if (pending.some(operation => operation.id !== current?.id && (status !== 'queued' || !current || operation.sequence < current.sequence))) return false;
    }
    const previous = this.latestAcceptedMessage(conversation.id);
    return !previous || (previous.runId !== null && (previous.runId === conversation.state.runId || previous.runId === conversation.state.terminalRunId));
  }
  async setArchived(id: string, archived: boolean) {
    this.assertOpen();
    const current = this.conversation(id);
    if (archived && !current.archived && current.binding) {
      await this.observe(id);
      await this.sync(id);
      this.assertOpen();
    }
    return this.store.setArchived(id, archived, conversation =>
      conversation.binding ? this.messageAllowed(conversation) :
        conversation.readiness === 'blocked' && conversation.state.pendingInputs === 0 &&
        !['running', 'waiting'].includes(conversation.state.status));
  }
  async enqueue(input: OperationInput) {
    this.assertOpen();
    if (this.store.getOperation(input.id)) return this.store.enqueueOperation(input).operation;
    const { cwd: directory, workspaceId } = this.conversation(input.conversationId);
    if (this.removing.has(workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    this.assertWorkspaceAvailable(workspaceId);
    if (!this.saving(directory) && this.executionBlocked(directory)) throw new StoreError('workspace_execution_blocked', 409);
    if (this.saving(directory)) throw new StoreError('workspace_save_in_progress', 409);
    if (input.type === 'message' && (this.runtimes.get(input.conversationId)?.dirty || this.runtimes.get(input.conversationId)?.syncing)) await this.sync(input.conversationId);
    const conversation = this.conversation(input.conversationId); this.adapter(conversation);
    if (conversation.archived) throw new StoreError('conversation_archived', 409);
    if (!conversation.binding) throw new StoreError('conversation_not_ready', 409);
    if (input.type === 'message' && !this.messageAllowed(conversation)) throw new StoreError('operation_needs_reconciliation', 409);
    if (input.type === 'stop' && (!['running', 'waiting'].includes(conversation.state.status) || conversation.state.runId !== input.payload.runId))
      throw new StoreError('native_run_changed', 409);
    await this.validateReferences(conversation, input);
    if (this.removing.has(workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    this.assertWorkspaceAvailable(workspaceId);
    if (input.type === 'message' && !this.messageAllowed(this.conversation(conversation.id))) throw new StoreError('operation_needs_reconciliation', 409);
    if (this.saving(conversation.cwd)) throw new StoreError('workspace_save_in_progress', 409);
    if (this.executionBlocked(conversation.cwd)) throw new StoreError('workspace_execution_blocked', 409);
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
        try { await this.validateReferences(conversation, operation); }
        catch { this.store.settleOperation(id, { outcome: 'rejected', reason: '引用的文件或图片已不可用，请继续编辑。' }); return; }
        if (!conversation.binding || this.workspaceUnavailable(conversation.workspaceId) ||
          this.executionBlocked(conversation.cwd) || !this.store.claimOperation(id)) return;
        claimed = true;
        let receipt: Receipt;
        try {
          receipt = operation.type === 'message'
            ? await adapter.submit(conversation.binding, this.messageInput(operation))
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
    if (this.closed || this.executionBlocked(this.conversation(id).cwd)) return;
    for (const operation of this.store.listOperations({ conversationId: id, status: 'queued', limit: 100 })) {
      if (!this.processing.has(operation.id)) this.launch(this.dispatch(operation.id));
    }
    const queue = this.store.readQueue(id);
    const head = queue.entries[0];
    if (!head || queue.pause || this.busyConversations.has(id)) return;
    const conversation = this.conversation(id);
    const { state } = conversation;
    if (!state.configurationVerified || conversation.readiness !== 'ready' || conversation.archived ||
      this.workspaceUnavailable(conversation.workspaceId) || this.removing.has(conversation.workspaceId)) return;
    const outcome = state.terminalRunId === queue.afterRunId ? state.terminalStatus : undefined;
    if (head.status !== 'waiting' || state.pendingInputs || !TERMINAL.has(state.status)) return;
    if (queue.afterRunId && (state.status !== 'idle' || (state.runId !== queue.afterRunId && outcome !== 'completed'))) return;
    try {
      const operation = this.store.claimQueue(id, head.entryId, head.version, randomUUID(), { mode: 'next' });
      this.launch(this.deliverQueued(operation));
    } catch (error) {
      if (!(error instanceof StoreError) || !['operation_needs_reconciliation', 'queue_entry_changed'].includes(error.code)) this.store.pauseQueue(id, 'rejected');
    }
  }
  private observationTarget(id: string) {
    const queue = this.store.readQueue(id);
    return (queue.entries.length ? queue.afterRunId : null) ?? this.latestAcceptedMessage(id)?.runId ?? undefined;
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
        else if (receipt.outcome === 'accepted' && latest.type === 'message' && latest.queuedInput?.delivery.mode === 'next' &&
          adapter.wakeQueued && conversation.state.status === 'interrupted') {
          const queue = this.store.readQueue(id);
          if (!queue.pause && !queue.afterRunId && !this.executionBlocked(conversation.cwd)) {
            // A user explicitly resumed this queue before the reply was lost.
            // Start only an already admitted item, using its native queue identity.
            await adapter.wakeQueued(conversation.binding!, latest.id).catch(() => {});
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
            if (change.item.tool && prior?.tool) { change.item.tool = { ...prior.tool, ...change.item.tool, name: prior.tool.name }; if (!change.item.text) change.item.text = prior.text; if (change.item.tool.exitCode !== undefined && change.item.tool.exitCode !== 0) change.item.status = 'failed'; }
            if (runtime.live.size >= 64 && !runtime.live.has(change.item.id)) throw new StoreError('live_item_limit', 429);
            runtime.live.set(change.item.id, change.item);
            if (!runtime.flush) { runtime.flush = setTimeout(() => this.flushLive(id, runtime), 40); runtime.flush.unref(); }
            if (runtime.syncing) runtime.dirty = true;
          } else {
            runtime.stateGeneration++;
            if (change.type === 'state') this.store.setConversationState(id, { state: change.state });
            // Transport loss is a fact, not a hint to wait for a successful read.
            // Keep saved history/identity while fencing reads from before loss.
            if (change.type === 'unavailable') this.unknown(id, change.reason);
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
      bytes += page.items.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0); count += page.items.length;
      if (bytes > HISTORY_MAX_BYTES || count > HISTORY_MAX_ITEMS) throw new StoreError('history_gap_limit', 502);
      pages.push(await this.materialize(conversation, page.items)); lastCursor = page.olderCursor;
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
          const target = this.observationTarget(id);
          const results = await Promise.allSettled([adapter.state(current.binding!, target), this.readHistory(current, adapter)]);
          if (this.closed || this.runtimes.get(id) !== runtime) return;
          const currentTarget = this.observationTarget(id);
          if (runtime.stateGeneration !== stateGeneration || currentTarget !== target) { runtime.dirty = true; continue; }
          const [state, history] = results;
          if (state.status === 'rejected') throw state.reason;
          if (history.status === 'rejected') throw history.reason;
          this.adapter(this.conversation(id));
          // Text can arrive faster than native reads. It invalidates history, not a
          // verified state read; newer state/invalidate events still fence both.
          this.store.setConversationState(id, { state: state.value, readiness: state.value.configurationVerified ? 'ready' : 'blocked',
            error: state.value.configurationVerified ? null : 'native_configuration_unverified' });
          const queue = this.store.readQueue(id);
          if (queue.entries.length && !queue.pause && queue.afterRunId && state.value.configurationVerified) {
            const outcome = state.value.terminalRunId === queue.afterRunId ? state.value.terminalStatus : undefined;
            if (outcome === 'failed' || state.value.status === 'failed') this.store.pauseQueue(id, 'failed');
            else if (outcome === 'interrupted' || state.value.status === 'interrupted') this.store.pauseQueue(id, 'stopped');
          }
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
    this.launch(result.then(() => {
      runtime.syncing = undefined;
      if (this.closed || this.runtimes.get(id) !== runtime) return;
      if (runtime.dirty) this.scheduleSync(id); else this.drain(id);
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
    if (this.queueRecovery) clearInterval(this.queueRecovery);
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

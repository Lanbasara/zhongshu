import type { HostPhase } from './workspace-maintenance.ts';
import { HarnessError, type Catalog, type HarnessAdapter, type HarnessId, type HistoryPage, type NativeItem, type NativeState, type Receipt } from '../harness/types.ts';
import type { Workspace } from './harness-config.ts';
import { decodeImage, ResourceError, workspacePath, workspaceFiles } from './resources.ts';
import { NATIVE_IMAGE_OWNER } from './storage.ts';
import { nativeText } from '../shared/content.ts';
import { referenceSchema } from '../shared/content.ts';
import { isAbsolute, relative } from 'node:path';
import { listWorkspaceDocuments, openWorkspaceDocument, saveWorkspaceDocument } from './workspace-documents.ts';
import { createHash, randomUUID } from 'node:crypto';
import { StoreError, type WorkbenchStore, type CreateConversation, type OperationInput, type Conversation, type Operation } from './workbench-store.ts';
import type { WorkspaceRegistry } from './workspace-registry.ts';
import type { ConversationUsage, QueueCommand, QueueView, SubagentList, WorkbenchConfiguration, WorkbenchItem, workspaceAddSchema, workspaceManagementSchema } from '../shared/workbench.ts';
import { itemSchema, subagentIdSchema } from '../shared/workbench.ts';
import { SubagentStoreError, type SubagentStop } from './subagent-store.ts';
import { z } from 'zod';

const TERMINAL = new Set<NativeState['status']>(['idle', 'interrupted', 'failed']);
/** Target items per native history page; adapters translate it into their own page unit. */
const HISTORY_PAGE_SIZE = 50;
/** Hard bounds on what one native page may contribute to a response. */
const HISTORY_PAGE_ITEMS = 400;
/** Serialized bytes, so escaping cannot push a whole page past the response budget. */
const HISTORY_PAGE_BYTES = 6 * 1024 * 1024;
const NATIVE_CURSOR_LENGTH = 4096;
/** Live items beyond this count prompt a fresh latest-page read; the hard limit drops settled copies. */
const LIVE_SYNC_THRESHOLD = 64;
const LIVE_LIMIT = 256;
const LIVE_VIEW_LIMIT = 100;
/** Consecutive latest pages that overlap are joined in memory up to this many items. */
const TAIL_LIMIT = 200;
/** An unobserved latest page is reused only briefly; observed pages follow native events. */
const TAIL_FRESH_MS = 2000;
/** Recently served native items, kept in memory to verify quotes and workspace images. */
const SERVED_ITEMS_BYTES = 32 * 1024 * 1024;
const LOOKUP_PAGES = 5;
/** Native pages may hold only non-display events; skip at most this many to reach visible content. */
const EMPTY_PAGE_SKIP = 20;
/** The latest native page and in-flight items live only in memory (ADR 0014). */
type Tail = { items: NativeItem[]; olderCursor: string | null; at: number; error?: string };
type TailRead = { items: NativeItem[]; olderCursor: string | null; startedAt: number; usage?: ConversationUsage };
type Runtime = {
  stop?: () => void; watching?: Promise<void>; syncing?: Promise<void>; reading?: Promise<void>;
  timer?: NodeJS.Timeout; retry?: NodeJS.Timeout; flush?: NodeJS.Timeout; release?: NodeJS.Timeout;
  retryAttempt: number;
  live: Map<string, NativeItem>; generation: number; stateGeneration: number; dirty: boolean;
  /** Last body mark announced for each live item, so unchanged items are not re-announced. */
  flushed: Map<string, string>;
  /** When each live item last changed; settled copies older than a latest-page read retire. */
  liveAt: Map<string, number>;
  tail?: Tail;
  /** The native sub-agent tree may differ from the saved index. */
  subagentsDirty: boolean;
};
type SubagentLease = { readers: Map<string, number>; dispose?: () => void; opening?: Promise<void> };
const cursorEnvelope = z.object({ c: z.uuid(), n: z.string().min(1).max(NATIVE_CURSOR_LENGTH) }).strict();
const UNDISPLAYABLE = '这条原生内容超出显示限制，未能展示。';
/** Strip adapter-only fields and keep the public item contract strict. */
function viewItem(item: NativeItem): WorkbenchItem {
  const { fileEdits: _edits, imageSources: _sources, ...rest } = item;
  const parsed = itemSchema.safeParse(rest);
  if (parsed.success) return parsed.data;
  return { id: item.id, kind: 'notice', text: UNDISPLAYABLE, status: 'unknown', ...(item.runId ? { runId: item.runId } : {}) };
}
const tailMark = (items: NativeItem[], cursor: string | null) => items.map(item => `${item.id}\u0000${item.status}\u0000${item.text.length}`).join('\u0001') + '\u0002' + (cursor ?? '');
const liveMark = (item: NativeItem) => `${item.status}\u0000${item.text.length}\u0000${item.text.slice(-32)}\u0000${item.tool?.exitCode ?? ''}\u0000${item.tool?.output?.length ?? ''}\u0000${item.fileEdits?.length ?? ''}`;
/** Serialized size of the displayable part of a native page; transient image sources are excluded. */
function pageBytes(page: HistoryPage): number {
  let bytes = 0;
  for (const item of page.items) { const { imageSources: _sources, fileEdits: _edits, ...view } = item; bytes += Buffer.byteLength(JSON.stringify(view)); }
  return bytes;
}
function historyErrorCode(error: unknown): string {
  if (error instanceof StoreError) return error.code;
  if (error instanceof HarnessError && /cursor/i.test(error.code)) return 'history_cursor_invalid';
  return 'native_history_unavailable';
}

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
  private readonly draftPreparations = new Map<string, Promise<{ preparationId: string; skills: import('../shared/content.ts').SkillOption[] }>>();
  private readonly removing = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;
  private catalogCache?: Catalog[];
  private catalogAt = 0;
  private catalogLoading?: Promise<Catalog[]>;
  private queueRecovery?: NodeJS.Timeout;
  private queueRecoveryCursor = '';
  private recoveryComplete = false;
  private readonly readers = new Map<string, Map<string, number>>();
  private readonly deleting = new Set<string>();
  private deletionGuard: (id: string) => boolean = () => false;
  private readonly deletionTasks = new Map<string, Promise<void>>();
  private readonly subagentRefreshes = new Map<string, { task: Promise<void>; again: boolean }>();
  private readonly served = new Map<string, { item: NativeItem; bytes: number }>();
  private servedBytes = 0;
  private readonly subagentTimers = new Map<string, NodeJS.Timeout>();
  private readonly subagentTouches = new Map<string, Set<string>>();
  private readonly subagentLeases = new Map<string, SubagentLease>();
  private readonly subagentStops = new Map<string, Promise<void>>();

  constructor(store: WorkbenchStore, initialWorkspaces: Workspace[], adapters: Map<HarnessId, HarnessAdapter>, registry?: WorkspaceRegistry) {
    this.store = store; this.adapters = adapters;
    this.initialWorkspaces = initialWorkspaces; this.registry = registry;
    this.deletionGuard = id => this.store.deletions.get(id) !== null;
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
    if (this.executionBlocked(entry.directory) || this.draftPreparations.has(id)) throw new StoreError('workspace_remove_busy', 409);
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
    // The sub-agent index came from the same lost observation; no surface may keep calling it running.
    this.store.subagents.markUnverified(id);
    const runtime = this.runtimes.get(id); if (runtime) runtime.subagentsDirty = true;
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
  conversationDefaults(workspaceId?: string): Conversation | null {
    this.assertOpen();
    if (workspaceId) this.workspace(workspaceId);
    const eligible = this.workspaces.filter(workspace => (!workspaceId || workspace.id === workspaceId) &&
      !this.workspaceUnavailable(workspace.id) && !this.removing.has(workspace.id));
    const conversation = this.store.recentAcceptedConversation(eligible.map(({ id, directory }) => ({ id, directory })), [...this.adapters.keys()]);
    if (!conversation) return null;
    const adapter = this.adapters.get(conversation.harnessId);
    try {
      // Defaults seed a new draft. Do not rewrite the existing binding or its retry identity.
      return { ...conversation, configuration: adapter?.normalizeConfiguration?.(conversation.configuration) ?? conversation.configuration };
    } catch {
      // An unrecognized historical selection remains unavailable rather than changing its meaning.
      return conversation;
    }
  }

  async draftSkills(workspaceId: string, harnessId: HarnessId) {
    const workspace = this.workspace(workspaceId);
    const adapter = this.adapters.get(harnessId);
    if (!adapter) throw new StoreError('harness_unavailable', 409);
    if (!adapter.draftSkills) return { supported: false as const, skills: [], reason: 'draft_skills_unavailable' as const };
    return this.task(async () => {
      const skills = await adapter.draftSkills!(workspace.directory).catch(() => { throw new StoreError('skill_catalog_unavailable', 503); });
      this.assertOpen();
      this.assertWorkspaceAvailable(workspaceId);
      return { supported: true as const, skills };
    });
  }

  async prepareDraft(workspaceId: string, harnessId: HarnessId, expectedId?: string): Promise<{ preparationId: string; skills: import('../shared/content.ts').SkillOption[] }> {
    const workspace = this.workspace(workspaceId);
    const adapter = this.adapters.get(harnessId);
    if (harnessId !== 'dsh' || !adapter?.prepareDraft) throw new StoreError('draft_skills_unavailable', 409);
    if (this.removing.has(workspaceId) || this.executionBlocked(workspace.directory)) throw new StoreError('workspace_execution_blocked', 409);
    const active = this.draftPreparations.get(workspaceId);
    if (active) { await active; return this.prepareDraft(workspaceId, harnessId, expectedId); }
    const slot = this.store.reservePreparation(workspaceId, workspace.directory, randomUUID(), expectedId);
    const promise = this.task(async () => {
      const skills = await adapter.prepareDraft!({ id: slot.nativeId, cwd: workspace.directory }).catch(() => { throw new StoreError('draft_preparation_unavailable', 503); });
      this.assertOpen(); this.assertWorkspaceAvailable(workspaceId);
      if (this.executionBlocked(workspace.directory)) throw new StoreError('workspace_execution_blocked', 409);
      this.store.reservePreparation(workspaceId, workspace.directory, randomUUID(), slot.preparationId);
      return { preparationId: slot.preparationId, skills };
    });
    this.draftPreparations.set(workspaceId, promise);
    try { return await promise; } finally { this.draftPreparations.delete(workspaceId); }
  }

  async draftFiles(workspaceId: string, harnessId: HarnessId, directory = '') {
    const workspace = this.workspace(workspaceId);
    if (!this.adapters.has(harnessId)) throw new StoreError('harness_unavailable', 409);
    const result = await workspaceFiles(workspace.directory, directory);
    this.assertWorkspaceAvailable(workspaceId);
    return result;
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
            if (runtime) this.disposeRuntime(conversation.id);
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
    if (this.workspaces.some(workspace => this.draftPreparations.has(workspace.id) && this.overlaps(directory, workspace.directory))) return false;
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
    const owner = 'markdown:' + createHash('sha256').update(itemId + '\0' + source).digest('hex');
    // A saved first-readable snapshot was verified against its message when it was created.
    const cached = this.store.resources.owned(id, owner); if (cached) return cached;
    const item = await this.locateItem(id, itemId);
    if (!item || !item.text.includes(source)) throw new StoreError('image_unavailable', 404);
    const reference = referenceSchema.parse({ type: 'file', path: decodeURIComponent(source).replace(/^\.\//, '') });
    if (reference.type !== 'file') throw new StoreError('invalid_request', 400);
    const adapter = this.adapter(conversation);
    if (!conversation.binding || !adapter.readImage) throw new StoreError('image_unavailable', 404);
    const path = await workspacePath(conversation.cwd, reference.path);
    // Read in the native Host, never turn Markdown into a host-user filesystem proxy.
    const data = decodeImage(await adapter.readImage(conversation.binding, path));
    this.assertWorkspaceAvailable(conversation.workspaceId);
    const image = this.store.resources.put(id, reference.path.split('/').at(-1)!.slice(0,120), data, 'copy');
    this.store.resources.pin(id, image.id, owner);
    return this.store.resources.get(id, image.id);
  }
  async validateReferences(conversation: Conversation, input: OperationInput): Promise<void> {
    if (input.type !== 'message') return;
    for (const ref of input.payload.references ?? []) {
      if (ref.type === 'file') await workspacePath(conversation.cwd, ref.path);
      else {
        const item = await this.locateItem(conversation.id, ref.itemId).catch(() => undefined);
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
    // Native image reads do not touch the workspace, so history stays readable after a workspace is removed.
    const adapter = this.historyAdapter(conversation);
    const output: NativeItem[] = [];
    for (const raw of items) {
      const { imageSources, ...item } = raw;
      if (imageSources?.length && conversation.binding && item.status === 'completed') {
        const images = [];
        for (const [index, source] of imageSources.slice(0,4).entries()) {
          try {
            // Native image copies are regenerable and may be evicted under the storage budget.
            const owner = `${NATIVE_IMAGE_OWNER}${item.id}:${index}`;
            const old = this.store.resources.owned(conversation.id, owner);
            if (old) { images.push({ id: old.id, name: old.name, mediaType: old.mediaType }); continue; }
            const encoded = source.data ?? (source.path && adapter?.readImage ? await adapter.readImage(conversation.binding, source.path) : undefined);
            if (!encoded) throw new Error('image_unavailable');
            const image = this.store.resources.put(conversation.id, 'Agent 图片 ' + (index + 1), decodeImage(encoded.replace(/^data:image\/[a-z]+;base64,/, '')), 'copy');
            this.store.resources.pin(conversation.id, image.id, owner); images.push(image);
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
    this.assertOpen(); this.assertNotDeleting(input.id);
    if (this.removing.has(input.workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    this.assertWorkspaceAvailable(input.workspaceId);
    const workspace = this.workspaces.find(item => item.id === input.workspaceId);
    if (!workspace || this.adapters.get(input.harnessId)?.id !== input.harnessId) throw new StoreError('configuration_unavailable', 400);
    if (!this.store.getConversation(input.id) && this.executionBlocked(workspace.directory)) throw new StoreError('workspace_execution_blocked', 409);
    if (input.preparationId && this.draftPreparations.has(input.workspaceId)) await this.draftPreparations.get(input.workspaceId);
    this.assertOpen(); this.assertWorkspaceAvailable(input.workspaceId);
    if (this.removing.has(input.workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    if (!this.store.getConversation(input.id) && this.executionBlocked(workspace.directory)) throw new StoreError('workspace_execution_blocked', 409);
    // A full storage budget stops new conversations; retries of an existing one stay idempotent.
    if (!this.store.getConversation(input.id)) this.store.storage.assertRoom();
    const result = this.store.createConversation({ ...input, cwd: workspace.directory });
    if (result.created) this.launch(this.prepare(result.conversation));
    return result.conversation;
  }
  private prepare(conversation: Conversation): Promise<void> {
    this.assertNotDeleting(conversation.id);
    if (this.preparing.has(conversation.id)) return Promise.resolve();
    this.preparing.add(conversation.id);
    return this.task(async () => {
      let acceptingBinding = true;
      try {
        const adapter = this.adapter(conversation);
        const catalog = (await this.catalogs()).find(item => item.id === conversation.harnessId);
        this.assertOpen();
        this.assertWorkspaceAvailable(conversation.workspaceId);
        const configuration = adapter.normalizeConfiguration?.(conversation.configuration) ?? conversation.configuration;
        const model = catalog?.models.find(item => item.id === configuration.modelId);
        const effort = configuration.reasoningEffort;
        if (!catalog?.available || !model || (effort !== undefined && !model.reasoningEfforts?.some(item => item.id === effort)) ||
          !catalog.permissions.some(item => item.id === conversation.configuration.permissionId))
          throw new StoreError('configuration_unavailable', 409);
        const binding = await adapter.create({ cwd: conversation.cwd, configuration: conversation.configuration, title: conversation.title, ...(conversation.nativePreparationId ? { preparedId: conversation.nativePreparationId } : {}) }, value => {
          // During shutdown this task remains tracked: a native identity already created must still be saved.
          if (acceptingBinding) this.store.saveBinding(conversation.id, value);
        });
        this.store.saveBinding(conversation.id, binding);
        this.store.completePreparation(conversation.id);
        if (this.closed) throw new StoreError('workbench_closed', 503);
        await this.observe(conversation.id); await this.sync(conversation.id);
      } catch {
        this.store.setConversationState(conversation.id, { readiness: 'blocked', error: 'conversation_preparation_incomplete' });
      } finally { acceptingBinding = false; this.preparing.delete(conversation.id); this.releaseIdle(conversation.id); }
    });
  }

  start(): Promise<void> {
    this.assertOpen();
    return this.task(async () => {
      for (const workspace of this.workspaces) {
        if (workspace.maintenance) this.maintenancePhases.set(workspace.id, await workspace.maintenance('status'));
      }
      this.restoreDeletions();
      this.store.recoverDispatching();
      this.store.subagents.recoverDispatching();
      this.restoreQueuedConversations();
      this.ensureRecoveryTimer();
    });
  }
  private ensureRecoveryTimer(): void {
    this.queueRecovery ??= setInterval(() => {
      if (this.closed) return;
      for (const [id, readers] of this.readers) {
        for (const [reader, expiry] of readers) if (expiry <= Date.now()) readers.delete(reader);
        if (!readers.size) { this.readers.delete(id); this.releaseIdle(id); }
      }
      for (const [key, lease] of this.subagentLeases) {
        for (const [reader, expiry] of lease.readers) if (expiry <= Date.now()) lease.readers.delete(reader);
        if (!lease.readers.size) this.closeSubagentLease(key);
      }
      this.restoreDeletions();
      try { this.restoreQueuedConversations(); } catch { /* Durable recovery resumes on the next bounded pass. */ }
    }, 5000).unref();
  }
  private restoreQueuedConversations() {
    if (this.closed) return;
    // Sweep durable execution responsibility once at startup; idle history is never restored.
    // Subsequent scans are limited to the durable queue, not the whole conversation catalogue.
    const pending = this.recoveryComplete
      ? this.store.queuedConversations(this.queueRecoveryCursor)
      : this.store.recoverableConversations(this.queueRecoveryCursor);
    for (const id of pending) {
      if (this.runtimes.has(id) || this.isDeleting(id)) { this.queueRecoveryCursor = id; continue; }
      const conversation = this.conversation(id);
      if (!conversation.binding && !conversation.nativePreparationId && conversation.readiness === 'preparing') {
        this.store.setConversationState(id, { readiness: 'blocked', error: 'native_creation_result_unknown' });
        this.queueRecoveryCursor = id; continue;
      }
      if (!this.configured(conversation)) { try { this.adapter(conversation); } catch { /* saved blocked state */ } this.queueRecoveryCursor = id; continue; }
      if ((!conversation.binding && !conversation.nativePreparationId) || this.workspaceUnavailable(conversation.workspaceId) ||
        this.executionBlocked(conversation.cwd)) { this.queueRecoveryCursor = id; continue; }
      try { this.runtime(id); } catch { return; }
      this.queueRecoveryCursor = id;
      this.launch(this.restoreConversation(id));
    }
    if (pending.length < 64) { this.queueRecoveryCursor = ''; this.recoveryComplete = true; }
  }
  private restoreConversation(id: string): Promise<void> {
    if (this.isDeleting(id)) return Promise.resolve();
    const conversation = this.conversation(id);
    if (conversation.nativePreparationId) return this.prepare(conversation);
    return this.task(async () => {
      try {
        await this.observe(id); await this.sync(id);
        for (const stop of this.store.subagents.pendingStops(id)) if (stop.status === 'queued') this.launch(this.dispatchSubagentStop(stop.id));
      }
      catch { if (!this.closed) { this.unknown(id, 'native_observation_unavailable'); const runtime = this.runtimes.get(id); if (runtime) this.retryUnknown(id, runtime); } }
    });
  }
  async open(id: string) {
    this.assertOpen(); const conversation = this.conversation(id);
    this.assertNotDeleting(id);
    if ((conversation.binding || conversation.nativePreparationId) && !this.workspaceUnavailable(conversation.workspaceId) && !this.executionBlocked(conversation.cwd)) {
      const runtime = this.runtimes.get(id);
      if (this.hasExecutionResponsibility(id) && !runtime?.stop && !runtime?.watching && !runtime?.syncing) this.launch(this.restoreConversation(id));
    }
    // The first screen is the native latest page; no local copy is consulted (ADR 0014).
    await this.ensureTail(id).catch(() => {});
    if (this.runtimes.get(id)?.tail || !this.historyAdapter(this.conversation(id))) return this.snapshot(id);
    // No memory slot for this conversation (every slot is busy): still serve one native page directly.
    const direct: Tail = await this.readTail(id).then(read => ({ items: read.items, olderCursor: read.olderCursor, at: Date.now() }),
      error => ({ items: [], olderCursor: null, at: Date.now(), error: historyErrorCode(error) }));
    return this.snapshot(id, direct);
  }
  /** Reading leases belong to authenticated browser pages, never to native execution. */
  async reading(id: string, readerId: string): Promise<void> {
    this.assertOpen(); this.assertNotDeleting(id);
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(readerId)) throw new StoreError('invalid_reader', 400);
    const conversation = this.conversation(id);
    if (!this.configured(conversation)) return;
    let readers = this.readers.get(id);
    if (!readers) {
      if (this.readers.size >= 16) throw new StoreError('reader_limit', 429);
      readers = new Map(); this.readers.set(id, readers);
    }
    if (!readers.has(readerId) && readers.size >= 32) throw new StoreError('reader_limit', 429);
    const first = readers.size === 0;
    readers.set(readerId, Date.now() + 45_000);
    this.ensureRecoveryTimer();
    if ((first || !this.runtimes.get(id)?.stop) && conversation.binding && !this.executionBlocked(conversation.cwd)) {
      await this.observe(id); await this.sync(id);
    }
  }
  releaseReading(id: string, readerId: string): void {
    const readers = this.readers.get(id);
    readers?.delete(readerId);
    if (!readers?.size) this.readers.delete(id);
    this.releaseIdle(id);
  }
  setDeletionGuard(guard: (id: string) => boolean): void { this.deletionGuard = guard; }
  private isDeleting(id: string): boolean { return this.deleting.has(id) || this.deletionGuard(id); }
  private assertNotDeleting(id: string): void { if (this.isDeleting(id)) throw new StoreError('conversation_deleting', 409); }
  /** Caller persists the deletion intent before cleaning native data. No new work can enter this fence. */
  async quiesceForDeletion(id: string): Promise<Conversation> {
    this.assertOpen();
    if (this.preparing.has(id) || this.busyConversations.has(id)) throw new StoreError('conversation_busy', 409);
    this.deleting.add(id);
    try {
      const conversation = this.conversation(id);
      if (!conversation.binding && (conversation.nativePreparationId || conversation.error === 'native_creation_result_unknown' || conversation.error === 'conversation_preparation_incomplete'))
        throw new StoreError('conversation_preparation_incomplete', 409);
      const runtime = this.runtimes.get(id);
      await runtime?.watching; await runtime?.reading?.catch(() => {});
      if (conversation.binding) await this.sync(id);
      await this.runtimes.get(id)?.reading?.catch(() => {});
      const current = this.conversation(id);
      if (this.preparing.has(id) || this.busyConversations.has(id) ||
        (current.binding ? !this.messageAllowed(current) : current.readiness === 'preparing') || this.store.readQueue(id).entries.length)
        throw new StoreError('conversation_busy', 409);
      // Native deletion cascades to the spawn tree; running sub-agents keep the conversation busy.
      if (current.binding) await this.assertSubagentsSettled(id);
      this.readers.delete(id); this.disposeRuntime(id); this.forget(id);
      return current;
    } catch (error) { this.deleting.delete(id); throw error; }
  }
  private restoreDeletions(): void {
    if (this.closed) return;
    for (const id of this.store.deletions.listPending(8)) this.launch(this.deleteConversation(id));
  }
  deleteConversation(id: string): Promise<void> {
    this.assertOpen();
    const existing = this.deletionTasks.get(id);
    if (existing) return existing;
    if (this.store.deletions.get(id)?.status === 'completed') return Promise.resolve();
    const pending = this.task(async () => {
      try {
        const record = this.store.deletions.get(id);
        if (record?.status !== 'native_done') {
          const conversation = this.conversation(id);
          if (conversation.harnessId === 'dsh') throw new StoreError('conversation_delete_unsupported', 409);
          const adapter = conversation.binding ? this.adapter(conversation) : undefined;
          if (conversation.binding && !adapter?.delete) throw new StoreError('native_deletion_unavailable', 409);
          if (!record) {
            await this.quiesceForDeletion(id);
            this.store.deletions.begin(id);
          } else {
            // A persisted intent has already passed quiescence. A missing native identity
            // must reach the idempotent delete, not fail a new state/history preflight.
            this.deleting.add(id); this.readers.delete(id); this.disposeRuntime(id);
            this.store.deletions.begin(id);
          }
          if (conversation.binding) await adapter!.delete!(conversation.binding);
          this.store.deletions.nativeDone(id);
        }
        this.readers.delete(id); this.disposeRuntime(id);
        this.store.deletions.complete(id);
      } catch (error) {
        if (this.store.deletions.get(id)) this.store.deletions.fail(id, 'conversation_deletion_failed');
        else this.deleting.delete(id);
        throw error;
      }
    });
    this.deletionTasks.set(id, pending);
    void pending.then(() => { this.deletionTasks.delete(id); this.deleting.delete(id); }, () => this.deletionTasks.delete(id));
    return pending;
  }
  releaseDeletion(id: string): void { this.deleting.delete(id); }
  async skills(id: string) {
    this.assertOpen();
    const conversation = this.conversation(id);
    this.assertQueueDispatchable(conversation);
    const adapter = this.adapter(conversation);
    if (!adapter.skills) throw new StoreError('skill_catalog_unavailable', 503);
    return this.task(async () => {
      const skills = await adapter.skills!(conversation.binding!).catch(() => { throw new StoreError('skill_catalog_unavailable', 503); });
      this.assertOpen();
      this.assertQueueDispatchable(this.conversation(id));
      return skills;
    });
  }
  snapshot(id: string, direct?: Tail) {
    this.assertOpen(); let conversation = this.conversation(id);
    const unavailable = this.workspaceUnavailable(conversation.workspaceId);
    if (unavailable) conversation = { ...conversation, readiness: 'blocked', error: unavailable,
      state: { ...conversation.state, configurationVerified: false } };
    else if (!this.configured(conversation)) { try { this.adapter(conversation); } catch { conversation = this.conversation(id); } }
    const runtime = this.runtimes.get(id); const tail = runtime?.tail ?? direct;
    const items = (tail?.items ?? []).map(viewItem);
    const live = [...(runtime?.live.values() ?? [])];
    const liveItems = live.slice(-LIVE_VIEW_LIMIT).map(viewItem);
    const runIds = new Set<string>();
    for (const item of [...items, ...liveItems].reverse()) if (item.runId) runIds.add(item.runId);
    const history = { items, liveItems, liveItemsLimited: live.length > LIVE_VIEW_LIMIT,
      olderCursor: this.wrapCursor(id, tail?.olderCursor ?? null), loaded: !!tail && !tail.error, ...(tail?.error ? { error: tail.error } : {}) };
    return { conversation, history, turnFiles: this.store.readTurnFiles(id, [...runIds]),
      operations: this.store.listOperations({ conversationId: id, order: 'desc', limit: 100 }), queue: this.queue(id), revision: this.store.version() };
  }
  /** One older native page, addressed by a cursor the server issued for this conversation. Nothing is persisted. */
  async history(id: string, cursor: string) {
    this.assertOpen(); this.assertNotDeleting(id);
    const conversation = this.conversation(id); const adapter = this.historyAdapter(conversation);
    if (!adapter) throw new StoreError('conversation_not_ready', 409);
    const native = this.unwrapCursor(id, cursor);
    return this.task(async () => {
      let page: HistoryPage;
      try { page = await this.readPage(conversation, adapter, native); }
      catch (error) { const code = historyErrorCode(error); throw new StoreError(code, code === 'history_cursor_invalid' ? 409 : 502); }
      this.assertOpen(); this.assertNotDeleting(id);
      const items = (await this.present(conversation, page.items)).map(viewItem);
      const runIds = [...new Set(items.flatMap(item => item.runId ? [item.runId] : []))];
      return { items, olderCursor: this.wrapCursor(id, page.olderCursor), turnFiles: this.store.readTurnFiles(id, runIds.reverse()) };
    });
  }
  /** The newest version of a live or latest-page item, for change frames. */
  liveItem(id: string, itemId: string): WorkbenchItem | null {
    const runtime = this.runtimes.get(id);
    const item = runtime?.live.get(itemId) ?? runtime?.tail?.items.find(value => value.id === itemId);
    return item ? viewItem(item) : null;
  }
  private historyAdapter(conversation: Conversation): HarnessAdapter | undefined {
    const adapter = this.adapters.get(conversation.harnessId);
    return conversation.binding && adapter?.id === conversation.harnessId ? adapter : undefined;
  }
  private wrapCursor(id: string, native: string | null): string | null {
    if (native === null) return null;
    if (typeof native !== 'string' || !native || native.length > NATIVE_CURSOR_LENGTH) throw new StoreError('native_history_page_limit', 502);
    return Buffer.from(JSON.stringify({ c: id, n: native })).toString('base64url');
  }
  private unwrapCursor(id: string, cursor: string): string {
    try {
      const value = cursorEnvelope.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      if (value.c === id) return value.n;
    } catch { /* rejected below */ }
    throw new StoreError('history_cursor_invalid', 400);
  }
  /** One native page with visible content (or the beginning). An advancing cursor over hidden events is progress. */
  private async readPage(conversation: Conversation, adapter: HarnessAdapter, cursor: string | undefined): Promise<HistoryPage> {
    const seen = new Set<string>();
    for (let skipped = 0; ; skipped++) {
      // A page too large to serialize is asked for again with fewer items from the same cursor.
      let limit = HISTORY_PAGE_SIZE; let page: HistoryPage;
      for (;;) {
        page = await adapter.history(conversation.binding!, cursor, limit);
        // A single oversized item is still returned; its view is replaced by an explicit notice when it cannot display.
        this.checkPage(page, true);
        if (pageBytes(page) <= HISTORY_PAGE_BYTES || limit === 1) break;
        limit = Math.ceil(limit / 2);
      }
      if (page.items.length || !page.olderCursor || skipped >= EMPTY_PAGE_SKIP) return page;
      if (seen.has(page.olderCursor)) throw new StoreError('history_no_progress', 502);
      seen.add(page.olderCursor); cursor = page.olderCursor;
    }
  }
  private checkPage(page: HistoryPage, shrinkable = false): void {
    if (!page || !Array.isArray(page.items) || page.items.length > HISTORY_PAGE_ITEMS ||
      (page.olderCursor !== null && (typeof page.olderCursor !== 'string' || !page.olderCursor || page.olderCursor.length > NATIVE_CURSOR_LENGTH)))
      throw new StoreError('native_history_page_limit', 502);
    if (!shrinkable && pageBytes(page) > HISTORY_PAGE_BYTES) throw new StoreError('native_history_page_limit', 502);
  }
  private async present(conversation: Conversation, items: NativeItem[]): Promise<NativeItem[]> {
    const presented = await this.materialize(conversation, items);
    try { this.store.recordTurnFiles(conversation.id, presented); } catch { /* the edited-path index is a hint, never a reading failure */ }
    this.remember(conversation.id, presented);
    return presented;
  }
  private remember(id: string, items: NativeItem[]): void {
    for (const value of items) {
      const { imageSources: _sources, ...item } = value;
      const key = `${id}\u0000${item.id}`; const bytes = Buffer.byteLength(item.text) + 512;
      const old = this.served.get(key); if (old) { this.served.delete(key); this.servedBytes -= old.bytes; }
      if (bytes > SERVED_ITEMS_BYTES / 4) continue;
      this.served.set(key, { item, bytes }); this.servedBytes += bytes;
    }
    for (const [key, entry] of this.served) { if (this.servedBytes <= SERVED_ITEMS_BYTES) break; this.served.delete(key); this.servedBytes -= entry.bytes; }
  }
  private forget(id: string): void {
    for (const [key, entry] of this.served) if (key.startsWith(`${id}\u0000`)) { this.served.delete(key); this.servedBytes -= entry.bytes; }
  }
  private findItem(id: string, itemId: string): NativeItem | undefined {
    const runtime = this.runtimes.get(id);
    return runtime?.live.get(itemId) ?? runtime?.tail?.items.find(item => item.id === itemId) ?? this.served.get(`${id}\u0000${itemId}`)?.item;
  }
  /** Verify against native history: memory first, then a bounded walk back from the latest page. */
  private async locateItem(id: string, itemId: string): Promise<NativeItem | undefined> {
    const found = this.findItem(id, itemId); if (found) return found;
    const conversation = this.conversation(id); const adapter = this.historyAdapter(conversation);
    if (!adapter) return undefined;
    let cursor: string | undefined;
    for (let number = 0; number < LOOKUP_PAGES; number++) {
      const page = await this.readPage(conversation, adapter, cursor);
      const item = page.items.find(value => value.id === itemId);
      if (item) { this.remember(id, [item]); return item; }
      if (!page.olderCursor) return undefined;
      cursor = page.olderCursor;
    }
    return undefined;
  }
  private ensureTail(id: string): Promise<void> {
    const conversation = this.conversation(id);
    if (!this.historyAdapter(conversation) || this.isDeleting(id) || this.closed) return Promise.resolve();
    let runtime: Runtime;
    try { runtime = this.runtime(id); } catch { return Promise.resolve(); }
    const tail = runtime.tail;
    if (tail && !tail.error && (runtime.stop || Date.now() - tail.at < TAIL_FRESH_MS)) return Promise.resolve();
    if (runtime.syncing) return runtime.syncing.catch(() => {});
    if (!runtime.reading) {
      const reading = this.task(async () => {
        try { this.applyTail(id, runtime, await this.readTail(id)); }
        catch (error) { this.failTail(id, runtime, error); }
      });
      runtime.reading = reading;
      void reading.finally(() => { if (runtime.reading === reading) runtime.reading = undefined; this.releaseIdle(id); });
    }
    return runtime.reading;
  }
  private async readTail(id: string): Promise<TailRead> {
    const conversation = this.conversation(id); const adapter = this.historyAdapter(conversation);
    if (!adapter) throw new StoreError('conversation_not_ready', 409);
    const startedAt = Date.now();
    const page = await this.readPage(conversation, adapter, undefined);
    this.assertOpen();
    return { items: await this.present(conversation, page.items), olderCursor: page.olderCursor, startedAt, ...(page.usage ? { usage: page.usage } : {}) };
  }
  private applyTail(id: string, runtime: Runtime, read: TailRead): void {
    if (this.closed || this.runtimes.get(id) !== runtime || this.isDeleting(id)) return;
    const previous = runtime.tail;
    let items = read.items; let olderCursor = read.olderCursor;
    // Join an overlapping previous latest page so items that scrolled out of the newest page stay contiguous.
    if (previous && !previous.error && items.length) {
      const overlap = previous.items.findIndex(item => item.id === items[0]!.id);
      if (overlap > 0 && overlap + items.length <= TAIL_LIMIT) { items = [...previous.items.slice(0, overlap), ...items]; olderCursor = previous.olderCursor; }
    }
    const present = new Map(items.map(item => [item.id, item]));
    for (const [key, live] of runtime.live) {
      const item = present.get(key);
      if (!item) {
        // A settled copy that predates this read and is absent from the contiguous latest page is older history now.
        if (live.status !== 'running' && (runtime.liveAt.get(key) ?? 0) < read.startedAt) this.retireLive(runtime, key);
        continue;
      }
      // A completed canonical item retires its live copy; a newer live body otherwise keeps precedence by identity.
      const sameBody = item.kind === live.kind && item.text === live.text && item.runId === live.runId && item.operationId === live.operationId;
      if ((live.status === 'running' && item.status === 'completed') || (sameBody && (item.status === live.status || item.status === 'completed'))) this.retireLive(runtime, key);
      else if (item.fileEdits && live.runId === item.runId && live.status === 'completed') runtime.live.set(key, { ...live, fileEdits: item.fileEdits });
    }
    runtime.tail = { items, olderCursor, at: Date.now() };
    if (!previous || previous.error || tailMark(previous.items, previous.olderCursor) !== tailMark(items, olderCursor)) this.store.touch(id);
    this.enrichReceipts(id);
  }
  private retireLive(runtime: Runtime, key: string): void { runtime.live.delete(key); runtime.flushed.delete(key); runtime.liveAt.delete(key); }
  private failTail(id: string, runtime: Runtime, error: unknown): void {
    if (this.closed || this.runtimes.get(id) !== runtime || this.isDeleting(id)) return;
    // Reading failures keep already loaded content and never fence execution by themselves.
    const code = historyErrorCode(error);
    if (runtime.tail?.error === code) { runtime.tail.at = Date.now(); return; }
    runtime.tail = { items: runtime.tail?.items ?? [], olderCursor: runtime.tail?.olderCursor ?? null, at: Date.now(), error: code };
    this.store.touch(id);
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
    this.assertOpen(); this.assertNotDeleting(id);
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
      this.assertNotDeleting(id);
      this.store.changeQueue(id, command);
      if (!this.executionBlocked(conversation.cwd)) this.launch(this.restoreConversation(id));
    }
    return this.queue(id);
  }
  private assertQueueDispatchable(conversation: Conversation) {
    this.assertNotDeleting(conversation.id);
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
  renameConversation(id: string, title: string): Conversation {
    this.assertOpen(); this.assertNotDeleting(id);
    return this.store.renameConversation(id, title);
  }
  async setArchived(id: string, archived: boolean) {
    this.assertOpen(); this.assertNotDeleting(id);
    const current = this.conversation(id);
    if (archived && !current.archived && current.binding) {
      await this.observe(id);
      await this.sync(id);
      this.assertOpen();
      // Native archive stops the spawn tree; it must not hide running sub-agents. A busy main agent is reported first.
      if (this.messageAllowed(this.conversation(id))) await this.assertSubagentsSettled(id);
    }
    this.assertNotDeleting(id);
    return this.store.setArchived(id, archived, conversation =>
      conversation.binding ? this.messageAllowed(conversation) :
        conversation.readiness === 'blocked' && conversation.state.pendingInputs === 0 &&
        !['running', 'waiting'].includes(conversation.state.status));
  }
  async enqueue(input: OperationInput) {
    this.assertOpen(); this.assertNotDeleting(input.conversationId);
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
    this.assertNotDeleting(input.conversationId);
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
      this.releaseIdle(queued.conversationId);
    };
    void task.then(settled, settled);
    return task;
  }
  private drain(id: string): void {
    if (this.closed || this.isDeleting(id) || this.executionBlocked(this.conversation(id).cwd)) return;
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
      const runId = this.runIdForOperation(id, operation.id);
      if (runId) this.store.settleOperation(operation.id, { outcome: 'accepted', runId });
    }
  }
  /** The native run that received an operation, as seen in the latest page or live items. Older evidence is reconciled natively. */
  private runIdForOperation(id: string, operationId: string): string | null {
    const runtime = this.runtimes.get(id); if (!runtime) return null;
    const runs = new Set<string>();
    for (const item of [...(runtime.tail?.items ?? []), ...runtime.live.values()])
      if (item.kind === 'user' && item.operationId === operationId && item.runId) runs.add(item.runId);
    return runs.size === 1 ? [...runs][0]! : null;
  }
  reconcile(id: string): Promise<void> {
    this.assertOpen(); this.assertNotDeleting(id);
    return this.task(async () => {
      let conversation = this.conversation(id); const adapter = this.adapter(conversation); if (!conversation.binding) return;
      await this.observe(id); await this.sync(id); this.assertOpen(); this.assertNotDeleting(id); conversation = this.conversation(id);
      for (const operation of this.store.listOperations({ conversationId: id, status: 'unknown', order: 'desc', limit: 100 })) {
        this.assertOpen(); this.assertNotDeleting(id); this.adapter(this.conversation(id));
        if (operation.type === 'message') {
          const runId = this.runIdForOperation(id, operation.id);
          const receipt = runId ? { outcome: 'accepted' as const, runId } : await adapter.reconcile(conversation.binding!, operation.id);
          this.assertOpen(); this.assertNotDeleting(id);
          this.store.settleOperation(operation.id, receipt);
        } else {
          await this.sync(id); this.assertOpen(); this.assertNotDeleting(id);
          const current = this.conversation(id);
          if (current.state.configurationVerified && TERMINAL.has(current.state.status) && current.state.runId === operation.payload.runId)
            this.store.settleOperation(operation.id, { outcome: 'accepted', runId: operation.payload.runId });
        }
      }
      const latest = this.store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 1 })[0];
      if (latest?.runId === null) {
        this.assertOpen(); this.assertNotDeleting(id); this.adapter(this.conversation(id));
        const receipt = await adapter.reconcile(conversation.binding!, latest.id);
        this.assertOpen(); this.assertNotDeleting(id);
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

  // Native sub-agents (ADR 0013): observe and stop only. The workbench never spawns or messages them.
  private subagentKey(id: string, agentId: string): string { return `${id}\u0000${agentId}`; }
  private hasSubagentReaders(id: string): boolean {
    for (const key of this.subagentLeases.keys()) if (key.startsWith(`${id}\u0000`)) return true;
    return false;
  }
  private ownedSubagent(id: string, agentId: string) {
    if (!subagentIdSchema.safeParse(agentId).success) throw new StoreError('invalid_request', 400);
    const agent = this.store.subagents.get(id)?.agents.find(value => value.id === agentId);
    if (!agent) throw new StoreError('subagent_not_found', 404);
    return agent;
  }
  private subagentTarget(id: string) {
    const conversation = this.conversation(id);
    const adapter = this.adapter(conversation);
    if (!conversation.binding) throw new StoreError('conversation_not_ready', 409);
    return { binding: conversation.binding, adapter };
  }
  /** Coalesce native hints: transcript growth only bumps that agent's revision; other hints re-read the tree. */
  private scheduleSubagents(id: string, agentId?: string, transcript = false): void {
    if (this.closed || this.isDeleting(id)) return;
    if (agentId) {
      let touched = this.subagentTouches.get(id);
      if (!touched) { touched = new Set(); this.subagentTouches.set(id, touched); }
      if (touched.size < 64) touched.add(agentId);
    }
    const runtime = this.runtimes.get(id);
    if (!transcript && runtime) runtime.subagentsDirty = true;
    if (this.subagentTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.subagentTimers.delete(id);
      const touched = this.subagentTouches.get(id); this.subagentTouches.delete(id);
      if (this.closed || this.isDeleting(id) || !this.store.getConversation(id)) return;
      try { if (touched?.size) this.store.subagents.touch(id, [...touched]); } catch { /* the next verified read replaces revisions */ }
      const current = this.runtimes.get(id);
      if (current?.subagentsDirty) { current.subagentsDirty = false; this.launch(this.refreshSubagents(id)); }
    }, 400);
    timer.unref(); this.subagentTimers.set(id, timer);
  }
  /** Single-flight native read of the spawn tree. A failed read revokes verification instead of keeping old states. */
  private refreshSubagents(id: string, duringDeletion = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    const conversation = this.store.getConversation(id);
    if (!conversation || !this.adapters.get(conversation.harnessId)?.subagents) return Promise.resolve();
    const running = this.subagentRefreshes.get(id);
    if (running) { running.again = true; return running.task; }
    // Register before starting so a fast completion can always remove its own entry.
    const entry = { task: Promise.resolve(), again: false };
    this.subagentRefreshes.set(id, entry);
    entry.task = this.task(async () => {
      await Promise.resolve();
      try {
        do {
          entry.again = false;
          const conversation = this.store.getConversation(id);
          // Archived trees were settled before archiving; keep their last verified index.
          if (!conversation?.binding || conversation.archived || (!duringDeletion && this.isDeleting(id))) return;
          const adapter = this.adapter(conversation);
          if (!adapter.subagents) return;
          let snapshot: Awaited<ReturnType<NonNullable<typeof adapter.subagents>>>;
          try { snapshot = await adapter.subagents(conversation.binding); }
          catch (error) {
            if (!this.closed && (duringDeletion || !this.isDeleting(id)) && this.store.getConversation(id)) this.store.subagents.markUnverified(id);
            throw error;
          }
          if (this.closed || (!duringDeletion && this.isDeleting(id)) || !this.store.getConversation(id)) return;
          this.store.subagents.save(id, conversation.binding.id, snapshot);
          // A verified non-running target settles an unknown stop. This reads native state; it never resends.
          const settled = new Map(snapshot.agents.map(agent => [agent.id, agent.status]));
          for (const stop of this.store.subagents.pendingStops(id)) {
            const status = settled.get(stop.agentId);
            if (stop.status === 'unknown' && status && status !== 'running' && status !== 'unknown') this.store.subagents.settleStop(stop.id, { outcome: 'accepted' });
          }
        } while (entry.again && !this.closed);
      } finally {
        if (this.subagentRefreshes.get(id) === entry) this.subagentRefreshes.delete(id);
        this.releaseIdle(id);
      }
    });
    return entry.task;
  }
  /** Archive and deletion cascade natively; they wait until no sub-agent is running or unverified. */
  private async assertSubagentsSettled(id: string): Promise<void> {
    const conversation = this.conversation(id);
    if (!conversation.binding || !this.adapters.get(conversation.harnessId)?.subagents) return;
    try { await this.refreshSubagents(id, true); }
    catch {
      // Without a readable tree, refuse only when sub-agents are known; never invent ones that were not observed.
      if (this.store.subagents.get(id)?.agents.length) throw new StoreError('subagents_unverified', 409);
      return;
    }
    if (this.store.subagents.busy(id)) throw new StoreError('subagents_running', 409);
  }
  async subagents(id: string): Promise<SubagentList> {
    this.assertOpen(); this.assertNotDeleting(id);
    const conversation = this.conversation(id);
    const stored = this.store.subagents.get(id);
    const runtime = this.runtimes.get(id);
    if (conversation.binding && this.configured(conversation) && this.adapters.get(conversation.harnessId)?.subagents &&
      !this.executionBlocked(conversation.cwd) && (!stored || !stored.verified || !runtime?.stop))
      await this.refreshSubagents(id).catch(() => { /* the index reports itself unverified */ });
    this.assertOpen(); this.assertNotDeleting(id);
    return this.store.subagents.view(id);
  }
  private childItem(item: NativeItem): WorkbenchItem | undefined {
    // Child transcripts are read through and never stored; native image bytes are not materialized here.
    const { imageSources, fileEdits: _fileEdits, images: _images, ...rest } = item;
    const value = imageSources?.length && !rest.text ? { ...rest, text: '子 Agent 生成的图片暂不在此显示。' } : rest;
    const parsed = itemSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }
  async subagentHistory(id: string, agentId: string, cursor?: string): Promise<{ brief?: string; items: WorkbenchItem[]; olderCursor: string | null }> {
    this.assertOpen(); this.assertNotDeleting(id);
    const { binding, adapter } = this.subagentTarget(id);
    const agent = this.ownedSubagent(id, agentId);
    if (agent.external) return { items: [], olderCursor: null };
    if (!adapter.subagentHistory) throw new StoreError('subagent_history_unavailable', 409);
    return this.task(async () => {
      let page: Awaited<ReturnType<NonNullable<typeof adapter.subagentHistory>>>;
      try { page = await adapter.subagentHistory!(binding, agentId, cursor, 50); }
      catch (error) {
        if (error instanceof HarnessError && error.code === 'subagent_not_owned') throw new StoreError('subagent_not_found', 404);
        throw new StoreError('subagent_history_unavailable', 503);
      }
      this.assertOpen(); this.assertNotDeleting(id);
      const items = page.items.slice(-100).map(item => this.childItem(item)).filter((item): item is WorkbenchItem => !!item);
      const brief = page.brief && Buffer.byteLength(page.brief) <= 64 * 1024 ? page.brief : page.brief?.slice(0, 16_000);
      return { ...(brief ? { brief } : {}), items, olderCursor: page.olderCursor };
    });
  }
  /** Reading leases for one sub-agent keep its live hints flowing; they never affect native execution. */
  async readingSubagent(id: string, agentId: string, readerId: string, active: boolean): Promise<void> {
    const key = this.subagentKey(id, agentId);
    if (!active) {
      const lease = this.subagentLeases.get(key);
      lease?.readers.delete(readerId);
      if (lease && !lease.readers.size) this.closeSubagentLease(key);
      return;
    }
    this.assertOpen(); this.assertNotDeleting(id);
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(readerId)) throw new StoreError('invalid_reader', 400);
    const { binding, adapter } = this.subagentTarget(id);
    const agent = this.ownedSubagent(id, agentId);
    let lease = this.subagentLeases.get(key);
    if (!lease) {
      if (this.subagentLeases.size >= 16) throw new StoreError('reader_limit', 429);
      lease = { readers: new Map() }; this.subagentLeases.set(key, lease);
    }
    if (!lease.readers.has(readerId) && lease.readers.size >= 8) throw new StoreError('reader_limit', 429);
    lease.readers.set(readerId, Date.now() + 45_000);
    this.ensureRecoveryTimer();
    if (agent.external || !adapter.observeSubagent || lease.dispose) return;
    if (lease.opening) return lease.opening;
    const own = lease;
    own.opening = this.task(async () => {
      try {
        await this.observe(id);
        const dispose = await adapter.observeSubagent!(binding, agentId);
        if (this.closed || this.subagentLeases.get(key) !== own) dispose(); else own.dispose = dispose;
      } catch { /* Explicit reads still work; the next renewal retries live hints. */ }
      finally { own.opening = undefined; }
    });
    return own.opening;
  }
  private closeSubagentLease(key: string): void {
    const lease = this.subagentLeases.get(key); if (!lease) return;
    this.subagentLeases.delete(key);
    try { lease.dispose?.(); } catch { /* releasing observation never stops native work */ }
    this.releaseIdle(key.slice(0, key.indexOf('\u0000')));
  }
  stopSubagent(id: string, agentId: string, stopId: string): SubagentStop {
    this.assertOpen(); this.assertNotDeleting(id);
    const { adapter } = this.subagentTarget(id);
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
    if (result.stop.status === 'queued') this.launch(this.dispatchSubagentStop(result.stop.id));
    return result.stop;
  }
  private dispatchSubagentStop(stopId: string): Promise<void> {
    const existing = this.subagentStops.get(stopId); if (existing) return existing;
    const task = this.task(async () => {
      const queued = this.store.subagents.getStop(stopId);
      if (!queued || queued.status !== 'queued' || this.closed || this.isDeleting(queued.conversationId)) return;
      const conversation = this.conversation(queued.conversationId);
      const adapter = this.adapters.get(conversation.harnessId);
      if (!conversation.binding || !adapter?.stopSubagent || !this.configured(conversation)) {
        this.store.subagents.settleStop(stopId, { outcome: 'rejected', reason: 'subagent_stop_unavailable' }); return;
      }
      if (!this.store.subagents.claimStop(stopId)) return;
      let receipt: Receipt;
      try { receipt = await adapter.stopSubagent(conversation.binding, queued.agentId); }
      catch { receipt = { outcome: 'unknown', reason: 'native_receipt_unknown' }; }
      this.store.subagents.settleStop(stopId, receipt);
      if (!this.closed && !this.isDeleting(queued.conversationId)) await this.refreshSubagents(queued.conversationId).catch(() => {});
    });
    this.subagentStops.set(stopId, task);
    void task.then(() => this.subagentStops.delete(stopId), () => this.subagentStops.delete(stopId));
    return task;
  }
  /** Settle an unknown stop only from a verified native read. A still-running agent leaves it unknown; nothing is resent. */
  async reconcileSubagentStop(id: string, stopId: string): Promise<SubagentStop> {
    this.assertOpen(); this.assertNotDeleting(id);
    const stop = this.store.subagents.getStop(stopId);
    if (!stop || stop.conversationId !== id) throw new StoreError('operation_not_found', 404);
    if (stop.status === 'queued') { await this.dispatchSubagentStop(stopId); return this.store.subagents.getStop(stopId)!; }
    if (stop.status !== 'unknown') return stop;
    await this.refreshSubagents(id).catch(() => {});
    this.assertOpen(); this.assertNotDeleting(id);
    const snapshot = this.store.subagents.get(id);
    const agent = snapshot?.agents.find(value => value.id === stop.agentId);
    if (snapshot?.verified && agent && !['running', 'unknown'].includes(agent.status))
      return this.store.subagents.settleStop(stopId, { outcome: 'accepted' });
    return this.store.subagents.getStop(stopId)!;
  }

  private hasExecutionResponsibility(id: string): boolean {
    const conversation = this.store.getConversation(id);
    if (!conversation) return false;
    if ([...(this.runtimes.get(id)?.live.values() ?? [])].some(item => item.status === 'running')) return true;
    if (this.preparing.has(id) || this.busyConversations.has(id) || conversation.state.pendingInputs ||
      ['running', 'waiting', 'unknown'].includes(conversation.state.status)) return true;
    for (const status of ['queued', 'dispatching', 'unknown'] as const)
      if (this.store.listOperations({ conversationId: id, status, limit: 1 }).length) return true;
    const latest = this.latestAcceptedMessage(id);
    if (latest && (!latest.runId || (latest.runId !== conversation.state.runId && latest.runId !== conversation.state.terminalRunId))) return true;
    const queue = this.store.readQueue(id);
    if (!queue.pause && queue.entries.length > 0) return true;
    // Native sub-agents keep working after the main turn ends; keep observing until they settle,
    // and keep a Codex parent loaded while it holds results it has not read yet.
    return this.store.subagents.busy(id) || (!conversation.archived && this.store.subagents.holdsObservation(id));
  }
  private releaseIdle(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime || this.closed || runtime.release || this.isDeleting(id)) return;
    if (runtime.syncing || runtime.watching || runtime.reading || runtime.dirty || this.readers.has(id) || this.hasSubagentReaders(id) || this.subagentRefreshes.has(id) || this.hasExecutionResponsibility(id)) return;
    runtime.release = setTimeout(() => {
      runtime.release = undefined;
      if (this.runtimes.get(id) !== runtime || runtime.syncing || runtime.watching || runtime.reading || runtime.dirty || this.readers.has(id) || this.hasSubagentReaders(id) || this.subagentRefreshes.has(id) || this.hasExecutionResponsibility(id)) return;
      this.flushLive(id, runtime);
      this.disposeRuntime(id);
    }, 250);
    runtime.release.unref();
  }
  private retryUnknown(id: string, runtime: Runtime): void {
    if (this.closed || this.isDeleting(id) || this.runtimes.get(id) !== runtime || runtime.retry) return;
    const current = this.store.getConversation(id);
    // Recovery only: ordinary live execution relies on native events, never timer silence.
    if (!current || (!this.hasExecutionResponsibility(id) && current.state.status !== 'unknown') || ['running', 'waiting'].includes(current.state.status)) return;
    runtime.retry = setTimeout(() => {
      runtime.retry = undefined;
      if (this.runtimes.get(id) === runtime && !this.isDeleting(id)) this.launch(this.reconcile(id).catch(() => {
        if (!this.closed && this.runtimes.get(id) === runtime) { this.unknown(id, 'native_observation_unavailable'); this.retryUnknown(id, runtime); }
      }));
    }, Math.min(60_000, 1000 * 2 ** Math.min(runtime.retryAttempt++, 6)));
    runtime.retry.unref();
  }
  private runtime(id: string): Runtime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      if (this.runtimes.size >= 64) {
        const idle = [...this.runtimes].find(([key, value]) => !value.syncing && !value.watching && !value.reading && !this.preparing.has(key) && !this.busyConversations.has(key) &&
          !this.readers.has(key) && !this.hasExecutionResponsibility(key));
        if (!idle) throw new StoreError('active_conversation_limit', 429);
        this.disposeRuntime(idle[0]);
      }
      runtime = { live: new Map(), flushed: new Map(), liveAt: new Map(), generation: 0, stateGeneration: 0, dirty: false, retryAttempt: 0, subagentsDirty: true }; this.runtimes.set(id, runtime);
    }
    return runtime;
  }
  private flushLive(id: string, runtime: Runtime): void {
    if (this.closed || this.runtimes.get(id) !== runtime) return;
    runtime.flush = undefined;
    // Live bodies stay in memory; only change hints (and edited paths) are persisted (ADR 0014).
    try {
      const changed: NativeItem[] = [];
      for (const item of runtime.live.values()) {
        const mark = liveMark(item);
        if (runtime.flushed.get(item.id) === mark) continue;
        runtime.flushed.set(item.id, mark); changed.push(item);
      }
      if (changed.length) {
        this.store.recordTurnFiles(id, changed);
        // A few items travel inside their change frames; a larger batch asks pages to re-read the snapshot.
        if (changed.length <= 4) for (const item of changed) this.store.touch(id, item.id);
        else this.store.touch(id);
      }
      this.enrichReceipts(id);
    } catch { this.scheduleSync(id); }
  }
  private observe(id: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const conversation = this.conversation(id); const adapter = this.adapter(conversation); if (!conversation.binding) return Promise.resolve();
    const runtime = this.runtime(id);
    if (runtime.release) { clearTimeout(runtime.release); runtime.release = undefined; }
    if (runtime.stop) return Promise.resolve(); if (runtime.watching) return runtime.watching;
    runtime.watching = this.task(async () => {
      const stop = await adapter.watch(conversation.binding!, change => {
        if (this.closed || this.isDeleting(id) || this.runtimes.get(id) !== runtime) return;
        try {
          if (change.type === 'usage') { this.store.setUsage(id, change.usage); return; }
          if (change.type === 'subagents') { this.scheduleSubagents(id, change.agentId, change.transcript); return; }
          runtime.generation++;
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
            runtime.live.set(change.item.id, change.item); runtime.liveAt.set(change.item.id, Date.now());
            // Many in-flight items prompt a fresh latest page, which retires settled live copies.
            if (runtime.live.size >= LIVE_SYNC_THRESHOLD) this.scheduleSync(id);
            if (runtime.live.size > LIVE_LIMIT) for (const [key, value] of runtime.live) {
              if (runtime.live.size <= LIVE_LIMIT) break;
              if (value.status !== 'running') this.retireLive(runtime, key);
            }
            if (!runtime.flush) { runtime.flush = setTimeout(() => this.flushLive(id, runtime), 40); runtime.flush.unref(); }
            if (runtime.syncing) runtime.dirty = true;
          } else {
            runtime.stateGeneration++;
            if (change.type === 'state') {
              this.store.setConversationState(id, { state: change.state });
              // An unknown native state means the same observation cannot vouch for its sub-agents either.
              if (change.state.status === 'unknown') { this.store.subagents.markUnverified(id); runtime.subagentsDirty = true; }
              if (change.state.configurationVerified && ['running', 'waiting'].includes(change.state.status)) return;
            }
            // Transport loss is a fact, not a hint to wait for a successful read.
            // Keep saved history/identity while fencing reads from before loss.
            if (change.type === 'unavailable') this.unknown(id, change.reason);
            this.scheduleSync(id);
          }
        } catch { this.unknown(id, 'native_update_requires_sync'); this.scheduleSync(id); }
      });
      if (this.closed || this.runtimes.get(id) !== runtime) stop();
      else { runtime.stop = stop; }
    });
    void runtime.watching.then(() => { runtime.watching = undefined; }, () => { runtime.watching = undefined; });
    return runtime.watching;
  }
  private scheduleSync(id: string): void {
    if (this.closed || this.isDeleting(id)) return;
    const runtime = this.runtime(id); runtime.dirty = true;
    if (runtime.syncing || runtime.timer) return;
    runtime.timer = setTimeout(() => { runtime.timer = undefined; this.launch(this.sync(id)); }, 120); runtime.timer.unref();
  }
  private sync(id: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const conversation = this.conversation(id); if (!conversation.binding) return Promise.resolve();
    const runtime = this.runtime(id); runtime.dirty = true;
    if (runtime.syncing) return runtime.syncing;
    runtime.syncing = this.task(async () => {
      if (runtime.reading) await runtime.reading.catch(() => {});
      for (let pass = 0; pass < 3 && runtime.dirty && !this.closed; pass++) {
        runtime.dirty = false; const stateGeneration = runtime.stateGeneration;
        try {
          const current = this.conversation(id); const adapter = this.adapter(current);
          const target = this.observationTarget(id);
          // Execution state and the latest native page are read together; there is no gap to fill (ADR 0014).
          const [state, history] = await Promise.allSettled([adapter.state(current.binding!, target), this.readTail(id)]);
          if (this.closed || this.runtimes.get(id) !== runtime) return;
          if (history.status === 'fulfilled') this.applyTail(id, runtime, history.value); else this.failTail(id, runtime, history.reason);
          const currentTarget = this.observationTarget(id);
          if (runtime.stateGeneration !== stateGeneration || currentTarget !== target) { runtime.dirty = true; continue; }
          if (state.status === 'rejected') throw state.reason;
          // An unverified unknown read never erases last-known run and pending facts; it takes the recovery path.
          if (state.value.status === 'unknown' && !state.value.configurationVerified)
            throw new StoreError(/^[a-z][a-z0-9_]{0,99}$/.test(state.value.reason ?? '') ? state.value.reason! : 'native_state_unavailable', 502);
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
          if (state.value.configurationVerified && history.status === 'fulfilled' && history.value.usage) this.store.setUsage(id, history.value.usage);
          if (runtime.flush) { clearTimeout(runtime.flush); this.flushLive(id, runtime); }
          if (state.value.configurationVerified && (runtime.subagentsDirty || this.store.subagents.get(id)?.verified === false ||
            (runtime.tail?.items ?? []).some(item => item.collaboration))) { runtime.subagentsDirty = false; this.launch(this.refreshSubagents(id)); }
          if (state.value.status !== 'unknown' && !this.hasExecutionResponsibility(id)) runtime.retryAttempt = 0;
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
      this.releaseIdle(id);
      this.retryUnknown(id, runtime);
    }, () => { runtime.syncing = undefined; if (!this.closed) this.scheduleSync(id); }));
    return result;
  }
  private disposeRuntime(id: string): void {
    const timer = this.subagentTimers.get(id); if (timer) { clearTimeout(timer); this.subagentTimers.delete(id); this.subagentTouches.delete(id); }
    for (const key of [...this.subagentLeases.keys()]) if (key.startsWith(`${id}\u0000`)) this.closeSubagentLease(key);
    const runtime = this.runtimes.get(id); if (!runtime) return;
    if (runtime.timer) clearTimeout(runtime.timer); if (runtime.retry) clearTimeout(runtime.retry); if (runtime.release) clearTimeout(runtime.release); if (runtime.flush) clearTimeout(runtime.flush);
    try { runtime.stop?.(); } finally { this.runtimes.delete(id); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.queueRecovery) clearInterval(this.queueRecovery);
    this.closing = (async () => {
      // In-flight bodies are memory only; the native Harness keeps the authoritative history (ADR 0014).
      for (const id of [...this.runtimes.keys()]) {
        try { this.disposeRuntime(id); } catch { /* adapter.close still runs */ }
      }
      // Closing connections first unblocks pending RPCs. The database owner may close it only after every task settles.
      await Promise.allSettled([...this.adapters.values()].map(adapter => Promise.resolve().then(() => adapter.close())));
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    })();
    return this.closing;
  }
}

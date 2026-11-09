// Layer 4 (ADR 0024): drafts and new conversations (ADR 0010, 0011, 0017). Nothing becomes a product conversation
// before the first send; a DSH draft may hold one prepared native session per workspace.
import { randomUUID } from 'node:crypto';
import type { Catalog, HarnessId } from '../../harness/types.ts';
import { workspaceFiles } from '../resources.ts';
import { StoreError, type Conversation, type CreateConversation, type WorkbenchStore } from '../workbench-store.ts';
import type { Bindings } from './bindings.ts';
import type { DraftPreparation, Gate } from './gate.ts';
import type { Observation } from './observation.ts';
import type { Tasks } from './tasks.ts';

type Deps = { store: WorkbenchStore; tasks: Tasks; bindings: Bindings; gate: Gate; observation: Observation };

export class Creation {
  private readonly store: WorkbenchStore;
  private readonly tasks: Tasks;
  private readonly bindings: Bindings;
  private readonly gate: Gate;
  private readonly observation: Observation;
  private catalogCache?: Catalog[];
  private catalogAt = 0;
  private catalogLoading?: Promise<Catalog[]>;

  constructor(deps: Deps) {
    this.store = deps.store; this.tasks = deps.tasks; this.bindings = deps.bindings;
    this.gate = deps.gate; this.observation = deps.observation;
  }

  catalogs(): Promise<Catalog[]> {
    this.tasks.assertOpen();
    if (this.catalogCache && Date.now() - this.catalogAt < 30_000) return Promise.resolve(this.catalogCache);
    if (!this.catalogLoading) {
      this.catalogLoading = this.tasks.task(async () => {
        const values = await Promise.all((['codex', 'dsh'] as const).map(async id => {
          const adapter = this.bindings.adapters.get(id);
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
  conversationDefaults(workspaceId?: string): Conversation | null {
    this.tasks.assertOpen();
    if (workspaceId) this.bindings.workspace(workspaceId);
    const eligible = this.bindings.workspaces.filter(workspace => (!workspaceId || workspace.id === workspaceId) &&
      !this.bindings.workspaceUnavailable(workspace.id) && !this.gate.removing(workspace.id));
    const conversation = this.store.recentAcceptedConversation(eligible.map(({ id, directory }) => ({ id, directory })), [...this.bindings.adapters.keys()]);
    if (!conversation) return null;
    const adapter = this.bindings.adapters.get(conversation.harnessId);
    try {
      // Defaults seed a new draft. Do not rewrite the existing binding or its retry identity.
      return { ...conversation, configuration: adapter?.normalizeConfiguration?.(conversation.configuration) ?? conversation.configuration };
    } catch {
      // An unrecognized historical selection remains unavailable rather than changing its meaning.
      return conversation;
    }
  }
  async draftSkills(workspaceId: string, harnessId: HarnessId) {
    const workspace = this.bindings.workspace(workspaceId);
    const adapter = this.bindings.adapters.get(harnessId);
    if (!adapter) throw new StoreError('harness_unavailable', 409);
    if (!adapter.draftSkills) return { supported: false as const, skills: [], reason: 'draft_skills_unavailable' as const };
    return this.tasks.task(async () => {
      const skills = await adapter.draftSkills!(workspace.directory).catch(() => { throw new StoreError('skill_catalog_unavailable', 503); });
      this.tasks.assertOpen();
      this.bindings.assertWorkspaceAvailable(workspaceId);
      return { supported: true as const, skills };
    });
  }
  async prepareDraft(workspaceId: string, harnessId: HarnessId, expectedId?: string): Promise<Awaited<DraftPreparation>> {
    const workspace = this.bindings.workspace(workspaceId);
    const adapter = this.bindings.adapters.get(harnessId);
    if (harnessId !== 'dsh' || !adapter?.prepareDraft) throw new StoreError('draft_skills_unavailable', 409);
    if (this.gate.removing(workspaceId) || this.gate.executionBlocked(workspace.directory)) throw new StoreError('workspace_execution_blocked', 409);
    const active = this.gate.drafting(workspaceId);
    if (active) { await active; return this.prepareDraft(workspaceId, harnessId, expectedId); }
    const slot = this.store.reservePreparation(workspaceId, workspace.directory, randomUUID(), expectedId);
    const promise = this.tasks.task(async () => {
      const skills = await adapter.prepareDraft!({ id: slot.nativeId, cwd: workspace.directory }).catch(() => { throw new StoreError('draft_preparation_unavailable', 503); });
      this.tasks.assertOpen(); this.bindings.assertWorkspaceAvailable(workspaceId);
      if (this.gate.executionBlocked(workspace.directory)) throw new StoreError('workspace_execution_blocked', 409);
      this.store.reservePreparation(workspaceId, workspace.directory, randomUUID(), slot.preparationId);
      return { preparationId: slot.preparationId, skills };
    });
    this.gate.beginDrafting(workspaceId, promise);
    try { return await promise; } finally { this.gate.endDrafting(workspaceId); }
  }
  async draftFiles(workspaceId: string, harnessId: HarnessId, directory = '') {
    const workspace = this.bindings.workspace(workspaceId);
    if (!this.bindings.adapters.has(harnessId)) throw new StoreError('harness_unavailable', 409);
    const result = await workspaceFiles(workspace.directory, directory);
    this.bindings.assertWorkspaceAvailable(workspaceId);
    return result;
  }

  async create(input: Omit<CreateConversation, 'cwd'>): Promise<Conversation> {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(input.id);
    if (this.gate.removing(input.workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    this.bindings.assertWorkspaceAvailable(input.workspaceId);
    const workspace = this.bindings.workspaces.find(item => item.id === input.workspaceId);
    if (!workspace || this.bindings.adapters.get(input.harnessId)?.id !== input.harnessId) throw new StoreError('configuration_unavailable', 400);
    if (!this.store.getConversation(input.id) && this.gate.executionBlocked(workspace.directory)) throw new StoreError('workspace_execution_blocked', 409);
    if (input.preparationId && this.gate.drafting(input.workspaceId)) await this.gate.drafting(input.workspaceId);
    this.tasks.assertOpen(); this.bindings.assertWorkspaceAvailable(input.workspaceId);
    if (this.gate.removing(input.workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    if (!this.store.getConversation(input.id) && this.gate.executionBlocked(workspace.directory)) throw new StoreError('workspace_execution_blocked', 409);
    // A full storage budget stops new conversations; retries of an existing one stay idempotent.
    if (!this.store.getConversation(input.id)) this.store.storage.assertRoom();
    const result = this.store.createConversation({ ...input, cwd: workspace.directory });
    if (result.created) this.tasks.launch(this.prepare(result.conversation));
    return result.conversation;
  }
  /** Create the native session for a new conversation, then observe it. Also resumes an interrupted creation. */
  prepare(conversation: Conversation): Promise<void> {
    this.gate.assertNotDeleting(conversation.id);
    if (this.gate.preparing(conversation.id)) return Promise.resolve();
    this.gate.beginPreparing(conversation.id);
    return this.tasks.task(async () => {
      let acceptingBinding = true;
      try {
        const adapter = this.bindings.adapter(conversation);
        const catalog = (await this.catalogs()).find(item => item.id === conversation.harnessId);
        this.tasks.assertOpen();
        this.bindings.assertWorkspaceAvailable(conversation.workspaceId);
        const configuration = adapter.normalizeConfiguration?.(conversation.configuration) ?? conversation.configuration;
        const model = catalog?.models.find(item => item.id === configuration.modelId);
        const effort = configuration.reasoningEffort;
        const preset = configuration.agentPreset;
        if (!catalog?.available || !model || (effort !== undefined && !model.reasoningEfforts?.some(item => item.id === effort)) ||
          !catalog.permissions.some(item => item.id === conversation.configuration.permissionId) ||
          // A chosen preset must be offered and usable now; it is never swapped for another (ADR 0017).
          (preset !== undefined && !catalog.presets?.some(item => item.id === preset && item.available)))
          throw new StoreError('configuration_unavailable', 409);
        const binding = await adapter.create({ cwd: conversation.cwd, configuration: conversation.configuration, title: conversation.title,
          ...(conversation.nativePreparationId ? { preparedId: conversation.nativePreparationId } : {}) }, value => {
          // During shutdown this task remains tracked: a native identity already created must still be saved.
          if (acceptingBinding) this.store.saveBinding(conversation.id, value);
        });
        this.store.saveBinding(conversation.id, binding);
        this.store.completePreparation(conversation.id);
        if (this.tasks.closed) throw new StoreError('workbench_closed', 503);
        await this.observation.observe(conversation.id); await this.observation.sync(conversation.id);
      } catch {
        this.store.setConversationState(conversation.id, { readiness: 'blocked', error: 'conversation_preparation_incomplete' });
      } finally { acceptingBinding = false; this.gate.endPreparing(conversation.id); this.observation.release(conversation.id); }
    });
  }
}

// Layer 4 (ADR 0024): workspace registration and removal, maintained Hosts, and saving workspace files.
// A save or a maintained Host fences native work through the gate; the conversations must be idle first.
import type { z } from 'zod';
import type { workspaceAddSchema, workspaceManagementSchema, WorkbenchConfiguration } from '../../shared/workbench.ts';
import { ResourceError } from '../resources.ts';
import { listWorkspaceDocuments, openWorkspaceDocument, saveWorkspaceDocument } from '../workspace-documents.ts';
import type { HostPhase } from '../workspace-maintenance.ts';
import { StoreError, type Conversation, type WorkbenchStore } from '../workbench-store.ts';
import { overlaps, type Bindings } from './bindings.ts';
import type { Gate } from './gate.ts';
import { TERMINAL, type Ledger } from './ledger.ts';
import type { Observation } from './observation.ts';
import type { Tasks } from './tasks.ts';

type Deps = { store: WorkbenchStore; tasks: Tasks; bindings: Bindings; gate: Gate; ledger: Ledger; observation: Observation };

export class Workspaces {
  private readonly store: WorkbenchStore;
  private readonly tasks: Tasks;
  private readonly bindings: Bindings;
  private readonly gate: Gate;
  private readonly ledger: Ledger;
  private readonly observation: Observation;

  constructor(deps: Deps) {
    this.store = deps.store; this.tasks = deps.tasks; this.bindings = deps.bindings;
    this.gate = deps.gate; this.ledger = deps.ledger; this.observation = deps.observation;
  }

  /** Read each maintained Host's phase once at startup. */
  async start(): Promise<void> {
    for (const workspace of this.bindings.workspaces) {
      if (workspace.maintenance) this.gate.setPhase(workspace.id, await workspace.maintenance('status'));
    }
  }
  view(): Omit<WorkbenchConfiguration, 'harnesses'> {
    return this.bindings.registry?.view() ?? { workspaces: this.bindings.workspaces.map(({ id, label }) => ({ id, label })) };
  }
  browse(id: string, path: string[]) {
    if (!this.bindings.registry) throw new StoreError('workspace_root_not_found', 404);
    return this.bindings.registry.browse(id, path);
  }
  add(input: z.infer<typeof workspaceAddSchema>) {
    this.tasks.assertOpen();
    if (!this.bindings.registry) throw new StoreError('workspace_root_not_found', 404);
    return this.bindings.registry.add(input);
  }
  async manage(id: string, input: z.infer<typeof workspaceManagementSchema>): Promise<void> {
    this.tasks.assertOpen();
    const registry = this.bindings.registry;
    const entry = registry?.get(id);
    if (!registry || !entry) throw new StoreError('workspace_not_found', 404);
    if (this.gate.removing(id)) throw new StoreError('workspace_remove_busy', 409);
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
    if (this.gate.executionBlocked(entry.directory) || this.gate.drafting(id)) throw new StoreError('workspace_remove_busy', 409);
    this.gate.beginRemoving(id);
    try {
      await this.tasks.task(async () => {
        if (!await this.confirmIdle(entry.directory, false, id) || this.gate.executionBlocked(entry.directory))
          throw new StoreError('workspace_remove_busy', 409);
        this.tasks.assertOpen();
        for (const conversation of this.conversations(entry.directory, id)) this.observation.flush(conversation.id);
        registry.remove(id);
        for (const conversation of this.conversations(entry.directory, id)) this.observation.dispose(conversation.id);
      });
    } finally { this.gate.endRemoving(id); }
  }

  changeMaintenance(id: string, action: 'pause' | 'resume') {
    const workspace = this.bindings.workspace(id);
    const controller = workspace.maintenance;
    const { directory } = workspace;
    if (!controller) throw new StoreError('workspace_maintenance_unavailable', 409);
    const previous = this.gate.phase(id);
    if (previous === 'transition' || this.gate.saving(directory)) throw new StoreError('workspace_maintenance_busy', 409);
    if (action === 'pause' && previous === 'paused') return this.editStatus(id);
    if (action === 'pause' && previous !== 'online') throw new StoreError('workspace_maintenance_unavailable', 409);
    this.gate.setPhase(id, 'transition');
    return this.tasks.task(async () => {
      let next: HostPhase = 'unknown';
      try {
        if (action === 'pause' && !await this.confirmIdle(directory)) {
          next = 'online';
          throw new StoreError('workspace_not_idle', 409);
        }
        const expected = action === 'pause' ? 'paused' : 'online';
        if (await controller(action) !== expected || await controller('status') !== expected)
          throw new StoreError('workspace_maintenance_unavailable', 409);
        if (action === 'pause') {
          for (const conversation of this.conversations(directory)) {
            if (this.observation.has(conversation.id)) this.observation.dispose(conversation.id);
          }
        }
        if (action === 'resume' && !await this.confirmIdle(directory, true) &&
          !await this.confirmIdle(directory, true))
          throw new StoreError('workspace_maintenance_unavailable', 409);
        next = expected;
      } finally {
        this.gate.setPhase(id, next);
      }
      return this.editStatus(id);
    });
  }
  private *conversations(directory: string, workspaceId?: string) {
    let beforeId: string | undefined;
    for (;;) {
      const page: Conversation[] = this.store.listConversations({ beforeId, limit: 100, workspaceId });
      for (const conversation of page) if (workspaceId || overlaps(directory, conversation.cwd)) yield conversation;
      if (page.length < 100) return;
      beforeId = page.at(-1)!.id;
    }
  }
  // Maintenance owns the execution gate while reading native state. History
  // delivery and observation-slot eviction do not participate in this proof.
  private async confirmIdle(directory: string, publish = false, removingId?: string): Promise<boolean> {
    if (this.bindings.workspaces.some(workspace => this.gate.drafting(workspace.id) && overlaps(directory, workspace.directory))) return false;
    const check = async (conversation: Conversation) => {
      if (!conversation.binding || !this.bindings.configured(conversation) ||
        this.gate.preparing(conversation.id) || this.gate.busy(conversation.id)) return false;
      const id = conversation.id;
      const runtime = this.observation.slot(id);
      const generation = runtime?.stateGeneration;
      const target = this.ledger.latestAcceptedMessage(id)?.runId;
      try {
        const state = await this.bindings.adapter(conversation).state(conversation.binding, target ?? undefined);
        this.tasks.assertOpen();
        const current = this.bindings.conversation(id);
        if (this.observation.slot(id) !== runtime || runtime?.stateGeneration !== generation ||
          this.ledger.latestAcceptedMessage(id)?.runId !== target || this.gate.busy(id) ||
          !this.bindings.configured(current) || current.binding?.id !== conversation.binding.id ||
          !(removingId ? TERMINAL.has(state.status) : state.status === 'idle') ||
          !this.observation.messageAllowed({ ...current, state, readiness: 'ready' }, undefined, true)) return false;
        if (publish) {
          this.observation.bumpState(id);
          this.store.setConversationState(id, { state, readiness: 'ready', error: null });
        }
        return true;
      } catch { return false; }
    };
    let batch: Promise<boolean>[] = [];
    for (const conversation of this.conversations(directory, removingId)) {
      batch.push(check(conversation));
      if (batch.length === 4) {
        if (!(await Promise.all(batch)).every(Boolean)) return false;
        batch = [];
      }
    }
    return (await Promise.all(batch)).every(Boolean);
  }
  private idleForEditing(conversation: Conversation): boolean {
    const runtime = this.observation.slot(conversation.id);
    return this.bindings.configured(conversation) && !this.gate.preparing(conversation.id) &&
      !this.gate.busy(conversation.id) && !!runtime?.stop && !runtime.syncing &&
      conversation.state.status === 'idle' && this.observation.messageAllowed(conversation);
  }
  editStatus(id: string) {
    const { directory, managedWrites, maintenance } = this.bindings.workspace(id);
    if (!managedWrites) return { editable: false, reason: 'workspace_writes_unmanaged' };
    if (this.gate.saving(directory)) return { editable: false, reason: 'workspace_save_in_progress' };
    const phase = maintenance ? this.gate.phase(id) ?? 'unknown' : undefined;
    if (phase && phase !== 'online') {
      return { editable: phase === 'paused', reason: phase === 'paused' ? null : 'workspace_maintenance_' + phase, maintenance: phase };
    }
    let idle = true;
    let restoring = 0;
    for (const conversation of this.conversations(directory)) {
      if (phase === 'online') {
        if (!this.bindings.configured(conversation) || this.gate.preparing(conversation.id) || this.gate.busy(conversation.id) ||
          ['running', 'waiting', 'interrupted', 'failed'].includes(conversation.state.status) || conversation.state.pendingInputs) idle = false;
        continue;
      }
      if (this.idleForEditing(conversation)) continue;
      idle = false;
      const runtime = this.observation.slot(conversation.id);
      if (restoring < 4 && this.bindings.configured(conversation) && conversation.binding && !runtime?.stop && !runtime?.watching) {
        restoring++;
        this.tasks.launch(this.observation.restore(conversation.id));
      }
    }
    if (phase === 'online') {
      return { editable: false, reason: idle ? 'workspace_maintenance_online' : 'workspace_not_idle', maintenance: phase, canPause: idle };
    }
    return { editable: idle, reason: idle ? null : 'workspace_not_idle' };
  }
  async listFiles(id: string, directory: string) {
    const result = await listWorkspaceDocuments(this.bindings.workspace(id).directory, directory, this.bindings.registry?.get(id)?.identity);
    this.bindings.assertWorkspaceAvailable(id);
    return result;
  }
  async openFile(id: string, path: string) {
    const result = await openWorkspaceDocument(this.bindings.workspace(id).directory, path, this.bindings.registry?.get(id)?.identity);
    this.bindings.assertWorkspaceAvailable(id);
    return result;
  }
  saveFile(id: string, path: string, version: string, text: string) {
    const { directory, maintenance } = this.bindings.workspace(id);
    const identity = this.bindings.registry?.get(id)?.identity;
    if (this.gate.removing(id)) throw new StoreError('workspace_remove_busy', 409);
    const status = this.editStatus(id);
    if (!status.editable) throw new StoreError(status.reason!, 409);
    this.gate.beginSaving(directory);
    return this.tasks.task(async () => {
      try {
        if (maintenance) {
          if (await maintenance('status') !== 'paused') {
            this.gate.setPhase(id, 'unknown');
            throw new StoreError('workspace_maintenance_unavailable', 409);
          }
          return await saveWorkspaceDocument(directory, path, version, text, () => {
            this.tasks.assertOpen(); this.bindings.assertWorkspaceAvailable(id);
          }, identity);
        }
        for (const conversation of this.conversations(directory)) await this.observation.sync(conversation.id);
        const assertWritable = () => {
          this.tasks.assertOpen();
          this.bindings.assertWorkspaceAvailable(id);
          for (const conversation of this.conversations(directory)) {
            if (!this.idleForEditing(conversation)) throw new ResourceError('workspace_not_idle', 409);
          }
        };
        assertWritable();
        return await saveWorkspaceDocument(directory, path, version, text, assertWritable, identity);
      } finally { this.gate.endSaving(directory); }
    });
  }
}

import { createHash, randomUUID } from 'node:crypto';
import type { ExecutionController, ExecutionControllerResult } from './execution-controller.ts';
import { ExecutionCoordinator, type BaselineBinding, type BaselineObservation, type ExecutionCursor, type ExecutionGate, type PendingExecution, type SaveWriteIdentity, type SavePermit } from './execution-coordinator.ts';
import type { AsyncExecutionStore } from './execution-store.ts';
import type { AsyncWorkspaceStore, Registration } from './workspace-store.ts';
import { StoreError } from './workbench-store.ts';

export type ManagedWorkspaceGroup = { groupId: string; harnessId?: 'codex' | 'dsh'; workspaceIds: string[]; workspaceRootIds: string[]; conflicts?: string[]; controller: ExecutionController };
export type ManagedExecutionCallbacks = {
  observeBaseline(binding: BaselineBinding, context: { groupId: string; through: number; after?: ExecutionCursor }): Promise<BaselineObservation>;
  resolvePending(pending: PendingExecution): Promise<'settled' | 'pending' | 'unknown'>;
  recoverSaves?(windowId?: string): Promise<void>;
};
export type ManagedEditStatus = { editable: boolean; reason: string | null; canPause: boolean;
  maintenance: 'online' | 'paused' | 'unknown' | 'transition'; phase: ExecutionGate['phase'] | 'initializing';
    windowId?: string; affectedGroups: string[]; initialized: boolean; canRecover?: boolean };
const proof = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameController = (a: ExecutionGate['controller'], b: ExecutionGate['controller']) => a.groupId === b.groupId && a.generation === b.generation && a.epoch === b.epoch && a.admission === b.admission && a.writers === b.writers && a.frozenSetId === b.frozenSetId;

/** Background initialization and ongoing reconciliation are bounded work units.
 * The SQLite port and the gateway own permission, never these scheduling hints.
 */
export class ManagedWorkspaceExecution {
  readonly port: AsyncExecutionStore;
  readonly coordinator: ExecutionCoordinator;
  private readonly groups: ManagedWorkspaceGroup[];
  private readonly workspaces: AsyncWorkspaceStore;
  private callbacks?: ManagedExecutionCallbacks;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopped = false;
  private readonly registered = new Set<string>();
  private conflictsRegistered = false;
  private readonly hostGroupsRegistered = new Set<string>();
  private registrationCursor?: string;
  private registrations: Registration[] = [];
  private registrationOffset = 0;
  private scopeGroup = 0;
  private registrationsComplete = false;
  private groupCursor = 0;
  private readonly pendingCursors = new Map<string, ExecutionCursor>();
  private readonly newWorkspaces = new Set<string>();
  private error?: string;
  private saveRecoveryAt = 0;
  private readonly hostChecks = new Map<string, { at: number; result: ExecutionControllerResult }>();
  initialized = false;
  constructor(input: { port: AsyncExecutionStore; workspaces: AsyncWorkspaceStore; groups: ManagedWorkspaceGroup[] }) {
    if (!input.groups.length || input.groups.length > 32 || new Set(input.groups.map(group => group.groupId)).size !== input.groups.length) throw new StoreError('execution_group_configuration_invalid', 400);
    this.port = input.port; this.workspaces = input.workspaces; this.groups = [...input.groups].sort((a, b) => a.groupId.localeCompare(b.groupId));
    this.coordinator = new ExecutionCoordinator(input.port, new Map(this.groups.map(group => [group.groupId, group.controller])), pending => this.callbacks ? this.callbacks.resolvePending(pending) : Promise.resolve('unknown'));
  }
  private configured(row: Registration) { return this.groups.filter(group => group.workspaceIds.includes(row.id) || row.root_id !== null && group.workspaceRootIds.includes(row.root_id)); }
  async managed(workspaceId: string) { const row = await this.workspaces.get(workspaceId); return !!row && this.configured(row).length > 0; }
  async registerWorkspace(workspaceId: string): Promise<void> {
    const row = await this.workspaces.get(workspaceId); if (!row || !this.configured(row).length) return;
    if (this.newWorkspaces.size >= 32 && !this.newWorkspaces.has(workspaceId)) throw new StoreError('execution_scope_registration_busy', 429);
    this.newWorkspaces.add(workspaceId); this.schedule(0);
  }
  async assertAdmission(workspaceId: string): Promise<void> {
    const row = await this.workspaces.get(workspaceId); if (!row) return;
    const configured = this.configured(row); if (!configured.length) return;
    if (!this.initialized) throw new StoreError(this.error ?? 'execution_baseline_incomplete', 409);
    const mapped = await this.port.workspaceGroups(workspaceId);
    if (configured.some(group => !mapped.includes(group.groupId))) { await this.registerWorkspace(workspaceId); throw new StoreError('execution_scope_registration_pending', 409); }
    const gates = await this.port.load(mapped);
    if (gates.some(gate => !gate.baselineComplete || gate.phase !== 'online' || gate.controller.admission !== 'open' || this.hostChecks.get(gate.groupId)?.result.status === 'unknown')) throw new StoreError('execution_admission_closed', 409);
  }
  start(callbacks: ManagedExecutionCallbacks) { if (this.callbacks) return; this.callbacks = callbacks; this.schedule(0); }
  private schedule(delay = 100) {
    if (this.stopped || !this.callbacks || this.timer || this.active) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.active = this.advance().catch(error => { this.error = error instanceof StoreError ? error.code : 'execution_reconciliation_unknown'; });
      void this.active.finally(() => { this.active = undefined; this.schedule(this.error ? 1000 : this.initialized ? 100 : 0); });
    }, delay).unref();
  }
  /** Public for deterministic operator/bootstrap probes; never overlaps work. */
  async step(): Promise<void> {
    if (this.active) return this.active;
    clearTimeout(this.timer); this.timer = undefined; this.active = this.advance();
    try { await this.active; } finally { this.active = undefined; this.schedule(this.initialized ? 100 : 0); }
  }
  private recoverable(row: ExecutionGate) {
    return row.phase === 'online' && !row.windowId && !row.intent && !row.stage && !row.frozenSetId && row.controller.admission === 'open' && row.controller.writers === 'running' && !row.controller.frozenSetId;
  }
  private async checkHost(group: ManagedWorkspaceGroup, row: ExecutionGate, explicit = false): Promise<ExecutionControllerResult> {
    if (!group.controller.recover || !this.recoverable(row)) return group.controller.inspect('inspect-' + randomUUID(), row.controller);
    const prior = this.hostChecks.get(group.groupId);
    if (!explicit && prior && Date.now() - prior.at < 1000) return prior.result;
    const result = await group.controller.recover({ requestId: 'recover-' + randomUUID(), explicit });
    const checked: ExecutionControllerResult = result.status === 'known' && !sameController(row.controller, result.state) ? { status: 'unknown', reason: 'epoch_mismatch' } : result;
    this.hostChecks.set(group.groupId, { at: Date.now(), result: checked }); return checked;
  }
  private async advance() {
    if (this.stopped || !this.callbacks) return;
    const missing = this.groups.find(group => !this.registered.has(group.groupId));
    if (missing) {
      // An existing online gate is the only authority to recover during startup.
      // Missing/incomplete baselines and durable edit windows never imply start.
      const existing = await this.port.load([missing.groupId]).then(rows => rows[0]).catch(() => undefined);
      const inspected = existing ? await this.checkHost(missing, existing) : await missing.controller.inspect('bootstrap-' + randomUUID());
      if (inspected.status !== 'known') throw new StoreError(inspected.reason === 'controller_unknown' ? 'execution_controller_unknown' : inspected.reason, 503);
      const current = await this.port.registerGroup(inspected.state);
      if (!sameController(current.controller, inspected.state)) throw new StoreError('execution_controller_epoch_changed', 409);
      this.registered.add(missing.groupId); this.error = undefined; return;
    }
    if (!this.registrationsComplete) {
      if (!this.conflictsRegistered) {
        const pairs = new Map<string, { left: string; right: string }>();
        for (const group of this.groups) for (const other of group.conflicts ?? []) {
          const pair = [group.groupId, other].sort(); if (pair[0] !== pair[1]) pairs.set(pair.join('\0'), { left: pair[0]!, right: pair[1]! });
        }
        await this.port.registerConflicts([...pairs.values()]); this.conflictsRegistered = true; return;
      }
      const hostGroup = this.groups.find(group => group.harnessId && !this.hostGroupsRegistered.has(group.groupId));
      if (hostGroup) {
        await this.port.registerHostGroup({ groupId: hostGroup.groupId, harnessId: hostGroup.harnessId! });
        this.hostGroupsRegistered.add(hostGroup.groupId); return;
      }
      if (!this.registrations.length && !this.registrationCursor && (await this.port.load(this.groups.map(group => group.groupId))).every(row => row.baselineComplete)) {
        this.registrationsComplete = true; return;
      }
      if (this.registrationOffset === this.registrations.length) {
        let page;
        try { page = await this.workspaces.page({ cursor: this.registrationCursor, limit: 50 }); }
        catch (error) { if (error instanceof StoreError && error.code === 'workspace_cursor_expired') { this.registrationCursor = undefined; return; } throw error; }
        this.registrations = page.entries; this.registrationOffset = 0; this.registrationCursor = page.nextCursor ?? undefined;
        if (!this.registrations.length) { this.registrationsComplete = page.nextCursor === null; return; }
      }
      const row = this.registrations[this.registrationOffset]!; const configured = this.configured(row);
      if (this.scopeGroup < configured.length) {
        if ((await this.port.registerScope({ workspaceId: row.id, groupId: configured[this.scopeGroup]!.groupId })).complete) this.scopeGroup++;
      } else {
        this.registrationOffset++; this.scopeGroup = 0;
        if (this.registrationOffset === this.registrations.length && !this.registrationCursor) this.registrationsComplete = true;
      }
      this.error = undefined; return;
    }
    const rows = await this.port.load(this.groups.map(group => group.groupId));
    const incomplete = rows.find(row => !row.baselineComplete);
    if (incomplete) {
      if (incomplete.windowId || incomplete.error === 'execution_restore_requires_reconciliation') throw new StoreError('execution_restore_requires_reconciliation', 409);
      let status = await this.port.baselineStatus(incomplete.groupId);
      if (!status.checkpoint) { await this.port.beginBaseline(incomplete.groupId); status = await this.port.baselineStatus(incomplete.groupId); }
      const source = status.sources.find(source => !source.complete);
      if (source) { await this.port.seedLegacyAdmissions({ groupId: incomplete.groupId, source: source.source, after: source.after, limit: 64, byteLimit: 128 * 1024 }); this.error = undefined; return; }
      const checkpoint = status.checkpoint!;
      const request = { groupId: incomplete.groupId, through: checkpoint.through, after: checkpoint.after, limit: 8, byteLimit: 128 * 1024 };
      const page = await this.port.bindingsPage(request);
      const observations: BaselineObservation[] = [];
      for (const binding of page.bindings) observations.push(await this.callbacks.observeBaseline(binding, { groupId: incomplete.groupId, through: checkpoint.through, after: checkpoint.after }));
      const inspected = await this.groups.find(group => group.groupId === incomplete.groupId)!.controller.inspect('baseline-' + randomUUID(), { generation: incomplete.controller.generation, epoch: incomplete.controller.epoch });
      if (inspected.status !== 'known' || !sameController(incomplete.controller, inspected.state)) throw new StoreError('execution_controller_unknown', 503);
      if (!await this.port.commitBaselineBatch({ ...request, expectedRevision: incomplete.revision, observations, proof: proof([page, observations, inspected.state]) })) throw new StoreError('execution_state_changed', 409);
      this.error = undefined; return;
    }
    this.initialized = true;
    if (Date.now() >= this.saveRecoveryAt) {
      this.saveRecoveryAt = Date.now() + 1000;
      await this.callbacks.recoverSaves?.();
    }
    const newId = this.newWorkspaces.values().next().value;
    if (newId) {
      const registration = await this.workspaces.get(newId);
      let complete = true;
      for (const group of registration ? this.configured(registration) : []) {
        if (!(await this.port.registerScope({ workspaceId: newId, groupId: group.groupId })).complete) { complete = false; break; }
      }
      if (complete) this.newWorkspaces.delete(newId); this.error = undefined; return;
    }
    const row = rows[this.groupCursor++ % rows.length]!;
    if (row.windowId) await this.callbacks.recoverSaves?.(row.windowId);
    if (row.windowId && row.windowGroups && row.phase !== 'editable') {
      if (row.phase === 'resuming' || row.stage === 'resume' || row.stage === 'opened') await this.coordinator.resume({ windowId: row.windowId, groupIds: row.windowGroups });
      else await this.coordinator.advance({ windowId: row.windowId, groupIds: row.windowGroups });
    } else if (row.phase === 'online') {
      const group = this.groups.find(group => group.groupId === row.groupId)!;
      if (group.controller.recover) {
        const checked = await this.checkHost(group, row);
        if (checked.status !== 'known') throw new StoreError(checked.reason === 'controller_unknown' ? 'execution_controller_unknown' : checked.reason, 503);
      }
      const page = await this.port.unresolvedPage({ groupId: row.groupId, after: this.pendingCursors.get(row.groupId), limit: 8 });
      for (const pending of page.entries) await this.callbacks.resolvePending(pending);
      if (page.nextCursor) this.pendingCursors.set(row.groupId, page.nextCursor); else this.pendingCursors.delete(row.groupId);
    }
    this.error = undefined;
  }
  async status(workspaceId: string): Promise<ManagedEditStatus> {
    const configured = await this.workspaces.get(workspaceId);
    const requested = configured ? this.configured(configured).map(group => group.groupId) : [];
    if (!requested.length) return { editable: false, reason: 'workspace_writes_unmanaged', canPause: false, maintenance: 'unknown', phase: 'unknown', affectedGroups: [], initialized: false };
    if (!this.initialized) {
      const rows = await this.port.load(requested).catch(() => []);
      const canRecover = rows.length === requested.length && rows.every(row => this.recoverable(row) && !!this.groups.find(group => group.groupId === row.groupId)?.controller.recover) && requested.some(groupId => this.hostChecks.get(groupId)?.result.status === 'unknown');
      return { editable: false, reason: this.error ?? 'execution_baseline_incomplete', canPause: false, maintenance: 'unknown', phase: 'initializing', affectedGroups: requested, initialized: false, canRecover };
    }
    const groupIds = await this.port.workspaceGroups(workspaceId);
    if (!groupIds.length) { await this.registerWorkspace(workspaceId); return { editable: false, reason: 'execution_scope_registration_pending', canPause: false, maintenance: 'transition', phase: 'initializing', affectedGroups: requested, initialized: false }; }
    const rows = await this.port.load(groupIds);
    const failed = rows.filter(row => this.recoverable(row)).map(row => this.hostChecks.get(row.groupId)?.result).find(result => result?.status === 'unknown');
    if (failed?.status === 'unknown') return { editable: false, canPause: false, reason: failed.reason === 'controller_unknown' ? 'execution_controller_unknown' : failed.reason,
      phase: 'unknown', maintenance: 'unknown', affectedGroups: groupIds, initialized: true, canRecover: rows.every(row => this.recoverable(row) && !!this.groups.find(group => group.groupId === row.groupId)?.controller.recover) };
    const phase = rows.some(row => row.phase === 'unknown') ? 'unknown' : rows.every(row => row.phase === 'online') ? 'online' : rows.every(row => row.phase === 'editable') ? 'editable' : rows.some(row => row.phase === 'resuming') ? 'resuming' : 'draining';
    const windowId = rows[0]?.windowId;
    const saving = !!windowId && await this.port.hasUnsettledSaves(windowId, groupIds);
    const concurrent = phase === 'online' && !windowId;
    const unresolved = concurrent && (await this.port.pendingConcurrentSaves({ workspaceId, limit: 1 })).entries.length > 0;
    return { editable: concurrent && !unresolved, canPause: false,
      reason: unresolved || saving ? 'execution_save_unresolved' : concurrent ? null : rows.find(row => row.error)?.error ?? 'execution_' + phase,
      phase, maintenance: phase === 'editable' ? 'paused' : phase === 'online' ? 'online' : phase === 'unknown' ? 'unknown' : 'transition',
      ...(windowId ? { windowId } : {}), affectedGroups: groupIds, initialized: true };

  }
  async change(workspaceId: string, action: 'pause' | 'resume') {
    const state = await this.status(workspaceId);
    if (action === 'resume' && !state.windowId && state.canRecover) {
      const rows = await this.port.load(state.affectedGroups);
      for (const row of rows) {
        if (!this.recoverable(row)) throw new StoreError('execution_admission_closed', 409);
        const result = await this.checkHost(this.groups.find(group => group.groupId === row.groupId)!, row, true);
        if (result.status !== 'known') throw new StoreError(result.reason === 'controller_unknown' ? 'execution_controller_unknown' : result.reason, 503);
      }
      this.error = undefined; this.schedule(0); return this.status(workspaceId);
    }
    if (!state.initialized) throw new StoreError(state.reason ?? 'execution_baseline_incomplete', 409);
    const target = { windowId: state.windowId ?? randomUUID(), groupIds: state.affectedGroups };
    if (action === 'pause') {
      if (state.phase === 'online') await this.coordinator.enterEdit(target);
      else await this.coordinator.advance(target);
    } else if (state.windowId) await this.coordinator.resume(target);
    return this.status(workspaceId);
  }
  async save<T>(workspaceId: string, saveId: string, write: SaveWriteIdentity, effect: (permit: SavePermit) => Promise<{ outcome: 'committed' | 'rejected'; proof: string; value: T }>, writerId?: string) {
    const state = await this.status(workspaceId);
    if (!state.editable || state.windowId) throw new StoreError(state.reason ?? 'execution_window_not_editable', 409);
    return this.coordinator.withSave<T>({ mode: 'concurrent', windowId: 'file-' + proof(workspaceId), groupIds: state.affectedGroups, saveId, write, writerId }, effect);
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; }
  async close() { this.stop(); await this.active; }
}

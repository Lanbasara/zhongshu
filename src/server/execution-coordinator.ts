/**
 * Durable edit-window protocol. This module neither contains processes nor
 * implements native dispatch. Its port MUST use single SQLite transactions for
 * the named admission/save transitions; every gateway entrance must use it.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { workspaceDocumentPath } from '../shared/content.ts';
import type { ExecutionController, ExecutionEpoch, ExecutionGroupState } from './execution-controller.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const epochSchema = z.object({ generation: id, epoch: sequence }).strict();
const controllerState = epochSchema.extend({ groupId: id, admission: z.enum(['open', 'drain', 'closed']), writers: z.enum(['running', 'quiescent']), durable: z.literal(true), frozenSetId: digest.optional() }).strict();
const stageSchema = z.enum(['fence', 'drain', 'quiesce', 'closed', 'resume', 'opened']);
const intentSchema = z.object({ action: z.enum(['fence', 'quiesce', 'resume']), requestId: id, expected: epochSchema, frozenSetId: digest.optional() }).strict();
export const executionCursorSchema = z.object({ sequence, id }).strict();
export type ExecutionCursor = z.infer<typeof executionCursorSchema>;
export const executionGateSchema = z.object({
  groupId: id, revision: sequence, baselineComplete: z.boolean(), controller: controllerState,
  phase: z.enum(['online', 'draining', 'editable', 'resuming', 'unknown']),
  windowId: id.optional(), windowGroups: z.array(id).min(1).max(32).optional(), frozenSetId: digest.optional(),
  stage: stageSchema.optional(), intent: intentSchema.optional(), pendingCursor: executionCursorSchema.optional(), error: id.optional(),
}).strict();
export type ExecutionGate = z.infer<typeof executionGateSchema>;
export type GroupRevision = { groupId: string; revision: number };
export type WindowRequest = { windowId: string; groupIds: string[] };
const windowSchema = z.object({ windowId: id, groupIds: z.array(id).min(1).max(32).refine(values => new Set(values).size === values.length) }).strict();
const workspacePendingSchema = z.object({
  id, sequence, groupId: id, bindingId: z.string().min(1).max(1024), workspaceId: id,
  directoryIdentity: z.string().min(1).max(200), kind: z.enum(['queued', 'receipt-unknown', 'running', 'waiting', 'native-associated']),
}).strict();
const hostPendingSchema = z.object({ id, sequence, groupId: id, kind: z.literal('host'), operationId: z.uuid(), harnessId: z.enum(['codex', 'dsh']) }).strict();
export type WorkspacePendingExecution = z.infer<typeof workspacePendingSchema>;
export type HostPendingExecution = z.infer<typeof hostPendingSchema>;
const pendingSchema = z.union([workspacePendingSchema, hostPendingSchema]);
export type PendingExecution = z.infer<typeof pendingSchema>;
const pendingPageSchema = z.object({ entries: z.array(pendingSchema).max(64), nextCursor: executionCursorSchema.nullable() }).strict();
export type PendingExecutionPage = z.infer<typeof pendingPageSchema>;
const writeIdentitySchema = z.object({ workspaceId: id, directoryIdentity: z.string().min(1).max(200), path: workspaceDocumentPath, expectedVersion: digest, contentDigest: digest }).strict();
export type SaveWriteIdentity = z.infer<typeof writeIdentitySchema>;
export type SavePermit = { saveId: string; windowId: string; write: SaveWriteIdentity; writerId?: string; groups: { groupId: string; controller: ExecutionEpoch }[] };
export type SaveAdmission = { created: true; permit: SavePermit } | { created: false; outcome: 'pending' | 'committed' | 'rejected' };

export interface ExecutionCoordinatorPort {
  /** Exact requested rows, no omitted group and no inferred clean/default row. */
  load(groupIds: string[]): Promise<ExecutionGate[]>;
  /** CAS only: persist next.revision = expectedRevision + 1, or return false. */
  save(groupId: string, expectedRevision: number, next: ExecutionGate): Promise<boolean>;
  /**
   * One transaction: verify all revisions, completed legacy baselines and online
   * phases; close NEW admissions for the complete conflict set; snapshot existing
   * admissions; persist per-group frozenSetId, shared windowGroups/windowId,
   * phase=draining, stage=fence. Retrying the same window returns its existing rows.
   * Never materialize every historical operation to construct this snapshot:
   * durable membership may use an admission watermark plus immutable identities.
   */
  freezeAdmissions(input: { windowId: string; groups: GroupRevision[] }): Promise<ExecutionGate[]>;
  /** Stable (sequence,id) keyset over only unresolved members of this frozen set. */
  pendingPage(input: { groupId: string; frozenSetId: string; after?: ExecutionCursor; limit: number; byteLimit: number }): Promise<PendingExecutionPage>;
  /** One transaction closes new saves in ALL groups; preserves in-flight saves. */
  beginResume(input: { windowId: string; groups: GroupRevision[] }): Promise<ExecutionGate[]>;
  hasUnsettledSaves(windowId: string, groupIds: string[]): Promise<boolean>;
  /** One transaction, only all-resumed/open matching epochs may reopen admission. */
  completeResume(input: { windowId: string; groups: GroupRevision[] }): Promise<ExecutionGate[]>;
  /**
   * One transaction validates all matching editable windows/revisions and claims
   * saveId exactly once, with immutable write identity for crash reconciliation.
   * Same ID with different content/window/scope is a conflict; a pending duplicate
   * must NEVER execute its effect again.
   */
  acquireSave(input: { saveId: string; windowId: string; write: SaveWriteIdentity; writerId?: string; groups: GroupRevision[] }): Promise<SaveAdmission>;
  /** Persist verified outcome/proof; unknown effects retain their permit forever. */
  settleSave(saveId: string, outcome: 'committed' | 'rejected', proof: string): Promise<boolean>;
}

/** Storage/migration integration uses the same stable-key, bounded-batch contract. */
export interface ExecutionBaselinePort {
  bindingsPage(input: { groupId: string; through: number; after?: ExecutionCursor; limit: number; byteLimit: number }): Promise<{
    bindings: BaselineBinding[];
    nextCursor: ExecutionCursor | null;
    endCursor: ExecutionCursor | null;
  }>;
  /**
   * Transactionally persist associations/proofs before advancing migration cursor.
   * New admissions remain closed. complete=true is valid only after every binding
   * through the fixed watermark and all associated native work were reconciled.
   */
  commitBaselineBatch(input: { groupId: string; expectedRevision: number; through: number; after?: ExecutionCursor;
    limit: number; byteLimit: number; observations: BaselineObservation[]; proof: string }): Promise<boolean>;
}
export type BaselineBinding = { id: string; sequence: number; workspaceId: string; directoryIdentity: string; bindingId: string | null };
/** These are fresh, trusted native observations, never the cached conversation state. */
export type BaselineObservation = BaselineBinding & { state: 'idle' | 'running' | 'waiting' | 'absent'; proof: string };

export type ResolvePending = (operation: PendingExecution, permission: {
  windowId: string; groups: { groupId: string; controller: ExecutionEpoch; frozenSetId: string }[];
}) => Promise<'settled' | 'pending' | 'unknown'>;
// resolvePending must durably claim original operation IDs and reconcile unknown
// receipts, never blindly replay submit. Gateway membership/epoch checks remain
// mandatory for queued, early, wake, automatic and external-client entrances.
export type ExecutionWindow = { phase: ExecutionGate['phase']; groups: ExecutionGate[]; reason?: string };
export class ExecutionCoordinatorError extends Error {
  readonly code: string; readonly statusCode: number;
  constructor(code: string, statusCode = 409) { super(code); this.name = 'ExecutionCoordinatorError'; this.code = code; this.statusCode = statusCode; }
}
const epochOf = (state: ExecutionGroupState): ExecutionEpoch => ({ generation: state.generation, epoch: state.epoch });
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class ExecutionCoordinator {
  private readonly port: ExecutionCoordinatorPort;
  private readonly controllers: ReadonlyMap<string, ExecutionController>;
  private readonly resolvePending: ResolvePending;
  private readonly locks = new Map<string, Promise<unknown>>();
  private actions = 0;
  constructor(port: ExecutionCoordinatorPort, controllers: ReadonlyMap<string, ExecutionController>, resolvePending: ResolvePending) {
    this.port = port; this.controllers = controllers; this.resolvePending = resolvePending;
  }
  private target(input: WindowRequest) { const parsed = windowSchema.parse(input); parsed.groupIds.sort(); return parsed; }
  private async lock<T>(groupIds: string[], action: () => Promise<T>): Promise<T> {
    if (this.actions >= 32) throw new ExecutionCoordinatorError('execution_coordinator_busy', 429);
    this.actions++;
    const previous = groupIds.map(groupId => this.locks.get(groupId)).filter(value => value !== undefined);
    const task = Promise.allSettled(previous).then(action);
    for (const groupId of groupIds) this.locks.set(groupId, task);
    try { return await task; }
    finally { this.actions--; for (const groupId of groupIds) if (this.locks.get(groupId) === task) this.locks.delete(groupId); }
  }
  private async load(groupIds: string[]) {
    const rows = z.array(executionGateSchema).max(32).parse(await this.port.load(groupIds)).sort((a, b) => a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0);
    if (rows.length !== groupIds.length || rows.some((row, index) => row.groupId !== groupIds[index] || row.controller.groupId !== row.groupId)) throw new ExecutionCoordinatorError('execution_group_missing');
    for (const row of rows) {
      const state = row.controller;
      if (state.writers !== (state.admission === 'closed' ? 'quiescent' : 'running') || state.admission === 'open' && state.frozenSetId !== undefined)
        throw new ExecutionCoordinatorError('execution_gate_invalid');
      const required = row.stage === 'fence' || row.stage === 'opened' ? 'open' : row.stage === 'drain' || row.stage === 'quiesce' ? 'drain' : row.stage === 'closed' || row.stage === 'resume' ? 'closed' : undefined;
      if (required && (state.admission !== required || required !== 'open' && (!row.frozenSetId || state.frozenSetId !== row.frozenSetId))) throw new ExecutionCoordinatorError('execution_gate_invalid');
      if (row.phase === 'editable' && (row.stage !== 'closed' || state.admission !== 'closed') ||
        row.phase === 'online' && (state.admission !== 'open' || row.stage || row.windowId || row.frozenSetId || row.intent)) throw new ExecutionCoordinatorError('execution_gate_invalid');
    }
    return rows;
  }
  private requireWindow(rows: ExecutionGate[], target: WindowRequest) {
    for (const row of rows) {
      if (!row.baselineComplete) throw new ExecutionCoordinatorError('execution_baseline_incomplete');
      if (row.windowId !== target.windowId || JSON.stringify(row.windowGroups) !== JSON.stringify(target.groupIds) || !row.frozenSetId || !row.stage)
        throw new ExecutionCoordinatorError('execution_window_changed');
    }
  }
  private view(rows: ExecutionGate[]): ExecutionWindow {
    const phase = rows.some(row => row.phase === 'unknown') ? 'unknown' : rows.every(row => row.phase === 'online') ? 'online'
      : rows.every(row => row.phase === 'editable') ? 'editable' : rows.some(row => row.phase === 'resuming') ? 'resuming' : 'draining';
    const reason = rows.find(row => row.error)?.error;
    return { phase, groups: rows, ...(reason ? { reason } : {}) };
  }
  private async update(row: ExecutionGate, change: Partial<ExecutionGate>) {
    const next = executionGateSchema.parse({ ...row, ...change, revision: row.revision + 1 });
    if (!await this.port.save(row.groupId, row.revision, next)) throw new ExecutionCoordinatorError('execution_state_changed');
    return next;
  }
  private controller(row: ExecutionGate) {
    const controller = this.controllers.get(row.groupId);
    if (!controller) throw new ExecutionCoordinatorError('execution_controller_unavailable', 503);
    return controller;
  }
  private async verify(row: ExecutionGate) {
    let result;
    try { result = await this.controller(row).inspect('verify-' + fingerprint([row.groupId, row.windowId, row.controller]), epochOf(row.controller)); }
    catch { return this.update(row, { phase: 'unknown', error: 'execution_controller_unknown' }); }
    const state = result.status === 'known' ? controllerState.safeParse(result.state).data : undefined;
    if (!state || JSON.stringify(state) !== JSON.stringify(controllerState.parse(row.controller)))
      return this.update(row, { phase: 'unknown', error: 'execution_controller_unknown' });
    return row.phase === 'unknown' ? this.update(row, { phase: row.stage === 'resume' || row.stage === 'opened' ? 'resuming' : 'draining', error: undefined }) : row;
  }
  private async mutation(row: ExecutionGate, action: 'fence' | 'quiesce' | 'resume') {
    if (!row.intent) {
      const intent = { action, requestId: 'change-' + fingerprint([row.windowId, row.groupId, action, row.controller.generation, row.controller.epoch, row.frozenSetId]),
        expected: epochOf(row.controller), ...(action !== 'resume' ? { frozenSetId: row.frozenSetId } : {}) };
      row = await this.update(row, { intent, error: undefined });
    }
    const intent = row.intent!;
    if (intent.action !== action || intent.expected.generation !== row.controller.generation || intent.expected.epoch !== row.controller.epoch ||
      intent.frozenSetId !== (action === 'resume' ? undefined : row.frozenSetId)) throw new ExecutionCoordinatorError('execution_intent_mismatch');
    let result;
    try {
      const controller = this.controller(row);
      result = action === 'resume' ? await controller.resume({ requestId: intent.requestId, expected: intent.expected })
        : await controller[action]({ requestId: intent.requestId, expected: intent.expected, frozenSetId: intent.frozenSetId });
    } catch { return this.update(row, { phase: 'unknown', error: 'execution_controller_unknown' }); }
    const state = result.status === 'known' ? controllerState.safeParse(result.state).data : undefined;
    const admission = action === 'fence' ? 'drain' : action === 'quiesce' ? 'closed' : 'open';
    if (!state || state.groupId !== row.groupId || state.generation !== intent.expected.generation || state.epoch !== intent.expected.epoch + 1 || state.admission !== admission ||
      state.writers !== (action === 'quiesce' ? 'quiescent' : 'running') || state.frozenSetId !== (action === 'resume' ? undefined : row.frozenSetId))
      return this.update(row, { phase: 'unknown', error: 'execution_controller_unknown' });
    return this.update(row, { controller: state, phase: action === 'resume' ? 'resuming' : 'draining', stage: action === 'fence' ? 'drain' : action === 'quiesce' ? 'closed' : 'opened', intent: undefined, error: undefined });
  }
  async enterEdit(input: WindowRequest): Promise<ExecutionWindow> {
    const target = this.target(input);
    return this.lock(target.groupIds, async () => {
      let rows = await this.load(target.groupIds);
      if (rows.some(row => !row.baselineComplete)) throw new ExecutionCoordinatorError('execution_baseline_incomplete');
      if (rows.every(row => row.phase === 'online')) {
        await this.port.freezeAdmissions({ windowId: target.windowId, groups: rows.map(({ groupId, revision }) => ({ groupId, revision })) });
        rows = await this.load(target.groupIds);
      }
      this.requireWindow(rows, target);
      return this.advanceWindow(target);
    });
  }
  async advance(input: WindowRequest): Promise<ExecutionWindow> {
    const target = this.target(input);
    return this.lock(target.groupIds, () => this.advanceWindow(target));
  }
  private async advanceWindow(target: WindowRequest): Promise<ExecutionWindow> {
    let rows = await this.load(target.groupIds); this.requireWindow(rows, target);
    if (rows.some(row => row.phase === 'resuming' || row.stage === 'resume' || row.stage === 'opened')) return this.resumeWindow(target, rows);
    // Fence ALL conflicting groups before allowing any admitted work to drain.
    for (let index = 0; index < rows.length; index++) {
      let row = rows[index]!;
      if (row.stage === 'fence') row = await this.mutation(row, 'fence');
      else if (row.phase === 'unknown' && row.intent?.action === 'quiesce') row = await this.mutation(row, 'quiesce');
      else if (row.phase === 'unknown' && !row.intent) row = await this.verify(row);
      rows[index] = row;
      if (row.phase === 'unknown') return this.view(rows);
    }
    const permission = { windowId: target.windowId, groups: rows.map(row => ({ groupId: row.groupId, controller: epochOf(row.controller), frozenSetId: row.frozenSetId! })) };
    let unresolved = false;
    for (let index = 0; index < rows.length; index++) {
      let row = rows[index]!;
      if (row.stage !== 'drain') continue;
      const page = pendingPageSchema.parse(await this.port.pendingPage({ groupId: row.groupId, frozenSetId: row.frozenSetId!, after: row.pendingCursor, limit: 64, byteLimit: 128 * 1024 }));
      if (Buffer.byteLength(JSON.stringify(page)) > 128 * 1024 || page.entries.some(entry => entry.groupId !== row.groupId)) throw new ExecutionCoordinatorError('execution_pending_page_invalid');
      let preceding = row.pendingCursor;
      for (const entry of page.entries) {
        if (preceding && (entry.sequence < preceding.sequence || entry.sequence === preceding.sequence && entry.id <= preceding.id)) throw new ExecutionCoordinatorError('execution_pending_cursor_invalid');
        preceding = entry;
      }
      if (page.nextCursor && (!page.entries.length || !preceding || page.nextCursor.sequence !== preceding.sequence || page.nextCursor.id !== preceding.id)) throw new ExecutionCoordinatorError('execution_pending_cursor_invalid');
      let pendingUnknown = false;
      for (const operation of page.entries) {
        let outcome;
        try { outcome = await this.resolvePending(operation, permission); } catch { outcome = 'unknown' as const; }
        // A native receipt can be unknown while the controller's admission
        // fence remains proven. Preserve that operation, but let other members
        // of the already frozen set drain. Their gateway still checks the exact
        // epoch and once-only ledger. Unknown work never authorizes quiescence.
        if (outcome !== 'settled' && outcome !== 'pending') { pendingUnknown = true; unresolved = true; }
      }
      row = await this.update(row, { pendingCursor: page.nextCursor ?? undefined, error: pendingUnknown ? 'execution_pending_unknown' : undefined }); rows[index] = row;
      const remaining = pendingPageSchema.parse(await this.port.pendingPage({ groupId: row.groupId, frozenSetId: row.frozenSetId!, limit: 1, byteLimit: 128 * 1024 }));
      if (remaining.entries.length || remaining.nextCursor) unresolved = true;
    }
    if (unresolved) return this.view(rows);
    // Do not quiesce one group while an operation spanning another group drains.
    for (let index = 0; index < rows.length; index++) {
      let row = rows[index]!;
      if (row.stage === 'drain') row = await this.update(row, { stage: 'quiesce' });
      if (row.stage === 'quiesce') row = await this.mutation(row, 'quiesce');
      rows[index] = row;
      if (row.phase === 'unknown') return this.view(rows);
    }
    for (let index = 0; index < rows.length; index++) {
      let row = rows[index]!;
      if (row.stage !== 'closed') throw new ExecutionCoordinatorError('execution_window_not_closed');
      row = await this.verify(row); rows[index] = row;
      if (row.phase === 'unknown') return this.view(rows);
      if (row.phase !== 'editable') rows[index] = await this.update(row, { phase: 'editable', error: undefined });
    }
    return this.view(rows);
  }
  async resume(input: WindowRequest): Promise<ExecutionWindow> {
    const target = this.target(input);
    return this.lock(target.groupIds, async () => {
      let rows = await this.load(target.groupIds); this.requireWindow(rows, target);
      if (rows.every(row => row.phase === 'editable')) {
        await this.port.beginResume({ windowId: target.windowId, groups: rows.map(({ groupId, revision }) => ({ groupId, revision })) });
        rows = await this.load(target.groupIds);
      }
      if (rows.some(row => row.phase !== 'resuming' && !(row.phase === 'unknown' && (row.stage === 'resume' || row.stage === 'opened')))) throw new ExecutionCoordinatorError('execution_window_not_editable');
      return this.resumeWindow(target, rows);
    });
  }
  private async resumeWindow(target: WindowRequest, rows: ExecutionGate[]) {
    if (await this.port.hasUnsettledSaves(target.windowId, target.groupIds)) return { ...this.view(rows), reason: 'execution_save_unresolved' };
    for (let index = 0; index < rows.length; index++) {
      let row = rows[index]!;
      if (row.stage !== 'opened') row = await this.mutation(row, 'resume');
      if (row.stage === 'opened') row = await this.verify(row);
      rows[index] = row;
      if (row.phase === 'unknown') return this.view(rows);
    }
    await this.port.completeResume({ windowId: target.windowId, groups: rows.map(({ groupId, revision }) => ({ groupId, revision })) });
    return this.view(await this.load(target.groupIds));
  }
  async withSave<T>(input: WindowRequest & { saveId: string; write: SaveWriteIdentity; writerId?: string }, effect: (permit: SavePermit) => Promise<{ outcome: 'committed' | 'rejected'; proof: string; value: T }>): Promise<
    { status: 'committed' | 'rejected'; value: T } | { status: 'unknown'; saveId: string } | { status: 'duplicate'; outcome: 'pending' | 'committed' | 'rejected' }
  > {
    const target = this.target({ windowId: input.windowId, groupIds: input.groupIds }); const saveId = id.parse(input.saveId);
    const write = writeIdentitySchema.parse(input.write);
    return this.lock(target.groupIds, async () => {
      const rows = await this.load(target.groupIds); this.requireWindow(rows, target);
      for (let index = 0; index < rows.length; index++) {
        if (rows[index]!.phase !== 'editable') throw new ExecutionCoordinatorError('execution_window_not_editable');
        rows[index] = await this.verify(rows[index]!);
        if (rows[index]!.phase === 'unknown') throw new ExecutionCoordinatorError('execution_controller_unknown');
      }
      const admission = await this.port.acquireSave({ saveId, windowId: target.windowId, write, writerId: input.writerId, groups: rows.map(({ groupId, revision }) => ({ groupId, revision })) });
      if (!admission.created) return { status: 'duplicate', outcome: admission.outcome };
      const permit = z.object({ saveId: id, windowId: id, writerId: id.optional(), write: writeIdentitySchema, groups: z.array(z.object({ groupId: id, controller: epochSchema }).strict()).min(1).max(32) }).strict().parse(admission.permit);
      if (permit.saveId !== saveId || permit.windowId !== target.windowId || permit.writerId !== input.writerId || fingerprint(permit.write) !== fingerprint(write) || permit.groups.length !== rows.length ||
        permit.groups.some((group, index) => group.groupId !== rows[index]!.groupId || group.controller.generation !== rows[index]!.controller.generation || group.controller.epoch !== rows[index]!.controller.epoch)) throw new ExecutionCoordinatorError('execution_save_permit_invalid');
      try {
        const result = await effect(permit);
        z.enum(['committed', 'rejected']).parse(result.outcome);
        digest.parse(result.proof);
        if (!await this.port.settleSave(saveId, result.outcome, result.proof)) return { status: 'unknown', saveId };
        return { status: result.outcome, value: result.value };
      } catch { return { status: 'unknown', saveId }; }
    });
  }
}

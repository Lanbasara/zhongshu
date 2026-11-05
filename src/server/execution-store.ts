import { createHash } from 'node:crypto';
import { isAbsolute, normalize, sep } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { messagePayload } from '../shared/workbench.ts';
import { workspaceDocumentPath } from '../shared/content.ts';
import { StoreError } from './workbench-store.ts';
import { executionCursorSchema, executionGateSchema } from './execution-coordinator.ts';
import type { ExecutionCoordinatorPort, ExecutionGate, GroupRevision, PendingExecution, SaveAdmission, SavePermit, SaveWriteIdentity, ExecutionCursor, BaselineBinding, BaselineObservation } from './execution-coordinator.ts';
import type { ExecutionGroupState } from './execution-controller.ts';
import { createExecutionHostRepository } from './execution-host-store.ts';
export type { HostAdmission, HostPluginPermit } from './execution-host-store.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const natural = z.number().int().nonnegative().safe();
const idsSchema = z.array(id).min(1).max(32).refine(values => new Set(values).size === values.length);
const revisionsSchema = z.array(z.object({ groupId: id, revision: natural }).strict()).min(1).max(32).refine(values => new Set(values.map(value => value.groupId)).size === values.length);
const writeSchema = z.object({ workspaceId: id, directoryIdentity: z.string().min(1).max(200), path: workspaceDocumentPath, expectedVersion: digestSchema, contentDigest: digestSchema }).strict();
const pageSchema = z.object({ groupId: id, through: natural, after: executionCursorSchema.optional(), limit: z.number().int().min(1).max(64), byteLimit: z.number().int().min(4096).max(128 * 1024) }).strict();
const bindingSchema = z.object({ id: z.uuid(), sequence: natural, workspaceId: id, directoryIdentity: z.string().min(1).max(200), bindingId: z.string().min(1).max(1024).nullable() }).strict();
const observationSchema = bindingSchema.extend({ state: z.enum(['idle', 'running', 'waiting', 'absent']), proof: digestSchema });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code: string, status = 409): never => { throw new StoreError(code, status); };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
type Row = Record<string, SQLInputValue>;
type Admission = {
  id: string; sequence: number; source: 'operation' | 'queue' | 'native'; sourceKey: string;
  conversationId: string | null; queueId: string | null; workspaceId: string; directoryIdentity: string; bindingId: string;
  contentDigest: string; kind: Exclude<PendingExecution['kind'], 'host'> | 'settled'; currentOperation: string | null; terminalProof: string | null;
};
export type DispatchPermit = { admissionId: string; operationId: string; contentDigest: string;
  groups: { groupId: string; generation: string; epoch: number; frozenSetId?: string }[] };
export type NativePermit = { admissionId: string; requestId: string; contentDigest: string; groups: DispatchPermit['groups'] };
export type StopPermit = { operationId: string; contentDigest: string; groups: DispatchPermit['groups']; purpose: 'stop' };
export type AssociatedPermit = { admissionId: string; operationId: string; requestId: string; contentDigest: string; groups: DispatchPermit['groups']; purpose: 'wake' };
export type ObservationPermit = { admissionId: string; requestId: string; contentDigest: string; groups: DispatchPermit['groups']; purpose: 'observe' };
type ConversationScope = { id: string; workspaceId: string; directoryIdentity: string; bindingId: string; groupIds: string[] };

function transaction<T>(db: DatabaseSync, action: () => T, read = false): T {
  if (db.isTransaction) return fail('execution_nested_transaction');
  db.exec(read ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try { const value = action(); db.exec('COMMIT'); return value; }
  catch (error) { try { db.exec('ROLLBACK'); } catch { /* Preserve unknown commit outcome. */ } throw error; }
}
function inTransaction(db: DatabaseSync) { if (!db.isTransaction) fail('execution_transaction_required'); }
function gate(db: DatabaseSync, groupId: string): ExecutionGate {
  const row = db.prepare('SELECT revision,gate_json FROM execution_groups WHERE id=?').get(id.parse(groupId));
  if (!row) return fail('execution_group_missing');
  const value = executionGateSchema.parse(JSON.parse(String(row.gate_json)));
  if (value.groupId !== groupId || value.revision !== row.revision) return fail('execution_gate_invalid');
  return value;
}
function putGate(db: DatabaseSync, value: ExecutionGate): void {
  const parsed = executionGateSchema.parse(value);
  db.prepare('UPDATE execution_groups SET revision=?,gate_json=? WHERE id=?').run(parsed.revision, JSON.stringify(parsed), parsed.groupId);
}
function checked(db: DatabaseSync, groups: GroupRevision[]): ExecutionGate[] {
  const parsed = revisionsSchema.parse(groups).sort((a, b) => compare(a.groupId, b.groupId));
  return parsed.map(({ groupId, revision }) => { const row = gate(db, groupId); if (row.revision !== revision) fail('execution_state_changed'); return row; });
}
function closure(db: DatabaseSync, seeds: string[]): string[] {
  const all = new Set(idsSchema.parse(seeds)); const queue = [...all];
  for (let index = 0; index < queue.length; index++) {
    gate(db, queue[index]!);
    for (const row of db.prepare('SELECT right_group FROM execution_conflicts WHERE left_group=? ORDER BY right_group LIMIT 33').all(queue[index]!)) {
      const next = String(row.right_group); if (all.has(next)) continue;
      all.add(next); queue.push(next); if (all.size > 32) fail('execution_conflict_scope_too_large');
    }
  }
  return [...all].sort(compare);
}
function workspaceGroups(db: DatabaseSync, workspaceId: string): string[] {
  const rows = db.prepare('SELECT group_id FROM execution_scopes WHERE workspace_id=? ORDER BY group_id LIMIT 33').all(workspaceId);
  if (rows.length > 32) return fail('execution_conflict_scope_too_large');
  return rows.length ? closure(db, rows.map(row => String(row.group_id))) : [];
}
function scope(db: DatabaseSync, conversationId: string, creating = false, allowRemoved = false): ConversationScope {
  const row = db.prepare(`SELECT c.id,c.workspace_id,c.cwd,json_extract(c.binding_json,'$.id') AS binding_id,
    w.directory,w.identity,w.removed FROM workbench_conversations c LEFT JOIN workbench_workspaces w ON w.id=c.workspace_id WHERE c.id=?`).get(z.uuid().parse(conversationId));
  if (!row) return fail('conversation_not_found', 404);
  if (db.prepare('SELECT id FROM execution_scope_registration WHERE workspace_id=?').get(String(row.workspace_id))) return fail('execution_scope_registration_pending');
  const groupIds = workspaceGroups(db, String(row.workspace_id));
  if (!groupIds.length) return { id: conversationId, workspaceId: String(row.workspace_id), directoryIdentity: '', bindingId: '', groupIds };
  if ((!row.binding_id && !creating) || row.cwd !== row.directory || row.removed !== 0 && !allowRemoved) return fail('execution_binding_unverified');
  for (const mapped of db.prepare('SELECT directory,directory_identity FROM execution_scopes WHERE workspace_id=? LIMIT 33').all(String(row.workspace_id))) {
    if (mapped.directory !== row.directory || mapped.directory_identity !== row.identity) fail('execution_directory_changed');
  }
  return { id: conversationId, workspaceId: String(row.workspace_id), directoryIdentity: String(row.identity), bindingId: row.binding_id ? String(row.binding_id) : 'create:' + conversationId, groupIds };
}
function admissionFromRow(row: Row): Admission {
  return { id: String(row.id), sequence: Number(row.sequence), source: row.source as Admission['source'], sourceKey: String(row.source_key),
    conversationId: row.conversation_id === null ? null : String(row.conversation_id), queueId: row.queue_id === null ? null : String(row.queue_id),
    workspaceId: String(row.workspace_id), directoryIdentity: String(row.directory_identity), bindingId: String(row.binding_id), contentDigest: String(row.content_digest),
    kind: row.kind as Admission['kind'], currentOperation: row.current_operation === null ? null : String(row.current_operation), terminalProof: row.terminal_proof === null ? null : String(row.terminal_proof) };
}
function admission(db: DatabaseSync, admissionId: string): Admission | undefined {
  const row = db.prepare('SELECT * FROM execution_admissions WHERE id=?').get(id.parse(admissionId)); return row ? admissionFromRow(row) : undefined;
}
function members(db: DatabaseSync, admissionId: string) {
  return db.prepare('SELECT group_id FROM execution_members WHERE admission_id=? ORDER BY group_id LIMIT 33').all(admissionId).map(row => String(row.group_id));
}
function assertAdmission(db: DatabaseSync, groups: string[], baseline = false) {
  for (const groupId of groups) {
    const row = gate(db, groupId);
    if (baseline ? row.windowId || row.intent || row.controller.admission !== 'open' || row.baselineComplete && row.phase !== 'online' : !row.baselineComplete || row.phase !== 'online' || row.controller.admission !== 'open') fail('execution_admission_closed');
  }
}
function insertAdmission(db: DatabaseSync, value: Omit<Admission, 'sequence' | 'terminalProof'>, groups: string[], baseline = false): Admission {
  const old = admission(db, value.id);
  if (old) {
    if (old.source !== value.source || old.sourceKey !== value.sourceKey || old.workspaceId !== value.workspaceId || old.bindingId !== value.bindingId || old.directoryIdentity !== value.directoryIdentity || old.contentDigest !== value.contentDigest)
      return fail('execution_admission_conflict');
    const existing = members(db, value.id);
    if (JSON.stringify(existing) !== JSON.stringify(groups)) {
      if (!baseline || existing.some(group => !groups.includes(group))) return fail('execution_admission_scope_changed');
      assertAdmission(db, groups, true);
      for (const groupId of groups.filter(group => !existing.includes(group))) {
        db.prepare('INSERT INTO execution_members(admission_id,group_id) VALUES(?,?)').run(value.id, groupId);
        if (old.kind !== 'settled') db.prepare('INSERT INTO execution_pending(group_id,sequence,admission_id) VALUES(?,?,?)').run(groupId, old.sequence, old.id);
      }
    }
    return old;
  }
  assertAdmission(db, groups, baseline);
  const result = db.prepare(`INSERT INTO execution_admissions(id,source,source_key,conversation_id,queue_id,workspace_id,directory_identity,binding_id,content_digest,kind,current_operation)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(value.id, value.source, value.sourceKey, value.conversationId, value.queueId, value.workspaceId, value.directoryIdentity, value.bindingId, value.contentDigest, value.kind, value.currentOperation);
  const sequence = Number(result.lastInsertRowid);
  for (const groupId of groups) {
    db.prepare('INSERT INTO execution_members(admission_id,group_id) VALUES(?,?)').run(value.id, groupId);
    db.prepare('INSERT INTO execution_pending(group_id,sequence,admission_id) VALUES(?,?,?)').run(groupId, sequence, value.id);
  }
  return admission(db, value.id)!;
}
function permission(db: DatabaseSync, value: Admission, operationId: string): DispatchPermit {
  if (value.kind === 'settled') return fail('execution_already_settled');
  const groups = members(db, value.id);
  if (!groups.length || groups.length > 32) return fail('execution_admission_unregistered');
  const tokens: DispatchPermit['groups'] = [];
  for (const groupId of groups) {
    const row = gate(db, groupId);
    if (!row.baselineComplete) fail('execution_baseline_incomplete');
    if (row.phase === 'online' && row.controller.admission === 'open') tokens.push({ groupId, generation: row.controller.generation, epoch: row.controller.epoch });
    else if (row.phase === 'draining' && row.stage === 'drain' && row.controller.admission === 'drain' && row.frozenSetId && row.controller.frozenSetId === row.frozenSetId) {
      const freeze = db.prepare('SELECT through_sequence FROM execution_freezes WHERE group_id=? AND frozen_set_id=? AND window_id=?').get(groupId, row.frozenSetId, row.windowId!);
      if (!freeze || value.sequence > Number(freeze.through_sequence)) fail('execution_not_in_frozen_set');
      tokens.push({ groupId, generation: row.controller.generation, epoch: row.controller.epoch, frozenSetId: row.frozenSetId });
    } else fail('execution_dispatch_closed');
  }
  return { admissionId: value.id, operationId, contentDigest: value.contentDigest, groups: tokens };
}
function observationPermission(db: DatabaseSync, current: Admission, requestId: string, wireDigest: string): ObservationPermit {
  const permit = permission(db, current, current.currentOperation ?? current.id);
  const old = db.prepare('SELECT admission_id,wire_digest FROM execution_observation_requests WHERE request_id=?').get(requestId);
  if (old && (old.admission_id !== current.id || old.wire_digest !== wireDigest)) return fail('execution_native_request_conflict');
  db.prepare('INSERT OR IGNORE INTO execution_observation_requests(request_id,admission_id,wire_digest) VALUES(?,?,?)').run(requestId, current.id, wireDigest);
  return { admissionId: current.id, requestId, contentDigest: wireDigest, groups: permit.groups, purpose: 'observe' };
}
function terminal(db: DatabaseSync, value: Admission, proof: string) {
  digestSchema.parse(proof);
  if (value.kind === 'settled') { if (value.terminalProof !== proof) fail('execution_terminal_conflict'); return; }
  db.prepare("UPDATE execution_admissions SET kind='settled',terminal_proof=? WHERE id=?").run(proof, value.id);
  db.prepare('DELETE FROM execution_pending WHERE admission_id=?').run(value.id);
}

function baseline(db: DatabaseSync, groupId: string) {
  const row = db.prepare('SELECT * FROM execution_baselines WHERE group_id=?').get(groupId);
  if (!row) return fail('execution_baseline_missing');
  return { through: Number(row.through_sequence), after: row.after_sequence === null ? undefined : { sequence: Number(row.after_sequence), id: String(row.after_id) }, complete: row.complete === 1 };
}
function bindingPage(db: DatabaseSync, value: z.infer<typeof pageSchema>) {
  const checkpoint = baseline(db, value.groupId);
  if (checkpoint.complete || checkpoint.through !== value.through || JSON.stringify(checkpoint.after) !== JSON.stringify(value.after)) return fail('execution_baseline_changed');
  if (db.prepare('SELECT source FROM execution_baseline_sources WHERE group_id=? AND complete=0 LIMIT 1').get(value.groupId)) return fail('execution_baseline_sources_incomplete');
  // Bound the RAW global metadata page before filtering, so unrelated workspaces
  // never cause an unbounded scan in one command. Null bindings require proof too.
  const rows = db.prepare(`SELECT id,created_at,workspace_id,json_extract(binding_json,'$.id') binding_id
    FROM workbench_conversations WHERE created_at<=? AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT ?`)
    .all(value.through, value.after?.sequence ?? -1, value.after?.id ?? '', value.limit + 1);
  const bindings: BaselineBinding[] = []; let consumed = 0; let bytes = 512; let endCursor = value.after ?? null;
  for (const row of rows.slice(0, value.limit)) {
    if (workspaceGroups(db, String(row.workspace_id)).includes(value.groupId)) {
      const current = scope(db, String(row.id), true, true);
      const item = bindingSchema.parse({ id: String(row.id), sequence: Number(row.created_at), workspaceId: current.workspaceId,
        directoryIdentity: current.directoryIdentity, bindingId: row.binding_id === null ? null : current.bindingId });
      const size = Buffer.byteLength(JSON.stringify(item)); if (size + bytes > value.byteLimit) break;
      bindings.push(item); bytes += size;
    }
    consumed++; endCursor = { sequence: Number(row.created_at), id: String(row.id) };
  }
  if (rows.length && !consumed) return fail('execution_baseline_entry_budget', 413);
  return { bindings, endCursor, nextCursor: rows.length > consumed ? endCursor : null };
}

/** These hooks MUST run before COMMIT of the existing business mutation. */
export function createExecutionAdmissionHooks(db: DatabaseSync) {
  function admitQueue(entryId: string, baseline = false): Admission | null {
    inTransaction(db); z.uuid().parse(entryId);
    const row = db.prepare('SELECT * FROM workbench_queue_entries WHERE id=?').get(entryId);
    if (!row || row.content_json === null) return null;
    const source = scope(db, String(row.conversation_id), false, baseline); if (!source.groupIds.length) return null;
    const contentDigest = hash(messagePayload.parse(JSON.parse(String(row.content_json))));
    return insertAdmission(db, { id: 'q:' + entryId, source: 'queue', sourceKey: entryId, conversationId: source.id, queueId: entryId,
      workspaceId: source.workspaceId, directoryIdentity: source.directoryIdentity, bindingId: source.bindingId, contentDigest,
      kind: 'queued', currentOperation: null }, source.groupIds, baseline);
  }
  function admitOperation(operationId: string, queueEntryId?: string, baseline = false): Admission | null {
    inTransaction(db); z.uuid().parse(operationId);
    const row = db.prepare('SELECT * FROM workbench_operations WHERE id=?').get(operationId);
    if (!row) return fail('operation_not_found', 404);
    if (row.type === 'stop') return null; // Stopping never removes the original pending admission.
    const source = scope(db, String(row.conversation_id), false, baseline); if (!source.groupIds.length) return null;
    const payload = JSON.parse(String(row.payload_json));
    const queued = payload.queueRecord === true;
    const entryId = queueEntryId ?? (queued ? z.uuid().parse(payload.queuedInput?.entryId) : undefined);
    const contentDigest = hash(messagePayload.parse(queued ? payload.content : payload));
    let value: Admission;
    if (entryId) {
      const current = admission(db, 'q:' + entryId) ?? admitQueue(entryId, baseline);
      if (!current || current.conversationId !== source.id || current.contentDigest !== contentDigest || current.kind === 'settled') return fail('execution_queue_admission_missing');
      if (!baseline) permission(db, current, operationId);
      if (current.currentOperation && current.currentOperation !== operationId) {
        const previous = db.prepare('SELECT status FROM execution_attempts WHERE operation_id=?').get(current.currentOperation);
        if (previous?.status !== 'rejected') return fail('execution_operation_unresolved');
      }
      db.prepare('UPDATE execution_admissions SET current_operation=? WHERE id=?').run(operationId, current.id);
      value = admission(db, current.id)!;
    } else value = insertAdmission(db, { id: 'o:' + operationId, source: 'operation', sourceKey: operationId, conversationId: source.id, queueId: null,
      workspaceId: source.workspaceId, directoryIdentity: source.directoryIdentity, bindingId: source.bindingId, contentDigest, kind: 'queued', currentOperation: operationId }, source.groupIds, baseline);
    const old = db.prepare('SELECT admission_id,content_digest FROM execution_attempts WHERE operation_id=?').get(operationId);
    if (old && (old.admission_id !== value.id || old.content_digest !== contentDigest)) return fail('execution_operation_conflict');
    db.prepare("INSERT OR IGNORE INTO execution_attempts(operation_id,admission_id,content_digest,status) VALUES(?,?,?,'queued')").run(operationId, value.id, contentDigest);
    return value;
  }
  function claimOperation(operationId: string): DispatchPermit | null {
    inTransaction(db); z.uuid().parse(operationId);
    const row = db.prepare('SELECT conversation_id,type FROM workbench_operations WHERE id=?').get(operationId);
    if (!row) return fail('operation_not_found', 404);
    if (row.type === 'stop' || !scope(db, String(row.conversation_id)).groupIds.length) return null;
    const attempt = db.prepare('SELECT * FROM execution_attempts WHERE operation_id=?').get(operationId);
    if (!attempt) return fail('execution_admission_unregistered');
    if (attempt.status !== 'queued') return fail('execution_operation_unresolved');
    const value = admission(db, String(attempt.admission_id))!;
    if (value.currentOperation !== operationId) return fail('execution_operation_changed');
    const permit = permission(db, value, operationId);
    db.prepare("UPDATE execution_attempts SET status='claimed',dispatch_json=? WHERE operation_id=? AND status='queued'").run(JSON.stringify(permit), operationId);
    db.prepare("UPDATE execution_admissions SET kind='receipt-unknown' WHERE id=?").run(value.id);
    return permit;
  }
  return {
    assertWorkspaceAdmission(workspaceId: string) {
      inTransaction(db); id.parse(workspaceId);
      if (db.prepare('SELECT id FROM execution_scope_registration WHERE workspace_id=?').get(workspaceId)) return fail('execution_scope_registration_pending');
      assertAdmission(db, workspaceGroups(db, workspaceId));
    },
    admitQueue: (entryId: string) => admitQueue(entryId),
    admitOperation: (operationId: string, queueEntryId?: string) => admitOperation(operationId, queueEntryId),
    /** Baseline-only entry; validates that every affected group is initializing. */
    seedQueue: (entryId: string) => admitQueue(entryId, true),
    seedOperation: (operationId: string) => admitOperation(operationId, undefined, true),
    claimOperation,
    changeQueue(entryId: string, action: 'edit' | 'remove') {
      inTransaction(db); z.uuid().parse(entryId); z.enum(['edit', 'remove']).parse(action);
      const value = admission(db, 'q:' + entryId); if (!value) return;
      const current = value.currentOperation ? db.prepare('SELECT status FROM execution_attempts WHERE operation_id=?').get(value.currentOperation) : undefined;
      if (current && current.status !== 'rejected') return fail('execution_operation_unresolved');
      if (action === 'remove') { terminal(db, value, hash(['explicit-queue-removal', value.id, value.contentDigest])); return; }
      assertAdmission(db, members(db, value.id));
      const row = db.prepare('SELECT content_json FROM workbench_queue_entries WHERE id=?').get(entryId);
      if (!row?.content_json) return fail('execution_queue_admission_missing');
      db.prepare('UPDATE execution_admissions SET content_digest=? WHERE id=?').run(hash(messagePayload.parse(JSON.parse(String(row.content_json)))), value.id);
    },
    settleReceipt(operationId: string, outcome: 'accepted' | 'rejected' | 'unknown') {
      inTransaction(db); z.uuid().parse(operationId); z.enum(['accepted', 'rejected', 'unknown']).parse(outcome);
      const attempt = db.prepare('SELECT * FROM execution_attempts WHERE operation_id=?').get(operationId); if (!attempt) return;
      const status = outcome === 'unknown' ? 'receipt-unknown' : outcome;
      if (['accepted', 'rejected'].includes(String(attempt.status)) && attempt.status !== status) return fail('execution_receipt_conflict');
      db.prepare('UPDATE execution_attempts SET status=? WHERE operation_id=?').run(status, operationId);
      const value = admission(db, String(attempt.admission_id))!;
      if (value.currentOperation !== operationId || value.kind === 'settled') return;
      if (outcome === 'rejected' && value.source === 'operation') terminal(db, value, hash(['rejected', operationId, value.contentDigest]));
      else db.prepare('UPDATE execution_admissions SET kind=? WHERE id=?').run(outcome === 'accepted' ? 'running' : outcome === 'rejected' ? 'queued' : 'receipt-unknown', value.id);
    },
  };
}

/** JSON commands own complete SQLite transactions; no native I/O occurs here. */
function hostRepository(db: DatabaseSync) { return createExecutionHostRepository(db, { gate: group => gate(db, group), closure: groups => closure(db, groups), assertAdmission: groups => assertAdmission(db, groups) }); }
export function createExecutionPluginHooks(db: DatabaseSync) { return hostRepository(db).hooks; }
export function createExecutionStore(db: DatabaseSync) {
  const hooks = createExecutionAdmissionHooks(db);
  const hosts = hostRepository(db);
  const load = (groups: string[]) => idsSchema.parse(groups).sort(compare).map(groupId => gate(db, groupId));
  const store = {
    registerHostGroup: hosts.registerHostGroup, hostAdmission: hosts.hostAdmission, bindHostPluginRequest: hosts.bindHostPluginRequest, settleHostPlugin: hosts.settleHostPlugin,
    load(groups: string[]) { return transaction(db, () => load(groups), true); },
    save(groupId: string, expectedRevision: number, raw: ExecutionGate) {
      const next = executionGateSchema.parse(raw); id.parse(groupId); natural.parse(expectedRevision);
      if (next.groupId !== groupId || next.revision !== expectedRevision + 1) return fail('execution_gate_invalid');
      return transaction(db, () => {
        const old = gate(db, groupId); if (old.revision !== expectedRevision) return false;
        if (next.baselineComplete !== old.baselineComplete || next.windowId !== old.windowId || next.frozenSetId !== old.frozenSetId ||
          JSON.stringify(next.windowGroups) !== JSON.stringify(old.windowGroups) || next.controller.groupId !== groupId ||
          next.controller.generation !== old.controller.generation || next.controller.epoch < old.controller.epoch || next.controller.epoch > old.controller.epoch + 1)
          return fail('execution_gate_invalid');
        putGate(db, next); return true;
      });
    },
    registerGroup(state: ExecutionGroupState) {
      const controller = executionGateSchema.shape.controller.parse(state);
      return transaction(db, () => {
        const old = db.prepare('SELECT id FROM execution_groups WHERE id=?').get(controller.groupId); if (old) return gate(db, controller.groupId);
        const row: ExecutionGate = { groupId: controller.groupId, revision: 0, baselineComplete: false, phase: 'unknown', controller, error: 'execution_baseline_incomplete' };
        db.prepare('INSERT INTO execution_groups(id,revision,gate_json) VALUES(?,0,?)').run(row.groupId, JSON.stringify(row)); return row;
      });
    },
    registerScope(input: { workspaceId: string; groupId: string }) {
      const value = z.object({ workspaceId: id, groupId: id }).strict().parse(input);
      return transaction(db, () => {
        const group = gate(db, value.groupId);
        const workspace = db.prepare('SELECT directory,identity,removed FROM workbench_workspaces WHERE id=?').get(value.workspaceId);
        if (!workspace || workspace.removed !== 0) return fail('workspace_not_found', 404);
        const directory = z.string().max(4096).refine(path => isAbsolute(path) && normalize(path) === path && !path.includes('\0')).parse(workspace.directory);
        const old = db.prepare('SELECT directory,directory_identity FROM execution_scopes WHERE workspace_id=? AND group_id=?').get(value.workspaceId, value.groupId);
        let job = db.prepare('SELECT * FROM execution_scope_registration WHERE id=1').get();
        if (old?.directory === directory && old.directory_identity === workspace.identity && (!job || job.workspace_id !== value.workspaceId || job.group_id !== value.groupId)) return { complete: true, scanned: 0 };
        if (group.windowId || old && (old.directory !== directory || old.directory_identity !== workspace.identity)) return fail('execution_scope_requires_initialization');
        if (!old && group.baselineComplete && (group.phase !== 'online' || db.prepare('SELECT id FROM workbench_conversations WHERE workspace_id=? LIMIT 1').get(value.workspaceId))) return fail('execution_scope_requires_initialization');
        if (job && (job.workspace_id !== value.workspaceId || job.group_id !== value.groupId)) return fail('execution_scope_registration_busy', 429);
        if (!job) {
          db.prepare('INSERT INTO execution_scopes(workspace_id,group_id,directory,directory_identity) VALUES(?,?,?,?)').run(value.workspaceId, value.groupId, directory, String(workspace.identity));
          db.prepare('INSERT INTO execution_scope_registration(id,workspace_id,group_id) VALUES(1,?,?)').run(value.workspaceId, value.groupId);
          job = db.prepare('SELECT * FROM execution_scope_registration WHERE id=1').get()!;
        }
        const rows = db.prepare('SELECT workspace_id,group_id,directory FROM execution_scopes WHERE (workspace_id,group_id)>(?,?) ORDER BY workspace_id,group_id LIMIT 65').all(String(job.cursor_workspace), String(job.cursor_group));
        const neighbors = new Set<string>(JSON.parse(String(job.neighbors_json)));
        const prefix = (path: string) => path.endsWith(sep) ? path : path + sep;
        for (const row of rows.slice(0, 64)) {
          const candidate = String(row.directory);
          if (row.group_id === value.groupId || !(candidate === directory || candidate.startsWith(prefix(directory)) || directory.startsWith(prefix(candidate)))) continue;
          const neighbor = gate(db, String(row.group_id));
          if (neighbor.windowId || (group.baselineComplete ? !closure(db, [value.groupId]).includes(neighbor.groupId) : neighbor.baselineComplete)) return fail('execution_scope_requires_initialization');
          neighbors.add(neighbor.groupId); if (neighbors.size >= 32) return fail('execution_conflict_scope_too_large');
        }
        const complete = rows.length <= 64; const scanned = Number(job.scanned) + Math.min(rows.length, 64);
        if (complete) {
          for (const neighbor of neighbors) {
            db.prepare('INSERT OR IGNORE INTO execution_conflicts(left_group,right_group) VALUES(?,?)').run(value.groupId, neighbor);
            db.prepare('INSERT OR IGNORE INTO execution_conflicts(left_group,right_group) VALUES(?,?)').run(neighbor, value.groupId);
          }
          for (const affected of closure(db, [value.groupId])) {
            if (!gate(db, affected).baselineComplete) {
              db.prepare('DELETE FROM execution_baseline_sources WHERE group_id=?').run(affected);
              db.prepare('DELETE FROM execution_baselines WHERE group_id=?').run(affected);
            }
          }
          db.prepare('DELETE FROM execution_scope_registration WHERE id=1').run();
        } else {
          const last = rows[63]!;
          db.prepare('UPDATE execution_scope_registration SET cursor_workspace=?,cursor_group=?,neighbors_json=?,scanned=? WHERE id=1')
            .run(String(last.workspace_id), String(last.group_id), JSON.stringify([...neighbors].sort(compare)), scanned);
        }
        return { complete, scanned };
      });
    },
    cancelScopeRegistration(input: { workspaceId: string; groupId: string }) {
      const value = z.object({ workspaceId: id, groupId: id }).strict().parse(input);
      return transaction(db, () => {
        const job = db.prepare('SELECT workspace_id,group_id FROM execution_scope_registration WHERE id=1').get();
        if (!job || job.workspace_id !== value.workspaceId || job.group_id !== value.groupId) return false;
        db.prepare('DELETE FROM execution_scopes WHERE workspace_id=? AND group_id=?').run(value.workspaceId, value.groupId);
        db.prepare('DELETE FROM execution_scope_registration WHERE id=1').run(); return true;
      });
    },
    conflictGroups(groups: string[]) { return transaction(db, () => closure(db, groups), true); },
    registerConflicts(input: { left: string; right: string }[]) {
      const pairs = z.array(z.object({ left: id, right: id }).strict()).max(496).parse(input);
      return transaction(db, () => {
        for (const pair of pairs) {
          if (pair.left === pair.right) continue;
          if (db.prepare('SELECT left_group FROM execution_conflicts WHERE left_group=? AND right_group=?').get(pair.left, pair.right)) continue;
          const left = gate(db, pair.left); const right = gate(db, pair.right);
          if (left.baselineComplete || right.baselineComplete || left.windowId || right.windowId) return fail('execution_scope_requires_initialization');
          db.prepare('INSERT OR IGNORE INTO execution_conflicts(left_group,right_group) VALUES(?,?),(?,?)').run(pair.left, pair.right, pair.right, pair.left);
          closure(db, [pair.left]);
          for (const affected of closure(db, [pair.left])) {
            db.prepare('DELETE FROM execution_baseline_sources WHERE group_id=?').run(affected);
            db.prepare('DELETE FROM execution_baselines WHERE group_id=?').run(affected);
          }
        }
      });
    },
    workspaceGroups(workspaceId: string) { id.parse(workspaceId); return transaction(db, () => workspaceGroups(db, workspaceId), true); },
    baselineStatus(groupId: string) {
      id.parse(groupId);
      return transaction(db, () => {
        const present = db.prepare('SELECT group_id FROM execution_baselines WHERE group_id=?').get(groupId);
        return { checkpoint: present ? baseline(db, groupId) : null,
          sources: db.prepare('SELECT source,through_sequence,after_sequence,complete FROM execution_baseline_sources WHERE group_id=? ORDER BY source').all(groupId)
            .map(row => ({ source: row.source as 'operations' | 'queues', through: Number(row.through_sequence), after: Number(row.after_sequence), complete: row.complete === 1 })) };
      }, true);
    },
    beginBaseline(groupId: string) {
      id.parse(groupId);
      return transaction(db, () => {
        const current = gate(db, groupId);
        if (current.windowId || current.baselineComplete) return fail('execution_baseline_already_complete');
        if (db.prepare('SELECT id FROM execution_scope_registration WHERE id=1').get()) return fail('execution_scope_registration_pending');
        if (db.prepare('SELECT group_id FROM execution_baselines WHERE group_id=?').get(groupId)) return baseline(db, groupId);
        const through = Number(db.prepare('SELECT COALESCE(MAX(created_at),0) value FROM workbench_conversations').get()!.value);
        db.prepare('INSERT INTO execution_baselines(group_id,through_sequence) VALUES(?,?)').run(groupId, through);
        const operations = Number(db.prepare('SELECT COALESCE(MAX(sequence),0) value FROM workbench_operations').get()!.value);
        const queues = Number(db.prepare('SELECT COALESCE(MAX(sequence),0) value FROM workbench_queue_entries').get()!.value);
        db.prepare("INSERT INTO execution_baseline_sources(group_id,source,through_sequence) VALUES(?,'operations',?),(?,'queues',?)").run(groupId, operations, groupId, queues);
        return baseline(db, groupId);
      });
    },
    seedLegacyAdmissions(input: { groupId: string; source: 'operations' | 'queues'; after: number; limit: number; byteLimit: number }) {
      const value = z.object({ groupId: id, source: z.enum(['operations', 'queues']), after: natural, limit: z.number().int().min(1).max(64), byteLimit: z.number().int().min(4096).max(1024 * 1024) }).strict().parse(input);
      return transaction(db, () => {
        const current = gate(db, value.groupId); if (current.baselineComplete || current.windowId) return fail('execution_baseline_changed');
        const checkpoint = db.prepare('SELECT * FROM execution_baseline_sources WHERE group_id=? AND source=?').get(value.groupId, value.source);
        if (!checkpoint || checkpoint.after_sequence !== value.after || checkpoint.complete === 1) return fail('execution_baseline_changed');
        if (value.source === 'queues' && !db.prepare("SELECT group_id FROM execution_baseline_sources WHERE group_id=? AND source='operations' AND complete=1").get(value.groupId)) return fail('execution_baseline_sources_incomplete');
        const rows = value.source === 'operations'
          ? db.prepare('SELECT sequence,id,conversation_id,type,status,length(CAST(payload_json AS BLOB)) bytes FROM workbench_operations WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(value.after, Number(checkpoint.through_sequence), value.limit + 1)
          : db.prepare('SELECT sequence,id,conversation_id,content_json IS NOT NULL active,length(CAST(content_json AS BLOB)) bytes FROM workbench_queue_entries WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(value.after, Number(checkpoint.through_sequence), value.limit + 1);
        let consumed = 0; let imported = 0; let after = value.after; let bytes = 0;
        for (const row of rows.slice(0, value.limit)) {
          const relevant = value.source === 'operations' ? row.type === 'message' && ['queued', 'dispatching', 'unknown'].includes(String(row.status)) : row.active === 1;
          const conversation = relevant ? db.prepare('SELECT workspace_id FROM workbench_conversations WHERE id=?').get(String(row.conversation_id)) : undefined;
          if (conversation && workspaceGroups(db, String(conversation.workspace_id)).includes(value.groupId)) {
            const size = Number(row.bytes); if (bytes + size > value.byteLimit) break;
            bytes += size;
            const importedAdmission = value.source === 'operations' ? hooks.seedOperation(String(row.id)) : hooks.seedQueue(String(row.id));
            if (importedAdmission) {
              imported++;
              if (value.source === 'operations' && row.status !== 'queued') {
                // A pre-upgrade unknown/dispatching attempt has NO fresh dispatch
                // permission. It must reconcile the original native receipt.
                db.prepare("UPDATE execution_attempts SET status='receipt-unknown' WHERE operation_id=? AND status='queued'").run(String(row.id));
                db.prepare("UPDATE execution_admissions SET kind='receipt-unknown' WHERE id=? AND kind<>'settled'").run(importedAdmission.id);
              }
            }
          }
          consumed++; after = Number(row.sequence);
        }
        if (rows.length && !consumed) return fail('execution_baseline_entry_budget', 413);
        const complete = rows.length <= consumed;
        db.prepare('UPDATE execution_baseline_sources SET after_sequence=?,complete=? WHERE group_id=? AND source=?').run(after, Number(complete), value.groupId, value.source);
        return { scanned: consumed, imported, bytes, after, complete };
      });
    },
    bindingsPage(input: z.infer<typeof pageSchema>) {
      const value = pageSchema.parse(input); return transaction(db, () => bindingPage(db, value), true);
    },
    registerBaselineObservation(input: { groupId: string; through: number; after?: ExecutionCursor; conversationId: string; wireDigest: string }): NativePermit {
      const value = z.object({ groupId: id, through: natural, after: executionCursorSchema.optional(), conversationId: z.uuid(), wireDigest: digestSchema }).strict().parse(input);
      return transaction(db, () => {
        const target = gate(db, value.groupId);
        if (target.baselineComplete || target.windowId || target.error === 'execution_restore_requires_reconciliation') return fail('execution_baseline_changed');
        const page = bindingPage(db, { groupId: value.groupId, through: value.through, after: value.after, limit: 8, byteLimit: 128 * 1024 });
        const expected = page.bindings.find(binding => binding.id === value.conversationId);
        if (!expected?.bindingId) return fail('execution_binding_unverified');
        const source = scope(db, expected.id, false, true);
        const sourceKey = 'baseline-' + hash([value.groupId, value.through, expected.id, expected.bindingId]);
        const current = insertAdmission(db, { id: 'n:' + hash(sourceKey), source: 'native', sourceKey, conversationId: expected.id, queueId: null,
          workspaceId: expected.workspaceId, directoryIdentity: expected.directoryIdentity, bindingId: expected.bindingId, contentDigest: value.wireDigest,
          kind: 'native-associated', currentOperation: null }, source.groupIds, true);
        if (current.kind === 'settled') return fail('execution_already_settled');
        assertAdmission(db, source.groupIds, true);
        const groups = source.groupIds.map(groupId => { const row = gate(db, groupId); return { groupId, generation: row.controller.generation, epoch: row.controller.epoch }; });
        return { admissionId: current.id, requestId: sourceKey, contentDigest: value.wireDigest, groups };
      });
    },
    commitBaselineBatch(input: { groupId: string; expectedRevision: number; through: number; after?: ExecutionCursor; limit: number; byteLimit: number; observations: BaselineObservation[]; proof: string }) {
      const value = pageSchema.extend({ expectedRevision: natural, observations: z.array(observationSchema).max(64), proof: digestSchema }).strict().parse(input);
      if (Buffer.byteLength(JSON.stringify(value.observations)) > 128 * 1024) return fail('execution_baseline_entry_budget', 413);
      return transaction(db, () => {
        const current = gate(db, value.groupId); if (current.revision !== value.expectedRevision) return false;
        if (current.baselineComplete || current.windowId) return fail('execution_baseline_changed');
        const page = bindingPage(db, value);
        if (value.observations.length !== page.bindings.length) return fail('execution_baseline_observation_missing');
        for (let index = 0; index < page.bindings.length; index++) {
          const expected = page.bindings[index]!; const observed = value.observations[index]!;
          const { state, proof, ...identity } = observed;
          if (JSON.stringify(bindingSchema.parse(identity)) !== JSON.stringify(bindingSchema.parse(expected)) || (state === 'absent') !== (expected.bindingId === null)) return fail('execution_baseline_identity_mismatch');
          const sourceKey = 'baseline-' + hash([value.groupId, value.through, expected.id, expected.bindingId]); const admissionId = 'n:' + hash(sourceKey);
          const old = admission(db, admissionId);
          if (expected.bindingId !== null && (!old || old.conversationId !== expected.id || old.bindingId !== expected.bindingId || old.directoryIdentity !== expected.directoryIdentity)) return fail('execution_baseline_observation_unregistered');
          if (state === 'running' || state === 'waiting') {
            if (old!.kind === 'settled') return fail('execution_baseline_observation_changed');
            db.prepare('UPDATE execution_admissions SET kind=? WHERE id=?').run(state, old!.id);
          } else if (old && old.kind !== 'settled') terminal(db, old, proof);
        }
        const complete = page.nextCursor === null;
        db.prepare('UPDATE execution_baselines SET after_sequence=?,after_id=?,proof=?,complete=? WHERE group_id=?').run(page.endCursor?.sequence ?? null, page.endCursor?.id ?? null,
          hash([value.proof, value.observations]), Number(complete), value.groupId);
        if (complete && (current.controller.admission !== 'open' || current.controller.writers !== 'running')) return fail('execution_baseline_controller_unverified');
        putGate(db, { ...current, revision: current.revision + 1, ...(complete ? { baselineComplete: true, phase: 'online' as const, error: undefined } : {}) });
        return true;
      });
    },
    bindNativeRequest(operationId: string, wireDigest: string): DispatchPermit {
      z.uuid().parse(operationId); digestSchema.parse(wireDigest);
      return transaction(db, () => {
        const attempt = db.prepare('SELECT * FROM execution_attempts WHERE operation_id=?').get(operationId);
        if (!attempt || !['claimed', 'receipt-unknown'].includes(String(attempt.status)) || !attempt.dispatch_json) return fail('execution_operation_not_claimed');
        const original = JSON.parse(String(attempt.dispatch_json));
        if (original.wireDigest && original.wireDigest !== wireDigest) return fail('execution_native_request_conflict');
        const current = admission(db, String(attempt.admission_id))!;
        if (current.currentOperation !== operationId) return fail('execution_operation_changed');
        const permit = permission(db, current, operationId);
        db.prepare('UPDATE execution_attempts SET dispatch_json=? WHERE operation_id=?').run(JSON.stringify({ ...permit, wireDigest }), operationId);
        return permit;
      });
    },
    bindAssociatedRequest(input: { operationId: string; requestId: string; kind: 'wake'; wireDigest: string }): AssociatedPermit {
      const value = z.object({ operationId: z.uuid(), requestId: id, kind: z.literal('wake'), wireDigest: digestSchema }).strict().parse(input);
      return transaction(db, () => {
        const attempt = db.prepare('SELECT admission_id,status FROM execution_attempts WHERE operation_id=?').get(value.operationId);
        if (!attempt || attempt.status !== 'accepted') return fail('execution_operation_not_accepted');
        const current = admission(db, String(attempt.admission_id))!;
        if (current.currentOperation !== value.operationId) return fail('execution_operation_changed');
        const permit = permission(db, current, value.operationId);
        const old = db.prepare('SELECT operation_id,kind,wire_digest FROM execution_associated_requests WHERE request_id=?').get(value.requestId);
        if (old && (old.operation_id !== value.operationId || old.kind !== value.kind || old.wire_digest !== value.wireDigest)) return fail('execution_native_request_conflict');
        db.prepare('INSERT OR IGNORE INTO execution_associated_requests(request_id,operation_id,kind,wire_digest) VALUES(?,?,?,?)').run(value.requestId, value.operationId, value.kind, value.wireDigest);
        return { admissionId: current.id, operationId: value.operationId, requestId: value.requestId, contentDigest: value.wireDigest, groups: permit.groups, purpose: 'wake' };
      });
    },
    bindObservationRequest(input: { admissionId: string; requestId: string; wireDigest: string }): ObservationPermit {
      const value = z.object({ admissionId: id, requestId: id, wireDigest: digestSchema }).strict().parse(input);
      return transaction(db, () => {
        const current = admission(db, value.admissionId); if (!current) return fail('execution_admission_unregistered');
        return observationPermission(db, current, value.requestId, value.wireDigest);
      });
    },
    registerObservation(input: { requestId: string; workspaceId: string; conversationId: string; bindingId: string; wireDigest: string }): ObservationPermit {
      const value = z.object({ requestId: id,
        workspaceId: id, conversationId: z.uuid(), bindingId: z.string().min(1).max(1024), wireDigest: digestSchema }).strict().parse(input);
      return transaction(db, () => {
        const source = scope(db, value.conversationId);
        if (!source.groupIds.length || source.workspaceId !== value.workspaceId || source.bindingId !== value.bindingId) return fail('execution_native_scope_mismatch');
        // An observation request has its own immutable once identity, but an
        // unresolved binding needs only one admission. Reuse legacy pending
        // observations too; never erase them or infer that unknown work ended.
        const request = db.prepare('SELECT admission_id,wire_digest FROM execution_observation_requests WHERE request_id=?').get(value.requestId);
        if (request && request.wire_digest !== value.wireDigest) return fail('execution_native_request_conflict');
        const row = request ? undefined : db.prepare(`SELECT * FROM execution_admissions
          WHERE source='native' AND source_key GLOB 'observe:*' AND kind<>'settled'
            AND conversation_id=? AND binding_id=? AND workspace_id=? AND directory_identity=? ORDER BY sequence,id LIMIT 1`)
          .get(value.conversationId, value.bindingId, value.workspaceId, source.directoryIdentity);
        let current = request ? admission(db, String(request.admission_id)) : row ? admissionFromRow(row) : undefined;
        if (current) {
          if (current.source !== 'native' || !current.sourceKey.startsWith('observe:') || current.conversationId !== value.conversationId ||
            current.bindingId !== value.bindingId || current.workspaceId !== value.workspaceId || current.directoryIdentity !== source.directoryIdentity ||
            JSON.stringify(members(db, current.id)) !== JSON.stringify(source.groupIds)) return fail('execution_observation_identity_changed');
        } else {
          if (request) return fail('execution_admission_unregistered');
          current = insertAdmission(db, { id: 'n:' + hash(['observe', value.requestId]), source: 'native', sourceKey: 'observe:' + hash(value.requestId), conversationId: value.conversationId,
            queueId: null, workspaceId: value.workspaceId, directoryIdentity: source.directoryIdentity, bindingId: source.bindingId,
            contentDigest: value.wireDigest, kind: 'receipt-unknown', currentOperation: null }, source.groupIds);
        }
        // permission() still checks the current epoch/frozen set. A new binding
        // cannot enter a fence merely because this is an observation request.
        return observationPermission(db, current, value.requestId, value.wireDigest);
      });
    },
    permissionForStop(input: { operationId: string; bindingId: string; runId: string; wireDigest: string }): StopPermit {
      const value = z.object({ operationId: z.uuid(), bindingId: z.string().min(1).max(1024), runId: z.string().min(1).max(1024), wireDigest: digestSchema }).strict().parse(input);
      return transaction(db, () => {
        const operation = db.prepare('SELECT conversation_id,type,status,payload_json FROM workbench_operations WHERE id=?').get(value.operationId);
        if (!operation || operation.type !== 'stop' || !['dispatching', 'unknown'].includes(String(operation.status)) || JSON.parse(String(operation.payload_json)).runId !== value.runId) return fail('execution_stop_unregistered');
        const source = scope(db, String(operation.conversation_id));
        if (!source.groupIds.length || source.bindingId !== value.bindingId) return fail('execution_native_scope_mismatch');
        const tokens: DispatchPermit['groups'] = [];
        for (const groupId of source.groupIds) {
          const current = gate(db, groupId);
          if (!current.baselineComplete || current.intent || !(current.phase === 'online' && current.controller.admission === 'open' ||
            current.phase === 'draining' && current.stage === 'drain' && current.controller.admission === 'drain' && current.controller.frozenSetId === current.frozenSetId)) return fail('execution_dispatch_closed');
          tokens.push({ groupId, generation: current.controller.generation, epoch: current.controller.epoch, ...(current.frozenSetId ? { frozenSetId: current.frozenSetId } : {}) });
        }
        const old = db.prepare('SELECT wire_digest,groups_json FROM execution_stop_requests WHERE operation_id=?').get(value.operationId);
        if (old && (old.wire_digest !== value.wireDigest || old.groups_json !== JSON.stringify(source.groupIds))) return fail('execution_native_request_conflict');
        db.prepare('INSERT OR IGNORE INTO execution_stop_requests(operation_id,wire_digest,groups_json) VALUES(?,?,?)').run(value.operationId, value.wireDigest, JSON.stringify(source.groupIds));
        return { operationId: value.operationId, contentDigest: value.wireDigest, groups: tokens, purpose: 'stop' };
      });
    },
    registerNative(input: { sourceKey: string; workspaceId: string; conversationId: string; bindingId?: string; purpose: 'create' | 'execute'; wireDigest: string }): NativePermit {
      const value = z.object({ sourceKey: z.string().min(1).max(512), workspaceId: id, conversationId: z.uuid(), bindingId: z.string().min(1).max(1024).optional(), purpose: z.enum(['create', 'execute']), wireDigest: digestSchema }).strict().parse(input);
      return transaction(db, () => {
        const source = scope(db, value.conversationId, value.purpose === 'create');
        if (!source.groupIds.length || source.workspaceId !== value.workspaceId || (value.purpose === 'create' ? source.bindingId !== 'create:' + value.conversationId || value.bindingId !== undefined : source.bindingId !== value.bindingId)) return fail('execution_native_scope_mismatch');
        const current = insertAdmission(db, { id: 'n:' + hash(value.sourceKey), source: 'native', sourceKey: value.sourceKey, conversationId: value.conversationId, queueId: null,
          workspaceId: value.workspaceId, directoryIdentity: source.directoryIdentity, bindingId: source.bindingId, contentDigest: value.wireDigest, kind: 'receipt-unknown', currentOperation: null }, source.groupIds);
        const permit = permission(db, current, current.id);
        return { admissionId: current.id, requestId: value.sourceKey, contentDigest: current.contentDigest, groups: permit.groups };
      });
    },
    permissionForNative(admissionId: string, wireDigest: string): NativePermit {
      id.parse(admissionId); digestSchema.parse(wireDigest);
      return transaction(db, () => {
        const current = admission(db, admissionId);
        if (!current || current.source !== 'native' || current.contentDigest !== wireDigest) return fail('execution_native_request_conflict');
        const permit = permission(db, current, current.id);
        return { admissionId: current.id, requestId: current.sourceKey, contentDigest: current.contentDigest, groups: permit.groups };
      }, true);
    },
    attachNativeBinding(admissionId: string) {
      id.parse(admissionId);
      return transaction(db, () => {
        const current = admission(db, admissionId);
        if (!current || current.source !== 'native' || !current.conversationId || current.kind === 'settled') return fail('execution_admission_unregistered');
        const source = scope(db, current.conversationId);
        if (source.workspaceId !== current.workspaceId || source.directoryIdentity !== current.directoryIdentity || ![source.bindingId, 'create:' + source.id].includes(current.bindingId)) return fail('execution_native_scope_mismatch');
        db.prepare('UPDATE execution_admissions SET binding_id=? WHERE id=?').run(source.bindingId, current.id);
        return admission(db, current.id)!;
      });
    },
    freezeAdmissions(input: { windowId: string; groups: GroupRevision[] }) {
      id.parse(input.windowId);
      return transaction(db, () => {
        if (db.prepare('SELECT id FROM execution_scope_registration WHERE id=1').get()) return fail('execution_scope_registration_pending');
        const groupIds = revisionsSchema.parse(input.groups).map(row => row.groupId).sort(compare);
        if (JSON.stringify(closure(db, groupIds)) !== JSON.stringify(groupIds)) return fail('execution_conflict_scope_incomplete');
        const old = db.prepare('SELECT groups_json,status FROM execution_windows WHERE id=?').get(input.windowId);
        if (old) {
          if (old.groups_json !== JSON.stringify(groupIds)) return fail('execution_window_conflict');
          if (old.status === 'completed') return fail('execution_window_completed');
          const rows = load(groupIds); if (rows.some(row => row.windowId !== input.windowId)) return fail('execution_window_changed'); return rows;
        }
        const rows = checked(db, input.groups);
        if (rows.some(row => !row.baselineComplete || row.phase !== 'online' || row.controller.admission !== 'open')) return fail('execution_admission_closed');
        const through = Number(db.prepare('SELECT COALESCE(MAX(sequence),0) sequence FROM execution_admissions').get()!.sequence);
        const hostThrough = hosts.watermark();
        db.prepare("INSERT INTO execution_windows(id,groups_json,status,created_at) VALUES(?,?,'active',?)").run(input.windowId, JSON.stringify(groupIds), Date.now());
        for (const row of rows) {
          const frozenSetId = hash([input.windowId, row.groupId, through, hostThrough, row.controller.generation, row.controller.epoch]);
          db.prepare('INSERT INTO execution_freezes(window_id,group_id,frozen_set_id,through_sequence,host_through_sequence) VALUES(?,?,?,?,?)').run(input.windowId, row.groupId, frozenSetId, through, hostThrough);
          putGate(db, { ...row, revision: row.revision + 1, phase: 'draining', stage: 'fence', windowId: input.windowId, windowGroups: groupIds, frozenSetId, error: undefined });
        }
        return load(groupIds);
      });
    },
    pendingPage(input: { groupId: string; frozenSetId: string; after?: ExecutionCursor; limit: number; byteLimit: number }) {
      const value = z.object({ groupId: id, frozenSetId: digestSchema, after: executionCursorSchema.optional(), limit: z.number().int().min(1).max(64), byteLimit: z.number().int().min(4096).max(128 * 1024) }).strict().parse(input);
      return transaction(db, () => {
        const freeze = db.prepare('SELECT through_sequence,host_through_sequence FROM execution_freezes WHERE group_id=? AND frozen_set_id=?').get(value.groupId, value.frozenSetId);
        if (!freeze) return fail('execution_frozen_set_missing');
        const rows = db.prepare(`SELECT a.* FROM execution_pending p JOIN execution_admissions a ON a.id=p.admission_id
          WHERE p.group_id=? AND p.sequence<=? AND (p.sequence,p.admission_id)>(?,?) ORDER BY p.sequence,p.admission_id LIMIT ?`)
          .all(value.groupId, Number(freeze.through_sequence), value.after?.sequence ?? -1, value.after?.id ?? '', value.limit + 1);
        const workspaceEntries: PendingExecution[] = rows.map(row => {
          const current = admissionFromRow(row);
          return { id: current.id, sequence: current.sequence, groupId: value.groupId, bindingId: current.bindingId, workspaceId: current.workspaceId, directoryIdentity: current.directoryIdentity, kind: current.kind as Exclude<Admission['kind'], 'settled'> };
        });
        const candidates = [...workspaceEntries, ...hosts.page({ groupId: value.groupId, through: Number(freeze.host_through_sequence), after: value.after, limit: value.limit + 1 })]
          .sort((a, b) => a.sequence - b.sequence || compare(a.id, b.id));
        const entries: PendingExecution[] = []; let bytes = 256;
        for (const item of candidates) {
          const size = Buffer.byteLength(JSON.stringify(item)); if (entries.length === value.limit || bytes + size > value.byteLimit) break;
          entries.push(item); bytes += size;
        }
        if (candidates.length && !entries.length) return fail('execution_pending_entry_budget', 413);
        const last = entries.at(-1); return { entries, nextCursor: candidates.length > entries.length && last ? { sequence: last.sequence, id: last.id } : null };
      }, true);
    },
    unresolvedPage(input: { groupId: string; after?: ExecutionCursor; limit: number }) {
      const value = z.object({ groupId: id, after: executionCursorSchema.optional(), limit: z.number().int().min(1).max(16) }).strict().parse(input);
      return transaction(db, () => {
        const rows = db.prepare(`SELECT a.* FROM execution_pending p JOIN execution_admissions a ON a.id=p.admission_id
          WHERE p.group_id=? AND (p.sequence,p.admission_id)>(?,?) ORDER BY p.sequence,p.admission_id LIMIT ?`)
          .all(value.groupId, value.after?.sequence ?? -1, value.after?.id ?? '', value.limit + 1);
        const workspaceEntries = rows.map(row => {
          const current = admissionFromRow(row);
          return { id: current.id, sequence: current.sequence, groupId: value.groupId, bindingId: current.bindingId, workspaceId: current.workspaceId, directoryIdentity: current.directoryIdentity, kind: current.kind as Exclude<Admission['kind'], 'settled'> } satisfies PendingExecution;
        });
        const candidates = [...workspaceEntries, ...hosts.page({ groupId: value.groupId, after: value.after, limit: value.limit + 1 })].sort((a, b) => a.sequence - b.sequence || compare(a.id, b.id));
        const entries = candidates.slice(0, value.limit);
        const last = entries.at(-1); return { entries, nextCursor: candidates.length > value.limit && last ? { sequence: last.sequence, id: last.id } : null };
      }, true);
    },
    beginResume(input: { windowId: string; groups: GroupRevision[] }) {
      id.parse(input.windowId);
      return transaction(db, () => {
        const rows = checked(db, input.groups); const groupIds = rows.map(row => row.groupId);
        if (rows.some(row => row.windowId !== input.windowId || JSON.stringify(row.windowGroups) !== JSON.stringify(groupIds) || row.phase !== 'editable' || row.stage !== 'closed')) return fail('execution_window_not_editable');
        for (const row of rows) putGate(db, { ...row, revision: row.revision + 1, phase: 'resuming', stage: 'resume' }); return load(groupIds);
      });
    },
    hasUnsettledSaves(windowId: string, groups: string[]) {
      id.parse(windowId); idsSchema.parse(groups);
      return !!db.prepare("SELECT id FROM execution_saves WHERE window_id=? AND outcome='pending' LIMIT 1").get(windowId);
    },
    completeResume(input: { windowId: string; groups: GroupRevision[] }) {
      id.parse(input.windowId);
      return transaction(db, () => {
        const rows = checked(db, input.groups); const groupIds = rows.map(row => row.groupId);
        if (rows.some(row => row.windowId !== input.windowId || JSON.stringify(row.windowGroups) !== JSON.stringify(groupIds) || row.phase !== 'resuming' || row.stage !== 'opened' || row.controller.admission !== 'open') || store.hasUnsettledSaves(input.windowId, groupIds)) return fail('execution_resume_unverified');
        for (const row of rows) putGate(db, { groupId: row.groupId, revision: row.revision + 1, baselineComplete: true, phase: 'online', controller: row.controller });
        db.prepare("UPDATE execution_windows SET status='completed' WHERE id=?").run(input.windowId); return load(groupIds);
      });
    },
    acquireSave(input: { saveId: string; windowId: string; write: SaveWriteIdentity; writerId?: string; groups: GroupRevision[] }): SaveAdmission {
      const value = z.object({ saveId: id, windowId: id, write: writeSchema, writerId: id.optional(), groups: revisionsSchema }).strict().parse(input);
      return transaction(db, () => {
        const groupIds = value.groups.map(row => row.groupId).sort(compare);
        const inputDigest = hash([value.windowId, groupIds, value.write]);
        const old = db.prepare('SELECT input_digest,outcome FROM execution_saves WHERE id=?').get(value.saveId);
        if (old) { if (old.input_digest !== inputDigest) return fail('execution_save_conflict'); return { created: false, outcome: old.outcome as 'pending' | 'committed' | 'rejected' }; }
        const rows = checked(db, value.groups);
        if (db.prepare('SELECT id FROM execution_scope_registration WHERE workspace_id=?').get(value.write.workspaceId)) return fail('execution_scope_registration_pending');
        if (rows.some(row => row.phase !== 'editable' || row.stage !== 'closed' || row.controller.admission !== 'closed' || row.windowId !== value.windowId || JSON.stringify(row.windowGroups) !== JSON.stringify(groupIds))) return fail('execution_window_not_editable');
        // Serialize the filesystem compare-and-rename across application
        // processes too. Atomic rename alone does not provide a version CAS.
        if (db.prepare("SELECT id FROM execution_saves WHERE window_id=? AND outcome='pending' LIMIT 1").get(value.windowId)) return fail('execution_save_in_progress');
        if (JSON.stringify(workspaceGroups(db, value.write.workspaceId)) !== JSON.stringify(groupIds)) return fail('execution_save_scope_mismatch');
        const workspace = db.prepare('SELECT identity,removed FROM workbench_workspaces WHERE id=?').get(value.write.workspaceId);
        if (workspace?.identity !== value.write.directoryIdentity || workspace.removed !== 0) return fail('execution_directory_changed');
        const permit: SavePermit = { saveId: value.saveId, windowId: value.windowId, write: value.write, ...(value.writerId ? { writerId: value.writerId } : {}), groups: rows.map(row => ({ groupId: row.groupId, controller: { generation: row.controller.generation, epoch: row.controller.epoch } })) };
        db.prepare("INSERT INTO execution_saves(id,window_id,input_digest,permit_json,outcome,created_at) VALUES(?,?,?,?,'pending',?)").run(value.saveId, value.windowId, inputDigest, JSON.stringify(permit), Date.now());
        return { created: true, permit };
      });
    },
    settleSave(saveId: string, outcome: 'committed' | 'rejected', proof: string) {
      id.parse(saveId); z.enum(['committed', 'rejected']).parse(outcome); digestSchema.parse(proof);
      return transaction(db, () => {
        const row = db.prepare('SELECT outcome,proof FROM execution_saves WHERE id=?').get(saveId); if (!row) return fail('execution_save_missing');
        if (row.outcome !== 'pending') return row.outcome === outcome && row.proof === proof;
        db.prepare('UPDATE execution_saves SET outcome=?,proof=? WHERE id=?').run(outcome, proof, saveId); return true;
      });
    },
    pendingSaves(input: { windowId: string; after?: string; limit: number }) {
      const value = z.object({ windowId: id, after: id.optional(), limit: z.number().int().min(1).max(16) }).strict().parse(input);
      const rows = db.prepare("SELECT id,permit_json FROM execution_saves WHERE window_id=? AND outcome='pending' AND id>? ORDER BY id LIMIT ?").all(value.windowId, value.after ?? '', value.limit + 1);
      const entries = rows.slice(0, value.limit).map(row => JSON.parse(String(row.permit_json)) as SavePermit);
      return { entries, nextCursor: rows.length > value.limit ? entries.at(-1)!.saveId : null };
    },
    admission(admissionId: string) { return admission(db, admissionId) ?? null; },
    confirmTerminal(input: { admissionId: string; bindingId: string; operationId: string | null; proof: string }) {
      const value = z.object({ admissionId: id, bindingId: z.string().min(1).max(1024), operationId: z.uuid().nullable(), proof: digestSchema }).strict().parse(input);
      return transaction(db, () => {
        const current = admission(db, value.admissionId); if (!current) return fail('execution_admission_unregistered');
        if (current.bindingId !== value.bindingId || current.currentOperation !== value.operationId) return fail('execution_terminal_identity_mismatch');
        terminal(db, current, value.proof);
      });
    },
  };
  return store;
}

export type ExecutionStore = ReturnType<typeof createExecutionStore>;
export type AsyncExecutionStore = { [K in keyof ExecutionStore]: ExecutionStore[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never };
/** Compile-time mapping: coordinator methods are whole serializable commands. */
type PortMethods = { [K in keyof ExecutionCoordinatorPort]: ExecutionCoordinatorPort[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never };
const checkedPort = (store: ExecutionStore): PortMethods => store;
void checkedPort;

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { StoreError } from './workbench-store.ts';
import type { ExecutionCursor, ExecutionGate, HostPendingExecution } from './execution-coordinator.ts';

const harness = z.enum(['codex', 'dsh']);
const kind = z.enum(['plugin', 'source']);
const status = z.enum(['applying', 'unknown', 'restart-required', 'applied', 'failed']);
const terminal = (value: Status) => ['applied', 'failed', 'restart-required'].includes(value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const groupId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value; }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
type Status = z.infer<typeof status>;
type Claim = { operationId: string; harnessId: z.infer<typeof harness>; kind: z.infer<typeof kind>; command: unknown };
type Core = { gate(group: string): ExecutionGate; closure(groups: string[]): string[]; assertAdmission(groups: string[]): void };
export type HostAdmission = Claim & { id: string; sequence: number; contentDigest: string; status: Status; dispatchable: boolean };
export type HostPluginPermit = { admissionId: string; operationId: string; contentDigest: string; purpose: 'host-plugin'; groups: { groupId: string; generation: string; epoch: number; frozenSetId?: string }[] };

/** Host mutations deliberately have no conversation/workspace foreign key.
 * Business claim and this ledger insert share the caller's single transaction. */
export function createExecutionHostRepository(db: DatabaseSync, core: Core) {
  const available = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='execution_host_admissions'").get());
  const fail = (code: string): never => { throw new StoreError(code, 409); };
  function transaction<T>(action: () => T): T {
    if (db.isTransaction) return fail('execution_nested_transaction');
    db.exec('BEGIN IMMEDIATE'); try { const value = action(); db.exec('COMMIT'); return value; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  function hostAdmission(operationId: string): HostAdmission | undefined {
    z.uuid().parse(operationId); if (!available) return;
    const row = db.prepare('SELECT * FROM execution_host_admissions WHERE operation_id=?').get(operationId);
    return row ? { id: 'h:' + operationId, operationId, sequence: Number(row.sequence), harnessId: harness.parse(row.harness), kind: kind.parse(row.kind), command: JSON.parse(String(row.command_json)), contentDigest: String(row.content_digest), status: status.parse(row.status), dispatchable: row.dispatchable === 1 } : undefined;
  }
  function groups(harnessId: string) {
    const found = db.prepare('SELECT group_id FROM execution_host_groups WHERE harness=? ORDER BY group_id LIMIT 33').all(harnessId).map(row => String(row.group_id));
    if (found.length > 32) return fail('execution_conflict_scope_too_large');
    return found.length ? core.closure(found) : [];
  }
  function claim(input: Claim, baseline = false) {
    if (!db.isTransaction) return fail('execution_transaction_required');
    z.uuid().parse(input.operationId); harness.parse(input.harnessId); kind.parse(input.kind);
    if (!available) return;
    const members = groups(input.harnessId); if (!members.length) return;
    const text = JSON.stringify(input.command); if (text === undefined || Buffer.byteLength(text) > 65536) return fail('execution_host_command_invalid');
    const contentDigest = hash([input.harnessId, input.kind, input.command]);
    const old = hostAdmission(input.operationId);
    if (old && (old.contentDigest !== contentDigest || old.harnessId !== input.harnessId || old.kind !== input.kind)) return fail('execution_host_command_conflict');
    if (!baseline) core.assertAdmission(members);
    if (!old) db.prepare(`INSERT INTO execution_host_admissions(operation_id,harness,kind,command_json,content_digest,status,dispatchable)
      VALUES(?,?,?,?,?,?,?)`).run(input.operationId, input.harnessId, input.kind, text, contentDigest, baseline ? 'unknown' : 'applying', baseline ? 0 : 1);
    else if (baseline && !terminal(old.status)) db.prepare("UPDATE execution_host_admissions SET status='unknown',dispatchable=0 WHERE operation_id=?").run(input.operationId);
    const value = hostAdmission(input.operationId)!;
    for (const group of members) {
      db.prepare('INSERT OR IGNORE INTO execution_host_members VALUES(?,?)').run(input.operationId, group);
      if (!terminal(value.status)) db.prepare('INSERT OR IGNORE INTO execution_host_pending VALUES(?,?,?)').run(group, value.sequence, 'h:' + input.operationId);
    }
    return value;
  }
  function settle(input: { operationId: string; status: Status }) {
    if (!db.isTransaction) return fail('execution_transaction_required');
    z.uuid().parse(input.operationId); status.parse(input.status); if (!available) return;
    const old = hostAdmission(input.operationId); if (!old) return;
    if (['applied', 'failed'].includes(old.status) && old.status !== input.status) return fail('execution_host_receipt_conflict');
    // Losing application-readiness visibility cannot undo an already verified
    // completed native mutation, even while its business UI remains unknown.
    if (old.status === 'restart-required' && ['unknown', 'applying'].includes(input.status)) return;
    db.prepare('UPDATE execution_host_admissions SET status=? WHERE operation_id=?').run(input.status, input.operationId);
    if (terminal(input.status)) db.prepare('DELETE FROM execution_host_pending WHERE admission_id=?').run(old.id);
  }
  return {
    hooks: { claim: (input: Claim) => claim(input), settle }, hostAdmission,
    registerHostGroup(input: { groupId: string; harnessId: z.infer<typeof harness> }) {
      groupId.parse(input.groupId); harness.parse(input.harnessId);
      if (!available) return fail('execution_host_schema_missing');
      return transaction(() => {
        const current = core.gate(input.groupId);
        const old = db.prepare('SELECT harness FROM execution_host_groups WHERE group_id=?').get(input.groupId);
        if (old && old.harness !== input.harnessId) return fail('execution_host_harness_changed');
        if (!old && current.windowId) return fail('execution_host_registration_window_active');
        db.prepare('INSERT OR IGNORE INTO execution_host_groups VALUES(?,?)').run(input.groupId, input.harnessId);
        // Per-Harness business constraints allow one nonterminal plugin mutation.
        // LIMIT 2 is a verification bound, never permission to ignore overflow.
        const plugins = db.prepare("SELECT * FROM plugin_operations WHERE harness=? AND status IN ('applying','unknown','restart-required') LIMIT 2").all(input.harnessId);
        const sources = db.prepare("SELECT * FROM plugin_source_operations WHERE harness=? AND status IN ('applying','unknown') LIMIT 2").all(input.harnessId);
        if (plugins.length > 1 || sources.length > 1) return fail('execution_host_legacy_conflict');
        for (const row of plugins) claim({ operationId: String(row.id), harnessId: input.harnessId, kind: 'plugin', command: { id: row.id, pluginId: row.plugin_id, action: row.action, ...(row.version === null ? {} : { version: row.version }) } }, true);
        for (const row of sources) claim({ operationId: String(row.id), harnessId: input.harnessId, kind: 'source', command: JSON.parse(String(row.command_json)) }, true);
        return { imported: plugins.length + sources.length };
      });
    },
    bindHostPluginRequest(input: { operationId: string; wireDigest: string }): HostPluginPermit {
      z.uuid().parse(input.operationId); digest.parse(input.wireDigest);
      return transaction(() => {
        const value = hostAdmission(input.operationId);
        if (!value || !value.dispatchable || value.status !== 'applying') return fail('execution_host_dispatch_unverified');
        const tokens: HostPluginPermit['groups'] = [];
        const members = db.prepare('SELECT group_id FROM execution_host_members WHERE operation_id=? ORDER BY group_id LIMIT 33').all(input.operationId);
        if (!members.length || members.length > 32) return fail('execution_host_admission_unregistered');
        for (const member of members) {
          const group = String(member.group_id); const gate = core.gate(group);
          if (!gate.baselineComplete || gate.intent) return fail('execution_host_dispatch_closed');
          if (gate.phase === 'online' && gate.controller.admission === 'open') tokens.push({ groupId: group, generation: gate.controller.generation, epoch: gate.controller.epoch });
          else if (gate.phase === 'draining' && gate.stage === 'drain' && gate.controller.admission === 'drain' && gate.frozenSetId === gate.controller.frozenSetId) {
            const freeze = db.prepare('SELECT host_through_sequence FROM execution_freezes WHERE group_id=? AND frozen_set_id=?').get(group, gate.frozenSetId!);
            if (!freeze || value.sequence > Number(freeze.host_through_sequence)) return fail('execution_not_in_frozen_set');
            tokens.push({ groupId: group, generation: gate.controller.generation, epoch: gate.controller.epoch, frozenSetId: gate.frozenSetId });
          } else return fail('execution_host_dispatch_closed');
        }
        const old = db.prepare('SELECT wire_digest FROM execution_host_admissions WHERE operation_id=?').get(input.operationId)!;
        if (old.wire_digest !== null && old.wire_digest !== input.wireDigest) return fail('execution_host_wire_conflict');
        db.prepare('UPDATE execution_host_admissions SET wire_digest=? WHERE operation_id=?').run(input.wireDigest, input.operationId);
        return { admissionId: value.id, operationId: input.operationId, contentDigest: input.wireDigest, purpose: 'host-plugin', groups: tokens };
      });
    },
    settleHostPlugin(input: { operationId: string; status: Exclude<Status, 'applying'> }) { status.exclude(['applying']).parse(input.status); return transaction(() => settle(input)); },
    watermark() { return available ? Number(db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM execution_host_admissions').get()!.n) : 0; },
    page(input: { groupId: string; through?: number; after?: ExecutionCursor; limit: number }): HostPendingExecution[] {
      if (!available) return [];
      return db.prepare(`SELECT p.sequence,p.admission_id,a.operation_id,a.harness FROM execution_host_pending p JOIN execution_host_admissions a ON a.operation_id=substr(p.admission_id,3)
        WHERE p.group_id=? AND p.sequence<=? AND (p.sequence,p.admission_id)>(?,?) ORDER BY p.sequence,p.admission_id LIMIT ?`)
        .all(input.groupId, input.through ?? Number.MAX_SAFE_INTEGER, input.after?.sequence ?? -1, input.after?.id ?? '', input.limit)
        .map(row => ({ id: String(row.admission_id), sequence: Number(row.sequence), groupId: input.groupId, kind: 'host', operationId: String(row.operation_id), harnessId: harness.parse(row.harness) }));
    },
  };
}

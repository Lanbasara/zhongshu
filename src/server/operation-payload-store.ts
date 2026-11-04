import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import { StoreError } from './workbench-store.ts';

const maxPayloadBytes = 1024 * 1024;
const marker = '$zhPayload';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Lossless storage compaction, never deletion of retry identity or input.
 * Candidates and legacy checkpoints are indexed; each call is one bounded
 * maintenance slice inside the repository's transaction. */
export function createOperationPayloadStore(db: DatabaseSync) {
  const available = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='workbench_operation_payloads'").get());
  function read(operationId: string, payload: string): string {
    if (!available || !payload.includes('"$zhPayload"')) return payload;
    let stub: Record<string, unknown>;
    try { stub = JSON.parse(payload) as Record<string, unknown>; } catch { throw new StoreError('corrupt_workbench_data'); }
    if (stub[marker] !== 'gzip-v1') return payload;
    const row = db.prepare('SELECT raw_bytes,raw_digest,data FROM workbench_operation_payloads WHERE operation_id=?').get(operationId);
    if (!row || !(row.data instanceof Uint8Array) || Number(row.raw_bytes) < 1 || Number(row.raw_bytes) > maxPayloadBytes) throw new StoreError('operation_payload_unavailable', 503);
    try {
      const bytes = gunzipSync(row.data, { maxOutputLength: Number(row.raw_bytes) });
      if (bytes.length !== Number(row.raw_bytes) || digest(bytes) !== row.raw_digest) throw new Error('digest');
      return bytes.toString('utf8');
    } catch { throw new StoreError('operation_payload_corrupt', 503); }
  }
  function eligible(operationId: string, status: string) {
    return status === 'rejected' || status === 'accepted' && Boolean(db.prepare(`SELECT 1 FROM execution_attempts e JOIN execution_admissions a ON a.id=e.admission_id WHERE e.operation_id=? AND a.kind='settled'`).get(operationId));
  }
  function maintenance(): boolean {
    if (!available) return false;
    if (!db.isTransaction) throw new StoreError('operation_payload_transaction_required');
    let changed = false;
    const scan = db.prepare('SELECT * FROM workbench_operation_compaction_scan WHERE id=1').get();
    if (scan) {
      const rows = db.prepare('SELECT id,sequence,status,length(CAST(payload_json AS BLOB)) bytes FROM workbench_operations WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT 128').all(Number(scan.after_sequence), Number(scan.through_sequence));
      for (const row of rows) if (Number(row.bytes) >= 1024 && eligible(String(row.id), String(row.status)))
        db.prepare('INSERT OR IGNORE INTO workbench_operation_compaction VALUES(?,?)').run(Number(row.sequence), String(row.id));
      if (rows.length < 128) db.prepare('DELETE FROM workbench_operation_compaction_scan WHERE id=1').run();
      else db.prepare('UPDATE workbench_operation_compaction_scan SET after_sequence=? WHERE id=1').run(Number(rows.at(-1)!.sequence));
      changed = true;
    }
    let consumed = 0;
    for (const candidate of db.prepare('SELECT sequence,operation_id FROM workbench_operation_compaction ORDER BY sequence LIMIT 8').all()) {
      const operationId = String(candidate.operation_id);
      const row = db.prepare('SELECT status,payload_json FROM workbench_operations WHERE id=?').get(operationId);
      const payload = String(row?.payload_json ?? ''); const bytes = Buffer.from(payload);
      if (consumed && consumed + bytes.length > 512 * 1024) break;
      consumed += bytes.length;
      if (row && bytes.length >= 1024 && bytes.length <= maxPayloadBytes && eligible(operationId, String(row.status)) && !db.prepare('SELECT 1 FROM workbench_operation_payloads WHERE operation_id=?').get(operationId)) {
        const decoded = JSON.parse(payload) as Record<string, unknown>;
        const stub = JSON.stringify({ [marker]: 'gzip-v1', ...(decoded.queueRecord === true ? { queueRecord: true, queuedInput: { delivery: (decoded.queuedInput as { delivery?: unknown })?.delivery } } : {}) });
        const compressed = gzipSync(bytes, { level: 1 });
        // Include a whole extra SQLite page and row/index overhead in the saving
        // threshold; short or incompressible payloads stay in their original row.
        if (compressed.byteLength + Buffer.byteLength(stub) + 4096 < bytes.length) {
          db.prepare("INSERT INTO workbench_operation_payloads VALUES(?,'gzip-v1',?,?,?)").run(operationId, bytes.length, digest(bytes), compressed);
          db.prepare('UPDATE workbench_operations SET payload_json=? WHERE id=?').run(stub, operationId);
        }
      }
      db.prepare('DELETE FROM workbench_operation_compaction WHERE sequence=?').run(Number(candidate.sequence)); changed = true;
    }
    return changed;
  }
  return { read, maintenance };
}

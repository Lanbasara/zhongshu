import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

const status = z.enum(['pending', 'native_done', 'failed', 'completed']);
const record = z.object({ id: z.uuid(), status, reason: z.string().nullable() });
export type DeletionRecord = z.infer<typeof record>;

/** The journal outlives the conversation. It retains identity and progress, never user content. */
export function createDeletionStore(db: DatabaseSync, notify: (event: { sequence: number; conversationId: string }) => void, now = Date.now) {
  const get = (id: string): DeletionRecord | null => {
    z.uuid().parse(id);
    const row = db.prepare('SELECT id,status,reason FROM workbench_deletions WHERE id=?').get(id);
    return row ? record.parse(row) : null;
  };
  const emit = (id: string) => {
    const result = db.prepare('INSERT INTO workbench_changes(conversation_id,created_at) VALUES(?,?)').run(id, now());
    return { sequence: Number(result.lastInsertRowid), conversationId: id };
  };
  const publish = (event: { sequence: number; conversationId: string }) => {
    try { notify(event); } catch { /* Durable SSE cursor replays committed changes. */ }
  };
  return {
    get,
    listPending(limit = 32): string[] {
      z.number().int().min(1).max(64).parse(limit);
      return db.prepare("SELECT id FROM workbench_deletions WHERE status IN ('pending','native_done') ORDER BY updated_at,id LIMIT ?").all(limit).map(row => String(row.id));
    },
    begin(id: string) {
      z.uuid().parse(id);
      const event = transaction(db, () => {
        db.prepare("INSERT INTO workbench_deletions(id,status,updated_at) VALUES(?,'pending',?) ON CONFLICT(id) DO UPDATE SET status=CASE WHEN status IN ('native_done','completed') THEN status ELSE 'pending' END,reason=NULL,updated_at=excluded.updated_at").run(id, now());
        return emit(id);
      });
      publish(event);
    },
    nativeDone(id: string) {
      z.uuid().parse(id);
      db.prepare("UPDATE workbench_deletions SET status='native_done',reason=NULL,updated_at=? WHERE id=? AND status!='completed'").run(now(), id);
    },
    fail(id: string, reason: string) {
      z.uuid().parse(id); z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).parse(reason);
      const event = transaction(db, () => {
        db.prepare("UPDATE workbench_deletions SET status=CASE WHEN status='native_done' THEN status ELSE 'failed' END,reason=?,updated_at=? WHERE id=? AND status!='completed'").run(reason, now(), id);
        return emit(id);
      });
      publish(event);
    },
    complete(id: string) {
      const current = get(id);
      if (current?.status === 'completed') return;
      if (current?.status !== 'native_done') throw new Error('native_deletion_not_verified');
      const event = transaction(db, () => {
        db.prepare('DELETE FROM workbench_resource_refs WHERE resource_id IN (SELECT id FROM workbench_resources WHERE conversation_id=?)').run(id);
        db.prepare('DELETE FROM workbench_resources WHERE conversation_id=?').run(id);
        // Remove queue foreign references before cascading message operations.
        db.prepare('DELETE FROM workbench_queues WHERE conversation_id=?').run(id);
        db.prepare('DELETE FROM workbench_draft_preparations WHERE claimed_by=?').run(id);
        db.prepare('DELETE FROM workbench_changes WHERE conversation_id=?').run(id);
        db.prepare('DELETE FROM workbench_conversations WHERE id=?').run(id);
        db.prepare("UPDATE workbench_deletions SET status='completed',reason=NULL,updated_at=? WHERE id=?").run(now(), id);
        return emit(id);
      });
      publish(event);
    },
  };
}
export type DeletionStore = ReturnType<typeof createDeletionStore>;

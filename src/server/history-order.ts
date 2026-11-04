import type { DatabaseSync } from 'node:sqlite';
import { StoreError } from './workbench-store.ts';

const stepSize = 1024 * 1024;
const bound = Math.floor(Number.MAX_SAFE_INTEGER / 2);
type Position = { id: string; position: number };
const available = new WeakMap<DatabaseSync, boolean>();
function supportsRebuild(db: DatabaseSync): boolean {
  let found = available.get(db);
  if (found === undefined) { found = !!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='workbench_history_order'").get(); available.set(db, found); }
  return found;
}
export function activeHistoryOrder(db: DatabaseSync, conversationId: string): number {
  return supportsRebuild(db) ? Number(db.prepare('SELECT active FROM workbench_history_order WHERE conversation_id=?').get(conversationId)?.active ?? 0) : 0;
}
export function requestHistoryRebuild(db: DatabaseSync, conversationId: string): void {
  if (!supportsRebuild(db)) return;
  db.prepare(`INSERT INTO workbench_history_order(conversation_id,phase) VALUES(?,'clear')
    ON CONFLICT(conversation_id) DO UPDATE SET phase='clear',after_id=NULL,after_position=NULL,next_position=0 WHERE phase IS NULL`).run(conversationId);
}

/** Builds the inactive unique order in bounded transactions, then publishes a
 * single pointer. Readers keep using the old index throughout construction.
 * Only positional changes pause; existing body/status updates can continue.
 */
export function advanceHistoryRebuild(db: DatabaseSync, limit = 512): boolean {
  if (!supportsRebuild(db)) return false;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1024) throw new StoreError('invalid_index_batch', 400);
  db.exec('BEGIN IMMEDIATE');
  try {
    const job = db.prepare('SELECT * FROM workbench_history_order WHERE phase IS NOT NULL ORDER BY conversation_id LIMIT 1').get();
    if (!job) { db.exec('COMMIT'); return false; }
    const id = String(job.conversation_id); const active = Number(job.active);
    const inactive = db.prepare(active === 0 ? 'UPDATE workbench_items SET alternate_position=? WHERE conversation_id=? AND id=?' : 'UPDATE workbench_items SET position=? WHERE conversation_id=? AND id=?');
    if (job.phase === 'clear') {
      const rows = db.prepare('SELECT id FROM workbench_items WHERE conversation_id=? AND id>? ORDER BY id LIMIT ?').all(id, String(job.after_id ?? ''), limit);
      // The original position column is NOT NULL. Its inactive values get
      // disjoint reserved integers until their replacement generation is built.
      let position = Number(job.next_position);
      for (const row of rows) inactive.run(active === 0 ? null : Number.MIN_SAFE_INTEGER + position++, id, String(row.id));
      db.prepare('UPDATE workbench_history_order SET after_id=?,next_position=? WHERE conversation_id=?').run(rows.at(-1)?.id ?? job.after_id ?? null, position, id);
      if (rows.length < limit) db.prepare("UPDATE workbench_history_order SET phase='build',after_position=NULL,next_position=0 WHERE conversation_id=?").run(id);
    } else {
      const first = job.after_position === null;
      const read = active === 0
        ? first ? db.prepare('SELECT id,position FROM workbench_items WHERE conversation_id=? ORDER BY position LIMIT ?') : db.prepare('SELECT id,position FROM workbench_items WHERE conversation_id=? AND position>? ORDER BY position LIMIT ?')
        : first ? db.prepare('SELECT id,alternate_position AS position FROM workbench_items WHERE conversation_id=? AND alternate_position IS NOT NULL ORDER BY alternate_position LIMIT ?') : db.prepare('SELECT id,alternate_position AS position FROM workbench_items WHERE conversation_id=? AND alternate_position>? ORDER BY alternate_position LIMIT ?');
      const rows = (first ? read.all(id, limit) : read.all(id, Number(job.after_position), limit)) as Position[];
      let position = Number(job.next_position);
      for (const row of rows) { if (position > bound) throw new StoreError('history_index_capacity', 507); inactive.run(position, id, row.id); position += stepSize; }
      db.prepare('UPDATE workbench_history_order SET after_position=?,next_position=? WHERE conversation_id=?').run(rows.at(-1)?.position ?? job.after_position ?? null, position, id);
      if (rows.length < limit) db.prepare('UPDATE workbench_history_order SET active=1-active,generation=generation+1,phase=NULL,after_id=NULL,after_position=NULL,next_position=0 WHERE conversation_id=?').run(id);
    }
    db.exec('COMMIT'); return true;
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } throw error; }
}

/** Called only inside the page publication transaction. Normal append/prepend
 * touches the page and its immediate neighbours, independent of history size.
 * A dense insertion redistributes a bounded local window, never loads all IDs.
 */
export function allocateHistoryPositions(db: DatabaseSync, conversationId: string, ids: string[], beforeItemId?: string): Map<string, number> {
  const active = activeHistoryOrder(db, conversationId);
  const find = db.prepare(active === 0 ? 'SELECT id,position FROM workbench_items WHERE conversation_id=? AND id=?' : 'SELECT id,alternate_position AS position FROM workbench_items WHERE conversation_id=? AND id=?');
  const known = new Map<string, number>();
  const anchor = beforeItemId === undefined ? undefined : find.get(conversationId, beforeItemId) as Position | undefined;
  if (beforeItemId !== undefined && !anchor) throw new StoreError('history_anchor_not_found', 409);
  let last = -Infinity;
  for (const id of ids) {
    const row = find.get(conversationId, id) as Position | undefined;
    if (!row) continue;
    if (row.position < last || anchor && row.position > anchor.position) throw new StoreError('history_order_conflict', 409);
    known.set(id, row.position); last = row.position;
  }
  const blocks = new Map<string | null, string[]>(); let pending: string[] = [];
  for (const id of ids) {
    if (known.has(id)) { if (pending.length) { blocks.set(id, pending); pending = []; } }
    else pending.push(id);
  }
  if (pending.length) {
    const boundary = beforeItemId ?? null;
    if (boundary && ids.includes(boundary)) throw new StoreError('history_order_conflict', 409);
    blocks.set(boundary, [...(blocks.get(boundary) ?? []), ...pending]);
  }
  if (blocks.size && supportsRebuild(db) && db.prepare('SELECT 1 FROM workbench_history_order WHERE conversation_id=? AND phase IS NOT NULL').get(conversationId))
    throw new StoreError('history_index_rebuild_required', 503);
  const insert = db.prepare(active === 0 ? "INSERT INTO workbench_items(conversation_id,id,position,kind,text,status) VALUES(?,?,?,'notice','','completed')"
    : "INSERT INTO workbench_items(conversation_id,id,alternate_position,position,kind,text,status) VALUES(?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM workbench_items WHERE conversation_id=?),'notice','','completed')");
  const move = db.prepare(active === 0 ? 'UPDATE workbench_items SET position=? WHERE conversation_id=? AND id=?' : 'UPDATE workbench_items SET alternate_position=? WHERE conversation_id=? AND id=?');
  for (const [boundary, block] of blocks) {
    const right = boundary === null ? undefined : find.get(conversationId, boundary) as Position;
    const left = (right
      ? db.prepare(active === 0 ? 'SELECT id,position FROM workbench_items WHERE conversation_id=? AND position<? ORDER BY position DESC LIMIT 1' : 'SELECT id,alternate_position AS position FROM workbench_items WHERE conversation_id=? AND alternate_position<? ORDER BY alternate_position DESC LIMIT 1').get(conversationId, right.position)
      : db.prepare(active === 0 ? 'SELECT id,position FROM workbench_items WHERE conversation_id=? ORDER BY position DESC LIMIT 1' : 'SELECT id,alternate_position AS position FROM workbench_items WHERE conversation_id=? AND alternate_position IS NOT NULL ORDER BY alternate_position DESC LIMIT 1').get(conversationId)) as Position | undefined;
    let step = left && right ? Math.floor((right.position - left.position) / (block.length + 1)) : stepSize;
    let first = left ? left.position + step : right ? right.position - step * block.length : 0;
    if (step < 1) {
      let repaired = false;
      for (const limit of [256, 1024, 4096]) {
        const rows = db.prepare(active === 0 ? 'SELECT id,position FROM workbench_items WHERE conversation_id=? AND position>=? ORDER BY position LIMIT ?' : 'SELECT id,alternate_position AS position FROM workbench_items WHERE conversation_id=? AND alternate_position>=? ORDER BY alternate_position LIMIT ?')
          .all(conversationId, right!.position, limit + 1) as Position[];
        const after = rows.length > limit ? rows.pop() : undefined;
        step = after ? Math.floor((after.position - left!.position) / (rows.length + block.length + 1)) : stepSize;
        first = left!.position + step;
        if (step < 1 || first + step * (rows.length + block.length - 1) > bound) continue;
        for (let index = 0; index < rows.length; index++) move.run(Number.MIN_SAFE_INTEGER + index, conversationId, rows[index]!.id);
        for (let index = 0; index < rows.length; index++) move.run(first + step * (block.length + index), conversationId, rows[index]!.id);
        repaired = true; break;
      }
      if (!repaired) throw new StoreError('history_index_rebuild_required', 503);
    }
    if (Math.abs(first) > bound || Math.abs(first + step * (block.length - 1)) > bound) throw new StoreError('history_index_rebuild_required', 503);
    for (let index = 0; index < block.length; index++) {
      if (active === 0) insert.run(conversationId, block[index]!, first + step * index);
      else insert.run(conversationId, block[index]!, first + step * index, conversationId);
    }
  }
  const physical = db.prepare('SELECT position FROM workbench_items WHERE conversation_id=? AND id=?');
  return new Map(ids.map(id => [id, Number(physical.get(conversationId, id)!.position)]));
}

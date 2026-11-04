import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { requestHistoryRebuild } from '../src/server/history-order.ts';

test('dense index repair checkpoints in bounded batches and atomically switches without exposing partial order', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-order-')); let db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  let store = createWorkbenchStore(db); const id = randomUUID(); const configuration = { modelId: 'fixture', permissionId: 'fixture' };
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration });
  store.saveBinding(id, { id: 'native', cwd: '/synthetic', configuration, details: {} });
  const item = (id: string) => ({ id, text: id, kind: 'assistant' as const, status: 'completed' as const });
  const insert = db.prepare("INSERT INTO workbench_items(conversation_id,id,position,kind,text,status) VALUES(?,?,?,'assistant',?,'completed')");
  db.exec('BEGIN IMMEDIATE');
  for (let index = 0; index < 5000; index++) insert.run(id, 'item-' + index, index, 'item-' + index);
  db.exec('COMMIT');
  store.commitArchivePage(store.claimArchiveJob(id, 'backfill', true)!, [item('item-1')], 'old-cursor');
  const job = store.claimArchiveJob(id, 'backfill', true)!;
  assert.throws(() => store.commitArchivePage(job, [item('inserted')], null), { code: 'history_index_rebuild_required' });
  assert.equal(store.archiveJobs(id).find(value => value.kind === 'backfill')?.cursor, 'old-cursor');
  assert.equal(db.prepare('SELECT phase FROM workbench_history_order WHERE conversation_id=?').get(id)?.phase, 'clear');
  const tail = store.readHistory(id).items.map(value => value.id);
  for (let step = 0; step < 5; step++) { assert.equal(store.advanceHistoryIndex(), true); assert.deepEqual(store.readHistory(id).items.map(value => value.id), tail); }
  db.close(); db = openDatabase(root, productMigrations); store = createWorkbenchStore(db);
  let passes = 5;
  while (store.advanceHistoryIndex()) { assert.deepEqual(store.readHistory(id).items.map(value => value.id), tail); assert.ok(++passes < 30); }
  assert.equal(db.prepare('SELECT active FROM workbench_history_order WHERE conversation_id=?').get(id)?.active, 1);
  assert.equal(store.commitArchivePage(job, [item('inserted')], null), true);
  assert.deepEqual(store.readHistory(id, { beforeItemId: 'item-1' }).items.map(value => value.id), ['item-0', 'inserted']);
  store.mergeHistory(id, [item('tail-after-rebuild')]);
  store.mergeHistory(id, [item('head-after-rebuild')], 'item-0');
  assert.equal(store.readHistory(id).items.at(-1)?.id, 'tail-after-rebuild');
  const nextTail = store.readHistory(id).items.map(value => value.id);
  requestHistoryRebuild(db, id); passes = 0;
  while (store.advanceHistoryIndex()) { assert.deepEqual(store.readHistory(id).items.map(value => value.id), nextTail); assert.ok(++passes < 30); }
  assert.equal(db.prepare('SELECT active FROM workbench_history_order WHERE conversation_id=?').get(id)?.active, 0);
  assert.equal(store.readHistory(id, { beforeItemId: 'item-0' }).items[0]?.id, 'head-after-rebuild');
});

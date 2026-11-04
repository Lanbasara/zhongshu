import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import type { NativeItem } from '../src/harness/types.ts';

const item = (id: string, text = id): NativeItem => ({ id, text, kind: 'assistant', status: 'completed' });

test('page body and cursor publish atomically; stale readers cannot commit after a replacement claim', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-archive-'));
  let db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  let store = createWorkbenchStore(db);
  const id = randomUUID(); const configuration = { modelId: 'fixture', permissionId: 'fixture' };
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration });
  store.saveBinding(id, { id: 'native-fixture', cwd: '/synthetic', configuration, details: {} });
  const first = store.claimArchiveJob(id, 'backfill', true)!;
  db.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE OF cursor ON workbench_archive_jobs BEGIN SELECT RAISE(ABORT,'synthetic crash boundary'); END");
  assert.throws(() => store.commitArchivePage(first, [item('tail')], 'older'));
  assert.equal(store.hasHistoryItem(id, 'tail'), false);
  assert.equal(store.archiveJobs(id).find(job => job.kind === 'backfill')?.cursor, null);
  db.exec('DROP TRIGGER fail_checkpoint');
  assert.equal(store.commitArchivePage(first, [item('tail')], 'older'), true);
  db.close(); db = openDatabase(root, productMigrations); store = createWorkbenchStore(db);
  const checkpoint = store.archiveJobs(id).find(job => job.kind === 'backfill')!;
  assert.equal(checkpoint.cursor, 'older'); assert.equal(checkpoint.anchorId, 'tail');
  const next = store.claimArchiveJob(id, 'backfill', true)!;
  assert.equal(store.commitArchivePage(first, [item('uncommitted')], null), false);
  assert.equal(store.hasHistoryItem(id, 'uncommitted'), false);
  assert.equal(store.commitArchivePage(next, [item('head')], null), true);
  assert.deepEqual(store.readHistory(id).items.map(value => value.id), ['head', 'tail']);
  assert.equal(store.archiveJobs(id).find(job => job.kind === 'backfill')?.complete, true);
});

test('old body pages cannot overwrite a newer head, and multi-page cursor cycles never advance coverage', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-archive-'));
  const db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = createWorkbenchStore(db); const id = randomUUID(); const configuration = { modelId: 'fixture', permissionId: 'fixture' };
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration });
  store.saveBinding(id, { id: 'native-fixture', cwd: '/synthetic', configuration, details: {} });
  store.mergeHistory(id, [item('same', 'new-final')]);
  let job = store.claimArchiveJob(id, 'backfill', true)!;
  store.commitArchivePage(job, [item('same', 'stale-body')], 'A');
  assert.equal(store.getItem(id, 'same')?.text, 'new-final');
  job = store.claimArchiveJob(id, 'backfill', true)!;
  store.commitArchivePage(job, [item('older')], 'B');
  job = store.claimArchiveJob(id, 'backfill', true)!;
  assert.throws(() => store.commitArchivePage(job, [item('cycle')], 'A'), { code: 'history_no_progress' });
  assert.equal(store.hasHistoryItem(id, 'cycle'), false);
  assert.equal(store.archiveJobs(id).find(value => value.kind === 'backfill')?.cursor, 'B');
});

test('expired cursor restarts at the head, retains archived bodies and records uncertain source continuity', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-archive-reset-'));
  let db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  let store = createWorkbenchStore(db); const id = randomUUID(); const configuration = { modelId: 'fixture', permissionId: 'fixture' };
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration });
  store.saveBinding(id, { id: 'native-fixture', cwd: '/synthetic', configuration, details: {} });
  let job = store.claimArchiveJob(id, 'backfill', true)!;
  store.commitArchivePage(job, [item('kept')], 'expired');
  job = store.claimArchiveJob(id, 'backfill', true)!;
  store.restartArchiveJob(job, 'history_cursor_invalid');
  assert.equal(store.commitArchivePage(job, [item('stale')], null), false);
  db.close(); db = openDatabase(root, productMigrations); store = createWorkbenchStore(db);
  job = store.claimArchiveJob(id, 'backfill', true)!;
  assert.equal(job.cursor, null); assert.equal(job.anchorId, null);
  assert.equal(job.coverageError, 'archive_continuity_unverified');
  store.commitArchivePage(job, [item('kept'), item('new')], null);
  assert.deepEqual(store.readHistory(id).items.map(value => value.id), ['kept', 'new']);
  assert.equal(store.archiveJobs(id).find(value => value.kind === 'backfill')!.coverageError, 'archive_continuity_unverified');
  let batches = 0; while (store.advanceArchiveMaintenance()) assert.ok(++batches < 10);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workbench_archive_scan_items').get()!.n, 0);
});

test('a replaced native head cannot silently claim continuous coverage and cleanup is batched', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-archive-gap-'));
  const db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = createWorkbenchStore(db); const id = randomUUID(); const configuration = { modelId: 'fixture', permissionId: 'fixture' };
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration });
  store.saveBinding(id, { id: 'native-fixture', cwd: '/synthetic', configuration, details: {} });
  store.mergeHistory(id, [item('prior-head')]);
  const job = store.claimArchiveJob(id, 'latest', true)!;
  store.commitArchivePage(job, [item('replacement-head')], null);
  assert.equal(store.archiveJobs(id).find(value => value.kind === 'latest')!.coverageError, 'archive_source_gap');
  assert.equal(store.getItem(id, 'prior-head')!.text, 'prior-head');
  const insert = db.prepare('INSERT INTO workbench_archive_scan_items VALUES(?,?,?,?)');
  db.exec('BEGIN'); for (let n = 0; n < 1200; n++) insert.run(id, 'latest', job.scanGeneration, String(n)); db.exec('COMMIT');
  assert.equal(store.advanceArchiveMaintenance(), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workbench_archive_scan_items').get()!.n, 688);
  store.advanceArchiveMaintenance(); store.advanceArchiveMaintenance();
  assert.equal(store.advanceArchiveMaintenance(), false);
});

test('comparable native revisions update old items while late tool calls only fill missing immutable input', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-archive-revision-'));
  const db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = createWorkbenchStore(db); const id = randomUUID(); const configuration = { modelId: 'fixture', permissionId: 'fixture' };
  store.createConversation({ id, harnessId: 'dsh', workspaceId: 'fixture', cwd: '/synthetic', configuration });
  store.saveBinding(id, { id: 'native-fixture', cwd: '/synthetic', configuration, details: {} });
  const revision = (sequence: number) => ({ generation: 'one-native-source', sequence });
  store.mergeHistory(id, [{ id: 'tool', kind: 'tool', text: 'result', status: 'completed', tool: { name: '工具执行', output: 'result' }, sourceRevision: revision(2000) }]);
  store.mergeHistory(id, [{ id: 'tool', kind: 'tool', text: 'bash', status: 'running', tool: { name: 'bash', input: 'printf synthetic' }, sourceRevision: revision(10) }]);
  assert.deepEqual(store.getItem(id, 'tool'), { id: 'tool', kind: 'tool', text: 'result', status: 'completed', tool: { name: 'bash', input: 'printf synthetic', output: 'result' }, sourceRevision: revision(2000), references: undefined });
  const job = store.claimArchiveJob(id, 'backfill', true)!;
  store.commitArchivePage(job, [{ id: 'tool', kind: 'tool', text: 'new result', status: 'completed', tool: { name: 'bash', output: 'new result' }, sourceRevision: revision(2001) }], null);
  assert.equal(store.getItem(id, 'tool')!.text, 'new result');
  assert.equal(store.getItem(id, 'tool')!.tool!.input, 'printf synthetic');
  store.saveLiveItem(id, { id: 'tool', kind: 'tool', text: 'late unversioned running hint', status: 'running' });
  assert.equal(store.getItem(id, 'tool')!.text, 'new result');
});

test('unfinished-item repair pages fairly after restart and never labels partial running bodies complete', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-archive-pending-'));
  let db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  let store = createWorkbenchStore(db); const id = randomUUID(); const configuration = { modelId: 'fixture', permissionId: 'fixture' };
  store.createConversation({ id, harnessId: 'dsh', workspaceId: 'fixture', cwd: '/synthetic', configuration });
  store.saveBinding(id, { id: 'native-fixture', cwd: '/synthetic', configuration, details: {} });
  store.mergeHistory(id, Array.from({ length: 20 }, (_, index) => ({ ...item(String(index).padStart(2, '0')), status: 'running' as const, sourceRevision: { generation: 'source', sequence: 1 } })));
  let job = store.claimArchiveJob(id, 'latest', true)!;
  let ids = store.pendingArchiveItems(id, job.refreshAfter);
  assert.equal(ids.length, 16);
  store.refreshArchiveItems(job, [], ids); // missing source rows do not starve later IDs
  db.close(); db = openDatabase(root, productMigrations); store = createWorkbenchStore(db);
  job = store.claimArchiveJob(id, 'latest', true)!;
  ids = store.pendingArchiveItems(id, job.refreshAfter);
  assert.deepEqual(ids, ['16', '17', '18', '19']);
  store.refreshArchiveItems(job, ids.map(id => ({ ...item(id), sourceRevision: { generation: 'source', sequence: 2 } })), ids);
  assert.ok(store.archiveJobs(id).every(job => job.error === 'archive_items_pending'));
  store.refreshArchiveItems(job, [], []);
  job = store.claimArchiveJob(id, 'latest', true)!;
  ids = store.pendingArchiveItems(id, job.refreshAfter);
  assert.equal(ids.length, 16);
  store.refreshArchiveItems(job, ids.map(id => ({ ...item(id), sourceRevision: { generation: 'source', sequence: 2 } })), ids);
  assert.deepEqual(store.pendingArchiveItems(id, null), []);
  assert.ok(store.archiveJobs(id).every(job => job.error === null));
});

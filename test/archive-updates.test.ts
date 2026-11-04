import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { HistoryChanges, NativeItem } from '../src/harness/types.ts';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createStorageClient } from '../src/server/storage-client.ts';
import { createWorkbenchStore, type WorkbenchChange } from '../src/server/workbench-store.ts';

const configuration = { modelId: 'fixture', permissionId: 'fixture' };
const binding = { id: 'native-fixture', cwd: '/synthetic', configuration, details: {} };
const item = (id: string, text = id, sequence = 1, generation = 'source'): NativeItem => ({
  id, text, kind: 'assistant', status: 'completed', sourceRevision: { generation, sequence },
});
const reference = (text: string) => ({ version: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) });
const page = (cursor: string, itemIds: string[] = [], hasMore = false): HistoryChanges => ({ cursor, itemIds, hasMore });

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-archive-updates-'));
  const db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const events: WorkbenchChange[] = [];
  let clock = 1_000;
  const store = createWorkbenchStore(db, { now: () => clock, onChange: event => events.push(event) });
  const id = randomUUID();
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration });
  store.saveBinding(id, binding);
  return { db, store, id, events, tick: () => { clock += 1_000; } };
}

test('incremental bodies, retained versions, cursor and notifications commit in one transaction', t => {
  const { db, store, id, events, tick } = fixture(t);
  store.mergeHistory(id, [item('old-item', 'original')]);
  const original = store.getItem(id, 'old-item');
  const job = store.claimArchiveJob(id, 'latest', true)!;
  assert.equal(store.commitArchiveUpdates(job, null, page('first'), []), true);
  const checkpoint = store.archiveUpdates(id), jobs = store.archiveJobs(id), version = store.version(), eventCount = events.length;
  const revised = item('old-item', 'corrected', 2);
  tick();

  // The first fault occurs after merging the body; the second occurs after
  // updating the watermark. Both must roll back the whole publication.
  for (const sql of [
    "CREATE TRIGGER fail_update_publication BEFORE UPDATE OF cursor ON workbench_archive_updates BEGIN SELECT RAISE(ABORT,'synthetic watermark failure'); END",
    "CREATE TRIGGER fail_update_publication BEFORE UPDATE OF working ON workbench_archive_jobs BEGIN SELECT RAISE(ABORT,'synthetic post-watermark failure'); END",
  ]) {
    db.exec(sql);
    assert.throws(() => store.commitArchiveUpdates(job, 'first', page('second', ['old-item']), [revised]));
    assert.deepEqual(store.archiveUpdates(id), checkpoint);
    assert.deepEqual(store.archiveJobs(id), jobs);
    assert.deepEqual(store.getItem(id, 'old-item'), original);
    assert.equal(Buffer.from(store.readBody(id, 'old-item', 'text', reference('original')).data).toString(), 'original');
    assert.throws(() => store.readBody(id, 'old-item', 'text', reference('corrected')), { code: 'body_not_found' });
    assert.equal(db.prepare('SELECT count(*) n FROM workbench_body_refs').get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM workbench_bodies').get()!.n, 0);
    assert.equal(store.version(), version);
    assert.equal(events.length, eventCount);
    db.exec('DROP TRIGGER fail_update_publication');
  }

  assert.equal(store.commitArchiveUpdates(job, 'first', page('second', ['old-item']), [revised]), true);
  assert.deepEqual(store.archiveUpdates(id), { cursor: 'second', complete: true, lastSuccessAt: 2_000 });
  assert.equal(store.getItem(id, 'old-item')!.text, 'corrected');
  assert.equal(Buffer.from(store.readBody(id, 'old-item', 'text', reference('original')).data).toString(), 'original');
  assert.equal(db.prepare('SELECT count(*) n FROM workbench_body_refs').get()!.n, 1);
  assert.equal(store.version(), version + 1);
  assert.equal(events.length, eventCount + 1);
});

test('stale epochs, cursors and every persisted binding identity refuse incremental publication', t => {
  const { db, store, id } = fixture(t);
  store.mergeHistory(id, [item('known', 'original')]);
  const oldJob = store.claimArchiveJob(id, 'latest', true)!;
  assert.equal(store.commitArchiveUpdates(oldJob, null, page('first'), []), true);
  const job = store.claimArchiveJob(id, 'latest', true)!;
  const checkpoint = store.archiveUpdates(id), version = store.version();
  const revised = [item('known', 'incorrect stale publication', 2)];
  const unchanged = () => {
    assert.deepEqual(store.archiveUpdates(id), checkpoint);
    assert.equal(store.getItem(id, 'known')!.text, 'original');
    assert.equal(store.version(), version);
  };
  assert.equal(store.commitArchiveUpdates(oldJob, 'first', page('stale-epoch', ['known']), revised), false);
  assert.equal(store.commitArchiveUpdates(job, null, page('stale-cursor', ['known']), revised), false);
  assert.equal(store.commitArchiveUpdates({ ...job, bindingId: 'another-native-binding' }, 'first', page('wrong-binding', ['known']), revised), false);
  unchanged();

  // Deliberate local fault injection verifies each independent durable fence;
  // no normal API permits replacing an already registered native binding.
  db.prepare("UPDATE workbench_archive_jobs SET binding_id=? WHERE conversation_id=? AND kind='latest'").run('different-job-binding', id);
  assert.equal(store.commitArchiveUpdates(job, 'first', page('wrong-job-binding', ['known']), revised), false);
  unchanged();
  db.prepare("UPDATE workbench_archive_jobs SET binding_id=? WHERE conversation_id=? AND kind='latest'").run(binding.id, id);
  db.prepare('UPDATE workbench_archive_updates SET binding_id=? WHERE conversation_id=?').run('different-watermark-binding', id);
  assert.equal(store.commitArchiveUpdates(job, 'first', page('wrong-watermark-binding', ['known']), revised), false);
  unchanged();
  db.prepare('UPDATE workbench_archive_updates SET binding_id=? WHERE conversation_id=?').run(binding.id, id);
  db.prepare('UPDATE workbench_conversations SET binding_json=? WHERE id=?').run(JSON.stringify({ ...binding, id: 'different-conversation-binding' }), id);
  assert.equal(store.commitArchiveUpdates(job, 'first', page('wrong-conversation-binding', ['known']), revised), false);
  unchanged();
});

test('unknown and live-only IDs block the whole watermark until chronological history establishes their order', t => {
  const { store, id } = fixture(t);
  store.mergeHistory(id, [item('first', 'original')]);
  const job = store.claimArchiveJob(id, 'latest', true)!;
  const updates = [item('first', 'corrected', 2), item('later', 'later final', 2)];
  const checkpoint = store.archiveUpdates(id), version = store.version();
  assert.throws(() => store.commitArchiveUpdates(job, null, page('next', ['first', 'later']), updates), { code: 'archive_update_waiting_for_history' });
  assert.deepEqual(store.archiveUpdates(id), checkpoint);
  assert.equal(store.getItem(id, 'first')!.text, 'original');
  assert.equal(store.version(), version);
  store.saveLiveItem(id, item('later', 'live only'));
  assert.throws(() => store.commitArchiveUpdates(job, null, page('next', ['first', 'later']), updates), { code: 'archive_update_waiting_for_history' });
  assert.deepEqual(store.archiveUpdates(id), checkpoint);
  assert.equal(store.getItem(id, 'first')!.text, 'original');
  assert.equal(store.hasHistoryItem(id, 'later'), false);
  store.mergeHistory(id, [item('later', 'chronological')]);
  assert.equal(store.commitArchiveUpdates(job, null, page('next', ['first', 'later']), updates), true);
  assert.deepEqual(store.readHistory(id).items.map(value => [value.id, value.text]), [['first', 'corrected'], ['later', 'later final']]);
});

test('reverse change-feed order updates both revisions without changing chronological order', t => {
  const { db, store, id, events } = fixture(t);
  store.mergeHistory(id, [item('a', 'old a'), item('b', 'old b')]);
  const job = store.claimArchiveJob(id, 'latest', true)!;
  const checkpoint = store.archiveUpdates(id), version = store.version(), eventCount = events.length;
  const updates = [item('b', 'new b', 2), item('a', 'new a', 3)];
  const content = () => store.readHistory(id).items.map(value => [value.id, value.text, value.sourceRevision!.sequence]);

  db.exec("CREATE TRIGGER fail_reverse_update BEFORE UPDATE OF cursor ON workbench_archive_updates BEGIN SELECT RAISE(ABORT,'synthetic reverse-page checkpoint failure'); END");
  assert.throws(() => store.commitArchiveUpdates(job, null, page('reverse-page', ['b', 'a']), updates));
  assert.deepEqual(content(), [['a', 'old a', 1], ['b', 'old b', 1]]);
  assert.deepEqual(store.archiveUpdates(id), checkpoint);
  assert.equal(store.version(), version);
  assert.equal(events.length, eventCount);
  assert.equal(db.prepare('SELECT count(*) n FROM workbench_body_refs').get()!.n, 0);
  db.exec('DROP TRIGGER fail_reverse_update');

  assert.equal(store.commitArchiveUpdates(job, null, page('reverse-page', ['b', 'a']), updates), true);
  assert.deepEqual(content(), [['a', 'new a', 3], ['b', 'new b', 2]]);
  assert.deepEqual(store.archiveUpdates(id), { cursor: 'reverse-page', complete: true, lastSuccessAt: 1_000 });
  assert.equal(store.version(), version + 1);
  assert.equal(events.length, eventCount + 1);
  for (const [itemId, text] of [['a', 'old a'], ['b', 'old b']] as const)
    assert.equal(Buffer.from(store.readBody(id, itemId, 'text', reference(text)).data).toString(), text);
});

test('incremental identity lists and item bodies must match exactly within the bounded page', t => {
  const { store, id } = fixture(t);
  store.mergeHistory(id, [item('one'), item('two')]);
  const job = store.claimArchiveJob(id, 'latest', true)!;
  const checkpoint = store.archiveUpdates(id), version = store.version();
  for (const [ids, values] of [
    [['one', 'one'], [item('one'), item('one')]],
    [['one', 'two'], [item('one'), item('one')]],
    [['one'], [item('two')]],
    [['one', 'two'], [item('one')]],
  ] as [string[], NativeItem[]][]) {
    assert.throws(() => store.commitArchiveUpdates(job, null, page('next', ids), values), { code: 'archive_update_identity_changed' });
  }
  assert.throws(() => store.commitArchiveUpdates({ ...job, kind: 'backfill' }, null, page('next'), []), { code: 'archive_update_identity_changed' });
  const tooMany = Array.from({ length: 17 }, (_, index) => item(`entry-${index}`));
  assert.throws(() => store.commitArchiveUpdates(job, null, page('next', tooMany.map(value => value.id)), tooMany));
  assert.deepEqual(store.archiveUpdates(id), checkpoint);
  assert.equal(store.version(), version);
});

test('empty nonterminal pages advance without false completeness and a stationary nonterminal cursor is rejected', t => {
  const { store, id, tick } = fixture(t);
  const job = store.claimArchiveJob(id, 'latest', true)!;
  assert.deepEqual(store.archiveUpdates(id), { cursor: null, complete: false, lastSuccessAt: null });
  assert.equal(store.commitArchiveUpdates(job, null, page('empty-1', [], true), []), true);
  assert.deepEqual(store.archiveUpdates(id), { cursor: 'empty-1', complete: false, lastSuccessAt: 1_000 });
  assert.equal(store.archiveJobs(id).find(value => value.kind === 'latest')!.working, true);
  const version = store.version();
  assert.throws(() => store.commitArchiveUpdates(job, 'empty-1', page('empty-1', [], true), []), { code: 'history_no_progress' });
  assert.equal(store.archiveUpdates(id)!.cursor, 'empty-1');
  assert.equal(store.version(), version);
  tick();
  assert.equal(store.commitArchiveUpdates(job, 'empty-1', page('empty-2', [], true), []), true);
  assert.deepEqual(store.archiveUpdates(id), { cursor: 'empty-2', complete: false, lastSuccessAt: 2_000 });
  assert.equal(store.commitArchiveUpdates(job, 'empty-2', page('empty-2'), []), true);
  assert.deepEqual(store.archiveUpdates(id), { cursor: 'empty-2', complete: true, lastSuccessAt: 2_000 });
  assert.equal(store.archiveJobs(id).find(value => value.kind === 'latest')!.working, false);
});

test('cursor reset is fenced, retains bodies and records uncertain continuity without erasing last success', t => {
  const { store, id } = fixture(t);
  store.mergeHistory(id, [item('known', 'retained')]);
  const oldJob = store.claimArchiveJob(id, 'latest', true)!;
  store.commitArchiveUpdates(oldJob, null, page('expired'), []);
  const job = store.claimArchiveJob(id, 'latest', true)!;
  const checkpoint = store.archiveUpdates(id), version = store.version();
  for (const [candidate, cursor] of [
    [oldJob, 'expired'], [job, 'another-cursor'], [{ ...job, bindingId: 'another-binding' }, 'expired'], [{ ...job, kind: 'backfill' as const }, 'expired'],
  ] as const) store.resetArchiveUpdates(candidate, cursor);
  assert.deepEqual(store.archiveUpdates(id), checkpoint);
  assert.equal(store.version(), version);
  store.resetArchiveUpdates(job, 'expired');
  assert.deepEqual(store.archiveUpdates(id), { cursor: null, complete: false, lastSuccessAt: 1_000 });
  assert.equal(store.archiveJobs(id).find(value => value.kind === 'latest')!.coverageError, 'archive_continuity_unverified');
  assert.equal(store.getItem(id, 'known')!.text, 'retained');
  assert.equal(store.commitArchiveUpdates(job, 'expired', page('late'), []), false);
  assert.equal(store.commitArchiveUpdates(job, null, page('restarted'), []), true);
  assert.equal(store.archiveJobs(id).find(value => value.kind === 'latest')!.coverageError, 'archive_continuity_unverified');
});

test('claiming latest revokes updates completeness before a new chronological head can publish', t => {
  const { store, id } = fixture(t);
  store.mergeHistory(id, [item('old-head')]);
  const first = store.claimArchiveJob(id, 'latest', true)!;
  store.commitArchivePage(first, [item('old-head')], null);
  store.commitArchiveUpdates(first, null, page('caught-up'), []);
  assert.equal(store.archiveJobs(id).find(value => value.kind === 'latest')!.updatesComplete, true);
  store.claimArchiveJob(id, 'backfill', true);
  assert.equal(store.archiveUpdates(id)!.complete, true, 'an unrelated backfill claim does not revoke the update checkpoint');
  const next = store.claimArchiveJob(id, 'latest', true)!;
  assert.deepEqual(store.archiveUpdates(id), { cursor: 'caught-up', complete: false, lastSuccessAt: 1_000 });
  assert.equal(store.archiveJobs(id).find(value => value.kind === 'latest')!.updatesComplete, false);
  store.commitArchivePage(next, [item('old-head'), item('new-head')], null);
  assert.equal(store.archiveUpdates(id)!.complete, false, 'publishing a new head cannot complete the old-item change feed');
  assert.equal(store.commitArchiveUpdates(first, 'caught-up', page('stale-completion'), []), false);
  assert.equal(store.commitArchiveUpdates(next, 'caught-up', page('caught-up-again'), []), true);
  assert.equal(store.archiveJobs(id).find(value => value.kind === 'latest')!.updatesComplete, true);
});

test('a change-feed generation gap retains the archived body and cannot erase the coverage error', t => {
  const { store, id } = fixture(t);
  const original = item('same-id', 'original immutable source', 9, 'source-before-replacement');
  store.mergeHistory(id, [original]);
  const stored = store.getItem(id, 'same-id');
  const job = store.claimArchiveJob(id, 'latest', true)!;
  assert.equal(store.commitArchiveUpdates(job, null, page('replacement-watermark', ['same-id']), [item('same-id', 'unrelated replacement source', 1, 'replacement-source')]), true);
  assert.deepEqual(store.getItem(id, 'same-id'), stored);
  assert.equal(Buffer.from(store.readBody(id, 'same-id', 'text', reference(original.text)).data).toString(), original.text);
  assert.equal(store.archiveUpdates(id)!.complete, true, 'feed exhaustion is distinct from continuous source coverage');
  assert.equal(store.archiveJobs(id).find(value => value.kind === 'latest')!.coverageError, 'archive_source_gap');
  assert.equal(store.commitArchiveUpdates(job, 'replacement-watermark', page('later-empty-page'), []), true);
  assert.equal(store.archiveJobs(id).find(value => value.kind === 'latest')!.coverageError, 'archive_source_gap');
});

test('the real storage worker preserves update cursors, revised bodies and reset state across restarts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-archive-updates-worker-'));
  const clients: ReturnType<typeof createStorageClient>[] = [];
  t.after(async () => { try { for (const client of clients) await client.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const start = async () => { const client = createStorageClient({ dataDirectory: root }); clients.push(client); await client.ready; return client.store; };
  let store = await start();
  const id = randomUUID();
  await store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration });
  await store.saveBinding(id, binding);
  await store.mergeHistory(id, [item('old-item', 'original')]);
  const first = (await store.claimArchiveJob(id, 'latest', true))!;
  assert.equal(await store.commitArchiveUpdates(first, null, page('durable-watermark', ['old-item'], true), [item('old-item', 'corrected', 2)]), true);
  const checkpoint = await store.archiveUpdates(id);
  await clients[0]!.close();
  store = await start();
  assert.deepEqual(await store.archiveUpdates(id), checkpoint);
  assert.equal((await store.getItem(id, 'old-item'))!.text, 'corrected');
  assert.equal(Buffer.from((await store.readBody(id, 'old-item', 'text', reference('original'))).data).toString(), 'original');
  const next = (await store.claimArchiveJob(id, 'latest', true))!;
  assert.equal(await store.commitArchiveUpdates(first, 'durable-watermark', page('stale-worker'), []), false);
  assert.equal(await store.commitArchiveUpdates(next, 'durable-watermark', page('caught-up'), []), true);
  assert.equal((await store.archiveUpdates(id))!.complete, true);
  await store.resetArchiveUpdates(next, 'caught-up');
  const reset = await store.archiveUpdates(id);
  await clients[1]!.close();
  store = await start();
  assert.deepEqual(await store.archiveUpdates(id), reset);
  assert.equal(reset!.cursor, null); assert.equal(reset!.complete, false); assert.ok(reset!.lastSuccessAt);
  assert.equal((await store.archiveJobs(id)).find(value => value.kind === 'latest')!.coverageError, 'archive_continuity_unverified');
  assert.equal((await store.getItem(id, 'old-item'))!.text, 'corrected');
});

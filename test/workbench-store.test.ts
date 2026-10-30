import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { Binding, NativeItem } from '../src/harness/types.ts';
import { backupDatabase, openDatabase, restoreDatabase } from '../src/server/database.ts';
import { afterProductRestore, productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore, type CreateConversation, type OperationInput, type WorkbenchChange } from '../src/server/workbench-store.ts';
import { stateSchema } from '../src/shared/workbench.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'zhongshu-workbench-'));
  const connections = new Set<DatabaseSync>();
  const open = () => { const db = openDatabase(directory, productMigrations); connections.add(db); return db; };
  const close = (db: DatabaseSync) => { db.close(); connections.delete(db); };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, open, close };
}
function conversation(): CreateConversation {
  return { id: randomUUID(), harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic/workspace', configuration: { modelId: 'fixture-model', permissionId: 'workspace' } };
}
function binding(input: CreateConversation): Binding {
  return { id: 'native-' + randomUUID(), cwd: input.cwd, configuration: input.configuration, details: { nativeOption: true } };
}
function item(id: string, text = id): NativeItem { return { id, kind: 'assistant', text, status: 'completed' }; }
function message(conversationId: string): OperationInput { return { id: randomUUID(), conversationId, type: 'message', payload: { text: 'synthetic user input' } }; }

test('conversation identity/configuration and an early native binding survive partial initialization and reopen', t => {
  const f = fixture(t); let db = f.open(); let store = createWorkbenchStore(db); const input = conversation();
  const created = store.createConversation(input); assert.equal(created.created, true); assert.equal(created.conversation.title, '新对话');
  assert.equal(created.conversation.readiness, 'preparing'); assert.equal(created.conversation.historyLoaded, false);
  assert.throws(() => store.setConversationState(input.id, { readiness: 'ready' }), { code: 'native_binding_required' });
  const native = binding(input); store.saveBinding(input.id, native);
  store.setConversationState(input.id, { readiness: 'blocked', error: 'native_configuration_failed' });
  f.close(db); db = f.open(); store = createWorkbenchStore(db);
  const reused = store.createConversation(input);
  assert.equal(reused.created, false); assert.equal(reused.conversation.binding?.id, native.id);
  assert.equal(reused.conversation.readiness, 'blocked'); assert.equal(reused.conversation.error, 'native_configuration_failed');
  assert.throws(() => store.createConversation({ ...input, configuration: { ...input.configuration, modelId: 'other-model' } }), { statusCode: 409 });
  assert.throws(() => store.saveBinding(input.id, { ...native, id: 'second-native-identity' }), { code: 'native_binding_conflict', statusCode: 409 });
  assert.throws(() => store.saveBinding(input.id, { ...native, cwd: '/another/workspace' }), { code: 'binding_configuration_conflict' });
  store.setConversationState(input.id, { readiness: 'ready', state: { status: 'idle', pendingInputs: 0, configurationVerified: true }, error: null });
  assert.equal(store.getConversation(input.id)?.readiness, 'ready');
});

test('target terminal proof persists with bounded identifiers, and a later state without proof clears it', t => {
  const f = fixture(t); let db = f.open(); let store = createWorkbenchStore(db); const input = conversation();
  store.createConversation(input); store.saveBinding(input.id, binding(input));
  const state = { status: 'idle' as const, runId: 'notification-run', terminalRunId: 'user-run', pendingInputs: 0, configurationVerified: true };
  store.setConversationState(input.id, { readiness: 'ready', state });
  f.close(db); db = f.open(); store = createWorkbenchStore(db);
  assert.deepEqual(store.getConversation(input.id)?.state, state); assert.deepEqual(stateSchema.parse(state), state);
  for (const terminalRunId of ['', 'x'.repeat(1025), 'invalid\0id']) {
    assert.equal(stateSchema.safeParse({ ...state, terminalRunId }).success, false);
    assert.throws(() => store.setConversationState(input.id, { state: { ...state, terminalRunId } }));
  }
  const { terminalRunId: _proof, ...unproved } = state;
  store.setConversationState(input.id, { state: unproved });
  assert.equal(store.getConversation(input.id)?.state.terminalRunId, undefined);
});

test('globally unique operation IDs compare exact content and only a queued claim permits dispatch', t => {
  const f = fixture(t); const db = f.open(); const store = createWorkbenchStore(db); const a = conversation(); const b = conversation();
  store.createConversation(a); store.createConversation(b); const operation = message(a.id);
  const first = store.enqueueOperation(operation); assert.equal(first.created, true); assert.equal(first.operation.status, 'queued');
  assert.equal(store.enqueueOperation(operation).created, false);
  assert.throws(() => store.enqueueOperation({ ...operation, conversationId: b.id }), { code: 'operation_id_conflict', statusCode: 409 });
  assert.throws(() => store.enqueueOperation({ ...operation, type: 'message', payload: { text: 'changed text' } }), { code: 'operation_id_conflict' });
  assert.throws(() => store.settleOperation(operation.id, { outcome: 'accepted' }), { code: 'operation_not_claimed' });
  assert.equal(store.claimOperation(operation.id)?.status, 'dispatching'); assert.equal(store.claimOperation(operation.id), null);
  store.settleOperation(operation.id, { outcome: 'unknown', reason: 'reply_lost' }); assert.equal(store.claimOperation(operation.id), null);
  store.settleOperation(operation.id, { outcome: 'accepted', runId: 'native-run' });
  assert.equal(store.settleOperation(operation.id, { outcome: 'accepted', runId: 'native-run' }).runId, 'native-run');
  assert.throws(() => store.settleOperation(operation.id, { outcome: 'rejected', reason: 'late-failure' }), { code: 'operation_result_conflict' });
  const stop: OperationInput = { id: randomUUID(), conversationId: a.id, type: 'stop', payload: { runId: 'native-run' } };
  store.enqueueOperation(stop); store.claimOperation(stop.id); store.settleOperation(stop.id, { outcome: 'accepted' });
  assert.deepEqual(store.getOperation(stop.id)?.payload, { runId: 'native-run' });
});

const childCode = `
  const { openDatabase } = await import(process.env.TEST_DATABASE_MODULE);
  const { productMigrations } = await import(process.env.TEST_MIGRATIONS_MODULE);
  const { createWorkbenchStore } = await import(process.env.TEST_STORE_MODULE);
  const db = openDatabase(process.env.TEST_DIRECTORY, productMigrations);
  const store = createWorkbenchStore(db);
  process.send({ready:true});
  process.once('message', request => {
    try {
      const result = store.enqueueOperation(request.operation);
      const claimed = store.claimOperation(request.operation.id);
      process.send({created:result.created,claimed:claimed !== null});
      if (request.hold) setInterval(() => {}, 1000);
      else { db.close(); process.disconnect(); }
    } catch (error) { process.send({error:error.code || 'worker_failed'}); db.close(); process.disconnect(); }
  });
`;
async function worker(t: TestContext, directory: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { env: {
    TEST_DIRECTORY: directory,
    TEST_DATABASE_MODULE: new URL('../src/server/database.ts', import.meta.url).href,
    TEST_MIGRATIONS_MODULE: new URL('../src/server/migrations.ts', import.meta.url).href,
    TEST_STORE_MODULE: new URL('../src/server/workbench-store.ts', import.meta.url).href,
  }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('worker_exited_before_ready'); })]);
  assert.deepEqual(message[0], { ready: true }); return child;
}

test('two real processes race to enqueue and claim: one durable dispatch winner', { timeout: 15_000 }, async t => {
  const f = fixture(t); const db = f.open(); const store = createWorkbenchStore(db); const input = conversation(); store.createConversation(input);
  const operation = message(input.id); const [a, b] = await Promise.all([worker(t, f.directory), worker(t, f.directory)]);
  const results = [once(a, 'message'), once(b, 'message')]; const exits = [once(a, 'exit'), once(b, 'exit')];
  a.send({ operation }); b.send({ operation });
  const received = (await Promise.all(results)).map(result => result[0] as { created: boolean; claimed: boolean; error?: string });
  assert.equal(received.filter(result => result.error).length, 0);
  assert.equal(received.filter(result => result.created).length, 1); assert.equal(received.filter(result => result.claimed).length, 1);
  await Promise.all(exits);
  assert.equal(store.getOperation(operation.id)?.status, 'dispatching');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workbench_operations').get()?.count, 1);
});

test('SIGKILL after durable claim becomes unknown on explicit startup recovery; queued and terminal results remain intact', { timeout: 15_000 }, async t => {
  const f = fixture(t); let db = f.open(); let store = createWorkbenchStore(db); const input = conversation(); store.createConversation(input);
  const queued = message(input.id); const accepted = message(input.id); const rejected = message(input.id); const unknown = message(input.id);
  for (const operation of [queued, accepted, rejected, unknown]) store.enqueueOperation(operation);
  store.claimOperation(accepted.id); store.settleOperation(accepted.id, { outcome: 'accepted', runId: 'complete-run' });
  store.settleOperation(rejected.id, { outcome: 'rejected', reason: 'local_validation' });
  store.claimOperation(unknown.id); store.settleOperation(unknown.id, { outcome: 'unknown', reason: 'original_unknown_reason' });
  const operation = message(input.id); const child = await worker(t, f.directory); const claimed = once(child, 'message');
  child.send({ operation, hold: true }); assert.deepEqual((await claimed)[0], { created: true, claimed: true });
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  f.close(db); db = f.open(); store = createWorkbenchStore(db);
  assert.equal(store.getOperation(operation.id)?.status, 'dispatching'); assert.equal(store.recoverDispatching(), 1); assert.equal(store.recoverDispatching(), 0);
  assert.equal(store.getOperation(operation.id)?.status, 'unknown'); assert.equal(store.claimOperation(operation.id), null);
  assert.equal(store.getOperation(queued.id)?.status, 'queued'); assert.equal(store.getOperation(accepted.id)?.status, 'accepted');
  assert.equal(store.getOperation(rejected.id)?.status, 'rejected'); assert.equal(store.getOperation(unknown.id)?.reason, 'original_unknown_reason');
});

test('operation listing is bounded and paginated across status and conversation filters', t => {
  const f = fixture(t); const store = createWorkbenchStore(f.open(), { now: () => 1000 }); const a = conversation(); const b = conversation();
  store.createConversation(a); store.createConversation(b);
  const ids: string[] = [];
  for (let n = 0; n < 7; n++) { const operation = message(n % 2 ? a.id : b.id); ids.push(operation.id); store.enqueueOperation(operation); }
  const first = store.listOperations({ status: 'queued', limit: 3 }); const second = store.listOperations({ status: 'queued', afterId: first.at(-1)!.id, limit: 3 });
  const third = store.listOperations({ status: 'queued', afterId: second.at(-1)!.id, limit: 3 });
  assert.deepEqual([...first, ...second, ...third].map(operation => operation.id), ids);
  assert.equal(store.listOperations({ conversationId: a.id, status: 'queued' }).length, 3);
  assert.throws(() => store.listOperations({ limit: 1001 }), { statusCode: 400 });
});

test('operation pagination follows durable insertion sequence despite tied timestamps and reverse UUID order', t => {
  const f = fixture(t); let at = 1000; const store = createWorkbenchStore(f.open(), { now: () => at });
  const a = conversation(); const b = conversation(); store.createConversation(a); store.createConversation(b);
  const messages: string[] = [];
  for (let n = 0; n < 6; n++) {
    if (n === 3) at++;
    const operation = message(a.id);
    if (n === 0) operation.id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    if (n === 1) operation.id = '00000000-0000-4000-8000-000000000001';
    messages.push(operation.id); store.enqueueOperation(operation);
    store.enqueueOperation({ id: randomUUID(), conversationId: a.id, type: 'stop', payload: { runId: 'run-' + n } });
  }
  store.enqueueOperation(message(b.id));
  const expected = [...messages];
  assert.ok(store.getOperation(messages[0]!)!.sequence < store.getOperation(messages[1]!)!.sequence);
  assert.ok(messages[0]! > messages[1]!);
  for (const order of ['asc', 'desc'] as const) {
    const found: string[] = []; let afterId: string | undefined;
    for (;;) {
      const page = store.listOperations({ conversationId: a.id, type: 'message', order, limit: 2, ...(afterId ? { afterId } : {}) });
      if (!page.length) break;
      found.push(...page.map(row => row.id)); afterId = page.at(-1)!.id;
    }
    assert.deepEqual(found, order === 'asc' ? expected : [...expected].reverse());
  }
  assert.deepEqual(store.listOperations({ conversationId: a.id, type: 'message' }).map(row => row.id), expected);
  assert.equal(store.listOperations({ conversationId: a.id, type: 'message', order: 'desc', limit: 1 })[0]?.id, expected.at(-1));
  const accepted = messages[0]!; store.claimOperation(accepted); store.settleOperation(accepted, { outcome: 'accepted', runId: 'terminal-run' });
  for (const order of ['asc', 'desc'] as const) {
    assert.deepEqual(store.listOperations({ conversationId: a.id, status: 'accepted', type: 'message', order }).map(row => row.id), [accepted]);
    assert.deepEqual(store.listOperations({ status: 'accepted', type: 'message', order }).map(row => row.id), [accepted]);
    assert.equal(store.listOperations({ type: 'stop', order }).length, 6);
  }
});

test('canonical history merges chronological pages and overlap, while live remains separate until canonical arrives', t => {
  const f = fixture(t); const db = f.open(); const store = createWorkbenchStore(db); const input = conversation(); store.createConversation(input);
  assert.equal(store.readHistory(input.id).historyLoaded, false);
  store.saveLiveItem(input.id, { ...item('live', 'partial streamed body'), status: 'running' });
  store.saveLiveItem(input.id, item('live', 'complete streamed body'));
  assert.equal(store.readHistory(input.id).items.length, 0); assert.equal(store.getItem(input.id, 'live')?.text, 'complete streamed body');
  store.mergeHistory(input.id, [item('d'), item('e')]); store.setHistoryCursor(input.id, { loaded: true, olderCursor: 'native-page-1', beforeItemId: 'd' });
  store.mergeHistory(input.id, [item('b'), item('c')], 'd');
  store.mergeHistory(input.id, [item('a'), item('b', 'updated-b'), item('c')], 'd');
  store.mergeHistory(input.id, [item('d'), item('e', 'updated-e'), item('live', 'authoritative complete body')]);
  assert.deepEqual(store.readHistory(input.id).items.map(row => row.id), ['a', 'b', 'c', 'd', 'e', 'live']);
  assert.equal(store.readHistory(input.id).liveItems.length, 0); assert.equal(store.getItem(input.id, 'live')?.text, 'authoritative complete body');
  assert.equal(store.getItem(input.id, 'b')?.text, 'updated-b');
  const snapshot = store.readHistory(input.id, { limit: 2 }); assert.deepEqual(snapshot.items.map(row => row.id), ['e', 'live']); assert.equal(snapshot.olderBeforeItemId, 'e');
  const older = store.readHistory(input.id, { beforeItemId: snapshot.olderBeforeItemId!, limit: 3 });
  assert.deepEqual(older.items.map(row => row.id), ['b', 'c', 'd']); assert.equal(older.olderBeforeItemId, 'b');
  assert.deepEqual(store.readHistory(input.id, { beforeItemId: 'b' }).items.map(row => row.id), ['a']);
  assert.equal(snapshot.nativeOlderCursor, 'native-page-1'); assert.equal(snapshot.nativeOlderBeforeItemId, 'd'); assert.equal(snapshot.historyLoaded, true);
  assert.throws(() => store.mergeHistory(input.id, [item('uncommitted')], 'missing-anchor'), { code: 'history_anchor_not_found' });
  assert.equal(store.getItem(input.id, 'uncommitted'), null);
});

test('body-only updates never rewrite positions; tightly packed insertion atomically compacts without losing items', t => {
  const f = fixture(t); const db = f.open(); const store = createWorkbenchStore(db); const input = conversation(); store.createConversation(input);
  store.mergeHistory(input.id, [item('left'), item('right')]);
  db.exec('CREATE TABLE position_updates (id TEXT) STRICT; CREATE TRIGGER track_position AFTER UPDATE OF position ON workbench_items BEGIN INSERT INTO position_updates VALUES(NEW.id); END;');
  store.mergeHistory(input.id, [item('left', 'new body'), item('right')]); store.saveLiveItem(input.id, { ...item('right', 'live full body'), status: 'running' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM position_updates').get()?.count, 0);
  store.mergeHistory(input.id, [item('left'), item('middle'), item('right')]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM position_updates').get()?.count, 0);
  db.prepare('UPDATE workbench_items SET position=1 WHERE conversation_id=? AND id=?').run(input.id, 'middle');
  db.prepare('UPDATE workbench_items SET position=2 WHERE conversation_id=? AND id=?').run(input.id, 'right');
  db.exec('DELETE FROM position_updates');
  store.mergeHistory(input.id, [item('left'), item('inserted'), item('middle')]);
  assert.deepEqual(store.readHistory(input.id).items.map(row => row.id), ['left', 'inserted', 'middle', 'right']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM position_updates WHERE id=?').get('left')?.count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM position_updates').get()?.count, 4);
});

test('native cursor and complete bodies survive restart without claiming a partially loaded history is complete', t => {
  const f = fixture(t); let db = f.open(); let store = createWorkbenchStore(db); const input = conversation(); store.createConversation(input);
  const text = '完整正文\n'.repeat(3000); store.mergeHistory(input.id, [item('latest', text)]);
  store.saveLiveItem(input.id, { ...item('streaming', text + 'next'), status: 'running' });
  store.setHistoryCursor(input.id, { loaded: true, olderCursor: 'opaque-provider-cursor', beforeItemId: 'latest' });
  const revision = store.version(); f.close(db); db = f.open(); store = createWorkbenchStore(db);
  const snapshot = store.readHistory(input.id); assert.equal(snapshot.revision, revision);
  assert.equal(snapshot.items[0]?.text, text); assert.equal(snapshot.liveItems[0]?.text, text + 'next');
  assert.equal(snapshot.olderBeforeItemId, null); assert.equal(snapshot.nativeOlderCursor, 'opaque-provider-cursor');
  assert.equal('historyComplete' in snapshot, false);
});

test('history capacity, text bytes, native details and live bounds fail explicitly without partial mutation', t => {
  const f = fixture(t); const db = f.open(); const store = createWorkbenchStore(db); const input = conversation(); store.createConversation(input);
  const insert = db.prepare("INSERT INTO workbench_items(conversation_id,id,position,kind,text,status) VALUES(?,?,?,'assistant','small body','completed')");
  db.exec('BEGIN IMMEDIATE'); for (let n = 0; n < 50_000; n++) insert.run(input.id, 'item-' + n, n * 1024); db.exec('COMMIT');
  const before = store.version();
  assert.throws(() => store.mergeHistory(input.id, [item('item-0', 'must roll back'), item('too-many')]), { code: 'history_capacity_reached' });
  assert.equal(store.getItem(input.id, 'item-0')?.text, 'small body'); assert.equal(store.version(), before);
  store.mergeHistory(input.id, [item('item-0', 'allowed update at capacity')]);
  assert.equal(store.getItem(input.id, 'item-0')?.text, 'allowed update at capacity');
  assert.throws(() => store.saveLiveItem(input.id, item('large', '中'.repeat(400_000))), { statusCode: 400 });
  assert.throws(() => store.mergeHistory(input.id, [item('large', 'a'.repeat(1_048_577))]), { statusCode: 400 });
  for (let n = 0; n < 100; n++) store.saveLiveItem(input.id, item('live-' + n));
  assert.throws(() => store.saveLiveItem(input.id, item('live-overflow')), { code: 'live_history_capacity_reached' });
  assert.equal(store.readHistory(input.id).items.length, 100); assert.equal(store.readHistory(input.id).liveItems.length, 100);
  const native = binding(input); const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => store.saveBinding(input.id, { ...native, details: cyclic }), { code: 'invalid_binding_details' });
  assert.equal(store.getConversation(input.id)?.binding, null);
});

test('change cursor is atomic, durable, bounded, body-free and gives an explicit reset outside retained history', t => {
  const f = fixture(t); let db = f.open(); const observer = f.open(); const callbacks: WorkbenchChange[] = [];
  let store = createWorkbenchStore(db, { onChange: event => {
    assert.equal(observer.prepare('SELECT sequence FROM workbench_changes WHERE sequence=?').get(event.sequence)?.sequence, event.sequence);
    callbacks.push(event);
  } });
  const input = conversation(); store.createConversation(input); const initial = store.version();
  store.createConversation(input); assert.equal(store.version(), initial);
  const operation = message(input.id); store.enqueueOperation(operation); const afterEnqueue = store.version();
  store.enqueueOperation(operation); assert.equal(store.version(), afterEnqueue);
  assert.throws(() => store.enqueueOperation({ ...operation, type: 'message', payload: { text: 'changed' } }), { statusCode: 409 });
  assert.equal(store.version(), afterEnqueue);
  store.saveLiveItem(input.id, item('live', 'body never copied into event'));
  assert.equal(callbacks.at(-1)?.itemId, 'live');
  const unchanged = store.version();
  store.saveLiveItem(input.id, item('live', 'body never copied into event'));
  store.setConversationState(input.id, { readiness: 'preparing' });
  store.mergeHistory(input.id, []);
  assert.equal(store.version(), unchanged);
  db.exec("CREATE TRIGGER reject_fixture_event BEFORE INSERT ON workbench_changes WHEN NEW.item_id='rollback-item' BEGIN SELECT RAISE(ABORT,'synthetic_event_failure'); END;");
  assert.throws(() => store.saveLiveItem(input.id, item('rollback-item', 'must not commit')), { code: 'workbench_storage_failed' });
  assert.equal(store.getItem(input.id, 'rollback-item'), null);
  assert.equal(store.version(), unchanged);
  db.exec('DROP TRIGGER reject_fixture_event');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM workbench_changes ORDER BY sequence').all()).includes('body never'), false);
  const version = store.version(); const replay = store.changes(0); assert.equal(replay.reset, false); assert.equal(replay.latest, version);
  assert.equal(replay.events.at(-1)?.itemId, 'live'); assert.equal(callbacks.length, version);
  f.close(db); db = f.open(); store = createWorkbenchStore(db);
  assert.deepEqual(store.changes(0), replay);
  for (let n = 0; n < 2001; n++) store.saveLiveItem(input.id, item('live', 'update-' + n));
  const latest = store.version(); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workbench_changes').get()?.count, 2000);
  assert.equal(store.changes(0).reset, true); assert.equal(store.changes(latest + 1).reset, true);
  assert.equal(store.changes(latest - 2000).reset, false); assert.equal(store.changes(latest - 2000).events.length, 200);
  assert.deepEqual(store.changes(latest), { latest, reset: false, events: [] });
  const final = store.readHistory(input.id); assert.equal(final.revision, latest); assert.equal(final.liveItems[0]?.text, 'update-2000');
});


test('restoring a backup marks previously queued work unknown even if the original database dispatched it later', async t => {
  const f = fixture(t); const db = f.open(); const store = createWorkbenchStore(db); const input = conversation(); store.createConversation(input);
  const queued = message(input.id); const dispatching = message(input.id); const unknown = message(input.id); const accepted = message(input.id);
  for (const operation of [queued, dispatching, unknown, accepted]) store.enqueueOperation(operation);
  store.claimOperation(dispatching.id);
  store.claimOperation(unknown.id); store.settleOperation(unknown.id, { outcome: 'unknown', reason: 'original_reason' });
  store.claimOperation(accepted.id); store.settleOperation(accepted.id, { outcome: 'accepted', runId: 'already-accepted-run' });
  const originalOrder = store.listOperations().map(operation => ({ id: operation.id, sequence: operation.sequence }));
  const snapshotVersion = store.version(); const backup = join(f.directory, 'snapshot.sqlite'); await backupDatabase(db, backup);
  // This accepted native dispatch happened after the retained backup. Replaying its queued snapshot would duplicate work.
  store.claimOperation(queued.id); store.settleOperation(queued.id, { outcome: 'accepted', runId: 'post-backup-run' });
  const target = join(f.directory, 'restored'); await restoreDatabase(backup, target, afterProductRestore);
  const restored = openDatabase(target, productMigrations);
  try {
    const recovered = createWorkbenchStore(restored);
    assert.equal(recovered.getOperation(queued.id)?.status, 'unknown'); assert.equal(recovered.getOperation(dispatching.id)?.status, 'unknown');
    assert.equal(recovered.claimOperation(queued.id), null); assert.equal(recovered.claimOperation(dispatching.id), null);
    assert.equal(recovered.getOperation(unknown.id)?.reason, 'original_reason'); assert.equal(recovered.getOperation(accepted.id)?.status, 'accepted');
    assert.deepEqual(recovered.listOperations().map(operation => ({ id: operation.id, sequence: operation.sequence })), originalOrder);
    assert.equal(recovered.getConversation(input.id)?.state.status, 'unknown');
    assert.deepEqual(recovered.changes(snapshotVersion).events.map(event => event.conversationId), [input.id]);
    assert.equal(recovered.recoverDispatching(), 0);
    const next = message(input.id); assert.ok(recovered.enqueueOperation(next).operation.sequence > originalOrder.at(-1)!.sequence);
  } finally { restored.close(); }
});

test('a restore hook failure rolls back and never publishes the staging database', async t => {
  const f = fixture(t); const db = f.open(); const store = createWorkbenchStore(db); const input = conversation(); store.createConversation(input);
  const operation = message(input.id); store.enqueueOperation(operation);
  const backup = join(f.directory, 'snapshot.sqlite'); await backupDatabase(db, backup);
  const target = join(f.directory, 'failed-restore');
  await assert.rejects(restoreDatabase(backup, target, restored => {
    afterProductRestore(restored);
    throw new Error('synthetic_hook_failure');
  }), { code: 'restore_failed' });
  assert.equal(existsSync(join(target, 'zhongshu.sqlite')), false); assert.deepEqual(readdirSync(target), []);
  assert.equal(store.getOperation(operation.id)?.status, 'queued');
});

test('large history and live reads have byte bounds before HTTP serialization and retain complete paging', t => {
  const f = fixture(t); const store = createWorkbenchStore(f.open()); const input = conversation(); store.createConversation(input);
  const body = 'x'.repeat(512 * 1024); const records = Array.from({ length: 20 }, (_, index) => item('large-' + index, body));
  store.mergeHistory(input.id, records);
  const first = store.readHistory(input.id);
  assert(first.items.length > 0 && first.items.length < records.length);
  assert(first.items.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text) + 2048, 0) <= 8 * 1024 * 1024);
  assert.equal(first.items.at(-1)?.id, 'large-19'); assert(first.olderBeforeItemId);
  const older = store.readHistory(input.id, { beforeItemId: first.olderBeforeItemId });
  assert.deepEqual([...older.items, ...first.items].map(entry => entry.id), records.map(entry => entry.id));
  assert([...older.items, ...first.items].every(entry => entry.text === body));
  for (let index = 0; index < 12; index++) store.saveLiveItem(input.id, { ...item('live-' + index, body), status: 'running' });
  const live = store.readHistory(input.id); assert.equal(live.liveItemsLimited, true);
  assert(live.liveItems.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text) + 2048, 0) <= 4 * 1024 * 1024);
  assert(live.liveItems.every(entry => entry.text === body));
});

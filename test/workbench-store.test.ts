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
import { conversationCursor, createWorkbenchStore, type CreateConversation, type OperationInput, type WorkbenchChange } from '../src/server/workbench-store.ts';
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
  assert.equal(created.conversation.readiness, 'preparing');
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

test('change hints and edited paths persist without any history body (ADR 0014)', t => {
  const f = fixture(t); const db = f.open(); const store = createWorkbenchStore(db); const input = conversation(); store.createConversation(input);
  const before = store.version();
  store.touch(input.id, 'live-item');
  assert.equal(store.version(), before + 1); assert.equal(store.changes(before).events[0]?.itemId, 'live-item');
  store.touch(input.id); assert.equal(store.changes(before + 1).events[0]?.itemId, undefined);
  const edit: NativeItem = { id: 'edit', kind: 'tool', text: 'secret tool body', status: 'completed', runId: 'run-1', fileEdits: ['a.ts', 'b/c.ts'] };
  store.recordTurnFiles(input.id, [edit, item('plain', 'another secret body'), { ...edit, id: 'running', status: 'running', fileEdits: ['d.ts'] }]);
  assert.deepEqual(store.readTurnFiles(input.id, ['run-1']), [{ runId: 'run-1', paths: ['a.ts', 'b/c.ts'], limited: false }]);
  const unchanged = store.version(); store.recordTurnFiles(input.id, [edit]); assert.equal(store.version(), unchanged);
  for (const table of ['workbench_changes', 'workbench_turn_files'])
    assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes('secret'), false, table);
  assert.ok((['workbench_items', 'workbench_live_items'].every(name => !db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name))), 'no history body table exists');
  assert.throws(() => store.touch(randomUUID()), { statusCode: 404 });
  assert.throws(() => store.recordTurnFiles(input.id, [{ ...edit, fileEdits: ['../escape'] }]), { statusCode: 400 });
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
  store.touch(input.id, 'live');
  assert.equal(callbacks.at(-1)?.itemId, 'live');
  const unchanged = store.version();
  store.setConversationState(input.id, { readiness: 'preparing' });
  store.recordTurnFiles(input.id, []);
  assert.equal(store.version(), unchanged);
  db.exec("CREATE TRIGGER reject_fixture_event BEFORE INSERT ON workbench_changes WHEN NEW.item_id='rollback-item' BEGIN SELECT RAISE(ABORT,'synthetic_event_failure'); END;");
  assert.throws(() => store.touch(input.id, 'rollback-item'), { code: 'workbench_storage_failed' });
  assert.equal(store.version(), unchanged);
  db.exec('DROP TRIGGER reject_fixture_event');
  const version = store.version(); const replay = store.changes(0); assert.equal(replay.reset, false); assert.equal(replay.latest, version);
  assert.equal(replay.events.at(-1)?.itemId, 'live'); assert.equal(callbacks.length, version);
  f.close(db); db = f.open(); store = createWorkbenchStore(db);
  assert.deepEqual(store.changes(0), replay);
  for (let n = 0; n < 2001; n++) store.touch(input.id, 'live');
  const latest = store.version(); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workbench_changes').get()?.count, 2000);
  assert.equal(store.changes(0).reset, true); assert.equal(store.changes(latest + 1).reset, true);
  assert.equal(store.changes(latest - 2000).reset, false); assert.equal(store.changes(latest - 2000).events.length, 200);
  assert.deepEqual(store.changes(latest), { latest, reset: false, events: [] });
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

// Seed the historical format directly: migration evidence must not rely on today's Store
// being able to write a schema that predates its requirements.
function seedLegacyConversation(db: DatabaseSync, input: CreateConversation, at = 100, native: Binding | null = null) {
  db.prepare(`INSERT INTO workbench_conversations(id,harness_id,workspace_id,cwd,title,configuration_json,
    creation_digest,binding_json,readiness,state_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.id, input.harnessId, input.workspaceId, input.cwd, input.title ?? '旧对话', JSON.stringify(input.configuration),
    'historical-fixture', native ? JSON.stringify(native) : null, 'ready',
    JSON.stringify({ status: 'idle', pendingInputs: 0, configurationVerified: true }), at);
}

test('v3 conversation history upgrades to active and management metadata survives reopen', t => {
  const f = fixture(t);
  const input = { ...conversation(), title: '旧库原始标题' };
  const native = binding(input);
  const legacy = openDatabase(f.directory, productMigrations.filter(migration => migration.version < 4));
  try {
    seedLegacyConversation(legacy, input, 100, native);
    legacy.prepare('INSERT INTO workbench_items(conversation_id,id,position,kind,text,status) VALUES(?,?,?,?,?,?)')
      .run(input.id, 'legacy-entry', 1024, 'assistant', '旧库原文', 'completed');
  } finally { legacy.close(); }

  let db = f.open();
  let store = createWorkbenchStore(db);
  assert.deepEqual(store.listConversations({ archived: false }).map(entry => entry.id), [input.id]);
  assert.equal(store.getConversation(input.id)?.archived, false);
  store.renameConversation(input.id, '升级后的标题');
  store.setArchived(input.id, true, () => true);
  f.close(db);

  db = f.open();
  store = createWorkbenchStore(db);
  assert.deepEqual(store.listConversations({ archived: false }), []);
  assert.equal(store.listConversations({ archived: true })[0]?.title, '升级后的标题');
  assert.deepEqual(store.getConversation(input.id)?.binding, native);
  // Migration 16 removes the retired projection and its copied bodies (ADR 0014); management data survives.
  assert.ok((['workbench_items', 'workbench_live_items'].every(name => !db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name))));
});

test('migration 16 removes retired history bodies from v10 databases while conversations and operations survive', t => {
  const f = fixture(t); const input = conversation();
  const legacy = openDatabase(f.directory, productMigrations.filter(migration => migration.version <= 10));
  try {
    seedLegacyConversation(legacy, input);
    legacy.prepare('INSERT INTO workbench_items(conversation_id,id,position,kind,text,status) VALUES(?,?,?,?,?,?)').run(input.id, 'old-tool', 1024, 'tool', 'retired body', 'completed');
    legacy.prepare('INSERT INTO workbench_live_items(conversation_id,id,kind,text,status,updated_at) VALUES(?,?,?,?,?,?)').run(input.id, 'old-live', 'assistant', 'retired live body', 'running', 100);
  } finally { legacy.close(); }
  const db = f.open(); const store = createWorkbenchStore(db);
  assert.equal(store.getConversation(input.id)?.id, input.id);
  assert.ok((['workbench_items', 'workbench_live_items'].every(name => !db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name))));
  assert.equal(Number(db.prepare('SELECT MAX(version) AS v FROM app_migrations').get()!.v) >= 16, true);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
test('reasoning effort is immutable and optional legacy identities remain retryable', t => {
  const f = fixture(t); const store = createWorkbenchStore(f.open()); const legacy = conversation();
  store.createConversation(legacy); assert.equal(store.createConversation(legacy).created, false);
  const input = { ...conversation(), configuration: { ...legacy.configuration, reasoningEffort: 'high' } };
  store.createConversation(input); store.saveBinding(input.id, binding(input));
  assert.equal(store.getConversation(input.id)?.configuration.reasoningEffort, 'high');
  assert.equal(store.createConversation(input).created, false);
  assert.throws(() => store.createConversation({ ...input, configuration: legacy.configuration }), { code: 'conversation_id_conflict' });
  assert.throws(() => store.saveBinding(input.id, { ...binding(input), configuration: legacy.configuration }), { code: 'binding_configuration_conflict' });
});

test('conversation defaults use accepted messages and exclude archived or stale workspaces', t => {
  const f = fixture(t); const db = f.open(); const store = createWorkbenchStore(db);
  const a = conversation(); const b = conversation(); const unsent = conversation();
  for (const input of [a, b, unsent]) store.createConversation(input);
  const eligible = [{ id: a.workspaceId, directory: a.cwd }];
  assert.equal(store.recentAcceptedConversation(eligible, ['codex']), null);
  const send = (id: string) => {
    const op = message(id); store.enqueueOperation(op); store.claimOperation(op.id);
    store.settleOperation(op.id, { outcome: 'accepted' }); return op.id;
  };
  send(b.id); const latest = send(a.id);
  db.prepare('UPDATE workbench_operations SET updated_at = ? WHERE id = ?').run(Date.now() + 1000, latest);
  assert.equal(store.recentAcceptedConversation(eligible, ['codex'])?.id, a.id);
  const stop = { id: randomUUID(), conversationId: b.id, type: 'stop' as const, payload: { runId: 'run' } };
  store.enqueueOperation(stop); store.claimOperation(stop.id); store.settleOperation(stop.id, { outcome: 'accepted' });
  assert.equal(store.recentAcceptedConversation(eligible, ['codex'])?.id, a.id);
  store.setArchived(a.id, true, () => true);
  assert.equal(store.recentAcceptedConversation(eligible, ['codex'])?.id, b.id);
  assert.equal(store.recentAcceptedConversation([{ id: a.workspaceId, directory: '/moved' }], ['codex']), null);
  assert.equal(store.recentAcceptedConversation(eligible, ['dsh']), null);
});


test('conversation activity changes only on accepted messages using submission time, not late receipt time', t => {
  const db = fixture(t).open(); let clock = 100;
  const store = createWorkbenchStore(db, { now: () => clock });
  const a = conversation(); const b = conversation();
  store.createConversation(a); clock = 200; store.createConversation(b);
  const ids = () => store.listConversations().map(value => value.id);
  assert.deepEqual(ids(), [b.id, a.id]);
  clock = 300; store.getConversation(a.id); store.renameConversation(a.id, 'renamed');
  store.setArchived(a.id, true, () => true); store.setArchived(a.id, false, () => true);
  assert.deepEqual(ids(), [b.id, a.id]);
  const failed = message(a.id); store.enqueueOperation(failed); store.claimOperation(failed.id);
  store.settleOperation(failed.id, { outcome: 'rejected', reason: 'native rejected' });
  assert.deepEqual(ids(), [b.id, a.id]);
  clock = 400; const old = message(a.id); store.enqueueOperation(old); store.claimOperation(old.id);
  store.settleOperation(old.id, { outcome: 'unknown', reason: 'connection lost' });
  assert.deepEqual(ids(), [b.id, a.id]);
  clock = 500; const newer = message(b.id); store.enqueueOperation(newer); store.claimOperation(newer.id);
  store.settleOperation(newer.id, { outcome: 'accepted' });
  clock = 900; store.settleOperation(old.id, { outcome: 'accepted' });
  assert.equal(store.getConversation(a.id)?.lastActivityAt, 400);
  assert.deepEqual(ids(), [b.id, a.id]);
  clock = 1000; const last = message(a.id); store.enqueueOperation(last); store.claimOperation(last.id);
  store.settleOperation(last.id, { outcome: 'accepted' });
  assert.deepEqual(ids(), [a.id, b.id]);
  clock = 2000; store.settleOperation(last.id, { outcome: 'accepted' });
  assert.equal(store.getConversation(a.id)?.lastActivityAt, 1000);
});

test('conversation cursor survives anchor deletion and rejects a different query scope', t => {
  const db = fixture(t).open(); let clock = 10;
  const store = createWorkbenchStore(db, { now: () => clock });
  const values = Array.from({ length: 9 }, () => conversation());
  for (const value of values) { store.createConversation(value); clock += 10; }
  const query = { workspaceId: 'fixture', archived: false };
  const first = store.listConversations({ ...query, limit: 3 });
  const cursor = conversationCursor(first.at(-1)!, query);
  // A separate deletion removes the boundary row, including the old revision events.
  db.prepare('DELETE FROM workbench_conversations WHERE id=?').run(first.at(-1)!.id);
  const rest = store.listConversations({ ...query, beforeId: cursor });
  assert.deepEqual(rest.map(value => value.id), values.slice(0, 6).reverse().map(value => value.id));
  assert.throws(() => store.listConversations({ ...query, title: 'changed', beforeId: cursor }), { code: 'conversation_cursor_scope_changed' });
  assert.throws(() => store.listConversations({ ...query, beforeId: 'not-a-cursor' }), { code: 'invalid_conversation_cursor' });
});

test('activity migration uses accepted submission timestamps and equal-time pages have a stable tie break', t => {
  const f = fixture(t); const a = conversation(); const b = conversation(); const c = conversation();
  const legacy = openDatabase(f.directory, productMigrations.filter(migration => migration.version < 13));
  try {
    seedLegacyConversation(legacy, a, 100); seedLegacyConversation(legacy, b, 200); seedLegacyConversation(legacy, c, 200);
    legacy.prepare(`INSERT INTO workbench_operations(id,conversation_id,type,payload_json,digest,status,created_at,updated_at)
      VALUES(?,?,'message',?,'historical-fixture','accepted',300,900)`).run(randomUUID(), a.id, JSON.stringify({ text: 'accepted old message' }));
  } finally { legacy.close(); }
  const store = createWorkbenchStore(f.open());
  assert.equal(store.getConversation(a.id)?.lastActivityAt, 300);
  assert.equal(store.getConversation(b.id)?.lastActivityAt, 200);
  const first = store.listConversations({ limit: 2 });
  const second = store.listConversations({ beforeId: conversationCursor(first.at(-1)!) });
  assert.deepEqual([...first, ...second].map(value => value.id), [a.id, ...[b.id, c.id].sort().reverse()]);
});

import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type Serializable } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { backupDatabase, openDatabase, restoreDatabase } from '../src/server/database.ts';
import { afterProductRestore, productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore, type CreateConversation } from '../src/server/workbench-store.ts';
import { createWorkspaceStore } from '../src/server/workspace-store.ts';
import { createExecutionAdmissionHooks, createExecutionStore, type ExecutionStore } from '../src/server/execution-store.ts';
import type { ExecutionCursor, ExecutionGate, SaveWriteIdentity } from '../src/server/execution-coordinator.ts';
import { createStorageClient, StorageClientError } from '../src/server/storage-client.ts';
import { createPluginStore } from '../src/server/plugin-store.ts';

const proof = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revisions = (rows: ExecutionGate[]) => rows.map(({ groupId, revision }) => ({ groupId, revision }));
const initial = (groupId: string) => ({ groupId, generation: 'synthetic-controller-generation', epoch: 0, admission: 'open' as const, writers: 'running' as const, durable: true as const });
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'zhongshu-execution-store-'));
  const database = join(directory, 'database'); const connections = new Set<DatabaseSync>();
  const open = () => { const db = openDatabase(database, productMigrations); connections.add(db); return db; };
  const close = (db: DatabaseSync) => { db.close(); connections.delete(db); };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  const db = open(); const store = createExecutionStore(db); const workbench = createWorkbenchStore(db);
  const registerWorkspace = (id: string, relative: string) => {
    const path = join(directory, relative); mkdirSync(path, { recursive: true }); const info = statSync(path);
    const identity = `${info.dev}:${info.ino}`;
    createWorkspaceStore(db).register({ id, label: id, directory: path, identity, root_id: null, pinned: 0, removed: 0 });
    return { id, path, identity };
  };
  const workspace = registerWorkspace('workspace', 'workspace');
  const conversation = (target = workspace, bound = true): CreateConversation => {
    const input: CreateConversation = { id: randomUUID(), harnessId: 'codex', workspaceId: target.id, cwd: target.path, configuration: { modelId: 'synthetic-model', permissionId: 'workspace' } };
    workbench.createConversation(input);
    if (bound) workbench.saveBinding(input.id, { id: 'synthetic-native-' + input.id, cwd: input.cwd, configuration: input.configuration, details: {} });
    return input;
  };
  return { directory, database, db, store, workbench, workspace, open, close, registerWorkspace, conversation };
}
function initialize(store: ExecutionStore, groupId: string) {
  const checkpoint = store.beginBaseline(groupId);
  for (const source of ['operations', 'queues'] as const) {
    let after = 0;
    for (;;) {
      const page = store.seedLegacyAdmissions({ groupId, source, after, limit: 64, byteLimit: 128 * 1024 }); after = page.after;
      if (page.complete) break;
    }
  }
  let after: ExecutionCursor | undefined;
  for (;;) {
    const request = { groupId, through: checkpoint.through, after, limit: 8, byteLimit: 128 * 1024 };
    const page = store.bindingsPage(request);
    for (const binding of page.bindings) if (binding.bindingId) store.registerBaselineObservation({ groupId, through: checkpoint.through, after, conversationId: binding.id, wireDigest: proof(["baseline-wire", binding]) });
    assert.equal(store.commitBaselineBatch({ ...request, expectedRevision: store.load([groupId])[0]!.revision,
      observations: page.bindings.map(binding => ({ ...binding, state: binding.bindingId === null ? 'absent' : 'idle', proof: proof(['fresh-synthetic-native-observation', binding]) })), proof: proof(page) }), true);
    if (!page.nextCursor) break; after = page.nextCursor;
  }
}
function register(store: ExecutionStore, workspaceId: string, groupId = 'group') {
  store.registerGroup(initial(groupId)); store.registerScope({ workspaceId, groupId });
}
function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
/** These SQL mutations exercise the sync hook contract, not a user-path fixture. */
function enqueue(db: DatabaseSync, conversationId: string, operationId = randomUUID(), text = 'synthetic input') {
  return transaction(db, () => {
    db.prepare("INSERT INTO workbench_operations(id,conversation_id,type,payload_json,digest,status,created_at,updated_at) VALUES(?,?,'message',?,?,'queued',1,1)")
      .run(operationId, conversationId, JSON.stringify({ text }), proof([conversationId, text]));
    createExecutionAdmissionHooks(db).admitOperation(operationId); return operationId;
  });
}
function claim(db: DatabaseSync, operationId: string) {
  return transaction(db, () => {
    const updated = db.prepare("UPDATE workbench_operations SET status='dispatching' WHERE id=? AND status='queued'").run(operationId);
    return updated.changes ? createExecutionAdmissionHooks(db).claimOperation(operationId) : null;
  });
}
function revise(store: ExecutionStore, row: ExecutionGate, change: Partial<ExecutionGate>) {
  const next = { ...row, ...change, revision: row.revision + 1 };
  assert.equal(store.save(row.groupId, row.revision, next), true); return next;
}
function editable(store: ExecutionStore, groupIds = ['group'], windowId = 'edit-window') {
  const rows = store.freezeAdmissions({ windowId, groups: store.load(groupIds).map(({ groupId, revision }) => ({ groupId, revision })) });
  for (let row of rows) {
    row = revise(store, row, { stage: 'drain', controller: { ...row.controller, epoch: row.controller.epoch + 1, admission: 'drain', frozenSetId: row.frozenSetId } });
    revise(store, row, { phase: 'editable', stage: 'closed', controller: { ...row.controller, epoch: row.controller.epoch + 1, admission: 'closed', writers: 'quiescent' } });
  }
  return store.load(groupIds);
}
function writeIdentity(workspace: { id: string; identity: string }): SaveWriteIdentity {
  return { workspaceId: workspace.id, directoryIdentity: workspace.identity, path: 'example.md', expectedVersion: proof('old'), contentDigest: proof('new') };
}

test('host plugin claims share the business transaction, join conflict freezes and paginate with workspace pending without fake conversations', t => {
  const f = fixture(t); const conversation = f.conversation();
  register(f.store, f.workspace.id, 'a'); register(f.store, f.workspace.id, 'b');
  f.store.registerHostGroup({ groupId: 'a', harnessId: 'codex' }); f.store.registerHostGroup({ groupId: 'b', harnessId: 'dsh' });
  initialize(f.store, 'a'); initialize(f.store, 'b');
  const plugins = createPluginStore(f.db); const command = { id: randomUUID(), pluginId: 'synthetic/plugin', action: 'enable' as const };
  assert.equal(plugins.claim('codex', command).created, true);
  const host = f.store.hostAdmission(command.id)!;
  assert.equal(host.kind, 'plugin'); assert.equal('conversationId' in host, false); assert.equal('workspaceId' in host, false);
  assert.equal(plugins.claim('codex', command).created, false);
  const message = enqueue(f.db, conversation.id); claim(f.db, message);
  let rows = f.store.freezeAdmissions({ windowId: 'host-plugin-window', groups: revisions(f.store.load(['a', 'b'])) });
  const rejected = { ...command, id: randomUUID() };
  assert.throws(() => plugins.claim('dsh', rejected), { code: 'execution_admission_closed' });
  assert.equal(plugins.find(rejected.id), undefined); assert.equal(f.store.hostAdmission(rejected.id), undefined);
  assert.throws(() => f.store.bindHostPluginRequest({ operationId: command.id, wireDigest: proof('wire') }), { code: 'execution_host_dispatch_closed' });
  rows = rows.map(row => revise(f.store, row, { stage: 'drain', controller: { ...row.controller, epoch: row.controller.epoch + 1, admission: 'drain', frozenSetId: row.frozenSetId } }));
  const permit = f.store.bindHostPluginRequest({ operationId: command.id, wireDigest: proof('wire') });
  assert.deepEqual(permit.groups.map(group => group.groupId), ['a', 'b']); assert.ok(permit.groups.every(group => group.frozenSetId));
  assert.throws(() => f.store.bindHostPluginRequest({ operationId: command.id, wireDigest: proof('different-wire') }), { code: 'execution_host_wire_conflict' });
  const ids: string[] = []; let after: ExecutionCursor | undefined;
  do {
    const page = f.store.pendingPage({ groupId: 'a', frozenSetId: rows[0]!.frozenSetId!, after, limit: 1, byteLimit: 4096 });
    ids.push(...page.entries.map(entry => entry.id)); after = page.nextCursor ?? undefined;
  } while (after);
  assert.deepEqual(new Set(ids), new Set(['h:' + command.id, 'o:' + message])); assert.equal(ids.length, 2);
  plugins.settle(command.id, 'unknown');
  assert.equal(f.store.unresolvedPage({ groupId: 'a', limit: 16 }).entries.length, 2);
  assert.throws(() => f.store.bindHostPluginRequest({ operationId: command.id, wireDigest: proof('wire') }), { code: 'execution_host_dispatch_unverified' });
  plugins.settle(command.id, 'applied');
  assert.deepEqual(f.store.unresolvedPage({ groupId: 'a', limit: 16 }).entries.map(entry => entry.id), ['o:' + message]);
});

test('host startup imports legacy unknown plugin/source work without granting a new mutation and source claim rollback is atomic', t => {
  const f = fixture(t); const plugins = createPluginStore(f.db);
  const command = { id: randomUUID(), pluginId: 'synthetic/plugin', action: 'install' as const, version: '1.0.0' };
  plugins.claim('codex', command); plugins.recoverApplying();
  register(f.store, f.workspace.id); f.store.registerHostGroup({ groupId: 'group', harnessId: 'codex' }); initialize(f.store, 'group');
  assert.equal(f.store.hostAdmission(command.id)!.dispatchable, false);
  assert.equal(f.store.unresolvedPage({ groupId: 'group', limit: 8 }).entries[0]!.kind, 'host');
  assert.throws(() => f.store.bindHostPluginRequest({ operationId: command.id, wireDigest: proof('legacy') }), { code: 'execution_host_dispatch_unverified' });
  plugins.settle(command.id, 'applied');
  const source = { action: 'add' as const, source: 'https://github.com/synthetic/fixture' }; const requestId = randomUUID();
  assert.equal(plugins.claimSource('codex', requestId, source).created, true);
  assert.equal(f.store.hostAdmission(requestId)!.kind, 'source');
  plugins.settleSource(requestId, 'applied');
  f.store.freezeAdmissions({ windowId: 'source-frozen', groups: revisions(f.store.load(['group'])) });
  const blocked = randomUUID(); assert.throws(() => plugins.claimSource('codex', blocked, source), { code: 'execution_admission_closed' });
  assert.equal(plugins.findSource(blocked), undefined); assert.equal(f.store.hostAdmission(blocked), undefined);
});

test('verified restart-required ends the host mutation while an imported legacy restart-required still requires native reconciliation', t => {
  const f = fixture(t); const plugins = createPluginStore(f.db);
  const command = { id: randomUUID(), pluginId: 'synthetic/restart', action: 'install' as const };
  plugins.claim('codex', command); plugins.settle(command.id, 'restart-required');
  register(f.store, f.workspace.id); f.store.registerHostGroup({ groupId: 'group', harnessId: 'codex' }); initialize(f.store, 'group');
  assert.equal(f.store.hostAdmission(command.id)!.status, 'unknown');
  assert.equal(f.store.unresolvedPage({ groupId: 'group', limit: 8 }).entries.length, 1);
  plugins.settle(command.id, 'restart-required');
  assert.equal(f.store.unresolvedPage({ groupId: 'group', limit: 8 }).entries.length, 0);
  f.store.registerHostGroup({ groupId: 'group', harnessId: 'codex' });
  assert.equal(f.store.unresolvedPage({ groupId: 'group', limit: 8 }).entries.length, 0, 'known completed mutation does not block the restart it requires');
  assert.equal(plugins.find(command.id)!.status, 'restart-required');
  plugins.settle(command.id, 'applied'); assert.equal(f.store.hostAdmission(command.id)!.status, 'applied');
});

test('SQLite admission hooks commit with business rows, reject a frozen insertion atomically, and preserve immutable wire digests', t => {
  const f = fixture(t); const conversation = f.conversation(); register(f.store, f.workspace.id); initialize(f.store, 'group');
  const operationId = enqueue(f.db, conversation.id); const first = claim(f.db, operationId); assert.ok(first);
  assert.equal(claim(f.db, operationId), null);
  assert.deepEqual(f.store.bindNativeRequest(operationId, proof('native-wire')), first);
  assert.throws(() => f.store.bindNativeRequest(operationId, proof('changed-native-wire')), { code: 'execution_native_request_conflict' });
  const rows = f.store.load(['group']);
  const frozen = f.store.freezeAdmissions({ windowId: 'freeze', groups: revisions(rows) }); const closedId = randomUUID();
  assert.throws(() => enqueue(f.db, conversation.id, closedId), { code: 'execution_admission_closed' });
  assert.equal(f.workbench.getOperation(closedId), null);
  assert.throws(() => f.store.bindNativeRequest(operationId, proof('native-wire')), { code: 'execution_dispatch_closed' });
  const row = frozen[0]!;
  revise(f.store, row, { stage: 'drain', controller: { ...row.controller, admission: 'drain', epoch: 1, frozenSetId: row.frozenSetId } });
  const permitted = f.store.bindNativeRequest(operationId, proof('native-wire'));
  assert.equal(permitted.groups[0]?.epoch, 1); assert.equal(permitted.groups[0]?.frozenSetId, row.frozenSetId);
  assert.throws(() => createExecutionAdmissionHooks(f.db).admitOperation(operationId), { code: 'execution_transaction_required' });
});

test('overlapping directories require the complete conflict set and multi-group CAS rolls back every row', t => {
  const f = fixture(t); const child = f.registerWorkspace('nested', 'workspace/child');
  register(f.store, f.workspace.id, 'parent'); register(f.store, child.id, 'child');
  initialize(f.store, 'parent'); initialize(f.store, 'child');
  assert.deepEqual(f.store.conflictGroups(['child']), ['child', 'parent']);
  const old = f.store.load(['child', 'parent']);
  assert.throws(() => f.store.freezeAdmissions({ windowId: 'subset', groups: revisions([old[0]!]) }), { code: 'execution_conflict_scope_incomplete' });
  assert.throws(() => f.store.freezeAdmissions({ windowId: 'stale', groups: old.map((row, index) => ({ groupId: row.groupId, revision: row.revision + index })) }), { code: 'execution_state_changed' });
  assert.deepEqual(f.store.load(['child', 'parent']), old);
  assert.equal(f.db.prepare('SELECT id FROM execution_windows WHERE id=?').get('stale'), undefined);
  const frozen = f.store.freezeAdmissions({ windowId: 'both', groups: revisions(old) });
  assert.deepEqual(frozen.map(row => row.windowGroups), [['child', 'parent'], ['child', 'parent']]);
  assert.deepEqual(f.store.freezeAdmissions({ windowId: 'both', groups: revisions(old) }), frozen);
});

test('pending keysets cover 130 originals once and terminal proofs remove only the matching original attempt', t => {
  const f = fixture(t); const conversation = f.conversation(); register(f.store, f.workspace.id); initialize(f.store, 'group');
  const ids = Array.from({ length: 130 }, () => enqueue(f.db, conversation.id));
  const frozen = f.store.freezeAdmissions({ windowId: 'many', groups: revisions(f.store.load(['group'])) })[0]!;
  let after: ExecutionCursor | undefined; const observed: string[] = [];
  for (;;) {
    const page = f.store.pendingPage({ groupId: 'group', frozenSetId: frozen.frozenSetId!, after, limit: 17, byteLimit: 4096 });
    assert.ok(page.entries.length <= 17); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096);
    observed.push(...page.entries.map(entry => entry.id)); if (!page.nextCursor) break; after = page.nextCursor;
  }
  assert.equal(observed.length, 130); assert.equal(new Set(observed).size, 130);
  const original = f.store.admission('o:' + ids[0])!;
  assert.throws(() => f.store.confirmTerminal({ admissionId: original.id, bindingId: 'other-binding', operationId: ids[0]!, proof: proof('terminal') }), { code: 'execution_terminal_identity_mismatch' });
  f.store.confirmTerminal({ admissionId: original.id, bindingId: original.bindingId, operationId: ids[0]!, proof: proof('terminal') });
  assert.equal(f.store.pendingPage({ groupId: 'group', frozenSetId: frozen.frozenSetId!, limit: 1, byteLimit: 4096 }).entries[0]?.id, 'o:' + ids[1]);
  const plan = f.db.prepare('EXPLAIN QUERY PLAN SELECT admission_id FROM execution_pending WHERE group_id=? AND (sequence,admission_id)>(?,?) ORDER BY sequence,admission_id LIMIT 64').all('group', 0, '');
  assert.match(JSON.stringify(plan), /SEARCH execution_pending USING PRIMARY KEY/);
});

const childCode = `
const {openDatabase}=await import(process.env.EXECUTION_TEST_DATABASE_MODULE);
const {productMigrations}=await import(process.env.EXECUTION_TEST_MIGRATIONS_MODULE);
const {createExecutionStore}=await import(process.env.EXECUTION_TEST_STORE_MODULE);
const db=openDatabase(process.env.EXECUTION_TEST_DIRECTORY,productMigrations);
const store=createExecutionStore(db); process.send({ready:true});
process.once('message',input=>{try{process.send({result:store.acquireSave(input)});}catch(error){process.send({error:error.code??error.message});}finally{db.close();process.disconnect();}});
`;
async function saveProcess(t: TestContext, database: string) {
  const child: ChildProcess = spawn(process.execPath, ['--input-type=module', '-e', childCode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env,
    EXECUTION_TEST_DIRECTORY: database, EXECUTION_TEST_DATABASE_MODULE: new URL('../src/server/database.ts', import.meta.url).href,
    EXECUTION_TEST_MIGRATIONS_MODULE: new URL('../src/server/migrations.ts', import.meta.url).href, EXECUTION_TEST_STORE_MODULE: new URL('../src/server/execution-store.ts', import.meta.url).href } });
  let diagnostics = ''; child.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4096); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('save process exited: ' + diagnostics); })]);
  assert.deepEqual(ready[0], { ready: true });
  return { child, result: (input: Serializable) => { const result = once(child, 'message'); child.send(input); return result.then(([message]) => message as { result?: { created: boolean; outcome?: string }; error?: string }); } };
}

test('two real processes grant one durable save permit; resume preserves an unknown save across reopen and completed window IDs never re-fence', async t => {
  const f = fixture(t); register(f.store, f.workspace.id); initialize(f.store, 'group');
  const rows = editable(f.store); const input = { saveId: 'same-save', windowId: 'edit-window', groups: rows.map(({ groupId, revision }) => ({ groupId, revision })), write: writeIdentity(f.workspace) };
  const [a, b] = await Promise.all([saveProcess(t, f.database), saveProcess(t, f.database)]);
  const results = await Promise.all([a.result(input), b.result(input)]);
  assert.equal(results.filter(result => result.result?.created).length, 1); assert.equal(results.filter(result => result.result?.outcome === 'pending').length, 1);
  assert.ok(results.every(result => !result.error));
  const other = createExecutionStore(f.open());
  assert.throws(() => other.acquireSave({ ...input, write: { ...input.write, contentDigest: proof('different') } }), { code: 'execution_save_conflict' });
  const resuming = other.beginResume({ windowId: input.windowId, groups: revisions(rows) });
  assert.equal(other.hasUnsettledSaves(input.windowId, ['group']), true);
  assert.throws(() => other.acquireSave({ ...input, saveId: 'late', groups: revisions(resuming) }), { code: 'execution_window_not_editable' });
  const opened = revise(other, resuming[0]!, { stage: 'opened', controller: { ...initial('group'), epoch: 3 } });
  assert.throws(() => other.completeResume({ windowId: input.windowId, groups: revisions([opened]) }), { code: 'execution_resume_unverified' });
  assert.equal(other.settleSave(input.saveId, 'committed', proof('file-version-verified')), true);
  assert.equal(other.settleSave(input.saveId, 'rejected', proof('other-result')), false);
  const online = other.completeResume({ windowId: input.windowId, groups: revisions([opened]) });
  assert.equal(online[0]?.phase, 'online');
  assert.throws(() => other.freezeAdmissions({ windowId: input.windowId, groups: revisions(online) }), { code: 'execution_window_completed' });
  assert.equal(other.load(['group'])[0]?.phase, 'online');
});

test('baseline migration checkpoints bounded raw pages, keeps unknown legacy receipts, verifies binding identity and survives reopen', t => {
  const f = fixture(t); const conversation = f.conversation();
  const legacy = Array.from({ length: 130 }, (_, index) => {
    const operationId = randomUUID(); f.workbench.enqueueOperation({ id: operationId, conversationId: conversation.id, type: 'message', payload: { text: 'legacy-' + index } }); return operationId;
  });
  f.workbench.claimOperation(legacy[0]!);
  register(f.store, f.workspace.id); const checkpoint = f.store.beginBaseline('group');
  assert.equal(f.store.load(['group'])[0]?.baselineComplete, false);
  assert.throws(() => transaction(f.db, () => createExecutionAdmissionHooks(f.db).assertWorkspaceAdmission(f.workspace.id)), { code: 'execution_admission_closed' });
  const first = f.store.seedLegacyAdmissions({ groupId: 'group', source: 'operations', after: 0, limit: 17, byteLimit: 4096 });
  assert.equal(first.scanned, 17); assert.equal(first.imported, 17); assert.equal(first.complete, false);
  const other = createExecutionStore(f.open());
  assert.throws(() => other.seedLegacyAdmissions({ groupId: 'group', source: 'operations', after: 0, limit: 17, byteLimit: 4096 }), { code: 'execution_baseline_changed' });
  let after = first.after;
  for (;;) { const page = other.seedLegacyAdmissions({ groupId: 'group', source: 'operations', after, limit: 17, byteLimit: 4096 }); after = page.after; if (page.complete) break; }
  other.seedLegacyAdmissions({ groupId: 'group', source: 'queues', after: 0, limit: 17, byteLimit: 4096 });
  const request = { groupId: 'group', through: checkpoint.through, limit: 17, byteLimit: 4096 };
  const page = other.bindingsPage(request); assert.equal(page.bindings.length, 1);
  other.registerBaselineObservation({ groupId: "group", through: checkpoint.through, conversationId: conversation.id, wireDigest: proof("legacy-baseline-wire") });
  const observations = page.bindings.map(binding => ({ ...binding, state: 'idle' as const, proof: proof(binding) }));
  const revision = other.load(['group'])[0]!.revision;
  assert.throws(() => other.commitBaselineBatch({ ...request, expectedRevision: revision, observations: [{ ...observations[0]!, bindingId: 'changed' }], proof: proof('batch') }), { code: 'execution_baseline_identity_mismatch' });
  assert.equal(other.load(['group'])[0]!.revision, revision);
  assert.equal(other.commitBaselineBatch({ ...request, expectedRevision: revision, observations, proof: proof('batch') }), true);
  assert.equal(other.admission('o:' + legacy[0])?.kind, 'receipt-unknown');
  assert.throws(() => other.bindNativeRequest(legacy[0]!, proof('wire')), { code: 'execution_operation_not_claimed' });
  assert.ok(claim(f.db, legacy[1]!));
  const frozen = other.freezeAdmissions({ windowId: 'migration-window', groups: revisions(other.load(['group'])) })[0]!;
  assert.equal(Number(f.db.prepare('SELECT COUNT(*) count FROM execution_pending WHERE group_id=?').get('group')!.count), 130);
  assert.equal(other.pendingPage({ groupId: 'group', frozenSetId: frozen.frozenSetId!, limit: 1, byteLimit: 4096 }).entries[0]?.kind, 'receipt-unknown');
});

test('native create is durably admitted before its binding exists and cannot bypass a frozen scope', t => {
  const f = fixture(t); const conversation = f.conversation(f.workspace, false);
  register(f.store, f.workspace.id); initialize(f.store, 'group');
  const input = { sourceKey: conversation.id + '.create', workspaceId: f.workspace.id, conversationId: conversation.id, purpose: 'create' as const, wireDigest: proof('exact-create-RPC') };
  const permit = f.store.registerNative(input); assert.equal(f.store.admission(permit.admissionId)?.bindingId, 'create:' + conversation.id);
  assert.deepEqual(f.store.registerNative(input), permit);
  assert.throws(() => f.store.permissionForNative(permit.admissionId, proof('other-wire')), { code: 'execution_native_request_conflict' });
  f.store.freezeAdmissions({ windowId: 'create-pending', groups: revisions(f.store.load(['group'])) });
  assert.throws(() => f.store.permissionForNative(permit.admissionId, input.wireDigest), { code: 'execution_dispatch_closed' });
  assert.throws(() => f.store.confirmTerminal({ admissionId: permit.admissionId, bindingId: 'invented-binding', operationId: null, proof: proof('idle') }), { code: 'execution_terminal_identity_mismatch' });
  f.workbench.saveBinding(conversation.id, { id: 'actual-native-binding', cwd: conversation.cwd, configuration: conversation.configuration, details: {} });
  assert.equal(f.store.attachNativeBinding(permit.admissionId).bindingId, 'actual-native-binding');
  f.store.confirmTerminal({ admissionId: permit.admissionId, bindingId: 'actual-native-binding', operationId: null, proof: proof('fresh-native-terminal') });
  assert.equal(f.store.admission(permit.admissionId)?.kind, 'settled');
});

test('real Workbench commands atomically admit messages and queued inputs, and frozen edits roll back their business changes', t => {
  const f = fixture(t); const conversation = f.conversation(); register(f.store, f.workspace.id); initialize(f.store, 'group');
  const operationId = randomUUID();
  f.workbench.enqueueOperation({ id: operationId, conversationId: conversation.id, type: 'message', payload: { text: 'registered in same commit' } });
  assert.equal(f.store.admission('o:' + operationId)?.kind, 'queued');
  f.workbench.claimOperation(operationId); f.workbench.settleOperation(operationId, { outcome: 'accepted', runId: 'native-run' });
  assert.equal(f.store.admission('o:' + operationId)?.kind, 'running');
  const entryId = randomUUID(); f.workbench.changeQueue(conversation.id, { action: 'add', entryId, content: { text: 'original queue text' } });
  assert.equal(f.store.admission('q:' + entryId)?.kind, 'queued');
  const before = f.workbench.version();
  const row = f.store.freezeAdmissions({ windowId: 'public-api', groups: revisions(f.store.load(['group'])) })[0]!;
  const denied = { id: randomUUID(), conversationId: conversation.id, type: 'message' as const, payload: { text: 'blocked' } };
  assert.throws(() => f.workbench.enqueueOperation(denied), { code: 'execution_admission_closed' });
  assert.equal(f.workbench.getOperation(denied.id), null);
  assert.throws(() => f.workbench.changeQueue(conversation.id, { action: 'edit', entryId, version: 0, content: { text: 'blocked edit' } }), { code: 'execution_admission_closed' });
  assert.equal(f.workbench.readQueue(conversation.id).entries[0]?.content.text, 'original queue text');
  assert.equal(f.workbench.version(), before);
  assert.throws(() => f.conversation(), { code: 'execution_admission_closed' });
  const drained = revise(f.store, row, { stage: 'drain', controller: { ...row.controller, admission: 'drain', epoch: 1, frozenSetId: row.frozenSetId } });
  const queuedOperation = randomUUID();
  f.workbench.claimQueue(conversation.id, entryId, 0, queuedOperation, { mode: 'next' });
  assert.equal(f.store.bindNativeRequest(queuedOperation, proof('queued-submit')).admissionId, 'q:' + entryId);
  f.workbench.settleOperation(queuedOperation, { outcome: 'accepted', runId: 'queued-native-run' });
  assert.equal(f.store.admission('q:' + entryId)?.kind, 'running');
  assert.equal(f.workbench.readQueue(conversation.id).entries.length, 0);
  const wake = f.store.bindAssociatedRequest({ operationId: queuedOperation, requestId: 'wake-intent-1', kind: 'wake', wireDigest: proof('wake-wire') });
  assert.equal(wake.admissionId, 'q:' + entryId); assert.equal(wake.groups[0]?.frozenSetId, drained.frozenSetId);
  assert.throws(() => f.store.bindAssociatedRequest({ operationId: queuedOperation, requestId: 'wake-intent-1', kind: 'wake', wireDigest: proof('changed-wake-wire') }), { code: 'execution_native_request_conflict' });
  assert.equal(Number(f.db.prepare('SELECT COUNT(*) count FROM execution_pending').get()!.count), 2);
});

test('explicit stop has a separate immutable permission and never clears the original pending work', t => {
  const f = fixture(t); const conversation = f.conversation(); register(f.store, f.workspace.id); initialize(f.store, 'group');
  const operationId = enqueue(f.db, conversation.id); claim(f.db, operationId);
  f.workbench.settleOperation(operationId, { outcome: 'accepted', runId: 'running-native-run' });
  const stopId = randomUUID(); f.workbench.enqueueOperation({ id: stopId, conversationId: conversation.id, type: 'stop', payload: { runId: 'running-native-run' } }); f.workbench.claimOperation(stopId);
  const request = { operationId: stopId, bindingId: f.workbench.getConversation(conversation.id)!.binding!.id, runId: 'running-native-run', wireDigest: proof('stop-RPC') };
  assert.equal(f.store.permissionForStop(request).purpose, 'stop');
  assert.throws(() => f.store.permissionForStop({ ...request, runId: 'different-target' }), { code: 'execution_stop_unregistered' });
  assert.throws(() => f.store.permissionForStop({ ...request, wireDigest: proof('changed-stop') }), { code: 'execution_native_request_conflict' });
  const frozen = f.store.freezeAdmissions({ windowId: 'stop-in-drain', groups: revisions(f.store.load(['group'])) })[0]!;
  assert.throws(() => f.store.permissionForStop(request), { code: 'execution_dispatch_closed' });
  revise(f.store, frozen, { stage: 'drain', controller: { ...frozen.controller, epoch: 1, admission: 'drain', frozenSetId: frozen.frozenSetId } });
  assert.equal(f.store.permissionForStop(request).groups[0]?.epoch, 1);
  f.workbench.settleOperation(stopId, { outcome: 'accepted' });
  assert.equal(f.store.admission('o:' + operationId)?.kind, 'running');
  assert.equal(Number(f.db.prepare('SELECT COUNT(*) count FROM execution_pending').get()!.count), 1);
});

test('scope registration scans at most 64 raw mappings per command, resumes its checkpoint and forbids premature baselines', t => {
  const f = fixture(t); f.store.registerGroup(initial('group'));
  for (let index = 0; index < 130; index++) {
    const workspace = f.registerWorkspace('scope-' + String(index).padStart(3, '0'), 'workspace/scope-' + index);
    for (;;) { if (f.store.registerScope({ workspaceId: workspace.id, groupId: 'group' }).complete) break; }
  }
  f.store.registerGroup(initial('parent'));
  const first = f.store.registerScope({ workspaceId: f.workspace.id, groupId: 'parent' });
  assert.deepEqual(first, { complete: false, scanned: 64 });
  assert.throws(() => f.store.beginBaseline('parent'), { code: 'execution_scope_registration_pending' });
  assert.throws(() => f.store.beginBaseline('group'), { code: 'execution_scope_registration_pending' });
  const reopened = createExecutionStore(f.open());
  assert.deepEqual(reopened.registerScope({ workspaceId: f.workspace.id, groupId: 'parent' }), { complete: false, scanned: 128 });
  assert.deepEqual(reopened.registerScope({ workspaceId: f.workspace.id, groupId: 'parent' }), { complete: true, scanned: 131 });
  assert.deepEqual(reopened.conflictGroups(['group']), ['group', 'parent']);
  assert.deepEqual(reopened.registerScope({ workspaceId: f.workspace.id, groupId: 'parent' }), { complete: true, scanned: 0 });
});

test('production storage worker exposes whole execution transactions and preserves closed gates across worker restart', async t => {
  const f = fixture(t); const conversation = f.conversation();
  const first = createStorageClient({ dataDirectory: f.database }); t.after(() => first.close()); await first.ready;
  const execution = first.execution;
  await execution.registerGroup(initial('group')); assert.equal((await execution.registerScope({ workspaceId: f.workspace.id, groupId: 'group' })).complete, true);
  const checkpoint = await execution.beginBaseline('group');
  for (const source of ['operations', 'queues'] as const) assert.equal((await execution.seedLegacyAdmissions({ groupId: 'group', source, after: 0, limit: 64, byteLimit: 4096 })).complete, true);
  const page = await execution.bindingsPage({ groupId: 'group', through: checkpoint.through, limit: 64, byteLimit: 4096 });
  await execution.registerBaselineObservation({ groupId: 'group', through: checkpoint.through, conversationId: conversation.id, wireDigest: proof('worker-baseline-wire') });
  await execution.commitBaselineBatch({ groupId: 'group', through: checkpoint.through, limit: 64, byteLimit: 4096, expectedRevision: (await execution.load(['group']))[0]!.revision,
    observations: page.bindings.map(binding => ({ ...binding, state: 'idle', proof: proof(binding) })), proof: proof('worker-native-observations') });
  const operation = { id: randomUUID(), conversationId: conversation.id, type: 'message' as const, payload: { text: 'worker managed operation' } };
  await execution.registerHostGroup({ groupId: 'group', harnessId: 'codex' });
  const plugin = { id: randomUUID(), pluginId: 'synthetic/worker', action: 'enable' as const };
  await first.plugins.claim('codex', plugin);
  assert.equal((await execution.bindHostPluginRequest({ operationId: plugin.id, wireDigest: proof('worker-plugin-wire') })).operationId, plugin.id);
  await first.store.enqueueOperation(operation); await first.store.claimOperation(operation.id);
  assert.equal((await execution.bindNativeRequest(operation.id, proof('worker-native-wire'))).operationId, operation.id);
  await execution.freezeAdmissions({ windowId: 'worker-edit-window', groups: revisions(await execution.load(['group'])) });
  await first.close();
  const second = createStorageClient({ dataDirectory: f.database }); t.after(() => second.close()); await second.ready;
  const denied = { ...operation, id: randomUUID() };
  await assert.rejects(second.store.enqueueOperation(denied), error => error instanceof StorageClientError && error.code === 'execution_admission_closed' && error.outcome === 'rejected');
  assert.equal(await second.store.getOperation(denied.id), null);
  const restored = (await second.execution.load(['group']))[0]!;
  assert.equal(restored.windowId, 'worker-edit-window');
  assert.deepEqual(new Set((await second.execution.pendingPage({ groupId: 'group', frozenSetId: restored.frozenSetId!, limit: 64, byteLimit: 4096 })).entries.map(entry => entry.id)), new Set(['o:' + operation.id, 'h:' + plugin.id]));
  await second.plugins.recoverApplying(); await second.execution.registerHostGroup({ groupId: 'group', harnessId: 'codex' });
  assert.equal((await second.execution.hostAdmission(plugin.id))!.dispatchable, false);
  await assert.rejects(second.execution.bindHostPluginRequest({ operationId: plugin.id, wireDigest: proof('worker-plugin-wire') }), { code: 'execution_host_dispatch_unverified' });
  await second.plugins.settle(plugin.id, 'applied');
  assert.deepEqual((await second.execution.pendingPage({ groupId: 'group', frozenSetId: restored.frozenSetId!, limit: 64, byteLimit: 4096 })).entries.map(entry => entry.id), ['o:' + operation.id]);
  await second.close();
});

test('restoring 10001 unresolved conversations invalidates every old idle state and preserves execution windows and unknown saves', async t => {
  const f = fixture(t);
  transaction(f.db, () => {
    f.db.prepare(`WITH RECURSIVE generated(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM generated WHERE n<10001)
      INSERT INTO workbench_conversations(id,harness_id,workspace_id,cwd,title,configuration_json,creation_digest,binding_json,readiness,state_json,created_at)
      SELECT printf('00000000-0000-4000-8000-%012d',n),'codex',?,?,'restore fixture',?,?,json_object('id','native-'||n,'cwd',?,'configuration',json(?),'details',json('{}')),'ready',?,n FROM generated`)
      .run(f.workspace.id, f.workspace.path, JSON.stringify({ modelId: 'model', permissionId: 'workspace' }), proof('creation'), f.workspace.path,
        JSON.stringify({ modelId: 'model', permissionId: 'workspace' }), JSON.stringify({ status: 'idle', configurationVerified: true, pendingInputs: 0 }));
    f.db.prepare(`INSERT INTO workbench_operations(id,conversation_id,type,payload_json,digest,status,created_at,updated_at)
      SELECT replace(id,'4000-8000','4000-9000'),id,'message','{"text":"restore fixture"}',?,'queued',created_at,created_at FROM workbench_conversations`).run(proof('input'));
  });
  // The execution window is independently populated through its public port.
  const independent = f.registerWorkspace('independent', 'independent'); register(f.store, independent.id); initialize(f.store, 'group');
  const rows = editable(f.store); const save = { saveId: 'restore-unknown-save', windowId: 'edit-window', groups: revisions(rows), write: writeIdentity(independent) };
  f.store.acquireSave(save);
  const backup = join(f.directory, 'backup.sqlite'); await backupDatabase(f.db, backup);
  const target = join(f.directory, 'restored'); await restoreDatabase(backup, target, afterProductRestore);
  const restored = openDatabase(target, productMigrations);
  try {
    assert.equal(Number(restored.prepare("SELECT COUNT(*) n FROM workbench_conversations WHERE json_extract(state_json,'$.status')='unknown' AND json_extract(state_json,'$.configurationVerified')=0").get()!.n), 10001);
    assert.equal(Number(restored.prepare("SELECT COUNT(*) n FROM workbench_operations WHERE status='unknown'").get()!.n), 10001);
    const execution = createExecutionStore(restored); const gate = execution.load(['group'])[0]!;
    assert.equal(gate.phase, 'unknown'); assert.equal(gate.baselineComplete, false); assert.equal(gate.windowId, 'edit-window');
    assert.equal(gate.error, 'execution_restore_requires_reconciliation');
    assert.equal(execution.hasUnsettledSaves('edit-window', ['group']), true);
    assert.deepEqual(execution.acquireSave(save), { created: false, outcome: 'pending' });
    assert.equal(Number(restored.prepare('SELECT COUNT(*) n FROM workbench_changes').get()!.n), 2000);
  } finally { restored.close(); }
});

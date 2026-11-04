import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { backupDatabase, openDatabase, restoreDatabase } from '../src/server/database.ts';
import { afterProductRestore, productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { createAuthStore } from '../src/server/auth-store.ts';
import { createWorkspaceStore } from '../src/server/workspace-store.ts';
import { createExecutionStore } from '../src/server/execution-store.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const config = { modelId: 'synthetic', permissionId: 'workspace' };
function create(store: ReturnType<typeof createWorkbenchStore>, id = randomUUID()) {
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'synthetic', cwd: '/synthetic', configuration: config });
  store.saveBinding(id, { id: 'native-' + id, cwd: '/synthetic', configuration: config, details: {} });
  store.setConversationState(id, { readiness: 'ready', state: { status: 'idle', pendingInputs: 0, configurationVerified: true } });
  return id;
}
function maintain(store: ReturnType<typeof createWorkbenchStore>, limit = 100) { let calls = 0; while (store.advanceStorageMaintenance()) { if (++calls > limit) throw new Error('maintenance did not converge'); } return calls; }

test('accepted payloads compact only after the matching durable execution becomes terminal', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-payload-terminal-')); const db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  createWorkspaceStore(db).register({ id: 'synthetic', label: 'Synthetic', directory: '/synthetic', identity: 'synthetic-directory', root_id: null, removed: 0, pinned: 0 });
  const execution = createExecutionStore(db);
  execution.registerGroup({ groupId: 'group', generation: 'synthetic-generation', epoch: 0, admission: 'open', writers: 'running', durable: true });
  execution.registerScope({ groupId: 'group', workspaceId: 'synthetic' }); const baseline = execution.beginBaseline('group');
  for (const source of ['operations', 'queues'] as const) execution.seedLegacyAdmissions({ groupId: 'group', source, after: 0, limit: 64, byteLimit: 4096 });
  execution.commitBaselineBatch({ groupId: 'group', through: baseline.through, expectedRevision: execution.load(['group'])[0]!.revision, observations: [], proof: hash('empty fixture'), limit: 8, byteLimit: 4096 });
  const store = createWorkbenchStore(db); const conversationId = create(store); const id = randomUUID();
  const input = { id, conversationId, type: 'message' as const, payload: { text: 'large input '.repeat(1000) } };
  store.enqueueOperation(input); store.claimOperation(id); store.settleOperation(id, { outcome: 'accepted', runId: 'synthetic-run' });
  maintain(store); assert.equal(db.prepare('SELECT COUNT(*) n FROM workbench_operation_payloads').get()!.n, 0);
  const admission = execution.admission('o:' + id)!;
  execution.confirmTerminal({ admissionId: admission.id, bindingId: admission.bindingId, operationId: id, proof: hash('explicit synthetic terminal observation') });
  maintain(store); assert.equal(db.prepare('SELECT COUNT(*) n FROM workbench_operation_payloads').get()!.n, 1);
  assert.deepEqual(store.getOperation(id)!.payload, input.payload); assert.equal(store.enqueueOperation(input).created, false);
});

test('legacy compaction scans raw operation keys once in bounded resumable pages', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-payload-checkpoint-'));
  let db = openDatabase(root, productMigrations.filter(migration => migration.version <= 26));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  let store = createWorkbenchStore(db); const conversationId = create(store);
  for (let n = 0; n < 300; n++) {
    const id = randomUUID(); store.enqueueOperation({ id, conversationId, type: 'message', payload: { text: 'small ' + n } });
    store.settleOperation(id, { outcome: 'rejected', reason: 'synthetic' });
  }
  db.close(); db = openDatabase(root, productMigrations); store = createWorkbenchStore(db);
  store.advanceStorageMaintenance(); assert.equal(db.prepare('SELECT after_sequence FROM workbench_operation_compaction_scan').get()!.after_sequence, 128);
  db.close(); db = openDatabase(root, productMigrations); store = createWorkbenchStore(db);
  store.advanceStorageMaintenance(); assert.equal(db.prepare('SELECT after_sequence FROM workbench_operation_compaction_scan').get()!.after_sequence, 256);
  store.advanceStorageMaintenance(); assert.equal(db.prepare('SELECT * FROM workbench_operation_compaction_scan').get(), undefined);
  assert.equal(store.advanceStorageMaintenance(), false); assert.equal(store.listOperations({ conversationId, limit: 1000 }).length, 300);
});

test('lossless terminal payload compaction preserves identity, rejects changed retries, leaves unknown and incompressible inputs intact, and keeps queue delivery summaries', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-payload-')); const db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = createWorkbenchStore(db); const id = create(store);
  const original = { id: randomUUID(), conversationId: id, type: 'message' as const, payload: { text: '中'.repeat(15000) } };
  store.enqueueOperation(original); store.claimOperation(original.id); store.settleOperation(original.id, { outcome: 'rejected', reason: 'synthetic rejection' });
  const unknown = { ...original, id: randomUUID() }; store.enqueueOperation(unknown); store.claimOperation(unknown.id); store.settleOperation(unknown.id, { outcome: 'unknown', reason: 'synthetic unknown' });
  const small = { ...original, id: randomUUID(), payload: { text: 'small input' } }; store.enqueueOperation(small); store.settleOperation(small.id, { outcome: 'rejected', reason: 'synthetic rejection' });
  const random = { ...original, id: randomUUID(), payload: { text: randomBytes(12000).toString('base64') } }; store.enqueueOperation(random); store.settleOperation(random.id, { outcome: 'rejected', reason: 'synthetic rejection' });
  const queueId = create(store); const entryId = randomUUID(); const queuedId = randomUUID();
  store.changeQueue(queueId, { action: 'add', entryId, content: original.payload });
  const queued = store.claimQueue(queueId, entryId, 0, queuedId, { mode: 'next' });
  assert.equal(queued.type, 'message'); if (queued.type !== 'message') throw new Error('wrong operation kind');
  store.settleOperation(queuedId, { outcome: 'rejected', reason: 'synthetic rejection' });
  maintain(store);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workbench_operation_payloads').get()!.n, 2);
  assert.equal(store.enqueueOperation(original).created, false); assert.equal(store.claimOperation(original.id), null);
  assert.throws(() => store.enqueueOperation({ ...original, payload: { text: original.payload.text + 'changed' } }), { code: 'operation_id_conflict' });
  assert.deepEqual(store.getOperation(original.id)!.payload, original.payload);
  assert.deepEqual(store.getOperation(unknown.id)!.payload, unknown.payload); assert.equal(store.getOperation(unknown.id)!.status, 'unknown');
  const decoded = store.getOperation(queuedId)!; assert.equal(decoded.type, 'message'); if (decoded.type !== 'message') throw new Error('wrong operation kind');
  assert.deepEqual(decoded.queuedInput, queued.queuedInput);
  assert.deepEqual(store.readOperationViews(queueId)[0]!.delivery, queued.queuedInput!.delivery);
  const row = db.prepare('SELECT raw_bytes,length(data) bytes FROM workbench_operation_payloads WHERE operation_id=?').get(original.id)!;
  assert.ok(Number(row.bytes) + 4096 < Number(row.raw_bytes));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workbench_operation_compaction').get()!.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workbench_operation_compaction_scan').get()!.n, 0);
  assert.equal(store.advanceStorageMaintenance(), false);
  db.prepare('UPDATE workbench_operation_payloads SET data=? WHERE operation_id=?').run(Buffer.from('corrupt'), original.id);
  assert.throws(() => store.getOperation(original.id), { code: 'operation_payload_corrupt' });
});

test('schema 10 backup upgrades to current schema and a second compressed backup restores operation identity, image/body hashes, binding and revoked sessions', async t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-payload-migration-'));
  let db = openDatabase(join(root, 'old'), productMigrations.filter(migration => migration.version <= 10));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  let store = createWorkbenchStore(db); const id = create(store);
  const auth = createAuthStore(db); const tokenHash = hash(randomBytes(32)); const now = Date.now();
  auth.initialize('scrypt-v1$' + randomBytes(16).toString('base64url') + '$' + randomBytes(64).toString('base64url'), now);
  auth.mintSession({ expectedVersion: 1, id: randomUUID(), tokenHash, clientHash: hash('synthetic'), issuedAt: now, expiresAt: now + 60000 });
  assert.ok(auth.authenticateHash(tokenHash, now));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==', 'base64');
  const image = store.resources.put(id, 'synthetic.png', png);
  const input = { id: randomUUID(), conversationId: id, type: 'message' as const, payload: { text: '存档输入'.repeat(3000), images: [image] } };
  store.enqueueOperation(input); store.claimOperation(input.id); store.settleOperation(input.id, { outcome: 'rejected', reason: 'synthetic rejection' });
  const body = '永久正文🙂\n'.repeat(30000);
  store.mergeHistory(id, [{ id: 'legacy-body', kind: 'assistant', status: 'completed', text: body, images: [image] }]);
  const oldIdentity = store.getOperation(input.id)!; const oldBinding = store.getConversation(id)!.binding;
  const v10 = join(root, 'v10.sqlite'); await backupDatabase(db, v10); db.close();
  const migrated = join(root, 'migrated'); await restoreDatabase(v10, migrated, afterProductRestore); db = openDatabase(migrated, productMigrations); store = createWorkbenchStore(db);
  assert.equal(createAuthStore(db).authenticateHash(tokenHash, now), null);
  assert.deepEqual(store.getOperation(input.id), oldIdentity); assert.deepEqual(store.getConversation(id)!.binding, oldBinding);
  assert.equal(hash(store.resources.get(id, image.id).data), hash(png));
  const reference = store.readHistory(id).items[0]!.bodies!.text!;
  store.mergeHistory(id, [{ id: 'legacy-body', kind: 'assistant', status: 'completed', text: 'later replacement' }]);
  maintain(store); assert.equal(db.prepare('SELECT COUNT(*) n FROM workbench_operation_payloads').get()!.n, 1);
  const current = join(root, 'current.sqlite'); await backupDatabase(db, current); db.close();
  const target = join(root, 'restored'); await restoreDatabase(current, target, afterProductRestore); db = openDatabase(target, productMigrations); store = createWorkbenchStore(db);
  assert.deepEqual(store.getOperation(input.id), oldIdentity); assert.deepEqual(store.getConversation(id)!.binding, oldBinding);
  assert.equal(store.enqueueOperation(input).created, false);
  assert.throws(() => store.enqueueOperation({ ...input, payload: { ...input.payload, text: 'changed' } }), { code: 'operation_id_conflict' });
  assert.equal(hash(store.resources.get(id, image.id).data), hash(png));
  const bodyHash = createHash('sha256'); let offset: number | null = 0;
  while (offset !== null) { const part = store.readBody(id, 'legacy-body', 'text', reference, offset); bodyHash.update(part.data); offset = part.nextOffset; }
  assert.equal(bodyHash.digest('hex'), hash(body));
  assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  t.diagnostic(JSON.stringify({ fromSchema: 10, toSchema: productMigrations.at(-1)!.version, originalBodyBytes: Buffer.byteLength(body), operationDigest: oldIdentity.digest, bodySha256: hash(body), imageSha256: hash(png), compressedPayloads: 1, oldSessionRevoked: true }));
});

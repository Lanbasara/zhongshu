import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';

test('multi-megabyte UTF-8 bodies publish bounded previews and immutable, owner-checked exact chunks', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-body-'));
  const db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = createWorkbenchStore(db); const id = randomUUID();
  const create = (id: string) => store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration: { modelId: 'fixture', permissionId: 'fixture' } });
  create(id); const text = '中文🙂\n'.repeat(300_000);
  store.mergeHistory(id, [{ id: 'large', kind: 'assistant', text, status: 'completed' }]);
  const item = store.getItem(id, 'large')!;
  assert.ok(Buffer.byteLength(item.text) <= 8192);
  assert.ok(text.startsWith(item.text)); assert.ok(!item.text.includes('�'));
  const reference = item.bodies!.text!;
  const hash = createHash('sha256'); let total = 0; let offset: number | null = 0;
  while (offset !== null) {
    const part = store.readBody(id, 'large', 'text', reference, offset);
    assert.ok(part.data.byteLength <= 65536); total += part.data.byteLength; hash.update(part.data); offset = part.nextOffset;
  }
  assert.equal(total, Buffer.byteLength(text));
  assert.equal(hash.digest('hex'), createHash('sha256').update(text).digest('hex'));
  const other = randomUUID(); create(other);
  assert.throws(() => store.readBody(other, 'large', 'text', reference), { code: 'body_not_found' });
  assert.throws(() => store.readBody(id, 'different', 'text', reference), { code: 'body_not_found' });
  assert.throws(() => store.readBody(id, 'large', 'output', reference), { code: 'body_not_found' });
  assert.throws(() => store.readBody(id, 'large', 'text', reference, 1), { code: 'invalid_body_request' });
  store.mergeHistory(id, [{ id: 'large', kind: 'assistant', text: text + 'final', status: 'completed' }]);
  assert.notEqual(store.getItem(id, 'large')!.bodies!.text!.version, reference.version);
  assert.equal(store.readBody(id, 'large', 'text', reference).bytes, total);
});

test('body publication rolls back with metadata and the total preview budget includes tool fields', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-body-'));
  const db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = createWorkbenchStore(db); const id = randomUUID();
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration: { modelId: 'fixture', permissionId: 'fixture' } });
  db.exec("CREATE TRIGGER fail_item BEFORE INSERT ON workbench_items BEGIN SELECT RAISE(ABORT,'synthetic metadata failure'); END");
  assert.throws(() => store.mergeHistory(id, [{ id: 'large', kind: 'assistant', text: 'x'.repeat(10000), status: 'completed' }]));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workbench_bodies').get()?.n, 0);
  db.exec('DROP TRIGGER fail_item');
  store.mergeHistory(id, [{ id: 'tool', kind: 'tool', text: 'x'.repeat(7000), status: 'completed', tool: { name: 'fixture', input: '中'.repeat(1000), output: 'y'.repeat(30000) } }]);
  const item = store.getItem(id, 'tool')!;
  assert.ok(Buffer.byteLength(item.text + item.tool!.input! + item.tool!.output!) <= 8192);
  assert.equal(item.bodies!.input!.bytes, 3000); assert.equal(item.bodies!.output!.bytes, 30000);
});

test('truncated live projections never advertise a complete body and are repaired from durable records', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-body-preview-'));
  const db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = createWorkbenchStore(db); const id = randomUUID();
  const configuration = { modelId: 'fixture', permissionId: 'fixture' };
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration });
  store.saveBinding(id, { id: 'native-fixture', cwd: '/synthetic', configuration, details: {} });
  const prefix = '中🙂\n'.repeat(10000);
  for (let n = 1; n <= 10; n++) store.saveLiveItem(id, { id: 'partial', kind: 'assistant', text: prefix.slice(0, n * 2000), status: 'completed', previewOnly: true });
  assert.equal(store.getItem(id, 'partial')!.previewOnly, true);
  assert.equal(store.getItem(id, 'partial')!.bodies, undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workbench_bodies').get()!.n, 0, 'live prefixes never become immutable archived versions');
  assert.deepEqual(store.pendingArchiveItems(id, null), ['partial']);
  assert.equal(store.archiveJobs(id)[0]!.error, 'archive_items_pending');
  const full = prefix + '\nconfirmed durable end';
  store.mergeHistory(id, [{ id: 'partial', kind: 'assistant', text: full, status: 'completed', sourceRevision: { generation: 'native-source', sequence: 42 } }]);
  assert.equal(store.getItem(id, 'partial')!.previewOnly, undefined);
  const reference = store.getItem(id, 'partial')!.bodies!.text!;
  assert.equal(reference.version, createHash('sha256').update(full).digest('hex'));
  assert.equal(reference.bytes, Buffer.byteLength(full));
  assert.deepEqual(store.pendingArchiveItems(id, null), []);
  store.saveLiveItem(id, { id: 'partial', kind: 'assistant', text: prefix, status: 'running', previewOnly: true });
  assert.equal(store.getItem(id, 'partial')!.bodies!.text!.version, reference.version, 'late live prefixes cannot overwrite a confirmed terminal body');
});

test('staging resumes after reopen and publishes only after digest validation and atomic item linkage', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-body-stage-'));
  let db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  let store = createWorkbenchStore(db); const id = randomUUID();
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration: { modelId: 'fixture', permissionId: 'fixture' } });
  const bytes = Buffer.from('synthetic streaming body\n'.repeat(60000));
  const reference = { version: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  const stage = store.beginBodyStage(id, 'streamed', 'text', reference);
  store.stageBodyChunk(stage.stageId, 0, bytes.subarray(0, 65536));
  assert.throws(() => store.readBody(id, 'streamed', 'text', reference), { code: 'body_not_found' });
  assert.throws(() => store.finishBodyStage(stage.stageId), { code: 'body_incomplete' });
  db.close(); db = openDatabase(root, productMigrations); store = createWorkbenchStore(db);
  const resumed = store.beginBodyStage(id, 'streamed', 'text', reference);
  assert.equal(resumed.stageId, stage.stageId); assert.equal(resumed.nextOffset, 65536);
  assert.equal(store.stageBodyChunk(stage.stageId, 0, bytes.subarray(0, 65536)), 65536);
  assert.throws(() => store.stageBodyChunk(stage.stageId, 0, Buffer.alloc(65536)), { code: 'body_chunk_conflict' });
  for (let offset = resumed.nextOffset; offset < bytes.length; offset += 65536) store.stageBodyChunk(stage.stageId, offset, bytes.subarray(offset, offset + 65536));
  let previous = 0; let batches = 0; let validation: ReturnType<typeof store.validateBodyStage>;
  do { validation = store.validateBodyStage(stage.stageId); batches++; assert.ok(validation.verifiedBytes - previous <= 8 * 65536); previous = validation.verifiedBytes; } while (!validation.complete);
  assert.ok(batches > 1);
  assert.deepEqual(store.finishBodyStage(stage.stageId), reference);
  assert.throws(() => store.readBody(id, 'streamed', 'text', reference), { code: 'body_not_found' });
  assert.throws(() => store.mergeHistory(id, [{ id: 'streamed', kind: 'assistant', text: 'wrong preview', status: 'completed', bodies: { text: reference } }]), { code: 'body_preview_invalid' });
  store.mergeHistory(id, [{ id: 'streamed', kind: 'assistant', text: bytes.subarray(0, 8192).toString(), status: 'completed', bodies: { text: reference } }]);
  assert.equal(store.readBody(id, 'streamed', 'text', reference).data.length, 65536);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workbench_body_stages').get()?.n, 0);
});

test('maximum Unicode quote metadata stays bounded and remains exactly readable across replacement', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-body-quotes-'));
  const db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = createWorkbenchStore(db); const id = randomUUID();
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration: { modelId: 'fixture', permissionId: 'fixture' } });
  const references = Array.from({ length: 8 }, (_, n) => ({ type: 'quote' as const, itemId: `source-${n}`, text: '中'.repeat(8000) }));
  store.mergeHistory(id, [{ id: 'quotes', kind: 'user', status: 'completed', text: '请比较这些引用', references }]);
  const page = store.readHistory(id); const preview = page.items[0]!;
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 16384);
  assert.equal(preview.references, undefined);
  const reference = preview.bodies!.references!;
  const parts: Uint8Array[] = []; let offset: number | null = 0;
  while (offset !== null) {
    const part = store.readBody(id, 'quotes', 'references', reference, offset);
    parts.push(part.data); offset = part.nextOffset;
  }
  assert.deepEqual(JSON.parse(Buffer.concat(parts).toString()), references);
  store.mergeHistory(id, [preview]);
  store.mergeHistory(id, [{ id: 'quotes', kind: 'user', status: 'completed', text: 'new', references: [{ type: 'file', path: 'new.txt' }] }]);
  assert.equal(store.readBody(id, 'quotes', 'references', reference).bytes, Buffer.byteLength(JSON.stringify(references, null, 2)));
});

test('legacy body versions remain readable after migration and the first replacement', t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-body-legacy-'));
  let db = openDatabase(root, productMigrations.filter(migration => migration.version <= 10));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  let store = createWorkbenchStore(db); const id = randomUUID();
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration: { modelId: 'fixture', permissionId: 'fixture' } });
  const original = '\u0001旧🙂'.repeat(20000);
  store.mergeHistory(id, [{ id: 'legacy', kind: 'assistant', status: 'completed', text: original }]);
  db.close(); db = openDatabase(root, productMigrations); store = createWorkbenchStore(db);
  const reference = store.readHistory(id).items[0]!.bodies!.text!;
  const first = store.readBody(id, 'legacy', 'text', reference);
  assert.deepEqual(Buffer.from(first.data), Buffer.from(original).subarray(0, 65536));
  store.mergeHistory(id, [{ id: 'legacy', kind: 'assistant', status: 'completed', text: 'replacement' }]);
  const hash = createHash('sha256'); let offset: number | null = 0;
  while (offset !== null) { const part = store.readBody(id, 'legacy', 'text', reference, offset); hash.update(part.data); offset = part.nextOffset; }
  assert.equal(hash.digest('hex'), createHash('sha256').update(original).digest('hex'));
});

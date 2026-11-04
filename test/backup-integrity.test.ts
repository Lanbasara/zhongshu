import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { backupDatabase, openDatabase, restoreDatabase } from '../src/server/database.ts';
import { afterProductRestore, productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fixture(t: TestContext, schema?: number) {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-backup-audit-'));
  const db = openDatabase(join(root, 'source'), schema ? productMigrations.filter(value => value.version <= schema) : productMigrations);
  t.after(() => { try { db.close(); } catch { /* already closed */ } rmSync(root, { recursive: true, force: true }); });
  const store = createWorkbenchStore(db), id = randomUUID();
  const configuration = { modelId: 'synthetic', permissionId: 'synthetic' };
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic', configuration });
  store.saveBinding(id, { id: 'native-fixture', cwd: '/synthetic', configuration, details: {} });
  const text = '中🙂'.repeat(20_000);
  store.mergeHistory(id, [{ id: 'body', kind: 'assistant', text, status: 'completed', sourceRevision: { generation: 'synthetic', sequence: 1 } }]);
  return { root, db, store, id, text, backup: join(root, 'backup.sqlite'), target: join(root, 'restored') };
}

const corruptions: [string, (db: DatabaseSync, version: string, id: string) => void][] = [
  ['same-length chunk corruption', (db, version) => { db.prepare('UPDATE workbench_body_chunks SET data=? WHERE version=? AND part=0').run(Buffer.alloc(65536, 'x'), version); }],
  ['missing chunk', (db, version) => { db.prepare('DELETE FROM workbench_body_chunks WHERE version=? AND part=1').run(version); }],
  ['incorrect chunk order', (db, version) => { db.prepare('UPDATE workbench_body_chunks SET part=9 WHERE version=? AND part=0').run(version); }],
  ['manifest byte count', (db, version) => { db.prepare('UPDATE workbench_bodies SET bytes=bytes+1 WHERE version=?').run(version); }],
  ['published incomplete manifest', (db, version) => { db.prepare('UPDATE workbench_bodies SET complete=0 WHERE version=?').run(version); }],
  ['missing owner reference', (db, version) => { db.prepare('DELETE FROM workbench_body_refs WHERE version=?').run(version); }],
  ['descriptor byte count', (db, _version, id) => { db.prepare("UPDATE workbench_items SET metadata_json=json_set(metadata_json,'$.bodies.text.bytes',1) WHERE conversation_id=? AND id='body'").run(id); }],
  ['orphan historical owner', (db, version) => { db.prepare("UPDATE workbench_body_refs SET item_id='missing' WHERE version=?").run(version); }],
];
for (const [name, corrupt] of corruptions) test(`restore rejects ${name} before publishing a target database`, async t => {
  const f = fixture(t); const reference = f.store.getItem(f.id, 'body')!.bodies!.text!;
  await backupDatabase(f.db, f.backup);
  const backup = new DatabaseSync(f.backup);
  try {
    corrupt(backup, reference.version, f.id);
    assert.equal(backup.prepare('PRAGMA quick_check').get()!.quick_check, 'ok', 'SQLite structure alone does not establish archive integrity');
    assert.deepEqual(backup.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { backup.close(); }
  await assert.rejects(restoreDatabase(f.backup, f.target, afterProductRestore), { code: 'invalid_backup' });
  assert.equal(existsSync(join(f.target, 'zhongshu.sqlite')), false);
  assert.ok(existsSync(f.backup), 'a rejected source is retained for diagnosis');
});

test('backup verifies its copied body bytes and removes a rejected backup', async t => {
  const f = fixture(t); const reference = f.store.getItem(f.id, 'body')!.bodies!.text!;
  corruptions[0]![1](f.db, reference.version, f.id);
  await assert.rejects(backupDatabase(f.db, f.backup), { code: 'invalid_backup' });
  assert.equal(existsSync(f.backup), false);
});

for (const schema of [10, undefined]) test(`schema ${schema ?? 'current'} restores exact bodies, binding and unfinished staging to a new directory`, async t => {
  const f = fixture(t, schema); const reference = f.store.getItem(f.id, 'body')!.bodies!.text!;
  let stageId: string | undefined;
  if (!schema) {
    const pending = Buffer.alloc(2 * 65536, 'p');
    const stage = f.store.beginBodyStage(f.id, 'pending', 'text', { version: sha(pending), bytes: pending.length });
    stageId = stage.stageId; f.store.stageBodyChunk(stageId, 0, pending.subarray(0, 65536));
    // A retained empty original is a complete zero-chunk version, not a missing
    // part zero. Unknown stages remain incomplete and are never garbage-collected.
    f.db.prepare('INSERT INTO workbench_bodies(version,bytes,chunks,complete) VALUES(?,0,0,1)').run(sha(''));
    f.db.prepare('INSERT INTO workbench_body_refs VALUES(?,?,?,?)').run(f.id, 'body', 'input', sha(''));
  }
  const binding = f.store.getConversation(f.id)!.binding;
  await backupDatabase(f.db, f.backup);
  await restoreDatabase(f.backup, f.target, afterProductRestore);
  const restored = openDatabase(f.target, productMigrations);
  try {
    const store = createWorkbenchStore(restored); const hash = createHash('sha256'); let offset: number | null = 0;
    while (offset !== null) { const chunk = store.readBody(f.id, 'body', 'text', reference, offset); hash.update(chunk.data); offset = chunk.nextOffset; }
    assert.equal(hash.digest('hex'), sha(f.text)); assert.deepEqual(store.getConversation(f.id)!.binding, binding);
    if (stageId) {
      assert.equal(restored.prepare('SELECT next_offset FROM workbench_body_stages WHERE id=?').get(stageId)!.next_offset, 65536);
      assert.equal(restored.prepare('SELECT complete FROM workbench_bodies b JOIN workbench_body_stages s ON s.version=b.version WHERE s.id=?').get(stageId)!.complete, 0);
      assert.equal(restored.prepare('SELECT chunks FROM workbench_bodies WHERE version=?').get(sha(''))!.chunks, 0);
    }
    t.diagnostic(JSON.stringify({ sourceSchema: schema ?? productMigrations.at(-1)!.version, restoredSchema: productMigrations.at(-1)!.version, bodyBytes: Buffer.byteLength(f.text) }));
  } finally { restored.close(); }
});

test('the final private staging snapshot is verified after the restore hook', async t => {
  const f = fixture(t); const reference = f.store.getItem(f.id, 'body')!.bodies!.text!;
  await backupDatabase(f.db, f.backup);
  await assert.rejects(restoreDatabase(f.backup, f.target, db => {
    afterProductRestore(db); corruptions[0]![1](db, reference.version, f.id);
  }), { code: 'invalid_backup' });
  assert.equal(existsSync(join(f.target, 'zhongshu.sqlite')), false);
  // Rejecting a changed staging snapshot does not mutate the original backup.
  await restoreDatabase(f.backup, f.target, afterProductRestore);
});

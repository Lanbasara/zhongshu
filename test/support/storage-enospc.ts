/** Trusted disposable Linux probe. Refuses ordinary disks and tmpfs >128 MiB.
 * Real product repositories/SQLite/WAL; no Harness or browser success claim.
 * A captured pre-fill capacity sample models a competing allocator winning the
 * statfs-to-COMMIT race; ENOSPC itself is supplied by the kernel, never mocked.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statfsSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../../src/server/database.ts';
import { productMigrations } from '../../src/server/migrations.ts';
import { createWorkbenchStore } from '../../src/server/workbench-store.ts';

const mount = process.argv[2];
assert.equal(process.platform, 'linux'); assert.ok(mount && mount.startsWith('/'));
const disk = statfsSync(mount, { bigint: true });
assert.equal(disk.type, 0x01021994n, 'requires disposable tmpfs');
assert.ok(disk.blocks * disk.bsize <= 128n * 1024n ** 2n, 'refuse large filesystem');
const root = mkdtempSync(join(mount, 'zhongshu-enospc-'));
const started = performance.now();
let db: DatabaseSync | undefined; let reader: DatabaseSync | undefined; let filler: number | undefined;
const sourceDigest = createHash('sha256');
for (const path of ['src/server/migrations.ts', 'src/server/storage-capacity.ts', 'src/server/workbench-store.ts', 'src/server/body-store.ts', 'src/server/resources.ts']) sourceDigest.update(path).update(readFileSync(new URL('../../' + path, import.meta.url)));
const observations: Record<string, unknown> = { platform: process.platform, node: process.version, filesystem: 'tmpfs', filesystemBytes: Number(disk.blocks * disk.bsize), schema: productMigrations.at(-1)!.version, productSourceSha256: sourceDigest.digest('hex') };
try {
  const data = join(root, 'data'); mkdirSync(data);
  db = openDatabase(data, productMigrations);
  const options = { quotaBytes: 64 * 1024 ** 2, reserveBytes: 1024 ** 2, minimumFreeBytes: 1024 ** 2 };
  let store = createWorkbenchStore(db, { capacity: options });
  const id = randomUUID(); const input = { id, harnessId: 'codex' as const, workspaceId: 'synthetic', cwd: '/synthetic', configuration: { modelId: 'fixture', permissionId: 'fixture' } };
  store.createConversation(input);
  store.mergeHistory(id, [{ id: 'permanent', kind: 'assistant', status: 'completed', text: 'retained before ENOSPC' }]);
  const operation = { id: randomUUID(), conversationId: id, type: 'message' as const, payload: { text: 'already admitted' } };
  store.enqueueOperation(operation); store.claimOperation(operation.id);
  const file = String(db.prepare('PRAGMA database_list').get()!.file);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  reader = new DatabaseSync(file); reader.exec('BEGIN'); reader.prepare('SELECT COUNT(*) FROM workbench_items').get();
  store.mergeHistory(id, [{ id: 'wal-content', kind: 'assistant', status: 'completed', text: 'w'.repeat(65536) }]);
  observations.pinnedWalBytes = statSync(file + '-wal').size;
  assert.ok(Number(observations.pinnedWalBytes) > 0);
  const captured = store.capacity();
  filler = openSync(join(root, 'competing-allocator'), 'wx', 0o600);
  let allocated = 0; let kernelCode = '';
  try { for (let i = 0; i < 128; i++) allocated += writeSync(filler, Buffer.alloc(1024 ** 2)); }
  catch (error) { kernelCode = (error as NodeJS.ErrnoException).code ?? ''; }
  assert.equal(kernelCode, 'ENOSPC'); closeSync(filler); filler = undefined;
  observations.competingAllocationBytes = allocated; observations.kernelCode = kernelCode;
  observations.capacityAtFull = store.capacity();
  assert.equal(store.capacity().status, 'full');
  assert.throws(() => store.createConversation({ ...input, id: randomUUID() }), { code: 'storage_capacity_reached' });
  store = createWorkbenchStore(db, { capacity: { ...options, sample: () => ({ usedBytes: captured.usedBytes, freeBytes: captured.freeBytes }) } });
  let sqliteFailure = '';
  try { store.mergeHistory(id, [{ id: 'must-not-publish', kind: 'assistant', status: 'completed', text: 'x'.repeat(256 * 1024) }]); }
  catch (error) { sqliteFailure = (error as Error).message; }
  assert.equal(sqliteFailure, 'workbench_storage_failed'); observations.sqliteFailure = sqliteFailure;
  assert.equal(store.getItem(id, 'must-not-publish'), null);
  assert.equal(store.getItem(id, 'permanent')!.text, 'retained before ENOSPC');
  assert.equal(store.getOperation(operation.id)!.status, 'dispatching');
  observations.uncommittedAbsent = true; observations.priorArchiveReadable = true; observations.admittedOperationRetained = true;
  rmSync(join(root, 'competing-allocator'));
  reader.exec('ROLLBACK'); reader.close(); reader = undefined;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  store = createWorkbenchStore(db, { capacity: options });
  assert.notEqual(store.capacity().status, 'full');
  store.mergeHistory(id, [{ id: 'after-expansion', kind: 'assistant', status: 'completed', text: 'readable after space returned' }]);
  store.settleOperation(operation.id, { outcome: 'accepted', runId: 'original-native-run' });
  assert.equal(store.createConversation({ ...input, id: randomUUID() }).created, true);
  db.close(); db = openDatabase(data, productMigrations); store = createWorkbenchStore(db, { capacity: options });
  assert.equal(store.getItem(id, 'permanent')!.text, 'retained before ENOSPC');
  assert.equal(store.getItem(id, 'after-expansion')!.text, 'readable after space returned');
  assert.equal(store.getOperation(operation.id)!.runId, 'original-native-run');
  observations.reopenIntegrity = db.prepare('PRAGMA integrity_check').get()!.integrity_check;
  observations.resumedAfterSpaceReturned = true; observations.status = 'passed';
} finally {
  if (filler !== undefined) closeSync(filler);
  reader?.close(); db?.close(); rmSync(root, { recursive: true, force: true });
  observations.cleanedOwnedRoot = true; observations.elapsedMs = Math.round(performance.now() - started);
  process.stdout.write(JSON.stringify(observations) + '\n');
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { createStorageAccounting, DEFAULT_STORAGE_BUDGET, NATIVE_IMAGE_OWNER, parseStorageBudget, StorageBudgetError } from '../src/server/storage.ts';
import { loadConfig } from '../src/server/config.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==', 'base64');
/** Distinct images of a chosen size: the type check reads only the signature. */
const image = (bytes: number, seed: number) => Buffer.concat([png, Buffer.alloc(bytes - png.length - 4, seed % 251), Buffer.from(Uint32Array.of(seed).buffer)]);
const MiB = 1024 * 1024;

function fixture(t: TestContext, headroom: number) {
  const directory = mkdtempSync(join(tmpdir(), 'zhongshu-storage-'));
  const db = openDatabase(directory, productMigrations);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  // Measure the empty database first, so the budget leaves a known headroom for images.
  const baseline = createStorageAccounting(db).used();
  const store = createWorkbenchStore(db, { storageBudget: baseline + headroom });
  const id = randomUUID();
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'w', cwd: '/synthetic/workspace', configuration: { modelId: 'model', permissionId: 'workspace' } });
  return { db, store, id };
}

test('the budget refuses uploads at the limit while native image copies make room by evicting older copies only', t => {
  const { store, id } = fixture(t, 12 * MiB);
  const upload = store.resources.put(id, 'upload.png', image(2 * MiB, 1));
  store.resources.pin(id, upload.id, randomUUID());
  const snapshot = store.resources.put(id, 'snapshot.png', image(2 * MiB, 2), 'copy');
  store.resources.pin(id, snapshot.id, 'markdown:fixture');
  const copies = [3, 4, 5].map(seed => { const value = store.resources.put(id, 'copy.png', image(2 * MiB, seed), 'copy'); store.resources.pin(id, value.id, `${NATIVE_IMAGE_OWNER}item-${seed}:0`); return value; });
  const usage = store.storage.usage();
  assert.equal(usage.images.cache, 6 * MiB); assert.equal(usage.images.owned, 4 * MiB);
  assert.equal(usage.warning, true); assert.equal(usage.full, false);
  // Owned images never exceed the budget: the upload is refused and nothing is evicted for it.
  assert.throws(() => store.resources.put(id, 'refused.png', image(2 * MiB, 9)), StorageBudgetError);
  assert.equal(store.storage.usage().images.cache, 6 * MiB);
  // A new native copy evicts the oldest copy first, never the upload or the first-readable snapshot.
  const fresh = store.resources.put(id, 'fresh.png', image(2 * MiB, 6), 'copy');
  store.resources.pin(id, fresh.id, `${NATIVE_IMAGE_OWNER}item-6:0`);
  assert.throws(() => store.resources.get(id, copies[0]!.id), { message: 'image_unavailable' });
  assert.equal(store.resources.get(id, copies[2]!.id).data.length, 2 * MiB);
  assert.equal(store.resources.get(id, upload.id).data.length, 2 * MiB);
  assert.equal(store.resources.get(id, snapshot.id).data.length, 2 * MiB);
  assert.equal(store.storage.used() <= store.storage.budget, true);
});

test('clearing the cache frees space immediately, keeps owned images and lets uploads resume', t => {
  const { store, id } = fixture(t, 7 * MiB);
  const upload = store.resources.put(id, 'upload.png', image(2 * MiB, 1)); store.resources.pin(id, upload.id, randomUUID());
  for (const seed of [2, 3]) { const value = store.resources.put(id, 'copy.png', image(2 * MiB, seed), 'copy'); store.resources.pin(id, value.id, `${NATIVE_IMAGE_OWNER}item-${seed}:0`); }
  assert.throws(() => store.resources.put(id, 'refused.png', image(2 * MiB, 9)), StorageBudgetError);
  assert.throws(() => store.storage.assertRoom(2 * MiB), StorageBudgetError);
  const before = store.storage.used();
  store.storage.clearCache();
  assert.equal(store.storage.usage().images.cache, 0);
  assert.equal(store.storage.used() <= before - 4 * MiB, true, 'deleted rows count as free without a vacuum');
  assert.equal(store.resources.get(id, upload.id).data.length, 2 * MiB);
  store.storage.assertRoom(2 * MiB);
  const accepted = store.resources.put(id, 'accepted.png', image(2 * MiB, 10));
  assert.equal(store.resources.get(id, accepted.id).data.length, 2 * MiB);
});

test('retired history rows are measured separately and excluded from the budget', t => {
  const { db, store, id } = fixture(t, 64 * MiB);
  assert.equal(store.storage.usage().legacy, 0, 'empty retired tables report no copy');
  const empty = store.storage.used();
  const insert = db.prepare("INSERT INTO workbench_items(conversation_id,id,position,kind,text,status) VALUES(?,?,?,'assistant',?,'completed')");
  db.exec('BEGIN IMMEDIATE'); for (let n = 0; n < 2000; n++) insert.run(id, 'legacy-' + n, n * 1024, 'x'.repeat(1000)); db.exec('COMMIT');
  const fresh = createStorageAccounting(db, store.storage.budget);
  const usage = fresh.usage();
  assert.equal(usage.legacy >= 2000 * 1000, true);
  assert.equal(Math.abs(usage.used - empty) < 64 * 1024, true, 'retired rows do not consume the budget');
});

test('the storage budget accepts bytes and binary units, defaults to 16 GiB and rejects nonsense', () => {
  assert.equal(parseStorageBudget(undefined), DEFAULT_STORAGE_BUDGET);
  assert.equal(parseStorageBudget(''), 16 * 1024 ** 3);
  assert.equal(parseStorageBudget('512MiB'), 512 * MiB);
  assert.equal(parseStorageBudget(' 2 gib '), 2 * 1024 ** 3);
  assert.equal(parseStorageBudget(String(8 * MiB)), 8 * MiB);
  for (const value of ['16GB', '-1', '1KiB', '1.5GiB', 'lots']) assert.throws(() => parseStorageBudget(value), /invalid_storage_budget/);
  assert.equal(loadConfig({ ZHONGSHU_ORIGIN: 'http://127.0.0.1:3000', ZHONGSHU_ALLOW_HTTP_LOOPBACK: 'true', ZHONGSHU_STORAGE_BUDGET: '1GiB' }).storageBudget, 1024 ** 3);
});

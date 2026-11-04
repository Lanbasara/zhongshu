import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { DirectoryIndex } from '../src/server/directory-index.ts';
import type { DirectoryEntry, DirectoryPage, DirectoryPageInput } from '../src/server/directory-index.ts';

async function fixture(t: TestContext, options: ConstructorParameters<typeof DirectoryIndex>[1] = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zhongshu-directory-index-')));
  const workspace = join(root, 'workspace'); await mkdir(workspace, { mode: 0o700 });
  const indexDirectory = join(root, 'index');
  const index = new DirectoryIndex(indexDirectory, options);
  t.after(async () => { await index.close(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, indexDirectory, index, target: { root: workspace, path: '' } };
}
async function files(root: string, count: number, prefix = 'file-') {
  const names = Array.from({ length: count }, (_, index) => prefix + index.toString().padStart(5, '0') + '.txt');
  for (let start = 0; start < names.length; start += 32) await Promise.all(names.slice(start, start + 32).map(name => writeFile(join(root, name), name, { mode: 0o600, flag: 'wx' })));
  return names;
}
async function published(index: DirectoryIndex, target: DirectoryPageInput, previous?: string | null) {
  const deadline = Date.now() + 20_000;
  let last: DirectoryPage;
  do {
    last = await index.page(target);
    if (last.error) throw new Error(last.error);
    if (last.generation && last.generation !== previous && !last.refreshing) return last;
    await delay(2);
  } while (Date.now() < deadline);
  assert.fail('directory publication timeout: ' + JSON.stringify(last!));
}
async function collect(index: DirectoryIndex, target: DirectoryPageInput, first: DirectoryPage, pageBytes = 128 * 1024) {
  const entries: DirectoryEntry[] = []; let page = first; const cursors = new Set<string>();
  do {
    assert.equal(page.generation, first.generation);
    assert.ok(page.entries.length <= 100);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= pageBytes);
    entries.push(...page.entries);
    if (!page.nextCursor) return entries;
    assert.equal(cursors.has(page.nextCursor), false); cursors.add(page.nextCursor);
    page = await index.page({ ...target, cursor: page.nextCursor });
  } while (cursors.size < 1000);
  assert.fail('directory cursor did not terminate');
}

for (const count of [201, 10_000]) test('directory index completely pages ' + count + ' real files with a stable unique order', async t => {
  const f = await fixture(t);
  const expected = await files(f.workspace, count);
  if (count === 201) {
    await files(f.workspace, 2100, '.hidden-');
    await symlink(join(f.workspace, expected[0]!), join(f.workspace, 'forbidden-link.txt'));
  }
  const initial = await f.index.page(f.target);
  assert.equal(initial.status, 'scanning'); assert.deepEqual(initial.entries, []);
  assert.equal(initial.complete, false); assert.equal(initial.nextCursor, null);
  const first = await published(f.index, f.target);
  assert.equal(first.complete, true); assert.equal(first.snapshot, false);
  const actual = await collect(f.index, f.target, first);
  assert.deepEqual(actual.map(entry => entry.name), expected);
  assert.equal(new Set(actual.map(entry => entry.path)).size, count);
  assert.ok(actual.every(entry => entry.supported && !entry.directory));
  assert.equal(first.discovered, count);
  if (count === 201) assert.equal(first.scanned, 2302);
});

test('refresh retains the old generation while scanning and one previous generation after publication', async t => {
  const f = await fixture(t, { scanBatchSize: 1 });
  const expected = await files(f.workspace, 201);
  const first = await published(f.index, { ...f.target, limit: 3 });
  assert.ok(first.nextCursor);
  await rm(join(f.workspace, expected[5]!));
  await writeFile(join(f.workspace, 'new.txt'), 'new');
  const refresh = await f.index.refresh(f.target);
  assert.equal(refresh.generation, first.generation); assert.equal(refresh.refreshing, true);
  const second = await published(f.index, f.target, first.generation);
  assert.equal(second.complete, true);
  assert.deepEqual((await collect(f.index, f.target, first)).map(entry => entry.name), expected);
  const changed = expected.filter(name => name !== expected[5]).concat('new.txt');
  assert.deepEqual((await collect(f.index, f.target, second)).map(entry => entry.name), changed);
  await f.index.refresh(f.target); await published(f.index, f.target, second.generation);
  await assert.rejects(f.index.page({ ...f.target, cursor: first.nextCursor! }), { code: 'directory_cursor_expired', statusCode: 409 });
});

test('cancelled scans retain old data, survive reopening, and can be rebuilt', async t => {
  const f = await fixture(t, { scanBatchSize: 1 });
  const expected = await files(f.workspace, 201);
  const first = await published(f.index, f.target);
  await files(f.workspace, 1000, 'added-');
  await f.index.refresh(f.target);
  await f.index.cancel(f.target);
  let cancelled = await f.index.page(f.target);
  for (let attempt = 0; attempt < 100 && cancelled.refreshing; attempt++) { await delay(2); cancelled = await f.index.page(f.target); }
  assert.equal(cancelled.error, 'directory_scan_cancelled');
  assert.equal(cancelled.generation, first.generation);
  assert.deepEqual((await collect(f.index, f.target, cancelled)).map(entry => entry.name), expected);
  await f.index.close();
  const reopened = new DirectoryIndex(f.indexDirectory); t.after(() => reopened.close());
  const old = await reopened.page(f.target);
  assert.equal(old.generation, first.generation);
  await reopened.refresh(f.target);
  const repaired = await published(reopened, f.target, old.generation);
  assert.equal((await collect(reopened, f.target, repaired)).length, 1201);
  await reopened.close();
});

test('directory identity, traversal and symlink boundaries are checked independently of cached metadata', async t => {
  const f = await fixture(t);
  await files(f.workspace, 201);
  const first = await published(f.index, f.target);
  await assert.rejects(f.index.page({ ...f.target, path: '../outside' }));
  await assert.rejects(f.index.page({ ...f.target, path: '.hidden' }));
  await assert.rejects(f.index.page({ ...f.target, identity: 'wrong' }), { message: 'workspace_directory_changed' });
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.workspace, 'linked'));
  await assert.rejects(f.index.page({ ...f.target, path: 'linked' }));
  await rename(f.workspace, join(f.root, 'old-workspace')); await mkdir(f.workspace);
  await assert.rejects(f.index.page({ ...f.target, cursor: first.nextCursor! }), { code: 'directory_cursor_expired' });
  await writeFile(join(f.workspace, 'replacement.txt'), 'replacement');
  const replacement = await published(f.index, f.target);
  assert.deepEqual(replacement.entries.map(entry => entry.name), ['replacement.txt']);
});

test('request admission applies backpressure and closing rejects new requests', async t => {
  const f = await fixture(t, { maxPending: 1 });
  const first = f.index.page(f.target);
  await assert.rejects(f.index.page(f.target), { code: 'directory_index_busy', statusCode: 429 });
  await first;
  await f.index.close();
  await assert.rejects(f.index.page(f.target), { code: 'directory_index_closed', statusCode: 503 });
});

test('byte budgets, supported metadata, fixed byte ordering and explicit invalidation remain visible', async t => {
  const f = await fixture(t, { pageBytes: 8192 });
  const names = Array.from({ length: 100 }, (_, index) => index.toString().padStart(3, '0') + '-'.repeat(200) + '.txt');
  for (const name of names) await writeFile(join(f.workspace, name), 'synthetic');
  await mkdir(join(f.workspace, 'Z-directory'));
  await writeFile(join(f.workspace, 'unsupported.bin'), 'synthetic');
  const first = await published(f.index, f.target);
  assert.equal(first.entries[0]!.name, 'Z-directory');
  assert.ok(first.entries.length < 100);
  const all = await collect(f.index, f.target, first, 8192);
  assert.equal(all.length, 102);
  assert.equal(all.at(-1)!.supported, false);
  await f.index.invalidate(f.target);
  const stale = await f.index.page(f.target);
  assert.equal(stale.status, 'stale'); assert.equal(stale.sourceChanged, true); assert.equal(stale.complete, false);
  assert.equal(await readFile(join(f.workspace, names[0]!), 'utf8'), 'synthetic');
});

test('scan admission is bounded while another directory is scanning', async t => {
  const f = await fixture(t, { maxQueuedScans: 1, scanBatchSize: 1 });
  const targets = [];
  for (const path of ['one', 'two', 'three', 'four']) {
    const directory = join(f.workspace, path); await mkdir(directory); await files(directory, 500);
    targets.push({ root: f.workspace, path });
  }
  const results = await Promise.allSettled(targets.map(target => f.index.refresh(target)));
  const rejected = results.filter(result => result.status === 'rejected');
  assert.ok(rejected.length > 0);
  for (const result of rejected) assert.equal(result.reason.code, 'directory_scan_queue_full');
  await f.index.close();
});

test('a killed scanning process leaves the previously published generation intact', async t => {
  const f = await fixture(t);
  const expected = await files(f.workspace, 201);
  const first = await published(f.index, f.target);
  await f.index.close();
  await files(f.workspace, 2000, 'after-crash-');
  // Kill only this test's child, after it acknowledges starting a replacement
  // generation. It runs the same public API and never edits index tables.
  const script = `
    import { DirectoryIndex } from ${JSON.stringify(new URL('../src/server/directory-index.ts', import.meta.url).href)};
    const index = new DirectoryIndex(process.argv[2], { scanBatchSize: 1 });
    const page = await index.refresh({ root: process.argv[3], path: '' });
    console.log(JSON.stringify({ refreshing: page.refreshing, generation: page.generation }));
  `;
  const scriptPath = join(f.root, 'scan-child.mjs'); await writeFile(scriptPath, script, { mode: 0o600, flag: 'wx' });
  const child = spawn(process.execPath, [scriptPath, f.indexDirectory, f.workspace], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const started = await new Promise<{ refreshing: boolean; generation: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('crash_fixture_start_timeout')), 5000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('crash_fixture_early_exit')); });
    let output = '';
    child.stdout.on('data', data => {
      output += String(data);
      if (output.length > 4096) { clearTimeout(timeout); reject(new Error('crash_fixture_output_limit')); }
      if (!output.includes('\n')) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(output.slice(0, output.indexOf('\n')))); } catch (error) { reject(error); }
    });
  });
  assert.equal(started.refreshing, true); assert.equal(started.generation, first.generation);
  child.kill('SIGKILL'); await exited;
  const reopened = new DirectoryIndex(f.indexDirectory); t.after(() => reopened.close());
  const recovered = await reopened.page(f.target);
  assert.equal(recovered.error, 'directory_scan_interrupted');
  assert.equal(recovered.generation, first.generation);
  assert.deepEqual((await collect(reopened, f.target, recovered)).map(entry => entry.name), expected);
  await reopened.refresh(f.target);
  const rebuilt = await published(reopened, f.target, recovered.generation);
  assert.equal((await collect(reopened, f.target, rebuilt)).length, 2201);
  await reopened.close();
});

test('source changes during iteration are reported and an explicit stable rebuild finds the new set', async t => {
  const f = await fixture(t, { scanBatchSize: 1 });
  const expected = await files(f.workspace, 3000);
  await f.index.refresh(f.target);
  let progress = await f.index.page(f.target);
  for (let attempt = 0; attempt < 100 && !progress.scanned; attempt++) { await delay(1); progress = await f.index.page(f.target); }
  assert.equal(progress.refreshing, true); assert.ok(progress.scanned > 0);
  await rm(join(f.workspace, expected[0]!));
  await rename(join(f.workspace, expected[1]!), join(f.workspace, 'renamed.txt'));
  await writeFile(join(f.workspace, 'new.txt'), 'new');
  const changed = await published(f.index, f.target);
  assert.equal(changed.status, 'stale'); assert.equal(changed.sourceChanged, true); assert.equal(changed.complete, false);
  await f.index.refresh(f.target);
  const rebuilt = await published(f.index, f.target, changed.generation);
  assert.equal(rebuilt.complete, true);
  assert.deepEqual((await collect(f.index, f.target, rebuilt)).map(entry => entry.name), expected.slice(2).concat(['new.txt', 'renamed.txt']));
});

test('bounded directory cache evicts rebuildable listings instead of imposing a workspace lifetime cap', async t => {
  const f = await fixture(t, { maxDirectories: 2 });
  const pages = [];
  for (const path of ['one', 'two', 'three']) {
    const directory = join(f.workspace, path); await mkdir(directory); await files(directory, 3);
    pages.push(await published(f.index, { root: f.workspace, path, limit: 1 }));
  }
  await assert.rejects(f.index.page({ root: f.workspace, path: 'one', cursor: pages[0]!.nextCursor! }), { code: 'directory_cursor_expired' });
  const rebuilt = await published(f.index, { root: f.workspace, path: 'one' });
  assert.equal(rebuilt.entries.length, 3);
  assert.notEqual(rebuilt.generation, pages[0]!.generation);
});

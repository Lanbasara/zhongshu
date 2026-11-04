import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { SavePermit } from '../src/server/execution-coordinator.ts';
import { openWorkspaceDocument, directoryIdentity } from '../src/server/workspace-documents.ts';
import { WorkspaceFileWriter } from '../src/server/workspace-writer.ts';
import { pausedWriter } from './support/workspace-writer-fixture.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'zhongshu-file-writer-')));
  const root = join(directory, 'workspace'); await mkdir(root); await writeFile(join(root, 'note.md'), 'original');
  const dataDirectory = join(directory, 'writer'); const writers: WorkspaceFileWriter[] = [];
  t.after(async () => { for (const writer of writers) await writer.close(); await rm(directory, { recursive: true, force: true }); });
  const writer = (capacity?: { quotaBytes: number; reserveBytes: number; minimumFreeBytes: number }) => { const value = new WorkspaceFileWriter({ dataDirectory, capacity }); writers.push(value); return value; };
  const permit = async (writerId: string, text = 'new content'): Promise<SavePermit> => ({ saveId: randomUUID(), windowId: 'synthetic-closed-window', writerId,
    write: { workspaceId: 'workspace', directoryIdentity: directoryIdentity(await stat(root, { bigint: true }))!, path: 'note.md', expectedVersion: (await openWorkspaceDocument(root, 'note.md')).version, contentDigest: hash(text) },
    groups: [{ groupId: 'synthetic-host', controller: { generation: 'synthetic-generation', epoch: 2 } }] });
  return { directory, root, dataDirectory, writer, permit };
}

test('one writer holds an actual cross-process SQLite owner lock and records durable conditional saves', async t => {
  const f = await fixture(t); const writer = f.writer(); const ownerId = await writer.owner();
  const contender = new DatabaseSync(join(f.dataDirectory, 'owner', 'zhongshu.sqlite'));
  try { contender.exec('PRAGMA busy_timeout=0'); assert.throws(() => contender.exec('BEGIN IMMEDIATE'), /locked/); } finally { contender.close(); }
  const permit = await f.permit(ownerId); const result = await writer.write({ root: f.root, permit, text: 'new content' });
  assert.equal(result.outcome, 'committed'); assert.equal(await readFile(join(f.root, 'note.md'), 'utf8'), 'new content');
  const before = await stat(join(f.root, 'note.md'), { bigint: true });
  assert.equal((await writer.write({ root: f.root, permit, text: 'new content' })).outcome, 'committed');
  assert.equal((await stat(join(f.root, 'note.md'), { bigint: true })).ino, before.ino, 'same save ID never repeats rename');
  await assert.rejects(writer.write({ root: f.root, permit: { ...permit, write: { ...permit.write, contentDigest: hash('changed') } }, text: 'changed' }), /file_writer_save_conflict/);
  const notStarted = await f.permit(ownerId, 'not yet sent');
  assert.equal((await writer.recover({ root: f.root, permit: notStarted })).outcome, 'pending', 'same-owner permit may still be on its way to the writer');
  await writer.close();
  const next = f.writer(); assert.notEqual(await next.owner(), ownerId);
  const recovered = await next.recover({ root: f.root, permit: notStarted }); assert.equal(recovered.outcome, 'rejected');
  assert.deepEqual(await next.recover({ root: f.root, permit: notStarted }), recovered);
});

for (const stage of ['intent', 'renamed', 'recorded'] as const) test(`SIGKILL at ${stage}: a new OS-fenced owner reconciles without repeating the uncertain filesystem effect`, async t => {
  const f = await fixture(t); const crashed = await pausedWriter(t, f.dataDirectory, stage);
  const permit = await f.permit(crashed.ownerId); await crashed.write({ root: f.root, permit, text: 'new content' });
  const before = await stat(join(f.root, 'note.md'), { bigint: true });
  const lock = new DatabaseSync(join(f.dataDirectory, 'owner', 'zhongshu.sqlite'));
  try { lock.exec('PRAGMA busy_timeout=0'); assert.throws(() => lock.exec('BEGIN IMMEDIATE'), /locked/); } finally { lock.close(); }
  crashed.child.kill('SIGKILL'); await crashed.exited;
  const recoveredWriter = f.writer(); assert.notEqual(await recoveredWriter.owner(), crashed.ownerId);
  const result = await recoveredWriter.recover({ root: f.root, permit });
  assert.equal(result.outcome, stage === 'intent' ? 'rejected' : 'committed');
  assert.equal((await stat(join(f.root, 'note.md'), { bigint: true })).ino, before.ino, 'recovery does not rename or replay the original input');
  assert.equal(await readFile(join(f.root, 'note.md'), 'utf8'), stage === 'intent' ? 'original' : 'new content');
});

test('an externally changed target remains unknown after owner recovery and is never overwritten', async t => {
  const f = await fixture(t); const crashed = await pausedWriter(t, f.dataDirectory, 'intent'); const permit = await f.permit(crashed.ownerId);
  await crashed.write({ root: f.root, permit, text: 'new content' }); crashed.child.kill('SIGKILL'); await crashed.exited;
  await writeFile(join(f.root, 'note.md'), 'external change');
  const writer = f.writer(); const recovered = await writer.recover({ root: f.root, permit });
  assert.equal(recovered.outcome, 'unknown'); assert.equal(await readFile(join(f.root, 'note.md'), 'utf8'), 'external change');
});

test('writer quota durably rejects new saves but preserves old receipts and reserves space for old-owner recovery', async t => {
  const f = await fixture(t); const first = f.writer(); const ownerId = await first.owner();
  const committed = await f.permit(ownerId); assert.equal((await first.write({ root: f.root, permit: committed, text: 'new content' })).outcome, 'committed');
  const unstarted = await f.permit(ownerId, 'unstarted'); await first.close();
  const limited = f.writer({ quotaBytes: 1024 ** 2, reserveBytes: 1024 ** 2 - 4096, minimumFreeBytes: 0 });
  const next = await f.permit(await limited.owner(), 'must not write');
  const rejected = await limited.write({ root: f.root, permit: next, text: 'must not write' });
  assert.equal(rejected.outcome, 'rejected'); assert.ok('reason' in rejected && rejected.reason === 'file_writer_capacity_reached');
  assert.deepEqual(await limited.write({ root: f.root, permit: next, text: 'must not write' }), rejected);
  assert.equal((await limited.write({ root: f.root, permit: committed, text: 'new content' })).outcome, 'committed');
  assert.equal((await limited.recover({ root: f.root, permit: unstarted })).outcome, 'rejected');
  assert.equal(await readFile(join(f.root, 'note.md'), 'utf8'), 'new content');
  await limited.close();
  const expanded = f.writer(); const after = await f.permit(await expanded.owner(), 'after expansion');
  assert.equal((await expanded.write({ root: f.root, permit: after, text: 'after expansion' })).outcome, 'committed');
});

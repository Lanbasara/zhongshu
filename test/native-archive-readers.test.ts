import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyNativeArchive } from './support/native-archive-verify.ts';
import { createPhysicalArchiveFixture } from './support/native-archive-fixture.ts';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

for (const harness of ['codex', 'dsh'] as const) test(`${harness} physical reader archives through Workbench and worker storage, resumes a gap and retains exact bodies after restart`, async () => {
  const result = await verifyNativeArchive({ harness, count: 37, gap: 19 });
  assert.equal(result.status, 'PASS'); assert.equal(result.offline.messages, 37);
  assert.equal(result.gap.appended, 19); assert.equal(result.nativeSourcesUnchanged, true);
  assert.equal(result.shapes.fileEdits, 'PASS');
  if (harness === 'codex') assert.equal(result.shapes.generatedImage, 'PASS');
  assert.deepEqual(result.restart, { items: result.gap.items, pages: result.gap.pages, bodyChunks: result.gap.bodyChunks, manifestSha256: result.gap.manifestSha256 });
});

test('DSH compressed migration-frame physical archive preserves the same bodies through gap recovery', async () => {
  const result = await verifyNativeArchive({ harness: 'dsh', dshCompressed: true, count: 37, gap: 19 });
  assert.equal(result.status, 'PASS'); assert.equal(result.gap.items, 57); assert.equal(result.restart.manifestSha256, result.gap.manifestSha256);
});

for (const harness of ['codex', 'dsh'] as const) test(`${harness} shared HTTP fixture physical source reopens and appends without preloading product history`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zh-physical-fixture-')), root = await realpath(directory), cwd = join(root, 'workspace'); await mkdir(cwd);
  const options = { root: join(root, 'physical'), cwd, harness, bindingId: 'fixture-reader', count: 21 };
  let fixture;
  try {
    fixture = await createPhysicalArchiveFixture(options);
    const binding = fixture.binding;
    const head = await fixture.reads.history(binding, undefined, 1); assert.equal(head.items.length, 1); assert(head.items[0]!.text.includes('000020'));
    await fixture.appendGap(11); const before = await fixture.manifest(); assert.equal(before.count, 32); await fixture.close();
    fixture = await createPhysicalArchiveFixture(options); assert.equal((await fixture.manifest()).manifestSha256, before.manifestSha256);
    const newest = await fixture.reads.history(binding, undefined, 1); assert(newest.items[0]!.text.includes('000031'));
    assert.equal((await fixture.manifest()).methods['thread/resume'], undefined);
    await assert.rejects(async () => fixture!.reads.history({ ...binding, id: 'wrong' }), /physical_fixture_binding_mismatch/);
  } finally { await fixture?.close(); await rm(root, { recursive: true, force: true }); }
});

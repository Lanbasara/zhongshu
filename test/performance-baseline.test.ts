import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReadingSamples, runPerformanceBaseline, writeBaselineJson } from './support/performance-baseline.ts';

test('performance baseline drives real product paths and reports boundaries without requiring defects forever', async () => {
  const report = await runPerformanceBaseline();
  assert.equal(report.mode, 'synthetic-harness-real-workbench');
  assert.equal(report.results.length, 3);
  assert.deepEqual(report.results.map(result => result.scenario), ['workspace-edit', 'history-catchup', 'directory']);
  for (const result of report.results) {
    assert.notEqual(result.status, 'scenario-error', JSON.stringify(result));
    assert.equal(result.status, Object.values(result.checks).every(Boolean) ? 'satisfied' : 'boundary-observed');
    assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
    assert.deepEqual(result.cleanup, { workbenchesClosed: true, databasesClosed: true, indexWorkersClosed: true, rootsRemoved: true, subscriptionsClosed: true, errors: [] });
  }
  assert.equal(report.results[0]!.actual.conversations, 40);
  assert.equal(report.results[1]!.actual.cachedBefore, 100);
  assert.equal(report.results[1]!.actual.nativeItems, 2101);
  assert.equal(report.results[1]!.checks.previousHistoryPreserved, true);
  assert.equal(report.results[2]!.expected.files, 201);
});

test('small controls establish that the fixture can save, recover exact history and enumerate files', async () => {
  const report = await runPerformanceBaseline({ conversations: 3, cachedItems: 10, offlineItems: 21, files: 5 });
  for (const result of report.results) assert.equal(result.status, 'satisfied', JSON.stringify(result));
  assert.equal(report.results[0]!.actual.fileSaved, true);
  assert.equal(report.results[1]!.actual.totalItems, 31);
  assert.equal(report.results[1]!.actual.exactHistory, true);
  assert.equal(report.results[2]!.actual.files, 5);
  await assert.rejects(runPerformanceBaseline({ files: 1_000_000 }));
  await assert.rejects(runPerformanceBaseline({ scenarios: ['directory', 'directory'] }));
});

test('JSON export creates a private file and rejects existing files, symlinks and relative paths', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zhongshu-baseline-output-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, 'evidence.json');
  const evidence = { format: 1, synthetic: true };
  await writeBaselineJson(destination, evidence);
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), evidence);
  assert.equal((await stat(destination)).mode & 0o077, 0);
  await assert.rejects(writeBaselineJson(destination, { overwritten: true }));
  await symlink(destination, join(root, 'link.json'));
  await assert.rejects(writeBaselineJson(join(root, 'link.json'), evidence));
  await assert.rejects(writeBaselineJson('relative.json', evidence));
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), evidence);
});

test('reading corpus is deterministic, exact-sized, and explicitly not browser evidence', () => {
  const corpus = createReadingSamples();
  assert.deepEqual(createReadingSamples(), corpus);
  assert.equal(corpus.mode, 'export-only-not-browser-evidence');
  assert.equal(corpus.samples[0]!.items.length, 82);
  assert.equal(corpus.samples[1]!.expected.utf8Bytes, 1024 * 1024);
  for (const sample of corpus.samples) assert.equal(sample.expected.sha256, createHash('sha256').update(JSON.stringify(sample.items)).digest('hex'));
});

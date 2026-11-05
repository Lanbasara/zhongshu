import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { createStorageClient } from '../../src/server/storage-client.ts';

// Test-only child: a parent-owned synthetic directory, no HTTP, native Harness,
// credentials or product hooks. SIGKILL terminates this process and its worker.
const [directory, conversationId, point] = z.tuple([
  z.string().refine(value => isAbsolute(value) && basename(value).startsWith('zhongshu-archive-crash-')),
  z.uuid(), z.enum(['page', 'chunk', 'prepared', 'committed']),
]).parse(process.argv.slice(2));
const bytes = await readFile(join(directory, 'source.txt'));
if (bytes.length > 2 * 1024 ** 2) throw Error('crash_fixture_source_too_large');
const reference = { version: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
const client = createStorageClient({ dataDirectory: directory }); await client.ready;
const job = await client.store.claimArchiveJob(conversationId, 'backfill', true);
if (!job) throw Error('crash_fixture_job_missing');
const revision = { generation: 'synthetic-source', sequence: 2 };
const preview = Array.from(bytes.toString('utf8')).slice(0, 100).join('');
const items = [
  { id: 'target', kind: 'assistant' as const, status: 'completed' as const, text: preview, bodies: { text: reference }, sourceRevision: revision },
  { id: 'tail', kind: 'assistant' as const, status: 'completed' as const, text: 'tail' },
];
async function reached(stage: typeof point) {
  if (point !== stage) return;
  process.stdout.write(JSON.stringify({ point, pid: process.pid, job }) + '\n');
  await new Promise(() => { setInterval(() => {}, 60_000); });
}
await reached('page');
const stage = await client.store.beginBodyStage(conversationId, 'target', 'text', reference, revision);
for (let offset = 0; offset < bytes.length; offset += 65536) {
  await client.store.stageBodyChunk(stage.stageId, offset, bytes.subarray(offset, offset + 65536));
  if (offset === 65536) await reached('chunk');
}
while (!(await client.store.validateBodyStage(stage.stageId)).complete) { /* bounded validation batches */ }
await client.store.finishBodyStage(stage.stageId);
await reached('prepared');
if (!await client.store.commitArchivePage(job, items, 'next-page')) throw Error('crash_fixture_commit_rejected');
// The marker is test instrumentation after durable commit, not a native receipt.
await reached('committed');

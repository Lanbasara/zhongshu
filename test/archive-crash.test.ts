import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { NativeItem } from '../src/harness/types.ts';
import type { ArchiveJob } from '../src/server/workbench-store.ts';
import { createStorageClient } from '../src/server/storage-client.ts';

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

for (const point of ['page', 'chunk', 'prepared', 'committed'] as const) {
  test(`archive SIGKILL at ${point} preserves checkpoint, old body and exact resumable content`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'zhongshu-archive-crash-'));
    const clients: ReturnType<typeof createStorageClient>[] = [];
    let stopChild = async () => {};
    t.after(async () => { await stopChild(); for (const client of clients) await client.close(); await rm(directory, { recursive: true, force: true }); });
    const open = async () => { const client = createStorageClient({ dataDirectory: directory }); clients.push(client); await client.ready; return client; };
    const original = await open(), id = randomUUID();
    const configuration = { modelId: 'fixture', permissionId: 'fixture' };
    const binding = { id: 'original-native-binding', cwd: '/synthetic', configuration, details: {} };
    await original.store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: binding.cwd, configuration });
    await original.store.saveBinding(id, binding);
    const operation = { id: randomUUID(), conversationId: id, type: 'message' as const, payload: { text: 'original input' } };
    await original.store.enqueueOperation(operation); await original.store.claimOperation(operation.id);
    const oldText = '旧版完整正文🙂';
    await original.store.mergeHistory(id, [
      { id: 'target', kind: 'assistant', status: 'completed', text: oldText, sourceRevision: { generation: 'synthetic-source', sequence: 1 } },
      { id: 'tail', kind: 'assistant', status: 'completed', text: 'tail' },
    ]);
    const bytes = Buffer.from('中🙂档案\n'.repeat(100_000));
    const reference = { version: sha(bytes), bytes: bytes.length };
    await writeFile(join(directory, 'source.txt'), bytes, { mode: 0o600 });
    await original.close();

    const child = spawn(process.execPath, [fileURLToPath(new URL('./support/archive-crash-fixture.ts', import.meta.url)), directory, id, point], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    stopChild = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; };
    const reached = await new Promise<{ point: string; pid: number; job: ArchiveJob }>((resolve, reject) => {
      let output = '', diagnostic = '';
      const timer = setTimeout(() => reject(Error('archive_crash_fixture_checkpoint_timeout')), 15_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(Error('archive_crash_fixture_early_exit: ' + diagnostic)); });
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.length > 8192) { clearTimeout(timer); reject(Error('archive_crash_fixture_output_limit')); }
        else if (output.includes('\n')) {
          clearTimeout(timer);
          try { resolve(JSON.parse(output.trim())); } catch (error) { reject(error); }
        }
      });
    });
    assert.equal(reached.point, point); assert.equal(reached.pid, child.pid, 'kill the actual process, not a launcher');
    child.kill('SIGKILL'); assert.equal((await exited).signal, 'SIGKILL');

    const recovered = await open(), store = recovered.store;
    assert.deepEqual((await store.getConversation(id))!.binding, binding);
    assert.equal((await store.getOperation(operation.id))!.status, 'dispatching');
    assert.equal((await store.enqueueOperation(operation)).created, false, 'same operation identity survives without a new claim');
    assert.equal(await store.claimOperation(operation.id), null);
    let checkpoint = (await store.archiveJobs(id)).find(value => value.kind === 'backfill')!;
    assert.equal(checkpoint.pages, point === 'committed' ? 1 : 0);
    assert.equal(checkpoint.cursor, point === 'committed' ? 'next-page' : null);
    assert.equal(checkpoint.complete, false);
    assert.equal(Buffer.from((await store.readBody(id, 'target', 'text', { version: sha(oldText), bytes: Buffer.byteLength(oldText) })).data).toString(), oldText);
    if (point !== 'committed') {
      assert.equal((await store.getItem(id, 'target'))!.text, oldText);
      await assert.rejects(store.readBody(id, 'target', 'text', reference), { code: 'body_not_found' });
      const stage = await store.beginBodyStage(id, 'target', 'text', reference, { generation: 'synthetic-source', sequence: 2 });
      assert.equal(stage.nextOffset, point === 'page' ? 0 : point === 'chunk' ? 2 * 65536 : bytes.length);
      for (let offset = stage.nextOffset; offset < bytes.length; offset += 65536) await store.stageBodyChunk(stage.stageId, offset, bytes.subarray(offset, offset + 65536));
      while (!(await store.validateBodyStage(stage.stageId)).complete) { /* hash validation restarts safely */ }
      await store.finishBodyStage(stage.stageId);
      const current = (await store.claimArchiveJob(id, 'backfill', true))!;
      const items: NativeItem[] = [
        { id: 'target', kind: 'assistant', status: 'completed', text: Array.from(bytes.toString()).slice(0, 100).join(''), bodies: { text: reference }, sourceRevision: { generation: 'synthetic-source', sequence: 2 } },
        { id: 'tail', kind: 'assistant', status: 'completed', text: 'tail' },
      ];
      assert.equal(await store.commitArchivePage(reached.job, items, 'next-page'), false, 'old claim cannot publish after restart/reclaim');
      assert.equal(await store.commitArchivePage(current, items, 'next-page'), true);
    }
    const next = (await store.claimArchiveJob(id, 'backfill', true))!;
    assert.equal(next.cursor, 'next-page');
    assert.equal(await store.commitArchivePage(next, [{ id: 'older', kind: 'assistant', text: 'older', status: 'completed' }], null), true);
    checkpoint = (await store.archiveJobs(id)).find(value => value.kind === 'backfill')!;
    assert.equal(checkpoint.pages, 2); assert.equal(checkpoint.complete, true); assert.equal(checkpoint.cursor, null);
    assert.deepEqual((await store.readHistory(id)).items.map(value => value.id), ['older', 'target', 'tail']);
    const hash = createHash('sha256'); let count = 0, offset: number | null = 0;
    while (offset !== null) { const part = await store.readBody(id, 'target', 'text', reference, offset); hash.update(part.data); count += part.data.length; offset = part.nextOffset; }
    assert.equal(count, bytes.length); assert.equal(hash.digest('hex'), reference.version);
    assert.equal((await store.getOperation(operation.id))!.status, 'dispatching');
    t.diagnostic(JSON.stringify({ point, signal: 'SIGKILL', bodyBytes: count, pages: checkpoint.pages, identityPreserved: true }));
  });
}

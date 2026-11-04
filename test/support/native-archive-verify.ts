import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, open, appendFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createZstdCompress, zstdCompressSync, constants as zstdConstants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { createCodexAdapter } from '../../src/harness/codex/index.ts';
import { createDshAdapter } from '../../src/harness/dsh/index.ts';
import { modelId } from '../../src/harness/dsh/native.ts';
import { createStorageClient } from '../../src/server/storage-client.ts';
import type { StorageClient } from '../../src/server/storage-client.ts';
import { Workbench } from '../../src/server/workbench.ts';
import type { HarnessAdapter, HarnessId, Binding } from '../../src/harness/types.ts';
import { nativeArchiveText } from './native-archive-fixture.ts';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const parameters = z.object({ harness: z.enum(['codex', 'dsh']), count: z.number().int().min(1).max(100_000), gap: z.number().int().min(1).max(100_000), progress: z.boolean().optional(), keepFailure: z.boolean().optional(), dshCompressed: z.boolean().optional() }).refine(value => !value.dshCompressed || value.harness === 'dsh');
/** Real physical importers, Workbench archive pump, worker-owned storage and published body reads.
 * The only simulated service is Codex's read-only thread/path metadata endpoint.
 * No history, item, staged body or cursor is inserted directly into product storage.
 */
export async function verifyNativeArchive(input: z.infer<typeof parameters>) {
  const options = parameters.parse(input), root = await mkdtemp(join(tmpdir(), 'zh-native-archive-'));
  let phase = 'prepare', lastBatch = 0, failed = false, aborted = false;
  const abort = () => { aborted = true; }; process.on('SIGINT', abort); process.on('SIGTERM', abort);
  const checkAbort = () => { if (aborted) throw new Error('verification_aborted'); };
  const codeVersions: { phase: string; sha256: string }[] = [];
  const cwd = join(root, 'workspace'), nativeRoot = join(root, 'native'), cacheRoot = join(root, 'cache'), dataDirectory = join(root, 'product'), socketPath = join(root, 'metadata.sock');
  await mkdir(cwd); await mkdir(nativeRoot);
  const nativeId = 'synthetic-archive', id = randomUUID();
  const configuration = options.harness === 'codex' ? { modelId: 'synthetic', permissionId: ':read-only' } : { modelId: modelId({ provider: 'synthetic', model: 'synthetic' }), permissionId: 'read-only' };
  const binding: Binding = { id: nativeId, cwd, configuration, details: options.harness === 'codex' ? { version: 1, approvalPolicy: 'never' } : {} };
  const project = `--${cwd.replace(/[\\/:]+/g, '-').replace(/^-+/, '').slice(0, 251)}--`;
  const source = options.harness === 'codex' ? join(nativeRoot, 'sessions', '2026', 'rollout-synthetic.jsonl') : join(nativeRoot, project, nativeId, options.dshCompressed ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl');
  await mkdir(resolve(source, '..'), { recursive: true });
  let ordinal = 0, sequence = 0;
  const header = options.harness === 'codex' ? { ordinal: 0, type: 'session_meta', payload: { id: nativeId, cwd, cli_version: '0.166.0-alpha.5.1', history_mode: 'paginated' } }
    : { type: 'session', version: 4, id: nativeId, cwd, createdAt: 0, isSeeded: false, delegationDepth: 0 };
  const encode = (text: string) => options.dshCompressed ? zstdCompressSync(text, { params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 } }) : text;
  await writeFile(source, encode(JSON.stringify(header) + '\n'), { mode: 0o600 });
  if (options.harness === 'dsh') await appendFile(source, encode(JSON.stringify({ seq: sequence++, time: 0, type: 'turn/start', data: { turn: 1 } }) + '\n'));
  const expected = new Map<string, { sha256: string; bytes: number }>();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5FYAAAAASUVORK5CYII=';
  const fileItemId = options.harness === 'codex' ? 'synthetic-file' : `dsh:${nativeId}:tool:synthetic-write`;
  let shapeCount = 0;
  const itemId = (n: number) => options.harness === 'codex' ? `message-${n}` : `dsh:${nativeId}:assistant:1:${n + 1}`;
  async function append(from: number, count: number) {
    const frame = join(root, 'next-frame.jsonl');
    const file = await open(options.dshCompressed ? frame : source, options.dshCompressed ? 'wx' : 'a', 0o600);
    try {
      for (let n = from; n < from + count; n++) {
        checkAbort();
        const text = nativeArchiveText(n);
        expected.set(itemId(n), { sha256: digest(text), bytes: Buffer.byteLength(text) });
        const row = options.harness === 'codex' ? { ordinal: ++ordinal, timestamp: new Date(0).toISOString(), type: 'event_msg', payload: { type: 'item_completed', thread_id: nativeId, turn_id: 'run-1', item: { type: 'AgentMessage', id: itemId(n), content: [{ type: 'Text', text }] } } }
          : { seq: sequence++, time: n + 1, type: 'assistant/message', data: { turn: 1, step: n + 1, message: { content: [{ type: 'text', text }] } } };
        await file.write(JSON.stringify(row) + '\n');
      }
      await file.sync();
    } finally { await file.close(); }
    if (options.dshCompressed) {
      try { await pipeline(createReadStream(frame), createZstdCompress({ params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 } }), createWriteStream(source, { flags: 'a', mode: 0o600 })); }
      finally { await rm(frame, { force: true }); }
    }
  }
  async function appendShapes() {
    if (options.harness === 'codex') {
      const items = [
        { type: 'FileChange', id: fileItemId, status: 'completed', changes: { [join(cwd, 'native-output.txt')]: { type: 'add', content: 'SYNTHETIC_FILE_BODY' } } },
        { type: 'ImageGeneration', id: 'synthetic-image', status: 'completed', result: png },
        { type: 'ImageGeneration', id: 'synthetic-image-failed', status: 'failed', result: '' },
      ];
      for (const item of items) {
        const text = JSON.stringify(item); expected.set(item.id, { sha256: digest(text), bytes: Buffer.byteLength(text) }); shapeCount++;
        await appendFile(source, JSON.stringify({ ordinal: ++ordinal, type: 'event_msg', payload: { type: 'item_completed', thread_id: nativeId, turn_id: 'run-1', item } }) + '\n');
      }
      const empty = { type: 'AgentMessage', id: 'synthetic-empty', content: [{ type: 'Text', text: '' }] };
      expected.set(empty.id, { sha256: digest(''), bytes: 0 }); shapeCount++;
      await appendFile(source, JSON.stringify({ ordinal: ++ordinal, type: 'event_msg', payload: { type: 'item_completed', thread_id: nativeId, turn_id: 'run-1', item: empty } }) + '\n');
    } else {
      const text = 'SYNTHETIC_FILE_BODY'; expected.set(fileItemId, { sha256: digest(text), bytes: Buffer.byteLength(text) }); shapeCount++;
      await appendFile(source, encode(JSON.stringify({ seq: sequence++, time: 1, type: 'tool/call', data: { callId: 'synthetic-write', name: 'write', input: { path: join(cwd, 'native-output.txt'), text } } }) + '\n' + JSON.stringify({ seq: sequence++, time: 2, type: 'tool/result', data: { message: { toolCallId: 'synthetic-write', isError: false, content: [{ type: 'text', text }] }, meta: { path: join(cwd, 'native-output.txt'), operation: 'create' } } }) + '\n'));
    }
  }
  const http = createServer(), ws = new WebSocketServer({ server: http }); const methods = new Map<string, number>();
  ws.on('connection', socket => socket.on('message', bytes => {
    const request = JSON.parse(bytes.toString()) as { id?: number; method?: string; params?: { threadId?: string } };
    if (request.id === undefined || !request.method) return;
    methods.set(request.method, (methods.get(request.method) ?? 0) + 1);
    if (request.method === 'initialize') socket.send(JSON.stringify({ id: request.id, result: { codexHome: nativeRoot } }));
    else if (request.method === 'thread/read' && request.params?.threadId === nativeId) socket.send(JSON.stringify({ id: request.id, result: { thread: { id: nativeId, cwd, path: source, cliVersion: '0.166.0-alpha.5.1', status: { type: 'notLoaded' } } } }));
    else socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Synthetic metadata peer does not execute work.' } }));
  }));
  await new Promise<void>(done => http.listen(socketPath, done));
  let storage: StorageClient | undefined, service: Workbench | undefined;
  let maxRss = 0, ticks = 0, previousTick = performance.now(), maxDelayMs = 0, lastMemorySample = 0, maxStorageHeap = 0, maxStorageExternal = 0;
  const storageSamples: { phase: string; batch: number; state: ReturnType<StorageClient['diagnostics']> }[] = [];
  const sampleStorage = () => { if (!storage) return; const state = storage.diagnostics(); maxStorageHeap = Math.max(maxStorageHeap, state.memory?.heapUsed ?? 0); maxStorageExternal = Math.max(maxStorageExternal, state.memory?.external ?? 0); if (storageSamples.length === 64) storageSamples.shift(); storageSamples.push({ phase, batch: lastBatch, state }); };
  const timer = setInterval(() => { const now = performance.now(); maxDelayMs = Math.max(maxDelayMs, now - previousTick - 10); previousTick = now; maxRss = Math.max(maxRss, process.memoryUsage().rss); ticks++; if (now - lastMemorySample >= 5000) { lastMemorySample = now; sampleStorage(); } }, 10);
  const begun = performance.now(); let lastProgress = begun;
  async function start(create: boolean) {
    const code = createHash('sha256');
    for (const path of ['../../src/server/storage-client.ts', '../../src/server/storage-worker.ts', '../../src/server/workbench-store.ts', '../../src/server/body-store.ts', '../../src/server/migrations.ts', '../../src/server/workbench.ts', '../../src/harness/codex/bounded-worker.ts', '../../src/harness/codex/bounded-reader.ts', '../../src/harness/codex/index.ts', '../../src/harness/dsh/bounded-worker.ts', '../../src/harness/dsh/bounded-reader.ts', '../../src/harness/dsh/bounded-frame-cache.ts', '../../src/harness/dsh/bounded-cache.ts', '../../src/harness/dsh/bounded-history.ts', '../../src/harness/dsh/bounded-extract.ts', '../../src/harness/dsh/index.ts', '../../src/shared/workbench.ts', '../../src/shared/content.ts', './native-archive-fixture.ts', './native-archive-verify.ts']) code.update(await readFile(new URL(path, import.meta.url)));
    codeVersions.push({ phase, sha256: code.digest('hex') });
    storage = createStorageClient({ dataDirectory }); await storage.ready;
    const adapter: HarnessAdapter = options.harness === 'codex' ? createCodexAdapter({ socketPath, boundedHistory: { nativeRoot, cacheRoot }, managedExecution: true })
      : createDshAdapter({ launchFile: join(root, 'absent-launch'), boundedHistory: { nativeRoot, cacheRoot }, managedExecution: true });
    service = new Workbench(storage.store, [{ id: 'fixture', label: 'Synthetic archive', directory: cwd }], new Map<HarnessId, HarnessAdapter>([[options.harness, adapter]]));
    if (create) { await storage.store.createConversation({ id, harnessId: options.harness, workspaceId: 'fixture', cwd, configuration }); await storage.store.saveBinding(id, binding); }
  }
  async function stop() { sampleStorage(); await service?.close(); service = undefined; await storage?.close(); storage = undefined; }
  async function pump(kind: 'latest' | 'backfill') {
    phase = 'archive-' + kind;
    let batches = 0;
    do {
      checkAbort();
      // Drive the identical bounded operation used by the background timer; no
      // sleeps/backoff are included in this archive-integrity experiment.
      await (service as unknown as { archivePage(id: string, kind: string, force: boolean): Promise<void> }).archivePage(id, kind, true);
      batches++;
      lastBatch = batches;
      const jobs = await storage!.store.archiveJobs(id), job = jobs.find(row => row.kind === kind)!;
      if (job.error && !['DSH_HISTORY_INDEXING', 'codex_bounded_indexing'].includes(job.error)) throw new Error(`archive:${kind}:${job.error}`);
      if (job.complete || kind === 'latest' && !job.working && job.cursor === null && job.lastSuccessAt !== null && !job.error) { assert.equal(job.coverageError, null); return batches; }
      assert(batches < Math.ceil((options.count + options.gap) / 2) + 100, 'archive checkpoint made no progress');
      if (options.progress && performance.now() - lastProgress > 5000) { lastProgress = performance.now(); console.log(JSON.stringify({ harness: options.harness, phase: kind, batches, elapsedSeconds: Math.round((performance.now() - begun) / 1000) })); }
    } while (true);
  }
  async function verify(expectedCount: number) {
    phase = 'verify-' + expectedCount;
    const actual = new Map<string, { sha256: string; bytes: number }>(), order: string[] = []; let cursor: string | undefined, pages = 0, bodyChunks = 0;
    do {
      const page = await storage!.store.readHistory(id, cursor ? { beforeItemId: cursor } : undefined); pages++; order.unshift(...page.items.map(item => item.id));
      for (const item of page.items) {
        checkAbort();
        assert(!actual.has(item.id)); assert.equal(item.status, item.id === 'synthetic-image-failed' ? 'failed' : 'completed'); assert(!item.previewOnly); assert(!item.mediaPending);
        const hash = createHash('sha256'); let bytes = 0;
        if (item.bodies?.text) { let offset: number | null = 0; while (offset !== null) { const chunk = await storage!.store.readBody(id, item.id, 'text', item.bodies.text, offset); assert(chunk.data.byteLength <= 65536); bytes += chunk.data.byteLength; hash.update(chunk.data); offset = chunk.nextOffset; bodyChunks++; } }
        else { const value = Buffer.from(item.text); bytes = value.length; hash.update(value); }
        const record = { sha256: hash.digest('hex'), bytes }; assert.deepEqual(record, expected.get(item.id), `full body mismatch at ${item.id}`); actual.set(item.id, record);
      }
      cursor = page.olderBeforeItemId ?? undefined;
    } while (cursor);
    assert.equal(actual.size, expectedCount); assert.deepEqual(order, [...expected.keys()]);
    const fileItem = await storage!.store.getItem(id, fileItemId); assert(fileItem?.runId);
    const recordedFiles = await storage!.store.readTurnFiles(id, [fileItem.runId]);
    assert.deepEqual(recordedFiles[0]?.paths, ['native-output.txt']);
    if (options.harness === 'codex') {
      const image = await storage!.store.getItem(id, 'synthetic-image'); assert.equal(image?.images?.length, 1, 'native image must materialize into a product resource');
      const resource = await storage!.store.resources.get(id, image!.images![0]!.id); assert.equal(digest(resource.data), digest(Buffer.from(png, 'base64')));
    }
    const manifest = createHash('sha256'); for (const [id, body] of expected) { assert.deepEqual(actual.get(id), body); manifest.update(JSON.stringify([id, body.sha256, body.bytes]) + '\n'); }
    return { items: actual.size, pages, bodyChunks, manifestSha256: manifest.digest('hex') };
  }
  async function sourceHash() { const hash = createHash('sha256'); for await (const data of createReadStream(source)) hash.update(data as Buffer); return hash.digest('hex'); }
  try {
    await append(0, options.count); await appendShapes(); const firstSource = await sourceHash(); phase = 'start-initial'; await start(true);
    const backfillBatches = await pump('backfill'); const offline = await verify(options.count + shapeCount); await pump('latest');
    assert.equal(await sourceHash(), firstSource); phase = 'stop-initial'; await stop();
    phase = 'append-gap'; await append(options.count, options.gap); const secondSource = await sourceHash(); phase = 'start-gap'; await start(false);
    const gapBatches = await pump('latest'); const recovered = await verify(options.count + options.gap + shapeCount); assert.equal(await sourceHash(), secondSource);
    phase = 'stop-gap'; await stop(); phase = 'start-final'; await start(false); const restarted = await verify(options.count + options.gap + shapeCount);
    assert.deepEqual(restarted, recovered); assert.equal(methods.get('thread/resume') ?? 0, 0); assert.equal(methods.get('thread/items/list') ?? 0, 0);
    sampleStorage();
    return { status: 'PASS', harness: options.harness, sourceFormat: options.harness === 'codex' ? '0.166.0-alpha.5.1 paginated ordinal JSONL' : options.dshCompressed ? '0.2.1-rc.4 v4 checksummed Zstd; one initial message frame' : '0.2.1-rc.4 v4 JSONL', shapes: { fileEdits: 'PASS', generatedImage: options.harness === 'codex' ? 'PASS' : 'not_applicable_to_DSH_native_item_mapping', extraItems: shapeCount }, offline: { messages: options.count, ...offline, batches: backfillBatches }, gap: { appended: options.gap, ...recovered, batches: gapBatches }, restart: restarted, nativeSourcesUnchanged: true, methods: Object.fromEntries(methods), elapsedMs: performance.now() - begun, mainThreadTicks: ticks, maxEventLoopDelayMs: maxDelayMs, maxRssBytes: maxRss, storage: { maxHeapUsedBytes: maxStorageHeap, maxExternalBytes: maxStorageExternal, samples: storageSamples }, codeVersions };
  } catch (error) {
    failed = true;
    const diagnostic = { phase, lastBatch, storage: storage?.diagnostics(), storageSamples, jobs: await storage?.store.archiveJobs(id).catch(error => ({ error: String(error) })), methods: Object.fromEntries(methods), maxRssBytes: maxRss, mainThreadTicks: ticks, maxEventLoopDelayMs: maxDelayMs, codeVersions, ...(options.keepFailure ? { retainedFixture: root } : {}) };
    if (error instanceof Error) Object.assign(error, { diagnostic });
    if (options.progress) console.log(JSON.stringify({ diagnostic }));
    throw error;
  } finally {
    clearInterval(timer); await stop(); for (const socket of ws.clients) socket.terminate(); await new Promise<void>(done => ws.close(() => done())); await new Promise<void>(done => http.close(() => done()));
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    assert(root.startsWith(join(tmpdir(), 'zh-native-archive-'))); if (!failed || !options.keepFailure) await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const value = (name: string, fallback: string) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] ?? fallback; };
  const options = parameters.parse({ harness: value('--harness', 'codex'), count: Number(value('--count', '20000')), gap: Number(value('--gap', '2001')), progress: true, keepFailure: process.argv.includes('--keep-failure'), dshCompressed: process.argv.includes('--dsh-compressed') });
  const report = value('--report', '');
  try { const result = await verifyNativeArchive(options); if (report) await writeFile(resolve(report), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(result)); }
  catch (error) { const result = { status: 'FAIL', harness: options.harness, error: String(error), diagnostic: (error as { diagnostic?: unknown })?.diagnostic }; if (report) await writeFile(resolve(report), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(result)); process.exitCode = 1; }
}

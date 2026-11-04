import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, rename, symlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { constants, zstdCompressSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { BoundedDshReader } from '../src/harness/dsh/bounded-reader.ts';
import { BoundedJsonEnvelope } from '../src/harness/dsh/bounded-json.ts';
import { createDshAdapter } from '../src/harness/dsh/index.ts';
import { modelId } from '../src/harness/dsh/native.ts';

const binding = { sessionId: 'synthetic', cwd: '/synthetic' };
const header = JSON.stringify({ type: 'session', version: 4, id: binding.sessionId, cwd: binding.cwd, createdAt: 0, isSeeded: false, delegationDepth: 0 }) + '\n';
const event = (seq: number, text = 'synthetic') => JSON.stringify({ type: seq === 0 ? 'turn/start' : 'assistant/message', seq, time: seq, data: seq === 0 ? { turn: 1 } : { text } }) + '\n';
const compress = (value: string) => zstdCompressSync(value, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
async function fixture(t: TestContext, compressed = false, maxCacheBytes = 64 * 1024 ** 2) {
  const root = await mkdtemp(join(tmpdir(), 'zs-dsh-bounded-')), nativeRoot = join(root, 'native'), cacheRoot = join(root, 'cache');
  const directory = join(nativeRoot, '--synthetic--', binding.sessionId); await mkdir(directory, { recursive: true });
  const path = join(directory, compressed ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl');
  await writeFile(path, compressed ? compress(header) : header);
  let reader = new BoundedDshReader({ nativeRoot, cacheRoot, maxCacheBytes });
  t.after(async () => { await reader.close(); await rm(root, { recursive: true, force: true }); });
  return { path, directory, nativeRoot, cacheRoot, get reader() { return reader; }, append: (text: string) => appendFile(path, compressed ? compress(text) : text),
    async reopen() { await reader.close(); reader = new BoundedDshReader({ nativeRoot, cacheRoot, maxCacheBytes }); } };
}

for (const compressed of [false, true]) test(`DSH bounded ${compressed ? 'zstd' : 'plaintext'} reads exact raw pages, appends and resumes after worker restart`, async t => {
  const f = await fixture(t, compressed); await f.append(Array.from({ length: 12 }, (_, i) => event(i)).join(''));
  const scan = await f.reader.scan(binding); assert.equal(scan.complete, true); assert.equal(scan.throughSeq, 11);
  const first = await f.reader.page({ ...binding, sourceGeneration: scan.sourceGeneration, throughSeq: 11, maxRecords: 5, maxBytes: 2048 });
  assert.deepEqual(first.records.map(row => row.seq), [11, 10, 9, 8, 7]);
  assert(first.records.reduce((sum, row) => sum + (row.raw?.length ?? 0), 0) <= 2048);
  for (const row of first.records) {
    const chunk = await f.reader.readChunk({ ...binding, sourceGeneration: scan.sourceGeneration, seq: row.seq, offset: 0 });
    assert.equal(Buffer.from(chunk.bytes).toString(), event(row.seq).trimEnd());
    assert.equal(chunk.sha256, createHash('sha256').update(chunk.bytes).digest('hex'));
    assert.equal(row.turn, 1);
  }
  await f.append(event(12)); const append = await f.reader.scan(binding);
  assert.equal(append.sourceGeneration, scan.sourceGeneration); assert.equal(append.indexedRecords, 1);
  await f.reopen(); const reopened = await f.reader.scan(binding); assert.equal(reopened.sourceGeneration, scan.sourceGeneration); assert.equal(reopened.indexedRecords, 0);
  const older = await f.reader.page({ ...binding, sourceGeneration: scan.sourceGeneration, throughSeq: 11, beforeSeq: first.beforeSeq!, maxRecords: 10 });
  assert.deepEqual(older.records.map(row => row.seq), [6, 5, 4, 3, 2, 1, 0]); assert.equal(older.beforeSeq, null);
});

test('DSH giant UTF-8 event is indexed without sending or parsing its entire body on the main thread', async t => {
  const f = await fixture(t, true); const text = '中🌱'.repeat(2 * 1024 ** 2); const huge = event(1, text);
  await f.append(event(0) + huge);
  let ticks = 0; const timer = setInterval(() => ticks++, 2); t.after(() => clearInterval(timer));
  const scan = await f.reader.scan(binding); assert.equal(scan.complete, true); assert(ticks > 2);
  const page = await f.reader.page({ ...binding, sourceGeneration: scan.sourceGeneration, throughSeq: 1, maxBytes: 1024 });
  assert.equal(page.records[0]!.raw, undefined); assert.equal(page.records[0]!.bytes, Buffer.byteLength(huge) - 1);
  const hash = createHash('sha256'); let offset = 0;
  while (offset < page.records[0]!.bytes) {
    const chunk = await f.reader.readChunk({ ...binding, sourceGeneration: scan.sourceGeneration, seq: 1, offset, maxBytes: 256 * 1024 });
    assert(chunk.bytes.length <= 256 * 1024); hash.update(chunk.bytes); offset += chunk.bytes.length;
  }
  assert.equal(hash.digest('hex'), createHash('sha256').update(huge.trimEnd()).digest('hex'));
  assert.equal((await f.reader.cacheStatus()).frameReads!.frameDecodes, 1, 'warm giant raw chunks must also use the indexed frame blocks');
});

test('DSH migrated single-frame history serves warm random pages without repeated prefix decompression', async t => {
  const f = await fixture(t, true); const rows = Array.from({ length: 20001 }, (_, n) => event(n, `row-${n}-` + 'x'.repeat(80)));
  await f.append(rows.join('')); const scan = await f.reader.scan(binding); assert(scan.complete);
  const indexed = (await f.reader.cacheStatus()).frameReads!; assert.equal(indexed.frameDecodes, 1);
  await f.reopen();
  for (const beforeSeq of [20001, 17000, 11000, 5000, 1000, 400]) {
    const page = await f.reader.page({ ...binding, sourceGeneration: scan.sourceGeneration, throughSeq: scan.throughSeq, beforeSeq, maxRecords: 50, maxBytes: 64 * 1024 });
    assert.equal(page.records.length, 50);
    for (const row of page.records) assert.equal(Buffer.from(row.raw!).toString(), rows[row.seq]!.trimEnd());
  }
  const warmed = (await f.reader.cacheStatus()).frameReads!;
  assert.equal(warmed.decodedFrameBytes, 0); assert.equal(warmed.frameDecodes, 0); assert(warmed.blockHits >= 300); assert(warmed.memoryBytes <= 1024 ** 2);
});

test('DSH decoded frame blocks are globally disposable and a cold old window is rebuilt once for many rows', async t => {
  const budget = 4 * 1024 ** 2, f = await fixture(t, true, budget);
  const rows = Array.from({ length: 2001 }, (_, n) => event(n, `${n}:` + 'x'.repeat(6000))); const raw = rows.join(''); assert(Buffer.byteLength(raw) > budget * 2);
  await f.append(raw); const scan = await f.reader.scan(binding); assert(scan.complete); await f.reopen();
  let beforeSeq = 129;
  for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
    const page = await f.reader.page({ ...binding, sourceGeneration: scan.sourceGeneration, throughSeq: scan.throughSeq, beforeSeq, maxRecords: 8, maxBytes: 64 * 1024 });
    for (const row of page.records) assert.equal(Buffer.from(row.raw!).toString(), rows[row.seq]!.trimEnd());
    beforeSeq = page.beforeSeq!;
  }
  const status = await f.reader.cacheStatus(); assert(status.bytes <= budget); assert.equal(status.frameReads!.frameDecodes, 1); assert.equal(status.frameReads!.blockMisses, 1);
  assert.equal(status.frameReads!.decodedFrameBytes, Buffer.byteLength(raw)); assert(status.frameReads!.blockHits >= 63);
  // The native artifact is retained. Cache corruption causes reconstruction,
  // while a same-size native rewrite is rejected before returning cached data.
  await f.reopen();
  const firstBlock = (await readdir(f.cacheRoot)).find(name => name.endsWith('-segment-0.body')); assert(firstBlock);
  await writeFile(join(f.cacheRoot, firstBlock), 'damaged-cache');
  const repaired = await f.reader.page({ ...binding, sourceGeneration: scan.sourceGeneration, throughSeq: scan.throughSeq, beforeSeq: 2, maxRecords: 1 });
  assert.equal(Buffer.from(repaired.records[0]!.raw!).toString(), rows[1]!.trimEnd()); assert.equal((await f.reader.cacheStatus()).frameReads!.frameDecodes, 1);
  const original = await readFile(f.path); await writeFile(f.path, original); await assert.rejects(f.reader.page({ ...binding, sourceGeneration: scan.sourceGeneration, throughSeq: scan.throughSeq, beforeSeq: 129, maxRecords: 1 }), /source_changed/);
});

test('DSH plaintext torn tail is not published and is consumed exactly once after completion', async t => {
  const f = await fixture(t); const row = event(1, '🌱'); const split = Buffer.from(row); await f.append(event(0));
  await appendFile(f.path, split.subarray(0, split.length - 3)); const first = await f.reader.scan(binding);
  assert.equal(first.throughSeq, 0); assert.equal(first.complete, false);
  await appendFile(f.path, split.subarray(split.length - 3)); const second = await f.reader.scan(binding);
  assert.equal(second.sourceGeneration, first.sourceGeneration); assert.equal(second.throughSeq, 1); assert.equal(second.indexedRecords, 1);
});

test('DSH turn index locates an old terminal beyond the Host hot-cache window and survives restart', async t => {
  const f = await fixture(t); const rows: string[] = [];
  for (let turn = 1; turn <= 1000; turn++) {
    rows.push(JSON.stringify({ seq: rows.length, time: turn, type: 'turn/start', data: { turn } }));
    rows.push(JSON.stringify({ seq: rows.length, time: turn, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }));
  }
  await f.append(rows.join('\n') + '\n'); const scan = await f.reader.scan(binding);
  const args = { ...binding, sourceGeneration: scan.sourceGeneration, throughSeq: scan.throughSeq, turn: 1 };
  assert.deepEqual(await f.reader.terminal(args), { seq: 1 });
  assert.equal(await f.reader.terminal({ ...args, throughSeq: 0 }), null);
  assert.equal(await f.reader.terminal({ ...args, turn: 1001 }), null);
  await f.reopen(); assert.deepEqual(await f.reader.terminal(args), { seq: 1 });
});

test('DSH extracts full decoded text and structured tool input as immutable bounded body chunks', async t => {
  const f = await fixture(t, true);
  const full = ('中🌱"\\\n').repeat(200_000);
  const message = { type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 2, message: { content: [{ text: 'ignored', type: 'reasoning' }, { text: full, type: 'text' }, { type: 'text', text: 'tail🌱' }] } } };
  const input = { '参数🌱': full, list: [1, null, { nested: 'x' }] };
  const tool = { type: 'tool/call', seq: 2, time: 2, data: { callId: 'tool-1', name: 'write', input } };
  await f.append(event(0) + JSON.stringify(message).replaceAll('🌱', '\\ud83c\\udf31') + '\n' + JSON.stringify(tool) + '\n');
  const scan = await f.reader.scan(binding);
  const text = await f.reader.project({ ...binding, sourceGeneration: scan.sourceGeneration, seq: 1 });
  assert.equal(text.metadata['/data/step'], 2); assert.equal(text.fields.text?.bytes, Buffer.byteLength(full + 'tail🌱'));
  assert(Buffer.byteLength(text.fields.text!.preview) <= 8192); assert(!text.fields.text!.preview.includes('ignored'));
  const structure = await f.reader.project({ ...binding, sourceGeneration: scan.sourceGeneration, seq: 2 });
  assert.equal(structure.metadata['/data/callId'], 'tool-1');
  for (const [seq, field, expected] of [[1, 'text', full + 'tail🌱'], [2, 'input', JSON.stringify(input)]] as const) {
    let offset = 0; const hash = createHash('sha256');
    const descriptor = (seq === 1 ? text : structure).fields[field]!;
    while (offset < descriptor.bytes) { const chunk = await f.reader.readBody({ ...binding, sourceGeneration: scan.sourceGeneration, seq, field, offset, maxBytes: 64 * 1024 }); assert(chunk.bytes.length <= 64 * 1024); hash.update(chunk.bytes); offset += chunk.bytes.length; }
    assert.equal(hash.digest('hex'), createHash('sha256').update(expected).digest('hex'));
    assert.equal(descriptor.version, createHash('sha256').update(expected).digest('hex'));
  }
});

test('DSH adapter reads bounded history offline and exposes giant bodies only through binding-scoped chunk tokens', async t => {
  const f = await fixture(t, true); const full = '中🌱'.repeat(200_000);
  const rows = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1, data: { source: { rpcId: 'operation-1' }, content: [{ type: 'text', text: 'prompt' }] } },
    { type: 'tool/call', seq: 2, time: 2, data: { callId: 'call-1', name: 'write', input: { text: full } } },
    { type: 'tool/result', seq: 3, time: 3, data: { message: { toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: full }] }, meta: { path: '/synthetic/output.txt', operation: 'create' } } },
    { type: 'assistant/message', seq: 4, time: 4, data: { turn: 1, step: 1, message: { content: [{ text: full, type: 'text' }] } } },
    { type: 'turn/end', seq: 5, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  await f.append(rows.map(value => JSON.stringify(value) + '\n').join(''));
  const adapter = createDshAdapter({ launchFile: join(f.nativeRoot, 'absent-launch-file'), boundedHistory: { nativeRoot: f.nativeRoot, cacheRoot: f.cacheRoot } }); t.after(() => adapter.close());
  const bound = { id: binding.sessionId, cwd: binding.cwd, configuration: { modelId: modelId({ provider: 'synthetic', model: 'synthetic' }), permissionId: 'read-only' }, details: {} };
  const latest = await adapter.history(bound, undefined, 2); assert(latest.olderCursor);
  const assistant = latest.items.find(item => item.kind === 'assistant')!; const tool = latest.items.find(item => item.kind === 'tool')!;
  assert(assistant.bodySources?.text); assert(tool.bodySources?.input); assert(tool.bodySources?.output); assert.deepEqual(tool.fileEdits, ['output.txt']);
  assert(Buffer.byteLength(assistant.text) <= 8192); assert.equal(assistant.bodies, undefined);
  assert.equal(assistant.bodySources.text.bytes, Buffer.byteLength(full));
  const hash = createHash('sha256'); let offset = 0;
  while (offset < assistant.bodySources.text.bytes) { const chunk = await adapter.readBodyChunk!(bound, assistant.bodySources.text.token, offset, 64 * 1024); hash.update(chunk.data); offset += chunk.data.length; }
  assert.equal(hash.digest('hex'), createHash('sha256').update(full).digest('hex'));
  await assert.rejects(adapter.readBodyChunk!({ ...bound, id: 'foreign' }, assistant.bodySources.text.token, 0, 64 * 1024), /IDENTITY_MISMATCH/);
  const older = await adapter.history(bound, latest.olderCursor!, 4); assert.deepEqual(older.items.map(item => item.text), ['prompt']); assert.equal(older.olderCursor, null);
  await assert.rejects(adapter.history({ ...bound, id: 'foreign' }, latest.olderCursor!, 4), /history_cursor_invalid/);
});

test('DSH tool anchors stay at call position across 1000 later messages and exact reads update the old item without moving it', async t => {
  const f = await fixture(t); const rows: Record<string, unknown>[] = [{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'distant-call', name: 'write', input: { text: 'new file' } } }];
  for (let i = 0; i < 1000; i++) rows.push({ type: 'assistant/message', seq: rows.length, time: i + 2, data: { turn: 1, step: i, message: { content: [{ type: 'text', text: `message-${i}` }] } } });
  await f.append(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const adapter = createDshAdapter({ launchFile: join(f.nativeRoot, 'absent-launch-file'), boundedHistory: { nativeRoot: f.nativeRoot, cacheRoot: f.cacheRoot } }); t.after(() => adapter.close());
  const bound = { id: binding.sessionId, cwd: binding.cwd, configuration: { modelId: modelId({ provider: 'synthetic', model: 'synthetic' }), permissionId: 'read-only' }, details: {} }, toolId = `dsh:${binding.sessionId}:tool:distant-call`;
  const oldHead = await adapter.history(bound, undefined, 16); assert(oldHead.olderCursor);
  const oldPayload = JSON.parse(Buffer.from(oldHead.olderCursor.slice(4), 'base64url').toString());
  const oldToolCursor = 'bd2.' + Buffer.from(JSON.stringify({ ...oldPayload, before: 2 })).toString('base64url');
  const pending = (await adapter.readItems!(bound, [toolId]))[0]!; assert.equal(pending.status, 'running'); assert.equal(pending.sourceRevision?.sequence, 1);
  const resultSeq = rows.length;
  await f.append(JSON.stringify({ type: 'tool/result', seq: resultSeq, time: resultSeq, data: { message: { toolCallId: 'distant-call', isError: false, content: [{ type: 'text', text: 'written' }] }, meta: { path: '/synthetic/result.txt', operation: 'create' } } }) + '\n');
  const current = (await adapter.readItems!(bound, [toolId]))[0]!;
  assert.equal(current.status, 'completed'); assert.equal(current.tool?.name, 'write'); assert.equal(current.tool?.input, '{"text":"new file"}'); assert.deepEqual(current.fileEdits, ['result.txt']);
  assert.equal(current.sourceRevision?.sequence, resultSeq); assert.equal(current.sourceRevision?.generation, pending.sourceRevision?.generation);
  assert.equal((await adapter.history(bound, oldToolCursor, 1)).items[0]!.status, 'running', 'an old cut must not see a later result');
  const latest = await adapter.history(bound, undefined, 16); assert.deepEqual(latest.items.map(item => item.id), oldHead.items.map(item => item.id));
  const all = [...latest.items]; let cursor = latest.olderCursor;
  while (cursor) { const page = await adapter.history(bound, cursor, 100); all.unshift(...page.items); cursor = page.olderCursor; }
  assert.equal(all.length, 1001); assert.equal(new Set(all.map(item => item.id)).size, 1001); assert.equal(all[0]!.id, toolId); assert.equal(all[0]!.status, 'completed');
  await assert.rejects(adapter.readItems!({ ...bound, id: 'another' }, [toolId]), /IDENTITY_MISMATCH/);
});

test('DSH history returns a smaller complete item page when active body leases fill its cache', async t => {
  const f = await fixture(t, false, 1024 ** 2), text = randomBytes(155 * 1024).toString('base64');
  await f.append(event(0) + [1, 2, 3].map(seq => JSON.stringify({ type: 'assistant/message', seq, time: seq, data: { turn: 1, step: seq, message: { content: [{ type: 'text', text }] } } })).join('\n') + '\n');
  const adapter = createDshAdapter({ launchFile: join(f.nativeRoot, 'absent'), boundedHistory: { nativeRoot: f.nativeRoot, cacheRoot: f.cacheRoot, maxCacheBytes: 1024 ** 2 } }); t.after(() => adapter.close());
  const bound = { id: binding.sessionId, cwd: binding.cwd, configuration: { modelId: modelId({ provider: 'synthetic', model: 'synthetic' }), permissionId: 'read-only' }, details: {} };
  let cursor: string | undefined; const seen: string[] = [];
  for (let i = 0; i < 5; i++) {
    const page = await adapter.history(bound, cursor, 16); assert(page.items.length > 0 && page.items.length < 3);
    for (const item of page.items) { seen.push(item.id); await adapter.releaseBodySource!(bound, item.bodySources!.text!.token); }
    if (!page.olderCursor) break; cursor = page.olderCursor;
  }
  assert.equal(seen.length, 3); assert.equal(new Set(seen).size, 3); assert.equal((await f.reader.cacheStatus()).activeLeases, 0);
});

test('DSH incomplete zstd frame and checksum corruption do not publish phantom records', async t => {
  const f = await fixture(t, true); await f.append(event(0)); const tail = compress(event(1));
  await appendFile(f.path, tail.subarray(0, tail.length - 3)); const first = await f.reader.scan(binding); assert.equal(first.throughSeq, 0); assert.equal(first.complete, false);
  await appendFile(f.path, tail.subarray(tail.length - 3)); const complete = await f.reader.scan(binding); assert.equal(complete.throughSeq, 1);
  const corrupt = compress(event(2)); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1; await appendFile(f.path, corrupt);
  await assert.rejects(f.reader.scan(binding));
  const page = await f.reader.page({ ...binding, sourceGeneration: complete.sourceGeneration, throughSeq: 1 }); assert.deepEqual(page.records.map(row => row.seq), [1, 0]);
});

test('DSH source replacement invalidates old raw cursors while a leased old body stays stable until release', async t => {
  const f = await fixture(t); const oldRow = JSON.stringify({ seq: 1, time: 1, type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'old' }] } } }) + '\n';
  await f.append(event(0) + oldRow); const before = await f.reader.scan(binding);
  const oldBody = await f.reader.project({ ...binding, sourceGeneration: before.sourceGeneration, seq: 1 });
  await rename(f.path, `${f.path}.old`); await writeFile(f.path, header + event(0) + event(1, 'new'));
  const after = await f.reader.scan(binding); assert.notEqual(after.sourceGeneration, before.sourceGeneration);
  await assert.rejects(f.reader.readChunk({ ...binding, sourceGeneration: before.sourceGeneration, seq: 1, offset: 0 }), /generation_changed/);
  const old = await f.reader.readBody({ ...binding, sourceGeneration: before.sourceGeneration, seq: 1, field: 'text', offset: 0, lease: oldBody.fields.text!.lease }); assert.equal(Buffer.from(old.bytes).toString(), 'old');
  await f.reader.release(oldBody.fields.text!.lease!);
  await assert.rejects(f.reader.readBody({ ...binding, sourceGeneration: before.sourceGeneration, seq: 1, field: 'text', offset: 0, lease: oldBody.fields.text!.lease }), /lease_expired/);
  const fresh = await f.reader.readChunk({ ...binding, sourceGeneration: after.sourceGeneration, seq: 1, offset: 0 }); assert.equal(Buffer.from(fresh.bytes).toString(), event(1, 'new').trimEnd());
});

test('DSH global cache rotates many bindings above budget and reconstructs old indexes and bodies from native sources', async t => {
  const budget = 1024 ** 2, f = await fixture(t, true, budget), text = randomBytes(96 * 1024).toString('base64');
  let first: { sourceGeneration: string; throughSeq: number } | undefined; let firstHash = ''; let totalSourceBytes = 0;
  for (let index = 0; index < 48; index++) {
    const source = { sessionId: index === 0 ? binding.sessionId : `synthetic-${index}`, cwd: binding.cwd };
    const directory = join(f.nativeRoot, '--synthetic--', source.sessionId); await mkdir(directory, { recursive: true });
    const head = header.replace('"id":"synthetic"', `"id":"${source.sessionId}"`);
    const content = event(0) + JSON.stringify({ seq: 1, time: 1, type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: text + index }] } } }) + '\n';
    const physical = Buffer.concat([compress(head), compress(content)]); await writeFile(join(directory, 'session.v4.jsonl.zstd'), physical); totalSourceBytes += physical.length;
    const scan = await f.reader.scan(source); if (index === 0) first = scan;
    const body = await f.reader.project({ ...source, sourceGeneration: scan.sourceGeneration, seq: 1 }); if (index === 0) firstHash = body.fields.text!.version;
    const chunk = await f.reader.readBody({ ...source, sourceGeneration: scan.sourceGeneration, seq: 1, field: 'text', lease: body.fields.text!.lease, offset: 0, maxBytes: 1024 }); assert.equal(Buffer.from(chunk.bytes).toString(), (text + index).slice(0, 1024));
    await f.reader.release(body.fields.text!.lease!);
    const status = await f.reader.cacheStatus(); assert(status.bytes <= budget);
  }
  assert(totalSourceBytes > budget * 4);
  const names = await readdir(f.cacheRoot); assert(!names.some(name => name.endsWith('.raw')));
  const key = createHash('sha256').update(JSON.stringify(binding)).digest('hex'); assert(!names.includes(`v2-${key}.sqlite`), 'old unleased index should have been evicted');
  await f.reopen();
  const oldPage = await f.reader.page({ ...binding, sourceGeneration: first!.sourceGeneration, throughSeq: first!.throughSeq, maxBytes: 1024 }); assert.equal(oldPage.records[0]!.seq, 1);
  const oldBody = await f.reader.project({ ...binding, sourceGeneration: first!.sourceGeneration, seq: 1 }); assert.equal(oldBody.fields.text!.version, firstHash);
  const hash = createHash('sha256'); let offset = 0;
  while (offset < oldBody.fields.text!.bytes) { const chunk = await f.reader.readBody({ ...binding, sourceGeneration: first!.sourceGeneration, seq: 1, field: 'text', lease: oldBody.fields.text!.lease, offset, maxBytes: 64 * 1024 }); hash.update(chunk.bytes); offset += chunk.bytes.length; }
  assert.equal(hash.digest('hex'), firstHash); await f.reader.release(oldBody.fields.text!.lease!);
  const bytes = (await Promise.all((await readdir(f.cacheRoot)).map(name => stat(join(f.cacheRoot, name))))).reduce((sum, value) => sum + value.size, 0); assert(bytes <= budget);
});

test('DSH cache pauses under active body leases and resumes after release without deleting archives or native files', async t => {
  const f = await fixture(t, false, 1024 ** 2), text = randomBytes(155 * 1024).toString('base64');
  const rows = [event(0)];
  for (let seq = 1; seq <= 3; seq++) rows.push(JSON.stringify({ type: 'assistant/message', seq, time: seq, data: { turn: 1, step: seq, message: { content: [{ type: 'text', text }] } } }) + '\n');
  await f.append(rows.join('')); const scan = await f.reader.scan(binding);
  const first = await f.reader.project({ ...binding, sourceGeneration: scan.sourceGeneration, seq: 1 });
  const second = await f.reader.project({ ...binding, sourceGeneration: scan.sourceGeneration, seq: 2 });
  await assert.rejects(f.reader.project({ ...binding, sourceGeneration: scan.sourceGeneration, seq: 3 }), /cache_paused/);
  assert.equal(f.reader.status.phase, 'paused');
  await f.reader.release(first.fields.text!.lease!);
  const third = await f.reader.project({ ...binding, sourceGeneration: scan.sourceGeneration, seq: 3 }); assert.equal(f.reader.status.phase, 'ready');
  const retained = await f.reader.readBody({ ...binding, sourceGeneration: scan.sourceGeneration, seq: 2, field: 'text', lease: second.fields.text!.lease, offset: 0, maxBytes: 1024 }); assert.equal(Buffer.from(retained.bytes).toString(), text.slice(0, 1024));
  await f.reader.release(second.fields.text!.lease!); await f.reader.release(third.fields.text!.lease!);
  assert.equal((await f.reader.cacheStatus()).activeLeases, 0); assert(!(await readdir(f.cacheRoot)).some(name => name.endsWith('.body')));
  assert.equal(await readFile(f.path, 'utf8'), header + rows.join(''));
});

test('DSH importer rejects wrong binding identity, sequence gaps, unsupported generations and symlinks', async t => {
  const f = await fixture(t); await writeFile(f.path, header.replace('"id":"synthetic"', '"id":"foreign"')); await assert.rejects(f.reader.scan(binding), /identity_mismatch/);
  await writeFile(f.path, header + event(2)); await assert.rejects(f.reader.scan(binding), /sequence_gap/);
  await writeFile(join(f.directory, 'session.v5.jsonl'), header); await assert.rejects(f.reader.scan(binding), /unsupported_generation/);
  await rm(join(f.directory, 'session.v5.jsonl')); await rename(f.path, `${f.path}.target`); await symlink(`${f.path}.target`, f.path); await assert.rejects(f.reader.scan(binding));
  assert.equal((await readFile(`${f.path}.target`, 'utf8')), header + event(2));
});

test('Streaming envelope parser rejects malformed body JSON and nesting over budget', () => {
  for (const data of ['{"type":"x","seq":0,"time":1,"data":[1,]}', '{"type":"x","seq":0,"time":1,"data":"bad\\q"}', '{"type":"x","seq":0,"time":1,"data":' + '['.repeat(129) + '0' + ']'.repeat(129) + '}']) {
    const parser = new BoundedJsonEnvelope(); assert.throws(() => { for (const char of data) parser.write(char); parser.finish(); });
  }
});

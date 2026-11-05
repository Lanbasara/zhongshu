import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { constants, zstdCompressSync } from 'node:zlib';
import { BoundedDshReader } from '../src/harness/dsh/bounded-reader.ts';
import { BoundedJsonEnvelope } from '../src/harness/dsh/bounded-json.ts';
import { boundedHistory } from '../src/harness/dsh/bounded-history.ts';
import { historyItems, textContent } from '../src/harness/dsh/native.ts';
import type { Event } from '../src/harness/dsh/native.ts';
import type { NativeBodySource } from '../src/harness/types.ts';

const binding = { id: 'projection', cwd: '/synthetic', configuration: { modelId: 'synthetic', permissionId: 'read-only' }, details: {} };
const compress = (text: string) => zstdCompressSync(text, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const row = (seq: number, type: string, data: Record<string, unknown>): Event => ({ seq, time: seq, type, data });
const assistant = (seq: number, step: number, content: unknown[]): Event => row(seq, 'assistant/message', { turn: 1, step, message: { role: 'assistant', content } });
const id = (key: string) => `dsh:${binding.id}:${key}`;

test('DSH streaming assistant presence follows native text semantics across JSON shapes and chunk boundaries', () => {
  const cases: unknown[] = [
    [], [{ type: 'text', text: '' }, { text: '', type: 'text' }],
    [{ type: 'tool-call', text: 'not assistant text' }],
    [{ type: 'text', text: null }], [{ type: 'text', text: { value: 'not a string' } }],
    [{ type: 'text', text: '\u0000' }], [{ text: '\n🌱', type: 'text' }],
    [{ text: '', type: 'text' }, { type: 'text', text: 'visible' }],
    { 0: { type: 'text', text: 'content must be an array' } },
  ];
  for (const content of cases) {
    const parser = new BoundedJsonEnvelope(), json = JSON.stringify(assistant(1, 1, content as unknown[]));
    for (const char of json) parser.write(char);
    parser.finish(); assert.equal(parser.hasMessageText, textContent(content).length > 0);
    assert(!Object.keys(parser.fields).some(key => key.includes('/content/')), 'body blocks must not accumulate in metadata');
  }
});

async function fixture(t: TestContext, compressed: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'zs-dsh-projection-'));
  const nativeRoot = join(root, 'native'), cacheRoot = join(root, 'cache'), directory = join(nativeRoot, '--synthetic--', binding.id);
  await mkdir(directory, { recursive: true });
  const path = join(directory, compressed ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl');
  const header = JSON.stringify({ type: 'session', version: 4, id: binding.id, cwd: binding.cwd, createdAt: 0, isSeeded: false, delegationDepth: 0 }) + '\n';
  await writeFile(path, compressed ? compress(header) : header);
  let reader = new BoundedDshReader({ nativeRoot, cacheRoot }), history = boundedHistory(reader);
  t.after(async () => { await reader.close(); await rm(root, { recursive: true, force: true }); });
  return {
    path, cacheRoot, get history() { return history; },
    async append(events: Event[]) { const text = events.map(event => JSON.stringify(event) + '\n').join(''); await appendFile(path, compressed ? compress(text) : text); },
    async reopen(mutate?: () => Promise<void>) { await reader.close(); await mutate?.(); reader = new BoundedDshReader({ nativeRoot, cacheRoot }); history = boundedHistory(reader); },
    async body(source: NativeBodySource) {
      const sha = createHash('sha256'); let offset = 0;
      for (;;) { const part = await history.readBodyChunk(binding, source.token, offset, 64 * 1024); sha.update(part.data); if (part.nextOffset === null) return sha.digest('hex'); offset = part.nextOffset; }
    },
  };
}

for (const compressed of [false, true]) test(`DSH ${compressed ? 'zstd' : 'JSONL'} CDC excludes nonprojecting assistants and preserves valid revisions`, async t => {
  const f = await fixture(t, compressed);
  const toolOnly = [{ type: 'tool-call', id: 'call', name: 'bash', arguments: '{}' }];
  const initial = [
    row(0, 'turn/start', { turn: 1 }),
    row(1, 'user/message', { turn: 1, source: { rpcId: 'operation' }, content: [{ type: 'text', text: 'run synthetic tool' }] }),
    assistant(2, 1, toolOnly),
    row(3, 'tool/call', { turn: 1, callId: 'call', name: 'bash', arguments: '{}' }),
    row(4, 'tool/result', { turn: 1, message: { toolCallId: 'call', isError: false, content: [{ type: 'text', text: 'synthetic result' }] } }),
    assistant(5, 2, [{ text: 'normal assistant', type: 'text' }]),
    row(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  await f.append(initial);
  const expected = historyItems(binding.id, initial).map(item => item.id);
  const first = await f.history.historyChanges(binding);
  assert.deepEqual(first.itemIds, expected, 'CDC must not announce a tool-call-only assistant absent from native history');
  assert(!first.hasMore);
  assert.deepEqual((await f.history.history(binding)).items.map(item => item.id), expected);
  assert.deepEqual((await f.history.readItems(binding, first.itemIds)).map(item => item.id), expected);
  const oldHead = await f.history.history(binding, undefined, 1); assert(oldHead.olderCursor);

  // Native textContent concatenates directly: several empty blocks remain empty.
  const empty = [{ type: 'text', text: '' }, { text: '', type: 'text' }];
  assert.equal(textContent(empty), '');
  await f.append([assistant(7, 2, empty), assistant(8, 2, toolOnly)]);
  const ignored = await f.history.historyChanges(binding, first.cursor);
  assert.deepEqual(ignored.itemIds, []); assert(!ignored.hasMore); assert.notEqual(ignored.cursor, first.cursor);
  const retained = (await f.history.readItems(binding, [id('assistant:1:2')]))[0]!;
  assert.equal(retained.text, 'normal assistant'); assert.equal(retained.sourceRevision?.sequence, 5);

  await f.append([assistant(9, 1, [{ text: 'later visible revision', type: 'text' }])]);
  const revised = await f.history.historyChanges(binding, ignored.cursor);
  assert.deepEqual(revised.itemIds, [id('assistant:1:1')]);
  assert.deepEqual((await f.history.history(binding)).items.map(item => item.id), [...expected, id('assistant:1:1')]);
  const old = await f.history.history(binding, oldHead.olderCursor);
  assert.deepEqual(old.items.map(item => item.id), expected.slice(0, -1), 'old cut must exclude later visible revisions');

  const giant = '中🌱'.repeat(170_000);
  await f.append([assistant(10, 2, [{ text: '', type: 'text' }, { text: giant, type: 'text' }, { type: 'text', text: '\nEND' }])]);
  const changed = await f.history.historyChanges(binding, revised.cursor);
  assert.deepEqual(changed.itemIds, [id('assistant:1:2')]);
  const large = (await f.history.readItems(binding, changed.itemIds))[0]!;
  assert.equal(large.sourceRevision?.sequence, 10); assert(Buffer.byteLength(large.text) <= 8192);
  assert(large.bodySources?.text); assert.equal(await f.body(large.bodySources.text), hash(giant + '\nEND'));
  await f.history.releaseBodySource(binding, large.bodySources.text.token);
  await f.reopen();
  assert.deepEqual((await f.history.historyChanges(binding, changed.cursor)).itemIds, []);
});

for (const compressed of [false, true]) test(`DSH ${compressed ? 'zstd' : 'JSONL'} cache upgrade rebuilds stale projection entries and retains leased bodies`, async t => {
  const f = await fixture(t, compressed), giant = 'body中🌱'.repeat(1000);
  await f.append([row(0, 'turn/start', { turn: 1 }), assistant(1, 1, [{ type: 'tool-call', id: 'call' }]), assistant(2, 2, [{ type: 'text', text: giant }]), assistant(3, 2, [{ type: 'text', text: '' }])]);
  const scan = await f.history.historyChanges(binding);
  // Recreate v4's false assistant anchor and its latest, nonprojecting revision.
  const generation = JSON.parse(Buffer.from(scan.cursor.slice(4), 'base64url').toString()).generation as string;
  await f.reopen(async () => {
    const name = (await readdir(f.cacheRoot)).find(name => /^v2-.*\.sqlite$/.test(name)); assert(name);
    const db = new DatabaseSync(join(f.cacheRoot, name));
    try {
      db.prepare('INSERT OR REPLACE INTO items VALUES(?,?,?,?,?)').run(generation, 'assistant:1:1', 1, 1, 1);
      db.prepare('INSERT OR REPLACE INTO item_events VALUES(?,?,?,?)').run(generation, 'assistant:1:1', 'assistant/message', 1);
      db.prepare('UPDATE items SET latest_seq=3 WHERE generation=? AND key=?').run(generation, 'assistant:1:2');
      db.prepare('INSERT OR REPLACE INTO item_events VALUES(?,?,?,?)').run(generation, 'assistant:1:2', 'assistant/message', 3);
      db.exec('PRAGMA user_version=4');
    } finally { db.close(); }
  });
  const nativeSHA = hash(await readFile(f.path));
  const rebuilt = await f.history.historyChanges(binding);
  assert.deepEqual(rebuilt.itemIds, [id('assistant:1:2')]);
  const items = await f.history.readItems(binding, rebuilt.itemIds);
  assert.equal(items[0]?.sourceRevision?.sequence, 2); assert(items[0]?.bodySources?.text);
  assert.equal(items[0].sourceRevision?.generation, generation, 'index schema migration must retain the native source generation');
  const source = items[0].bodySources.text;
  assert.equal(await f.body(source), hash(giant));
  await f.reopen(async () => {
    const name = (await readdir(f.cacheRoot)).find(name => /^v2-.*\.sqlite$/.test(name)); assert(name);
    const db = new DatabaseSync(join(f.cacheRoot, name)); try { db.exec('PRAGMA user_version=4'); } finally { db.close(); }
  });
  assert.deepEqual((await f.history.historyChanges(binding, scan.cursor)).itemIds, []);
  assert.equal(await f.body(source), hash(giant), 'cache migration must not delete a still-leased body');
  await f.history.releaseBodySource(binding, source.token);
  assert.equal(hash(await readFile(f.path)), nativeSHA);
});

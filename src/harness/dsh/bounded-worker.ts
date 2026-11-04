import { parentPort, workerData } from 'node:worker_threads';
import { constants } from 'node:fs';
import { Readable } from 'node:stream';
import { open, mkdir, lstat, realpath, opendir, chmod, stat as pathStat, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, relative, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createZstdDecompress, constants as zstdConstants } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { boundedBinding, boundedOptions, boundedPageArgs, boundedChunkArgs, boundedProjectArgs, boundedBodyArgs, boundedTerminalArgs, boundedItemsArgs, boundedChangesArgs } from './bounded-reader.ts';
import type { BoundedRecord, BoundedItemGroup } from './bounded-reader.ts';
import { BoundedJsonEnvelope } from './bounded-json.ts';
import { extractRecord } from './bounded-extract.ts';
import type { ExtractedRecord } from './bounded-extract.ts';
import { BoundedCache } from './bounded-cache.ts';
import { FrameBlockCache } from './bounded-frame-cache.ts';

const options = boundedOptions.parse(workerData);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
type Generation = { id: string; identity: string; header: string; source_offset: number; source_bytes: number; modified: string; raw_bytes: number; through_seq: number; turn: number | null };
type Row = { seq: number; type: string; time: number; turn: number | null; frame: number; frame_end: number; offset: number; bytes: number; sha256: string };
let quota: BoundedCache;
const frameBlocks = new FrameBlockCache(() => options.cacheRoot, () => quota, options.maxCacheBytes);
const observations = new Map<string, { bytes: number; modified: string }>();
function fail(code: string): never { throw new Error(`dsh_bounded_${code}`); }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function segment(raw: string): string {
  if (raw === '.') return '~002E'; if (raw === '..') return '~002E~002E';
  let value = ''; for (let i = 0; i < raw.length; i++) { const char = raw[i]!; value += /^[A-Za-z0-9._-]$/.test(char) ? char : `~${raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`; } return value;
}
function project(cwd: string): string {
  let value = '', separator = false;
  for (let i = 0; i < cwd.length; i++) {
    const char = cwd[i]!;
    if ('/\\:'.includes(char)) { if (!separator) value += '-'; separator = true; }
    else { value += /^[A-Za-z0-9._-]$/.test(char) ? char : `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`; separator = false; }
  }
  return `--${(value.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}
async function directory(path: string, create: boolean): Promise<string> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe_path');
  const canonical = await realpath(path);
  if (create && process.getuid && info.uid !== process.getuid()) fail('unsafe_path');
  if (create) await chmod(path, 0o700);
  return canonical;
}
async function file(path: string, write = false): Promise<FileHandle> {
  const handle = await open(path, constants.O_NOFOLLOW | (write ? constants.O_CREAT | constants.O_RDWR : constants.O_RDONLY), 0o600);
  const info = await handle.stat();
  if (!info.isFile() || (write && (info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())))) { await handle.close(); fail('unsafe_path'); }
  if (write) await handle.chmod(0o600);
  return handle;
}
async function source(binding: z.infer<typeof boundedBinding>) {
  options.nativeRoot = await directory(options.nativeRoot, false);
  const base = join(options.nativeRoot, project(binding.cwd), segment(binding.sessionId));
  await directory(join(options.nativeRoot, project(binding.cwd)), false); await directory(base, false);
  const entries: string[] = [];
  for await (const entry of await opendir(base, { bufferSize: 16 })) {
    if (entries.length >= 64) fail('unsupported_generation');
    entries.push(entry.name);
  }
  if (entries.some(name => { const match = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/.exec(name); return match && Number(match[1]) > 4; })) fail('unsupported_generation');
  const names = entries.filter(name => /^session\.v4\.jsonl(?:\.zstd)?$/.test(name));
  if (names.length !== 1) fail('source_missing_or_ambiguous');
  const path = join(base, names[0]!); const handle = await file(path);
  if (await realpath(path) !== path) { await handle.close(); fail('unsafe_path'); }
  return { handle, compressed: names[0]!.endsWith('.zstd') };
}
async function bytesAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length); let offset = 0;
  while (offset < length) { const read = await handle.read(bytes, offset, length - offset, position + offset); if (!read.bytesRead) fail('source_changed'); offset += read.bytesRead; }
  return bytes;
}
/** Seek over bounded Zstandard frame/block headers; never allocate compressed payloads. */
async function frameEnd(handle: FileHandle, start: number, size: number): Promise<number | undefined> {
  if (size - start < 5) return undefined;
  const first = await bytesAt(handle, start, 5);
  if (first.readUInt32LE(0) !== 0xfd2fb528) fail('invalid_frame');
  const descriptor = first[4]!;
  if ((descriptor & 24) || !(descriptor & 4)) fail('unsupported_frame');
  const single = !!(descriptor & 32), flag = descriptor >>> 6, dictionary = descriptor & 3;
  let offset = start + 5 + (single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (flag === 0 ? single ? 1 : 0 : 1 << flag);
  if (offset > size) return undefined;
  for (;;) {
    if (size - offset < 3) return undefined;
    const block = (await bytesAt(handle, offset, 3)).readUIntLE(0, 3); offset += 3;
    const type = (block >>> 1) & 3; if (type === 3) fail('invalid_frame');
    offset += type === 1 ? 1 : block >>> 3; if (offset > size) return undefined;
    if (block & 1) break;
  }
  return offset + 4 > size ? undefined : offset + 4;
}
async function* chunks(handle: FileHandle, start: number, end: number, compressed: boolean): AsyncGenerator<Buffer> {
  if (end <= start) return;
  async function* inputChunks() {
    for (let offset = start; offset < end; offset += 64 * 1024) yield await bytesAt(handle, offset, Math.min(64 * 1024, end - offset));
  }
  const input = Readable.from(inputChunks(), { objectMode: false, highWaterMark: 64 * 1024 });
  const decoder = compressed ? createZstdDecompress({ chunkSize: 64 * 1024, params: { [zstdConstants.ZSTD_d_windowLogMax]: 26 } }) : undefined;
  const stream = decoder ? input.pipe(decoder) : input;
  const onError = (error: Error) => decoder?.destroy(error); input.on('error', onError);
  try { for await (const chunk of stream) yield Buffer.from(chunk as Buffer); }
  finally { input.unpipe(); input.destroy(); decoder?.destroy(); input.off('error', onError); }
}
async function header(handle: FileHandle, size: number, compressed: boolean, binding: z.infer<typeof boundedBinding>) {
  const end = compressed ? await frameEnd(handle, 0, size) : Math.min(size, 64 * 1024);
  if (!end) fail('incomplete_header');
  const parts: Buffer[] = []; let length = 0, found = false;
  for await (const chunk of chunks(handle, 0, end, compressed)) {
    if (found) fail('invalid_header');
    const newline = chunk.indexOf(10); const part = newline < 0 ? chunk : chunk.subarray(0, newline + 1);
    parts.push(part); length += part.length; if (length > 64 * 1024) fail('metadata_too_large');
    if (newline >= 0) { found = true; if (compressed && newline !== chunk.length - 1) fail('invalid_header'); if (!compressed) break; }
  }
  if (!found) fail('incomplete_header');
  const raw = Buffer.concat(parts, length);
  const parsed = z.object({ type: z.literal('session'), version: z.literal(4), id: z.literal(binding.sessionId), cwd: z.literal(binding.cwd), createdAt: count, isSeeded: z.boolean(), delegationDepth: count }).passthrough().safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
  if (!parsed.success) fail('identity_mismatch');
  return { hash: digest(raw), offset: compressed ? end : length };
}
function generationId(identity: string, header: string): string {
  const hash = digest(identity + ':' + header);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
async function cache(binding: z.infer<typeof boundedBinding>) {
  const key = digest(JSON.stringify(binding)); quota.protect(key);
  const name = `v2-${key}`, path = join(options.cacheRoot, `${name}.sqlite`);
  const reserved = await file(path, true); await reserved.close();
  const db = new DatabaseSync(path);
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== 4) db.exec('DROP TABLE IF EXISTS records; DROP TABLE IF EXISTS generations; DROP TABLE IF EXISTS current; DROP TABLE IF EXISTS extractions; DROP TABLE IF EXISTS item_events; DROP TABLE IF EXISTS items;');
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL; PRAGMA auto_vacuum=FULL;
    CREATE TABLE IF NOT EXISTS generations(id TEXT PRIMARY KEY, identity TEXT NOT NULL, header TEXT NOT NULL, source_offset INTEGER NOT NULL, source_bytes INTEGER NOT NULL, modified TEXT NOT NULL, raw_bytes INTEGER NOT NULL, through_seq INTEGER NOT NULL, turn INTEGER) STRICT;
    CREATE TABLE IF NOT EXISTS current(id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS records(generation TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, time INTEGER NOT NULL, turn INTEGER, frame INTEGER NOT NULL, frame_end INTEGER NOT NULL, offset INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, call_id TEXT, tool_name TEXT, PRIMARY KEY(generation,seq)) STRICT;
    CREATE INDEX IF NOT EXISTS records_turn ON records(generation,turn,type,seq);
    CREATE TABLE IF NOT EXISTS extractions(generation TEXT NOT NULL,seq INTEGER NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(generation,seq)) STRICT;
    CREATE TABLE IF NOT EXISTS items(generation TEXT NOT NULL,key TEXT NOT NULL,first_seq INTEGER NOT NULL,latest_seq INTEGER NOT NULL,turn INTEGER,PRIMARY KEY(generation,key)) STRICT;
    CREATE INDEX IF NOT EXISTS items_order ON items(generation,first_seq DESC);
    CREATE TABLE IF NOT EXISTS item_events(generation TEXT NOT NULL,key TEXT NOT NULL,type TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(generation,key,type,seq)) STRICT;
    CREATE INDEX IF NOT EXISTS item_events_sequence ON item_events(generation,seq);
    PRAGMA user_version=4;`);
  db.exec('CREATE INDEX IF NOT EXISTS records_call ON records(generation,call_id,turn,type,seq);');
  const current = db.prepare('SELECT g.id,g.source_bytes,g.modified FROM generations g JOIN current c ON c.generation=g.id').get();
  if (current) { const generation = String(current.id); observations.delete(generation); observations.set(generation, { bytes: Number(current.source_bytes), modified: String(current.modified) }); if (observations.size > 16) observations.delete(observations.keys().next().value!); }
  return { db, key, name, path, bodyPath: (generation: string, seq: number, field: string) => join(options.cacheRoot, `${name}-${generation}-${seq}-${field}.body`) };
}
async function scan(args: unknown) {
  const binding = boundedBinding.parse(args), native = await source(binding), stored = await cache(binding).catch(async error => { await native.handle.close(); throw error; });
  try {
    await quota.ensure(Math.min(64 * 1024 ** 2, Math.floor(options.maxCacheBytes / 4))); stored.db.exec('BEGIN IMMEDIATE');
    const stat = await native.handle.stat({ bigint: true }); const size = Number(stat.size);
    if (!Number.isSafeInteger(size)) fail('source_too_large');
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`, metadata = await header(native.handle, size, native.compressed, binding);
    let generation = stored.db.prepare('SELECT g.* FROM generations g JOIN current c ON c.generation=g.id WHERE c.id=1').get() as Generation | undefined;
    if (!generation || generation.identity !== identity || generation.header !== metadata.hash) {
      stored.db.exec('DELETE FROM records; DELETE FROM generations; DELETE FROM current; DELETE FROM extractions; DELETE FROM item_events; DELETE FROM items;');
      generation = { id: generationId(identity, metadata.hash), identity, header: metadata.hash, source_offset: metadata.offset, source_bytes: size, modified: stat.mtimeNs.toString(), raw_bytes: 0, through_seq: -1, turn: null };
      stored.db.prepare('INSERT INTO generations VALUES (?,?,?,?,?,?,?,?,?)').run(generation.id, identity, metadata.hash, metadata.offset, size, generation.modified, 0, -1, null);
      stored.db.prepare('INSERT INTO current VALUES(1,?)').run(generation.id);
    } else if (size < generation.source_bytes || (size === generation.source_bytes && stat.mtimeNs.toString() !== generation.modified)) fail('source_changed');
    const before = generation.through_seq; let decodedBytes = 0;
    let parser = new BoundedJsonEnvelope(), utf8 = new TextDecoder('utf-8', { fatal: true }), hash = createHash('sha256');
    let rowBytes = 0, indexedBytes = generation.raw_bytes, currentTurn = generation.turn;
    let frame = -1, frameEndOffset = -1, rowOffset = generation.source_offset;
    const publish = (sourceOffset: number) => {
      generation!.source_offset = sourceOffset; generation!.source_bytes = size; generation!.modified = stat.mtimeNs.toString(); generation!.raw_bytes = indexedBytes; generation!.turn = currentTurn;
      stored.db.prepare('UPDATE generations SET source_offset=?,source_bytes=?,modified=?,raw_bytes=?,through_seq=?,turn=? WHERE id=?').run(sourceOffset, size, generation!.modified, indexedBytes, generation!.through_seq, currentTurn, generation!.id);
    };
    const insert = stored.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    const consume = (chunk: Buffer) => {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(start, end); decodedBytes += part.length;
        parser.write(utf8.decode(part, { stream: true })); hash.update(part); rowBytes += part.length;
        if (newline < 0) break;
        parser.write(utf8.decode()); const event = parser.finish();
        if (event.seq !== generation!.through_seq + 1) fail('sequence_gap');
        if (event.type === 'turn/start') { if (event.turn === undefined) fail('turn_missing'); currentTurn = event.turn; }
        insert.run(generation!.id, event.seq, event.type, event.time, currentTurn, frame, frameEndOffset, rowOffset, rowBytes, hash.digest('hex'), event.callId ?? null, event.toolName ?? null);
        const fields = parser.fields;
        const tool = event.callId && (['tool/call', 'tool/result'].includes(event.type) || event.type === 'job/settled' && fields['/data/kind'] === 'bash' && fields['/data/producerReported'] === true);
        const assistant = event.type === 'assistant/message' && currentTurn !== null && Number.isSafeInteger(fields['/data/step']);
        const standalone = event.type === 'user/message' && typeof fields['/data/source/rpcId'] === 'string' || event.type === 'approval/asked' || event.type === 'approval/decided' && fields['/data/outcome'] === 'unavailable' || event.type === 'turn/end' && fields['/data/reason/kind'] !== 'completed';
        const itemKey = tool ? `tool:${event.callId}` : assistant ? `assistant:${currentTurn}:${fields['/data/step']}` : standalone ? `event:${event.seq}` : undefined;
        if (itemKey) {
          const old = stored.db.prepare('SELECT turn FROM items WHERE generation=? AND key=?').get(generation!.id, itemKey);
          if (old && old.turn !== currentTurn) fail('item_identity_conflict');
          stored.db.prepare('INSERT INTO items VALUES(?,?,?,?,?) ON CONFLICT(generation,key) DO UPDATE SET latest_seq=excluded.latest_seq').run(generation!.id, itemKey, event.seq, event.seq, currentTurn);
          stored.db.prepare('INSERT INTO item_events VALUES(?,?,?,?)').run(generation!.id, itemKey, event.type, event.seq);
        }
        rowOffset += rowBytes + 1; indexedBytes += rowBytes; rowBytes = 0; generation!.through_seq = event.seq;
        parser = new BoundedJsonEnvelope(); utf8 = new TextDecoder('utf-8', { fatal: true }); hash = createHash('sha256'); start = newline + 1;
      }
    };
    let frames = 0;
    while (generation.source_offset < size && frames < 8 && decodedBytes < 8 * 1024 ** 2) {
      const start = generation.source_offset, end = native.compressed ? await frameEnd(native.handle, start, size) : size;
      if (end === undefined) break;
      frame = native.compressed ? start : -1; frameEndOffset = native.compressed ? end : -1; rowOffset = native.compressed ? 0 : start;
      stored.db.exec('SAVEPOINT batch');
      try {
        const blocks = native.compressed ? frameBlocks.writer({ key: stored.key, generation: generation.id, frame: start }) : undefined;
        let consumed = start, lastLineEnd = start;
        for await (const chunk of chunks(native.handle, start, end, native.compressed)) {
          consume(chunk); consumed += chunk.length;
          await blocks?.add(chunk);
          const newline = chunk.lastIndexOf(10); if (newline >= 0) lastLineEnd = consumed - chunk.length + newline + 1;
          if (!native.compressed && decodedBytes >= 8 * 1024 ** 2 && newline >= 0) break;
        }
        await blocks?.finish();
        if (native.compressed && rowBytes) fail('incomplete_frame_record');
        const observed = await native.handle.stat({ bigint: true });
        if (observed.size < stat.size || (observed.size === stat.size && observed.mtimeNs !== stat.mtimeNs)) fail('source_changed');
        publish(native.compressed ? end : lastLineEnd); stored.db.exec('RELEASE batch');
        if (!native.compressed) break;
      } catch (error) { stored.db.exec('ROLLBACK TO batch'); throw error; }
      frames++;
    }
    const after = await native.handle.stat({ bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size < stat.size) fail('source_changed');
    const indexBytes = Number(stored.db.prepare('PRAGMA page_count').get()!.page_count) * Number(stored.db.prepare('PRAGMA page_size').get()!.page_size);
    if (indexBytes + 64 * 1024 > options.maxCacheBytes) fail('cache_index_capacity');
    await quota.ensure(Math.max(0, indexBytes - (await pathStat(stored.path)).size) + 32 * 1024);
    stored.db.exec('COMMIT'); await quota.touch(`${stored.name}.sqlite`);
    return { sourceGeneration: generation.id, throughSeq: generation.through_seq, sourceOffset: generation.source_offset, sourceBytes: size, complete: generation.source_offset === size, indexedRecords: generation.through_seq - before, decodedBytes };
  } finally { await native.handle.close(); stored.db.close(); }
}
async function indexed(binding: z.infer<typeof boundedBinding>, generation: string, through: number) {
  let stored = await cache(binding);
  let value = stored.db.prepare('SELECT through_seq FROM generations WHERE id=?').get(generation) as { through_seq: number } | undefined;
  if (!value || value.through_seq < through) {
    stored.db.close(); const rebuilt = await scan(binding);
    if (rebuilt.sourceGeneration !== generation) fail('generation_changed');
    if (rebuilt.throughSeq < through) fail('indexing');
    stored = await cache(binding); value = { through_seq: rebuilt.throughSeq };
  }
  return stored;
}
/** Native frame decoder with a seek cursor; sequential body reads decode each frame once. */
async function recordSource(binding: z.infer<typeof boundedBinding>, generation: string, row: Row) {
  const native = await source(binding);
  try {
    const stat = await native.handle.stat({ bigint: true }), meta = await header(native.handle, Number(stat.size), native.compressed, binding);
    if (generationId(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`, meta.hash) !== generation) fail('generation_changed');
    const observed = observations.get(generation);
    if (observed && (Number(stat.size) < observed.bytes || Number(stat.size) === observed.bytes && stat.mtimeNs.toString() !== observed.modified)) fail('source_changed');
    let iterator: AsyncGenerator<Buffer> | undefined, cursor = 0, buffered: Buffer = Buffer.alloc(0), blocks: ReturnType<FrameBlockCache['writer']> | undefined;
    const frameIdentity = { key: digest(JSON.stringify(binding)), generation, frame: row.frame };
    let verifiedOffset = 0, checksum: ReturnType<typeof createHash> | undefined = createHash('sha256');
    const verify = (buffer: Buffer, offset: number, length: number, position: number) => {
      if (position !== verifiedOffset) { verifiedOffset = position; checksum = position === 0 ? createHash('sha256') : undefined; }
      checksum?.update(buffer.subarray(offset, offset + length)); verifiedOffset += length;
      if (verifiedOffset === row.bytes && checksum) { const hash = checksum.digest('hex'); checksum = undefined; if (hash !== row.sha256) fail('source_changed'); }
    };
    const reset = async () => { await iterator?.return(undefined); await blocks?.finish(false); iterator = chunks(native.handle, row.frame, row.frame_end, true); blocks = frameBlocks.writer(frameIdentity); cursor = 0; buffered = Buffer.alloc(0); };
    return {
      async read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> {
        if (position < 0 || position + length > row.bytes) fail('record_missing');
        if (row.frame < 0) { const bytes = await bytesAt(native.handle, row.offset + position, length); bytes.copy(buffer, offset); verify(buffer, offset, length, position); return { bytesRead: bytes.length }; }
        if (row.bytes <= 8192) {
          const bytes = await frameBlocks.read(frameIdentity, row.offset + position, length, () => chunks(native.handle, row.frame, row.frame_end, true));
          bytes.copy(buffer, offset); verify(buffer, offset, length, position); return { bytesRead: bytes.length };
        }
        const cached = await frameBlocks.readCached(frameIdentity, row.offset + position, length);
        if (cached) { cached.copy(buffer, offset); verify(buffer, offset, length, position); return { bytesRead: cached.length }; }
        const target = row.offset + position;
        if (!iterator || target < cursor) await reset();
        let written = 0;
        while (written < length) {
          if (!buffered.length) { const next = await iterator!.next(); if (next.done) fail('source_changed'); buffered = next.value; await blocks!.add(buffered); }
          if (cursor < target) { const skip = Math.min(target - cursor, buffered.length); cursor += skip; buffered = buffered.subarray(skip); continue; }
          const take = Math.min(length - written, buffered.length); buffered.copy(buffer, offset + written, 0, take); buffered = buffered.subarray(take); cursor += take; written += take;
        }
        verify(buffer, offset, length, position); return { bytesRead: written };
      },
      async close() { try { await iterator?.return(undefined); await blocks?.finish(false); const after = await native.handle.stat({ bigint: true }); if (after.size < stat.size || (after.size === stat.size && after.mtimeNs !== stat.mtimeNs)) fail('source_changed'); } finally { await native.handle.close(); } },
    };
  } catch (error) { await native.handle.close(); throw error; }
}
async function rowBytes(binding: z.infer<typeof boundedBinding>, generation: string, row: Row, offset: number, length: number) {
  const source = await recordSource(binding, generation, row);
  try { const buffer = Buffer.alloc(length); await source.read(buffer, 0, length, offset); if (offset === 0 && length === row.bytes && digest(buffer) !== row.sha256) fail('source_changed'); return buffer; }
  finally { await source.close(); }
}
let rawLease: { key: string; next: number; source: Awaited<ReturnType<typeof recordSource>>; hash?: ReturnType<typeof createHash> } | undefined;
async function closeRawLease() { const previous = rawLease; rawLease = undefined; await previous?.source.close(); }
async function rawChunk(binding: z.infer<typeof boundedBinding>, generation: string, row: Row, offset: number, length: number) {
  const key = `${digest(JSON.stringify(binding))}:${generation}:${row.seq}`;
  if (rawLease?.key !== key || rawLease.next !== offset) { await closeRawLease(); rawLease = { key, next: offset, source: await recordSource(binding, generation, row), ...(offset === 0 ? { hash: createHash('sha256') } : {}) }; }
  const current = rawLease!, buffer = Buffer.alloc(length);
  try {
    await current.source.read(buffer, 0, length, offset); current.hash?.update(buffer); current.next += length;
    if (current.next === row.bytes) { const hash = current.hash?.digest('hex'); await closeRawLease(); if (hash && hash !== row.sha256) fail('source_changed'); }
    return buffer;
  } catch (error) { await closeRawLease(); throw error; }
}
async function read(method: string, args: unknown) {
  const parsed = method === 'page' ? boundedPageArgs.parse(args) : boundedChunkArgs.parse(args);
  const binding = boundedBinding.parse({ sessionId: parsed.sessionId, cwd: parsed.cwd });
  const stored = await indexed(binding, parsed.sourceGeneration, 'throughSeq' in parsed ? parsed.throughSeq : parsed.seq);
  try {
    if ('throughSeq' in parsed) {
      const before = Math.min(parsed.beforeSeq ?? parsed.throughSeq + 1, parsed.throughSeq + 1);
      const rows = stored.db.prepare('SELECT * FROM records WHERE generation=? AND seq<? ORDER BY seq DESC LIMIT ?').all(parsed.sourceGeneration, before, parsed.maxRecords) as Row[];
      const records: BoundedRecord[] = []; let remaining = parsed.maxBytes - 256;
      for (const row of rows) {
        const record = { seq: row.seq, type: row.type, time: row.time, turn: row.turn, bytes: row.bytes, sha256: row.sha256 };
        const metadataBytes = Buffer.byteLength(JSON.stringify(record)) + 16; if (metadataBytes > remaining) break; remaining -= metadataBytes;
        if (row.bytes <= remaining) { records.push({ ...record, raw: await rowBytes(binding, parsed.sourceGeneration, row, 0, row.bytes) }); remaining -= row.bytes; }
        else records.push(record);
      }
      return { sourceGeneration: parsed.sourceGeneration, throughSeq: parsed.throughSeq, records, beforeSeq: records.at(-1)?.seq ? records.at(-1)!.seq : null };
    }
    const row = stored.db.prepare('SELECT * FROM records WHERE generation=? AND seq=?').get(parsed.sourceGeneration, parsed.seq) as Row | undefined;
    if (!row || parsed.offset > row.bytes) fail('record_missing');
    return { sourceGeneration: parsed.sourceGeneration, seq: row.seq, sha256: row.sha256, offset: parsed.offset, totalBytes: row.bytes, bytes: await rawChunk(binding, parsed.sourceGeneration, row, parsed.offset, Math.min(parsed.maxBytes, row.bytes - parsed.offset)) };
  } finally { await quota.touch(`${stored.name}.sqlite`); stored.db.close(); }
}
async function projectBody(method: string, args: unknown) {
  const parsed = method === 'project' ? boundedProjectArgs.parse(args) : boundedBodyArgs.parse(args), binding = boundedBinding.parse({ sessionId: parsed.sessionId, cwd: parsed.cwd });
  let stored = await cache(binding);
  try {
    const leased = method === 'body' ? boundedBodyArgs.parse(args) : undefined;
    if (leased?.lease) {
      const name = basename(stored.bodyPath(leased.sourceGeneration, leased.seq, leased.field));
      const body = quota.renew(leased.lease, stored.key, name);
      if (leased.offset > body.bytes) fail('record_missing');
      if ((await pathStat(join(options.cacheRoot, name)).catch(() => undefined))?.size === body.bytes) {
        const handle = await file(join(options.cacheRoot, name));
        try { return { sourceGeneration: leased.sourceGeneration, seq: leased.seq, sha256: body.version, offset: leased.offset, totalBytes: body.bytes, bytes: await bytesAt(handle, leased.offset, Math.min(leased.maxBytes, body.bytes - leased.offset)) }; }
        finally { await handle.close(); await quota.touch(name); }
      }
    }
    const previous = stored.db.prepare('SELECT metadata FROM extractions WHERE generation=? AND seq=?').get(parsed.sourceGeneration, parsed.seq);
    let extracted = previous ? JSON.parse(String(previous.metadata)) as ExtractedRecord : undefined;
    let present = !!extracted;
    for (const [field, descriptor] of Object.entries(extracted?.fields ?? {})) if ((await pathStat(stored.bodyPath(parsed.sourceGeneration, parsed.seq, field)).catch(() => undefined))?.size !== descriptor.bytes) present = false;
    if (!present) {
      stored.db.close(); stored = await indexed(binding, parsed.sourceGeneration, parsed.seq);
      const row = stored.db.prepare('SELECT * FROM records WHERE generation=? AND seq=?').get(parsed.sourceGeneration, parsed.seq) as Row | undefined;
      if (!row) fail('record_missing');
      await quota.ensure(row.bytes * 3);
      const source = await recordSource(binding, parsed.sourceGeneration, row);
      try { extracted = await extractRecord(source, 0, row.bytes, field => { const path = stored.bodyPath(parsed.sourceGeneration, row.seq, field); quota.protectFile(basename(path)); return path; }, options.maxCacheBytes); }
      finally { await source.close(); }
      stored.db.prepare('INSERT INTO extractions VALUES(?,?,?) ON CONFLICT(generation,seq) DO UPDATE SET metadata=excluded.metadata').run(parsed.sourceGeneration, row.seq, JSON.stringify(extracted));
    }
    if (!extracted) fail('record_missing');
    if (method === 'project') {
      quota.requireLeases(Object.keys(extracted.fields).length);
      for (const [field, descriptor] of Object.entries(extracted.fields)) descriptor.lease = quota.lease(stored.key, basename(stored.bodyPath(parsed.sourceGeneration, parsed.seq, field)), descriptor);
      return extracted;
    }
    const request = boundedBodyArgs.parse(args), body = extracted.fields[request.field]; if (!body || request.offset > body.bytes) fail('record_missing');
    const name = basename(stored.bodyPath(request.sourceGeneration, request.seq, request.field));
    if (request.lease) quota.renew(request.lease, stored.key, name);
    const handle = await file(stored.bodyPath(request.sourceGeneration, request.seq, request.field));
    try { return { sourceGeneration: request.sourceGeneration, seq: request.seq, sha256: body.version, offset: request.offset, totalBytes: body.bytes, bytes: await bytesAt(handle, request.offset, Math.min(request.maxBytes, body.bytes - request.offset)) }; }
    finally { await handle.close(); await quota.touch(name); }
  } finally { stored.db.close(); }
}
async function itemPage(method: string, args: unknown) {
  const parsed = method === 'itemsByKeys' ? boundedItemsArgs.parse(args) : boundedPageArgs.parse(args);
  const binding = boundedBinding.parse({ sessionId: parsed.sessionId, cwd: parsed.cwd }), store = await indexed(binding, parsed.sourceGeneration, parsed.throughSeq);
  try {
    const selected = 'keys' in parsed
      ? parsed.keys.flatMap(key => { const row = store.db.prepare('SELECT key,first_seq FROM items WHERE generation=? AND key=? AND first_seq<=?').get(parsed.sourceGeneration, key, parsed.throughSeq); return row ? [row] : []; })
      : store.db.prepare('SELECT key,first_seq FROM items WHERE generation=? AND first_seq<? ORDER BY first_seq DESC LIMIT ?').all(parsed.sourceGeneration, Math.min(parsed.beforeSeq ?? parsed.throughSeq + 1, parsed.throughSeq + 1), parsed.maxRecords);
    const latestEvent = store.db.prepare('SELECT seq FROM item_events WHERE generation=? AND key=? AND type=? AND seq<=? ORDER BY seq DESC LIMIT 1');
    const recordAt = store.db.prepare('SELECT * FROM records WHERE generation=? AND seq=?');
    const groups: BoundedItemGroup[] = []; let remaining = ('maxBytes' in parsed ? parsed.maxBytes : 256 * 1024) - 256;
    for (const anchor of selected) {
      const key = String(anchor.key);
      // Event kinds are fixed by the indexer's item-key mapping. Seek each kind's
      // latest revision, so one item with years of revisions also stays bounded.
      const types = key.startsWith('tool:') ? ['tool/call', 'tool/result', 'job/settled'] : key.startsWith('assistant:') ? ['assistant/message'] : [];
      const latest = types.length ? types.flatMap(type => {
        const event = latestEvent.get(parsed.sourceGeneration, key, type, parsed.throughSeq); return event ? [event] : [];
      }) : [{ seq: anchor.first_seq }];
      // A join plus ORDER BY made SQLite walk every record in the generation
      // for each item. Resolve the at-most-three event identities first, then
      // force composite-primary-key point reads; sort only these bounded rows.
      const rows = latest.map(event => {
        const seq = Number(event.seq); if (!Number.isSafeInteger(seq) || seq < 0) fail('record_missing');
        const row = recordAt.get(parsed.sourceGeneration, seq) as Row | undefined;
        if (!row) fail('record_missing');
        return row;
      }).sort((left, right) => left.seq - right.seq);
      const metadataBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify({ seq: row.seq, type: row.type, time: row.time, turn: row.turn, bytes: row.bytes, sha256: row.sha256 })) + 16, 128);
      if (metadataBytes > remaining) { if (!groups.length) fail('page_budget'); break; } remaining -= metadataBytes;
      const records: BoundedRecord[] = [];
      for (const row of rows) {
        const record = { seq: row.seq, type: row.type, time: row.time, turn: row.turn, bytes: row.bytes, sha256: row.sha256 };
        if (row.bytes <= Math.min(8192, remaining)) { records.push({ ...record, raw: await rowBytes(binding, parsed.sourceGeneration, row, 0, row.bytes) }); remaining -= row.bytes; }
        else records.push(record);
      }
      groups.push({ key: String(anchor.key), orderSeq: Number(anchor.first_seq), records });
    }
    const oldest = groups.at(-1)?.orderSeq;
    const hasOlder = oldest !== undefined && !!store.db.prepare('SELECT 1 FROM items WHERE generation=? AND first_seq<? LIMIT 1').get(parsed.sourceGeneration, oldest);
    return { groups, beforeSeq: hasOlder ? oldest! : null };
  } finally { store.db.close(); }
}
async function relatedCall(args: unknown) {
  const parsed = boundedProjectArgs.parse(args), store = await indexed(boundedBinding.parse({ sessionId: parsed.sessionId, cwd: parsed.cwd }), parsed.sourceGeneration, parsed.seq);
  try {
    return store.db.prepare(`SELECT c.seq,c.turn,c.call_id callId,c.tool_name name FROM records r JOIN records c
      ON c.generation=r.generation AND c.call_id=r.call_id AND c.turn=r.turn AND c.seq<r.seq AND c.type='tool/call'
      WHERE r.generation=? AND r.seq=? AND r.type='tool/result' AND c.tool_name IS NOT NULL ORDER BY c.seq DESC LIMIT 1`).get(parsed.sourceGeneration, parsed.seq) ?? null;
  } finally { store.db.close(); }
}
async function changes(args: unknown) {
  const parsed = boundedChangesArgs.parse(args), binding = boundedBinding.parse({ sessionId: parsed.sessionId, cwd: parsed.cwd });
  if (parsed.cursor) {
    const native = await source(binding);
    try {
      const stat = await native.handle.stat({ bigint: true }), meta = await header(native.handle, Number(stat.size), native.compressed, binding);
      if (generationId(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`, meta.hash) !== parsed.cursor.generation) fail('generation_changed');
    } finally { await native.handle.close(); }
  }
  // One incremental indexing step per request; callers retry indexing explicitly.
  const scanned = await scan(binding);
  if (!scanned.complete) fail('indexing');
  const cursor = parsed.cursor;
  if (cursor && (cursor.generation !== scanned.sourceGeneration || cursor.through > scanned.throughSeq)) fail('generation_changed');
  const through = cursor && cursor.after < cursor.through ? cursor.through : scanned.throughSeq, after = cursor?.after ?? -1;
  const store = await indexed(binding, scanned.sourceGeneration, through);
  try {
    const rows = store.db.prepare('SELECT key,seq FROM item_events WHERE generation=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?').all(scanned.sourceGeneration, after, through, parsed.limit);
    const last = rows.length ? Number(rows.at(-1)!.seq) : through;
    const hasMore = !!store.db.prepare('SELECT 1 FROM item_events WHERE generation=? AND seq>? AND seq<=? LIMIT 1').get(scanned.sourceGeneration, last, through);
    return { keys: [...new Set(rows.map(row => String(row.key)))], cursor: { generation: scanned.sourceGeneration, through, after: hasMore ? last : through }, hasMore };
  } finally { store.db.close(); }
}
async function terminal(args: unknown) {
  const parsed = boundedTerminalArgs.parse(args); const store = await indexed(boundedBinding.parse({ sessionId: parsed.sessionId, cwd: parsed.cwd }), parsed.sourceGeneration, parsed.throughSeq);
  try {
    const generation = store.db.prepare('SELECT through_seq FROM generations WHERE id=?').get(parsed.sourceGeneration) as { through_seq: number } | undefined;
    if (!generation || parsed.throughSeq > generation.through_seq) fail('cut_unavailable');
    return store.db.prepare("SELECT seq FROM records WHERE generation=? AND turn=? AND type='turn/end' AND seq<=? ORDER BY seq DESC LIMIT 1").get(parsed.sourceGeneration, parsed.turn, parsed.throughSeq) ?? null;
  } finally { store.db.close(); }
}
let chain = Promise.resolve();
parentPort?.on('message', (message: { id: number; method: string; args: unknown }) => {
  chain = chain.then(async () => {
    let locked = false; let reply: Record<string, unknown>;
    try {
      options.nativeRoot = await directory(options.nativeRoot, false); options.cacheRoot = await directory(options.cacheRoot, true);
      if (relative(options.nativeRoot, options.cacheRoot).split(sep)[0] !== '..' || relative(options.cacheRoot, options.nativeRoot).split(sep)[0] !== '..') fail('cache_overlaps_source');
      quota = await BoundedCache.lock(options.cacheRoot, options.maxCacheBytes); locked = true;
      if (message.method !== 'chunk') await closeRawLease();
      let result: unknown;
      if (message.method === 'release') {
        const released = quota.release(z.string().uuid().parse(message.args));
        if (released?.unleased) {
          await rm(join(options.cacheRoot, released.file), { force: true });
          const match = /^v2-[a-f0-9]{64}-([a-f0-9-]{36})-(\d+)-(text|input)\.body$/.exec(released.file);
          const path = join(options.cacheRoot, `v2-${released.key}.sqlite`);
          if (match && await pathStat(path).catch(() => undefined)) {
            const db = new DatabaseSync(path); try { db.prepare('DELETE FROM extractions WHERE generation=? AND seq=?').run(match[1]!, Number(match[2])); } finally { db.close(); }
          }
        }
        result = null;
      }
      else if (message.method === 'status') result = null;
      else result = ['items', 'itemsByKeys'].includes(message.method) ? await itemPage(message.method, message.args) : message.method === 'changes' ? await changes(message.args) : message.method === 'scan' ? await scan(message.args) : message.method === 'terminal' ? await terminal(message.args) : message.method === 'call' ? await relatedCall(message.args) : ['page', 'chunk'].includes(message.method) ? await read(message.method, message.args) : ['project', 'body'].includes(message.method) ? await projectBody(message.method, message.args) : fail('invalid_method');
      await quota.ensure();
      const status = { ...quota.status(), frameReads: frameBlocks.stats() };
      reply = { id: message.id, result: message.method === 'status' ? status : result, cacheStatus: status };
    } catch (error) { const code = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'dsh_bounded_source_missing' : error instanceof Error && /^dsh_bounded_[a-z_]+$/.test(error.message) ? error.message : 'dsh_bounded_read_failed'; reply = { id: message.id, error: code, ...(locked ? { cacheStatus: quota.status() } : {}) }; }
    finally { if (locked) { try { quota.close(); } catch { reply = { id: message.id, error: 'dsh_bounded_cache_failed' }; } } }
    parentPort!.postMessage(reply!);
  });
});

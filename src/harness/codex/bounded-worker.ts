import { parentPort, workerData } from 'node:worker_threads';
import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, chmod, rm, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, relative, sep, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { BoundedJsonEnvelope } from '../dsh/bounded-json.ts';
import { BoundedCache } from '../dsh/bounded-cache.ts';
import { boundedCodexOptions, rolloutBinding, rolloutCursor, rolloutChangesCursor, rolloutBody, rolloutKey, encodeRolloutToken } from './bounded-reader.ts';
import type { RolloutBinding } from './bounded-reader.ts';
import type { NativeItem, NativeBodySource, HistoryPage } from '../types.ts';
import { editPath } from '../edit-paths.ts';
import { fileURLToPath } from 'node:url';

const options = boundedCodexOptions.parse(workerData);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(512);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fields = new Set(['/type', '/payload/type', '/payload/id', '/payload/name', '/payload/cwd', '/payload/cli_version', '/payload/thread_id', '/payload/turn_id', '/payload/call_id', '/payload/role', '/payload/internal_chat_message_metadata_passthrough/turn_id', '/payload/item/id', '/payload/item/type', '/payload/item/client_id', '/payload/item/status', '/payload/item/success', '/payload/item/exit_code', '/payload/item/name', '/payload/item/tool', '/payload/item/saved_path', '/payload/item/savedPath']);
fields.add('/ordinal'); fields.add('/payload/history_mode');
const selection = { capture: (path: string) => fields.has(path), stream: () => false };
const fail = (code: string): never => { throw new Error(code); };
let quota: BoundedCache;
type State = { generation: string; identity: string; header: string; offset: number; size: number; modified: string; seq: number; turn: string | null };
type Row = { id: string; seq: number; first_seq: number; turn: string; kind: string; offset: number; bytes: number; sha: string; metadata: string };
async function file(path: string, write = false) {
  const handle = await open(path, constants.O_NOFOLLOW | (write ? constants.O_CREAT | constants.O_RDWR : constants.O_RDONLY), 0o600);
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1 || (write && process.getuid && stat.uid !== process.getuid())) { await handle.close(); fail('codex_bounded_unsafe_path'); }
  if (write) await handle.chmod(0o600);
  return handle;
}
async function read(handle: FileHandle, offset: number, length: number) {
  const data = Buffer.alloc(length); let at = 0;
  while (at < length) { const result = await handle.read(data, at, length - at, offset + at); if (!result.bytesRead) fail('history_source_changed'); at += result.bytesRead; }
  return data;
}
async function write(handle: FileHandle, data: Buffer, offset: number) {
  let at = 0; while (at < data.length) { const result = await handle.write(data, at, data.length - at, offset + at); if (!result.bytesWritten) fail('codex_bounded_cache_write_failed'); at += result.bytesWritten; }
}
async function roots() {
  await mkdir(options.cacheRoot, { recursive: true, mode: 0o700 });
  const [native, cache] = await Promise.all([realpath(options.nativeRoot), realpath(options.cacheRoot)]);
  for (const path of [options.nativeRoot, options.cacheRoot]) { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('codex_bounded_unsafe_path'); }
  const stat = await lstat(options.cacheRoot); if (process.getuid && stat.uid !== process.getuid()) fail('codex_bounded_unsafe_path');
  if (native === cache || cache.startsWith(native + sep) || native.startsWith(cache + sep)) fail('codex_bounded_roots_overlap');
  await chmod(options.cacheRoot, 0o700); options.nativeRoot = native; options.cacheRoot = cache;
}
async function source(binding: RolloutBinding) {
  const canonical = await realpath(binding.path);
  const components = relative(options.nativeRoot, canonical).split(sep);
  if (!['sessions', 'archived_sessions'].includes(components[0]!) || components.some(part => part === '..' || part === '.') || !/^rollout-.+\.jsonl$/.test(components.at(-1)!)) fail('codex_bounded_unsafe_path');
  // Walk the operator-owned root to prevent symlink escapes, including in parents.
  let path = options.nativeRoot;
  for (const component of components) { path = join(path, component); if ((await lstat(path)).isSymbolicLink()) fail('codex_bounded_unsafe_path'); }
  if (await realpath(binding.path) !== canonical || (await lstat(binding.path)).isSymbolicLink()) fail('codex_bounded_unsafe_path');
  return file(canonical);
}
function uuid(value: string) { const h = hash(value); return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; }
async function header(handle: FileHandle, binding: RolloutBinding, size: number) {
  const parser = new BoundedJsonEnvelope(undefined, selection), decoder = new TextDecoder('utf-8', { fatal: true }), digest = createHash('sha256');
  let bytes = 0;
  for (let offset = 0; offset < size; offset += 64 * 1024) {
    const chunk = await read(handle, offset, Math.min(64 * 1024, size - offset)); const end = chunk.indexOf(10), part = end < 0 ? chunk : chunk.subarray(0, end + 1);
    digest.update(part); parser.write(decoder.decode(part, { stream: true })); bytes += part.length;
    if (bytes > 8 * 1024 ** 2) fail('codex_bounded_header_capacity');
    if (end >= 0) {
      parser.write(decoder.decode()); parser.finishDocument(); const f = parser.fields;
      if (f['/type'] !== 'session_meta' || f['/payload/id'] !== binding.id || f['/payload/cli_version'] !== binding.cliVersion) fail('history_source_changed');
      if (f['/ordinal'] !== 0 || f['/payload/history_mode'] !== 'paginated') fail('codex_bounded_unsupported_format');
      const cwd = f['/payload/cwd']; if (typeof cwd !== 'string' || (cwd !== binding.cwd && await realpath(cwd) !== await realpath(binding.cwd))) fail('history_source_changed');
      return { bytes, sha: digest.digest('hex') };
    }
  }
  return fail('codex_bounded_incomplete_header');
}
async function database(key: string) {
  const path = join(options.cacheRoot, `v2-${key}.sqlite`); const handle = await file(path, true); await handle.close();
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA auto_vacuum=FULL; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation TEXT NOT NULL,identity TEXT NOT NULL,header TEXT NOT NULL,offset INTEGER NOT NULL,size INTEGER NOT NULL,modified TEXT NOT NULL,seq INTEGER NOT NULL,turn TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS anchors(id TEXT PRIMARY KEY,first_seq INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS records(seq INTEGER PRIMARY KEY,id TEXT NOT NULL,turn TEXT NOT NULL,kind TEXT NOT NULL,offset INTEGER NOT NULL,bytes INTEGER NOT NULL,sha TEXT NOT NULL,metadata TEXT NOT NULL,client TEXT) STRICT;
    CREATE INDEX IF NOT EXISTS records_item ON records(id,seq DESC);
    CREATE INDEX IF NOT EXISTS records_client ON records(client);
    CREATE INDEX IF NOT EXISTS anchors_order ON anchors(first_seq DESC);
    CREATE TABLE IF NOT EXISTS extractions(seq INTEGER PRIMARY KEY,metadata TEXT NOT NULL) STRICT;`);
  return db;
}
async function scan(handle: FileHandle, db: DatabaseSync, binding: RolloutBinding): Promise<State> {
  const stat = await handle.stat({ bigint: true }), size = Number(stat.size), head = await header(handle, binding, size);
  const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  let state = db.prepare('SELECT generation,identity,header,offset,size,modified,seq,turn FROM state').get() as State | undefined;
  if (state && state.identity === identity && state.header === head.sha && (size < state.size || (size === state.size && String(stat.mtimeNs) !== state.modified))) fail('history_source_changed');
  if (!state || state.identity !== identity || state.header !== head.sha) {
    db.exec('DELETE FROM records; DELETE FROM anchors; DELETE FROM extractions; DELETE FROM state;');
    state = { generation: uuid(identity + head.sha), identity, header: head.sha, offset: head.bytes, size, modified: String(stat.mtimeNs), seq: 0, turn: null };
  }
  const target = { ...state, size, modified: String(stat.mtimeNs) };
  const start = target.offset;
  await quota.ensure(Math.min(8 * 1024 ** 2, options.maxCacheBytes / 4));
  db.exec('BEGIN IMMEDIATE;');
  try {
    let parser = new BoundedJsonEnvelope(undefined, selection), decoder = new TextDecoder('utf-8', { fatal: true }), digest = createHash('sha256'), lineBytes = 0;
    outer: for (let offset = start; offset < size; offset += 64 * 1024) {
      const chunk = await read(handle, offset, Math.min(64 * 1024, size - offset));
      let begin = 0;
      while (begin < chunk.length) {
        const end = chunk.indexOf(10, begin), part = chunk.subarray(begin, end < 0 ? chunk.length : end + 1);
        digest.update(part); parser.write(decoder.decode(part, { stream: true })); lineBytes += part.length; begin += part.length;
        if (end < 0) continue;
        parser.write(decoder.decode()); parser.finishDocument(); const f = parser.fields; target.seq++;
        if (f['/ordinal'] !== target.seq) fail('codex_bounded_ordinal_gap');
        if (f['/type'] === 'event_msg' && f['/payload/type'] === 'task_started') target.turn = id.parse(f['/payload/turn_id']);
        const completed = f['/type'] === 'event_msg' && f['/payload/type'] === 'item_completed';
        const called = f['/type'] === 'response_item' && ['function_call', 'custom_tool_call'].includes(String(f['/payload/type']));
        const answered = f['/type'] === 'response_item' && typeof f['/payload/call_id'] === 'string' && ['function_call_output', 'custom_tool_call_output'].includes(String(f['/payload/type']));
        if (completed || called || answered) {
          if (completed && f['/payload/thread_id'] !== binding.id) fail('history_source_changed');
          const itemId = id.parse(f[completed ? '/payload/item/id' : '/payload/call_id']);
          const turn = id.parse(completed ? f['/payload/turn_id'] : f['/payload/internal_chat_message_metadata_passthrough/turn_id'] ?? target.turn);
          const kind = completed ? id.parse(f['/payload/item/type']) : answered ? 'GenericToolResult' : 'PendingCall';
          db.prepare('INSERT INTO anchors VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(itemId, target.seq);
          const old = db.prepare('SELECT turn FROM records WHERE id=? LIMIT 1').get(itemId);
          if (old && old.turn !== turn) fail('codex_bounded_item_identity_changed');
          // Public completed items own their semantics. Internal tool output still
          // settles calls (such as get_goal) which have no public timeline item.
          const native = answered ? db.prepare("SELECT 1 FROM records WHERE id=? AND kind NOT IN ('PendingCall','GenericToolResult') LIMIT 1").get(itemId) : undefined;
          if (!native) db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?)').run(target.seq, itemId, turn, kind, target.offset, lineBytes, digest.digest('hex'), JSON.stringify(f), typeof f['/payload/item/client_id'] === 'string' ? f['/payload/item/client_id'] : null);
        }
        target.offset += lineBytes; lineBytes = 0;
        parser = new BoundedJsonEnvelope(undefined, selection); decoder = new TextDecoder('utf-8', { fatal: true }); digest = createHash('sha256');
        if (target.offset - start >= 8 * 1024 ** 2) break outer;
      }
    }
    db.prepare('INSERT OR REPLACE INTO state VALUES(1,?,?,?,?,?,?,?,?)').run(target.generation, target.identity, target.header, target.offset, target.size, target.modified, target.seq, target.turn);
    const bytes = Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size);
    if (bytes > options.maxCacheBytes - 64 * 1024) fail('codex_bounded_cache_index_capacity');
    const disk = await lstat(join(options.cacheRoot, `v2-${rolloutKey(binding)}.sqlite`)); await quota.ensure(Math.max(0, bytes - disk.size) + 32768);
    db.exec('COMMIT;');
    const after = await handle.stat({ bigint: true });
    if (Number(after.size) < size || after.ino !== stat.ino) fail('history_source_changed');
    // A torn last line is not complete history. Appending the newline makes it resumable.
    if (target.offset < size) fail('codex_bounded_indexing');
    return target;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK;'); throw error; }
}

type BodyField = 'text' | 'input' | 'output' | 'image';
type Descriptor = { bytes: number; version: string; preview: string };
type Projection = { item: NativeItem; fields: Partial<Record<BodyField, Descriptor>> };
const inlineMessage = z.object({ payload: z.object({ item: z.object({
  content: z.array(z.object({ type: z.enum(['text', 'Text']), text: z.string() })).max(32),
}) }) });
/** Small, complete text records need no temporary file, lease or staging RPC.
 * The physical byte limit is checked before JSON.parse; every other shape keeps
 * the streaming path, including mixed content and oversized escaped strings.
 */
async function inlineText(handle: FileHandle, row: Row, generation: string): Promise<NativeItem | undefined> {
  if (!['AgentMessage', 'UserMessage'].includes(row.kind) || row.bytes > 8192) return;
  const data = await read(handle, row.offset, row.bytes);
  if (hash(data) !== row.sha) fail('history_source_changed');
  const parsed = inlineMessage.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)));
  if (!parsed.success) return;
  const parts = parsed.data.payload.item.content;
  if (!parts.every(part => part.type === (row.kind === 'AgentMessage' ? 'Text' : 'text'))) return;
  const text = parts.map(part => part.text).join('\n');
  if (Buffer.byteLength(text) > 4096) return;
  const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  return { id: row.id, runId: row.turn, kind: row.kind === 'AgentMessage' ? 'assistant' : 'user', status: 'completed', text,
    sourceRevision: { generation, sequence: row.seq },
    ...(row.kind === 'UserMessage' && typeof metadata['/payload/item/client_id'] === 'string' ? { operationId: metadata['/payload/item/client_id'] as string } : {}) };
}
function bodyName(key: string, generation: string, seq: number, field: string) { return `${key}-${generation}-${seq}-${field}.body`; }
async function extract(handle: FileHandle, row: Row, key: string, generation: string, cwd: string, call?: Row): Promise<Projection> {
  const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  const prefix = '/payload/item'; const supported = ['UserMessage', 'AgentMessage', 'CommandExecution', 'Reasoning', 'Plan', 'PendingCall', 'GenericToolResult'].includes(row.kind);
  const outputs = new Map<BodyField, { handle: FileHandle; bytes: number; hash: ReturnType<typeof createHash>; preview: Buffer[]; previewBytes: number; path: string }>();
  const stage = randomUUID(); let actions: { field: BodyField; text?: string; start?: number; end?: number }[] = [], lastTextPath: string | undefined, lastDiffPath: string | undefined, mixedContent = false, displayText: string | undefined;
  const spans = new Map<string, { start: number; end: number }>();
  const paths = new Set<string>(); let fileEditsLimited = false, pathBytes = 0;
  const changed = (value: unknown) => {
    if (typeof value !== 'string') return;
    let path = value; if (path.startsWith('file:')) { try { path = fileURLToPath(path); } catch { return; } }
    const selected = editPath(cwd, path); if (!selected || paths.has(selected)) return;
    const bytes = Buffer.byteLength(JSON.stringify(selected)) + 1;
    if (paths.size < 100 && pathBytes + bytes <= 32 * 1024) { paths.add(selected); pathBytes += bytes; } else fileEditsLimited = true;
  };
  const target = (field: string) => join(options.cacheRoot, bodyName(key, generation, row.seq, field));
  const output = async (field: BodyField, data: Buffer) => {
    if (!data.length) return;
    let sink = outputs.get(field);
    if (!sink) { const path = target(`${field}-stage-${stage}`); sink = { handle: await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600), bytes: 0, hash: createHash('sha256'), preview: [], previewBytes: 0, path }; outputs.set(field, sink); }
    await write(sink.handle, data, sink.bytes); sink.hash.update(data); sink.bytes += data.length;
    if (sink.previewBytes < 8192) { const head = Buffer.from(data.subarray(0, 8192 - sink.previewBytes)); sink.preview.push(head); sink.previewBytes += head.length; }
  };
  const parser = new BoundedJsonEnvelope({
    string(path, text, final) {
      if (path === prefix + '/aggregated_output' || path === '/payload/output') actions.push({ field: 'output', text });
      else if (path === prefix + '/result' && row.kind === 'ImageGeneration') actions.push({ field: 'image', text });
      else if (row.kind === 'FileChange' && /^\/payload\/item\/changes\/[^/]+\/(content|unified_diff)$/.test(path)) {
        if (path !== lastDiffPath) { const name = path.split('/')[4]!.replaceAll('~1', '/').replaceAll('~0', '~'); actions.push({ field: 'output', text: (lastDiffPath ? '\n' : '') + name + '\n' }); lastDiffPath = path; }
        actions.push({ field: 'output', text });
      }
      else if (['/payload/arguments', '/payload/input'].includes(path)) actions.push({ field: 'input', text });
      else if (/^\/payload\/item\/summary_text\/\d+$/.test(path) || path === prefix + '/text') { if (lastTextPath !== path) { if (lastTextPath !== undefined) actions.push({ field: 'text', text: '\n' }); lastTextPath = path; } actions.push({ field: 'text', text }); }
      else if (/^\/payload\/item\/content\/\d+\/text$/.test(path)) { if (lastTextPath !== path) { if (lastTextPath !== undefined) actions.push({ field: 'text', text: '\n' }); lastTextPath = path; } actions.push({ field: 'text', text }); }
    }, value(path, value) {
      if (row.kind === 'FileChange' && /^\/payload\/item\/changes\/[^/]+\/(?:path|move_path|kind\/move_path)$/.test(path)) changed(value);
      if (/^\/payload\/item\/content\/\d+\/type$/.test(path) && (row.kind === 'UserMessage' ? value !== 'text' : value !== 'Text')) { mixedContent = true; actions.push({ field: 'text', text: (lastTextPath === undefined ? '' : '\n') + '[非文本输入]' }); lastTextPath = path; }
    }, end() {},
    span(path, start, end) {
      if ([prefix, prefix + '/command', prefix + '/changes', '/payload/arguments', '/payload/input', '/payload/output'].includes(path)) spans.set(path, { start, end });
      const entry = row.kind === 'FileChange' ? /^\/payload\/item\/changes\/([^/]+)$/.exec(path) : null;
      if (entry && !/^\d+$/.test(entry[1]!)) changed(entry[1]!.replaceAll('~1', '/').replaceAll('~0', '~'));
    },
  }, { capture: path => (row.kind === 'UserMessage' || row.kind === 'AgentMessage') && /^\/payload\/item\/content\/\d+\/type$/.test(path) || row.kind === 'FileChange' && /^\/payload\/item\/changes\/[^/]+\/(?:path|move_path|kind\/move_path)$/.test(path), stream: path => row.kind === 'ImageGeneration' && path === prefix + '/result' || row.kind === 'FileChange' && /^\/payload\/item\/changes\/[^/]+\/(content|unified_diff)$/.test(path) || supported && (/^\/payload\/item\/(?:content\/\d+\/text|summary_text\/\d+|text|aggregated_output)$/.test(path) || /^\/payload\/(arguments|input|output)$/.test(path)) });
  const digest = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (let at = 0; at < row.bytes; at += 64 * 1024) {
      const data = await read(handle, row.offset + at, Math.min(64 * 1024, row.bytes - at)); digest.update(data); parser.write(decoder.decode(data, { stream: true }));
      for (const action of actions) await output(action.field, Buffer.from(action.text!, 'utf8')); actions = [];
    }
    parser.write(decoder.decode()); parser.finishDocument(); for (const action of actions) await output(action.field, Buffer.from(action.text!, 'utf8'));
    if (digest.digest('hex') !== row.sha) fail('history_source_changed');
    if (row.kind === 'FileChange') { const span = spans.get(prefix + '/changes'); if (!span || (await read(handle, row.offset + span.start, 1))[0] !== 123) fail('codex_bounded_item_invalid'); }
    const copy = async (field: BodyField, span: { start: number; end: number }) => { for (let at = span.start; at < span.end; at += 64 * 1024) await output(field, await read(handle, row.offset + at, Math.min(64 * 1024, span.end - at))); };
    if (row.kind === 'CommandExecution' && spans.has(prefix + '/command')) await copy('input', spans.get(prefix + '/command')!);
    if (row.kind === 'PendingCall' && !outputs.has('input')) { const span = spans.get('/payload/arguments') ?? spans.get('/payload/input'); if (span) await copy('input', span); }
    if (row.kind === 'GenericToolResult' && !outputs.has('output')) { const span = spans.get('/payload/output'); if (span) await copy('output', span); }
    if (row.kind === 'GenericToolResult' && call) {
      let parts: string[] = []; const inputParser = new BoundedJsonEnvelope({ string(_path, text) { parts.push(text); }, value() {}, end() {}, span() {} }, { capture: () => false, stream: path => ['/payload/arguments', '/payload/input'].includes(path) });
      const inputDecoder = new TextDecoder('utf-8', { fatal: true }), digest = createHash('sha256');
      for (let at = 0; at < call.bytes; at += 64 * 1024) { const data = await read(handle, call.offset + at, Math.min(64 * 1024, call.bytes - at)); digest.update(data); inputParser.write(inputDecoder.decode(data, { stream: true })); for (const part of parts) await output('input', Buffer.from(part)); parts = []; }
      inputParser.write(inputDecoder.decode()); inputParser.finishDocument(); for (const part of parts) await output('input', Buffer.from(part));
      if (digest.digest('hex') !== call.sha) fail('history_source_changed');
    }
    if (!supported) { const span = spans.get(prefix); if (!span) throw new Error('codex_bounded_item_invalid'); await copy('text', span); }
    if (mixedContent) {
      const sink = outputs.get('text');
      if (sink) displayText = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(sink.preview), { stream: true });
      await output('text', Buffer.from('\n原生非文本记录：\n'));
      const span = spans.get(prefix); if (!span) throw new Error('codex_bounded_item_invalid'); await copy('text', span);
    }
    const descriptors: Projection['fields'] = {};
    for (const [field, sink] of outputs) {
      await sink.handle.sync(); await sink.handle.close(); await rename(sink.path, target(field));
      descriptors[field] = { bytes: sink.bytes, version: sink.hash.digest('hex'), preview: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(sink.preview), { stream: true }) };
    }
    const status = row.kind === 'PendingCall' || ['in_progress', 'inProgress', 'running'].includes(String(metadata[prefix + '/status'])) ? 'running' : metadata[prefix + '/success'] === false || ['failed', 'declined', 'interrupted'].includes(String(metadata[prefix + '/status'])) ? 'failed' : 'completed';
    const base = { id: row.id, runId: row.turn, status, sourceRevision: { generation, sequence: row.seq } } as const;
    let item: NativeItem;
    if (row.kind === 'UserMessage') item = { ...base, kind: 'user', text: displayText ?? descriptors.text?.preview ?? '', ...(typeof metadata[prefix + '/client_id'] === 'string' ? { operationId: metadata[prefix + '/client_id'] as string } : {}) };
    else if (row.kind === 'AgentMessage') item = { ...base, kind: 'assistant', text: displayText ?? descriptors.text?.preview ?? '' };
    else if (row.kind === 'Reasoning' || row.kind === 'Plan') item = { ...base, kind: 'notice', text: descriptors.text?.preview ?? (row.kind === 'Reasoning' ? '思考' : '更新计划') };
    else if (row.kind === 'FileChange') item = { ...base, kind: 'tool', text: descriptors.text?.preview ?? '修改工作区文件', tool: { name: '修改文件', output: descriptors.output?.preview }, ...(status === 'completed' && metadata[prefix + '/status'] === 'completed' && paths.size ? { fileEdits: [...paths], ...(fileEditsLimited ? { fileEditsLimited: true } : {}) } : {}) };
    else if (row.kind === 'ImageGeneration') {
      const savedPath = metadata[prefix + '/savedPath'] ?? metadata[prefix + '/saved_path'];
      item = { ...base, kind: 'assistant', text: '', ...(typeof savedPath === 'string' ? { imageSources: [{ path: savedPath }] } : {}) };
    }
    else if (['McpToolCall', 'DynamicToolCall'].includes(row.kind)) item = { ...base, kind: 'tool', text: descriptors.text?.preview ?? '', tool: { name: String(metadata[prefix + '/tool'] ?? metadata[prefix + '/name'] ?? '调用工具').slice(0, 200), output: descriptors.text?.preview } };
    else if (row.kind === 'CommandExecution' || row.kind === 'PendingCall' || row.kind === 'GenericToolResult') {
      const called = call ? JSON.parse(call.metadata) as Record<string, unknown> : metadata;
      item = { ...base, kind: 'tool', text: descriptors.output?.preview ?? '执行工具', tool: { name: row.kind === 'CommandExecution' ? '运行命令' : String(called['/payload/name'] ?? '原生工具').slice(0, 200), input: descriptors.input?.preview, output: descriptors.output?.preview, ...(Number.isSafeInteger(metadata[prefix + '/exit_code']) ? { exitCode: Number(metadata[prefix + '/exit_code']) } : {}) } };
    }
    else item = { ...base, kind: 'notice', text: descriptors.text?.preview ?? `暂不支持的原生条目：${row.kind}` };
    return { item, fields: descriptors };
  } finally { for (const sink of outputs.values()) { await sink.handle.close().catch(() => {}); await rm(sink.path, { force: true }); } }
}
async function project(handle: FileHandle, db: DatabaseSync, row: Row, key: string, state: State, cwd: string) {
  const inline = await inlineText(handle, row, state.generation); if (inline) return inline;
  let projected = db.prepare('SELECT metadata FROM extractions WHERE seq=?').get(row.seq);
  let value = projected ? JSON.parse(String(projected.metadata)) as Projection : undefined;
  if (value) for (const field of Object.keys(value.fields)) { try { await lstat(join(options.cacheRoot, bodyName(key, state.generation, row.seq, field))); } catch { value = undefined; break; } }
  if (!value) {
    const call = row.kind === 'GenericToolResult' ? db.prepare("SELECT * FROM records WHERE id=? AND kind='PendingCall' ORDER BY seq LIMIT 1").get(row.id) as Row | undefined : undefined;
    await quota.ensure((row.bytes + (call?.bytes ?? 0)) * 3 + 64 * 1024); value = await extract(handle, row, key, state.generation, cwd, call); db.prepare('INSERT OR REPLACE INTO extractions VALUES(?,?)').run(row.seq, JSON.stringify(value));
  }
  const sources: Partial<Record<'text' | 'input' | 'output', NativeBodySource>> = {};
  let imageSource: NativeItem['imageSources'];
  quota.requireLeases(Object.keys(value.fields).length);
  for (const [field, descriptor] of Object.entries(value.fields) as [BodyField, Descriptor][]) {
    const file = bodyName(key, state.generation, row.seq, field), lease = quota.lease(key, file, descriptor);
    const token = encodeRolloutToken('cb1.', { v: 1, key, generation: state.generation, seq: row.seq, field, lease, version: descriptor.version, bytes: descriptor.bytes });
    if (field === 'image') imageSource = [{ path: 'codex-image:' + token, releaseToken: token }];
    else sources[field] = { version: descriptor.version, bytes: descriptor.bytes, token };
  }
  if (['CommandExecution', 'GenericToolResult'].includes(row.kind) && sources.output) sources.text = sources.output;
  if (['McpToolCall', 'DynamicToolCall'].includes(row.kind) && sources.text) sources.output = sources.text;
  return { ...value.item, ...(Object.keys(sources).length ? { bodySources: sources } : {}), ...(imageSource ? { imageSources: imageSource } : {}) };
}
async function withSource<T>(binding: RolloutBinding, action: (handle: FileHandle, db: DatabaseSync, key: string, state: State) => Promise<T>, expectedGeneration?: string) {
  const key = rolloutKey(binding); quota.protect(key); const handle = await source(binding); let db: DatabaseSync | undefined;
  try {
    if (expectedGeneration) { const stat = await handle.stat({ bigint: true }), head = await header(handle, binding, Number(stat.size)); if (uuid(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}` + head.sha) !== expectedGeneration) fail('history_cursor_invalid'); }
    db = await database(key); const state = await scan(handle, db, binding); return await action(handle, db, key, state);
  }
  finally { db?.close(); await handle.close(); }
}
const pageArgs = z.object({ binding: rolloutBinding, cursor: rolloutCursor.optional(), limit: count.min(1).max(100) });
function releaseItems(items: NativeItem[]) {
  for (const item of items) {
    const tokens = new Set([...Object.values(item.bodySources ?? {}).map(source => source.token), ...(item.imageSources ?? []).flatMap(source => source.releaseToken ? [source.releaseToken] : [])]);
    for (const token of tokens) { const body = rolloutBody.parse(JSON.parse(Buffer.from(token.slice(4), 'base64url').toString())); quota.release(body.lease); }
  }
}
async function history(raw: unknown): Promise<HistoryPage> {
  const args = pageArgs.parse(raw);
  return withSource(args.binding, async (handle, db, key, state) => {
    if (args.cursor && (args.cursor.key !== key || args.cursor.generation !== state.generation || args.cursor.through > state.seq)) fail('history_cursor_invalid');
    const through = args.cursor?.through ?? state.seq, before = args.cursor?.before ?? state.seq + 1;
    const rows = db.prepare(`SELECT r.*,a.first_seq FROM anchors a JOIN records r ON r.seq=(SELECT MAX(x.seq) FROM records x WHERE x.id=a.id AND x.seq<=?) WHERE a.first_seq<? ORDER BY a.first_seq DESC LIMIT ?`).all(through, before, Math.min(args.limit, 16) + 1) as Row[];
    const items: NativeItem[] = []; let consumed = 0, previewBytes = 0;
    try {
      for (const row of rows.slice(0, Math.min(args.limit, 16))) {
        try {
          const item = await project(handle, db, row, key, state, args.binding.cwd), bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
          if (previewBytes + bytes > 256 * 1024) { releaseItems([item]); if (!consumed) fail('codex_bounded_page_capacity'); break; }
          items.push(item); consumed++; previewBytes += bytes;
        } catch (error) { if (consumed && error instanceof Error && error.message.includes('cache_')) break; throw error; }
      }
      return { items: items.reverse(), olderCursor: rows.length > consumed ? encodeRolloutToken('cr1.', { v: 1, key, generation: state.generation, through, before: rows[consumed - 1]!.first_seq }) : null };
    } catch (error) { releaseItems(items); throw error; }
  });
}
async function dispatch(method: string, args: unknown): Promise<unknown> {
  if (method === 'history') return history(args);
  if (method === 'changes') {
    const parsed = z.object({ binding: rolloutBinding, cursor: rolloutChangesCursor.optional(), limit: count.min(1).max(16) }).parse(args);
    return withSource(parsed.binding, async (_handle, db, key, state) => {
      const cursor = parsed.cursor;
      if (cursor && (cursor.key !== key || cursor.generation !== state.generation || cursor.through > state.seq)) fail('history_cursor_invalid');
      const through = cursor && cursor.after < cursor.through ? cursor.through : state.seq, after = cursor?.after ?? 0;
      const rows = db.prepare('SELECT id,seq FROM records WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?').all(after, through, parsed.limit);
      const last = rows.length ? Number(rows.at(-1)!.seq) : through;
      const hasMore = !!db.prepare('SELECT 1 FROM records WHERE seq>? AND seq<=? LIMIT 1').get(last, through);
      return { itemIds: [...new Set(rows.map(row => String(row.id)))], cursor: encodeRolloutToken('cc1.', { v: 1, key, generation: state.generation, through, after: hasMore ? last : through }), hasMore };
    }, parsed.cursor?.generation);
  }
  if (method === 'items') {
    const parsed = z.object({ binding: rolloutBinding, ids: z.array(id).max(16) }).parse(args);
    return withSource(parsed.binding, async (handle, db, key, state) => {
      const items: NativeItem[] = [];
      try {
        for (const itemId of new Set(parsed.ids)) { const row = db.prepare('SELECT r.*,a.first_seq FROM records r JOIN anchors a ON r.id=a.id WHERE r.id=? ORDER BY r.seq DESC LIMIT 1').get(itemId) as Row | undefined; if (row) items.push(await project(handle, db, row, key, state, parsed.binding.cwd)); }
        return items;
      } catch (error) { releaseItems(items); throw error; }
    });
  }
  if (method === 'reconcile') {
    const parsed = z.object({ binding: rolloutBinding, operationId: id }).parse(args);
    return withSource(parsed.binding, async (_handle, db) => {
      const rows = db.prepare('SELECT DISTINCT id,turn FROM records WHERE client=? LIMIT 2').all(parsed.operationId);
      return rows.length === 1 ? { outcome: 'accepted', runId: rows[0]!.turn } : { outcome: 'unknown', reason: rows.length ? 'codex_operation_ambiguous' : 'codex_receipt_not_found' };
    });
  }
  if (method === 'release') {
    const body = rolloutBody.parse(args);
    const fileName = bodyName(body.key, body.generation, body.seq, body.field);
    const released = quota.release(body.lease, body.key, fileName);
    if (released?.unleased) {
      await rm(join(options.cacheRoot, released.file), { force: true });
      const path = join(options.cacheRoot, `v2-${body.key}.sqlite`);
      try { await lstat(path); const db = await database(body.key); try { db.prepare('DELETE FROM extractions WHERE seq=?').run(body.seq); } finally { db.close(); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return;
  }
  if (method === 'body') {
    const { body, offset, maxBytes } = z.object({ body: rolloutBody, offset: count, maxBytes: count.min(1).max(64 * 1024) }).parse(args);
    const name = bodyName(body.key, body.generation, body.seq, body.field), descriptor = quota.renew(body.lease, body.key, name);
    if (descriptor.version !== body.version || descriptor.bytes !== body.bytes || offset > body.bytes) fail('codex_body_invalid');
    const handle = await file(join(options.cacheRoot, name));
    try { if ((await handle.stat()).size !== body.bytes) fail('codex_body_invalid'); const data = await read(handle, offset, Math.min(maxBytes, body.bytes - offset)); return { version: body.version, bytes: body.bytes, offset, data, nextOffset: offset + data.length < body.bytes ? offset + data.length : null }; }
    finally { await handle.close(); }
  }
  fail('codex_bounded_method_invalid');
}
let chain = Promise.resolve();
parentPort!.on('message', (message: { id: number; method: string; args: unknown }) => {
  chain = chain.then(async () => {
    let result: unknown, error: string | undefined, cache: unknown;
    try { await roots(); quota = await BoundedCache.lock(options.cacheRoot, options.maxCacheBytes); try { result = await dispatch(message.method, message.args); await quota.ensure(); cache = quota.status(); } finally { quota.close(); } }
    catch (cause) { const code = cause instanceof Error ? cause.message : ''; error = /^(?:codex_bounded_|history_|codex_body_)[a-z_]+$/.test(code) ? code : code.startsWith('dsh_bounded_') ? code.replace('dsh_bounded_', 'codex_bounded_') : (cause as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'history_source_missing' : 'codex_bounded_invalid_data'; }
    parentPort!.postMessage({ id: message.id, ...(error ? { error } : { result }), ...(cache ? { cache } : {}) });
  }).catch(() => { parentPort!.postMessage({ id: message.id, error: 'codex_bounded_read_failed' }); });
});

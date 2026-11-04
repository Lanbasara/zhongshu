/** Synthetic physical logs for the shared HTTP performance fixture. Only native
 * read methods are exported: callers must label execution/state as synthetic.
 * Private operator-owned roots, no credentials, no product history insertion.
 * A root has one fixture writer; stop it before opening another writer process.
 */
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { createCodexAdapter } from '../../src/harness/codex/index.ts';
import { createDshAdapter } from '../../src/harness/dsh/index.ts';
import { modelId } from '../../src/harness/dsh/native.ts';
import type { Binding, HarnessAdapter } from '../../src/harness/types.ts';

const schema = z.object({ root: z.string().refine(isAbsolute), cwd: z.string().refine(isAbsolute), harness: z.enum(['codex', 'dsh']), bindingId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), count: z.number().int().min(0).max(1_000_000).default(20000) }).strict();
const stateSchema = z.object({ format: z.literal(1), harness: z.enum(['codex', 'dsh']), bindingId: z.string(), cwd: z.string(), count: z.number().int().nonnegative().max(1_000_000), sourceBytes: z.number().int().nonnegative().safe(), manifestBytes: z.number().int().nonnegative().safe() }).strict();
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function nativeArchiveText(n: number): string {
  const title = `NATIVE_ARCHIVE ${n.toString().padStart(6, '0')} 中文🌱\n`;
  return title + (n % 5000 === 4999 ? '大正文🙂\n'.repeat(90_000) : n % 997 === 996 ? '长代码行中文'.repeat(3000) : `exact-${n}-` + 'x'.repeat(80));
}

export async function createPhysicalArchiveFixture(input: z.input<typeof schema>) {
  const options = schema.parse(input);
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const root = await realpath(options.root), cwd = await realpath(options.cwd), info = await lstat(options.root);
  if (root !== resolve(options.root) || !info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error('unsafe_physical_fixture_root');
  const nativeRoot = join(root, 'native'), cacheRoot = join(root, 'cache'), statePath = join(root, 'state.json'), manifestPath = join(root, 'expected.ndjson');
  let encoded = '', separator = false;
  for (let n = 0; n < cwd.length; n++) { const character = cwd[n]!; if ('/\\:'.includes(character)) { if (!separator) encoded += '-'; separator = true; } else { encoded += /^[A-Za-z0-9._-]$/.test(character) ? character : `~${cwd.charCodeAt(n).toString(16).toUpperCase().padStart(4, '0')}`; separator = false; } }
  const project = `--${(encoded.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
  const source = options.harness === 'codex' ? join(nativeRoot, 'sessions', '2026', 'rollout-synthetic.jsonl') : join(nativeRoot, project, options.bindingId, 'session.v4.jsonl');
  let parent = root;
  for (const component of relative(root, resolve(source, '..')).split(sep)) {
    parent = join(parent, component); await mkdir(parent, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const stat = await lstat(parent); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('unsafe_physical_fixture_directory');
  }
  async function privateFile(path: string) { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('unsafe_physical_fixture_file'); return stat; }
  let state: z.infer<typeof stateSchema>;
  try {
    const stat = await privateFile(statePath); if (stat.size > 4096) throw new Error('invalid_physical_fixture_state');
    state = stateSchema.parse(JSON.parse(await readFile(statePath, 'utf8')));
    if (state.harness !== options.harness || state.bindingId !== options.bindingId || state.cwd !== cwd || (await privateFile(source)).size !== state.sourceBytes || (await privateFile(manifestPath)).size !== state.manifestBytes) throw new Error('physical_fixture_identity_changed');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const header = options.harness === 'codex' ? { ordinal: 0, type: 'session_meta', payload: { id: options.bindingId, cwd, cli_version: '0.166.0-alpha.5.1', history_mode: 'paginated' } }
      : { type: 'session', version: 4, id: options.bindingId, cwd, createdAt: 0, isSeeded: false, delegationDepth: 0 };
    const initial = JSON.stringify(header) + '\n' + (options.harness === 'dsh' ? JSON.stringify({ seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } }) + '\n' : '');
    await writeFile(source, initial, { flag: 'wx', mode: 0o600 }); await writeFile(manifestPath, '', { flag: 'wx', mode: 0o600 });
    state = { format: 1, harness: options.harness, bindingId: options.bindingId, cwd, count: 0, sourceBytes: Buffer.byteLength(initial), manifestBytes: 0 };
    await writeFile(statePath, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  }
  const itemId = (n: number) => options.harness === 'codex' ? `message-${n}` : `dsh:${options.bindingId}:assistant:1:${n + 1}`;
  let writing = false, closed = false, writeDone: Promise<void> | undefined;
  async function appendGap(count: number) {
    z.number().int().min(1).max(100_000).parse(count);
    if (closed || writing || state.count + count > 1_000_000) throw new Error('physical_fixture_write_unavailable');
    writing = true;
    let complete!: () => void; writeDone = new Promise<void>(resolve => { complete = resolve; });
    let log, expected;
    try {
      if ((await privateFile(source)).size !== state.sourceBytes || (await privateFile(manifestPath)).size !== state.manifestBytes) throw new Error('physical_fixture_source_changed');
      log = await open(source, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW); expected = await open(manifestPath, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
      for (let n = state.count; n < state.count + count; n++) {
        const text = nativeArchiveText(n), id = itemId(n);
        const event = options.harness === 'codex' ? { ordinal: n + 1, type: 'event_msg', payload: { type: 'item_completed', thread_id: options.bindingId, turn_id: 'run-1', item: { type: 'AgentMessage', id, content: [{ type: 'Text', text }] } } }
          : { seq: n + 1, time: n + 1, type: 'assistant/message', data: { turn: 1, step: n + 1, message: { content: [{ type: 'text', text }] } } };
        await log.writeFile(JSON.stringify(event) + '\n'); await expected.writeFile(JSON.stringify([id, sha256(text), Buffer.byteLength(text)]) + '\n');
      }
      await log.sync(); await expected.sync(); state = { ...state, count: state.count + count, sourceBytes: (await log.stat()).size, manifestBytes: (await expected.stat()).size };
      const temporary = statePath + '.next'; await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); await rename(temporary, statePath);
      return { count: state.count, lastId: itemId(state.count - 1) };
    } finally { try { await log?.close(); await expected?.close(); } finally { writing = false; complete(); writeDone = undefined; } }
  }
  while (state.count < options.count) await appendGap(Math.min(100_000, options.count - state.count));
  const socketRoot = await mkdtemp(join(tmpdir(), 'zh-native-peer-')), socketPath = join(socketRoot, 'metadata.sock');
  const http = createServer(), ws = new WebSocketServer({ server: http, maxPayload: 64 * 1024 }); const methods = new Map<string, number>();
  ws.on('connection', socket => socket.on('message', bytes => {
    let raw: unknown; try { raw = JSON.parse(bytes.toString()); } catch { socket.close(); return; }
    const request = z.object({ id: z.number().optional(), method: z.string(), params: z.object({ threadId: z.string().optional() }).passthrough().optional() }).safeParse(raw);
    if (!request.success || request.data.id === undefined) return;
    const value = request.data; methods.set(value.method, (methods.get(value.method) ?? 0) + 1);
    if (value.method === 'initialize') socket.send(JSON.stringify({ id: value.id, result: { codexHome: nativeRoot } }));
    else if (value.method === 'thread/read' && value.params?.threadId === options.bindingId) socket.send(JSON.stringify({ id: value.id, result: { thread: { id: options.bindingId, cwd, path: source, cliVersion: '0.166.0-alpha.5.1', status: { type: 'notLoaded' } } } }));
    else socket.send(JSON.stringify({ id: value.id, error: { code: -32601, message: 'Physical fixture metadata is read-only.' } }));
  }));
  await new Promise<void>(done => http.listen(socketPath, done));
  const adapter = options.harness === 'codex' ? createCodexAdapter({ socketPath, boundedHistory: { nativeRoot, cacheRoot }, managedExecution: true })
    : createDshAdapter({ launchFile: join(root, 'absent-launch'), boundedHistory: { nativeRoot, cacheRoot }, managedExecution: true });
  const binding: Binding = { id: options.bindingId, cwd, configuration: options.harness === 'codex' ? { modelId: 'synthetic', permissionId: ':read-only' } : { modelId: modelId({ provider: 'synthetic', model: 'synthetic' }), permissionId: 'read-only' }, details: options.harness === 'codex' ? { version: 1, approvalPolicy: 'never' } : {} };
  const check = (binding: Binding) => { if (binding.id !== options.bindingId || binding.cwd !== cwd) throw new Error('physical_fixture_binding_mismatch'); };
  const reads: Pick<HarnessAdapter, 'history' | 'readItems' | 'readBodyChunk' | 'releaseBodySource' | 'readImage'> = {
    history: (binding, ...args) => { check(binding); return adapter.history(binding, ...args); },
    readItems: (binding, ...args) => { check(binding); return adapter.readItems!(binding, ...args); },
    readBodyChunk: (binding, ...args) => { check(binding); return adapter.readBodyChunk!(binding, ...args); },
    releaseBodySource: (binding, ...args) => { check(binding); return adapter.releaseBodySource!(binding, ...args); },
    readImage: (binding, ...args) => { check(binding); return adapter.readImage!(binding, ...args); },
  };
  return { reads, binding, appendGap,
    async manifest() { await writeDone; const snapshot = { ...state }, digest = createHash('sha256'); if (snapshot.manifestBytes) for await (const chunk of createReadStream(manifestPath, { start: 0, end: snapshot.manifestBytes - 1 })) digest.update(chunk); return { mode: 'synthetic-native-format-real-physical-reader', harness: options.harness, count: snapshot.count, firstId: snapshot.count ? itemId(0) : null, lastId: snapshot.count ? itemId(snapshot.count - 1) : null, manifestPath, manifestSha256: digest.digest('hex'), sourceBytes: snapshot.sourceBytes, methods: Object.fromEntries(methods) }; },
    async close() { if (closed) return; closed = true; await writeDone; await adapter.close(); for (const socket of ws.clients) socket.terminate(); await new Promise<void>(done => ws.close(() => done())); await new Promise<void>(done => http.close(() => done())); await rm(socketRoot, { recursive: true, force: true }); },
  };
}

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { deserialize } from 'node:v8';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import type { Binding, HarnessAdapter, NativeChange } from '../harness/types.ts';
import { encodeStorageValue } from './storage-client.ts';
import { ExecutionHostError } from './execution-host-docker.ts';
import type { NativeInvocation } from './execution-host.ts';
import { pluginCommand, pluginKey, pluginSourceCommand } from '../shared/plugins.ts';
import { PluginSourceError, type PluginBackend } from './plugin-backend.ts';

const methods = ['catalog', 'skills', 'create', 'state', 'history', 'submit', 'submitQueued', 'wakeQueued', 'readImage', 'readBodyChunk', 'releaseBodySource', 'readItems', 'reconcile', 'stop', 'watch', 'pluginCatalog', 'pluginDetail', 'pluginSources', 'pluginChange', 'pluginRecover', 'pluginSource', 'pluginRecoverSource'] as const;
export type ManagedNativeMethod = typeof methods[number];
const readonlyMethods = new Set<ManagedNativeMethod>(['catalog', 'history', 'readImage', 'readBodyChunk', 'releaseBodySource', 'readItems', 'pluginCatalog', 'pluginDetail', 'pluginSources', 'pluginRecover', 'pluginRecoverSource']);
const optionsSchema = z.object({ socketPath: z.string().min(1).max(100).refine(isAbsolute), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), timeoutMs: z.number().int().min(100).max(120_000).default(30_000) }).strict();
const MAX_BYTES = 12 * 1024 * 1024;
const requestSchema = z.object({ type: z.literal('call'), id: z.number().int().positive().safe(), method: z.enum(methods), args: z.array(z.unknown()).max(4) }).strict();
const controlSchema = z.object({ type: z.enum(['bound-ack', 'unwatch']), id: z.number().int().positive().safe(), accepted: z.boolean().optional() }).strict();
const responseSchema = z.object({ type: z.enum(['result', 'error', 'bound', 'invalidate']), id: z.number().int().positive().safe(), value: z.unknown().optional() }).strict();
const capabilitySchema = z.object({ id: z.enum(['codex', 'dsh']), methods: z.array(z.enum(methods)).max(methods.length), earlyInput: z.enum(['current', 'soon']).optional() }).strict();
function decode(data: RawData): unknown {
  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes.length > MAX_BYTES) throw new Error('native_rpc_frame_limit');
  const value: unknown = deserialize(bytes); encodeStorageValue(value, MAX_BYTES); return value;
}
function send(socket: WebSocket, value: unknown): void {
  const data = encodeStorageValue(value, MAX_BYTES);
  if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount + data.length > 2 * MAX_BYTES) throw new ExecutionHostError('managed_native_backpressure', 503);
  socket.send(data);
}

/** Runs INSIDE the dedicated Host container. The socket directory and bearer are
 * operator-private runtime mounts, never workspaces or browser-facing ports.
 * Only the outer execution gateway receives this endpoint; other clients use
 * its opaque business-ID API. Native state/watch/reconcile can activate work and
 * are deliberately absent from the outer client's read() allowlist.
 */
export async function serveManagedHarness(adapter: HarnessAdapter, input: z.input<typeof optionsSchema>, plugins?: PluginBackend) {
  const options = optionsSchema.parse(input);
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(options.socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || process.getuid && directory.uid !== process.getuid()) throw new ExecutionHostError('managed_native_socket_unsafe');
  // Container restart is the only supported server restart; the old process tree
  // has already exited. Never replace a regular file or another user's socket.
  try { const old = await lstat(options.socketPath); if (!old.isSocket() || process.getuid && old.uid !== process.getuid()) throw new ExecutionHostError('managed_native_socket_unsafe'); await unlink(options.socketPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const ws = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES, perMessageDeflate: false });
  const clients = new Set<WebSocket>();
  let pluginBusy = false;
  const capability = { id: adapter.id, methods: methods.filter(method => method.startsWith('plugin') ? !!plugins : typeof adapter[method as keyof HarnessAdapter] === 'function'), ...(adapter.earlyInput ? { earlyInput: adapter.earlyInput } : {}) };
  server.on('upgrade', (request, socket, head) => {
    const supplied = request.headers.authorization;
    const expected = 'Bearer ' + options.token;
    if (request.url !== '/native' || typeof supplied !== 'string' || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) || clients.size >= 4) { socket.destroy(); return; }
    ws.handleUpgrade(request, socket, head, connected => ws.emit('connection', connected, request));
  });
  ws.on('connection', socket => {
    clients.add(socket); let active = 0; let lastId = 0;
    const watches = new Map<number, () => void>();
    const bound = new Map<number, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    socket.once('close', () => { clients.delete(socket); for (const stop of watches.values()) stop(); watches.clear(); for (const wait of bound.values()) { clearTimeout(wait.timer); wait.reject(new Error('native_binding_ack_unknown')); } bound.clear(); });
    socket.on('error', () => socket.terminate());
    socket.on('message', data => {
      let value: unknown;
      try { value = decode(data); } catch { socket.terminate(); return; }
      const control = controlSchema.safeParse(value);
      if (control.success) {
        if (control.data.type === 'unwatch') { watches.get(control.data.id)?.(); watches.delete(control.data.id); return; }
        const waiter = bound.get(control.data.id); if (!waiter) { socket.terminate(); return; }
        clearTimeout(waiter.timer); bound.delete(control.data.id); if (control.data.accepted) waiter.resolve(); else waiter.reject(new Error('native_binding_not_persisted')); return;
      }
      const parsed = requestSchema.safeParse(value);
      if (!parsed.success || parsed.data.id <= lastId || active >= 16) { socket.terminate(); return; }
      const command = parsed.data; lastId = command.id; active++;
      void (async () => {
        try {
          let result: unknown;
          if (command.method === 'catalog' && command.args.length === 1 && command.args[0] === 'capabilities') result = capability;
          else if (command.method.startsWith('plugin')) {
            if (!plugins) throw new Error('native_plugin_unavailable');
            if (command.method === 'pluginCatalog') {
              const catalog = plugins.catalog ? await plugins.catalog() : { entries: await plugins.list(), sources: await plugins.sources?.() ?? [] };
              result = { entries: catalog.entries, sources: catalog.sources };
            }
            else if (command.method === 'pluginDetail') result = await plugins.detail?.(pluginKey.parse(command.args[0])) ?? null;
            else if (command.method === 'pluginSources') result = await plugins.sources?.() ?? [];
            else if (command.method === 'pluginRecover') result = pluginBusy ? 'unknown' : await plugins.recover(pluginCommand.parse(command.args[0]));
            else if (command.method === 'pluginRecoverSource') result = pluginBusy ? 'unknown' : await plugins.recoverSource?.(pluginSourceCommand.parse(command.args[0]), z.uuid().parse(command.args[1])) ?? 'unknown';
            else {
              if (pluginBusy) throw new Error('native_plugin_busy');
              pluginBusy = true;
              try {
                if (command.method === 'pluginChange') result = await plugins.change(pluginCommand.parse(command.args[0]));
                else {
                  if (!plugins.updateSource) throw new Error('native_plugin_source_unavailable');
                  try { await plugins.updateSource(pluginSourceCommand.parse(command.args[0]), z.uuid().parse(command.args[1])); result = { status: 'applied' }; }
                  catch (error) { if (error instanceof PluginSourceError) result = { status: 'failed', error: error.code }; else throw error; }
                }
              } finally { pluginBusy = false; }
            }
          }
          else if (command.method === 'create') {
            if (command.args.length !== 1) throw new Error('native_arguments_invalid');
            result = await adapter.create(command.args[0] as Parameters<HarnessAdapter['create']>[0], async binding => {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => { bound.delete(command.id); reject(new Error('native_binding_ack_timeout')); }, options.timeoutMs);
                bound.set(command.id, { resolve, reject, timer });
                try { send(socket, { type: 'bound', id: command.id, value: binding }); } catch (error) { clearTimeout(timer); bound.delete(command.id); reject(error); }
              });
            });
          } else if (command.method === 'watch') {
            if (command.args.length !== 1 || watches.size >= 16) throw new Error('native_watch_limit');
            const stop = await adapter.watch(command.args[0] as Binding, () => {
              try { send(socket, { type: 'invalidate', id: command.id }); } catch { socket.terminate(); }
            });
            if (socket.readyState !== WebSocket.OPEN) stop(); else watches.set(command.id, stop);
            result = { watching: true };
          } else {
            const method = adapter[command.method as keyof HarnessAdapter];
            if (typeof method !== 'function') throw new Error('native_method_unavailable');
            result = await Reflect.apply(method, adapter, command.args);
          }
          send(socket, { type: 'result', id: command.id, value: result });
        } catch { try { send(socket, { type: 'error', id: command.id }); } catch { socket.terminate(); } }
        finally { active--; }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.socketPath, () => { server.off('error', reject); resolve(); }); });
  await chmod(options.socketPath, 0o600);
  return { async close() { for (const socket of clients) socket.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await adapter.close(); await unlink(options.socketPath).catch(() => {}); } };
}

export class ManagedHarnessRpc {
  private readonly options: z.output<typeof optionsSchema>;
  private socket?: WebSocket;
  private opening?: Promise<void>;
  private sequence = 0;
  private closed = false;
  private capability?: z.infer<typeof capabilitySchema>;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; bound?: (binding: Binding) => Promise<void> }>();
  private readonly watches = new Map<string, { id: number; listener: (change: NativeChange) => void }>();
  constructor(options: z.input<typeof optionsSchema>) { this.options = optionsSchema.parse(options); }
  private async connect() {
    if (this.closed) throw new ExecutionHostError('managed_native_closed', 503);
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return await this.opening;
    this.opening = (async () => {
      const info = await lstat(this.options.socketPath);
      if (!info.isSocket() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new ExecutionHostError('managed_native_socket_unsafe');
      const socket = new WebSocket('ws+unix://' + this.options.socketPath + ':/native', { headers: { authorization: 'Bearer ' + this.options.token }, maxPayload: MAX_BYTES, perMessageDeflate: false, handshakeTimeout: this.options.timeoutMs });
      this.socket = socket;
      socket.on('message', data => {
        try {
          const message = responseSchema.parse(decode(data)); const pending = this.pending.get(message.id);
          if (message.type === 'invalidate') { for (const watch of this.watches.values()) if (watch.id === message.id) watch.listener({ type: 'invalidate' }); return; }
          if (!pending) throw new Error('native_unexpected_receipt');
          if (message.type === 'bound') {
            if (!pending.bound) throw new Error('native_unexpected_binding');
            void pending.bound(message.value as Binding).then(() => send(socket, { type: 'bound-ack', id: message.id, accepted: true }), () => send(socket, { type: 'bound-ack', id: message.id, accepted: false })).catch(() => socket.terminate()); return;
          }
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.type === 'error') pending.reject(new ExecutionHostError('managed_native_result_unknown', 503)); else pending.resolve(message.value);
        } catch { socket.terminate(); }
      });
      socket.once('close', () => {
        if (this.socket !== socket) return; this.socket = undefined; this.capability = undefined;
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new ExecutionHostError('managed_native_result_unknown', 503)); } this.pending.clear();
        for (const watch of this.watches.values()) watch.listener({ type: 'unavailable', reason: 'managed_native_disconnected' }); this.watches.clear();
      });
      socket.on('error', () => socket.terminate());
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', () => reject(new ExecutionHostError('managed_native_unavailable', 503))); socket.once('close', () => reject(new ExecutionHostError('managed_native_unavailable', 503))); });
    })();
    try { await this.opening; } finally { this.opening = undefined; }
  }
  private async call(method: ManagedNativeMethod, args: unknown[], bound?: (binding: Binding) => Promise<void>, watch?: { requestId: string; listener: (change: NativeChange) => void }) {
    if (this.pending.size >= 32) throw new ExecutionHostError('managed_native_busy', 429);
    await this.connect();
    if (this.pending.size >= 32) throw new ExecutionHostError('managed_native_busy', 429);
    const id = ++this.sequence; const socket = this.socket!;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ExecutionHostError('managed_native_result_unknown', 503)); socket.terminate(); }, method === 'pluginChange' || method === 'pluginSource' ? Math.max(this.options.timeoutMs, 180_000) : this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, bound });
      if (watch) this.watches.set(watch.requestId, { id, listener: watch.listener });
      try { send(socket, { type: 'call', id, method, args }); } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  async ready() {
    this.capability = capabilitySchema.parse(await this.call('catalog', ['capabilities']));
    const catalog = await this.call('catalog', []) as { available?: unknown };
    if (catalog?.available !== true) throw new ExecutionHostError('managed_native_unavailable', 503);
  }
  async capabilities() { if (!this.capability) await this.ready(); return this.capability!; }
  async read(method: ManagedNativeMethod, args: unknown[]) { if (!readonlyMethods.has(method)) throw new ExecutionHostError('managed_native_activation_requires_permission'); return await this.call(method, args); }
  async invoke(invocation: NativeInvocation, onBound: (binding: Binding) => Promise<void>, listener?: (change: NativeChange) => void) {
    return await this.call(invocation.method, invocation.args, onBound, invocation.method === 'watch' && listener ? { requestId: invocation.requestId, listener } : undefined);
  }
  releaseWatch(requestId: string) { const watch = this.watches.get(requestId); this.watches.delete(requestId); if (watch && this.socket?.readyState === WebSocket.OPEN) send(this.socket, { type: 'unwatch', id: watch.id }); }
  async close() { this.closed = true; this.socket?.terminate(); }
}

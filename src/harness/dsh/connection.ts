import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, basename } from 'node:path';
import WebSocket from 'ws';
import { z } from 'zod';
import { HarnessError } from '../types.ts';

// The operator owns the launch file. The browser never supplies a URL or sees its token.
// Plain HTTP is allowed only for the native Host's loopback transport, never a remote origin.
// Long sessions send whole snapshot projections (turn outline) and uncounted tool events per page.
const MAX_BODY = 32 * 1024 * 1024;
const code = z.string().regex(/^[a-zA-Z0-9_/-]{1,120}$/);
const responseSchema = z.object({ type: z.literal('server-response'), rpcId: z.string(), result: z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown().optional() }), z.object({ ok: z.literal(false), error: z.object({ code }) })]) });
const frameSchema = z.object({ type: z.enum(['item', 'error', 'end']), streamId: z.string().max(200), value: z.unknown().optional(), error: z.object({ code }).optional() });
export class NativeRejection extends HarnessError {}
type Stream = { item: (value: unknown) => void; failed: (error: HarnessError) => void };
/** A request the Host forwards to answering clients (ADR 0016). `agentId` is the asking session. */
export type Interaction = { eventId: string; event: string; agentId: string; request: unknown };
/** Receives forwarded interactions. `reset` means every forwarded request of the old connection is void; the Host replays open ones. */
export type InteractionSink = { request(interaction: Interaction): void; cancel(eventId: string): void; reset(): void;
  /** A forwarded one-way Host event such as payload-free `schedule/changed` (ADR 0021); also called with `reset` semantics after reconnect. */
  emit?(event: string): void };
const eventItem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), clientId: z.string().min(1).max(200) }).passthrough(),
  z.object({ type: z.literal('waterfall'), event: z.string().max(120), eventId: z.string().min(1).max(200), agentId: z.string().min(1).max(240), request: z.unknown() }).passthrough(),
  z.object({ type: z.literal('cancel'), eventId: z.string().min(1).max(200) }).passthrough(),
  z.object({ type: z.literal('emit'), event: z.string().max(120).optional(), name: z.string().max(120).optional() }).passthrough(),
]);

export async function readLaunchFile(path: string): Promise<URL> {
  try {
    if (!isAbsolute(path)) throw new Error();
    const parent = await realpath(dirname(path));
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || (parentStat.mode & 0o022) !== 0) throw new Error();
    const handle = await open(join(parent, basename(path)), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const file = await handle.stat();
      if (!file.isFile() || (file.mode & 0o077) !== 0 || (process.getuid && file.uid !== process.getuid()) || file.size < 1 || file.size > 4096) throw new Error();
      const buffer = Buffer.alloc(4097); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4096) throw new Error();
      const value = new URL(buffer.subarray(0, bytesRead).toString('utf8').trim());
      if (!['http:', 'https:'].includes(value.protocol) || !['127.0.0.1', '[::1]'].includes(value.hostname) || value.username || value.password || value.hash || value.pathname !== '/' || !value.port) throw new Error();
      const entries = [...value.searchParams.entries()];
      if (entries.length !== 1 || entries[0]?.[0] !== 'token' || !/^[A-Za-z0-9._~%-]{16,2048}$/.test(entries[0]?.[1] ?? '')) throw new Error();
      return value;
    } finally { await handle.close(); }
  } catch { throw new HarnessError('DSH_LAUNCH_FILE_INVALID'); }
}

async function jsonBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new HarnessError('DSH_RESPONSE_INVALID');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > MAX_BODY) { await reader.cancel(); throw new HarnessError('DSH_RESPONSE_TOO_LARGE'); } chunks.push(part.value); }
    const body = Buffer.concat(chunks);
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.startsWith('multipart/form-data;')) {
      const form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
      const metadata = form.get('metadata'); if (typeof metadata !== 'string') throw new HarnessError('DSH_RESPONSE_INVALID');
      const value = z.object({ result: z.object({ ok: z.literal(true), value: z.object({ data: z.null(), absolutePath: z.string().max(4096) }).passthrough() }), attachments: z.array(z.object({ path: z.tuple([z.literal('data')]), codec: z.literal('bytes'), part: z.string().max(100) })).length(1) }).passthrough().parse(JSON.parse(metadata));
      const part = form.get(value.attachments[0]!.part);
      if (!(part instanceof Blob) || part.size > 6 * 1024 * 1024) throw new HarnessError('DSH_RESPONSE_TOO_LARGE');
      return { ...value, result: { ...value.result, value: { ...value.result.value, data: Buffer.from(await part.arrayBuffer()).toString('base64') } } };
    }
    return JSON.parse(body.toString('utf8')) as unknown;
  } finally { reader.releaseLock(); }
}

export class Connection {
  private readonly launchFile: string;
  private socket: WebSocket | undefined;
  private cookie = '';
  private origin = '';
  private connecting: Promise<void> | undefined;
  private closed = false;
  private streams = new Map<string, Stream>();
  private requests = new Set<AbortController>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastSeen = 0;
  private readonly sink: InteractionSink | undefined;
  /** This client's identity on the current `$events` stream; answers must name it. */
  private clientId: string | undefined;
  constructor(launchFile: string, sink?: InteractionSink) { this.launchFile = launchFile; this.sink = sink; }

  async ready(): Promise<void> {
    if (this.closed) throw new HarnessError('DSH_ADAPTER_CLOSED');
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (!this.connecting) this.connecting = this.connect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    try {
      const launch = await readLaunchFile(this.launchFile);
      if (this.closed) throw new HarnessError('DSH_ADAPTER_CLOSED');
      const url = new URL('/connect', launch.origin); url.search = launch.search; url.searchParams.set('interactions', this.sink ? 'answer' : 'none');
      const reply = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      if (reply.status !== 302) throw new HarnessError('DSH_CONNECT_REJECTED');
      const cookie = reply.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const target = new URL(reply.headers.get('location') ?? '', launch.origin);
      if (!cookie || cookie.length > 8192 || target.host !== launch.host || !['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol) || target.pathname !== '/api/remote.mux' || target.search || target.hash || target.username || target.password) throw new HarnessError('DSH_CONNECT_INVALID');
      target.protocol = launch.protocol === 'https:' ? 'wss:' : 'ws:';
      if (this.closed) throw new HarnessError('DSH_ADAPTER_CLOSED');
      const socket = new WebSocket(target, { headers: { Cookie: cookie }, maxPayload: MAX_BODY, handshakeTimeout: 10000, followRedirects: false });
      this.socket = socket; this.cookie = cookie; this.origin = launch.origin;
      socket.on('error', () => {});
      socket.on('ping', () => { this.lastSeen = Date.now(); });
      socket.on('pong', () => { this.lastSeen = Date.now(); });
      socket.on('message', bytes => {
        this.lastSeen = Date.now();
        try {
          const frame = frameSchema.parse(JSON.parse(bytes.toString()));
          const stream = this.streams.get(frame.streamId);
          if (!stream) return;
          if (frame.type === 'item') stream.item(frame.value);
          else { this.streams.delete(frame.streamId); stream.failed(new HarnessError(frame.type === 'error' ? 'DSH_STREAM_REJECTED' : 'DSH_STREAM_ENDED')); }
        } catch { socket.terminate(); }
      });
      socket.on('close', () => { if (this.socket === socket) this.disconnected(); });
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', () => reject(new HarnessError('DSH_UNAVAILABLE'))); socket.once('close', () => reject(new HarnessError('DSH_UNAVAILABLE'))); });
      this.lastSeen = Date.now();
      if (this.sink) this.openEvents(socket);
      this.heartbeat = setInterval(() => { if (Date.now() - this.lastSeen > 15000) socket.terminate(); else if (socket.readyState === WebSocket.OPEN) socket.ping(); }, 5000);
      this.heartbeat.unref();
    } catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError('DSH_UNAVAILABLE'); }
  }

  /** Answering clients receive forwarded requests here; open ones are replayed after `ready` on every new stream. */
  private openEvents(socket: WebSocket): void {
    const streamId = randomUUID();
    this.streams.set(streamId, {
      item: value => {
        const parsed = eventItem.safeParse(value);
        if (!parsed.success || this.socket !== socket) return;
        const item = parsed.data;
        if (item.type === 'ready') { this.clientId = item.clientId; this.sink?.emit?.('$ready'); }
        else if (item.type === 'waterfall') this.sink?.request({ eventId: item.eventId, event: item.event, agentId: item.agentId, request: item.request });
        else if (item.type === 'cancel') this.sink?.cancel(item.eventId);
        else if (item.type === 'emit') { const event = item.event ?? item.name; if (event) this.sink?.emit?.(event); }
      },
      // Without the stream nothing can be answered; other calls keep working and the next connection retries.
      failed: () => { if (this.socket === socket) this.clientId = undefined; },
    });
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }));
  }

  /** Settle one forwarded request. Never send `next`: as the only answering client that would fail the request. */
  async settle(eventId: string, outcome: { kind: 'result'; value: unknown } | { kind: 'rejected'; error: { name: string; message: string; code?: string } }): Promise<void> {
    const clientId = this.clientId;
    if (!clientId || !this.socket) throw new NativeRejection('DSH_NATIVE_interactions_unavailable');
    await this.call('$events/result', { clientId, eventId, outcome });
  }

  private disconnected(): void {
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = undefined;
    this.socket = undefined; this.cookie = ''; this.origin = ''; this.clientId = undefined;
    try { this.sink?.reset(); } catch { /* a sink failure cannot keep a dead connection */ }
    const listeners = [...this.streams.values()]; this.streams.clear();
    for (const listener of listeners) listener.failed(new HarnessError('DSH_DISCONNECTED'));
  }

  async call(endpoint: string, args: Record<string, unknown> = {}, timeout = 15_000): Promise<unknown> {
    await this.ready();
    if (!/^(?:[A-Za-z][A-Za-z0-9]*|\$events)\/[A-Za-z][A-Za-z0-9]*$/.test(endpoint)) throw new HarnessError('DSH_ENDPOINT_INVALID');
    if (this.requests.size >= 32) throw new HarnessError('DSH_REQUEST_LIMIT');
    const controller = new AbortController(); this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const rpcId = randomUUID(); const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } });
      if (Buffer.byteLength(body) > 12 * 1024 * 1024) throw new HarnessError('DSH_REQUEST_TOO_LARGE');
      const response = await fetch(`${this.origin}/api/${endpoint}`, { method: 'POST', headers: { Cookie: this.cookie, 'Content-Type': 'application/json' }, body, redirect: 'manual', signal: controller.signal });
      if (!response.ok) throw new HarnessError('DSH_RPC_UNAVAILABLE');
      const parsed = responseSchema.parse(await jsonBody(response));
      if (parsed.rpcId !== rpcId) throw new HarnessError('DSH_RESPONSE_INVALID');
      if (!parsed.result.ok) throw new NativeRejection(`DSH_NATIVE_${parsed.result.error.code}`);
      return parsed.result.value;
    } catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError('DSH_RPC_UNAVAILABLE'); }
    finally { clearTimeout(timer); this.requests.delete(controller); }
  }

  async follow(args: Record<string, unknown>, stream: Stream): Promise<() => void> {
    await this.ready();
    if (this.streams.size >= 32) throw new HarnessError('DSH_STREAM_LIMIT');
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new HarnessError('DSH_DISCONNECTED');
    const streamId = randomUUID(); this.streams.set(streamId, stream);
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args } }));
    return () => { this.streams.delete(streamId); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId })); };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const request of this.requests) request.abort();
    const socket = this.socket;
    this.disconnected();
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => { const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1000); socket.once('close', () => { clearTimeout(timer); resolve(); }); socket.close(); });
  }
}

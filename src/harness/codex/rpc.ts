import { isAbsolute, normalize } from 'node:path';
import { connect as connectUnixSocket } from 'node:net';
import WebSocket from 'ws';
import { z } from 'zod';
import { HarnessError } from '../types.ts';

const envelope = z.object({
  id: z.union([z.string().max(256), z.number().int()]).optional(),
  method: z.string().max(200).optional(), params: z.unknown().optional(), result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string().max(100_000) }).optional(),
});
// Two native image results can each carry up to 8 MiB of base64.
const MAX_FRAME = 20 * 1024 * 1024;
const MAX_PENDING = 64;

export class RpcError extends HarnessError {
  readonly nativeCode: number | undefined;
  readonly nativeKind: 'missing_rollout' | 'deleted_thread_absent' | undefined;
  constructor(code: string, nativeCode?: number, nativeKind?: 'missing_rollout' | 'deleted_thread_absent') { super(code); this.nativeCode = nativeCode; this.nativeKind = nativeKind; }
}

type Hooks = {
  notification(method: string, params: unknown): void;
  unsupportedRequest(method: string, params: unknown): void;
  disconnected(): void;
};

/** A configured local IPC boundary. No credentials, subprocesses, logs, or native host ownership. */
export class CodexRpc {
  private socketPath: string;
  private hooks: Hooks;
  private socket: WebSocket | undefined;
  private connecting: Promise<void> | undefined;
  private permanentlyClosed = false;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; deleteThreadId?: string }>();
  private heartbeat: NodeJS.Timeout | undefined;
  private awaitingPong = false;
  private home: string | undefined;

  constructor(socketPath: string, hooks: Hooks) {
    const parsed = z.string().min(1).max(4096).refine(path => isAbsolute(path) && normalize(path) === path && !path.includes('\0')).safeParse(socketPath);
    if (!parsed.success) throw new RpcError('codex_socket_invalid');
    this.socketPath = parsed.data;
    this.hooks = hooks;
  }

  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  get codexHome(): string | undefined { return this.home; }

  async connect(): Promise<void> {
    if (this.permanentlyClosed) throw new RpcError('codex_adapter_closed');
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const attempt = this.open();
    this.connecting = attempt;
    try { await attempt; } finally { if (this.connecting === attempt) this.connecting = undefined; }
  }

  private async open(): Promise<void> {
    // The URL is only the HTTP Upgrade target; createConnection always opens the configured Unix socket.
    const ws = new WebSocket('ws://localhost/', {
      createConnection: () => connectUnixSocket({ path: this.socketPath }),
      maxPayload: MAX_FRAME, handshakeTimeout: 10_000, perMessageDeflate: false,
    });
    this.socket = ws;
    let ended = false;
    let established = false;
    const disconnect = () => {
      if (ended) return;
      ended = true;
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.home = undefined;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new RpcError('codex_disconnected')); }
      this.pending.clear();
      // Failed offline attempts are request errors, not new losses of verified
      // observation. Repeated loss signals would fence every state read.
      if (established && !this.permanentlyClosed) this.hooks.disconnected();
      established = false;
    };
    ws.on('close', disconnect);
    ws.on('error', () => { disconnect(); ws.terminate(); });
    ws.on('pong', () => { if (this.socket === ws && !this.permanentlyClosed) this.awaitingPong = false; });
    ws.on('message', (bytes, binary) => {
      if (this.socket !== ws || this.permanentlyClosed) return;
      try {
        const buffer = Buffer.isBuffer(bytes) ? bytes : bytes instanceof ArrayBuffer ? Buffer.from(bytes) : Buffer.concat(bytes);
        if (binary || buffer.byteLength > MAX_FRAME) throw new RpcError('codex_invalid_frame');
        const data = envelope.parse(JSON.parse(buffer.toString()));
        if (data.method) {
          if (data.id !== undefined) {
            this.hooks.unsupportedRequest(data.method, data.params);
            ws.send(JSON.stringify({ id: data.id, error: { code: -32601, message: 'This client does not support this interaction and grants no additional permissions.' } }));
          } else this.hooks.notification(data.method, data.params);
        } else if (typeof data.id === 'number') {
          const request = this.pending.get(data.id);
          if (!request) return;
          this.pending.delete(data.id); clearTimeout(request.timer);
          if (data.error) request.reject(new RpcError('codex_native_error', data.error.code,
            data.error.code === -32600 && request.deleteThreadId && data.error.message === `thread not found: ${request.deleteThreadId}`
              ? 'deleted_thread_absent'
              : data.error.code === -32600 && /^no rollout found for thread id [a-zA-Z0-9_-]{1,512}$/.test(data.error.message) ? 'missing_rollout' : undefined));
          else request.resolve(data.result);
        } else throw new RpcError('codex_invalid_frame');
      } catch { disconnect(); ws.terminate(); }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', () => reject(new RpcError('codex_unavailable')));
        ws.once('close', () => reject(new RpcError('codex_disconnected')));
      });
      const initialization = z.object({ codexHome: z.string().max(4096) }).safeParse(
        await this.send('initialize', { clientInfo: { name: 'zhongshu', version: '0.1.0' }, capabilities: { experimentalApi: true } }));
      if (ws.readyState !== WebSocket.OPEN) throw new RpcError('codex_disconnected');
      this.home = initialization.data?.codexHome;
      ws.send(JSON.stringify({ method: 'initialized', params: {} }));
      established = true;
      this.awaitingPong = false;
      this.heartbeat = setInterval(() => {
        if (this.awaitingPong) { disconnect(); ws.terminate(); return; }
        this.awaitingPong = true; ws.ping();
      }, 15_000);
      this.heartbeat.unref();
    } catch (error) { disconnect(); ws.terminate(); throw error; }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.connect();
    return this.requestConnected(method, params);
  }

  /** Used when the caller must fence a request to an already verified connection. */
  requestConnected(method: string, params: unknown): Promise<unknown> {
    return this.send(method, params);
  }

  private send(method: string, params: unknown): Promise<unknown> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new RpcError('codex_disconnected'));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new RpcError('codex_request_limit'));
    const id = ++this.sequence;
    const payload = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(payload) > MAX_FRAME) return Promise.reject(new RpcError('codex_request_too_large'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError('codex_request_timeout'));
      }, 20_000);
      const deletion = method === 'thread/delete' ? z.object({ threadId: z.string().min(1).max(512) }).safeParse(params) : undefined;
      this.pending.set(id, { resolve, reject, timer, ...(deletion?.success ? { deleteThreadId: deletion.data.threadId } : {}) });
      ws.send(payload, error => {
        if (!error) return;
        const request = this.pending.get(id);
        if (request) { clearTimeout(request.timer); this.pending.delete(id); request.reject(new RpcError('codex_send_failed')); }
      });
    });
  }

  async close(): Promise<void> {
    this.permanentlyClosed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    const ws = this.socket;
    if (ws) {
      ws.close();
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { ws.terminate(); resolve(); }, 500);
        ws.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new RpcError('codex_adapter_closed')); }
    this.pending.clear();
  }
}

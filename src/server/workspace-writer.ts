import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { WriterRequest, WriterResult, WriterTarget } from './workspace-writer-worker.ts';

const resultSchema = z.union([
  z.object({ outcome: z.enum(['committed', 'rejected']), proof: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().max(128).optional(),
    document: z.object({ kind: z.enum(['markdown', 'text', 'html', 'source']), text: z.string().max(512 * 1024), version: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict(),
  z.object({ outcome: z.enum(['unknown', 'pending']), reason: z.string().max(128) }).strict(),
]);
export class WorkspaceWriterError extends Error {
  readonly code: string; readonly outcome: 'not_started' | 'unknown';
  constructor(code: string, outcome: 'not_started' | 'unknown') { super(code); this.name = 'WorkspaceWriterError'; this.code = code; this.outcome = outcome; }
}
type Pending = { id: number; method: 'write' | 'recover'; input: WriterRequest | WriterTarget; bytes: number; resolve: (value: WriterResult) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };

/** One private child owns all file effects. Failed commands are never replayed;
 * a subsequent owner must acquire the old process's OS lock before recovery.
 */
export class WorkspaceFileWriter {
  private readonly dataDirectory: string;
  private readonly capacity?: { quotaBytes: number; reserveBytes: number; minimumFreeBytes: number };
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private starting?: Promise<string>;
  private ownerId?: string;
  private closing = false;
  private closed?: Promise<void>;
  private current?: Pending;
  private readonly queue: Pending[] = [];
  private queuedBytes = 0;
  private sequence = 0;
  private idleWait?: { promise: Promise<void>; resolve: () => void };
  constructor(options: { dataDirectory: string; capacity?: { quotaBytes: number; reserveBytes: number; minimumFreeBytes: number } }) {
    this.dataDirectory = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0')).parse(options.dataDirectory);
    this.capacity = options.capacity;
  }
  async owner(): Promise<string> {
    if (this.closing) throw new WorkspaceWriterError('file_writer_closed', 'not_started');
    if (this.ownerId) return this.ownerId;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.exited;
      if (this.closing) throw new WorkspaceWriterError('file_writer_closed', 'not_started');
      const child = spawn(process.execPath, ['--max-old-space-size=128', fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './workspace-writer-worker.ts' : './workspace-writer-worker.js', import.meta.url))],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
      this.child = child;
      let resolveExit!: () => void;
      this.exited = new Promise<void>(resolve => { resolveExit = resolve; });
      return new Promise<string>((resolve, reject) => {
        let ready = false;
        const timer = setTimeout(() => { reject(new WorkspaceWriterError('file_writer_startup_timeout', 'not_started')); this.fail(child, 'file_writer_startup_timeout'); }, 15_000);
        child.on('error', () => { clearTimeout(timer); reject(new WorkspaceWriterError('file_writer_unavailable', 'not_started')); this.fail(child, 'file_writer_unavailable'); });
        child.on('exit', () => {
          clearTimeout(timer); resolveExit();
          if (!ready) reject(new WorkspaceWriterError('file_writer_unavailable', 'not_started'));
          if (this.child === child) { this.ownerId = undefined; this.failPending('file_writer_process_ended'); }
        });
        child.once('close', resolveExit);
        child.on('message', message => {
          if (!message || typeof message !== 'object' || !('type' in message)) { this.fail(child, 'file_writer_protocol_invalid'); return; }
          if (message.type === 'ready' && !ready && 'ownerId' in message) {
            const parsed = z.uuid().safeParse(message.ownerId); if (!parsed.success) { this.fail(child, 'file_writer_protocol_invalid'); return; }
            ready = true; this.ownerId = parsed.data; clearTimeout(timer); resolve(parsed.data); this.pump(); return;
          }
          if (message.type === 'result' && 'id' in message && this.current?.id === message.id) {
            const current = this.current!; clearTimeout(current.timer); this.current = undefined; this.queuedBytes -= current.bytes;
            if ('error' in message) current.reject(new WorkspaceWriterError(typeof message.error === 'string' ? message.error : 'file_writer_rejected', 'unknown'));
            else {
              const parsed = resultSchema.safeParse('result' in message ? message.result : undefined);
              if (parsed.success) current.resolve(parsed.data); else { current.reject(new WorkspaceWriterError('file_writer_protocol_invalid', 'unknown')); this.fail(child, 'file_writer_protocol_invalid'); }
            }
            this.pump(); return;
          }
          if (message.type === 'closed' && this.closing) return;
          this.fail(child, 'file_writer_protocol_invalid');
        });
        child.send({ type: 'initialize', dataDirectory: this.dataDirectory, ...(this.capacity ? { capacity: this.capacity } : {}) }, error => { if (error) this.fail(child, 'file_writer_unavailable'); });
      });
    })();
    try { return await this.starting; } finally { this.starting = undefined; }
  }
  private failPending(code: string) {
    if (this.current) { clearTimeout(this.current.timer); this.current.reject(new WorkspaceWriterError(code, 'unknown')); this.current = undefined; }
    for (const item of this.queue.splice(0)) item.reject(new WorkspaceWriterError(code, 'not_started'));
    this.queuedBytes = 0; this.idleWait?.resolve(); this.idleWait = undefined;
  }
  private fail(child: ChildProcess, code: string) {
    if (this.child !== child) return;
    this.ownerId = undefined; this.failPending(code);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  private pump() {
    if (this.current || !this.ownerId) return;
    const item = this.queue.shift();
    if (!item) { this.idleWait?.resolve(); this.idleWait = undefined; return; }
    this.current = item;
    item.timer = setTimeout(() => this.fail(this.child!, 'file_writer_timeout'), 30_000);
    this.child!.send({ type: 'request', id: item.id, method: item.method, input: item.input }, error => { if (error) this.fail(this.child!, 'file_writer_unavailable'); });
  }
  private async request(method: 'write' | 'recover', input: WriterRequest | WriterTarget) {
    await this.owner();
    if (this.closing) throw new WorkspaceWriterError('file_writer_closed', 'not_started');
    // Each file is at most 512 KiB; reject before retaining a full queue.
    const bytes = Buffer.byteLength(JSON.stringify(input));
    if (bytes > 1024 * 1024 || this.queue.length + Number(!!this.current) >= 32 || this.queuedBytes + bytes > 4 * 1024 * 1024) throw new WorkspaceWriterError('file_writer_busy', 'not_started');
    return new Promise<WriterResult>((resolve, reject) => { this.queuedBytes += bytes; this.queue.push({ id: ++this.sequence, method, input, bytes, resolve, reject }); this.pump(); });
  }
  write(input: WriterRequest) { return this.request('write', input); }
  recover(input: WriterTarget) { return this.request('recover', input); }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.closed = (async () => {
      await this.starting?.catch(() => {});
      if (this.current || this.queue.length) {
        this.idleWait ??= (() => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; })();
        await this.idleWait.promise;
      }
      const child = this.child;
      if (child?.connected) {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.send({ type: 'close' }); await this.exited; clearTimeout(timer);
      } else await this.exited;
    })();
    return this.closed;
  }
}

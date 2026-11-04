/** Rebuildable metadata only. File reads/writes must still use filesystem guards. */
import { isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { workspaceDocumentPath } from '../shared/content.ts';

export const directoryOptionsSchema = z.object({
  maxPending: z.number().int().min(1).max(128).default(32),
  maxQueuedScans: z.number().int().min(1).max(32).default(8),
  scanBatchSize: z.number().int().min(1).max(256).default(128),
  pageBytes: z.number().int().min(8192).max(256 * 1024).default(128 * 1024),
  retainedGenerationMs: z.number().int().min(0).max(600_000).default(60_000),
  maxDirectories: z.number().int().min(1).max(4096).default(256),
}).strict();
export const directoryTargetSchema = z.object({
  root: z.string().min(1).max(4096).refine(isAbsolute),
  path: z.union([z.literal(''), workspaceDocumentPath]).default(''),
  identity: z.string().min(1).max(200).optional(),
}).strict();
export const directoryPageSchema = directoryTargetSchema.extend({
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(100).default(100),
  refresh: z.boolean().default(false),
}).strict();
export type DirectoryTarget = z.input<typeof directoryTargetSchema>;
export type DirectoryPageInput = z.input<typeof directoryPageSchema>;
export type DirectoryEntry = { name: string; path: string; directory: boolean; supported: boolean };
export type DirectoryPage = {
  entries: DirectoryEntry[];
  nextCursor: string | null;
  generation: string | null;
  latestGeneration: string | null;
  status: 'scanning' | 'ready' | 'stale' | 'error';
  complete: boolean;
  refreshing: boolean;
  scanned: number;
  discovered: number;
  sourceChanged: boolean;
  /** Directory iteration is never claimed to be a filesystem snapshot. */
  snapshot: false;
  error?: string;
};
export class DirectoryIndexError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode = 409) { super(code); this.name = 'DirectoryIndexError'; this.code = code; this.statusCode = statusCode; }
}
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** One worker owns SQLite, one scan runs at a time, both queues are bounded. */
export class DirectoryIndex {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly maxPending: number;
  private sequence = 0;
  private closing = false;
  private closed = false;
  private closingPromise?: Promise<void>;
  private readonly exited: Promise<void>;

  constructor(indexDirectory: string, options: z.input<typeof directoryOptionsSchema> = {}) {
    const directory = z.string().min(1).max(4096).refine(isAbsolute).parse(indexDirectory);
    const parsed = directoryOptionsSchema.parse(options);
    this.maxPending = parsed.maxPending;
    // TypeScript rewrites static import extensions, not URL strings.
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    this.worker = new Worker(new URL('./directory-index-worker.' + extension, import.meta.url), {
      workerData: { directory, options: parsed }, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
    });
    this.worker.on('message', (message: { id: number; value?: unknown; error?: { code: string; statusCode: number } }) => {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new DirectoryIndexError(message.error.code, message.error.statusCode));
      else pending.resolve(message.value);
    });
    const fail = () => {
      this.closed = true;
      for (const request of this.pending.values()) request.reject(new DirectoryIndexError('directory_index_unavailable', 503));
      this.pending.clear();
    };
    this.worker.on('error', fail);
    this.exited = new Promise(resolve => this.worker.once('exit', () => { fail(); resolve(); }));
  }

  private request(action: string, input?: unknown, closing = false): Promise<unknown> {
    if (this.closed || this.closing && !closing) return Promise.reject(new DirectoryIndexError('directory_index_closed', 503));
    if (!closing && this.pending.size >= this.maxPending) return Promise.reject(new DirectoryIndexError('directory_index_busy', 429));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, action, input }); }
      catch { this.pending.delete(id); reject(new DirectoryIndexError('directory_index_unavailable', 503)); }
    });
  }
  async page(input: DirectoryPageInput): Promise<DirectoryPage> { return await this.request('page', directoryPageSchema.parse(input)) as DirectoryPage; }
  async refresh(input: DirectoryTarget): Promise<DirectoryPage> { return this.page({ ...directoryTargetSchema.parse(input), refresh: true }); }
  async invalidate(input: DirectoryTarget): Promise<void> { await this.request('invalidate', directoryTargetSchema.parse(input)); }
  async cancel(input: DirectoryTarget): Promise<void> { await this.request('cancel', directoryTargetSchema.parse(input)); }
  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true;
    this.closingPromise = (async () => {
      const timer = setTimeout(() => { void this.worker.terminate(); }, 3000).unref();
      try { if (!this.closed) await this.request('close', undefined, true).catch(() => {}); await this.exited; }
      finally { clearTimeout(timer); }
    })();
    return this.closingPromise;
  }
}

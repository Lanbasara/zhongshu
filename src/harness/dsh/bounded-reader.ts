import { Worker } from 'node:worker_threads';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { ExtractedRecord } from './bounded-extract.ts';

const path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && normalize(value) === value && !value.includes('\0'));
export const boundedBinding = z.object({ sessionId: z.string().min(1).max(512).refine(value => !value.includes('\0')), cwd: path }).strict();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const boundedPageArgs = boundedBinding.extend({ sourceGeneration: z.string().uuid(), throughSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER), beforeSeq: count.optional(), maxRecords: count.min(1).max(128).default(50), maxBytes: count.min(1024).max(256 * 1024).default(64 * 1024) });
export const boundedChunkArgs = boundedBinding.extend({ sourceGeneration: z.string().uuid(), seq: count, offset: count, maxBytes: count.min(1).max(256 * 1024).default(64 * 1024) });
export const boundedProjectArgs = boundedBinding.extend({ sourceGeneration: z.string().uuid(), seq: count });
export const boundedBodyArgs = boundedChunkArgs.extend({ field: z.enum(['text', 'input']), lease: z.string().uuid().optional() });
export const boundedTerminalArgs = boundedBinding.extend({ sourceGeneration: z.string().uuid(), throughSeq: count, turn: count.min(1) });
export const boundedItemsArgs = boundedBinding.extend({ sourceGeneration: z.string().uuid(), throughSeq: count, keys: z.array(z.string().min(1).max(600)).min(1).max(16) });
export type BoundedBinding = z.infer<typeof boundedBinding>;
export const boundedOptions = z.object({ nativeRoot: path, cacheRoot: path, maxCacheBytes: z.number().int().min(1024 * 1024).max(16 * 1024 ** 3).default(512 * 1024 ** 2) }).strict();
export type BoundedDshOptions = z.input<typeof boundedOptions>;
export type BoundedScan = { sourceGeneration: string; throughSeq: number; sourceOffset: number; sourceBytes: number; complete: boolean; indexedRecords: number; decodedBytes: number };
export type BoundedRecord = { seq: number; type: string; time: number; turn: number | null; bytes: number; sha256: string; raw?: Uint8Array };
export type BoundedPage = { sourceGeneration: string; throughSeq: number; records: BoundedRecord[]; beforeSeq: number | null };
export type BoundedChunk = { sourceGeneration: string; seq: number; sha256: string; offset: number; totalBytes: number; bytes: Uint8Array };
export type BoundedItemGroup = { key: string; orderSeq: number; records: BoundedRecord[] };
export type BoundedItemPage = { groups: BoundedItemGroup[]; beforeSeq: number | null };
export type BoundedCacheStatus = { bytes: number; budget: number; evicted: number; activeLeases: number; frameReads?: { decodedFrameBytes: number; frameDecodes: number; blockHits: number; blockMisses: number; memoryBytes: number } };

/**
 * Read-only DSH v4 physical-log importer. Authentication and binding ownership
 * belong to the caller. It neither resumes native sessions nor proves execution state.
 * The cache is reconstructable; permanent archive publication belongs to the caller.
 */
export class BoundedDshReader {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private closed = false;
  private observed: { phase: 'ready' | 'indexing' | 'paused'; error?: string; cache?: BoundedCacheStatus } = { phase: 'ready' };
  constructor(options: BoundedDshOptions) {
    const parsed = boundedOptions.parse(options);
    this.worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './bounded-worker.ts' : './bounded-worker.js', import.meta.url), {
      workerData: parsed, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
    });
    this.worker.on('message', (reply: { id: number; result?: unknown; error?: string; cacheStatus?: BoundedCacheStatus }) => {
      const request = this.pending.get(reply.id); if (!request) return;
      this.pending.delete(reply.id);
      this.observed = { phase: reply.error ? /cache_|capacity/.test(reply.error) ? 'paused' : /indexing/.test(reply.error) ? 'indexing' : 'ready' : 'ready', ...(reply.error ? { error: reply.error } : {}), ...(reply.cacheStatus ? { cache: reply.cacheStatus } : {}) };
      if (reply.error) request.reject(new Error(/^dsh_bounded_[a-z_]+$/.test(reply.error) ? reply.error : 'dsh_bounded_read_failed'));
      else request.resolve(reply.result);
    });
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => this.fail());
  }
  private fail(): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error('dsh_bounded_worker_closed'));
    this.pending.clear();
  }
  private async request<T>(method: string, args: unknown): Promise<T> {
    if (this.closed) throw new Error('dsh_bounded_worker_closed');
    if (this.pending.size >= 16) throw new Error('dsh_bounded_queue_full');
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      this.worker.postMessage({ id, method, args });
    });
  }
  scan(binding: BoundedBinding): Promise<BoundedScan> { return this.request('scan', boundedBinding.parse(binding)); }
  page(args: z.input<typeof boundedPageArgs>): Promise<BoundedPage> { return this.request('page', boundedPageArgs.parse(args)); }
  items(args: z.input<typeof boundedPageArgs>): Promise<BoundedItemPage> { return this.request('items', boundedPageArgs.parse(args)); }
  itemsByKeys(args: z.input<typeof boundedItemsArgs>): Promise<BoundedItemPage> { return this.request('itemsByKeys', boundedItemsArgs.parse(args)); }
  readChunk(args: z.input<typeof boundedChunkArgs>): Promise<BoundedChunk> { return this.request('chunk', boundedChunkArgs.parse(args)); }
  project(args: z.input<typeof boundedProjectArgs>): Promise<ExtractedRecord> { return this.request('project', boundedProjectArgs.parse(args)); }
  readBody(args: z.input<typeof boundedBodyArgs>): Promise<BoundedChunk> { return this.request('body', boundedBodyArgs.parse(args)); }
  terminal(args: z.input<typeof boundedTerminalArgs>): Promise<{ seq: number } | null> { return this.request('terminal', boundedTerminalArgs.parse(args)); }
  relatedCall(args: z.input<typeof boundedProjectArgs>): Promise<{ seq: number; turn: number; callId: string; name: string } | null> { return this.request('call', boundedProjectArgs.parse(args)); }
  release(lease: string): Promise<void> { return this.request('release', z.string().uuid().parse(lease)); }
  cacheStatus(): Promise<BoundedCacheStatus> { return this.request('status', {}); }
  get status() { return this.observed; }
  async close(): Promise<void> { this.fail(); await this.worker.terminate(); }
}

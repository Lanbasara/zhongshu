import { Worker } from 'node:worker_threads';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { HarnessError } from '../types.ts';
import type { Binding, HistoryPage, HistoryChanges, NativeBodyChunk, NativeItem, Receipt } from '../types.ts';
import { createHash } from 'node:crypto';
import type { CachedQueryPosition } from '../dsh/bounded-cache.ts';
import type { configuredThread } from './protocol.ts';

const path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && normalize(value) === value && !value.includes('\0'));
export const boundedCodexOptions = z.object({ nativeRoot: path, cacheRoot: path, maxCacheBytes: z.number().int().min(1024 * 1024).max(16 * 1024 ** 3).default(512 * 1024 ** 2) }).strict();
export type BoundedCodexOptions = z.input<typeof boundedCodexOptions>;
export const rolloutBinding = z.object({ id: z.string().min(1).max(512), cwd: path, path, cliVersion: z.literal('0.166.0-alpha.5.1') }).strict();
export type RolloutBinding = z.infer<typeof rolloutBinding>;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const turnQueryKey = z.string().regex(/^[a-f0-9]{64}$/);
export const turnQueryUpdate = z.object({ key: turnQueryKey, expected: z.string().uuid(), cursor: z.string().min(1).max(4096).nullable(), settled: z.boolean() }).strict();
export const turnQueryRetirement = z.object({ key: turnQueryKey, before: count }).strict();
export const rolloutCursor = z.object({ v: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/), generation: z.string().uuid(), through: count, before: count }).strict();
export const rolloutChangesCursor = z.object({ v: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/), generation: z.string().uuid(), through: count, after: count }).strict().refine(value => value.after <= value.through);
export const rolloutBody = z.object({ v: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/), generation: z.string().uuid(), seq: count, field: z.enum(['text', 'input', 'output', 'image']), lease: z.string().uuid(), version: z.string().regex(/^[a-f0-9]{64}$/), bytes: count }).strict();
export const rolloutKey = (binding: Pick<Binding, 'id' | 'cwd'>) => createHash('sha256').update(JSON.stringify([binding.id, binding.cwd])).digest('hex');
export const encodeRolloutToken = (prefix: string, value: unknown) => prefix + Buffer.from(JSON.stringify(value)).toString('base64url');
function decode<T>(prefix: string, value: string, schema: z.ZodType<T>): T {
  if (value.length > 4096 || !value.startsWith(prefix)) throw new HarnessError('history_cursor_invalid');
  try { return schema.parse(JSON.parse(Buffer.from(value.slice(prefix.length), 'base64url').toString('utf8'))); }
  catch { throw new HarnessError('history_cursor_invalid'); }
}
export const decodeRolloutBody = (value: string) => decode('cb1.', value, rolloutBody);

/** Dedicated, read-only, version-pinned importer. It never opens native credentials or resumes a thread. */
export class BoundedCodexReader {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private closed = false;
  private observed: { phase: 'ready' | 'indexing' | 'paused'; reason?: string; cache?: { bytes: number; budget: number; activeLeases: number } } = { phase: 'ready' };
  constructor(options: BoundedCodexOptions) {
    this.worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './bounded-worker.ts' : './bounded-worker.js', import.meta.url), { workerData: boundedCodexOptions.parse(options), resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
    this.worker.on('message', (reply: { id: number; result?: unknown; error?: string; cache?: { bytes: number; budget: number; activeLeases: number } }) => {
      const pending = this.pending.get(reply.id); if (!pending) return; this.pending.delete(reply.id);
      this.observed = { phase: reply.error?.includes('cache_') ? 'paused' : reply.error?.includes('indexing') ? 'indexing' : 'ready', ...(reply.error ? { reason: reply.error } : {}), ...(reply.cache ? { cache: reply.cache } : this.observed.cache ? { cache: this.observed.cache } : {}) };
      if (reply.error) pending.reject(new HarnessError(reply.error)); else pending.resolve(reply.result);
    });
    this.worker.on('error', () => this.fail()); this.worker.on('exit', () => this.fail());
  }
  private fail() { this.closed = true; for (const pending of this.pending.values()) pending.reject(new HarnessError('codex_bounded_worker_closed')); this.pending.clear(); }
  private request<T>(method: string, args: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new HarnessError('codex_bounded_worker_closed'));
    if (this.pending.size >= 16) return Promise.reject(new HarnessError('codex_bounded_queue_full'));
    return new Promise((resolve, reject) => { const id = ++this.sequence; this.pending.set(id, { resolve: value => resolve(value as T), reject }); this.worker.postMessage({ id, method, args }); });
  }
  history(binding: RolloutBinding, cursor?: string, limit = 50): Promise<HistoryPage> {
    const parsed = cursor === undefined ? undefined : decode('cr1.', cursor, rolloutCursor);
    if (parsed && parsed.key !== rolloutKey(binding)) throw new HarnessError('history_cursor_invalid');
    return this.request('history', { binding: rolloutBinding.parse(binding), cursor: parsed, limit: z.number().int().min(1).max(100).parse(limit) });
  }
  readItems(binding: RolloutBinding, ids: string[]): Promise<NativeItem[]> { return this.request('items', { binding: rolloutBinding.parse(binding), ids: z.array(z.string().min(1).max(512)).max(16).parse(ids) }); }
  creationConfiguration(binding: RolloutBinding): Promise<z.infer<typeof configuredThread> | null> {
    return this.request('creation-configuration', rolloutBinding.parse(binding));
  }
  historyChanges(binding: RolloutBinding, cursor?: string, limit = 16): Promise<HistoryChanges> {
    const parsed = cursor === undefined ? undefined : decode('cc1.', cursor, rolloutChangesCursor);
    if (parsed && parsed.key !== rolloutKey(binding)) throw new HarnessError('history_cursor_invalid');
    return this.request('changes', { binding: rolloutBinding.parse(binding), cursor: parsed, limit: count.min(1).max(16).parse(limit) });
  }
  reconcile(binding: RolloutBinding, operationId: string): Promise<Receipt> { return this.request('reconcile', { binding: rolloutBinding.parse(binding), operationId: z.string().min(1).max(512).parse(operationId) }); }
  turnQuery(key: string): Promise<CachedQueryPosition> { return this.request('turn-query', turnQueryKey.parse(key)); }
  retireTurnQuery(key: string, before: number): Promise<void> { return this.request('retire-turn-query', turnQueryRetirement.parse({ key, before })); }
  advanceTurnQuery(key: string, expected: string, cursor: string | null, settled: boolean): Promise<CachedQueryPosition | null> {
    return this.request('advance-turn-query', turnQueryUpdate.parse({ key, expected, cursor, settled }));
  }
  readBodyChunk(binding: Binding, token: string, offset: number, maxBytes: number): Promise<NativeBodyChunk> {
    const body = decodeRolloutBody(token); if (body.key !== rolloutKey(binding)) throw new HarnessError('codex_body_invalid');
    return this.request('body', { body, offset: count.parse(offset), maxBytes: count.min(1).max(64 * 1024).parse(maxBytes) });
  }
  releaseBodySource(binding: Binding, token: string): Promise<void> {
    const body = decodeRolloutBody(token); if (body.key !== rolloutKey(binding)) throw new HarnessError('codex_body_invalid');
    return this.request('release', body);
  }
  async readImage(binding: Binding, token: string): Promise<string> {
    const body = decodeRolloutBody(token);
    if (body.field !== 'image' || body.bytes > 8 * 1024 ** 2) throw new HarnessError('codex_image_capacity');
    const parts: Buffer[] = []; let offset = 0;
    do { const chunk = await this.readBodyChunk(binding, token, offset, 64 * 1024); parts.push(Buffer.from(chunk.data)); if (chunk.nextOffset === null) break; offset = chunk.nextOffset; } while (true);
    const data = Buffer.concat(parts); if (createHash('sha256').update(data).digest('hex') !== body.version) throw new HarnessError('codex_body_invalid');
    return data.toString('utf8');
  }
  get status() { return this.observed; }
  async close(): Promise<void> { this.fail(); await this.worker.terminate(); }
}

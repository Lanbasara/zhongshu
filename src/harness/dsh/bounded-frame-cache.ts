import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BoundedCache } from './bounded-cache.ts';

const blockBytes = 256 * 1024, prefixBytes = 36;
const hash = (value: Buffer) => createHash('sha256').update(value).digest();
type Identity = { key: string; generation: string; frame: number };
/** Reconstructable decoded blocks share the reader's global quota. Migration
 * can put years of events in one Zstd frame; rows in a warm window must not
 * decode that frame independently. Four immutable blocks are also kept in RAM.
 */
export class FrameBlockCache {
  private memory = new Map<string, Buffer>();
  private counters = { decodedFrameBytes: 0, frameDecodes: 0, blockHits: 0, blockMisses: 0 };
  private root: () => string;
  private quota: () => BoundedCache;
  private budget: number;
  constructor(root: () => string, quota: () => BoundedCache, budget: number) { this.root = root; this.quota = quota; this.budget = budget; }
  private name(identity: Identity, block: number) { return `v2-${identity.key}-${identity.generation}-${identity.frame}-segment-${block}.body`; }
  private remember(name: string, data: Buffer) { this.memory.delete(name); this.memory.set(name, data); while (this.memory.size > 4) this.memory.delete(this.memory.keys().next().value!); }
  private async cached(identity: Identity, block: number): Promise<Buffer | undefined> {
    const name = this.name(identity, block), remembered = this.memory.get(name);
    if (remembered) { this.remember(name, remembered); this.counters.blockHits++; return remembered; }
    let handle;
    try {
      handle = await open(join(this.root(), name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid()) throw new Error('dsh_bounded_unsafe_path');
      if (stat.size < prefixBytes || stat.size > prefixBytes + blockBytes) { await rm(join(this.root(), name), { force: true }); return; }
      const data = Buffer.alloc(stat.size); let offset = 0;
      while (offset < data.length) { const next = await handle.read(data, offset, data.length - offset, offset); if (!next.bytesRead) break; offset += next.bytesRead; }
      const bytes = data.subarray(prefixBytes);
      if (offset !== data.length || data.toString('ascii', 0, 4) !== 'zsc1' || !hash(bytes).equals(data.subarray(4, prefixBytes))) { await rm(join(this.root(), name), { force: true }); return; }
      this.remember(name, bytes); this.counters.blockHits++; await this.quota().touch(name); return bytes;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    finally { await handle?.close(); }
  }
  private async put(identity: Identity, block: number, bytes: Buffer) {
    const name = this.name(identity, block); this.remember(name, Buffer.from(bytes));
    try { await this.quota().ensure(bytes.length + prefixBytes); }
    catch (error) { if (error instanceof Error && /^dsh_bounded_cache_(paused|item_capacity)$/.test(error.message)) return; throw error; }
    const temporary = join(this.root(), name.slice(0, -5) + '-stage-' + randomUUID() + '.body');
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(Buffer.concat([Buffer.from('zsc1'), hash(bytes), bytes])); await handle.close(); await rename(temporary, join(this.root(), name)); }
    finally { await handle.close().catch(() => {}); await rm(temporary, { force: true }); }
  }
  /** Called by the indexer's existing decoder, so building the index warms
   * random-access blocks without another pass over the native frame. */
  writer(identity: Identity, window?: { first: number; last: number; requested: number }) {
    this.counters.frameDecodes++;
    let pending = Buffer.alloc(blockBytes), used = 0, block = 0, requested: Buffer | undefined;
    const flush = async () => {
      const bytes = pending.subarray(0, used);
      if (!window || block >= window.first && block <= window.last) {
        if (window?.requested === block) requested = Buffer.from(bytes);
        await this.put(identity, block, bytes);
      }
      used = 0; block++;
    };
    return {
      add: async (chunk: Buffer) => { this.counters.decodedFrameBytes += chunk.length; let offset = 0; while (offset < chunk.length) { const take = Math.min(blockBytes - used, chunk.length - offset); chunk.copy(pending, used, offset, offset + take); used += take; offset += take; if (used === blockBytes) await flush(); } },
      finish: async (complete = true) => { if (used && complete) await flush(); used = 0; pending = Buffer.alloc(0); return requested; },
    };
  }
  async readCached(identity: Identity, position: number, length: number): Promise<Buffer | undefined> {
    const result = Buffer.alloc(length); let written = 0;
    while (written < length) {
      const at = position + written, bytes = await this.cached(identity, Math.floor(at / blockBytes)), offset = at % blockBytes;
      if (!bytes || bytes.length <= offset) return;
      const take = Math.min(length - written, bytes.length - offset); bytes.copy(result, written, offset, offset + take); written += take;
    }
    return result;
  }
  async read(identity: Identity, position: number, length: number, decode: () => AsyncGenerator<Buffer>): Promise<Buffer> {
    const result = Buffer.alloc(length); let written = 0;
    while (written < length) {
      const at = position + written, block = Math.floor(at / blockBytes), offset = at % blockBytes;
      let bytes = await this.cached(identity, block);
      if (!bytes) {
        this.counters.blockMisses++;
        const width = Math.max(1, Math.min(32, Math.floor(this.budget / (blockBytes * 4)))), first = Math.floor(block / width) * width;
        const writer = this.writer(identity, { first, last: first + width - 1, requested: block });
        for await (const chunk of decode()) await writer.add(chunk);
        bytes = await writer.finish();
        if (!bytes) throw new Error('dsh_bounded_record_missing');
      }
      const take = Math.min(length - written, bytes.length - offset); if (take <= 0) throw new Error('dsh_bounded_record_missing');
      bytes.copy(result, written, offset, offset + take); written += take;
    }
    return result;
  }
  stats() { return { ...this.counters, memoryBytes: [...this.memory.values()].reduce((sum, data) => sum + data.length, 0) }; }
}

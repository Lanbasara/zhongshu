import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { open, opendir, lstat, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const owned = /^(?:v2-)?[a-f0-9]{64}(?:\.sqlite(?:-(?:wal|shm|journal))?|-[a-f0-9-]{36}(?:\.raw|-\d+-[a-z0-9-]+\.body))$/;
type Entry = { name: string; bytes: number; modified: number; key: string };
const lifetime = 5 * 60_000;
/** One process-independent quota/lease lock. All blocking SQLite work is in the reader worker. */
export class BoundedCache {
  private db: DatabaseSync;
  private root: string;
  private budget: number;
  private protectedKey = '';
  private protectedFiles = new Set<string>();
  private evicted = 0;
  private used = 0;
  private constructor(root: string, budget: number, db: DatabaseSync) { this.root = root; this.budget = budget; this.db = db; }
  static async lock(root: string, budget: number): Promise<BoundedCache> {
    const path = join(root, '.bounded-cache.sqlite');
    const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('dsh_bounded_unsafe_path'); await handle.chmod(0o600); } finally { await handle.close(); }
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=1000; PRAGMA auto_vacuum=FULL; CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,key TEXT NOT NULL,file TEXT NOT NULL,expires INTEGER NOT NULL,descriptor TEXT NOT NULL DEFAULT '{}') STRICT;");
      if (!db.prepare('PRAGMA table_info(leases)').all().some(row => row.name === 'descriptor')) db.exec("ALTER TABLE leases ADD COLUMN descriptor TEXT NOT NULL DEFAULT '{}';");
      db.exec('BEGIN IMMEDIATE;');
      db.prepare('DELETE FROM leases WHERE expires<=?').run(Date.now());
      return new BoundedCache(root, budget, db);
    } catch { db.close(); throw new Error('dsh_bounded_cache_busy'); }
  }
  protect(key: string): void { this.protectedKey = key; }
  protectFile(name: string): void { if (!owned.test(name)) throw new Error('dsh_bounded_unsafe_path'); this.protectedFiles.add(name); }
  private async entries(): Promise<Entry[]> {
    const entries: Entry[] = [];
    for await (const entry of await opendir(this.root, { bufferSize: 32 })) {
      if (/^\.bounded-cache\.sqlite(?:-journal)?$/.test(entry.name)) { const stat = await lstat(join(this.root, entry.name)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('dsh_bounded_unsafe_path'); entries.push({ name: entry.name, bytes: stat.size, modified: stat.mtimeMs, key: '' }); continue; }
      if (!owned.test(entry.name)) throw new Error('dsh_bounded_cache_not_dedicated');
      const stat = await lstat(join(this.root, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('dsh_bounded_unsafe_path');
      // The quota transaction excludes other cache writers. Unprotected staging
      // names therefore belong to an interrupted, reconstructable extraction.
      if (/(?:-stage-|-candidate-)[a-f0-9-]{36}\.body$/.test(entry.name) && !this.protectedFiles.has(entry.name)) { await rm(join(this.root, entry.name)); continue; }
      if (entries.length >= 65536) throw new Error('dsh_bounded_cache_entry_limit');
      const key = /^(?:v2-)?([a-f0-9]{64})/.exec(entry.name)![1]!;
      entries.push({ name: entry.name, key, bytes: stat.size, modified: stat.mtimeMs });
    }
    return entries;
  }
  /** Reserve temporary extraction space before creating it; evict only reconstructable unleased files. */
  async ensure(reserve = 0): Promise<void> {
    if (reserve > this.budget) throw new Error('dsh_bounded_cache_item_capacity');
    const entries = await this.entries(); this.used = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const leases = this.db.prepare('SELECT key,file FROM leases').all() as { key: string; file: string }[];
    const protectedKeys = new Set(leases.map(lease => lease.key)), protectedFiles = new Set([...this.protectedFiles, ...leases.map(lease => lease.file)]);
    const candidates = entries.filter(entry => entry.key !== '' && !protectedFiles.has(entry.name)
      && !(entry.name.includes('.sqlite') && (entry.key === this.protectedKey || protectedKeys.has(entry.key))))
      .sort((a, b) => Number(a.name.includes('.sqlite')) - Number(b.name.includes('.sqlite')) || a.modified - b.modified);
    for (const entry of candidates) {
      if (this.used + reserve + 16 * 1024 <= this.budget) break;
      await rm(join(this.root, entry.name)); this.used -= entry.bytes; this.evicted++;
    }
    if (this.used + reserve + 16 * 1024 > this.budget) throw new Error('dsh_bounded_cache_paused');
  }
  lease(key: string, file: string, descriptor: { version: string; bytes: number }): string {
    if (Number(this.db.prepare('SELECT count(*) n FROM leases').get()!.n) >= 256) throw new Error('dsh_bounded_cache_lease_limit');
    const id = randomUUID(); this.db.prepare('INSERT INTO leases VALUES(?,?,?,?,?)').run(id, key, file, Date.now() + lifetime, JSON.stringify({ version: descriptor.version, bytes: descriptor.bytes })); return id;
  }
  requireLeases(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || Number(this.db.prepare('SELECT count(*) n FROM leases').get()!.n) + count > 256) throw new Error('dsh_bounded_cache_lease_limit');
  }
  renew(id: string, key: string, file: string): { version: string; bytes: number } {
    const changed = this.db.prepare('UPDATE leases SET expires=? WHERE id=? AND key=? AND file=? AND expires>?').run(Date.now() + lifetime, id, key, file, Date.now()).changes;
    if (!changed) throw new Error('dsh_bounded_cache_lease_expired');
    const row = this.db.prepare('SELECT descriptor FROM leases WHERE id=?').get(id)!;
    const descriptor = JSON.parse(String(row.descriptor)) as { version: string; bytes: number };
    if (!/^[a-f0-9]{64}$/.test(descriptor.version) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0) throw new Error('dsh_bounded_cache_lease_expired');
    return descriptor;
  }
  release(id: string, key?: string, file?: string): { key: string; file: string; unleased: boolean } | undefined {
    const row = this.db.prepare('SELECT key,file FROM leases WHERE id=?').get(id) as { key: string; file: string } | undefined;
    if (row && ((key !== undefined && row.key !== key) || (file !== undefined && row.file !== file))) throw new Error('dsh_bounded_cache_lease_invalid');
    this.db.prepare('DELETE FROM leases WHERE id=?').run(id);
    return row ? { ...row, unleased: !this.db.prepare('SELECT 1 FROM leases WHERE file=? LIMIT 1').get(row.file) } : undefined;
  }
  async touch(name: string): Promise<void> { const now = new Date(); await utimes(join(this.root, name), now, now); }
  status() { return { bytes: this.used, budget: this.budget, evicted: this.evicted, activeLeases: Number(this.db.prepare('SELECT count(*) n FROM leases').get()!.n) }; }
  close(): void { this.db.exec('COMMIT'); this.db.close(); }
}

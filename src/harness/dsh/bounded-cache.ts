import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { open, opendir, lstat, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const owned = /^(?:v2-)?[a-f0-9]{64}(?:\.sqlite(?:-(?:wal|shm|journal))?|-[a-f0-9-]{36}(?:\.raw|-\d+-[a-z0-9-]+\.body))$/;
type Entry = { name: string; bytes: number; modified: number; key: string };
const lifetime = 5 * 60_000;
const queryLifetime = 7 * 24 * 60 * 60_000;
export type CachedQueryPosition = { revision: string; cursor: string | null };
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
      db.exec(`CREATE TABLE IF NOT EXISTS query_positions(key TEXT PRIMARY KEY,revision TEXT NOT NULL,cursor TEXT,expires INTEGER,updated INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE INDEX IF NOT EXISTS query_positions_expiry ON query_positions(expires) WHERE expires IS NOT NULL;`);
      if (!db.prepare('PRAGMA table_info(query_positions)').all().some(row => row.name === 'updated')) db.exec('ALTER TABLE query_positions ADD COLUMN updated INTEGER NOT NULL DEFAULT 0;');
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
      if (/^\.bounded-cache\.sqlite(?:-journal)?$/.test(entry.name)) {
        const stat = await lstat(join(this.root, entry.name)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('dsh_bounded_unsafe_path');
        // SQLite may retain new pages in memory until COMMIT. Include their
        // logical size before close(), not just the old on-disk file length.
        const logical = entry.name === '.bounded-cache.sqlite'
          ? Number(this.db.prepare('PRAGMA page_count').get()!.page_count) * Number(this.db.prepare('PRAGMA page_size').get()!.page_size) : 0;
        entries.push({ name: entry.name, bytes: Math.max(stat.size, logical), modified: stat.mtimeMs, key: '' }); continue;
      }
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
  /** Positions only: terminal facts must always come from a fresh native page.
   * Active searches are never LRU-evicted. Space exhaustion fails closed instead
   * of repeatedly restarting old searches when many bindings rotate through. */
  async queryPosition(key: string): Promise<CachedQueryPosition> {
    this.db.prepare('DELETE FROM query_positions WHERE key IN (SELECT key FROM query_positions WHERE expires<=? ORDER BY expires LIMIT 64)').run(Date.now());
    const existing = this.db.prepare('SELECT revision,cursor FROM query_positions WHERE key=?').get(key) as CachedQueryPosition | undefined;
    if (existing) return existing;
    return this.queryWrite(async () => {
      const position = { revision: randomUUID(), cursor: null };
      this.db.prepare('INSERT INTO query_positions(key,revision,cursor,expires,updated) VALUES(?,?,NULL,NULL,?)').run(key, position.revision, Date.now());
      return position;
    });
  }
  async advanceQuery(key: string, expected: string, cursor: string | null, settled: boolean): Promise<CachedQueryPosition | null> {
    // This transaction is held only for the cache RPC, never across native IPC.
    // UUID revisions also reject an old response after expiry/recreation (ABA).
    if (!this.db.prepare('SELECT 1 FROM query_positions WHERE key=? AND revision=?').get(key, expected)) return null;
    return this.queryWrite(async () => {
      const position = { revision: randomUUID(), cursor };
      this.db.prepare('UPDATE query_positions SET revision=?,cursor=?,expires=?,updated=? WHERE key=? AND revision=?')
        .run(position.revision, cursor, settled ? Date.now() + queryLifetime : null, Date.now(), key, expected);
      return position;
    });
  }
  retireQuery(key: string, before: number): void {
    // This timestamp is only a conservative cache cleanup fence. A concurrent
    // newer query survives the hint; clock rollback retains expendable data.
    this.db.prepare('DELETE FROM query_positions WHERE key=? AND updated<?').run(key, before);
  }
  private async queryWrite<T>(write: () => Promise<T>): Promise<T> {
    // Max 4096 Unicode cursor characters, one row and its B-tree/journal pages.
    // Reserve before mutation, and roll back the row if the physical final
    // quota check fails: close() must not commit a failed checkpoint.
    await this.ensure(128 * 1024);
    this.db.exec('SAVEPOINT query_write');
    try { const result = await write(); await this.ensure(); this.db.exec('RELEASE query_write'); return result; }
    catch (error) { this.db.exec('ROLLBACK TO query_write; RELEASE query_write'); throw error; }
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

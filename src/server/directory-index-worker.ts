/**
 * Trusted local worker; request paths are still schema/identity checked. No
 * credentials or content are indexed. Cache loss never deletes workspace data.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { directoryIdentity, withWorkspaceDirectory, workspaceDocumentEntry } from './workspace-documents.ts';
import { DirectoryIndexError, directoryOptionsSchema, directoryPageSchema, directoryTargetSchema } from './directory-index.ts';
import type { DirectoryEntry, DirectoryPage } from './directory-index.ts';

if (!parentPort) throw new Error('directory_index_worker_only');
const port = parentPort;
const setup = z.object({ directory: z.string().min(1).max(4096), options: directoryOptionsSchema }).strict().parse(workerData);
const options = setup.options;
const indexDirectory = resolve(setup.directory);
mkdirSync(indexDirectory, { recursive: true, mode: 0o700 });
const directoryInfo = lstatSync(indexDirectory);
if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) ||
  (process.getuid && directoryInfo.uid !== process.getuid()) || realpathSync(indexDirectory) !== indexDirectory) throw new Error('unsafe_directory_index_directory');
const databasePath = join(indexDirectory, 'directory-index.sqlite');
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  try {
    const info = lstatSync(databasePath + suffix);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('unsafe_directory_index_file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!suffix) closeSync(openSync(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
  }
}
const db = new DatabaseSync(databasePath);
// Fixed cache budget: 65,536 x 4 KiB pages = 256 MiB, excluding bounded WAL.
// A full cache stops a build explicitly and preserves the published generation.
db.exec(`PRAGMA page_size=4096; PRAGMA max_page_count=65536; PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000;
  PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=4194304;
  CREATE TABLE IF NOT EXISTS directories (
    key TEXT PRIMARY KEY, identity TEXT NOT NULL, published TEXT, previous TEXT,
    previous_until INTEGER NOT NULL DEFAULT 0, building TEXT,
    scanned INTEGER NOT NULL DEFAULT 0, discovered INTEGER NOT NULL DEFAULT 0,
    stamp TEXT NOT NULL, source_changed INTEGER NOT NULL DEFAULT 0,
    invalidation INTEGER NOT NULL DEFAULT 0, error TEXT, accessed INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS entries (
    key TEXT NOT NULL, generation TEXT NOT NULL, rank INTEGER NOT NULL,
    name TEXT NOT NULL COLLATE BINARY, path TEXT NOT NULL, supported INTEGER NOT NULL,
    PRIMARY KEY (key, generation, rank, name)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS directory_access ON directories(accessed);
  CREATE TABLE IF NOT EXISTS garbage (
    key TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY(key,generation)
  ) STRICT;
  INSERT OR IGNORE INTO garbage SELECT key,building FROM directories WHERE building IS NOT NULL;
  UPDATE directories SET building=NULL, error='directory_scan_interrupted' WHERE building IS NOT NULL;`);

type Target = z.infer<typeof directoryTargetSchema>;
type Row = { key: string; identity: string; published: string | null; previous: string | null; previous_until: number; building: string | null; scanned: number; discovered: number; stamp: string; source_changed: number; invalidation: number; error: string | null; accessed: number };
type Fingerprint = { identity: string; stamp: string };
type Job = { key: string; target: Target; generation: string; identity: string; invalidation: number; cancelled: boolean };
const cursorSchema = z.object({ v: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/), identity: z.string().max(200), generation: z.uuid(), rank: z.number().int().min(0).max(1), name: z.string().min(1).max(1024) }).strict();
const jobs = new Map<string, Job>();
// A full filesystem may prevent persisting the error itself. This bounded
// projection still exposes that failure until retry or worker restart.
const failures = new Map<string, string>();
const queue: Job[] = [];
let active: Promise<void> | undefined;
let closing = false;
let handlers = 0;
let cleaning = false;
const keyFor = (target: Target) => createHash('sha256').update(JSON.stringify([target.root, target.path])).digest('hex');
const rowFor = (key: string) => db.prepare('SELECT * FROM directories WHERE key=?').get(key) as Row | undefined;
function assertOpen() { if (closing) throw new DirectoryIndexError('directory_index_closed', 503); }
function errorDetails(error: unknown) {
  if (error instanceof DirectoryIndexError) return { code: error.code, statusCode: error.statusCode };
  if (error instanceof Error && 'code' in error && error.code === 'ERR_SQLITE_ERROR' && 'errcode' in error && error.errcode === 13) return { code: 'directory_index_capacity', statusCode: 507 };
  const code = error instanceof Error && /^[a-z][a-z0-9_]{1,100}$/.test(error.message) ? error.message : 'directory_index_unavailable';
  return { code, statusCode: error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 503 };
}
async function fingerprint(directory: string): Promise<Fingerprint> {
  // withWorkspaceDirectory supplies a held /proc/self/fd/<n> anchor on Linux.
  // That kernel entry is a symlink: O_NOFOLLOW on the anchor itself rejects it.
  // Open its literal '.' child instead, while the owner keeps the FD alive.
  const handle = await open(directory + '/.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    const identity = directoryIdentity(info);
    if (!identity) throw new DirectoryIndexError('workspace_identity_unavailable');
    return { identity, stamp: [info.mtimeNs, info.ctimeNs].join(':') };
  } finally { await handle.close(); }
}
async function guarded<T>(target: Target, action: (directory: string) => Promise<T>) {
  let actionError: unknown;
  try {
    return await withWorkspaceDirectory(target.root, target.path ? target.path.split('/') : [], async directory => {
      try { return await action(directory); }
      catch (error) { actionError = error; throw error; }
    }, target.identity);
  } catch (error) { throw actionError ?? error; }
}
async function inspect(target: Target) { const result = await guarded(target, fingerprint); assertOpen(); return result; }
function discard(key: string, generations: (string | null)[]) {
  const insert = db.prepare('INSERT OR IGNORE INTO garbage(key,generation) VALUES(?,?)');
  for (const generation of generations) if (generation) insert.run(key, generation);
}

/** Incremental orphan reclamation never holds a transaction across an await. */
function cleanLater() {
  if (cleaning || closing) return;
  cleaning = true;
  void (async () => {
    try {
      while (!closing) {
        // Only a bounded directory-metadata set is examined for TTL expiry.
        db.prepare('INSERT OR IGNORE INTO garbage SELECT key,previous FROM directories WHERE previous IS NOT NULL AND previous_until<?').run(Date.now());
        db.prepare('UPDATE directories SET previous=NULL WHERE previous IS NOT NULL AND previous_until<?').run(Date.now());
        const old = db.prepare('SELECT key,generation FROM garbage LIMIT 1').get();
        if (!old) break;
        const owner = rowFor(String(old.key));
        if (owner && (old.generation === owner.published || old.generation === owner.building || old.generation === owner.previous && owner.previous_until > Date.now())) {
          db.prepare('DELETE FROM garbage WHERE key=? AND generation=?').run(old.key!, old.generation!);
          await yieldTurn(); continue;
        }
        const count = db.prepare('DELETE FROM entries WHERE rowid IN (SELECT rowid FROM entries WHERE key=? AND generation=? LIMIT 256)').run(old.key!, old.generation!).changes;
        if (!count) db.prepare('DELETE FROM garbage WHERE key=? AND generation=?').run(old.key!, old.generation!);
        await yieldTurn();
      }
    } catch { /* Rebuildable orphans are retried after the next scan; no content loss. */ }
    finally { cleaning = false; }
  })();
}
function ensureRow(key: string, source: Fingerprint): Row {
  const old = rowFor(key);
  if (old?.identity === source.identity) return old;
  if (old && jobs.has(key)) throw new DirectoryIndexError('directory_identity_changed');
  if (!old && Number(db.prepare('SELECT COUNT(*) count FROM directories').get()!.count) >= options.maxDirectories) {
    const evict = db.prepare('SELECT * FROM directories WHERE building IS NULL ORDER BY accessed,key LIMIT 1').get() as Row | undefined;
    if (!evict) throw new DirectoryIndexError('directory_index_busy', 429);
    discard(evict.key, [evict.published, evict.previous]);
    db.prepare('DELETE FROM directories WHERE key=?').run(evict.key);
    failures.delete(evict.key);
  }
  if (old) discard(old.key, [old.published, old.previous, old.building]);
  db.prepare(`INSERT INTO directories(key,identity,stamp,accessed) VALUES(?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET identity=excluded.identity, published=NULL, previous=NULL,
    building=NULL, scanned=0, discovered=0, stamp=excluded.stamp, source_changed=0, error=NULL, accessed=excluded.accessed`).run(key, source.identity, source.stamp, Date.now());
  cleanLater(); return rowFor(key)!;
}
function schedule(key: string, target: Target, source: Fingerprint): void {
  if (jobs.has(key)) return;
  if (queue.length >= options.maxQueuedScans) throw new DirectoryIndexError('directory_scan_queue_full', 429);
  const row = ensureRow(key, source);
  const job: Job = { key, target, generation: randomUUID(), identity: source.identity, invalidation: row.invalidation, cancelled: false };
  db.prepare('UPDATE directories SET building=?,scanned=0,discovered=0,error=NULL WHERE key=?').run(job.generation, key);
  failures.delete(key);
  jobs.set(key, job); queue.push(job); pump();
}
function pump() {
  if (active || closing) return;
  const job = queue.shift(); if (!job) return;
  active = scan(job).catch(error => {
    const code = errorDetails(error).code;
    failures.set(job.key, code);
    try {
      db.prepare('UPDATE directories SET building=NULL,error=? WHERE key=? AND building=?').run(code, job.key, job.generation);
      discard(job.key, [job.generation]);
    } catch { /* Full disk may reject the failure marker; page() uses failures. */ }
  }).finally(() => { jobs.delete(job.key); active = undefined; cleanLater(); pump(); });
  void active.catch(() => {});
}
async function scan(job: Job) {
  let scanned = 0; let discovered = 0;
  const check = () => { if (job.cancelled || closing) throw new DirectoryIndexError('directory_scan_cancelled'); };
  const result = await guarded(job.target, async directory => {
    const before = await fingerprint(directory);
    if (before.identity !== job.identity) throw new DirectoryIndexError('directory_identity_changed');
    const iterator = await opendir(directory, { bufferSize: options.scanBatchSize });
    let batch: DirectoryEntry[] = []; let bytes = 0; let work = 0;
    const flush = () => {
      check();
      db.exec('BEGIN IMMEDIATE');
      try {
        const insert = db.prepare('INSERT OR IGNORE INTO entries(key,generation,rank,name,path,supported) VALUES(?,?,?,?,?,?)');
        for (const entry of batch) insert.run(job.key, job.generation, entry.directory ? 0 : 1, entry.name, entry.path, entry.supported ? 1 : 0);
        db.prepare('UPDATE directories SET scanned=?,discovered=? WHERE key=? AND building=?').run(scanned, discovered, job.key, job.generation);
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch { /* Preserve original failure. */ } throw error; }
      batch = []; bytes = 0; work = 0;
    };
    for await (const entry of iterator) {
      check(); scanned++; work++;
      const item = workspaceDocumentEntry(job.target.path, entry.name, { directory: entry.isDirectory(), file: entry.isFile() });
      if (item) { batch.push(item); discovered++; bytes += Buffer.byteLength(JSON.stringify(item)); }
      if (work >= options.scanBatchSize || bytes >= 64 * 1024) { flush(); await yieldTurn(); }
    }
    flush();
    const after = await fingerprint(directory);
    if (after.identity !== before.identity) throw new DirectoryIndexError('directory_identity_changed');
    return { after, changed: after.stamp !== before.stamp };
  });
  check();
  const current = rowFor(job.key);
  if (!current || current.building !== job.generation || current.identity !== job.identity) throw new DirectoryIndexError('directory_identity_changed');
  discard(job.key, [current.previous]);
  db.prepare(`UPDATE directories SET previous=published,previous_until=?,published=?,building=NULL,
    stamp=?,source_changed=?,error=NULL,accessed=? WHERE key=? AND building=?`).run(
    Date.now() + options.retainedGenerationMs, job.generation, result.after.stamp,
    result.changed || current.invalidation !== job.invalidation ? 1 : 0, Date.now(), job.key, job.generation);
}

function cursorFor(key: string, identity: string, generation: string, entry: DirectoryEntry) {
  return Buffer.from(JSON.stringify({ v: 1, key, identity, generation, rank: entry.directory ? 0 : 1, name: entry.name })).toString('base64url');
}
async function page(input: unknown): Promise<DirectoryPage> {
  const value = directoryPageSchema.parse(input);
  const target = directoryTargetSchema.parse({ root: value.root, path: value.path, identity: value.identity });
  const key = keyFor(target); const source = await inspect(target);
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (value.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(value.cursor, 'base64url').toString('utf8'))); }
    catch { throw new DirectoryIndexError('directory_cursor_invalid', 400); }
    if (cursor.key !== key || cursor.identity !== source.identity) throw new DirectoryIndexError('directory_cursor_expired');
  }
  let row = rowFor(key);
  if (cursor && (!row || row.identity !== source.identity)) throw new DirectoryIndexError('directory_cursor_expired');
  row = ensureRow(key, source);
  if (row.published && row.stamp !== source.stamp) {
    db.prepare('UPDATE directories SET source_changed=1 WHERE key=?').run(key); row.source_changed = 1;
  }
  if (value.refresh || !row.published && !row.building && !row.error) { schedule(key, target, source); row = rowFor(key)!; }
  let generation = row.published;
  if (cursor) {
    if (cursor.generation !== row.published && (cursor.generation !== row.previous || row.previous_until <= Date.now())) throw new DirectoryIndexError('directory_cursor_expired');
    generation = cursor.generation;
  }
  const sourceChanged = !!row.source_changed || generation !== row.published;
  const error = failures.get(key) ?? row.error;
  const metadata = { generation, latestGeneration: row.published,
    status: error ? 'error' as const : !row.published ? 'scanning' as const : sourceChanged ? 'stale' as const : 'ready' as const,
    complete: !!generation && !sourceChanged, refreshing: jobs.has(key), scanned: row.scanned, discovered: row.discovered,
    sourceChanged, snapshot: false as const, ...(error ? { error } : {}) };
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ ...metadata, entries: [], nextCursor: null }));
  const entries: DirectoryEntry[] = [];
  let hasMore = false; let bytes = 0;
  if (generation) {
    const rows = cursor
      ? db.prepare('SELECT name,path,rank,supported FROM entries WHERE key=? AND generation=? AND (rank,name)>(?,?) ORDER BY rank,name LIMIT ?').all(key, generation, cursor.rank, cursor.name, value.limit + 1)
      : db.prepare('SELECT name,path,rank,supported FROM entries WHERE key=? AND generation=? ORDER BY rank,name LIMIT ?').all(key, generation, value.limit + 1);
    for (const record of rows) {
      const entry = { name: String(record.name), path: String(record.path), directory: record.rank === 0, supported: record.supported === 1 };
      const size = Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0);
      const cursorBytes = cursorFor(key, row.identity, generation, entry).length;
      if (entries.length >= value.limit || envelopeBytes + bytes + size + cursorBytes > options.pageBytes) {
        if (!entries.length) throw new DirectoryIndexError('directory_entry_page_budget', 413);
        hasMore = true; break;
      }
      entries.push(entry); bytes += size;
    }
  }
  db.prepare('UPDATE directories SET accessed=? WHERE key=?').run(Date.now(), key);
  return { ...metadata, entries, nextCursor: hasMore && generation && entries.length ? cursorFor(key, row.identity, generation, entries.at(-1)!) : null };
}
async function handle(action: string, input: unknown) {
  if (action === 'close') {
    closing = true; for (const job of jobs.values()) job.cancelled = true;
    for (const job of queue.splice(0)) { db.prepare('UPDATE directories SET building=NULL,error=? WHERE key=? AND building=?').run('directory_scan_cancelled', job.key, job.generation); jobs.delete(job.key); }
    await active?.catch(() => {});
    while (handlers > 1 || cleaning) await yieldTurn();
    db.close(); return null;
  }
  assertOpen();
  if (action === 'page') return page(input);
  if (action === 'invalidate' || action === 'cancel') {
    const target = directoryTargetSchema.parse(input); await inspect(target);
    const key = keyFor(target);
    if (action === 'invalidate') db.prepare('UPDATE directories SET source_changed=1,invalidation=invalidation+1 WHERE key=?').run(key);
    else {
      const job = jobs.get(key); if (job) job.cancelled = true;
      const queued = queue.findIndex(candidate => candidate.key === key);
      if (queued >= 0) { queue.splice(queued, 1); jobs.delete(key); db.prepare('UPDATE directories SET building=NULL,error=? WHERE key=?').run('directory_scan_cancelled', key); }
    }
    return null;
  }
  throw new DirectoryIndexError('directory_index_request_invalid', 400);
}
port.on('message', (raw: unknown) => {
  const request = z.object({ id: z.number().int().positive(), action: z.enum(['page', 'invalidate', 'cancel', 'close']), input: z.unknown().optional() }).strict().safeParse(raw);
  if (!request.success) return;
  handlers++;
  void handle(request.data.action, request.data.input).then(
    value => { port.postMessage({ id: request.data.id, value }); },
    error => { port.postMessage({ id: request.data.id, error: errorDetails(error) }); },
  ).finally(() => { handlers--; if (request.data.action === 'close') port.close(); });
});
cleanLater();

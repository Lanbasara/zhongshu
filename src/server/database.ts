import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { z } from 'zod';

export type Migration = { version: number; sql: string };
export class DatabaseError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'DatabaseError'; this.code = code; }
}

const migrationSchema = z.array(z.object({ version: z.number().int().positive().max(10_000), sql: z.string().min(1).max(1_000_000) })).max(1000);
const locations = new WeakMap<DatabaseSync, string>();
const authMigration: Migration = { version: 1, sql: `
  CREATE TABLE auth_admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_digest TEXT NOT NULL,
    credential_version INTEGER NOT NULL CHECK (credential_version > 0),
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE auth_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    admin_id INTEGER NOT NULL REFERENCES auth_admin(id) ON DELETE CASCADE,
    credential_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
  CREATE TABLE auth_login_limits (
    bucket TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL CHECK (attempts > 0),
    reset_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX auth_login_limits_expiry ON auth_login_limits(reset_at);
` };

function privateDirectory(value: string): string {
  if (!z.string().min(1).max(4096).safeParse(value).success) throw new DatabaseError('invalid_data_directory');
  const path = resolve(value);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new DatabaseError('unsafe_data_directory');
  chmodSync(path, 0o700);
  return realpathSync(path);
}

function secureFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new DatabaseError('unsafe_data_file');
  chmodSync(path, 0o600);
}

function reserveFile(path: string): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
}

function entryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}

function syncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function configure(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
}

/** Migrations are trusted application code, never request input. The batch is atomic. */
export function applyMigrations(db: DatabaseSync, migrations: Migration[]): void {
  const parsed = migrationSchema.safeParse(migrations);
  if (!parsed.success || !parsed.data.length) throw new DatabaseError('invalid_migrations');
  const ordered = [...parsed.data].sort((a, b) => a.version - b.version);
  if (new Set(ordered.map(m => m.version)).size !== ordered.length) throw new DatabaseError('invalid_migrations');
  let transaction = false;
  try {
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    db.exec('CREATE TABLE IF NOT EXISTS app_migrations (version INTEGER PRIMARY KEY, digest TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT');
    const applied = db.prepare('SELECT version, digest FROM app_migrations ORDER BY version').all() as { version: number; digest: string }[];
    let current = applied.at(-1)?.version ?? 0;
    if (current > ordered[ordered.length - 1]!.version) throw new DatabaseError('newer_database_schema');
    for (const migration of ordered) {
      const digest = createHash('sha256').update(migration.sql).digest('hex');
      const existing = applied.find(row => row.version === migration.version);
      if (existing) {
        if (existing.digest !== digest) throw new DatabaseError('changed_applied_migration');
        continue;
      }
      if (migration.version !== current + 1) throw new DatabaseError('migration_version_gap');
      db.exec(migration.sql);
      db.prepare('INSERT INTO app_migrations(version, digest, applied_at) VALUES (?, ?, ?)').run(migration.version, digest, Date.now());
      current = migration.version;
    }
    db.exec('COMMIT'); transaction = false;
  } catch (error) {
    if (transaction) { try { db.exec('ROLLBACK'); } catch { /* connection will fail closed */ } }
    throw error instanceof DatabaseError ? error : new DatabaseError('migration_failed');
  }
}

/** Owns a private local data directory; callers close the returned native connection. */
export function openDatabase(dataDirectory: string, additionalMigrations: Migration[] = []): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    const directory = privateDirectory(dataDirectory);
    const path = join(directory, 'zhongshu.sqlite');
    if (!entryExists(path)) reserveFile(path);
    secureFile(path);
    for (const suffix of ['-wal', '-shm', '-journal']) if (entryExists(path + suffix)) secureFile(path + suffix);
    db = new DatabaseSync(path);
    configure(db);
    applyMigrations(db, [authMigration, ...additionalMigrations]);
    locations.set(db, path);
    return db;
  } catch (error) {
    db?.close();
    throw error instanceof DatabaseError ? error : new DatabaseError('database_open_failed');
  }
}

/** Product archives are immutable, but SQLite's page/FK checks cannot detect a
 * same-length damaged BLOB or a descriptor whose owner link is missing. This
 * audit runs only on an operator backup/restore snapshot, never a live request.
 * Iterate manifests and 64 KiB chunks; do not aggregate a body or all IDs. */
function verifyArchivedBodies(db: DatabaseSync): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?");
  const names = ['workbench_bodies', 'workbench_body_chunks', 'workbench_body_refs'];
  const present = names.map(name => Boolean(exists.get(name)));
  if (!present.some(Boolean)) {
    if (db.prepare('SELECT 1 FROM app_migrations WHERE version=12').get()) throw new DatabaseError('invalid_backup');
    return; // Auth-only and pre-chunk product backups remain restorable.
  }
  if (!present.every(Boolean)) throw new DatabaseError('invalid_backup');
  const manifests = db.prepare('SELECT substr(version,1,65) version,length(version) version_length,bytes,chunks,complete FROM workbench_bodies ORDER BY version');
  const chunks = db.prepare('SELECT part,length(data) bytes,substr(data,1,65537) data FROM workbench_body_chunks WHERE version=? ORDER BY part');
  for (const manifest of manifests.iterate()) {
    const version = String(manifest.version), bytes = Number(manifest.bytes), count = Number(manifest.chunks);
    if (manifest.version_length !== 64 || !/^[a-f0-9]{64}$/.test(version) || !Number.isSafeInteger(bytes) || bytes < 0 ||
      !Number.isSafeInteger(count) || count !== Math.ceil(bytes / 65536) || ![0, 1].includes(Number(manifest.complete))) throw new DatabaseError('invalid_backup');
    // Interrupted stages are retained exactly as captured. They are not a
    // completed body and must not be made complete by the restore audit.
    if (manifest.complete !== 1) continue;
    const hash = createHash('sha256'); let part = 0, length = 0;
    for (const chunk of chunks.iterate(version)) {
      const expected = Math.min(65536, bytes - length);
      if (chunk.part !== part++ || expected < 1 || chunk.bytes !== expected || !(chunk.data instanceof Uint8Array) || chunk.data.byteLength !== expected)
        throw new DatabaseError('invalid_backup');
      hash.update(chunk.data); length += chunk.data.byteLength;
    }
    if (part !== count || length !== bytes || hash.digest('hex') !== version) throw new DatabaseError('invalid_backup');
  }
  // Historical owner references intentionally outlive the current item version.
  // They still need an extant item and a complete immutable manifest.
  if (db.prepare(`SELECT 1 FROM workbench_body_refs r LEFT JOIN workbench_bodies b ON b.version=r.version
    WHERE b.version IS NULL OR b.complete!=1 OR NOT EXISTS(SELECT 1 FROM workbench_items i WHERE i.conversation_id=r.conversation_id AND i.id=r.item_id)
      AND NOT EXISTS(SELECT 1 FROM workbench_live_items i WHERE i.conversation_id=r.conversation_id AND i.id=r.item_id) LIMIT 1`).get()) throw new DatabaseError('invalid_backup');
  const owner = db.prepare(`SELECT 1 FROM workbench_body_refs r JOIN workbench_bodies b ON b.version=r.version
    WHERE r.conversation_id=? AND r.item_id=? AND r.field=? AND r.version=? AND b.bytes=? AND b.complete=1`);
  // SQL extracts only the small descriptor, not legacy full text/tool payloads.
  for (const table of ['workbench_items', 'workbench_live_items']) {
    const invalid = table === 'workbench_items'
      ? "SELECT 1 FROM workbench_items WHERE NOT json_valid(metadata_json) OR (json_type(metadata_json,'$.bodies') IS NOT NULL AND json_type(metadata_json,'$.bodies')!='object') LIMIT 1"
      : "SELECT 1 FROM workbench_live_items WHERE NOT json_valid(metadata_json) OR (json_type(metadata_json,'$.bodies') IS NOT NULL AND json_type(metadata_json,'$.bodies')!='object') LIMIT 1";
    if (db.prepare(invalid).get()) throw new DatabaseError('invalid_backup');
    const descriptors = table === 'workbench_items'
      ? `SELECT i.conversation_id,i.id,j.key field,j.type,substr(json_extract(j.value,'$.version'),1,65) version,
        length(json_extract(j.value,'$.version')) version_length,json_extract(j.value,'$.bytes') bytes,
        (SELECT COUNT(*) FROM json_each(j.value)) fields FROM workbench_items i,json_each(i.metadata_json,'$.bodies') j`
      : `SELECT i.conversation_id,i.id,j.key field,j.type,substr(json_extract(j.value,'$.version'),1,65) version,
        length(json_extract(j.value,'$.version')) version_length,json_extract(j.value,'$.bytes') bytes,
        (SELECT COUNT(*) FROM json_each(j.value)) fields FROM workbench_live_items i,json_each(i.metadata_json,'$.bodies') j`;
    for (const value of db.prepare(descriptors).iterate()) {
      if (value.type !== 'object' || value.fields !== 2 || !['text', 'input', 'output', 'references'].includes(String(value.field)) ||
        value.version_length !== 64 || !/^[a-f0-9]{64}$/.test(String(value.version)) || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 ||
        !owner.get(String(value.conversation_id), String(value.id), String(value.field), String(value.version), Number(value.bytes))) throw new DatabaseError('invalid_backup');
    }
  }
}

function verifyDatabase(db: DatabaseSync, archives = true): void {
  const result = db.prepare('PRAGMA quick_check(1)').get();
  if (!result || Object.values(result)[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) throw new DatabaseError('invalid_backup');
  if (!db.prepare('SELECT version FROM app_migrations WHERE version=1').get()) throw new DatabaseError('invalid_backup');
  db.prepare('SELECT id,password_digest,credential_version FROM auth_admin LIMIT 1').get();
  db.prepare('SELECT id,token_hash,expires_at FROM auth_sessions LIMIT 1').get();
  if (archives) verifyArchivedBodies(db);
}

function verifyBackup(path: string): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA trusted_schema=OFF; BEGIN');
    verifyDatabase(db);
    db.exec('COMMIT');
  } catch { throw new DatabaseError('invalid_backup'); }
  finally { db?.close(); }
}

/** SQLite's online backup includes committed WAL state; never copy a live database file. */
export async function backupDatabase(db: DatabaseSync, destination: string): Promise<void> {
  const parsed = z.string().min(1).max(4096).safeParse(destination);
  if (!parsed.success) throw new DatabaseError('invalid_backup_destination');
  const path = resolve(destination);
  let reserved = false;
  try {
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) || (process.getuid && parent.uid !== process.getuid())) throw new DatabaseError('unsafe_backup_directory');
    if (locations.get(db) === path || entryExists(path)) throw new DatabaseError('backup_destination_exists');
    reserveFile(path); reserved = true;
    await backup(db, path);
    secureFile(path);
    verifyBackup(path);
    syncFile(path); syncFile(dirname(path));
  } catch (error) {
    if (reserved) { try { unlinkSync(path); } catch { /* retain no success claim */ } }
    throw error instanceof DatabaseError ? error : new DatabaseError('backup_failed');
  }
}

/** Restore into a fresh target. The trusted synchronous hook shares the session-revocation transaction. */
export async function restoreDatabase(source: string, destinationDirectory: string, afterRestore?: (db: DatabaseSync) => void): Promise<void> {
  if (!z.string().min(1).max(4096).safeParse(source).success) throw new DatabaseError('invalid_backup');
  let sourceDb: DatabaseSync | undefined;
  let restored: DatabaseSync | undefined;
  let staging: string | undefined;
  try {
    const path = resolve(source);
    secureFile(path);
    const sourceIdentity = lstatSync(path, { bigint: true });
    const directory = privateDirectory(destinationDirectory);
    const target = join(directory, 'zhongshu.sqlite');
    if (entryExists(target)) throw new DatabaseError('restore_target_exists');
    for (const suffix of ['-wal', '-shm', '-journal']) if (entryExists(target + suffix)) throw new DatabaseError('restore_target_exists');
    staging = join(directory, '.restore-' + randomUUID() + '.sqlite');
    reserveFile(staging);
    try {
      sourceDb = new DatabaseSync(path, { readOnly: true });
      sourceDb.exec('PRAGMA trusted_schema=OFF');
      verifyDatabase(sourceDb, false);
    } catch { throw new DatabaseError('invalid_backup'); }
    await backup(sourceDb, staging);
    // Audit the exact private SQLite snapshot that will be published, not a
    // prior path-based read of a source that may change while copying its WAL.
    const copiedIdentity = lstatSync(path, { bigint: true });
    if (copiedIdentity.isSymbolicLink() || copiedIdentity.nlink !== 1n || copiedIdentity.dev !== sourceIdentity.dev || copiedIdentity.ino !== sourceIdentity.ino)
      throw new DatabaseError('invalid_backup');
    sourceDb.close(); sourceDb = undefined;
    secureFile(staging);
    restored = new DatabaseSync(staging);
    configure(restored);
    restored.exec('BEGIN IMMEDIATE');
    try {
      restored.exec('DELETE FROM auth_sessions; DELETE FROM auth_login_limits;');
      afterRestore?.(restored);
      try { verifyDatabase(restored); } catch { throw new DatabaseError('invalid_backup'); }
      restored.exec('COMMIT');
    } catch (error) {
      try { restored.exec('ROLLBACK'); } catch { /* do not publish this staging database */ }
      throw error;
    }
    restored.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    restored.close(); restored = undefined;
    syncFile(staging);
    // Publish only after token revocation is durable. link is atomic and refuses an existing target.
    linkSync(staging, target);
    unlinkSync(staging); staging = undefined;
    syncFile(directory);
  } catch (error) {
    restored?.close(); restored = undefined;
    throw error instanceof DatabaseError ? error : new DatabaseError('restore_failed');
  } finally {
    restored?.close(); sourceDb?.close();
    if (staging) { for (const suffix of ['', '-wal', '-shm', '-journal']) { try { unlinkSync(staging + suffix); } catch { /* only owned staging files */ } } }
  }
}

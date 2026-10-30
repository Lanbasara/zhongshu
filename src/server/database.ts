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

function verifyBackup(path: string): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA trusted_schema=OFF');
    const result = db.prepare('PRAGMA quick_check').all();
    if (result.length !== 1 || Object.values(result[0]!)[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new DatabaseError('invalid_backup');
    const migration = db.prepare('SELECT version FROM app_migrations WHERE version = 1').get();
    if (!migration) throw new DatabaseError('invalid_backup');
    db.prepare('SELECT id, password_digest, credential_version FROM auth_admin').all();
    db.prepare('SELECT id, token_hash, expires_at FROM auth_sessions LIMIT 1').all();
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
  } catch (error) {
    if (reserved) { try { unlinkSync(path); } catch { /* retain no success claim */ } }
    throw error instanceof DatabaseError ? error : new DatabaseError('backup_failed');
  }
}

/** Restore only into a fresh target. Restored sessions are revoked to prevent token resurrection. */
export async function restoreDatabase(source: string, destinationDirectory: string): Promise<void> {
  if (!z.string().min(1).max(4096).safeParse(source).success) throw new DatabaseError('invalid_backup');
  let sourceDb: DatabaseSync | undefined;
  let restored: DatabaseSync | undefined;
  let staging: string | undefined;
  try {
    const path = resolve(source);
    secureFile(path); verifyBackup(path);
    const directory = privateDirectory(destinationDirectory);
    const target = join(directory, 'zhongshu.sqlite');
    if (entryExists(target)) throw new DatabaseError('restore_target_exists');
    for (const suffix of ['-wal', '-shm', '-journal']) if (entryExists(target + suffix)) throw new DatabaseError('restore_target_exists');
    staging = join(directory, '.restore-' + randomUUID() + '.sqlite');
    reserveFile(staging);
    sourceDb = new DatabaseSync(path, { readOnly: true });
    await backup(sourceDb, staging);
    secureFile(staging);
    verifyBackup(staging);
    restored = new DatabaseSync(staging);
    configure(restored);
    restored.exec('BEGIN IMMEDIATE; DELETE FROM auth_sessions; DELETE FROM auth_login_limits; COMMIT;');
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

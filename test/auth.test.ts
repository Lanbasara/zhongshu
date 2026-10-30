import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAuth, type LoginResult } from '../src/server/auth.ts';
import { DatabaseError, applyMigrations, backupDatabase, openDatabase, restoreDatabase, type Migration } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';

const PASSWORD = 'synthetic correct horse battery';
const NEW_PASSWORD = 'synthetic replacement password';
const silent = { audit: () => {} };
function success(result: LoginResult) { assert.equal(result.ok, true); if (!result.ok) throw new Error('expected_success'); return result; }
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-auth-'));
  const directory = join(root, 'data');
  const connections = new Set<DatabaseSync>();
  const open = (migrations: Migration[] = []) => { const db = openDatabase(directory, migrations); connections.add(db); return db; };
  const close = (db: DatabaseSync) => { db.close(); connections.delete(db); };
  t.after(() => { for (const db of connections) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, directory, open, close };
}

test('private WAL/FULL database, one administrator, and token hashes only', async t => {
  const f = fixture(t); const db = f.open(); const auth = createAuth(db, silent);
  assert.equal(auth.initialized(), false);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.directory, 'zhongshu.sqlite')).mode & 0o777, 0o600);
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA synchronous').get()?.synchronous, 2);
  await assert.rejects(auth.initialize('short'), { code: 'password_requires_12_to_1024_characters' });
  await auth.initialize(PASSWORD);
  await assert.rejects(auth.initialize(NEW_PASSWORD), { code: 'admin_already_initialized' });
  assert.deepEqual(await auth.login('wrong password', { clientKey: 'client-one' }), { ok: false, reason: 'invalid_credentials' });
  const logged = success(await auth.login(PASSWORD, { clientKey: 'client-one' }));
  const row = db.prepare('SELECT * FROM auth_sessions').get()!;
  assert.equal(row.token_hash, createHash('sha256').update(logged.token).digest('hex'));
  assert.equal(JSON.stringify(row).includes(logged.token), false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM auth_admin').get()).includes(PASSWORD), false);
  assert.deepEqual(auth.authenticate(logged.token), logged.session);
  assert.equal(auth.authenticate('forged'), null);
  assert.equal(auth.authenticate('x'.repeat(43)), null);
});

test('login rotates current session while two devices remain independent', async t => {
  const f = fixture(t); const db = f.open(); const auth = createAuth(db, silent); await auth.initialize(PASSWORD);
  const first = success(await auth.login(PASSWORD, { clientKey: 'device-a' }));
  const second = success(await auth.login(PASSWORD, { clientKey: 'device-b' }));
  const rotated = success(await auth.login(PASSWORD, { clientKey: 'device-a', previousToken: first.token }));
  assert.notEqual(first.token, rotated.token);
  assert.equal(auth.authenticate(first.token), null);
  assert.ok(auth.authenticate(second.token));
  auth.logout(rotated.token);
  assert.equal(auth.authenticate(rotated.token), null);
  assert.ok(auth.authenticate(second.token));
});

test('absolute expiry and sessions survive an ordinary database reopen', async t => {
  const f = fixture(t); let at = 10_000; let db = f.open();
  let auth = createAuth(db, { ...silent, now: () => at, sessionTtlMs: 1000 }); await auth.initialize(PASSWORD);
  const logged = success(await auth.login(PASSWORD, { clientKey: 'device' }));
  f.close(db); at += 500; db = f.open(); auth = createAuth(db, { ...silent, now: () => at, sessionTtlMs: 1000 });
  assert.deepEqual(auth.authenticate(logged.token), logged.session);
  at += 500; assert.equal(auth.authenticate(logged.token), null);
});

test('reset revokes every session including a login racing asynchronous password hashing', async t => {
  const f = fixture(t); const db = f.open(); const auth = createAuth(db, silent); await auth.initialize(PASSWORD);
  const logged = success(await auth.login(PASSWORD, { clientKey: 'before-reset' }));
  const [racing] = await Promise.all([auth.login(PASSWORD, { clientKey: 'racing' }), auth.reset(NEW_PASSWORD)]);
  assert.equal(auth.authenticate(logged.token), null);
  if (racing.ok) assert.equal(auth.authenticate(racing.token), null);
  assert.equal((await auth.login(PASSWORD, { clientKey: 'after-reset' })).ok, false);
  assert.ok(success(await auth.login(NEW_PASSWORD, { clientKey: 'after-reset' })).session);
});

test('concurrent initialization cannot overwrite the winning administrator', async t => {
  const f = fixture(t); const db = f.open(); const auth = createAuth(db, silent);
  const results = await Promise.allSettled([auth.initialize(PASSWORD), auth.initialize(NEW_PASSWORD)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_admin').get()?.count, 1);
  const winner = results[0]!.status === 'fulfilled' ? PASSWORD : NEW_PASSWORD;
  assert.equal((await auth.login(winner, { clientKey: 'device' })).ok, true);
});

test('login lockout persists across restart and expires without growing buckets indefinitely', async t => {
  const f = fixture(t); let at = 1000; let db = f.open(); let auth = createAuth(db, { ...silent, now: () => at }); await auth.initialize(PASSWORD);
  for (let n = 0; n < 5; n++) assert.equal((await auth.login('wrong password', { clientKey: 'attacker' })).ok, false);
  f.close(db); db = f.open(); auth = createAuth(db, { ...silent, now: () => at });
  assert.deepEqual(await auth.login(PASSWORD, { clientKey: 'attacker' }), { ok: false, reason: 'rate_limited', retryAfterSeconds: 900 });
  at += 900_001;
  assert.equal((await auth.login(PASSWORD, { clientKey: 'attacker' })).ok, true);
  db.exec('DELETE FROM auth_login_limits');
  const insert = db.prepare('INSERT INTO auth_login_limits(bucket, attempts, reset_at) VALUES (?, 1, ?)');
  for (let n = 0; n < 512; n++) insert.run('synthetic-client-' + n, at + 900_000);
  const denied = await auth.login(PASSWORD, { clientKey: 'new-client' });
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.reason, 'rate_limited');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_login_limits').get()?.count, 512);
});

test('global reservation limits rotated clients and concurrent hashes are bounded', async t => {
  const f = fixture(t); const db = f.open(); const auth = createAuth(db, silent); await auth.initialize(PASSWORD);
  const results = await Promise.all([0, 1, 2].map(n => auth.login(PASSWORD, { clientKey: 'concurrent-' + n })));
  assert.equal(results.filter(result => result.ok).length, 2);
  assert.equal(results.filter(result => !result.ok && result.reason === 'busy').length, 1);
  db.prepare('UPDATE auth_login_limits SET attempts = 30 WHERE bucket = ?').run('global');
  const denied = await auth.login(PASSWORD, { clientKey: 'another-new-client' });
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.reason, 'rate_limited');
});

test('migration failure rolls back and unknown newer schema is rejected', t => {
  const f = fixture(t); let db = f.open();
  assert.throws(() => applyMigrations(db, [{ version: 2, sql: 'CREATE TABLE should_rollback (id INTEGER); INSERT INTO missing_table VALUES (1);' }]), { code: 'migration_failed' });
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'should_rollback'").get(), undefined);
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM app_migrations').get()?.version, 1);
  applyMigrations(db, [{ version: 2, sql: 'CREATE TABLE product_records (id INTEGER PRIMARY KEY) STRICT;' }]);
  f.close(db);
  assert.throws(() => f.open(), { code: 'newer_database_schema' });
  db = openDatabase(f.directory, [{ version: 2, sql: 'CREATE TABLE product_records (id INTEGER PRIMARY KEY) STRICT;' }]);
  db.close();
});

test('online WAL backup restores real credentials but never resurrects sessions', async t => {
  const f = fixture(t); const db = f.open(); const auth = createAuth(db, silent); await auth.initialize(PASSWORD);
  const logged = success(await auth.login(PASSWORD, { clientKey: 'device' }));
  const backupPath = join(f.root, 'backup.sqlite');
  await backupDatabase(db, backupPath);
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  await assert.rejects(backupDatabase(db, backupPath), { code: 'backup_destination_exists' });
  await auth.reset(NEW_PASSWORD);
  const restoredDirectory = join(f.root, 'restored');
  await restoreDatabase(backupPath, restoredDirectory);
  const restored = openDatabase(restoredDirectory);
  try {
    const restoredAuth = createAuth(restored, silent);
    assert.equal(restoredAuth.authenticate(logged.token), null);
    assert.equal((await restoredAuth.login(PASSWORD, { clientKey: 'restored-device' })).ok, true);
    assert.equal((await restoredAuth.login(NEW_PASSWORD, { clientKey: 'restored-device' })).ok, false);
  } finally { restored.close(); }
  await assert.rejects(restoreDatabase(backupPath, restoredDirectory), { code: 'restore_target_exists' });
});

test('database and backup reject symlinks and corrupted input', async t => {
  const f = fixture(t); const db = f.open();
  const target = join(f.root, 'unrelated.txt'); writeFileSync(target, 'untouched', { mode: 0o600 });
  const linked = join(f.root, 'linked.sqlite'); symlinkSync(target, linked);
  await assert.rejects(backupDatabase(db, linked), DatabaseError);
  await assert.rejects(restoreDatabase(linked, join(f.root, 'restore-link')), { code: 'unsafe_data_file' });
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
  const corrupt = join(f.root, 'corrupt.sqlite'); writeFileSync(corrupt, 'not a database', { mode: 0o600 });
  await assert.rejects(restoreDatabase(corrupt, join(f.root, 'restore-corrupt')), { code: 'invalid_backup' });
  f.close(db); rmSync(join(f.directory, 'zhongshu.sqlite')); symlinkSync(target, join(f.directory, 'zhongshu.sqlite'));
  assert.throws(() => f.open(), { code: 'unsafe_data_file' });
});

async function cli(args: string[], input = '') {
  return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server/admin.ts', import.meta.url)), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data.toString(); }); child.stderr.on('data', data => { output += data.toString(); });
    child.on('error', reject); child.on('exit', code => resolve({ code, output })); child.stdin.end(input);
  });
}

test('administrator CLI accepts stdin secrets, rejects plaintext arguments and duplicate initialization', async t => {
  const f = fixture(t);
  const first = await cli(['init', '--data-dir', f.directory, '--password-stdin'], PASSWORD + '\n');
  assert.equal(first.code, 0, first.output); assert.equal(first.output.includes(PASSWORD), false);
  const duplicate = await cli(['init', '--data-dir', f.directory, '--password-stdin'], NEW_PASSWORD + '\n');
  assert.notEqual(duplicate.code, 0); assert.match(duplicate.output, /admin_already_initialized/);
  const insecure = await cli(['reset', '--data-dir', f.directory, '--password', NEW_PASSWORD]);
  assert.notEqual(insecure.code, 0); assert.equal(insecure.output.includes(NEW_PASSWORD), false);
  const reset = await cli(['reset', '--data-dir', f.directory, '--password-stdin'], NEW_PASSWORD + '\n');
  assert.equal(reset.code, 0, reset.output); assert.equal(reset.output.includes(NEW_PASSWORD), false);
  const auth = createAuth(f.open(productMigrations), silent);
  assert.equal((await auth.login(NEW_PASSWORD, { clientKey: 'device' })).ok, true);
});

import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export type Session = { id: string; adminId: 1; expiresAt: number };
export type LoginResult = { ok: true; token: string; session: Session } | { ok: false; reason: 'invalid_credentials' | 'rate_limited' | 'not_initialized' | 'busy'; retryAfterSeconds?: number };
export type AuthEvent = { event: 'admin_initialized' | 'admin_reset' | 'login_success' | 'login_failure' | 'login_limited' | 'session_revoked'; time: number };
export type AuthOptions = { now?: () => number; sessionTtlMs?: number; audit?: (event: AuthEvent) => void };
export class AuthError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'AuthError'; this.code = code; }
}

const passwordInput = z.string().min(1).max(1024).refine(value => Buffer.byteLength(value, 'utf8') <= 1024);
const newPassword = passwordInput.refine(value => [...value].length >= 12);
const tokenInput = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const clientInput = z.string().min(1).max(256);
const adminRow = z.object({ password_digest: z.string().regex(/^scrypt-v1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/), credential_version: z.number().int().positive() });
const sessionRow = z.object({ id: z.string().uuid(), admin_id: z.literal(1), expires_at: z.number().int().nonnegative() });
const DAY = 24 * 60 * 60 * 1000;
const CLIENT_WINDOW = 15 * 60 * 1000;
const GLOBAL_WINDOW = 60 * 1000;
let activeHashes = 0;

// OWASP's lower-memory scrypt choice: N=2^15, r=8, p=3. At most two hashes per process.
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (activeHashes >= 2) throw new AuthError('hash_capacity_reached');
  activeHashes++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, result) => {
        if (error) reject(new AuthError('password_hash_failed')); else resolve(result);
      });
    });
  } finally { activeHashes--; }
}

async function digest(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  try { return 'scrypt-v1$' + salt.toString('base64url') + '$' + key.toString('base64url'); }
  finally { key.fill(0); }
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** HTTP owns cookies, origin checks and trusted client address selection. No secret is logged here. */
export function createAuth(db: DatabaseSync, options: AuthOptions = {}) {
  const sessionTtlMs = z.number().int().min(1000).max(30 * DAY).parse(options.sessionTtlMs ?? 7 * DAY);
  const now = options.now ?? Date.now;
  const audit = options.audit ?? ((event: AuthEvent) => { console.info(JSON.stringify(event)); });
  function emit(event: AuthEvent['event'], time: number): void { audit({ event, time }); }
  function time(): number { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw new AuthError('invalid_clock'); return value; }
  function transaction<T>(run: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch { /* fail closed */ } throw error; }
  }
  function administrator() {
    const row = db.prepare('SELECT password_digest, credential_version FROM auth_admin WHERE id = 1').get();
    if (!row) return null;
    const parsed = adminRow.safeParse(row);
    if (!parsed.success) throw new AuthError('invalid_auth_state');
    return parsed.data;
  }
  function initialized(): boolean { return administrator() !== null; }

  // Reservations happen before expensive work and survive restart. Bounded to 512 clients plus global.
  function reserveAttempt(clientKey: string, at: number): number | null {
    return transaction(() => {
      db.prepare('DELETE FROM auth_login_limits WHERE reset_at <= ?').run(at);
      const clientBucket = 'client:' + hashToken(clientKey);
      const buckets = [{ key: 'global', limit: 30, window: GLOBAL_WINDOW }, { key: clientBucket, limit: 5, window: CLIENT_WINDOW }];
      for (const bucket of buckets) {
        const row = db.prepare('SELECT attempts, reset_at FROM auth_login_limits WHERE bucket = ?').get(bucket.key) as { attempts: number; reset_at: number } | undefined;
        if (row && row.attempts >= bucket.limit) return Math.max(1, Math.ceil((row.reset_at - at) / 1000));
      }
      const existing = db.prepare('SELECT bucket FROM auth_login_limits WHERE bucket = ?').get(clientBucket);
      const count = db.prepare('SELECT COUNT(*) AS count FROM auth_login_limits WHERE bucket <> ?').get('global') as { count: number };
      if (!existing && count.count >= 512) return 60;
      for (const bucket of buckets) db.prepare('INSERT INTO auth_login_limits(bucket, attempts, reset_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1').run(bucket.key, at + bucket.window);
      return null;
    });
  }

  async function initialize(password: unknown): Promise<void> {
    const parsed = newPassword.safeParse(password);
    if (!parsed.success) throw new AuthError('password_requires_12_to_1024_characters');
    if (initialized()) throw new AuthError('admin_already_initialized');
    const encoded = await digest(parsed.data);
    const at = time();
    transaction(() => {
      if (initialized()) throw new AuthError('admin_already_initialized');
      db.prepare('INSERT INTO auth_admin(id, password_digest, credential_version, updated_at) VALUES (1, ?, 1, ?)').run(encoded, at);
    });
    emit('admin_initialized', at);
  }

  async function reset(password: unknown): Promise<void> {
    const parsed = newPassword.safeParse(password);
    if (!parsed.success) throw new AuthError('password_requires_12_to_1024_characters');
    if (!initialized()) throw new AuthError('admin_not_initialized');
    const encoded = await digest(parsed.data);
    const at = time();
    transaction(() => {
      if (!initialized()) throw new AuthError('admin_not_initialized');
      db.prepare('UPDATE auth_admin SET password_digest = ?, credential_version = credential_version + 1, updated_at = ? WHERE id = 1').run(encoded, at);
      db.exec('DELETE FROM auth_sessions; DELETE FROM auth_login_limits;');
    });
    emit('admin_reset', at);
  }

  async function login(password: unknown, input: { clientKey: string; previousToken?: string }): Promise<LoginResult> {
    const parsed = passwordInput.safeParse(password);
    const client = clientInput.safeParse(input.clientKey);
    if (!parsed.success || !client.success) return { ok: false, reason: 'invalid_credentials' };
    const at = time();
    const wait = reserveAttempt(client.data, at);
    if (wait !== null) { emit('login_limited', at); return { ok: false, reason: 'rate_limited', retryAfterSeconds: wait }; }
    const admin = administrator();
    if (!admin) return { ok: false, reason: 'not_initialized' };
    const [, salt, expected] = admin.password_digest.split('$');
    let key: Buffer;
    try { key = await derive(parsed.data, Buffer.from(salt!, 'base64url')); }
    catch (error) { if (error instanceof AuthError && error.code === 'hash_capacity_reached') return { ok: false, reason: 'busy', retryAfterSeconds: 1 }; throw error; }
    const expectedKey = Buffer.from(expected!, 'base64url');
    const valid = key.length === expectedKey.length && timingSafeEqual(key, expectedKey);
    key.fill(0); expectedKey.fill(0);
    if (!valid) { emit('login_failure', at); return { ok: false, reason: 'invalid_credentials' }; }
    const issuedAt = time();
    const token = randomBytes(32).toString('base64url');
    const session: Session = { id: randomUUID(), adminId: 1, expiresAt: issuedAt + sessionTtlMs };
    const accepted = transaction(() => {
      // A credential reset during async hashing must not mint an old-password session afterward.
      if (administrator()?.credential_version !== admin.credential_version) return false;
      db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(issuedAt);
      if (tokenInput.safeParse(input.previousToken).success) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(input.previousToken!));
      db.exec('DELETE FROM auth_sessions WHERE id IN (SELECT id FROM auth_sessions ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET 31)');
      db.prepare('INSERT INTO auth_sessions(id, token_hash, admin_id, credential_version, created_at, expires_at) VALUES (?, ?, 1, ?, ?, ?)').run(session.id, hashToken(token), admin.credential_version, issuedAt, session.expiresAt);
      db.prepare('DELETE FROM auth_login_limits WHERE bucket = ?').run('client:' + hashToken(client.data));
      return true;
    });
    if (!accepted) { emit('login_failure', issuedAt); return { ok: false, reason: 'invalid_credentials' }; }
    emit('login_success', issuedAt);
    return { ok: true, token, session };
  }

  function authenticate(token: unknown): Session | null {
    const parsed = tokenInput.safeParse(token);
    if (!parsed.success) return null;
    const at = time();
    const row = db.prepare('SELECT s.id, s.admin_id, s.expires_at FROM auth_sessions s JOIN auth_admin a ON a.id = s.admin_id AND a.credential_version = s.credential_version WHERE s.token_hash = ? AND s.expires_at > ?').get(hashToken(parsed.data), at);
    if (!row) return null;
    const value = sessionRow.safeParse(row);
    if (!value.success) throw new AuthError('invalid_auth_state');
    return { id: value.data.id, adminId: 1, expiresAt: value.data.expires_at };
  }

  function logout(token: unknown): void {
    const parsed = tokenInput.safeParse(token);
    if (!parsed.success) return;
    const result = db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(parsed.data));
    if (result.changes) emit('session_revoked', time());
  }
  return { initialized, initialize, reset, login, authenticate, logout };
}

export type AuthService = ReturnType<typeof createAuth>;

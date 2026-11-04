import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createAuthStore, type AsyncAuthStore } from './auth-store.ts';

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
const DAY = 24 * 60 * 60 * 1000;
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
export type AuthService = {
  initialized(): boolean | Promise<boolean>;
  initialize(password: unknown): Promise<void>;
  reset(password: unknown): Promise<void>;
  login(password: unknown, input: { clientKey: string; previousToken?: string }): Promise<LoginResult>;
  authenticate(token: unknown): Session | null | Promise<Session | null>;
  logout(token: unknown): void | Promise<void>;
};
type SyncAuthService = Omit<AuthService, 'initialized' | 'authenticate' | 'logout'> & { initialized(): boolean; authenticate(token: unknown): Session | null; logout(token: unknown): void };
type AsyncAuthService = Omit<AuthService, 'initialized' | 'authenticate' | 'logout'> & { initialized(): Promise<boolean>; authenticate(token: unknown): Promise<Session | null>; logout(token: unknown): Promise<void> };
export function createAuth(input: DatabaseSync, options?: AuthOptions): SyncAuthService;
export function createAuth(input: AsyncAuthStore, options?: AuthOptions): AsyncAuthService;
export function createAuth(input: DatabaseSync | AsyncAuthStore, options?: AuthOptions): AuthService;
export function createAuth(input: DatabaseSync | AsyncAuthStore, options: AuthOptions = {}): AuthService {
  const synchronous = 'prepare' in input;
  const store = synchronous ? createAuthStore(input) : input;
  const sessionTtlMs = z.number().int().min(1000).max(30 * DAY).parse(options.sessionTtlMs ?? 7 * DAY);
  const now = options.now ?? Date.now;
  const audit = options.audit ?? ((event: AuthEvent) => { console.info(JSON.stringify(event)); });
  function emit(event: AuthEvent['event'], time: number): void { audit({ event, time }); }
  function time(): number { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw new AuthError('invalid_clock'); return value; }
  function initialized() { return store.initialized(); }

  async function initialize(password: unknown): Promise<void> {
    const parsed = newPassword.safeParse(password);
    if (!parsed.success) throw new AuthError('password_requires_12_to_1024_characters');
    if (await initialized()) throw new AuthError('admin_already_initialized');
    const encoded = await digest(parsed.data);
    const at = time();
    await store.initialize(encoded, at);
    emit('admin_initialized', at);
  }

  async function reset(password: unknown): Promise<void> {
    const parsed = newPassword.safeParse(password);
    if (!parsed.success) throw new AuthError('password_requires_12_to_1024_characters');
    if (!await initialized()) throw new AuthError('admin_not_initialized');
    const encoded = await digest(parsed.data);
    const at = time();
    await store.reset(encoded, at);
    emit('admin_reset', at);
  }

  async function login(password: unknown, input: { clientKey: string; previousToken?: string }): Promise<LoginResult> {
    const parsed = passwordInput.safeParse(password);
    const client = clientInput.safeParse(input.clientKey);
    if (!parsed.success || !client.success) return { ok: false, reason: 'invalid_credentials' };
    const at = time();
    const wait = await store.reserveAttempt(hashToken(client.data), at);
    if (wait !== null) { emit('login_limited', at); return { ok: false, reason: 'rate_limited', retryAfterSeconds: wait }; }
    const admin = await store.administrator();
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
    const accepted = await store.mintSession({ expectedVersion: admin.credential_version, id: session.id, tokenHash: hashToken(token),
      ...(tokenInput.safeParse(input.previousToken).success ? { previousTokenHash: hashToken(input.previousToken!) } : {}),
      clientHash: hashToken(client.data), issuedAt, expiresAt: session.expiresAt });
    if (!accepted) { emit('login_failure', issuedAt); return { ok: false, reason: 'invalid_credentials' }; }
    emit('login_success', issuedAt);
    return { ok: true, token, session };
  }

  function authenticate(token: unknown) {
    const parsed = tokenInput.safeParse(token);
    return parsed.success ? store.authenticateHash(hashToken(parsed.data), time()) : null;
  }
  function logout(token: unknown): void | Promise<void> {
    const parsed = tokenInput.safeParse(token);
    if (!parsed.success) return;
    const result = store.logoutHash(hashToken(parsed.data));
    const settled = (changed: boolean) => { if (changed) emit('session_revoked', time()); };
    if (result instanceof Promise) return result.then(settled);
    settled(result);
  }
  const common = { initialize, reset, login };
  return synchronous ? { ...common, initialized, authenticate, logout } : {
    ...common, initialized: async () => await initialized(), authenticate: async token => await authenticate(token), logout: async token => { await logout(token); },
  };
}

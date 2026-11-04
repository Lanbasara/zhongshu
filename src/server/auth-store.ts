import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { StoreError } from './workbench-store.ts';

const digestSchema = z.string().regex(/^scrypt-v1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().nonnegative().safe();
const adminRow = z.object({ password_digest: digestSchema, credential_version: z.number().int().positive().safe() });
const sessionRow = z.object({ id: z.uuid(), admin_id: z.literal(1), expires_at: timestamp });

/** Only hashes/digests cross this private repository boundary. Expensive scrypt
 * and clocks stay outside short, complete SQLite transactions. */
export function createAuthStore(db: DatabaseSync) {
  function transaction<T>(action: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const value = action(); db.exec('COMMIT'); return value; }
    catch (error) { try { db.exec('ROLLBACK'); } catch { /* unknown commits require readback */ } throw error; }
  }
  function administrator() {
    const row = db.prepare('SELECT password_digest,credential_version FROM auth_admin WHERE id=1').get();
    if (!row) return null;
    const parsed = adminRow.safeParse(row);
    if (!parsed.success) throw new StoreError('invalid_auth_state', 500);
    return parsed.data;
  }
  return {
    administrator,
    initialized() { return administrator() !== null; },
    reserveAttempt(clientHash: string, at: number): number | null {
      hashSchema.parse(clientHash); timestamp.parse(at);
      return transaction(() => {
        db.prepare('DELETE FROM auth_login_limits WHERE reset_at<=?').run(at);
        const clientBucket = 'client:' + clientHash;
        const buckets = [{ key: 'global', limit: 30, window: 60_000 }, { key: clientBucket, limit: 5, window: 900_000 }];
        for (const bucket of buckets) {
          const row = db.prepare('SELECT attempts,reset_at FROM auth_login_limits WHERE bucket=?').get(bucket.key) as { attempts: number; reset_at: number } | undefined;
          if (row && row.attempts >= bucket.limit) return Math.max(1, Math.ceil((row.reset_at - at) / 1000));
        }
        const existing = db.prepare('SELECT bucket FROM auth_login_limits WHERE bucket=?').get(clientBucket);
        const count = db.prepare('SELECT COUNT(*) AS count FROM auth_login_limits WHERE bucket<>?').get('global') as { count: number };
        if (!existing && count.count >= 512) return 60;
        for (const bucket of buckets) db.prepare('INSERT INTO auth_login_limits(bucket,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1').run(bucket.key, at + bucket.window);
        return null;
      });
    },
    initialize(encoded: string, at: number): void {
      digestSchema.parse(encoded); timestamp.parse(at);
      transaction(() => {
        if (administrator()) throw new StoreError('admin_already_initialized', 409);
        db.prepare('INSERT INTO auth_admin(id,password_digest,credential_version,updated_at) VALUES(1,?,1,?)').run(encoded, at);
      });
    },
    reset(encoded: string, at: number): void {
      digestSchema.parse(encoded); timestamp.parse(at);
      transaction(() => {
        if (!administrator()) throw new StoreError('admin_not_initialized', 409);
        db.prepare('UPDATE auth_admin SET password_digest=?,credential_version=credential_version+1,updated_at=? WHERE id=1').run(encoded, at);
        db.exec('DELETE FROM auth_sessions; DELETE FROM auth_login_limits;');
      });
    },
    mintSession(input: { expectedVersion: number; id: string; tokenHash: string; previousTokenHash?: string; clientHash: string; issuedAt: number; expiresAt: number }): boolean {
      const value = z.object({ expectedVersion: z.number().int().positive().safe(), id: z.uuid(), tokenHash: hashSchema, previousTokenHash: hashSchema.optional(),
        clientHash: hashSchema, issuedAt: timestamp, expiresAt: timestamp }).strict().refine(value => value.expiresAt > value.issuedAt).parse(input);
      return transaction(() => {
        // A reset while scrypt is running must not mint an old-password session.
        if (administrator()?.credential_version !== value.expectedVersion) return false;
        db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(value.issuedAt);
        if (value.previousTokenHash) db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(value.previousTokenHash);
        db.exec('DELETE FROM auth_sessions WHERE id IN (SELECT id FROM auth_sessions ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 31)');
        db.prepare('INSERT INTO auth_sessions(id,token_hash,admin_id,credential_version,created_at,expires_at) VALUES(?,?,1,?,?,?)')
          .run(value.id, value.tokenHash, value.expectedVersion, value.issuedAt, value.expiresAt);
        db.prepare('DELETE FROM auth_login_limits WHERE bucket=?').run('client:' + value.clientHash);
        return true;
      });
    },
    authenticateHash(hash: string, at: number): { id: string; adminId: 1; expiresAt: number } | null {
      hashSchema.parse(hash); timestamp.parse(at);
      const row = db.prepare('SELECT s.id,s.admin_id,s.expires_at FROM auth_sessions s JOIN auth_admin a ON a.id=s.admin_id AND a.credential_version=s.credential_version WHERE s.token_hash=? AND s.expires_at>?').get(hash, at);
      if (!row) return null;
      const parsed = sessionRow.safeParse(row);
      if (!parsed.success) throw new StoreError('invalid_auth_state', 500);
      return { id: parsed.data.id, adminId: 1, expiresAt: parsed.data.expires_at };
    },
    logoutHash(hash: string): boolean { hashSchema.parse(hash); return Boolean(db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hash).changes); },
  };
}
export type AuthStore = ReturnType<typeof createAuthStore>;
export type AsyncAuthStore = { [K in keyof AuthStore]: (...args: Parameters<AuthStore[K]>) => Promise<ReturnType<AuthStore[K]>> };

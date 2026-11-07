import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pushDeviceLimit, pushMessage, pushStateSchema, pushSubscribeResponseSchema, pushSubscribeSchema, pushTestResponseSchema,
  type PushHarness, type PushKind, type PushState } from '../shared/push.ts';
import { allowedEndpoint, encryptPayload, generateVapidKeys, validSubscriptionKeys, vapidAuthorization, type VapidKeys } from './web-push.ts';

/** `title` is the conversation title (ADR 0018, 2026-11-07); it travels only inside the encrypted message. */
export type PushEvent = { kind: PushKind; conversationId?: string; harnessId?: PushHarness; title?: string };
type Device = { id: string; endpoint: string; p256dh: string; auth: string; label: string; publicKey: string; createdAt: number;
  deliveredAt: number | null; failedAt: number | null; failure: string | null };
type Delivery = { delivered: boolean; failure: string | null };

export class PushError extends Error {
  readonly code: string; readonly statusCode: number;
  constructor(code: string, statusCode: number) { super(code); this.name = 'PushError'; this.code = code; this.statusCode = statusCode; }
}

const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const deviceRow = z.object({ id: z.uuid(), endpoint: z.string(), p256dh: z.string(), auth: z.string(), label: z.string(), public_key: z.string(),
  created_at: time, delivered_at: time.nullable(), failed_at: time.nullable(), failure: z.string().nullable() });
const keyRow = z.object({ public_key: z.string(), private_key: z.string() });
const fingerprint = (endpoint: string) => createHash('sha256').update(endpoint).digest('base64url').slice(0, 22);
/** Push services hold an undelivered message this long, then drop it (ADR 0018). */
const ttlSeconds = 12 * 3600;
const sendsPerMinute = 120;

/**
 * Per-device push subscriptions and delivery (ADR 0018). The instance key is created on first use and kept in
 * the instance database; endpoints are capability URLs, so they never leave the server or reach a log.
 */
export function createPush(db: DatabaseSync, options: {
  origin: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (event: Record<string, string | number>) => void;
  /** Current unread count for the app badge; omitted when it cannot be read. */
  badge?: () => number | undefined;
}) {
  const now = options.now ?? Date.now;
  const send = options.fetch ?? fetch;
  const log = (event: Record<string, string | number>) => { try { options.log?.(event); } catch { /* logging never breaks delivery */ } };
  // RFC 8292 asks for a contact; an HTTPS instance origin is one, a loopback development origin is not.
  const subject = options.origin.startsWith('https:') ? options.origin : 'mailto:zhongshu@localhost';
  const inflight = new Set<AbortController>();
  const recent: number[] = [];
  let closed = false;

  function keys(): VapidKeys {
    const existing = db.prepare('SELECT public_key, private_key FROM push_keys WHERE id = 1').get();
    if (existing) { const row = keyRow.parse(existing); return { publicKey: row.public_key, privateKey: row.private_key }; }
    const created = generateVapidKeys();
    // A concurrent first use keeps whichever key was written first.
    db.prepare('INSERT OR IGNORE INTO push_keys(id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)').run(created.publicKey, created.privateKey, now());
    return keys();
  }
  const fromRow = (value: unknown): Device => {
    const row = deviceRow.parse(value);
    return { id: row.id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, label: row.label, publicKey: row.public_key, createdAt: row.created_at,
      deliveredAt: row.delivered_at, failedAt: row.failed_at, failure: row.failure };
  };
  const devices = (): Device[] => db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at, id').all().map(fromRow);
  const device = (id: string): Device | undefined => { const row = db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(z.uuid().parse(id)); return row ? fromRow(row) : undefined; };

  function state(): PushState {
    const { publicKey } = keys();
    return pushStateSchema.parse({ publicKey, devices: devices().map(value => ({ id: value.id, label: value.label, fingerprint: fingerprint(value.endpoint),
      createdAt: value.createdAt, deliveredAt: value.deliveredAt, failedAt: value.failedAt, failure: value.failure, current: value.publicKey === publicKey })) });
  }
  /** The same endpoint is the same device: re-enabling refreshes its keys instead of adding a second row. */
  function subscribe(input: unknown): { id: string } {
    const parsed = pushSubscribeSchema.safeParse(input);
    if (!parsed.success) throw new PushError('invalid_request', 400);
    const { endpoint, keys: subscription, label } = parsed.data;
    if (!allowedEndpoint(endpoint)) throw new PushError('push_service_not_allowed', 400);
    if (!validSubscriptionKeys(subscription)) throw new PushError('invalid_subscription_keys', 400);
    const { publicKey } = keys();
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
      let id: string;
      if (existing) {
        id = z.uuid().parse(existing.id);
        db.prepare('UPDATE push_subscriptions SET p256dh=?, auth=?, label=?, public_key=?, failed_at=NULL, failure=NULL WHERE id=?')
          .run(subscription.p256dh, subscription.auth, label, publicKey, id);
      } else {
        const count = Number(db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get()!.count);
        if (count >= pushDeviceLimit) throw new PushError('push_device_limit', 409);
        id = randomUUID();
        db.prepare('INSERT INTO push_subscriptions(id, endpoint, p256dh, auth, label, public_key, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, endpoint, subscription.p256dh, subscription.auth, label, publicKey, now());
      }
      db.exec('COMMIT');
      log({ event: 'push_subscription_changed', action: existing ? 'refresh' : 'add' });
      return pushSubscribeResponseSchema.parse({ id });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function remove(id: string, reason: 'remove' | 'expired' = 'remove'): boolean {
    const removed = db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(z.uuid().parse(id)).changes > 0;
    if (removed) log({ event: 'push_subscription_changed', action: reason });
    return removed;
  }

  function admitted(): boolean {
    const cutoff = now() - 60_000;
    while (recent.length && recent[0]! < cutoff) recent.shift();
    if (recent.length >= sendsPerMinute) return false;
    recent.push(now()); return true;
  }
  async function deliver(target: Device, event: PushEvent): Promise<Delivery> {
    const instance = keys();
    if (target.publicKey !== instance.publicKey) return record(target, { delivered: false, failure: 'subscription_key_changed' });
    if (closed) return { delivered: false, failure: 'push_closed' };
    if (!admitted()) return record(target, { delivered: false, failure: 'push_rate_limited' });
    let badge: number | undefined;
    try { badge = options.badge?.(); } catch { badge = undefined; }
    const body = encryptPayload(Buffer.from(JSON.stringify(pushMessage(event, badge))), { p256dh: target.p256dh, auth: target.auth });
    const headers: Record<string, string> = {
      Authorization: vapidAuthorization(target.endpoint, instance, subject, now()),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttlSeconds), Urgency: 'high',
    };
    // A newer message for the same conversation replaces one the push service is still holding.
    if (event.conversationId) headers.Topic = createHash('sha256').update(`conversation:${event.conversationId}`).digest('base64url').slice(0, 32);
    const controller = new AbortController(); inflight.add(controller);
    try {
      const response = await send(target.endpoint, { method: 'POST', headers, body: new Uint8Array(body), redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      await response.body?.cancel().catch(() => {});
      if (response.status >= 200 && response.status < 300) return record(target, { delivered: true, failure: null });
      if (response.status === 404 || response.status === 410) { remove(target.id, 'expired'); return { delivered: false, failure: 'subscription_expired' }; }
      log({ event: 'push_delivery_failed', status: response.status });
      return record(target, { delivered: false, failure: `push_service_${response.status}` });
    } catch {
      log({ event: 'push_delivery_failed', status: 0 });
      return record(target, { delivered: false, failure: 'push_service_unreachable' });
    } finally { inflight.delete(controller); }
  }
  function record(target: Device, result: Delivery): Delivery {
    if (closed) return result;
    try {
      if (result.delivered) db.prepare('UPDATE push_subscriptions SET delivered_at=?, failed_at=NULL, failure=NULL WHERE id=?').run(now(), target.id);
      else db.prepare('UPDATE push_subscriptions SET failed_at=?, failure=? WHERE id=?').run(now(), result.failure, target.id);
    } catch { /* bookkeeping only */ }
    return result;
  }
  /** Fire-and-forget fan-out to every device; failures are recorded per device and never thrown. */
  async function notify(event: PushEvent): Promise<void> {
    if (closed) return;
    let targets: Device[];
    try { targets = devices(); } catch { return; }
    await Promise.allSettled(targets.map(target => deliver(target, event)));
  }
  async function test(id: string): Promise<Delivery> {
    const target = device(id);
    if (!target) throw new PushError('push_device_not_found', 404);
    return deliver(target, { kind: 'test' });
  }
  function close(): void { closed = true; for (const controller of inflight) controller.abort(); }

  async function routes(app: FastifyInstance): Promise<void> {
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof PushError) return reply.code(error.statusCode).send({ error: error.code });
      const code = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
      const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
      if (status === 500) app.log.error({ event: 'push_request_failed' });
      return reply.code(status).send({ error: status === 500 ? 'push_unavailable' : 'invalid_request' });
    });
    const noQuery = z.object({}).strict();
    const params = z.object({ id: z.uuid() }).strict();
    const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const parsed = schema.safeParse(value); if (!parsed.success) throw new PushError('invalid_request', 400); return parsed.data; };
    app.get('/', async request => { parse(noQuery, request.query); return state(); });
    app.post('/devices', { bodyLimit: 8192 }, async request => { parse(noQuery, request.query); return subscribe(request.body); });
    app.post('/devices/:id/remove', { bodyLimit: 1024 }, async request => {
      parse(noQuery, request.query); const { id } = parse(params, request.params);
      if (!remove(id)) throw new PushError('push_device_not_found', 404);
      return { ok: true };
    });
    app.post('/devices/:id/test', { bodyLimit: 1024 }, async request => {
      parse(noQuery, request.query); const { id } = parse(params, request.params);
      return pushTestResponseSchema.parse(await test(id));
    });
  }

  return { state, subscribe, remove, notify, test, close, routes };
}
export type Push = ReturnType<typeof createPush>;

import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHash, hkdfSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import { createAuth } from '../src/server/auth.ts';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createPush, type PushEvent } from '../src/server/push.ts';
import { createPushTriggers } from '../src/server/push-triggers.ts';
import type { Conversation } from '../src/server/workbench-store.ts';
import { pushDeviceLimit, pushStateSchema } from '../src/shared/push.ts';

type Sent = { url: string; headers: Record<string, string>; body: Buffer };
function browser() {
  const receiver = createECDH('prime256v1'); receiver.generateKeys();
  const auth = Buffer.alloc(16, Math.floor(Math.random() * 255));
  const id = Math.random().toString(36).slice(2);
  return {
    subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    /** What the browser's service worker would read. */
    decrypt(body: Buffer): unknown {
      const salt = body.subarray(0, 16); const sender = body.subarray(21, 86);
      const ikm = Buffer.from(hkdfSync('sha256', receiver.computeSecret(sender), auth, Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), sender]), 32));
      const decipher = createDecipheriv('aes-128-gcm', Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)),
        Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
      const sealed = body.subarray(86); decipher.setAuthTag(sealed.subarray(-16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
      assert.equal(plain.at(-1), 2);
      return JSON.parse(plain.subarray(0, -1).toString());
    },
  };
}
async function fixture(t: TestContext, respond: (sent: Sent) => number = () => 201) {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-push-'));
  const db = openDatabase(directory, productMigrations);
  const sent: Sent[] = []; const logs: Record<string, string | number>[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = { url: String(url), headers: init!.headers as Record<string, string>, body: Buffer.from(init!.body as Uint8Array) };
    sent.push(value);
    return new Response(null, { status: respond(value) });
  }) as typeof fetch;
  const push = createPush(db, { origin: 'https://zhongshu.example', fetch: fakeFetch, log: event => logs.push(event), badge: () => 3 });
  t.after(async () => { push.close(); db.close(); await rm(directory, { recursive: true }); });
  return { db, push, sent, logs };
}

test('a subscription is validated, kept once per endpoint and bounded', async t => {
  const { push } = await fixture(t);
  const phone = browser();
  const first = push.subscribe({ ...phone.subscription, label: 'Android · Chrome' });
  assert.equal(push.subscribe({ ...phone.subscription, label: 'Android · Chrome 2' }).id, first.id, 'the same endpoint is the same device');
  const state = pushStateSchema.parse(push.state());
  assert.equal(state.devices.length, 1);
  assert.equal(state.devices[0]!.label, 'Android · Chrome 2');
  assert.equal(state.devices[0]!.fingerprint, createHash('sha256').update(phone.subscription.endpoint).digest('base64url').slice(0, 22));
  assert.equal(state.devices[0]!.current, true);
  assert.equal(JSON.stringify(state).includes(phone.subscription.endpoint), false, 'endpoints never leave the server');
  assert.equal(push.state().publicKey, state.publicKey, 'the instance key is created once');
  for (const [input, code] of [
    [{ ...phone.subscription, endpoint: 'https://evil.example/push', label: 'x' }, 'push_service_not_allowed'],
    [{ ...phone.subscription, endpoint: 'https://fcm.googleapis.com/x', keys: { ...phone.subscription.keys, auth: 'AAAA' }, label: 'x' }, 'invalid_subscription_keys'],
    [{ ...phone.subscription, label: '<script>' }, 'invalid_request'],
    [{ ...phone.subscription, label: 'x', extra: true }, 'invalid_request'],
  ] as const) assert.throws(() => push.subscribe(input), (error: Error & { code?: string }) => error.code === code);
  for (let index = 1; index < pushDeviceLimit; index++) push.subscribe({ ...browser().subscription, label: `Device ${index}` });
  assert.throws(() => push.subscribe({ ...browser().subscription, label: 'One too many' }), (error: Error & { code?: string }) => error.code === 'push_device_limit');
});

test('delivery is encrypted for each device and carries only the event, the conversation title, an entry and the unread count', async t => {
  const { push, sent, logs } = await fixture(t);
  const phone = browser(); const desktop = browser();
  push.subscribe({ ...phone.subscription, label: 'Android · Chrome' });
  push.subscribe({ ...desktop.subscription, label: 'macOS · Chrome' });
  const conversationId = '11111111-1111-4111-8111-111111111111';
  await push.notify({ kind: 'completed', conversationId, harnessId: 'codex', title: '周报改版\n第二行' });
  assert.equal(sent.length, 2);
  const toPhone = sent.find(value => value.url === phone.subscription.endpoint)!;
  assert.deepEqual(phone.decrypt(toPhone.body), { v: 1, kind: 'completed', title: '周报改版 第二行', body: 'Codex 已完成，点开查看结果。', url: `/#${conversationId}`, tag: `conversation:${conversationId}`, badge: 3 });
  assert.throws(() => desktop.decrypt(toPhone.body), 'another device cannot read it');
  assert.equal(toPhone.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(toPhone.headers.TTL, '43200');
  assert.equal(toPhone.headers.Urgency, 'high');
  assert.match(toPhone.headers.Topic!, /^[A-Za-z0-9_-]{32}$/);
  assert.match(toPhone.headers.Authorization!, new RegExp(`^vapid t=[^ ]+, k=${push.state().publicKey}$`));
  const devices = push.state().devices;
  assert.ok(devices.every(device => device.deliveredAt !== null && device.failure === null));
  assert.deepEqual(logs.filter(event => event.event !== 'push_subscription_changed'), []);
});

test('a gone subscription is removed, other failures are recorded, and logs never carry endpoints', async t => {
  const phone = browser(); const desktop = browser();
  const { push, logs } = await fixture(t, sent => sent.url === phone.subscription.endpoint ? 410 : 500);
  const kept = push.subscribe({ ...desktop.subscription, label: 'macOS · Chrome' });
  push.subscribe({ ...phone.subscription, label: 'Android · Chrome' });
  await push.notify({ kind: 'failed', conversationId: '11111111-1111-4111-8111-111111111111', harnessId: 'dsh' });
  const devices = push.state().devices;
  assert.deepEqual(devices.map(device => device.id), [kept.id]);
  assert.equal(devices[0]!.failure, 'push_service_500');
  assert.deepEqual(await push.test(kept.id), { delivered: false, failure: 'push_service_500' });
  assert.ok(logs.some(event => event.event === 'push_subscription_changed' && event.action === 'expired'));
  assert.equal(JSON.stringify(logs).includes('fcm.googleapis.com'), false);
});

function conversation(id: string, state: Partial<Conversation['state']>, archived = false): Conversation {
  return { id, title: '周报改版', harnessId: 'codex', archived, state: { status: 'idle', pendingInputs: 0, configurationVerified: true, ...state } } as Conversation;
}
test('triggers fire for unseen results of runs and for waiting, and stay quiet for readers, stops and repeats', async () => {
  const values = new Map<string, Conversation>(); const unseen = new Set<string>(); const reading = new Set<string>();
  const events: PushEvent[] = [];
  const id = '11111111-1111-4111-8111-111111111111';
  const inFlight = '22222222-2222-4222-8222-222222222222';
  values.set(inFlight, conversation(inFlight, { status: 'running', runId: 'r0' }));
  const triggers = createPushTriggers({
    conversation: key => values.get(key) ?? null,
    unread: list => new Set(list.map(value => value.id).filter(key => unseen.has(key))),
    isReading: key => reading.has(key), active: () => [...values.values()],
  }, event => events.push(event));
  const step = async (key: string, state: Partial<Conversation['state']>, options: { unseen?: boolean } = {}) => {
    values.set(key, conversation(key, state));
    if (options.unseen) unseen.add(key); else unseen.delete(key);
    triggers.changed({ sequence: 1, conversationId: key }); await tick();
  };
  // A run already in flight at startup still reports its result.
  await step(inFlight, { status: 'idle', terminalStatus: 'completed', terminalRunId: 'r0' }, { unseen: true });
  assert.deepEqual(events.splice(0), [{ kind: 'completed', conversationId: inFlight, harnessId: 'codex', title: '周报改版' }]);
  // First sight of a settled conversation reports nothing.
  await step(id, { status: 'idle', terminalStatus: 'completed', terminalRunId: 'r1' }, { unseen: true });
  assert.deepEqual(events, []);
  await step(id, { status: 'running', runId: 'r2' });
  await step(id, { status: 'waiting', runId: 'r2' });
  await step(id, { status: 'waiting', runId: 'r2' });
  assert.deepEqual(events.splice(0), [{ kind: 'waiting', conversationId: id, harnessId: 'codex', title: '周报改版' }], 'waiting notifies once');
  await step(id, { status: 'unknown', runId: 'r2' });
  await step(id, { status: 'failed', terminalStatus: 'failed', terminalRunId: 'r2' }, { unseen: true });
  assert.deepEqual(events.splice(0), [{ kind: 'failed', conversationId: id, harnessId: 'codex', title: '周报改版' }], 'a lost observation still reports the result');
  await step(id, { status: 'failed', terminalStatus: 'failed', terminalRunId: 'r2' }, { unseen: true });
  assert.deepEqual(events, [], 'the same result never notifies twice');
  // Read, or stopped by the user: the result is not unseen.
  reading.add(id);
  await step(id, { status: 'running', runId: 'r3' });
  await step(id, { status: 'waiting', runId: 'r3' });
  await step(id, { status: 'idle', terminalStatus: 'completed', terminalRunId: 'r3' });
  reading.delete(id);
  await step(id, { status: 'running', runId: 'r4' });
  await step(id, { status: 'interrupted', terminalStatus: 'interrupted', terminalRunId: 'r4' });
  assert.deepEqual(events, []);
  // A run that started and ended between two observations is still new.
  await step(id, { status: 'idle', terminalStatus: 'completed', terminalRunId: 'r5' }, { unseen: true });
  assert.deepEqual(events.splice(0), [{ kind: 'completed', conversationId: id, harnessId: 'codex', title: '周报改版' }]);
  // Live item deltas and archived conversations never notify.
  triggers.changed({ sequence: 2, conversationId: id, itemId: 'item' }); await tick();
  values.set(id, conversation(id, { status: 'waiting', runId: 'r6' }, true)); triggers.changed({ sequence: 3, conversationId: id }); await tick();
  assert.deepEqual(events, []);
  triggers.close();
});

test('push routes sit behind authentication and CSRF', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-push-http-'));
  const db = openDatabase(directory, productMigrations);
  const password = 'synthetic-test-password-only';
  await createAuth(db, { audit: () => {} }).initialize(password);
  const origin = 'https://workbench.example';
  const push = createPush(db, { origin, fetch: (async () => new Response(null, { status: 201 })) as typeof fetch });
  const app = await buildApp({ db, origin, privateRoutes: async scope => { await scope.register(push.routes, { prefix: '/push' }); } });
  t.after(async () => { push.close(); await app.close(); db.close(); await rm(directory, { recursive: true }); });
  assert.equal((await app.inject({ method: 'GET', url: '/api/private/push' })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin }, payload: { password } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const csrf = login.json().csrfToken as string;
  const phone = browser();
  const post = (url: string, payload: object, headers: Record<string, string> = { 'x-csrf-token': csrf }) =>
    app.inject({ method: 'POST', url, headers: { origin, cookie, ...headers }, payload });
  assert.equal((await post('/api/private/push/devices', { ...phone.subscription, label: 'Android · Chrome' }, {})).statusCode, 403);
  const added = await post('/api/private/push/devices', { ...phone.subscription, label: 'Android · Chrome' });
  assert.equal(added.statusCode, 200);
  const { id } = added.json() as { id: string };
  const state = await app.inject({ method: 'GET', url: '/api/private/push', headers: { cookie } });
  assert.equal(pushStateSchema.parse(state.json()).devices[0]!.id, id);
  assert.deepEqual((await post(`/api/private/push/devices/${id}/test`, {})).json(), { delivered: true, failure: null });
  assert.equal((await post('/api/private/push/devices', { ...phone.subscription, endpoint: 'https://evil.example/x', label: 'x' })).json().error, 'push_service_not_allowed');
  assert.equal((await post(`/api/private/push/devices/${id}/remove`, {})).statusCode, 200);
  assert.equal((await post(`/api/private/push/devices/${id}/remove`, {})).json().error, 'push_device_not_found');
});

test('notification titles are one bounded line; without a title the event heads the notification', async () => {
  const { pushMessage, notificationTitle } = await import('../src/shared/push.ts');
  assert.equal(notificationTitle('  a\u0000b\u2028c  '), 'a b c');
  assert.equal([...notificationTitle('字'.repeat(200))].length, 80);
  assert.equal(notificationTitle('字'.repeat(200)).endsWith('…'), true);
  assert.deepEqual(pushMessage({ kind: 'waiting', conversationId: '11111111-1111-4111-8111-111111111111', harnessId: 'dsh' }),
    { v: 1, kind: 'waiting', title: 'DSH 在等你回答或批准', body: '点开处理。', url: '/#11111111-1111-4111-8111-111111111111', tag: 'conversation:11111111-1111-4111-8111-111111111111' });
  assert.equal(pushMessage({ kind: 'test', title: 'ignored' }).title, '中书测试通知');
});

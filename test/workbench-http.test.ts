import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import type { HarnessAdapter, NativeItem, NativeState, Receipt } from '../src/harness/types.ts';
import { openDatabase } from '../src/server/database.ts';
import { createAuth } from '../src/server/auth.ts';
import { buildApp } from '../src/server/app.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { Workbench } from '../src/server/workbench.ts';
import { createWorkbenchHttp } from '../src/server/workbench-http.ts';
import { changeEventSchema, snapshotSchema, workbenchConfigurationSchema } from '../src/shared/workbench.ts';

const origin = 'https://workbench.example';
const configuration = { modelId: 'synthetic-model', permissionId: 'workspace-write' };
const nativeState: NativeState = { status: 'idle', pendingInputs: 0, configurationVerified: true };
async function eventually(check: () => Promise<boolean> | boolean, timeout = 4000): Promise<void> {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('bounded condition was not observed');
}

async function fixture(t: TestContext, limits: Parameters<typeof createWorkbenchHttp>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-workbench-http-'));
  const db = openDatabase(directory, productMigrations);
  const auth = createAuth(db, { audit: () => {} });
  const password = randomBytes(32).toString('base64url'); await auth.initialize(password);
  let transport: ReturnType<typeof createWorkbenchHttp>;
  const store = createWorkbenchStore(db, { onChange: change => transport?.changed(change) });
  const submissions: string[] = []; let receipt: Receipt = { outcome: 'unknown', reason: 'synthetic_receipt_lost' };
  const adapter: HarnessAdapter = {
    id: 'dsh',
    async catalog() { return { id: 'dsh', available: true, models: [{ id: configuration.modelId, label: 'Synthetic model' }], permissions: [{ id: configuration.permissionId, label: 'Workspace', description: 'Synthetic test only' }] }; },
    async create(input, onBound) { const binding = { id: 'private-native-binding', cwd: input.cwd, configuration: input.configuration, details: { privateNativeField: 'never-public' } }; onBound(binding); return binding; },
    async state() { return nativeState; }, async history() { return { items: [], olderCursor: null }; },
    async submit(_binding, operation) { submissions.push(operation.id); return receipt; },
    async reconcile() { return { outcome: 'accepted', runId: 'synthetic-turn' }; },
    async stop() { return { outcome: 'accepted', runId: 'synthetic-turn' }; },
    async watch() { return () => {}; }, async close() {},
  };
  const workbench = new Workbench(store, [{ id: 'fixture', label: 'Synthetic workspace', directory: '/operator-only/synthetic-workspace' }], new Map([['dsh', adapter]]));
  transport = createWorkbenchHttp(workbench, { heartbeatMs: 50, ...limits });
  const app = await buildApp({ db, origin, privateRoutes: transport.routes, onLogout: transport.logout });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const controllers = new Set<AbortController>();
  t.after(async () => {
    for (const controller of controllers) controller.abort(); transport.close(); await workbench.close(); await app.close(); db.close(); await rm(directory, { recursive: true });
  });
  async function login() {
    const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const body = await response.json() as { csrfToken: string };
    return { cookie: response.headers.getSetCookie()[0]!.split(';')[0]!, csrf: body.csrfToken };
  }
  const credentials = await login();
  async function request(path: string, input: { method?: string; body?: unknown; headers?: Record<string, string>; authenticated?: boolean } = {}) {
    const response = await fetch(base + (path.startsWith('/api/') ? path : '/api/private/workbench' + path), {
      method: input.method ?? 'GET', signal: AbortSignal.timeout(8000),
      headers: { ...(input.authenticated === false ? {} : { cookie: credentials.cookie, 'x-csrf-token': credentials.csrf }), origin,
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }), ...input.headers },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  }
  function seed() {
    const id = randomUUID();
    store.createConversation({ id, harnessId: 'dsh', workspaceId: 'fixture', cwd: '/operator-only/synthetic-workspace', title: '<synthetic title>', configuration });
    store.saveBinding(id, { id: 'private-native-binding', cwd: '/operator-only/synthetic-workspace', configuration, details: { privateNativeField: 'never-public' } });
    store.setConversationState(id, { readiness: 'ready', state: nativeState });
    return id;
  }
  async function stream(query = '', headers: Record<string, string> = {}) {
    const controller = new AbortController(); controllers.add(controller);
    const response = await fetch(`${base}/api/private/workbench/events${query}`, { headers: { cookie: credentials.cookie, ...headers }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffered = '';
    async function next() {
      while (true) {
        const end = buffered.indexOf('\n\n');
        if (end >= 0) {
          const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2);
          const name = frame.match(/^event: (.+)$/m)?.[1]; if (!name) continue;
          return { name, id: frame.match(/^id: (.+)$/m)?.[1], data: JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? '{}') as any };
        }
        const result = await reader.read(); if (result.done) return null;
        buffered += decoder.decode(result.value, { stream: true }); assert.ok(buffered.length < 512 * 1024);
      }
    }
    async function named(name: string) { while (true) { const event = await next(); if (!event || event.name === name) return event; } }
    return { response, next, named, reader, close: () => { controller.abort(); controllers.delete(controller); } };
  }
  return { db, auth, store, workbench, transport, app, base, credentials, login, request, seed, stream, submissions, setReceipt(value: Receipt) { receipt = value; } };
}

test('workbench real HTTP enforces authentication, input limits and the public DTO boundary', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/configuration', { authenticated: false })).status, 401);
  assert.equal((await f.request('/events', { authenticated: false })).status, 401);
  const config = await f.request('/configuration'); assert.equal(config.status, 200);
  assert.deepEqual(workbenchConfigurationSchema.parse(config.body).workspaces, [{ id: 'fixture', label: 'Synthetic workspace' }]);
  const create = { id: randomUUID(), harnessId: 'dsh', workspaceId: 'fixture', configuration };
  assert.equal((await f.request('/conversations', { method: 'POST', body: create, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await f.request('/conversations', { method: 'POST', body: create, headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await f.request('/conversations', { method: 'POST', body: { ...create, cwd: '/arbitrary' } })).status, 400);
  assert.equal((await f.request('/conversations/not-a-uuid')).status, 400);
  assert.equal((await f.request('/configuration?extra=1')).status, 400);
  const accepted = await f.request('/conversations', { method: 'POST', body: create }); assert.equal(accepted.status, 202);
  await eventually(() => f.store.getConversation(create.id)?.readiness === 'ready');
  const snapshot = await f.request(`/conversations/${create.id}`); assert.equal(snapshot.status, 200); snapshotSchema.parse(snapshot.body);
  for (const hidden of ['cwd', 'binding', 'details', 'nativeOlderCursor', '/operator-only', 'never-public']) assert.ok(!JSON.stringify(snapshot.body).includes(hidden), hidden);
  const oversized = await f.request(`/conversations/${create.id}/operations`, { method: 'POST', body: { id: randomUUID(), type: 'message', payload: { text: 'x'.repeat(16_001) } } });
  assert.equal(oversized.status, 400);
  assert.equal((await f.request('/conversations', { method: 'POST', body: { ...create, title: 'x'.repeat(70_000) } })).status, 413);
  const malformed = await fetch(`${f.base}/api/private/workbench/conversations`, { method: 'POST', headers: { cookie: f.credentials.cookie, origin, 'x-csrf-token': f.credentials.csrf, 'content-type': 'application/json' }, body: '{"__proto__":{"admin":true}}', signal: AbortSignal.timeout(5000) });
  assert.equal(malformed.status, 400); await malformed.arrayBuffer();
});

test('HTTP receipt loss retains stable operation identity and reconciliation never resends', async t => {
  const f = await fixture(t); const id = f.seed(); const operationId = randomUUID();
  const body = { id: operationId, type: 'message', payload: { text: 'Synthetic message, no real Harness.' } };
  // Deliberately discard the actual HTTP receipt; the caller retains only its original UUID.
  const response = await fetch(`${f.base}/api/private/workbench/conversations/${id}/operations`, { method: 'POST', headers: { cookie: f.credentials.cookie, origin, 'x-csrf-token': f.credentials.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
  await eventually(() => f.store.getOperation(operationId)?.status === 'unknown');
  const recovered = await f.request(`/operations/${operationId}`); assert.equal(recovered.body.operation.status, 'unknown');
  assert.equal('payload' in recovered.body.operation, false); assert.equal('digest' in recovered.body.operation, false);
  const replay = await f.request(`/conversations/${id}/operations`, { method: 'POST', body }); assert.equal(replay.status, 202);
  const conflict = await f.request(`/conversations/${id}/operations`, { method: 'POST', body: { ...body, payload: { text: 'Different body' } } });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error, 'operation_id_conflict');
  const reconciled = await f.request(`/conversations/${id}/reconcile`, { method: 'POST', body: {} });
  assert.equal(reconciled.status, 200); assert.equal(reconciled.body.operations.find((item: { id: string }) => item.id === operationId).status, 'accepted');
  assert.deepEqual(f.submissions, [operationId]);
});

test('SSE preserves security headers, replays durable changes and resets expired cursors', async t => {
  const f = await fixture(t); const id = f.seed(); const cut = f.store.version();
  const first = await f.stream(`?cursor=${cut}`); assert.equal(first.response.status, 200);
  assert.match(first.response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(first.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(first.response.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.match(first.response.headers.get('cache-control')!, /no-store/);
  assert.equal((await first.named('ready'))?.data.revision, cut);
  assert.ok(await first.named('heartbeat'));
  f.store.saveLiveItem(id, { id: 'live-one', kind: 'assistant', status: 'running', text: 'first body' });
  const emitted = (await first.named('change'))!; changeEventSchema.parse(emitted.data);
  assert.equal(emitted.data.item.text, 'first body'); assert.equal(emitted.id, String(emitted.data.revision)); first.close();
  f.store.saveLiveItem(id, { id: 'live-one', kind: 'assistant', status: 'running', text: 'full current body after disconnect' });
  const replay = await f.stream('?cursor=0', { 'last-event-id': emitted.id! }); await replay.named('ready');
  const resumed = (await replay.named('change'))!; assert.equal(resumed.data.revision, emitted.data.revision + 1);
  assert.equal(resumed.data.item.id, 'live-one'); assert.equal(resumed.data.item.text, 'full current body after disconnect'); replay.close();
  assert.equal((await f.request('/events?cursor=1e3')).status, 400);
  assert.equal((await f.request('/events?cursor=9007199254740992')).status, 400);
  for (let index = 0; index < 2002; index++) f.store.setConversationState(id, { error: `synthetic-history-${index}` });
  const expired = await f.stream('?cursor=0'); await expired.named('ready');
  const reset = (await expired.named('reset'))!; assert.equal(reset.data.revision, f.store.version()); assert.equal(reset.id, String(f.store.version())); expired.close();
});

test('logout closes only its session stream, and reset blocks the next event before heartbeat', async t => {
  const f = await fixture(t, { heartbeatMs: 5000 }); const id = f.seed();
  const first = await f.stream(); await first.named('ready');
  const secondCredentials = await f.login(); const second = await f.stream('', { cookie: secondCredentials.cookie }); await second.named('ready');
  const end = first.next().then(value => value === null, () => true);
  assert.equal((await f.request('/api/private/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal(await end, true);
  f.store.saveLiveItem(id, { id: 'after-logout', kind: 'notice', status: 'completed', text: 'Second session still authorized' });
  assert.equal((await second.named('change'))!.data.item.text, 'Second session still authorized');
  await f.auth.reset(randomBytes(32).toString('base64url'));
  const revoked = second.next().then(value => value === null, () => true);
  f.store.saveLiveItem(id, { id: 'after-reset', kind: 'notice', status: 'completed', text: 'Must not reach revoked reader' });
  assert.equal(await revoked, true);
});

test('SSE capacity is released after client disconnect and app shutdown closes active streams', async t => {
  const f = await fixture(t, { maxConnections: 1, maxConnectionsPerSession: 1 });
  const first = await f.stream(); await first.named('ready');
  const excess = await f.request('/events'); assert.equal(excess.status, 429); assert.equal(excess.body.error, 'event_connection_limit'); first.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  const replacement = await f.stream(); assert.equal(replacement.response.status, 200); await replacement.named('ready');
  const ended = replacement.next().then(value => value === null, () => true);
  await f.app.close(); assert.equal(await ended, true);
});

test('idle streams recheck revoked credentials, while oversized events fall back to complete HTTP bodies', async t => {
  const f = await fixture(t); const id = f.seed();
  const stream = await f.stream(); await stream.named('ready');
  const text = 'Synthetic long body '.repeat(8000);
  f.store.saveLiveItem(id, { id: 'long-live', kind: 'assistant', status: 'running', text });
  const change = (await stream.named('change'))!; assert.equal(change.data.item, undefined);
  assert.equal((await f.request(`/conversations/${id}`)).body.history.liveItems.find((item: NativeItem) => item.id === 'long-live').text, text);
  await f.auth.reset(randomBytes(32).toString('base64url'));
  const revokedAt = Date.now();
  const ended = async () => { try { while (await stream.next()) { /* already-buffered heartbeat frames contain no private data */ } } catch { /* socket closed by credential check */ } };
  await ended();
  assert.ok(Date.now() - revokedAt < 1000, 'server heartbeat must close before the client safety timeout');
});

test('history byte pagination preserves complete messages and reports bounded live output', async t => {
  const f = await fixture(t); const id = f.seed();
  const items: NativeItem[] = Array.from({ length: 16 }, (_, index) => ({ id: `large-${index}`, kind: 'assistant', status: 'completed', text: String(index).padStart(2, '0') + 'x'.repeat(1024 * 1024 - 2) }));
  f.store.mergeHistory(id, items);
  const first = await f.request(`/conversations/${id}`); assert.equal(first.status, 200); snapshotSchema.parse(first.body);
  assert.ok(first.body.history.items.length < items.length); assert.ok(first.body.history.hasOlder);
  assert.equal(first.body.history.items.at(-1).id, 'large-15');
  const older = await f.request(`/conversations/${id}/older?beforeItemId=${encodeURIComponent(first.body.history.olderBeforeItemId)}`);
  assert.equal(older.status, 200); assert.ok(older.body.history.items.every((item: NativeItem) => !first.body.history.items.some((previous: NativeItem) => previous.id === item.id)));
  for (const item of [...first.body.history.items, ...older.body.history.items]) assert.equal(item.text, items.find(candidate => candidate.id === item.id)!.text);
  f.store.saveLiveItem(id, { id: 'huge-live', kind: 'assistant', status: 'running', text: '\u0001'.repeat(1024 * 1024) });
  const limited = await f.request(`/conversations/${id}`); assert.equal(limited.status, 200); assert.equal(limited.body.history.liveItemsLimited, true);
  assert.ok(Buffer.byteLength(JSON.stringify(limited.body)) < 12 * 1024 * 1024);
});

test('a real non-reading TCP client is evicted under backpressure without an unbounded event queue', async t => {
  const f = await fixture(t, { maxConnections: 1, maxConnectionsPerSession: 1, slowClientMs: 100 }); const id = f.seed();
  const paused = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = httpGet(`${f.base}/api/private/workbench/events`, { headers: { cookie: f.credentials.cookie } }, response => { response.pause(); resolve(response); });
    request.setTimeout(8000, () => request.destroy()); request.on('error', reject); t.after(() => request.destroy());
  });
  assert.equal(paused.statusCode, 200); paused.on('error', () => {});
  const text = '\u0001'.repeat(7900);
  for (let index = 0; index < 700; index++) f.store.saveLiveItem(id, { id: 'backpressure', kind: 'assistant', status: 'running', text: text + String(index) });
  await new Promise(resolve => setTimeout(resolve, 400));
  const replacement = await f.stream(); assert.equal(replacement.response.status, 200, 'slow client connection slot must be released');
  await replacement.named('ready'); replacement.close(); paused.destroy();
});

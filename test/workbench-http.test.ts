import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import type { HarnessAdapter, NativeChange, NativeItem, NativeState, Receipt } from '../src/harness/types.ts';
import { openDatabase } from '../src/server/database.ts';
import { createAuth } from '../src/server/auth.ts';
import { buildApp } from '../src/server/app.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { Workbench } from '../src/server/workbench.ts';
import { createWorkbenchHttp } from '../src/server/workbench-http.ts';
import { WorkspaceRegistry } from '../src/server/workspace-registry.ts';
import { changeEventSchema, historyPageSchema, snapshotSchema, workbenchConfigurationSchema } from '../src/shared/workbench.ts';

const origin = 'https://workbench.example';
const configuration = { modelId: 'synthetic-model', permissionId: 'workspace-write' };
const nativeState: NativeState = { status: 'idle', pendingInputs: 0, configurationVerified: true };
async function eventually(check: () => Promise<boolean> | boolean, timeout = 4000): Promise<void> {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('bounded condition was not observed');
}

/** The next change frame that carries a live item; latest-page refreshes also emit item-less hints. */
async function itemChange(stream: { named(name: string): Promise<{ name: string; id?: string; data: any } | null> }) {
  for (;;) { const event = await stream.named('change'); if (!event || event.data.item) return event; }
}

async function fixture(t: TestContext, limits: Parameters<typeof createWorkbenchHttp>[1] = {}, withRegistry = false) {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-workbench-http-'));
  const db = openDatabase(directory, productMigrations);
  const auth = createAuth(db, { audit: () => {} });
  const password = randomBytes(32).toString('base64url'); await auth.initialize(password);
  let transport: ReturnType<typeof createWorkbenchHttp>;
  const store = createWorkbenchStore(db, { onChange: change => transport?.changed(change) });
  const submissions: string[] = []; let receipt: Receipt = { outcome: 'unknown', reason: 'synthetic_receipt_lost' };
  let state = nativeState;
  let historyItems: NativeItem[] = [];
  let nextStateRead: (() => Promise<void>) | undefined;
  let listener: ((change: NativeChange) => void) | undefined;
  const adapter: HarnessAdapter = {
    id: 'dsh',
    async skills() { return [{ id: 'a'.repeat(64), name: 'proof', label: 'Proof', description: 'Synthetic skill' }]; },
    async catalog() { return { id: 'dsh', available: true, models: [{ id: configuration.modelId, label: 'Synthetic model' }], permissions: [{ id: configuration.permissionId, label: 'Workspace', description: 'Synthetic test only' }] }; },
    async create(input, onBound) { const binding = { id: 'private-native-binding', cwd: input.cwd, configuration: input.configuration, details: { privateNativeField: 'never-public' } }; onBound(binding); return binding; },
    async state() {
      const pause = nextStateRead;
      nextStateRead = undefined;
      if (pause) await pause();
      return state;
    },
    async history(_binding, cursor, limit = 50) {
      const end = cursor === undefined ? historyItems.length : Number(cursor); const start = Math.max(0, end - limit);
      return { items: historyItems.slice(start, end), olderCursor: start ? String(start) : null };
    },
    async submit(_binding, operation) { submissions.push(operation.id); return receipt; },
    async reconcile() { return { outcome: 'accepted', runId: 'synthetic-turn' }; },
    async stop() { return { outcome: 'accepted', runId: 'synthetic-turn' }; },
    async watch(_binding, value) { listener = value; return () => { listener = undefined; }; }, async close() {},
  };
  const root = join(await realpath(directory), 'folders');
  if (withRegistry) await mkdir(root);
  const roots = [{ id: 'shared', label: 'Test folders', directory: root }];
  const registry = withRegistry ? new WorkspaceRegistry(db, [], roots) : undefined;
  const workbench = new Workbench(store, [{ id: 'fixture', label: 'Synthetic workspace', directory: '/operator-only/synthetic-workspace' }], new Map([['dsh', adapter]]), registry);
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
  return { db, auth, store, workbench, transport, app, base, credentials, login, request, seed, stream, submissions, root, roots, adapter,
    setReceipt(value: Receipt) { receipt = value; }, setState(value: NativeState) { state = value; },
    setHistory(value: NativeItem[]) { historyItems = value; },
    /** Live output reaches the workbench only through native observation (ADR 0014). */
    async live(id: string, item: NativeItem) { await workbench.reading(id, 'http-test-reader'); assert.ok(listener, 'conversation is observed'); listener({ type: 'item', item }); },
    pauseNextState() {
      let entered = false;
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      nextStateRead = () => { entered = true; return released; };
      return { entered: () => entered, release };
    },
  };
}

test('draft preparation requires authentication and CSRF before native work and keeps native identity private', async t => {
  const f=await fixture(t); const ids:string[]=[];
  f.adapter.prepareDraft=async input=>{ids.push(input.id);return [];};
  const body={workspaceId:'fixture',harnessId:'dsh'};
  assert.equal((await f.request('/draft-preparation',{method:'POST',body,authenticated:false})).status,401);
  assert.equal((await f.request('/draft-preparation',{method:'POST',body,headers:{'x-csrf-token':''}})).status,403);
  assert.equal((await f.request('/draft-preparation',{method:'POST',body:{...body,cwd:'/outside'}})).status,400);
  assert.equal(ids.length,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workbench_draft_preparations').get()!.n,0);
  const response=await f.request('/draft-preparation',{method:'POST',body});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(Object.keys(response.body).sort(),['preparationId','skills']);
  assert.notEqual(response.body.preparationId,ids[0]);
  const again=await f.request('/draft-preparation',{method:'POST',body:{...body,preparationId:response.body.preparationId}});
  assert.deepEqual(again.body,response.body);assert.equal(new Set(ids).size,1);
  assert.equal(f.store.listConversations().length,0);
});

test('skills and usage stay behind conversation authorization and skill identity is frozen for retry', async t => {
  const f = await fixture(t);
  const id = f.seed();
  const root = `/conversations/${id}`;
  assert.equal((await f.request(root + '/skills', { authenticated: false })).status, 401);
  assert.equal((await f.request(root + '/skills?cwd=outside')).status, 400);
  const catalog = await f.request(root + '/skills');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.headers.get('cache-control'), 'no-store');
  assert.deepEqual(catalog.body, { skills: [{ id: 'a'.repeat(64), name: 'proof', label: 'Proof', description: 'Synthetic skill' }] });
  const context = { used: 600, capacity: 1000, estimated: true };
  f.store.setUsage(id, { total: 1200, context });
  f.store.setUsage(id, { total: 1199 });
  assert.deepEqual(snapshotSchema.parse((await f.request(root)).body).usage, { total: 1200, context });
  f.store.setUsage(id, { total: 1200, context: { ...context, used: 80 } });
  assert.equal(snapshotSchema.parse((await f.request(root)).body).usage?.context?.used, 80);
  f.store.setUsage(id, { total: 1200 });
  assert.deepEqual(snapshotSchema.parse((await f.request(root)).body).usage, { total: 1200 });
  const send = (payload: unknown, operationId: string) => f.request(root + '/operations', {
    method: 'POST', body: { id: operationId, type: 'message', payload },
  });
  const skill = { id: 'a'.repeat(64), label: 'Proof', start: 0, end: 7 };
  const payload = { text: '⬡ Proof', skills: [skill] };
  const entryId = randomUUID();
  f.store.changeQueue(id, { action: 'add', entryId, content: payload });
  const queued = f.store.readQueue(id).entries[0]!;
  const earlyId = randomUUID();
  assert.throws(() => f.store.claimQueue(id, entryId, queued.version, earlyId, { mode: 'current', target: 'synthetic-turn' }),
    { code: 'queue_skill_requires_next_turn' });
  assert.equal(f.store.getOperation(earlyId), null);
  assert.deepEqual(f.store.readQueue(id).entries, [queued]);
  f.store.changeQueue(id, { action: 'remove', entryId, version: queued.version });
  assert.equal((await send({ ...payload, skills: [{ ...skill, end: 8 }] }, randomUUID())).status, 400);
  const operationId = randomUUID();
  assert.equal((await send(payload, operationId)).status, 202);
  assert.equal((await send(payload, operationId)).status, 202);
  assert.equal((await send({ ...payload, skills: [{ ...skill, id: 'b'.repeat(64) }] }, operationId)).status, 409);
  await eventually(() => f.submissions.length === 1);
  assert.deepEqual(f.submissions, [operationId]);
});

test('workspace registration gates real HTTP and retains disk files, history and binding across removal', async t => {
  const f = await fixture(t, {}, true);
  const folder = join(f.root, 'existing');
  await mkdir(folder);
  await writeFile(join(folder, 'notes.md'), 'workspace evidence');
  await symlink(folder, join(f.root, 'alias'));
  const post = (path: string, body: unknown) => f.request(path, { method: 'POST', body });
  const selection = { rootId: 'shared', path: ['existing'] };
  assert.equal((await f.request('/workspace-directories', { method: 'POST', body: selection, authenticated: false })).status, 401);
  assert.equal((await f.request('/workspaces', { method: 'POST', body: selection, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.deepEqual((await post('/workspace-directories', { ...selection, path: [] })).body,
    { currentDirectory: f.root, names: ['existing'], limited: false });
  assert.equal((await post('/workspace-directories', selection)).body.currentDirectory, folder);
  assert.equal((await post('/workspaces', { ...selection, path: ['..'] })).status, 400);
  assert.equal((await post('/workspaces', { ...selection, path: ['alias'] })).status, 409);
  assert.equal((await post('/workspaces', { ...selection, path: [], name: 'new-folder' })).status, 200);
  const registered = await post('/workspaces', selection);
  assert.equal(registered.status, 200);
  const workspaceId = registered.body.id as string;
  assert.equal((await post('/workspaces', selection)).body.id, workspaceId);
  const manage = (action: Record<string, unknown>) => post(`/workspaces/${workspaceId}/manage`, action);
  assert.equal((await manage({ action: 'rename', label: 'Display only' })).status, 200);
  assert.equal((await manage({ action: 'pin', pinned: true })).status, 200);
  assert.deepEqual((await f.request('/configuration')).body.workspaces[0],
    { id: workspaceId, label: 'Display only', directoryName: 'existing', pinned: true });
  const id = randomUUID();
  assert.equal((await post('/conversations', { id, harnessId: 'dsh', workspaceId, configuration })).status, 202);
  await eventually(() => f.store.getConversation(id)?.readiness === 'ready');
  const binding = f.store.getConversation(id)!.binding;
  assert.equal(binding?.cwd, folder);
  const history = [{ id: 'saved-message', kind: 'assistant', status: 'completed', text: 'Saved conversation' }] as const;
  f.setHistory([...history]);
  f.setState({ ...nativeState, status: 'waiting', runId: 'waiting-run', pendingInputs: 1 });
  assert.equal((await manage({ action: 'remove' })).body.error, 'workspace_remove_busy');
  f.setState(nativeState);
  const paused = f.pauseNextState();
  const removal = manage({ action: 'remove' });
  try {
    await eventually(paused.entered);
    const send = await post(`/conversations/${id}/operations`, { id: randomUUID(), type: 'message', payload: { text: 'Raced removal' } });
    assert.equal(send.body.error, 'workspace_remove_busy');
  } finally { paused.release(); }
  assert.equal((await removal).status, 200);
  assert.equal(new WorkspaceRegistry(f.db, [], f.roots).get(workspaceId)?.removed, 1);
  assert.equal((await f.request(`/conversations/${id}`)).body.history.items[0]?.text, 'Saved conversation');
  assert.equal((await post(`/conversations/${id}/operations`, { id: randomUUID(), type: 'message', payload: { text: 'Blocked' } })).body.error, 'workspace_removed');
  assert.equal((await f.request(`/workspaces/${workspaceId}/file?path=notes.md`)).body.error, 'workspace_removed');
  assert.equal(await readFile(join(folder, 'notes.md'), 'utf8'), 'workspace evidence');
  assert.equal((await manage({ action: 'restore' })).status, 200);
  assert.equal(f.store.getConversation(id)?.state.configurationVerified, false);
  await f.request(`/conversations/${id}`);
  assert.equal(f.store.getConversation(id)?.state.configurationVerified, false);
  assert.equal((await post(`/conversations/${id}/reading`, { readerId: randomUUID(), active: true })).status, 200);
  await eventually(() => f.store.getConversation(id)?.state.configurationVerified === true);
  assert.deepEqual(f.store.getConversation(id)?.binding, binding);
  assert.equal((await manage({ action: 'remove' })).status, 200);
  await rename(folder, join(f.root, 'moved'));
  await mkdir(folder);
  assert.equal((await manage({ action: 'restore' })).body.error, 'workspace_directory_changed');
  assert.equal((await f.request(`/conversations/${id}`)).body.history.items[0]?.text, 'Saved conversation');
  assert.deepEqual(f.submissions, []);
});

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
  await f.live(id, { id: 'live-one', kind: 'assistant', status: 'running', text: 'first body' });
  const emitted = (await itemChange(first))!; changeEventSchema.parse(emitted.data);
  assert.equal(emitted.data.item.text, 'first body'); assert.equal(emitted.id, String(emitted.data.revision)); first.close();
  await f.live(id, { id: 'live-one', kind: 'assistant', status: 'running', text: 'full current body after disconnect' });
  const replay = await f.stream('?cursor=0', { 'last-event-id': emitted.id! }); await replay.named('ready');
  const resumed = (await itemChange(replay))!; assert.ok(resumed.data.revision > emitted.data.revision);
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
  await f.live(id, { id: 'after-logout', kind: 'notice', status: 'completed', text: 'Second session still authorized' });
  assert.equal((await itemChange(second))!.data.item.text, 'Second session still authorized');
  await f.auth.reset(randomBytes(32).toString('base64url'));
  const revoked = second.next().then(value => value === null, () => true);
  await f.live(id, { id: 'after-reset', kind: 'notice', status: 'completed', text: 'Must not reach revoked reader' });
  assert.equal(await revoked, true);
});

test('SSE capacity is released after client disconnect and app shutdown closes active streams', async t => {
  const f = await fixture(t, { maxConnections: 1, maxConnectionsPerSession: 1 });
  const first = await f.stream(); await first.named('ready');
  const excess = await f.request('/events'); assert.equal(excess.status, 429); assert.equal(excess.body.error, 'event_connection_limit'); first.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  const replacement = await f.stream(); assert.equal(replacement.response.status, 200); await replacement.named('ready');
  const ended = (async () => {
    try { while (await replacement.next()) { /* Drain heartbeat frames already in flight. */ } }
    catch { /* Closing the socket may reject the pending read. */ }
  })();
  let deadline: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new Error('active SSE stream did not close during shutdown')), 3000).unref();
  });
  try { await Promise.all([f.app.close(), Promise.race([ended, timedOut])]); }
  finally { clearTimeout(deadline); }
});

test('idle streams recheck revoked credentials, while oversized events fall back to complete HTTP bodies', async t => {
  const f = await fixture(t); const id = f.seed();
  const stream = await f.stream(); await stream.named('ready');
  const text = 'Synthetic long body '.repeat(8000);
  await f.live(id, { id: 'long-live', kind: 'assistant', status: 'running', text });
  const change = (await stream.named('change'))!; assert.equal(change.data.item, undefined);
  assert.equal((await f.request(`/conversations/${id}`)).body.history.liveItems.find((item: NativeItem) => item.id === 'long-live').text, text);
  await f.auth.reset(randomBytes(32).toString('base64url'));
  const revokedAt = Date.now();
  const ended = async () => { try { while (await stream.next()) { /* already-buffered heartbeat frames contain no private data */ } } catch { /* socket closed by credential check */ } };
  await ended();
  assert.ok(Date.now() - revokedAt < 1000, 'server heartbeat must close before the client safety timeout');
});

test('native pages shrink to fit the response budget, read through to the first message, and report bounded live output', async t => {
  const f = await fixture(t); const id = f.seed();
  const items: NativeItem[] = Array.from({ length: 16 }, (_, index) => ({ id: `large-${index}`, kind: 'assistant', status: 'completed', text: String(index).padStart(2, '0') + 'x'.repeat(1024 * 1024 - 2) }));
  f.setHistory(items);
  const first = await f.request(`/conversations/${id}`); assert.equal(first.status, 200); snapshotSchema.parse(first.body);
  assert.ok(first.body.history.items.length > 0 && first.body.history.items.length < items.length); assert.ok(first.body.history.olderCursor);
  assert.equal(first.body.history.items.at(-1).id, 'large-15');
  const seen: NativeItem[] = [...first.body.history.items]; let cursor: string | null = first.body.history.olderCursor;
  while (cursor) {
    const older = await f.request(`/conversations/${id}/history?cursor=${encodeURIComponent(cursor)}`);
    assert.equal(older.status, 200); historyPageSchema.parse(older.body);
    seen.unshift(...older.body.items); cursor = older.body.olderCursor;
  }
  assert.deepEqual(seen.map(item => item.id), items.map(item => item.id));
  for (const item of seen) assert.equal(item.text, items.find(candidate => candidate.id === item.id)!.text);
  assert.equal((await f.request(`/conversations/${id}/history?cursor=${Buffer.from(JSON.stringify({ c: randomUUID(), n: '4' })).toString('base64url')}`)).body.error, 'history_cursor_invalid');
  assert.equal((await f.request(`/conversations/${id}/history?cursor=bad%2Fcursor`)).status, 400);
  assert.equal((await f.request(`/conversations/${id}/history?cursor=${encodeURIComponent(first.body.history.olderCursor)}`, { authenticated: false })).status, 401);
  await f.live(id, { id: 'huge-live', kind: 'assistant', status: 'running', text: '\u0001'.repeat(1024 * 1024) });
  // Live output is bounded by the response budget: it is either returned whole or flagged as limited.
  await eventually(async () => { const body = (await f.request(`/conversations/${id}`)).body; return body.history.liveItemsLimited || body.history.liveItems.some((item: NativeItem) => item.id === 'huge-live'); });
  const limited = await f.request(`/conversations/${id}`); assert.equal(limited.status, 200); snapshotSchema.parse(limited.body);
  assert.ok(Buffer.byteLength(JSON.stringify(limited.body)) < 12 * 1024 * 1024);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workbench_live_items').get()?.n, 0);
});
test('a real non-reading TCP client is evicted under backpressure without an unbounded event queue', async t => {
  const f = await fixture(t, { maxConnections: 1, maxConnectionsPerSession: 1, slowClientMs: 100 }); const id = f.seed();
  const paused = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = httpGet(`${f.base}/api/private/workbench/events`, { headers: { cookie: f.credentials.cookie } }, response => { response.pause(); resolve(response); });
    request.setTimeout(8000, () => request.destroy()); request.on('error', reject); t.after(() => request.destroy());
  });
  assert.equal(paused.statusCode, 200); paused.on('error', () => {});
  const text = '\u0001'.repeat(7900);
  await f.live(id, { id: 'backpressure', kind: 'assistant', status: 'running', text });
  // Each durable change hint carries the current in-memory body.
  for (let index = 0; index < 700; index++) f.store.touch(id, 'backpressure');
  await new Promise(resolve => setTimeout(resolve, 400));
  const replacement = await f.stream(); assert.equal(replacement.response.status, 200, 'slow client connection slot must be released');
  await replacement.named('ready'); replacement.close(); paused.destroy();
});

test('management filters before paging, preserves binding and guards archived submissions', async t => {
  const f = await fixture(t);
  const id = f.seed();
  const post = (path: string, body: unknown) => f.request(path, { method: 'POST', body });
  const manage = (body: unknown) => post(`/conversations/${id}/manage`, body);
  const search = (body: unknown) => post('/conversation-search', body);
  const title = '旧对话 100%_内容';
  const binding = f.store.getConversation(id)?.binding;
  assert.equal((await f.request('/conversation-search', { method: 'POST', authenticated: false, body: {} })).status, 401);
  assert.equal((await f.request(`/conversations/${id}/manage`, { method: 'POST', body: { action: 'archive', archived: true }, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await manage({ action: 'rename', title: '   ' })).status, 400);
  assert.equal((await manage({ action: 'rename', title })).body.conversation.title, title);
  for (let index = 0; index < 8; index++) f.seed();
  const first = await search({ workspaceId: 'fixture' });
  assert.equal(first.body.conversations.length, 6);
  assert.ok(first.body.olderBeforeId);
  const second = await search({ workspaceId: 'fixture', beforeId: first.body.olderBeforeId });
  assert.equal(second.body.conversations.length, 3);
  assert.equal(new Set([...first.body.conversations, ...second.body.conversations].map(entry => entry.id)).size, 9);
  assert.deepEqual((await search({ title: '%_' })).body.conversations.map((entry: { id: string }) => entry.id), [id]);
  assert.deepEqual((await search({ workspaceId: 'other', title })).body.conversations, []);

  const operation = { id: randomUUID(), type: 'message', payload: { text: 'Concurrent synthetic submission' } };
  const [archive, send] = await Promise.all([manage({ action: 'archive', archived: true }), post(`/conversations/${id}/operations`, operation)]);
  assert.ok((archive.status === 200 && send.status === 409) || (archive.status === 409 && send.status === 202));
  const archivable = archive.status === 200 ? id : f.seed();
  const setArchive = (archived: boolean) => post(`/conversations/${archivable}/manage`, { action: 'archive', archived });
  assert.equal((await setArchive(true)).body.conversation.archived, true);
  assert.equal((await post(`/conversations/${archivable}/operations`, { ...operation, id: randomUUID() })).body.error, 'conversation_archived');
  assert.equal((await search({ archived: true })).body.conversations[0].id, archivable);
  assert.equal((await f.request(`/conversations/${archivable}`)).body.conversation.archived, true);
  assert.equal((await setArchive(false)).body.conversation.archived, false);
  assert.deepEqual(f.store.getConversation(id)?.binding, binding);
  assert.deepEqual((await search({ archived: true })).body.conversations, []);
});

test('draft defaults are authenticated, exclude unsent conversations, and expose only public fields', async t => {
  const f = await fixture(t); const id = f.seed();
  assert.equal((await f.request('/conversation-defaults', { authenticated: false })).status, 401);
  assert.deepEqual((await f.request('/conversation-defaults')).body, { conversation: null });
  const operation = { id: randomUUID(), conversationId: id, type: 'message' as const, payload: { text: 'sent' } };
  f.store.enqueueOperation(operation); f.store.claimOperation(operation.id); f.store.settleOperation(operation.id, { outcome: 'accepted' });
  const result = await f.request('/conversation-defaults?workspaceId=fixture');
  assert.equal(result.status, 200); assert.equal(result.body.conversation.id, id);
  assert.equal(result.body.conversation.cwd, undefined); assert.equal(result.body.conversation.binding, undefined);
  assert.equal((await f.request('/conversation-defaults?workspaceId=missing')).status, 404);
  assert.equal((await f.request('/conversation-defaults?extra=1')).status, 400);
  assert.equal((await f.request('/draft-files?workspaceId=fixture&harnessId=dsh', { authenticated: false })).status, 401);
  assert.equal((await f.request('/draft-files?workspaceId=fixture&harnessId=other')).status, 400);
  assert.equal((await f.request('/draft-files?workspaceId=fixture&harnessId=codex')).status, 409);
});

test('draft files stay within a registered workspace and do not create conversations', async t => {
  const f = await fixture(t, {}, true); const folder = join(f.root, 'draft');
  await mkdir(folder); await writeFile(join(folder, 'notes.md'), 'draft');
  const registered = await f.request('/workspaces', { method: 'POST', body: { rootId: 'shared', path: ['draft'] } });
  const id = registered.body.id;
  const path = `/draft-files?workspaceId=${id}&harnessId=dsh`;
  const result = await f.request(path);
  assert.equal(result.status, 200); assert.ok(JSON.stringify(result.body.files).includes('notes.md'));
  assert.deepEqual(f.store.listConversations(), []);
  assert.notEqual((await f.request(path + '&directory=..')).status, 200);
  await f.request(`/workspaces/${id}/manage`, { method: 'POST', body: { action: 'remove' } });
  assert.notEqual((await f.request(path)).status, 200);
});


test('draft skills report capability without creating a conversation and preserve authentication', async t => {
  const f = await fixture(t);
  const path = '/draft-skills?workspaceId=fixture&harnessId=dsh';
  assert.equal((await f.request(path, { authenticated: false })).status, 401);
  assert.deepEqual((await f.request(path)).body, { supported: false, skills: [], reason: 'draft_skills_unavailable' });
  assert.equal((await f.request('/draft-skills?workspaceId=fixture&harnessId=codex')).status, 409);
  assert.equal((await f.request('/draft-skills?workspaceId=missing&harnessId=dsh')).status, 404);
  assert.equal((await f.request(path + '&unexpected=1')).status, 400);
  const skills = [{ id: 'b'.repeat(64), name: 'draft', label: 'Draft', description: 'Native skill' }];
  f.adapter.draftSkills = async cwd => { assert.equal(cwd, '/operator-only/synthetic-workspace'); return skills; };
  assert.deepEqual((await f.request(path)).body, { supported: true, skills });
  assert.deepEqual(f.store.listConversations(), []);
  f.adapter.draftSkills = async () => { throw new Error('native failure'); };
  const failed = await f.request(path);
  assert.equal(failed.status, 503); assert.equal(failed.body.error, 'skill_catalog_unavailable');
});


test('history defaults split legacy DSH model effort without changing persisted identity', async t => {
  const f = await fixture(t);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const model = { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' };
  f.adapter.normalizeConfiguration = configuration => {
    const selected = JSON.parse(Buffer.from(configuration.modelId, 'base64url').toString('utf8'));
    return { ...configuration, modelId: encode({ provider: selected.provider, model: selected.model }), reasoningEffort: selected.reasoningEffort };
  };
  const configuration = { modelId: encode(model), permissionId: 'workspace-write' };
  const input = { id: randomUUID(), harnessId: 'dsh' as const, workspaceId: 'fixture',
    cwd: '/operator-only/synthetic-workspace', configuration };
  f.store.createConversation(input);
  const binding = { id: 'legacy-binding', cwd: input.cwd, configuration, details: {} };
  f.store.saveBinding(input.id, binding);
  const op = { id: randomUUID(), conversationId: input.id, type: 'message' as const, payload: { text: 'legacy accepted' } };
  f.store.enqueueOperation(op); f.store.claimOperation(op.id); f.store.settleOperation(op.id, { outcome: 'accepted' });
  for (const path of ['/conversation-defaults', '/conversation-defaults?workspaceId=fixture']) {
    const response = await f.request(path);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.conversation.configuration, {
      modelId: encode({ provider: model.provider, model: model.model }), permissionId: 'workspace-write', reasoningEffort: 'high',
    });
  }
  assert.deepEqual(f.store.getConversation(input.id)?.configuration, configuration);
  assert.deepEqual(f.store.getConversation(input.id)?.binding, binding);
  assert.equal(f.store.createConversation(input).created, false);
});

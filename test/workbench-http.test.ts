import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
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
import { WorkspaceRegistry } from '../src/server/workspace-registry.ts';
import { createStorageClient, StorageClientError } from '../src/server/storage-client.ts';
import { changeEventSchema, snapshotSchema, workbenchConfigurationSchema } from '../src/shared/workbench.ts';

const origin = 'https://workbench.example';
const configuration = { modelId: 'synthetic-model', permissionId: 'workspace-write' };
const nativeState: NativeState = { status: 'idle', pendingInputs: 0, configurationVerified: true };
async function eventually(check: () => Promise<boolean> | boolean, timeout = 4000): Promise<void> {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('bounded condition was not observed');
}

async function fixture(t: TestContext, limits: Parameters<typeof createWorkbenchHttp>[1] = {}, withRegistry = false, useWorker = false) {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-workbench-http-'));
  const db = openDatabase(directory, productMigrations);
  const auth = createAuth(db, { audit: () => {} });
  const password = randomBytes(32).toString('base64url'); await auth.initialize(password);
  let transport: ReturnType<typeof createWorkbenchHttp>;
  const store = createWorkbenchStore(db, { onChange: change => transport?.changed(change) });
  const storage = useWorker ? createStorageClient({ dataDirectory: directory, onChange: change => transport?.changed(change), onReset: () => transport?.invalidate() }) : undefined;
  await storage?.ready;
  const submissions: string[] = []; let receipt: Receipt = { outcome: 'unknown', reason: 'synthetic_receipt_lost' };
  let state = nativeState;
  let historyItems: NativeItem[] = [];
  const historyChangeIds: string[] = [];
  let nextStateRead: (() => Promise<void>) | undefined;
  const adapter: HarnessAdapter = {
    id: 'dsh', historyReadOnly: true,
    async skills() { return [{ id: 'a'.repeat(64), name: 'proof', label: 'Proof', description: 'Synthetic skill' }]; },
    async catalog() { return { id: 'dsh', available: true, models: [{ id: configuration.modelId, label: 'Synthetic model' }], permissions: [{ id: configuration.permissionId, label: 'Workspace', description: 'Synthetic test only' }] }; },
    async create(input, onBound) { const binding = { id: 'private-native-binding', cwd: input.cwd, configuration: input.configuration, details: { privateNativeField: 'never-public' } }; await onBound(binding); return binding; },
    async state() {
      const pause = nextStateRead;
      nextStateRead = undefined;
      if (pause) await pause();
      return state;
    },
    async history() { return { items: historyItems, olderCursor: null }; },
    async historyChanges(_binding, cursor, limit = 16) {
      const offset = cursor === undefined ? 0 : Number(cursor);
      assert.ok(Number.isSafeInteger(offset) && offset >= 0 && offset <= historyChangeIds.length);
      const end = Math.min(historyChangeIds.length, offset + limit);
      return { itemIds: [...new Set(historyChangeIds.slice(offset, end))], cursor: String(end), hasMore: end < historyChangeIds.length };
    },
    async readItems(_binding, ids) { return ids.map(id => historyItems.find(item => item.id === id)!); },
    async submit(_binding, operation) { submissions.push(operation.id); return receipt; },
    async reconcile() { return { outcome: 'accepted', runId: 'synthetic-turn' }; },
    async stop() { return { outcome: 'accepted', runId: 'synthetic-turn' }; },
    async watch() { return () => {}; }, async close() {},
  };
  const root = join(await realpath(directory), 'folders');
  if (withRegistry) await mkdir(root);
  const roots = [{ id: 'shared', label: 'Test folders', directory: root }];
  const registry = withRegistry ? new WorkspaceRegistry(storage?.workspaces ?? db, [], roots) : undefined;
  const workbench = new Workbench(storage?.store ?? store, [{ id: 'fixture', label: 'Synthetic workspace', directory: '/operator-only/synthetic-workspace' }], new Map([['dsh', adapter]]), registry);
  transport = createWorkbenchHttp(workbench, { heartbeatMs: 50, ...limits });
  const app = await buildApp({ ...(storage ? { authStore: storage.auth } : { db }), origin, privateRoutes: transport.routes, onLogout: transport.logout });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const controllers = new Set<AbortController>();
  t.after(async () => {
    for (const controller of controllers) controller.abort(); transport.close(); await workbench.close(); await app.close(); await storage?.close(); db.close(); await rm(directory, { recursive: true });
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
  return { db, auth, store, storage, workbench, transport, app, base, credentials, login, request, seed, stream, submissions, root, roots,
    setReceipt(value: Receipt) { receipt = value; }, setState(value: NativeState) { state = value; },
    setHistory(value: NativeItem[]) { historyItems = value; historyChangeIds.push(...value.map(item => item.id)); },
    setBodyReader(value: NonNullable<HarnessAdapter['readBodyChunk']>) { adapter.readBodyChunk = value; },
    setImageReader(value: NonNullable<HarnessAdapter['readImage']>) { adapter.readImage = value; },
    setItemsReader(value: NonNullable<HarnessAdapter['readItems']>) { adapter.readItems = value; },
    setHistoryChanges(value: NonNullable<HarnessAdapter['historyChanges']>) { adapter.historyChanges = value; },
    pauseNextState() {
      let entered = false;
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      nextStateRead = () => { entered = true; return released; };
      return { entered: () => entered, release };
    },
  };
}

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
  f.store.mergeHistory(id, [...history]);
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
  assert.equal((await new WorkspaceRegistry(f.db, [], f.roots).get(workspaceId))?.removed, 1);
  assert.equal((await f.request(`/conversations/${id}`)).body.history.items[0]?.text, 'Saved conversation');
  assert.equal((await post(`/conversations/${id}/operations`, { id: randomUUID(), type: 'message', payload: { text: 'Blocked' } })).body.error, 'workspace_removed');
  assert.equal((await f.request(`/workspaces/${workspaceId}/file?path=notes.md`)).body.error, 'workspace_removed');
  assert.equal(await readFile(join(folder, 'notes.md'), 'utf8'), 'workspace evidence');
  assert.equal((await manage({ action: 'restore' })).status, 200);
  assert.equal(f.store.getConversation(id)?.state.configurationVerified, false);
  await f.request(`/conversations/${id}`);
  await eventually(() => f.store.getConversation(id)?.state.configurationVerified === true);
  assert.deepEqual(f.store.getConversation(id)?.binding, binding);
  assert.equal((await manage({ action: 'remove' })).status, 200);
  await rename(folder, join(f.root, 'moved'));
  await mkdir(folder);
  assert.equal((await manage({ action: 'restore' })).body.error, 'workspace_directory_changed');
  assert.equal((await f.request(`/conversations/${id}`)).body.history.items[0]?.text, 'Saved conversation');
  assert.deepEqual(f.submissions, []);
});

test('removed workspaces keep authorized background text archiving without restoring execution or file access', async t => {
  const f = await fixture(t, {}, true, true);
  const folder = join(f.root, 'archived'); await mkdir(folder); await writeFile(join(folder, 'notes.md'), 'private workspace bytes');
  const added = await f.request('/workspaces', { method: 'POST', body: { rootId: 'shared', path: ['archived'] } });
  assert.equal(added.status, 200); const workspaceId = added.body.id;
  const id = randomUUID();
  assert.equal((await f.request('/conversations', { method: 'POST', body: { id, harnessId: 'dsh', workspaceId, configuration } })).status, 202);
  await eventually(() => f.store.getConversation(id)?.readiness === 'ready');
  assert.equal((await f.request('/workspaces/' + workspaceId + '/manage', { method: 'POST', body: { action: 'remove' } })).status, 200);
  const items: NativeItem[] = [{ id: 'unread-after-removal', kind: 'assistant', status: 'completed', text: 'Archived after removal. '.repeat(600) }];
  f.setHistory(items); f.setItemsReader(async (_binding, ids) => items.filter(item => ids.includes(item.id)));
  f.setHistoryChanges(async () => ({ itemIds: items.map(item => item.id), cursor: 'synthetic-revision-1', hasMore: false }));
  // Only the due time is controlled. Actual bodies/checkpoints must be produced
  // by the background Workbench path and its real storage worker.
  f.db.prepare('UPDATE workbench_archive_jobs SET next_at=0 WHERE conversation_id=?').run(id);
  await f.workbench.start();
  await eventually(() => f.store.archiveUpdates(id)?.complete === true);
  const archived = f.store.getItem(id, items[0]!.id)!;
  assert.equal(Buffer.from(f.store.readBody(id, archived.id, 'text', archived.bodies!.text!, 0).data).toString(), items[0]!.text);
  const snapshot = await f.request('/conversations/' + id);
  assert.equal(snapshot.body.archive.latest.complete, true);
  assert.equal((await f.request(`/conversations/${id}/operations`, { method: 'POST', body: { id: randomUUID(), type: 'message', payload: { text: 'must stay blocked' } } })).body.error, 'workspace_removed');
  assert.equal((await f.request(`/workspaces/${workspaceId}/file?path=notes.md`)).body.error, 'workspace_removed');
  assert.deepEqual(f.submissions, []);
  assert.equal(await readFile(join(folder, 'notes.md'), 'utf8'), 'private workspace bytes');
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

test('idle streams recheck revoked credentials while large live bodies expose only a bounded preview', async t => {
  const f = await fixture(t); const id = f.seed();
  const stream = await f.stream(); await stream.named('ready');
  const text = 'Synthetic long body '.repeat(8000);
  f.store.saveLiveItem(id, { id: 'long-live', kind: 'assistant', status: 'running', text });
  const change = (await stream.named('change'))!;
  assert.ok(Buffer.byteLength(change.data.item.text) <= 8192);
  assert.equal(change.data.item.bodies.text.bytes, Buffer.byteLength(text));
  const item = (await f.request(`/conversations/${id}`)).body.history.liveItems.find((item: NativeItem) => item.id === 'long-live');
  assert.equal(item.text, change.data.item.text);
  const body = await fetch(`${f.base}/api/private/workbench/conversations/${id}/body?` + new URLSearchParams({
    item: item.id, field: 'text', version: item.bodies.text.version, bytes: String(item.bodies.text.bytes), download: '1',
  }), { headers: { cookie: f.credentials.cookie } });
  assert.equal(await body.text(), text);
  await f.auth.reset(randomBytes(32).toString('base64url'));
  const revokedAt = Date.now();
  const ended = async () => { try { while (await stream.next()) { /* already-buffered heartbeat frames contain no private data */ } } catch { /* socket closed by credential check */ } };
  await ended();
  assert.ok(Date.now() - revokedAt < 1000, 'server heartbeat must close before the client safety timeout');
});

test('history pages carry bounded previews and immutable full body references', async t => {
  const f = await fixture(t); const id = f.seed();
  const items: NativeItem[] = Array.from({ length: 16 }, (_, index) => ({ id: `large-${index}`, kind: 'assistant', status: 'completed', text: String(index).padStart(2, '0') + 'x'.repeat(1024 * 1024 - 2) }));
  f.store.mergeHistory(id, items);
  const first = await f.request(`/conversations/${id}`); assert.equal(first.status, 200); snapshotSchema.parse(first.body);
  assert.equal(first.body.history.items.length, items.length);
  assert.equal(first.body.history.items.at(-1).id, 'large-15');
  for (const item of first.body.history.items) {
    assert.ok(Buffer.byteLength(item.text) <= 8192);
    assert.equal(item.text, items.find(candidate => candidate.id === item.id)!.text.slice(0, 8192));
    assert.equal(item.bodies.text.bytes, 1024 * 1024);
  }
  f.store.saveLiveItem(id, { id: 'huge-live', kind: 'assistant', status: 'running', text: '\u0001'.repeat(1024 * 1024) });
  const limited = await f.request(`/conversations/${id}`); assert.equal(limited.status, 200);
  assert.ok(Buffer.byteLength(limited.body.history.liveItems[0].text) <= 8192);
  assert.equal(limited.body.history.liveItems[0].bodies.text.bytes, 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(limited.body)) < 256 * 1024);
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

test('real storage worker drives native preparation, admission and a lost database receipt without redispatch', async t => {
  const f = await fixture(t, {}, false, true);
  const id = randomUUID();
  const created = await f.request('/conversations', { method: 'POST', body: { id, harnessId: 'dsh', workspaceId: 'fixture', configuration } });
  assert.equal(created.status, 202);
  await eventually(async () => (await f.workbench.store.getConversation(id))?.readiness === 'ready');
  assert.equal((await f.workbench.store.getConversation(id))!.binding!.id, 'private-native-binding');
  const original = f.workbench.store.enqueueOperation;
  let loseReceipt = true;
  f.workbench.store.enqueueOperation = async input => {
    const result = await original(input);
    if (loseReceipt) { loseReceipt = false; throw new StorageClientError('synthetic_commit_receipt_lost', 'unknown'); }
    return result;
  };
  const operation = { id: randomUUID(), type: 'message', payload: { text: 'One durable admission' } };
  const url = `/conversations/${id}/operations`;
  assert.equal((await f.request(url, { method: 'POST', body: operation })).status, 503);
  assert.equal((await f.workbench.store.getOperation(operation.id))!.status, 'queued');
  assert.deepEqual(f.submissions, [], 'an unknown storage outcome cannot authorize a native dispatch');
  assert.equal((await f.request(url, { method: 'POST', body: operation })).status, 202);
  assert.deepEqual(f.submissions, [], 'retry reads the same durable admission without sending again');
  f.workbench.store.enqueueOperation = original;
  assert.equal((await f.request(`/conversations/${id}/reconcile`, { method: 'POST', body: {} })).status, 200);
  await eventually(() => f.submissions.length === 1);
  assert.deepEqual(f.submissions, [operation.id]);
  await f.storage!.drain();
  assert.equal(f.storage!.diagnostics().pending, 0);
});

test('snapshots bound combined history, queue and files; full queue editing and paged paths preserve exact data', async t => {
  const f = await fixture(t, {}, false, true); const id = f.seed();
  const paths = Array.from({ length: 500 }, (_, n) => `${String(n).padStart(4, '0')}-${'中'.repeat(150)}.txt`);
  const items: NativeItem[] = Array.from({ length: 100 }, (_, n) => ({ id: 'heavy-' + n, kind: 'tool', runId: 'run-' + Math.floor(n / 2),
    status: 'completed', text: '\u0001'.repeat(8000), fileEdits: paths.slice(n % 2 ? 250 : 0, n % 2 ? 500 : 250) }));
  f.store.mergeHistory(id, items);
  const content = { text: '完整输入🙂'.repeat(2000), references: Array.from({ length: 8 }, () => ({ type: 'quote' as const, itemId: 'source', text: '中'.repeat(8000) })) };
  for (let n = 0; n < 20; n++) f.store.changeQueue(id, { action: 'add', entryId: randomUUID(), content });
  const entry = f.store.readQueue(id).entries[0]!;
  const oldest = randomUUID();
  f.store.enqueueOperation({ id: oldest, conversationId: id, type: 'stop', payload: { runId: 'old-run' } });
  for (let n = 0; n < 120; n++) {
    const operationId = randomUUID(); f.store.enqueueOperation({ id: operationId, conversationId: id, type: 'stop', payload: { runId: 'run-' + n } });
    f.store.settleOperation(operationId, { outcome: 'rejected', reason: '\u0001'.repeat(4096) });
  }
  const response = await f.request(`/conversations/${id}`);
  assert.equal(response.status, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(response.body)) <= 256 * 1024);
  assert.ok(response.body.history.items.length > 0);
  assert.equal(response.body.queue.entries.length, 20);
  assert.equal(response.body.queue.entries[0].content, undefined);
  assert.equal(response.body.queue.entries[0].preview.references, 8);
  assert.equal(response.body.operationState.unresolved, true, 'old unresolved admission is independent of recent operation display budget');
  assert.equal(response.body.operations.some((operation: { id: string }) => operation.id === oldest), false);
  assert.ok(response.body.turnFiles.every((summary: { paths: string[]; count: number }) => summary.paths.length === 0 && summary.count === 500));
  const url = `/conversations/${id}/queue/${entry.entryId}?version=${entry.version}`;
  assert.equal((await fetch(f.base + '/api/private/workbench' + url)).status, 401);
  assert.deepEqual((await f.request(url)).body.content, content);
  assert.equal((await f.request(`/conversations/${f.seed()}/queue/${entry.entryId}?version=${entry.version}`)).status, 404);
  assert.equal((await f.request(`/conversations/${id}/queue/${entry.entryId}?version=${entry.version + 1}`)).status, 409);
  const seen: string[] = []; let after: string | null = null;
  do {
    const query = new URLSearchParams({ run: 'run-49', ...(after ? { after } : {}) });
    const page = await f.request(`/conversations/${id}/turn-files?${query}`);
    assert.equal(page.status, 200); assert.ok(Buffer.byteLength(JSON.stringify(page.body)) < 64 * 1024);
    seen.push(...page.body.paths); after = page.body.afterPath;
    assert.ok(seen.length <= 500);
  } while (after);
  assert.deepEqual(seen, paths, 'bounded keyset pages preserve all recorded paths once');
});

test('a bounded native file projection retains an explicit partial marker across later reads', async t => {
  const f = await fixture(t, {}, false, true); const id = f.seed();
  f.setHistory([{ id: 'many-edits', kind: 'tool', status: 'completed', runId: 'many-files', text: 'Complete native record retained separately',
    tool: { name: 'FileChange' }, fileEdits: ['first.txt', 'second.txt'], fileEditsLimited: true }]);
  await f.workbench.reconcile(id);
  const page = (await f.request(`/conversations/${id}/turn-files?run=many-files`)).body;
  assert.deepEqual(page.paths, ['first.txt', 'second.txt']); assert.equal(page.count, 2); assert.equal(page.limited, true);
  assert.equal((await f.request(`/conversations/${id}`)).body.turnFiles[0].limited, true);
  f.store.mergeHistory(id, [{ id: 'later-edit', kind: 'tool', status: 'completed', runId: 'many-files', text: 'Another confirmed edit', fileEdits: ['third.txt'] }]);
  assert.equal((await f.request(`/conversations/${id}/turn-files?run=many-files`)).body.limited, true);
});

test('a failed image preserves immutable text, remains pending and repairs all image ordinals without duplication', async t => {
  const f = await fixture(t, {}, false, true); const id = f.seed();
  const content = Buffer.from('正文 prefix\n'.repeat(5000));
  const version = createHash('sha256').update(content).digest('hex');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==', 'base64');
  const second = Buffer.concat([png, Buffer.from('synthetic second image')]);
  let missing = true; let secondReads = 0;
  f.setBodyReader(async (_binding, _token, offset, limit) => ({ version, bytes: content.length, offset, data: content.subarray(offset, offset + limit), nextOffset: offset + limit >= content.length ? null : offset + limit }));
  f.setImageReader(async (_binding, path) => {
    if (path === 'first' && missing) throw new Error('synthetic_image_temporarily_missing');
    if (path === 'second') secondReads++;
    return (path === 'first' ? png : second).toString('base64');
  });
  const native: NativeItem = { id: 'with-images', kind: 'assistant', status: 'completed', text: '正文 prefix\n', sourceRevision: { generation: 'fixture-images', sequence: 1 },
    bodySources: { text: { token: 'private-source', version, bytes: content.length } }, imageSources: [{ path: 'first' }, { path: 'second' }] };
  f.setHistory([native]); f.setItemsReader(async () => [native]);
  await f.workbench.reconcile(id);
  let response = await f.request(`/conversations/${id}`);
  let item = response.body.history.items.find((value: { id: string }) => value.id === native.id);
  assert.equal(item.bodies.text.version, version); assert.equal(item.text, native.text);
  assert.equal(item.mediaPending, true); assert.equal(response.body.archive.latest.complete, false);
  assert.equal(secondReads, 1, 'a successful ordinal is durably pinned across retries');
  missing = false; await f.workbench.reconcile(id);
  await f.workbench.start();
  await eventually(() => f.store.archiveJobs(id).some(job => job.kind === 'backfill' && job.complete));
  await f.workbench.reconcile(id);
  response = await f.request(`/conversations/${id}`); item = response.body.history.items.find((value: { id: string }) => value.id === native.id);
  assert.equal(item.mediaPending, undefined); assert.equal(item.images.length, 2);
  assert.equal(item.bodies.text.version, version); assert.equal(secondReads, 1);
  assert.equal(response.body.archive.latest.complete, true);
  assert.deepEqual(f.store.resources.get(id, item.images[0].id).data, png);
  assert.deepEqual(f.store.resources.get(id, item.images[1].id).data, second);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workbench_resources WHERE conversation_id=?').get(id)!.n, 2);
});

test('accepted user input keeps its own complete body when native text expands references', async t => {
  const f = await fixture(t, {}, false, true); const id = f.seed();
  const text = '原始输入🙂'.repeat(1800);
  const references = [{ type: 'file' as const, path: 'synthetic.txt' }];
  const operationId = randomUUID();
  f.store.enqueueOperation({ id: operationId, conversationId: id, type: 'message', payload: { text, references } });
  f.store.claimOperation(operationId);
  f.store.settleOperation(operationId, { outcome: 'accepted', runId: 'original-run' });
  const native = Buffer.from(text + '\nExpanded native reference\n' + 'x'.repeat(100_000));
  const version = createHash('sha256').update(native).digest('hex'); let nativeReads = 0;
  f.setBodyReader(async () => { nativeReads++; throw new Error('expanded_transport_must_not_replace_original'); });
  f.setHistory([{ id: 'original-user', kind: 'user', operationId, status: 'completed', text: text.slice(0, 200),
    bodySources: { text: { token: 'expanded-source', version, bytes: native.length } } }]);
  await f.workbench.reconcile(id);
  const snapshot = await f.request(`/conversations/${id}`);
  const item = snapshot.body.history.items.find((value: { id: string }) => value.id === 'original-user');
  assert.ok(item); assert.ok(text.startsWith(item.text));
  assert.equal(item.bodies.references.version, createHash('sha256').update(JSON.stringify(references, null, 2)).digest('hex'));
  assert.equal(item.bodies.text.version, createHash('sha256').update(text).digest('hex'));
  assert.equal(item.bodies.text.bytes, Buffer.byteLength(text)); assert.equal(nativeReads, 0);
  const query = new URLSearchParams({ item: item.id, field: 'text', version: item.bodies.text.version, bytes: String(item.bodies.text.bytes), download: '1' });
  const download = await fetch(`${f.base}/api/private/workbench/conversations/${id}/body?${query}`, { headers: { cookie: f.credentials.cookie } });
  assert.equal(download.status, 200); assert.equal(await download.text(), text);
});

test('native giant bodies stage through the real worker and private HTTP streams fixed-version 64 KiB chunks', async t => {
  const f = await fixture(t, {}, false, true);
  const id = f.seed();
  const content = Buffer.from('合成数据🙂 long line\n'.repeat(100_000));
  const version = createHash('sha256').update(content).digest('hex');
  const token = 'synthetic-native-private-source';
  let nativeChunks = 0;
  f.setBodyReader(async (_binding, supplied, offset, limit) => {
    assert.equal(supplied, token); assert.equal(limit, 64 * 1024); nativeChunks++;
    const data = content.subarray(offset, Math.min(content.byteLength, offset + limit));
    return { version, bytes: content.byteLength, offset, data, nextOffset: offset + data.byteLength === content.byteLength ? null : offset + data.byteLength };
  });
  f.setHistory([{ id: 'native-giant', kind: 'assistant', status: 'completed', text: '合成数据🙂', bodySources: { text: { token, version, bytes: content.byteLength } } }]);
  await f.workbench.reconcile(id);
  assert.equal(nativeChunks, 32, 'explicit reconcile makes two passes, each importing at most 1 MiB before yielding');
  let snapshot = await f.request(`/conversations/${id}`);
  assert.equal(snapshot.body.archive.latest.complete, false);
  assert.equal(snapshot.body.archive.latest.error, null);
  assert.equal(snapshot.body.history.items.length, 0, 'partial body cannot be publicly linked');
  for (let pass = 0; pass < 8 && !snapshot.body.history.items.length; pass++) {
    await f.workbench.reconcile(id); snapshot = await f.request(`/conversations/${id}`);
  }
  assert.equal(nativeChunks, Math.ceil(content.byteLength / 65536), 'yield resumes at the saved byte offset');
  assert.equal(snapshot.status, 200);
  const item = snapshot.body.history.items.find((entry: NativeItem) => entry.id === 'native-giant');
  assert.ok(item, JSON.stringify(snapshot.body.archive));
  assert.deepEqual(item.bodies.text, { version, bytes: content.byteLength });
  assert.equal(JSON.stringify(snapshot.body).includes(token), false);
  assert.equal(JSON.stringify(snapshot.body.archive).includes('private-native-binding'), false);
  await f.workbench.start();
  await eventually(() => f.store.archiveJobs(id).some(job => job.kind === 'backfill' && job.complete));
  await f.workbench.reconcile(id);
  snapshot = await f.request(`/conversations/${id}`);
  assert.equal(snapshot.body.archive.latest.complete, true);
  const query = new URLSearchParams({ item: item.id, field: 'text', version, bytes: String(content.byteLength), offset: '0' });
  const endpoint = `${f.base}/api/private/workbench/conversations/${id}/body?`;
  assert.equal((await fetch(endpoint + query)).status, 401);
  let offset = 0;
  const received: Buffer[] = [];
  while (offset >= 0) {
    query.set('offset', String(offset));
    const response = await fetch(endpoint + query, { headers: { cookie: f.credentials.cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.match(response.headers.get('cache-control')!, /no-store/);
    assert.equal(response.headers.get('etag'), '"' + version + '"');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.byteLength <= 64 * 1024);
    received.push(bytes); offset = Number(response.headers.get('x-body-next-offset'));
  }
  assert.deepEqual(Buffer.concat(received), content);
  query.set('offset', '1');
  assert.equal((await fetch(endpoint + query, { headers: { cookie: f.credentials.cookie } })).status, 400);
  query.set('offset', '0'); query.set('download', '1');
  const download = await fetch(endpoint + query, { headers: { cookie: f.credentials.cookie } });
  assert.equal(download.headers.get('content-length'), String(content.byteLength));
  assert.match(download.headers.get('content-disposition')!, /^attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
  query.delete('download'); query.set('bytes', String(content.byteLength + 1));
  assert.equal((await fetch(endpoint + query, { headers: { cookie: f.credentials.cookie } })).status, 404);
});

test('workspace HTTP pages and unregistered search stay correct beyond the first 50 and the former 256 cap', async t => {
  const f = await fixture(t, {}, true, true);
  const orphan = f.seed();
  for (let index = 0; index < 307; index++) {
    const id = 'workspace-' + index.toString().padStart(4, '0');
    await f.storage!.workspaces.register({ id, label: 'Workspace ' + index.toString().padStart(4, '0'), directory: join(f.root, id),
      identity: 'synthetic-' + index, root_id: 'shared', pinned: 0, removed: 0 });
    f.store.createConversation({ id: randomUUID(), harnessId: 'dsh', workspaceId: id, cwd: join(f.root, id), title: 'Registered', configuration });
  }
  const configurationPage = (await f.request('/configuration')).body;
  workbenchConfigurationSchema.parse(configurationPage);
  assert.equal(configurationPage.workspaces.length, 50); assert.ok(configurationPage.workspaceCursor);
  const seen = new Set<string>(configurationPage.workspaces.map((entry: { id: string }) => entry.id));
  let cursor: string | null = configurationPage.workspaceCursor;
  while (cursor) {
    const response = await f.request('/workspaces?cursor=' + encodeURIComponent(cursor));
    assert.equal(response.status, 200); assert.ok(response.body.workspaces.length <= 50);
    for (const item of response.body.workspaces) { assert.equal(seen.has(item.id), false); seen.add(item.id); }
    cursor = response.body.nextCursor;
  }
  assert.equal(seen.size, 307);
  assert.equal((await f.request('/workspaces/workspace-0306')).body.workspace.label, 'Workspace 0306');
  const search = (await f.request('/conversation-search', { method: 'POST', body: { title: 'Registered' } })).body;
  assert.ok(!configurationPage.workspaces.some((value: { id: string }) => value.id === 'workspace-0306'));
  assert.equal(search.workspaceLabels.find((value: { id: string }) => value.id === 'workspace-0306').label, 'Workspace 0306');
  assert.ok(Buffer.byteLength(JSON.stringify(search)) <= 256 * 1024);
  const firstSearch = await f.request('/workspaces?query=0306');
  assert.deepEqual(firstSearch.body.workspaces, []); assert.equal(firstSearch.body.scanned, 256); assert.equal(firstSearch.body.scanLimited, true);
  const secondSearch = await f.request('/workspaces?query=0306&cursor=' + encodeURIComponent(firstSearch.body.nextCursor));
  assert.equal(secondSearch.body.workspaces[0].id, 'workspace-0306'); assert.equal(secondSearch.body.nextCursor, null);
  assert.equal((await f.request('/workspaces/workspace-0306', { authenticated: false })).status, 401);
  assert.equal((await f.request('/capacity', { authenticated: false })).status, 401);
  assert.ok(['ok', 'warning', 'full'].includes((await f.request('/capacity')).body.status));
  let beforeId: string | undefined; const found: string[] = []; let scans = 0;
  do {
    const response = await f.request('/conversation-search', { method: 'POST', body: { unregistered: true, ...(beforeId ? { beforeId } : {}) } });
    assert.equal(response.status, 200); found.push(...response.body.conversations.map((item: { id: string }) => item.id));
    beforeId = response.body.olderBeforeId ?? undefined; scans++;
    assert.ok(scans <= 4);
  } while (beforeId);
  assert.deepEqual(found, [orphan]); assert.equal(scans, 4, 'bounded scan must continue across empty registered-only pages');
  await f.storage!.workspaces.pin('workspace-0306', true);
  const stale = await f.request('/workspaces?cursor=' + encodeURIComponent(configurationPage.workspaceCursor));
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'workspace_cursor_expired');
});

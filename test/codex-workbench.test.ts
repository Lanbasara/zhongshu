import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { CodexRpc } from '../src/harness/codex/rpc.ts';
import { createCodexAdapter } from '../src/harness/codex/index.ts';
import type { NativeChange } from '../src/harness/types.ts';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { Workbench } from '../src/server/workbench.ts';
import { buildApp } from '../src/server/app.ts';
import { createAuth } from '../src/server/auth.ts';
import { createWorkbenchHttp } from '../src/server/workbench-http.ts';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'Expected transport/state condition'); await delay(10); }
}

/** Real IPC and application stack; only the external Codex protocol peer is synthetic. */
async function peer(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'zh-codex-state-'));
  const cwd = join(directory, 'workspace'); await mkdir(cwd);
  const socketPath = join(directory, 'rpc.sock');
  const configuration = { modelId: 'model-a', permissionId: 'workspace' };
  const operationId = randomUUID();
  let status: 'inProgress' | 'interrupted' = 'inProgress';
  let waiting = false;
  let http: Server | undefined; let ws: WebSocketServer | undefined;
  const calls: string[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  const nativeConfiguration = () => ({ thread: { id: 'thread-1', status: { type: status === 'inProgress' ? 'active' : 'idle', activeFlags: waiting ? ['waitingOnUserInput'] : [] } },
    cwd, model: configuration.modelId, activePermissionProfile: { id: configuration.permissionId }, approvalPolicy: 'never' });
  async function start() {
    assert.equal(http, undefined);
    http = createServer(); ws = new WebSocketServer({ server: http });
    ws.on('connection', socket => socket.on('message', bytes => {
      const input = JSON.parse(bytes.toString()) as { id?: number; method?: string };
      if (input.id === undefined || !input.method) return;
      calls.push(input.method);
      let result: unknown;
      switch (input.method) {
        case 'initialize': result = {}; break;
        case 'thread/resume': result = nativeConfiguration(); break;
        case 'thread/read': result = { thread: nativeConfiguration().thread }; break;
        case 'thread/turns/list': result = { data: [{ id: 'run-1', status }], nextCursor: null }; break;
        case 'thread/queue/list': result = { data: status === 'inProgress' && !waiting ? [{ id: 'one' }, { id: 'two' }, { id: 'three' }] : [], nextCursor: null }; break;
        case 'thread/items/list': result = { data: [{ turnId: 'run-1', completedAtMs: 1,
          item: { id: 'user-1', type: 'userMessage', clientId: operationId, content: [{ type: 'text', text: 'Synthetic work' }] } }], nextCursor: null }; break;
        case 'thread/unsubscribe': result = { status: 'unsubscribed' }; break;
        default: socket.send(JSON.stringify({ id: input.id, error: { code: -32601, message: 'Synthetic unsupported request' } })); return;
      }
      socket.send(JSON.stringify({ id: input.id, result }));
    }));
    await new Promise<void>(resolve => http!.listen(socketPath, resolve));
  }
  async function stop() {
    if (!http || !ws) return;
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>(resolve => ws!.close(() => resolve()));
    await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
    ws = undefined; http = undefined;
  }
  t.after(async () => { for (const close of cleanups.toReversed()) await close(); await stop(); await rm(directory, { recursive: true }); });
  return { directory, cwd, socketPath, configuration, operationId, calls, start, stop,
    cleanup(close: () => Promise<void>) { cleanups.push(close); },
    waitForInput() { waiting = true; },
    interrupt() { waiting = false; status = 'interrupted'; },
    notify() { for (const socket of ws?.clients ?? []) socket.send(JSON.stringify({ method: 'synthetic/current', params: {} })); } };
}

test('transport loss is emitted once per initialized connection, never for failed retries or intentional shutdown', async t => {
  const p = await peer(t); let losses = 0; let notifications = 0;
  const rpc = new CodexRpc(p.socketPath, { notification() { notifications++; }, serverRequest: () => false, disconnected() { losses++; } });
  p.cleanup(() => rpc.close());
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(rpc.connect());
  assert.equal(losses, 0, 'failed initial handshakes have no verified connection to lose');
  await p.start(); await rpc.request('thread/read', {});
  // Retain a resource only to inject callbacks that were queued by an older transport.
  const oldTransport = (rpc as unknown as { socket: WebSocket }).socket;
  await p.stop(); await until(() => losses === 1);
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(rpc.connect());
  assert.equal(losses, 1, 'offline retries must not create an invalidation storm');
  await p.start(); await rpc.request('thread/read', {});
  oldTransport.emit('message', Buffer.from(JSON.stringify({ method: 'synthetic/stale', params: {} })), false);
  oldTransport.emit('close');
  assert.equal(rpc.connected, true, 'old transport closure must not close the replacement');
  assert.equal(notifications, 0, 'old transport messages must not reach current observers');
  p.notify(); await until(() => notifications === 1);
  await p.stop(); await until(() => losses === 2);
  await p.start(); await rpc.request('thread/read', {}); await rpc.close();
  assert.equal(losses, 2, 'intentional shutdown does not report unexpected unavailability');
});

test('Codex transport loss immediately persists unknown, preserves facts, and recovers without redispatch', async t => {
  const p = await peer(t); await p.start();
  const adapter = createCodexAdapter({ socketPath: p.socketPath });
  const db = openDatabase(join(p.directory, 'data'), productMigrations);
  const store = createWorkbenchStore(db);
  const service = new Workbench(store, [{ id: 'fixture', label: 'fixture', directory: p.cwd }], new Map([['codex', adapter]]));
  p.cleanup(async () => { await service.close(); db.close(); });
  const id = randomUUID();
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: p.cwd, configuration: p.configuration });
  const binding = { id: 'thread-1', cwd: p.cwd, configuration: p.configuration, details: { version: 1, approvalPolicy: 'never' } };
  store.saveBinding(id, binding);
  store.enqueueOperation({ id: p.operationId, conversationId: id, type: 'message', payload: { text: 'Synthetic work' } });
  store.claimOperation(p.operationId); store.settleOperation(p.operationId, { outcome: 'accepted', runId: 'run-1' });
  await service.start();
  await until(() => store.getConversation(id)?.state.status === 'running' && service.snapshot(id).history.items.length === 1);
  const changes: NativeChange[] = [];
  const release = await adapter.watch(binding, change => changes.push(change));
  p.cleanup(async () => { release(); });
  const before = service.snapshot(id);
  assert.equal(before.conversation.state.pendingInputs, 3);
  await p.stop();
  await until(() => store.getConversation(id)?.state.status === 'unknown');
  const lost = service.snapshot(id);
  assert.equal(lost.conversation.state.configurationVerified, false);
  assert.equal(lost.conversation.state.runId, 'run-1');
  assert.equal(lost.conversation.state.pendingInputs, 3);
  assert.deepEqual(lost.conversation.binding, binding);
  assert.deepEqual(lost.history.items, before.history.items);
  assert.ok(lost.revision > before.revision);
  await assert.rejects(service.enqueue({ id: randomUUID(), conversationId: id, type: 'message', payload: { text: 'Must not dispatch offline' } }), { code: 'operation_needs_reconciliation' });
  for (let attempt = 0; attempt < 3; attempt++) await service.reconcile(id);
  assert.equal(store.getConversation(id)?.state.status, 'unknown');
  assert.equal(store.getConversation(id)?.state.runId, 'run-1');
  assert.equal(store.getConversation(id)?.state.pendingInputs, 3);
  assert.equal(changes.filter(change => change.type === 'unavailable').length, 1, 'all observers see the same single loss, not each failed retry');
  p.interrupt(); await p.start(); await service.reconcile(id);
  await until(() => store.getConversation(id)?.state.status === 'interrupted');
  const recovered = service.snapshot(id);
  assert.equal(recovered.conversation.state.configurationVerified, true);
  assert.equal(recovered.conversation.state.runId, 'run-1');
  assert.deepEqual(recovered.conversation.binding, binding);
  assert.deepEqual(recovered.history.items, before.history.items);
  assert.equal(recovered.operations.length, 1);
  assert.equal(recovered.operations[0]!.id, p.operationId);
  assert.equal(recovered.operations[0]!.status, 'accepted');
  assert.equal(p.calls.includes('turn/start'), false);
  assert.equal(p.calls.includes('turn/interrupt'), false);
});

test('archive rejects Codex native waiting status and succeeds after interruption', async t => {
  const p = await peer(t);
  p.waitForInput();
  await p.start();
  const db = openDatabase(join(p.directory, 'data'), productMigrations);
  const store = createWorkbenchStore(db);
  const adapter = createCodexAdapter({ socketPath: p.socketPath });
  const service = new Workbench(store, [{ id: 'fixture', label: 'Fixture', directory: p.cwd }], new Map([['codex', adapter]]));
  p.cleanup(async () => { await service.close(); db.close(); });

  const id = randomUUID();
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: p.cwd, configuration: p.configuration });
  store.saveBinding(id, { id: 'thread-1', cwd: p.cwd, configuration: p.configuration, details: { version: 1, approvalPolicy: 'never' } });

  const origin = 'https://workbench.example';
  const password = randomUUID() + randomUUID();
  await createAuth(db, { audit: () => {} }).initialize(password);
  const transport = createWorkbenchHttp(service);
  const app = await buildApp({ db, origin, privateRoutes: transport.routes });
  p.cleanup(async () => { transport.close(); await app.close(); });

  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin }, payload: { password } });
  assert.equal(login.statusCode, 200);
  const headers = { origin, cookie: login.cookies.map(cookie => cookie.name + '=' + cookie.value).join('; '), 'x-csrf-token': login.json().csrfToken };
  const conversationUrl = '/api/private/workbench/conversations/' + id;
  const archive = () => app.inject({ method: 'POST', url: conversationUrl + '/manage', headers, payload: { action: 'archive', archived: true } });
  const read = async () => (await app.inject({ method: 'GET', url: conversationUrl, headers })).json().conversation;

  const refused = await archive();
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, 'conversation_archive_busy');
  const waiting = await read();
  assert.equal(waiting.state.status, 'waiting');
  assert.equal(waiting.state.pendingInputs, 0);
  assert.equal(waiting.state.configurationVerified, true);
  assert.equal(waiting.archived, false);

  p.interrupt();
  const accepted = await archive();
  assert.equal(accepted.statusCode, 200);
  assert.equal((await read()).archived, true);
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { createDshAdapter } from '../src/harness/dsh/index.ts';
import { readLaunchFile } from '../src/harness/dsh/connection.ts';
import { LiveAssistant } from '../src/harness/dsh/live.ts';
import { snapshotSchema, stateFrom, terminalRunFrom } from '../src/harness/dsh/native.ts';
import type { Binding, NativeChange } from '../src/harness/types.ts';

type Event = { type: string; seq: number; time: number; data: Record<string, unknown> };
type Session = { id: string; cwd: string; model: { provider: string; model: string; reasoningEffort?: string }; permission: string; events: Event[]; turn: number; open: number | null; inbox: unknown[]; stepInbox: unknown[]; questions: unknown[] };
async function until(predicate: () => boolean, timeout = 4000): Promise<void> { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) assert.fail('condition did not become true'); await delay(10); } }

/** Protocol fixture only. These tests make no claim about real model execution. */
async function host() {
  const token = randomUUID(); const sessions = new Map<string, Session>(); const peers = new Map<string, WebSocket | null>();
  const follows = new Map<string, { socket: WebSocket; session: string }>();
  const calls: { method: string; args: Record<string, any> }[] = [];
  let rejectModel = false; let losePromptReceipt = false; let exchanges = 0; let nextPage: (() => void) | undefined;
  const wss = new WebSocketServer({ noServer: true });
  function append(session: Session, type: string, data: Record<string, unknown>): Event {
    const event = { type, data, seq: session.events.length, time: Date.now() }; session.events.push(event);
    for (const [streamId, follow] of follows) if (follow.session === session.id && follow.socket.readyState === WebSocket.OPEN) follow.socket.send(JSON.stringify({ type: 'item', streamId, value: { type: 'event', event } }));
    return event;
  }
  const projections = (session: Session) => ({ asOfSeq: Math.max(0, session.events.length - 1), values: { permissions: { currentValue: session.permission }, modelSelection: { next: session.model, lastUsed: session.turn ? session.model : null }, inbox: { 'next-turn': session.inbox, 'next-step': session.stepInbox }, turnOutline: session.events.filter(event => event.type === 'turn/start').map(event => ({ turn: event.data.turn, seq: event.seq, prompt: '', response: '' })), userQuestions: { active: session.questions } } });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/connect') {
      if (url.searchParams.get('token') !== token) { response.writeHead(401).end(); return; }
      assert.equal(url.searchParams.get('interactions'), 'none');
      const cookie = `peer-${++exchanges}`; peers.set(cookie, null); response.writeHead(302, { 'Set-Cookie': `peer=${cookie}; HttpOnly`, Location: '/api/remote.mux' }).end(); return;
    }
    const cookie = request.headers.cookie?.split('=')[1];
    if (!cookie || !peers.get(cookie)) { response.writeHead(401).end(); return; }
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error(); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString()); const args = body.payload.args; calls.push({ method: body.method, args });
      const session = sessions.get(args.request?.sessionId ?? args.agentId ?? args.request?.address?.sessionId);
      let value: unknown;
      switch (body.method) {
        case 'account/getState': value = { status: 'credential-stored' }; break;
        case 'session/modelCatalog': value = { groups: [{ id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'test-model', name: 'Test', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] }; break;
        case 'permissionPresets/catalog': value = { options: ['workspace-write', 'danger-full-access'].map(value => ({ value, name: value, description: 'Fixture permission' })) }; break;
        case 'session/create': {
          const id = `session-${sessions.size + 1}`; const created: Session = { id, cwd: args.request.cwd, model: { provider: 'deepseek-account', model: 'test-model', reasoningEffort: 'high' }, permission: 'workspace-write', events: [], turn: 0, open: null, inbox: [], stepInbox: [], questions: [] };
          sessions.set(id, created); append(created, 'permission/preset', { preset: 'workspace-write' }); value = { sessionId: id }; break;
        }
        case 'session/selectModel': {
          if (rejectModel) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'session/model-unavailable' } } })); return; }
          assert.ok(session); session.model = { provider: args.request.provider, model: args.request.model, reasoningEffort: args.request.reasoningEffort }; append(session, 'model/selection', session.model); value = { selected: session.model }; break;
        }
        case 'commands/execute': {
          assert.ok(session); assert.ok(['/permission workspace-write', '/permission danger-full-access'].includes(args.line));
          const permission = args.line.slice('/permission '.length); const changed = session.permission !== permission; session.permission = permission;
          append(session, 'permission/preset', { preset: permission });
          // Native rc.4 policy changes inject non-waking context into next-step.
          if (changed) { const notification = approvalContext(); session.stepInbox.push(notification); append(session, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [notification] }); }
          value = { result: { kind: 'success' } }; break;
        }
        case 'session/page': {
          assert.ok(session); const through = args.request.throughSeq; const before = args.request.beforeSeq ?? through + 1; const eligible = session.events.filter(event => event.seq <= through && event.seq < before); const records = eligible.slice(-args.request.maxMessages).map(event => ({ type: 'event', event })); value = { records, hasMore: eligible.length > records.length };
          const hook = nextPage; nextPage = undefined; hook?.(); break;
        }
        case 'session/prompt': {
          assert.ok(session); const message = { source: { kind: 'user', rpcId: args.request.requestId }, content: args.request.content };
          append(session, 'agent/inbox/spliced', { inserted: [message] }); session.turn++; session.open = session.events.length; append(session, 'turn/start', { turn: session.turn }); append(session, 'user/message', message);
          if (losePromptReceipt) { response.destroy(); return; } value = { accepted: true }; break;
        }
        case 'session/cancel': assert.ok(session); append(session, 'turn/end', { turn: session.turn, reason: { kind: 'aborted' } }); session.open = null; value = { accepted: true }; break;
        default: throw new Error('unexpected fixture endpoint');
      }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
    } catch { response.writeHead(500).end(); }
  });
  server.on('upgrade', (request, socket, head) => {
    const cookie = request.headers.cookie?.split('=')[1];
    if (!cookie || !peers.has(cookie) || peers.get(cookie)) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      peers.set(cookie, ws);
      ws.on('close', () => { peers.delete(cookie); for (const [id, follow] of follows) if (follow.socket === ws) follows.delete(id); });
      ws.on('message', bytes => {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'cancel') { follows.delete(message.streamId); return; }
        assert.equal(message.endpoint, 'session/follow'); const input = message.payload.args.request; const session = sessions.get(input.address.sessionId); assert.ok(session);
        follows.set(message.streamId, { socket: ws, session: session.id });
        const records = session.events.slice(-input.maxMessages).map(event => ({ type: 'event', event }));
        ws.send(JSON.stringify({ type: 'item', streamId: message.streamId, value: { type: 'snapshot', header: { id: session.id, cwd: session.cwd }, cursor: session.events.length - 1, records, hasMore: session.events.length > records.length, projections: projections(session) } }));
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const launch = `http://127.0.0.1:${address.port}/?token=${token}`;
  return { launch, sessions, calls, peers, follows, append, onNextPage(hook: () => void) { nextPage = hook; }, exchanges: () => exchanges, rejectModel: () => { rejectModel = true; }, losePromptReceipt: () => { losePromptReceipt = true; }, live(session: string, frame: unknown) { for (const [streamId, follow] of follows) if (follow.session === session) follow.socket.send(JSON.stringify({ type: 'item', streamId, value: { type: 'assistant-stream', frame } })); }, disconnect() { for (const peer of peers.values()) peer?.terminate(); }, async close() { for (const peer of peers.values()) peer?.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function setup() {
  const fixture = await host(); const directory = await mkdtemp(join(tmpdir(), 'zhongshu-dsh-test-')); const file = join(directory, 'launch'); await writeFile(file, fixture.launch, { mode: 0o600 });
  const adapter = createDshAdapter({ launchFile: file });
  async function create(permissionId = 'workspace-write'): Promise<Binding> { const catalog = await adapter.catalog(); assert.ok(catalog.available); const model = catalog.models[0]; assert.ok(model); return adapter.create({ cwd: directory, configuration: { modelId: model.id, permissionId } }, () => {}); }
  return { fixture, directory, file, adapter, create, async close() { await adapter.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); } };
}

function approvalContext() { return { id: randomUUID(), role: 'user', source: { kind: 'user-approval' }, content: [{ type: 'text', text: 'The approval policy has changed.' }] }; }

test('DSH permission setup context permits the first message without clearing native input', async () => {
  const context = await setup();
  try {
    const binding = await context.create('danger-full-access'); const native = context.fixture.sessions.get(binding.id)!;
    const retained = structuredClone(native.stepInbox); assert.equal(retained.length, 1);
    assert.equal((await context.adapter.state(binding)).pendingInputs, 0);
    const reconnected = createDshAdapter({ launchFile: context.file });
    try { assert.equal((await reconnected.state(binding)).pendingInputs, 0); } finally { await reconnected.close(); }
    assert.deepEqual(native.stepInbox, retained);
    assert.equal((await context.adapter.submit(binding, { id: randomUUID(), text: 'First message' })).outcome, 'accepted');
    assert.equal(context.fixture.calls.filter(call => call.method === 'session/prompt').length, 1);
    assert.deepEqual(native.stepInbox, retained, 'adapter must not delete native context');
  } finally { await context.close(); }
});

test('DSH passive context never hides queued user work or unknown next-step inputs', async () => {
  const context = await setup();
  try {
    const binding = await context.create('danger-full-access'); const native = context.fixture.sessions.get(binding.id)!;
    const passive = approvalContext();
    const blocked = [
      { ...approvalContext(), source: { kind: 'user', rpcId: randomUUID() } },
      { ...approvalContext(), source: { kind: 'unknown' } },
      { ...approvalContext(), role: undefined },
      { ...approvalContext(), source: { kind: 'user-approval', rpcId: randomUUID() } },
      { ...approvalContext(), content: [{ type: 'image', url: 'fixture' }] },
    ];
    for (const item of blocked) {
      native.stepInbox = [passive, item]; assert.equal((await context.adapter.state(binding)).pendingInputs, 1);
      assert.equal((await context.adapter.submit(binding, { id: randomUUID(), text: 'Must stay blocked' })).outcome, 'rejected');
    }
    native.stepInbox = [passive]; native.inbox = [approvalContext()];
    assert.equal((await context.adapter.state(binding)).pendingInputs, 1, 'next-turn is never passive context');
    native.inbox = []; native.questions = [{ callId: 'still-waiting' }];
    assert.equal((await context.adapter.state(binding)).status, 'waiting');
    assert.equal(context.fixture.calls.some(call => call.method === 'session/prompt'), false);
  } finally { await context.close(); }
});

test('DSH launch files reject public endpoints, loose permissions, and symlinks without leaking tokens', async () => {
  const context = await setup();
  try {
    assert.equal((await readLaunchFile(context.file)).hostname, '127.0.0.1');
    await chmod(context.file, 0o644); await assert.rejects(readLaunchFile(context.file), { message: 'DSH_LAUNCH_FILE_INVALID' });
    await chmod(context.file, 0o600); await writeFile(context.file, 'https://example.com:443/?token=secret-secret-secret'); await assert.rejects(readLaunchFile(context.file), { message: 'DSH_LAUNCH_FILE_INVALID' });
    const link = join(context.directory, 'link'); await symlink(context.file, link); await assert.rejects(readLaunchFile(link), { message: 'DSH_LAUNCH_FILE_INVALID' });
  } finally { await context.close(); }
});

test('DSH persists the native binding before configuration failure and never creates a replacement', async () => {
  const context = await setup();
  try {
    const catalog = await context.adapter.catalog(); context.fixture.rejectModel(); let bound: Binding | undefined;
    await assert.rejects(context.adapter.create({ cwd: context.directory, configuration: { modelId: catalog.models[0]!.id, permissionId: 'workspace-write' } }, value => { bound = value; assert.equal(context.fixture.calls.at(-1)?.method, 'session/create'); }));
    assert.ok(bound); assert.equal(context.fixture.calls.filter(call => call.method === 'session/create').length, 1); assert.equal(context.fixture.calls.some(call => call.method === 'session/prompt'), false);
  } finally { await context.close(); }
});

test('DSH unknown prompt receipt reconciles its original operation identity without retransmission', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); context.fixture.losePromptReceipt(); const operation = { id: randomUUID(), text: 'Synthetic input' };
    assert.equal((await context.adapter.submit(binding, operation)).outcome, 'unknown');
    assert.equal((await context.adapter.reconcile(binding, operation.id)).outcome, 'accepted');
    assert.equal(context.fixture.calls.filter(call => call.method === 'session/prompt').length, 1);
    assert.equal((await context.adapter.reconcile(binding, randomUUID())).outcome, 'unknown');
  } finally { await context.close(); }
});

test('DSH history pages remain chronological at their native cut and cursors cannot cross sessions', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    for (let i = 1; i <= 5; i++) context.fixture.append(native, 'user/message', { source: { kind: 'user', rpcId: `op-${i}` }, content: [{ type: 'text', text: `message-${i}` }] });
    const page = await context.adapter.history(binding, undefined, 2); assert.deepEqual(page.items.map(item => item.text), ['message-4', 'message-5']); assert.ok(page.olderCursor);
    context.fixture.append(native, 'user/message', { source: { kind: 'user', rpcId: 'later' }, content: [{ type: 'text', text: 'later' }] });
    const older = await context.adapter.history(binding, page.olderCursor, 2); assert.deepEqual(older.items.map(item => item.text), ['message-2', 'message-3']);
    const other = await context.create(); await assert.rejects(context.adapter.history(other, page.olderCursor));
  } finally { await context.close(); }
});

test('DSH verifies configuration, reports unsupported waiting, and stopping preserves queued inputs', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    await context.adapter.submit(binding, { id: randomUUID(), text: 'Synthetic task' }); native.inbox = [{ source: { rpcId: randomUUID() } }]; native.questions = [{ callId: 'question' }];
    const waiting = await context.adapter.state(binding); assert.equal(waiting.status, 'waiting'); assert.equal(waiting.pendingInputs, 1); assert.ok(waiting.runId);
    assert.equal((await context.adapter.stop(binding, 'stale-run')).outcome, 'rejected'); assert.equal(context.fixture.calls.some(call => call.method === 'session/cancel'), false);
    native.questions = []; assert.equal((await context.adapter.stop(binding, waiting.runId)).outcome, 'accepted');
    const stopped = await context.adapter.state(binding); assert.equal(stopped.pendingInputs, 1); assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.runId, waiting.runId);
    native.model.reasoningEffort = 'low'; assert.equal((await context.adapter.state(binding)).configurationVerified, false);
    assert.equal((await context.adapter.submit(binding, { id: randomUUID(), text: 'Must not dispatch' })).outcome, 'rejected'); assert.equal(context.fixture.calls.filter(call => call.method === 'session/prompt').length, 1);
  } finally { await context.close(); }
});

test('DSH live text and durable text share an ID, and connection loss is explicit with reauthentication', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!; const changes: NativeChange[] = [];
    const unsubscribe = await context.adapter.watch(binding, change => changes.push(change)); await until(() => changes.some(change => change.type === 'state'));
    native.turn = 1; native.open = native.events.length; context.fixture.append(native, 'turn/start', { turn: 1 });
    context.fixture.live(binding.id, { type: 'start', attemptId: 'attempt-1', turn: 1, step: 1, revision: 1 });
    context.fixture.live(binding.id, { type: 'chunk', attemptId: 'attempt-1', index: 0, revision: 2, chunk: { type: 'text-delta', index: 0, text: 'Hello' } });
    await until(() => changes.some(change => change.type === 'item' && change.item.text === 'Hello'));
    context.fixture.append(native, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Hello world' }] } });
    await until(() => changes.some(change => change.type === 'item' && change.item.text === 'Hello world'));
    const items = changes.flatMap(change => change.type === 'item' && change.item.kind === 'assistant' ? [change.item] : []); assert.equal(new Set(items.map(item => item.id)).size, 1);
    context.fixture.disconnect(); await until(() => changes.some(change => change.type === 'state' && change.state.status === 'unknown')); await until(() => context.fixture.exchanges() >= 2);
    context.fixture.append(native, 'user/message', { source: { kind: 'user', rpcId: 'after-reconnect' }, content: [{ type: 'text', text: 'Recovered observation' }] });
    await until(() => changes.some(change => change.type === 'item' && change.item.text === 'Recovered observation'));
    unsubscribe(); await context.adapter.close(); assert.equal(context.fixture.calls.some(call => call.method === 'session/cancel'), false);
  } finally { await context.close(); }
});

test('DSH reconnect rereads a rotated launch file and never transfers credentials to the old Host', async () => {
  const context = await setup(); const replacement = await host();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    replacement.sessions.set(binding.id, structuredClone(native)); const changes: NativeChange[] = [];
    const unsubscribe = await context.adapter.watch(binding, value => changes.push(value)); await until(() => changes.some(change => change.type === 'state'));
    await writeFile(context.file, replacement.launch, { mode: 0o600 }); context.fixture.disconnect();
    await until(() => replacement.exchanges() === 1);
    replacement.append(replacement.sessions.get(binding.id)!, 'user/message', { source: { kind: 'user', rpcId: 'rotated-host' }, content: [{ type: 'text', text: 'Restored from replacement Host' }] });
    await until(() => changes.some(change => change.type === 'item' && change.item.text === 'Restored from replacement Host'));
    assert.equal(context.fixture.exchanges(), 1); unsubscribe(); await context.adapter.close();
    assert.equal((await fetch(new URL('/', replacement.launch))).status, 401);
  } finally { await context.close(); await replacement.close(); }
});

test('DSH compact stream snapshots resume at their chunk index and gaps require a fresh snapshot', () => {
  const live = new LiveAssistant('session-test');
  const initial = snapshotSchema.parse({ type: 'snapshot', header: { id: 'session-test', cwd: '/synthetic' }, cursor: 12, records: [], hasMore: false, projections: { asOfSeq: 12, values: {} }, assistantStream: { revision: 8, activeAttempt: { attemptId: 'attempt', turn: 2, step: 1, nextIndex: 3, stream: [{ type: 'text-chunks', index: 0, texts: ['Hello', ' '], time0: 0, dt: [0, 1] }] } } });
  assert.equal(live.restore(initial)?.text, 'Hello ');
  assert.deepEqual(live.accept({ type: 'chunk', attemptId: 'attempt', revision: 7, index: 2, chunk: { type: 'text-delta', index: 0, text: 'duplicate' } }), {});
  assert.equal(live.accept({ type: 'chunk', attemptId: 'attempt', revision: 9, index: 3, chunk: { type: 'text-delta', index: 0, text: 'world' } }).item?.text, 'Hello world');
  assert.equal(live.accept({ type: 'chunk', attemptId: 'attempt', revision: 11, index: 5, chunk: { type: 'text-delta', index: 0, text: 'gap' } }).resubscribe, true);
});

test('DSH subscriptions have a bound and unsubscribe releases native observations without cancelling work', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const stops: (() => void)[] = [];
    for (let i = 0; i < 24; i++) stops.push(await context.adapter.watch(binding, () => {}));
    await assert.rejects(context.adapter.watch(binding, () => {}), { message: 'DSH_WATCH_LIMIT' });
    for (const stop of stops) stop(); await until(() => context.fixture.follows.size === 0);
    assert.equal(context.fixture.calls.some(call => call.method === 'session/cancel'), false);
  } finally { await context.close(); }
});

test('DSH completed state retains the same native run identity, while a new session has none', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    const blank = await context.adapter.state(binding); assert.equal(blank.runId, undefined); assert.equal(blank.status, 'idle'); assert.equal(blank.configurationVerified, true);
    await context.adapter.submit(binding, { id: randomUUID(), text: 'Synthetic task' }); const running = await context.adapter.state(binding); assert.ok(running.runId);
    context.fixture.append(native, 'turn/end', { turn: native.turn, reason: { kind: 'completed' } }); native.open = null;
    const completed = await context.adapter.state(binding); assert.equal(completed.status, 'idle'); assert.equal(completed.runId, running.runId);
  } finally { await context.close(); }
});

test('DSH empty public turn outline means blank only without contradictory execution evidence', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    const blank = snapshotSchema.parse({ type: 'snapshot', header: { id: binding.id, cwd: binding.cwd }, cursor: 5, records: [], hasMore: true,
      projections: { asOfSeq: 5, values: { turnOutline: [], permissions: { currentValue: native.permission }, modelSelection: { next: native.model, lastUsed: null }, inbox: { 'next-turn': [], 'next-step': [] } } } });
    assert.equal(stateFrom(binding, blank).status, 'idle');
    blank.projections.values.modelSelection!.lastUsed = native.model;
    assert.equal(stateFrom(binding, blank).status, 'unknown');
    blank.projections.values.modelSelection!.lastUsed = null;
    blank.records.push({ type: 'event', event: { type: 'turn/start', seq: 5, time: 1, data: { turn: 1 } } });
    assert.equal(stateFrom(binding, blank).status, 'unknown');
    const permission = (await context.adapter.catalog()).permissions.find(item => item.id === 'workspace-write')!;
    assert.equal(permission.label, '工作区读写'); assert.match(permission.description, /交互式审批尚不支持/);
  } finally { await context.close(); }
});

test('DSH running and completed state use wire outline and paged turn facts, including old approvals', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    await context.adapter.submit(binding, { id: randomUUID(), text: 'Synthetic long turn' });
    context.fixture.append(native, 'approval/asked', { id: 'approval-before-window' });
    for (let index = 0; index < 12; index++) context.fixture.append(native, 'synthetic/metadata', { index });
    const waiting = await context.adapter.state(binding); assert.equal(waiting.status, 'waiting'); assert.match(waiting.runId!, /:turn:1$/);
    assert.ok(context.fixture.calls.some(call => call.method === 'session/page'));
    context.fixture.append(native, 'approval/decided', { id: 'approval-before-window', outcome: 'approved' });
    assert.equal((await context.adapter.state(binding)).status, 'running');
    context.fixture.append(native, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); native.open = null;
    for (let index = 0; index < 12; index++) context.fixture.append(native, 'synthetic/metadata', { index });
    const completed = await context.adapter.state(binding); assert.equal(completed.status, 'idle'); assert.equal(completed.runId, waiting.runId);
  } finally { await context.close(); }
});

test('DSH user messages without turn fields keep exact turn identities across page cuts and receipt reconciliation', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    const first = randomUUID(); const second = randomUUID();
    await context.adapter.submit(binding, { id: first, text: 'First synthetic turn' });
    context.fixture.append(native, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); native.open = null;
    await context.adapter.submit(binding, { id: second, text: 'Second synthetic turn' });
    context.fixture.append(native, 'turn/end', { turn: 2, reason: { kind: 'completed' } }); native.open = null;
    let cursor: string | undefined; const seen = new Map<string, string | undefined>();
    for (let page = 0; page < 10; page++) {
      const history = await context.adapter.history(binding, cursor, 1);
      for (const item of history.items) if (item.operationId) seen.set(item.operationId, item.runId);
      if (!history.olderCursor) break; cursor = history.olderCursor;
    }
    assert.equal(seen.get(first), `dsh:${binding.id}:turn:1`); assert.equal(seen.get(second), `dsh:${binding.id}:turn:2`);
    assert.deepEqual(await context.adapter.reconcile(binding, first), { outcome: 'accepted', runId: seen.get(first) });
    assert.equal((await context.adapter.state(binding)).runId, seen.get(second));
    assert.equal(context.fixture.calls.filter(call => call.method === 'session/prompt').length, 2);
  } finally { await context.close(); }
});

test('DSH proves the accepted turn ended even after an automatic turn, including a fresh adapter', async () => {
  const context = await setup(); let replacement: ReturnType<typeof createDshAdapter> | undefined;
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    await context.adapter.submit(binding, { id: randomUUID(), text: 'Synthetic user turn' });
    const target = `dsh:${binding.id}:turn:1`;
    context.fixture.append(native, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); native.open = null;
    for (let index = 0; index < 120; index++) context.fixture.append(native, 'synthetic/metadata', { index });
    native.turn = 2; context.fixture.append(native, 'turn/start', { turn: 2 });
    context.fixture.append(native, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
    const recovered = await context.adapter.state(binding, target);
    assert.equal(recovered.status, 'idle'); assert.equal(recovered.runId, `dsh:${binding.id}:turn:2`);
    assert.equal(recovered.terminalRunId, target); assert.equal(recovered.configurationVerified, true);
    const pages = context.fixture.calls.filter(call => call.method === 'session/page'); assert.ok(pages.length >= 2);
    assert.equal(pages[0]!.args.request.beforeSeq, native.events.find(event => event.type === 'turn/start' && event.data.turn === 2)!.seq);
    await context.adapter.close(); replacement = createDshAdapter({ launchFile: context.file });
    assert.equal((await replacement.state(binding, target)).terminalRunId, target);
    assert.equal((await replacement.state(binding, `dsh:${binding.id}:turn:3`)).terminalRunId, undefined);
    assert.equal((await replacement.state(binding)).terminalRunId, undefined);
    assert.equal((await replacement.state(binding, 'dsh:another-session:turn:1')).terminalRunId, undefined);
    assert.equal(context.fixture.calls.filter(call => call.method === 'session/prompt').length, 1);
  } finally { await replacement?.close(); await context.close(); }
});

test('DSH never infers target completion from a later turn or a closer outside its outline interval', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    await context.adapter.submit(binding, { id: randomUUID(), text: 'Synthetic unfinished turn' });
    const target = `dsh:${binding.id}:turn:1`;
    const running = await context.adapter.state(binding, target); assert.equal(running.status, 'running'); assert.equal(running.terminalRunId, undefined);
    native.turn = 2; context.fixture.append(native, 'turn/start', { turn: 2 });
    context.fixture.append(native, 'turn/end', { turn: 2, reason: { kind: 'completed' } }); native.open = null;
    const later = await context.adapter.state(binding, target); assert.equal(later.status, 'idle'); assert.equal(later.terminalRunId, undefined);
    context.fixture.append(native, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    assert.equal((await context.adapter.state(binding, target)).terminalRunId, undefined);
    assert.equal((await context.adapter.state(binding, `dsh:${binding.id}:turn:01`)).terminalRunId, undefined);
  } finally { await context.close(); }
});

test('DSH target completion queries are bounded and missing old proof stays absent', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    await context.adapter.submit(binding, { id: randomUUID(), text: 'Synthetic old turn' });
    context.fixture.append(native, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); native.open = null;
    for (let index = 0; index < 1050; index++) context.fixture.append(native, 'synthetic/metadata', { index });
    native.turn = 2; context.fixture.append(native, 'turn/start', { turn: 2 });
    context.fixture.append(native, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
    const before = context.fixture.calls.filter(call => call.method === 'session/page').length;
    const current = await context.adapter.state(binding, `dsh:${binding.id}:turn:1`);
    assert.equal(current.status, 'idle'); assert.equal(current.runId, `dsh:${binding.id}:turn:2`); assert.equal(current.terminalRunId, undefined);
    assert.equal(context.fixture.calls.filter(call => call.method === 'session/page').length - before, 10);
  } finally { await context.close(); }
});

test('DSH target proof requires a known durable reason, matching session, and matching snapshot cut', () => {
  const session = 'synthetic-session'; const target = `dsh:${session}:turn:1`;
  const snapshot = snapshotSchema.parse({ type: 'snapshot', header: { id: session, cwd: '/synthetic' }, cursor: 8, hasMore: false,
    projections: { asOfSeq: 8, values: { turnOutline: [{ turn: 1, seq: 3 }, { turn: 2, seq: 6 }] } },
    records: [{ type: 'event', event: { type: 'turn/end', seq: 5, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } }] });
  for (const kind of ['completed', 'aborted', 'interrupted', 'error', 'blocked', 'max-tokens', 'forked']) {
    snapshot.records[0]!.event.data.reason = { kind }; assert.equal(terminalRunFrom(session, snapshot, target), target);
  }
  snapshot.records[0]!.event.data.reason = { kind: 'unknown-extension' }; assert.equal(terminalRunFrom(session, snapshot, target), undefined);
  snapshot.records[0]!.event.data.reason = { kind: 'completed' };
  assert.equal(terminalRunFrom(session, snapshot, `dsh:${session}:turn:2`), undefined);
  assert.equal(terminalRunFrom('other-session', snapshot, target), undefined);
  snapshot.projections.asOfSeq = 7; assert.equal(terminalRunFrom(session, snapshot, target), undefined);
  snapshot.projections.asOfSeq = 8; snapshot.records[0]!.event.seq = 9; assert.equal(terminalRunFrom(session, snapshot, target), undefined);
});

test('DSH rechecks current execution after target paging and refuses to queue behind new work', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    await context.adapter.submit(binding, { id: randomUUID(), text: 'Synthetic user turn' });
    context.fixture.append(native, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); native.open = null;
    for (let index = 0; index < 12; index++) context.fixture.append(native, 'synthetic/metadata', { index });
    native.turn = 2; context.fixture.append(native, 'turn/start', { turn: 2 }); context.fixture.append(native, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
    context.fixture.onNextPage(() => { native.turn = 3; native.open = native.events.length; context.fixture.append(native, 'turn/start', { turn: 3 }); });
    const result = await context.adapter.state(binding, `dsh:${binding.id}:turn:1`);
    assert.equal(result.terminalRunId, `dsh:${binding.id}:turn:1`); assert.equal(result.status, 'running'); assert.equal(result.runId, `dsh:${binding.id}:turn:3`);
    assert.equal((await context.adapter.submit(binding, { id: randomUUID(), text: 'Must not queue behind native work' })).outcome, 'rejected');
    context.fixture.append(native, 'turn/end', { turn: 3, reason: { kind: 'completed' } }); native.open = null; native.inbox = [{ source: { rpcId: randomUUID() } }];
    assert.equal((await context.adapter.submit(binding, { id: randomUUID(), text: 'Must not queue behind native input' })).outcome, 'rejected');
    assert.equal(context.fixture.calls.filter(call => call.method === 'session/prompt').length, 1);
  } finally { await context.close(); }
});

test('DSH discards target proof if the Host history moves backwards during lookup', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    await context.adapter.submit(binding, { id: randomUUID(), text: 'Synthetic user turn' });
    context.fixture.append(native, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); native.open = null;
    for (let index = 0; index < 12; index++) context.fixture.append(native, 'synthetic/metadata', { index });
    native.turn = 2; context.fixture.append(native, 'turn/start', { turn: 2 }); context.fixture.append(native, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
    context.fixture.onNextPage(() => { native.events.splice(3); native.turn = 0; });
    const result = await context.adapter.state(binding, `dsh:${binding.id}:turn:1`);
    assert.equal(result.status, 'unknown'); assert.equal(result.terminalRunId, undefined); assert.equal(result.configurationVerified, false);
  } finally { await context.close(); }
});

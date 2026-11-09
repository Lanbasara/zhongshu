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
type Session = { id: string; cwd: string; model: { provider: string; model: string; reasoningEffort?: string }; permission: string; events: Event[]; turn: number; open: number | null; inbox: unknown[]; stepInbox: unknown[]; questions: unknown[]; plan?: { active: boolean; pending: boolean }; agentPreset?: string };
async function until(predicate: () => boolean, timeout = 4000): Promise<void> { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) assert.fail('condition did not become true'); await delay(10); } }

/** Protocol fixture only. These tests make no claim about real model execution. */
async function host() {
  const token = randomUUID(); const sessions = new Map<string, Session>(); const peers = new Map<string, WebSocket | null>();
  const follows = new Map<string, { socket: WebSocket; session: string }>();
  const calls: { method: string; args: Record<string, any> }[] = [];
  let rejectModel = false; let losePromptReceipt = false; let exchanges = 0; let nextPage: (() => void) | undefined; let followCalls = 0;
  let catalog: unknown = { groups: [{ id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'test-model', name: 'Test', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] };
  let signedIn = true;
  let profile: 'ready' | 'failed' | 'rejected' = 'ready';
  let balance: 'ready' | 'failed' | 'rejected' = 'ready';
  const followRequests: { kind: string; activate?: boolean }[] = [];
  let presetIds = ['standard', 'ptc', 'minimal', 'cordis']; const brokenPresets = new Set<string>(); let lockedSelects = 0;
  let signIn: { id: string; phase: string; state: string; callbackOrigin: string } | null = null;
  const wss = new WebSocketServer({ noServer: true });
  // Answering clients (ADR 0016): forwarded requests park until settled and are replayed to every new $events stream.
  const eventStreams = new Map<string, { socket: WebSocket; clientId: string }>(); let clients = 0;
  const parked = new Map<string, { event: string; agentId: string; request: unknown }>(); const settled: { clientId: string; eventId: string; outcome: any }[] = [];
  let failNextResult: 'drop' | undefined;
  const forward = (streamId: string, socket: WebSocket, eventId: string, value: { event: string; agentId: string; request: unknown }) =>
    socket.send(JSON.stringify({ type: 'item', streamId, value: { type: 'waterfall', eventId, ...value } }));
  function append(session: Session, type: string, data: Record<string, unknown>): Event {
    const event = { type, data, seq: session.events.length, time: Date.now() }; session.events.push(event);
    for (const [streamId, follow] of follows) if (follow.session === session.id && follow.socket.readyState === WebSocket.OPEN) follow.socket.send(JSON.stringify({ type: 'item', streamId, value: { type: 'event', event } }));
    return event;
  }
  const projections = (session: Session) => ({ asOfSeq: Math.max(0, session.events.length - 1), values: { permissions: { currentValue: session.permission }, modelSelection: { next: session.model, lastUsed: session.turn ? session.model : null }, inbox: { 'next-turn': session.inbox, 'next-step': session.stepInbox }, turnOutline: session.events.filter(event => event.type === 'turn/start').map(event => ({ turn: event.data.turn, seq: event.seq, prompt: '', response: '' })), userQuestions: { active: session.questions }, ...(session.plan ? { plan: session.plan } : {}), agentPreset: session.agentPreset ?? 'standard' } });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/connect') {
      if (url.searchParams.get('token') !== token) { response.writeHead(401).end(); return; }
      assert.equal(url.searchParams.get('interactions'), 'answer');
      const cookie = `peer-${++exchanges}`; peers.set(cookie, null); response.writeHead(302, { 'Set-Cookie': `peer=${cookie}; HttpOnly`, Location: '/api/remote.mux' }).end(); return;
    }
    // The Host's loopback callback: state-checked, no RPC authentication (DSH deepseek-account-platform).
    if (url.pathname === '/oauth/callback') {
      if (!signIn || url.searchParams.get('state') !== signIn.state || url.searchParams.getAll('code').length !== 1) { response.writeHead(400).end(); return; }
      if (signIn.phase !== 'waiting-browser') { response.writeHead(410).end(); return; }
      if (url.searchParams.get('code') === 'good') { signIn.phase = 'succeeded'; signedIn = true; response.writeHead(204).end(); }
      else { signIn.phase = 'failed'; response.writeHead(200).end(); }
      return;
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
        case 'agentPresets/list': value = { presets: presetIds.map((id, order) => ({ id, isDefault: id === 'standard', order: order + 1, ...(brokenPresets.has(id) ? { broken: true } : {}) })) }; break;
        case 'agentPresets/select': {
          const target = sessions.get(args.agentId);
          if (!target || target.turn > 0 || target.open !== null) { lockedSelects++; { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'agent-preset/locked' } } })); return; } }
          target.agentPreset = args.agentPreset; value = { agentPreset: args.agentPreset }; break;
        }
        case 'account/getState': value = { status: signedIn ? 'credential-stored' : 'signed-out', links: { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/top_up' },
          attempt: signIn ? { id: signIn.id, phase: signIn.phase, ...(signIn.phase === 'waiting-browser' ? { authorizeUrl: `https://platform.example/sign_in?state=${signIn.state}` } : {}) } : null }; break;
        case 'account/startSignIn':
          signIn = { id: randomUUID(), phase: 'waiting-browser', state: randomUUID(), callbackOrigin: args.callbackOrigin };
          value = { status: signedIn ? 'credential-stored' : 'signed-out', links: {}, attempt: { id: signIn.id, phase: 'initializing' } }; break;
        case 'account/cancelSignIn': if (signIn && signIn.id === args.attemptId) signIn.phase = 'cancelled'; value = { status: signedIn ? 'credential-stored' : 'signed-out', links: {}, attempt: null }; break;
        // A rejected grant is cleared by the Host and the read yields null (DSH deepseek-account README).
        case 'account/getProfile': value = profile === 'rejected' ? (signedIn = false, null) : profile === 'failed' ? { status: 'failed' } : { status: 'ready', value: { id: 'u1', name: 'Synthetic', contact: '138****9119' } }; break;
        case 'account/getBalance': value = balance === 'rejected' ? (signedIn = false, null) : balance === 'failed' ? { status: 'failed' } : { status: 'ready', value: [{ currency: 'CNY', totalBalance: '9.00' }], bonusWallets: [] }; break;
        case 'session/modelCatalog': value = catalog; break;
        case 'permissionPresets/catalog': value = { options: ['workspace-write', 'danger-full-access'].map(value => ({ value, name: value, description: 'Fixture permission' })) }; break;
        case 'session/list': assert.deepEqual(args, { _request: {} }); value = { items: [...sessions.values()].map(s => ({ sessionId: s.id, cwd: s.cwd, blank: !s.turn })) }; break;
        case 'skills/list': assert.ok(session); value = { skills: [{ name: 'proof', description: 'Synthetic skill' }] }; break;
        case 'session/create': {
          const id = args.request.sessionId ?? `session-${sessions.size + 1}`; const created: Session = { id, cwd: args.request.cwd, model: { provider: 'deepseek-account', model: 'test-model', reasoningEffort: 'high' }, permission: 'workspace-write', events: [], turn: 0, open: null, inbox: [], stepInbox: [], questions: [] };
          if (args.request.agentPreset !== undefined) {
            if (!presetIds.includes(args.request.agentPreset)) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'agent-preset/not-found' } } })); return; }
            created.agentPreset = args.request.agentPreset;
          }
          sessions.set(id, created); append(created, 'permission/preset', { preset: 'workspace-write' }); value = { sessionId: id, ...(created.agentPreset ? { agentPreset: created.agentPreset } : {}) }; break;
        }
        case 'session/selectModel': {
          if (rejectModel) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'session/model-unavailable' } } })); return; }
          assert.ok(session); session.model = { provider: args.request.provider, model: args.request.model, reasoningEffort: args.request.reasoningEffort }; append(session, 'model/selection', session.model); value = { selected: session.model }; break;
        }
        case 'commands/execute': {
          assert.ok(session);
          if (args.line === '/plan' || args.line === '/plan off') {
            // Native plan mode is session state; a change requested between turns waits for the next turn.
            const active = args.line === '/plan'; session.plan = { active, pending: false }; append(session, 'plan/mode', { active });
            // Native rc.4: a switch in a session that has run leaves a non-waking notice in next-step.
            if (session.turn > 0) { const summary = active ? 'The user switched this session to plan mode.' : 'The user switched this session out of plan mode.';
              const notice = { content: [{ type: 'text', text: summary }], source: { kind: 'plan-mode', form: 'notice', summary }, role: 'user', id: randomUUID() };
              session.stepInbox.push(notice); append(session, 'agent/inbox/spliced', { target: 'next-step', start: session.stepInbox.length - 1, inserted: [notice] }); }
            value = { commandId: randomUUID(), result: { kind: 'success', text: active ? 'Plan mode on' : 'Plan mode off' } }; break;
          }
          assert.ok(['/permission workspace-write', '/permission danger-full-access'].includes(args.line));
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
        case '$events/result': {
          if (failNextResult === 'drop') { failNextResult = undefined; response.destroy(); return; }
          if (![...eventStreams.values()].some(stream => stream.clientId === args.clientId)) {
            response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'gateway/interactions-forbidden' } } })); return;
          }
          if (parked.delete(args.eventId)) settled.push({ clientId: args.clientId, eventId: args.eventId, outcome: args.outcome });
          value = null; break;
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
        if (message.type === 'cancel') { follows.delete(message.streamId); eventStreams.delete(message.streamId); return; }
        if (message.endpoint === '$events') {
          assert.deepEqual(message.payload.args, {});
          const clientId = `client-${++clients}`; eventStreams.set(message.streamId, { socket: ws, clientId });
          ws.on('close', () => eventStreams.delete(message.streamId));
          ws.send(JSON.stringify({ type: 'item', streamId: message.streamId, value: { type: 'ready', clientId, host: { home: '/' } } }));
          for (const [eventId, value] of parked) forward(message.streamId, ws, eventId, value);
          return;
        }
        assert.equal(message.endpoint, 'session/follow'); const input = message.payload.args.request; followRequests.push({ kind: input.address.kind, activate: input.activate }); const session = sessions.get(input.address.sessionId); assert.ok(session);
        follows.set(message.streamId, { socket: ws, session: session.id }); followCalls++;
        const records = session.events.slice(-input.maxMessages).map(event => ({ type: 'event', event }));
        ws.send(JSON.stringify({ type: 'item', streamId: message.streamId, value: { type: 'snapshot', header: { id: session.id, cwd: session.cwd }, cursor: session.events.length - 1, records, hasMore: session.events.length > records.length, projections: projections(session) } }));
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const launch = `http://127.0.0.1:${address.port}/?token=${token}`;
  return { launch, sessions, calls, peers, follows, followRequests, append, settled, eventStreams,
    ask(agentId: string, event: string, request: unknown) {
      const eventId = randomUUID(); parked.set(eventId, { event, agentId, request });
      for (const [streamId, stream] of eventStreams) forward(streamId, stream.socket, eventId, { event, agentId, request });
      return eventId;
    },
    withdraw(eventId: string) { parked.delete(eventId); for (const [streamId, stream] of eventStreams) stream.socket.send(JSON.stringify({ type: 'item', streamId, value: { type: 'cancel', eventId } })); },
    dropNextResult() { failNextResult = 'drop'; }, followCalls: () => followCalls, setCatalog(value: unknown) { catalog = value; }, signOut() { signedIn = false; }, signIn() { signedIn = true; }, signInAttempt: () => signIn, setPresets(ids: string[], broken: string[] = []) { presetIds = ids; brokenPresets.clear(); for (const id of broken) brokenPresets.add(id); }, lockedSelects: () => lockedSelects, setProfile(value: 'ready' | 'failed' | 'rejected') { profile = value; }, setBalance(value: 'ready' | 'failed' | 'rejected') { balance = value; }, onNextPage(hook: () => void) { nextPage = hook; }, exchanges: () => exchanges, rejectModel: () => { rejectModel = true; }, losePromptReceipt: () => { losePromptReceipt = true; }, live(session: string, frame: unknown) { for (const [streamId, follow] of follows) if (follow.session === session) follow.socket.send(JSON.stringify({ type: 'item', streamId, value: { type: 'assistant-stream', frame } })); }, disconnect() { for (const peer of peers.values()) peer?.terminate(); }, async close() { for (const peer of peers.values()) peer?.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function setup() {
  const fixture = await host(); const directory = await mkdtemp(join(tmpdir(), 'zhongshu-dsh-test-')); const file = join(directory, 'launch'); await writeFile(file, fixture.launch, { mode: 0o600 });
  const adapter = createDshAdapter({ launchFile: file });
  async function create(permissionId = 'workspace-write'): Promise<Binding> { const catalog = await adapter.catalog(); assert.ok(catalog.available); const model = catalog.models[0]; assert.ok(model); return adapter.create({ cwd: directory, configuration: { modelId: model.id, permissionId, reasoningEffort: 'high' } }, () => {}); }
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
    await assert.rejects(context.adapter.create({ cwd: context.directory, configuration: { modelId: catalog.models[0]!.id, permissionId: 'workspace-write', reasoningEffort: 'high' } }, value => { bound = value; assert.equal(context.fixture.calls.at(-1)?.method, 'session/create'); }));
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

test('DSH older pages read without follow (no Agent activation) and number turns from the cursor', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    const operations = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of operations.entries()) {
      await context.adapter.submit(binding, { id, text: `Turn ${index + 1}` });
      context.fixture.append(native, 'tool/call', { name: 'read', input: `step-${index + 1}` });
      context.fixture.append(native, 'turn/end', { turn: index + 1, reason: { kind: 'completed' } }); native.open = null;
    }
    const latest = await context.adapter.history(binding, undefined, 1);
    const follows = context.fixture.followCalls();
    const runs = new Map<string, string | undefined>(); let cursor = latest.olderCursor;
    for (const item of latest.items) if (item.operationId) runs.set(item.operationId, item.runId);
    while (cursor) {
      const page = await context.adapter.history(binding, cursor, 1);
      for (const item of page.items) if (item.operationId) runs.set(item.operationId, item.runId);
      cursor = page.olderCursor;
    }
    assert.equal(context.fixture.followCalls(), follows, 'older pages use session/page only');
    assert.deepEqual(operations.map(id => runs.get(id)), [1, 2, 3].map(turn => `dsh:${binding.id}:turn:${turn}`));
    const legacy = Buffer.from(JSON.stringify({ session: binding.id, through: 3, before: 2 })).toString('base64url');
    await assert.rejects(context.adapter.history(binding, legacy, 1), 'a cursor without its turn boundary is refused');
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

test('DSH announces sub-agent progress from the parent inbox before a busy parent records it', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!; const changes: NativeChange[] = [];
    const unsubscribe = await context.adapter.watch(binding, change => changes.push(change)); await until(() => changes.some(change => change.type === 'state'));
    // Shape captured from DSH 0.2.1-rc.4 while the parent was inside its own tool call.
    context.fixture.append(native, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [
      { role: 'user', id: 'relay', source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child-0001' }, content: [{ type: 'text', text: 'done' }] },
      { role: 'user', id: 'settled', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-0001' }, content: [{ type: 'text', text: 'finished' }] },
      { role: 'user', id: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'queued by the user' }] },
      { role: 'user', id: 'unsafe', source: { kind: 'subagent-settled', senderSessionId: '../escape' }, content: [] }] });
    await until(() => changes.some(change => change.type === 'subagents'));
    assert.deepEqual(changes.filter(change => change.type === 'subagents'), [{ type: 'subagents', agentId: 'child-0001' }]);
    context.fixture.append(native, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 2, inserted: [] });
    context.fixture.append(native, 'user/message', { source: { kind: 'user', rpcId: 'marker' }, content: [{ type: 'text', text: 'after splice' }] });
    await until(() => changes.some(change => change.type === 'item' && change.item.text === 'after splice'));
    assert.equal(changes.filter(change => change.type === 'subagents').length, 1, 'removals and user input are not sub-agent progress');
    unsubscribe();
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
    assert.equal(permission.label, '工作区读写'); assert.match(permission.description, /需要越界时会请求你批准/);
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

test('DSH keeps proving a long running turn when native events arrive while it pages back to the turn start', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    await context.adapter.submit(binding, { id: randomUUID(), text: 'Synthetic long turn' });
    // The turn start falls out of the latest five-record window, so state pages back to it.
    for (let index = 0; index < 12; index++) context.fixture.append(native, 'synthetic/step', { index });
    // A step boundary lands while the page is in flight: a few events, then more than one window.
    context.fixture.onNextPage(() => { for (let index = 0; index < 3; index++) context.fixture.append(native, 'synthetic/step', { index: 100 + index }); });
    const first = await context.adapter.state(binding);
    assert.equal(first.status, 'running', first.reason); assert.equal(first.runId, `dsh:${binding.id}:turn:1`);
    context.fixture.onNextPage(() => { for (let index = 0; index < 20; index++) context.fixture.append(native, 'synthetic/step', { index: 200 + index }); });
    const second = await context.adapter.state(binding);
    assert.equal(second.status, 'running', second.reason); assert.equal(second.runId, `dsh:${binding.id}:turn:1`);
    context.fixture.append(native, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); native.open = null;
    assert.equal((await context.adapter.state(binding)).status, 'idle');
  } finally { await context.close(); }
});

test('A watch opened in the middle of a long DSH turn reports it running, never a false unknown', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    await context.adapter.submit(binding, { id: randomUUID(), text: 'Synthetic long turn' });
    // More events than the watch's thirty-record window: its snapshot cannot see the turn start.
    for (let index = 0; index < 40; index++) context.fixture.append(native, 'synthetic/step', { index });
    const changes: NativeChange[] = [];
    const unsubscribe = await context.adapter.watch(binding, change => changes.push(change));
    await until(() => changes.some(change => change.type === 'state'));
    const states = changes.flatMap(change => change.type === 'state' ? [change.state] : []);
    assert.deepEqual(states.map(state => state.status), ['running']); assert.equal(states[0]!.runId, `dsh:${binding.id}:turn:1`);
    unsubscribe();
  } finally { await context.close(); }
});

test('After a stop, child messages left in next-step do not lock the conversation; unknown next-step input still does', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!;
    await context.adapter.submit(binding, { id: randomUUID(), text: 'Synthetic parent turn' });
    const child = randomUUID();
    // Native rc.4: a child's relay and settle notice land in next-step while the parent's own tool runs.
    native.stepInbox.push(
      { id: randomUUID(), role: 'user', source: { kind: 'agent-message', form: 'relay', senderSessionId: child }, content: [{ type: 'text', text: 'Agent sent a message' }, { type: 'text', text: 'synthetic result' }] },
      { id: randomUUID(), role: 'user', source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent finished', senderSessionId: child }, content: [{ type: 'text', text: 'Background subagent finished' }] });
    // A user stop ends the turn; nothing wakes the parent, so the notices wait for the next prompt.
    context.fixture.append(native, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }); native.open = null;
    const stopped = await context.adapter.state(binding);
    assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.pendingInputs, 0);
    assert.equal((await context.adapter.submit(binding, { id: randomUUID(), text: 'Next prompt after the stop' })).outcome, 'accepted');
    context.fixture.append(native, 'turn/end', { turn: 2, reason: { kind: 'completed' } }); native.open = null;
    native.stepInbox.push({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: randomUUID() }, content: [{ type: 'text', text: 'Unknown queued work' }] });
    assert.equal((await context.adapter.state(binding)).pendingInputs, 1);
    assert.equal((await context.adapter.submit(binding, { id: randomUUID(), text: 'Must not run behind unknown input' })).outcome, 'rejected');
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

test('DSH separates reasoning choices, rejects invalid selections before creation, and restores legacy IDs', async () => {
  const context = await setup();
  try {
    const catalog = await context.adapter.catalog();
    const model = catalog.models[0]!;
    assert.equal(catalog.models.length, 1);
    assert.deepEqual(model.reasoningEfforts, [{ id: 'high', label: 'High' }]);
    assert.equal(model.defaultReasoningEffort, undefined);
    assert.equal(catalog.defaultModelId, undefined);
    const configuration = { modelId: model.id, permissionId: 'workspace-write' };
    await assert.rejects(context.adapter.create({ cwd: context.directory, configuration }, () => {}), /DSH_REASONING_EFFORT_UNAVAILABLE/);
    await assert.rejects(context.adapter.create({ cwd: context.directory, configuration: { ...configuration, reasoningEffort: 'low' } }, () => {}), /DSH_REASONING_EFFORT_UNAVAILABLE/);
    assert.equal(context.fixture.sessions.size, 0);
    const legacyId = Buffer.from(JSON.stringify({ provider: 'deepseek-account', model: 'test-model', reasoningEffort: 'high' })).toString('base64url');
    const legacy = await context.adapter.create({ cwd: context.directory, configuration: { ...configuration, modelId: legacyId } }, () => {});
    assert.equal((await context.adapter.state(legacy)).configurationVerified, true);
    await assert.rejects(context.adapter.create({ cwd: context.directory, configuration: { ...configuration, modelId: legacyId, reasoningEffort: 'low' } }, () => {}), /DSH_MODEL_CONFLICT/);
  } finally { await context.close(); }
});


test('DSH reads native default selection and model effort defaults without guessing unavailable values', async () => {
  const context = await setup();
  try {
    const efforts = [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }];
    const groups = [{ id: 'deepseek-account', name: 'DeepSeek', models: [
      { id: 'test-model', name: 'Test', reasoning: { efforts, defaultEffort: 'low' } },
      { id: 'other-model', name: 'Other', reasoning: { efforts, defaultEffort: 'low' } },
    ] }];
    context.fixture.setCatalog({ default: { provider: 'deepseek-account', model: 'test-model', reasoningEffort: 'high' }, groups });
    const catalog = await context.adapter.catalog();
    assert.equal(catalog.defaultModelId, catalog.models[0]!.id);
    assert.equal(catalog.models[0]!.defaultReasoningEffort, 'high');
    assert.equal(catalog.models[1]!.defaultReasoningEffort, 'low');
    const binding = await context.adapter.create({ cwd: context.directory, configuration: { modelId: catalog.defaultModelId!, reasoningEffort: catalog.models[0]!.defaultReasoningEffort!, permissionId: 'workspace-write' } }, () => {});
    assert.equal(context.fixture.sessions.get(binding.id)!.model.reasoningEffort, 'high');

    context.fixture.setCatalog({ default: { provider: 'deepseek-account', model: 'test-model' }, groups });
    assert.equal((await context.adapter.catalog()).models[0]!.defaultReasoningEffort, 'low');
    context.fixture.setCatalog({ default: { provider: 'deepseek-account', model: 'test-model', reasoningEffort: 'removed' }, groups });
    assert.equal((await context.adapter.catalog()).models[0]!.defaultReasoningEffort, undefined);
    context.fixture.setCatalog({ default: { provider: 'deepseek-account', model: 'removed' }, groups });
    assert.equal((await context.adapter.catalog()).defaultModelId, undefined);
    context.fixture.setCatalog({ groups: [{ id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'test-model', name: 'Test', reasoning: { efforts, defaultEffort: 'removed' } }] }] });
    const unavailable = await context.adapter.catalog();
    assert.equal(unavailable.defaultModelId, undefined);
    assert.equal(unavailable.models[0]!.defaultReasoningEffort, undefined);

    context.fixture.setCatalog({ default: { provider: 'deepseek-account', model: 'test-model', reasoningEffort: 'high' }, groups });
    context.fixture.signOut();
    const signedOut = await context.adapter.catalog();
    assert.equal(signedOut.defaultModelId, undefined);
    assert.equal(signedOut.models.length, 0);
    assert.equal(signedOut.available, false);
    assert.equal(context.fixture.sessions.get(binding.id)!.model.reasoningEffort, 'high');
  } finally { await context.close(); }
});

test('DSH catalog projection splits legacy effort while preserving immutable input', async () => {
  const adapter = createDshAdapter({ launchFile: '/unused-projection-test.json' });
  try {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const legacy = { modelId: encode({ provider: 'test', model: 'chat', reasoningEffort: 'high' }), permissionId: 'read-only' };
    const original = { ...legacy };
    const normalized = adapter.normalizeConfiguration!(legacy);
    assert.deepEqual(normalized, { modelId: encode({ provider: 'test', model: 'chat' }), permissionId: 'read-only', reasoningEffort: 'high' });
    assert.deepEqual(legacy, original);
    assert.deepEqual(adapter.normalizeConfiguration!(normalized), normalized);
    assert.throws(() => adapter.normalizeConfiguration!({ ...legacy, reasoningEffort: 'low' }), { code: 'DSH_MODEL_CONFLICT' });
  } finally { await adapter.close(); }
});

test('DSH prepares one named blank, adopts it with final configuration, and rejects used sessions', async () => {
  const context=await setup();
  try {
    const id=randomUUID(); const input={id,cwd:context.directory};
    const skills=await context.adapter.prepareDraft!(input);
    assert.equal(skills.length,1);
    assert.deepEqual(await context.adapter.prepareDraft!(input),skills);
    assert.equal(context.fixture.calls.filter(call=>call.method==='session/create').length,1);
    assert.equal(context.fixture.calls.some(call=>call.method==='session/selectModel'),false);
    const catalog=await context.adapter.catalog();
    const binding=await context.adapter.create({cwd:input.cwd,configuration:{modelId:catalog.models[0]!.id,permissionId:'danger-full-access',reasoningEffort:'high'},preparedId:id},()=>{});
    assert.equal(binding.id,id);assert.equal((await context.adapter.state(binding)).configurationVerified,true);
    assert.equal(context.fixture.calls.filter(call=>call.method==='session/create').length,1);
    await context.adapter.submit(binding,{id:randomUUID(),text:'synthetic'});
    const before=context.fixture.calls.filter(call=>call.method==='session/selectModel').length;
    await assert.rejects(context.adapter.prepareDraft!(input),/DSH_PREPARED_SESSION_NOT_EMPTY/);
    await assert.rejects(context.adapter.create({cwd:input.cwd,configuration:binding.configuration,preparedId:id},()=>{}),/DSH_PREPARED_SESSION_NOT_EMPTY/);
    assert.equal(context.fixture.calls.filter(call=>call.method==='session/selectModel').length,before);
    assert.equal(context.fixture.sessions.size,1);
  } finally {await context.close();}
});

// ADR 0016: DSH forwards questions and approvals to answering clients; the Host keeps them until settled.
test('DSH presents forwarded questions and approvals of the watched conversation and answers each once', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const native = context.fixture.sessions.get(binding.id)!; const changes: NativeChange[] = [];
    await context.adapter.watch(binding, change => changes.push(change));
    await until(() => context.fixture.eventStreams.size === 1);
    context.fixture.append(native, 'tool/call', { callId: 'call-1', name: 'bash', input: { command: 'curl -sS https://example.com' } });
    const approval = context.fixture.ask(binding.id, 'approval/request', { toolName: 'bash', callId: 'call-1', reason: 'escalate sandbox to danger-full-access: network', displayReason: { zh: '需要联网' } });
    const question = context.fixture.ask(binding.id, 'user-questions/request', { questions: [{ id: 'format', question: 'Which format?', header: 'Format', options: [{ label: 'Markdown' }, { label: 'HTML', description: 'Charts' }] }] });
    context.fixture.ask('another-session', 'approval/request', { toolName: 'bash' });
    let requests: Awaited<ReturnType<NonNullable<typeof context.adapter.requests>>> = [];
    for (let tries = 0; tries < 100 && !(requests.length === 2 && requests.some(request => request.approval?.command)); tries++) { await delay(20); requests = await context.adapter.requests!(binding); }
    assert.equal(requests.length, 2, 'only requests of this conversation');
    const shownApproval = requests.find(request => request.kind === 'approval')!; const shownQuestion = requests.find(request => request.kind === 'question')!;
    assert.deepEqual(shownApproval.approval, { action: 'command', decisions: ['accept', 'decline'], reason: '需要联网', command: 'curl -sS https://example.com' });
    assert.deepEqual(shownQuestion.questions, [{ id: 'format', text: 'Which format?', header: 'Format', multiple: false, custom: true, options: [{ label: 'Markdown' }, { label: 'HTML', description: 'Charts' }] }]);
    assert.ok(changes.some(change => change.type === 'requests'));
    // Answers that do not fit are refused locally; nothing reaches the Host.
    assert.deepEqual(await context.adapter.answer!(binding, shownApproval.id, { kind: 'approval', decision: 'acceptForSession' }), { outcome: 'rejected', reason: 'answer_invalid' });
    assert.deepEqual(await context.adapter.answer!(binding, shownQuestion.id, { kind: 'question', answers: [{ id: 'format', selected: ['PDF'] }] }), { outcome: 'rejected', reason: 'answer_invalid' });
    assert.equal(context.fixture.settled.length, 0);
    assert.deepEqual(await context.adapter.answer!(binding, shownApproval.id, { kind: 'approval', decision: 'accept' }), { outcome: 'accepted' });
    assert.deepEqual(await context.adapter.answer!(binding, shownQuestion.id, { kind: 'question', answers: [{ id: 'format', selected: ['Markdown'], custom: 'With a summary table' }] }), { outcome: 'accepted' });
    assert.deepEqual(context.fixture.settled.map(row => [row.eventId, row.outcome]), [
      [approval, { kind: 'result', value: 'allowed-once' }],
      [question, { kind: 'result', value: { answers: [{ id: 'format', selected: [], custom: 'With a summary table' }] } }],
    ], 'a typed single-choice answer replaces the selection, as the native UI sends it');
    assert.deepEqual(await context.adapter.requests!(binding), []);
    assert.deepEqual(await context.adapter.answer!(binding, shownApproval.id, { kind: 'approval', decision: 'accept' }), { outcome: 'rejected', reason: 'request_not_open' });
  } finally { await context.close(); }
});

test('DSH replays open requests after reconnect, drops withdrawn ones, and leaves a lost answer unknown', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const changes: NativeChange[] = [];
    await context.adapter.watch(binding, change => changes.push(change));
    await until(() => context.fixture.eventStreams.size === 1);
    const first = context.fixture.ask(binding.id, 'approval/request', { toolName: 'write_file', callId: 'missing' });
    let requests: Awaited<ReturnType<NonNullable<typeof context.adapter.requests>>> = [];
    for (let tries = 0; tries < 100 && !requests.length; tries++) { await delay(20); requests = await context.adapter.requests!(binding); }
    const id = requests[0]!.id;
    assert.equal(requests[0]!.approval?.action, 'fileChange');
    context.fixture.disconnect();
    for (let tries = 0; tries < 100 && (await context.adapter.requests!(binding)).length; tries++) await delay(20);
    assert.deepEqual(await context.adapter.requests!(binding), [], 'forwarded requests belong to the lost stream');
    // Any call reconnects; the Host replays the parked request with the same identity.
    await context.adapter.state(binding);
    for (let tries = 0; tries < 100 && !(await context.adapter.requests!(binding)).length; tries++) await delay(20);
    assert.equal((await context.adapter.requests!(binding))[0]?.id, id);
    context.fixture.dropNextResult();
    assert.deepEqual(await context.adapter.answer!(binding, id, { kind: 'approval', decision: 'decline' }), { outcome: 'unknown', reason: 'dsh_answer_unconfirmed' });
    assert.equal(context.fixture.settled.length, 0);
    assert.equal((await context.adapter.requests!(binding))[0]?.id, id, 'an unconfirmed answer keeps the request open for reconciliation');
    context.fixture.withdraw(first);
    for (let tries = 0; tries < 100 && (await context.adapter.requests!(binding)).length; tries++) await delay(20);
    assert.deepEqual(await context.adapter.requests!(binding), []);
  } finally { await context.close(); }
});

test('DSH refuses forwarded requests it cannot present instead of leaving the turn blocked', async () => {
  const context = await setup();
  try {
    const binding = await context.create(); const changes: NativeChange[] = [];
    await context.adapter.watch(binding, change => changes.push(change));
    await until(() => context.fixture.eventStreams.size === 1);
    const broken = context.fixture.ask(binding.id, 'user-questions/request', { questions: [] });
    for (let tries = 0; tries < 100 && !context.fixture.settled.length; tries++) await delay(20);
    assert.deepEqual(context.fixture.settled[0], { clientId: 'client-1', eventId: broken,
      outcome: { kind: 'rejected', error: { name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED' } } });
    assert.ok(changes.some(change => change.type === 'item' && change.item.kind === 'notice'));
    assert.deepEqual(await context.adapter.requests!(binding), []);
  } finally { await context.close(); }
});

// Plan mode (ADR 0016): native session state set by /plan and /plan off; the plan review is a forwarded question.
test('DSH turns native Plan mode on and off and reports it in state', async () => {
  const context = await setup();
  try {
    const binding = await context.create();
    assert.equal(context.adapter.planMode, 'native');
    assert.equal((await context.adapter.state(binding)).plan, undefined, 'a composition without plan state reports none');
    assert.deepEqual(await context.adapter.setPlan!(binding, true), { outcome: 'accepted' });
    assert.deepEqual((await context.adapter.state(binding)).plan, { active: true, pending: false });
    assert.deepEqual(await context.adapter.setPlan!(binding, false), { outcome: 'accepted' });
    assert.deepEqual((await context.adapter.state(binding)).plan, { active: false, pending: false });
    assert.deepEqual(context.fixture.calls.filter(call => call.method === 'commands/execute' && String(call.args.line).startsWith('/plan')).map(call => call.args.line), ['/plan', '/plan off']);
    // After a turn, the switch leaves a passive notice that must not block the next message.
    const native = context.fixture.sessions.get(binding.id)!;
    await context.adapter.submit(binding, { id: randomUUID(), text: 'Synthetic first turn' });
    native.open = null; context.fixture.append(native, 'turn/end', { turn: native.turn, reason: { kind: 'completed' } });
    assert.deepEqual(await context.adapter.setPlan!(binding, true), { outcome: 'accepted' });
    assert.equal(native.stepInbox.some(entry => (entry as { source?: { kind?: string } }).source?.kind === 'plan-mode'), true);
    const afterSwitch = await context.adapter.state(binding);
    assert.deepEqual([afterSwitch.status, afterSwitch.pendingInputs, afterSwitch.plan?.active], ['idle', 0, true]);
    assert.equal((await context.adapter.submit(binding, { id: randomUUID(), text: 'Plan the next step' })).outcome, 'accepted');
  } finally { await context.close(); }
});

test('DSH presents a plan review with its plan and answers with the native option labels', async () => {
  const context = await setup();
  try {
    const binding = await context.create();
    await context.adapter.watch(binding, () => {});
    await until(() => context.fixture.eventStreams.size === 1);
    const ask = () => context.fixture.ask(binding.id, 'user-questions/request', { questions: [{ id: 'plan-review', question: 'Approve this plan and leave plan mode?',
      detail: '## Plan\n1. Read\n2. Write', options: [{ label: 'Approve' }, { label: 'Keep planning' }], intent: { kind: 'plan-review', approve: 'Approve', callId: 'exit-1' } }] });
    const first = ask();
    let requests: Awaited<ReturnType<NonNullable<typeof context.adapter.requests>>> = [];
    for (let tries = 0; tries < 100 && !requests.length; tries++) { await delay(20); requests = await context.adapter.requests!(binding); }
    const [review] = requests;
    assert.deepEqual(review?.questions?.[0], { id: 'plan-review', text: 'Approve this plan and leave plan mode?', multiple: false, custom: true,
      options: [{ label: 'Approve' }, { label: 'Keep planning' }], review: { approve: 'Approve', keep: 'Keep planning', plan: '## Plan\n1. Read\n2. Write' } }, 'the plan is not folded into the question');
    assert.deepEqual(await context.adapter.answer!(binding, review!.id, { kind: 'question', answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: 'Add tests' }] }), { outcome: 'accepted' });
    const second = ask();
    requests = [];
    for (let tries = 0; tries < 100 && !requests.length; tries++) { await delay(20); requests = await context.adapter.requests!(binding); }
    assert.deepEqual(await context.adapter.answer!(binding, requests[0]!.id, { kind: 'question', answers: [{ id: 'plan-review', selected: ['Approve'] }] }), { outcome: 'accepted' });
    assert.deepEqual(context.fixture.settled.map(row => [row.eventId, row.outcome]), [
      [first, { kind: 'result', value: { answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: 'Add tests' }] } }],
      [second, { kind: 'result', value: { answers: [{ id: 'plan-review', selected: ['Approve'] }] } }],
    ], 'approval is exactly the approve label without feedback');
  } finally { await context.close(); }
});

test('DSH account: a platform check makes it valid, a failed check unverified, a cleared grant rejected', async t => {
  const context = await setup(); t.after(() => context.close());
  const links = { usage: 'https://platform.example/usage', topUp: 'https://platform.example/top_up' };
  assert.deepEqual(await context.adapter.account!(), { state: 'valid', identity: 'DeepSeek 账号 138****9119', links });
  const profileCall = context.fixture.calls.find(call => call.method === 'account/getProfile');
  assert.deepEqual(Object.keys(profileCall!.args.client).sort(), ['locale', 'timezoneOffsetSeconds', 'version']);
  context.fixture.setProfile('failed');
  assert.deepEqual(await context.adapter.account!(), { state: 'valid', links }, 'a blocked profile read falls back to the balance read, which proves the grant without naming it');
  const balanceCall = context.fixture.calls.find(call => call.method === 'account/getBalance');
  assert.deepEqual(Object.keys(balanceCall!.args.client).sort(), ['locale', 'timezoneOffsetSeconds', 'version']);
  context.fixture.setBalance('failed');
  assert.deepEqual(await context.adapter.account!(), { state: 'unverified', links }, 'both platform reads failing is unverified');
  context.fixture.setBalance('rejected');
  assert.deepEqual(await context.adapter.account!(), { state: 'rejected', links }, 'the balance read clearing the grant is a rejection');
  context.fixture.signIn(); context.fixture.setBalance('ready');
  assert.equal((await context.adapter.account!()).state, 'valid');
  context.fixture.setProfile('rejected');
  assert.deepEqual(await context.adapter.account!(), { state: 'rejected', links });
  assert.deepEqual(await context.adapter.account!(), { state: 'signed-out', links }, 'after the rejection is reported it is plainly signed out');
  context.fixture.signIn(); context.fixture.setProfile('ready');
  assert.equal((await context.adapter.account!()).state, 'valid');
});

test('DSH paste-back login: the Host loopback callback receives only code and state from the pasted address', async t => {
  const context = await setup(); t.after(() => context.close());
  context.fixture.signOut();
  const started = await context.adapter.startLogin!();
  assert.ok(started.kind === 'paste-back');
  const launchOrigin = new URL(context.fixture.launch).origin;
  assert.equal(context.fixture.signInAttempt()!.callbackOrigin, launchOrigin, 'the callback origin is the Host loopback address');
  assert.equal(started.callbackPrefix, `${launchOrigin}/oauth/callback`);
  assert.match(started.authorizeUrl, /^https:\/\/platform\.example\/sign_in/);
  const state = context.fixture.signInAttempt()!.state;
  assert.equal(await context.adapter.completeLogin!(started.loginId, 'not a url'), 'invalid');
  assert.equal(await context.adapter.completeLogin!(started.loginId, `http://127.0.0.1:1/elsewhere?code=good&state=${state}`), 'invalid');
  assert.equal(await context.adapter.completeLogin!(started.loginId, `http://127.0.0.1:1/oauth/callback?code=good&state=wrong`), 'invalid', 'the Host rejects a foreign state');
  // The pasted host and port are whatever the browser showed; only code and state travel to the Host's own callback.
  assert.equal(await context.adapter.completeLogin!(started.loginId, `http://127.0.0.1:9/oauth/callback?code=good&state=${state}`), 'succeeded');
  assert.equal((await context.adapter.account!()).state, 'valid');
  const again = await context.adapter.startLogin!();
  assert.equal(await context.adapter.cancelLogin!(again.loginId), 'canceled');
  assert.equal(await context.adapter.completeLogin!(again.loginId, `http://127.0.0.1:9/oauth/callback?code=good&state=${context.fixture.signInAttempt()!.state}`), 'failed', 'a cancelled attempt cannot complete');
});

test('DSH Agent presets: standard and PTC are offered, chosen at creation, verified natively and locked after the first turn', async t => {
  const context = await setup(); t.after(() => context.close());
  const catalog = await context.adapter.catalog();
  assert.deepEqual(catalog.presets?.map(item => [item.id, item.label, item.available]), [['standard', '标准', true], ['ptc', 'PTC', true]]);
  assert.equal(catalog.defaultPresetId, 'standard');
  const model = catalog.models[0]!;
  const configuration = { modelId: model.id, permissionId: 'workspace-write', reasoningEffort: 'high', agentPreset: 'ptc' };
  const binding = await context.adapter.create({ cwd: '/workspace/project', configuration }, () => {});
  assert.equal(context.fixture.sessions.get(binding.id)!.agentPreset, 'ptc');
  assert.equal(context.fixture.calls.find(call => call.method === 'session/create')!.args.request.agentPreset, 'ptc');
  assert.equal((await context.adapter.state(binding)).configurationVerified, true);
  // Natively changed behind Zhongshu's back: the conversation stops dispatching instead of running with another preset.
  context.fixture.sessions.get(binding.id)!.agentPreset = 'standard';
  assert.equal((await context.adapter.state(binding)).configurationVerified, false);
  // A conversation created before presets keeps working whatever the Host records.
  const legacy = await context.adapter.create({ cwd: '/workspace/project', configuration: { modelId: model.id, permissionId: 'workspace-write', reasoningEffort: 'high' } }, () => {});
  assert.equal(context.fixture.calls.filter(call => call.method === 'session/create').at(-1)!.args.request.agentPreset, undefined);
  assert.equal((await context.adapter.state(legacy)).configurationVerified, true);
  // Parent follows wake the Agent (DSH 0.2.2); 0.2.1 ignores the field.
  const parents = context.fixture.followRequests.filter(item => item.kind === 'session');
  assert.ok(parents.length > 0 && parents.every(item => item.activate === true));
  // A missing or broken preset is listed as unavailable and refused, never swapped.
  context.fixture.setPresets(['standard', 'ptc'], ['ptc']);
  assert.deepEqual((await context.adapter.catalog()).presets?.map(item => [item.id, item.available]), [['standard', true], ['ptc', false]]);
  await assert.rejects(context.adapter.create({ cwd: '/workspace/project', configuration }, () => {}));
  context.fixture.setPresets(['standard']);
  assert.deepEqual((await context.adapter.catalog()).presets?.map(item => [item.id, item.available]), [['standard', true], ['ptc', false]]);
});

test('DSH prepared draft: the preset is selected on the blank session before the first turn', async t => {
  const context = await setup(); t.after(() => context.close());
  const preparationId = randomUUID();
  await context.adapter.prepareDraft!({ id: preparationId, cwd: '/workspace/project' });
  assert.equal(context.fixture.sessions.get(preparationId)!.agentPreset, undefined);
  const model = (await context.adapter.catalog()).models[0]!;
  const binding = await context.adapter.create({ cwd: '/workspace/project', preparedId: preparationId, configuration: { modelId: model.id, permissionId: 'workspace-write', reasoningEffort: 'high', agentPreset: 'ptc' } }, () => {});
  assert.equal(binding.id, preparationId);
  assert.equal(context.fixture.sessions.get(preparationId)!.agentPreset, 'ptc');
  assert.deepEqual(context.fixture.calls.find(call => call.method === 'agentPresets/select')!.args, { agentId: preparationId, agentPreset: 'ptc' });
  assert.equal((await context.adapter.state(binding)).configurationVerified, true);
});

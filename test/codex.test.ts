import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { createCodexAdapter } from '../src/harness/codex/index.ts';
import type { Binding, NativeChange } from '../src/harness/types.ts';

// Protocol peer, not a model substitute or a claim of real Harness acceptance.
const NO_RESPONSE = Symbol('no-response');
type Request = { id: number; method: string; params: Record<string, unknown> };
const saved: Binding = { id: 'thread-1', cwd: '/workspace/synthetic', configuration: { modelId: 'model-a', permissionId: 'workspace' }, details: { version: 1, approvalPolicy: 'never' } };
/** The approval policy the synthetic App Server last started a thread with; a resume reports the same. */
let startedPolicy = 'never';
const nativeConfiguration = () => ({ thread: { id: saved.id, status: { type: 'idle' } }, cwd: saved.cwd, model: 'model-a', activePermissionProfile: { id: 'workspace' }, approvalPolicy: startedPolicy });
/** A conversation created with a non-full-access permission asks for approval when needed (ADR 0016). */
const created: Binding = { ...saved, details: { version: 1, approvalPolicy: 'on-request' } };
function userItem(id: string, clientId = id) { return { turnId: 'run-1', item: { id, type: 'userMessage', clientId, content: [{ type: 'text', text: id }] }, completedAtMs: 1 }; }

async function peer(t: TestContext, override?: (request: Request, socket: WebSocket) => unknown, workspaceToolsProfile?: string) {
  startedPolicy = 'never';
  const dir = await mkdtemp(join(tmpdir(), 'zh codex test '));
  const socketPath = join(dir, 'rpc.sock');
  const http = createServer(); const sockets = new Set<WebSocket>(); const calls: Request[] = []; const clientResponses: unknown[] = [];
  const ws = new WebSocketServer({ server: http });
  ws.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('message', bytes => {
      const data = JSON.parse(bytes.toString()) as Request;
      if (!data.method) { clientResponses.push(data); return; }
      if (data.id === undefined) return;
      calls.push(data);
      if (data.method === 'thread/start') startedPolicy = String((data.params as { approvalPolicy?: string }).approvalPolicy);
      const custom = override?.(data, socket);
      if (custom === NO_RESPONSE) return;
      let result = custom;
      if (result === undefined) {
        switch (data.method) {
          case 'initialize': result = {}; break;
          case 'account/read': result = { account: { type: 'chatgpt' } }; break;
          case 'model/list': result = { data: [{ model: 'model-a', displayName: 'Model A', hidden: false }], nextCursor: null }; break;
          case 'permissionProfile/list': result = { data: [{ id: 'workspace', allowed: true, description: 'Synthetic workspace permission' }], nextCursor: null }; break;
          case 'thread/start': case 'thread/resume': result = nativeConfiguration(); break;
          case 'thread/read': result = { thread: { id: saved.id, status: { type: 'idle' } } }; break;
          case 'thread/turns/list': case 'thread/queue/list': result = { data: [], nextCursor: null }; break;
          case 'thread/items/list': result = { data: [], nextCursor: null }; break;
          case 'thread/unsubscribe': result = { status: 'unsubscribed' }; break;
          case 'thread/name/set': result = {}; break;
          case 'turn/start': result = { turn: { id: 'run-1', status: 'inProgress' } }; break;
          case 'turn/interrupt': result = {}; break;
          default: socket.send(JSON.stringify({ id: data.id, error: { code: -32601, message: 'Synthetic unsupported method' } })); return;
        }
      }
      socket.send(JSON.stringify({ id: data.id, result }));
    });
  });
  await new Promise<void>(resolve => http.listen(socketPath, resolve));
  const adapter = createCodexAdapter({ socketPath, workspaceToolsProfile });
  t.after(async () => {
    await adapter.close();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { adapter, calls, sockets, clientResponses, notify(method: string, params: unknown) { for (const socket of sockets) socket.send(JSON.stringify({ method, params })); } };
}
async function until(predicate: () => boolean) { for (let tries = 0; tries < 100; tries++) { if (predicate()) return; await delay(20); } assert.fail('Expected protocol observation did not arrive'); }

test('Codex web history and live notifications preserve completion evidence and unknown states', async t => {
  const p = await peer(t, request => {
    if (request.method === 'thread/items/list') return { data: [
      { turnId: 'run-1', item: { id: 'missing', type: 'webSearch', query: 'unknown' } },
      { turnId: 'run-1', completedAtMs: 42, item: { id: 'done', type: 'webSearch', action: { type: 'openPage', url: 'https://example.com/' } } },
      { turnId: 'run-1', completedAtMs: null, item: { id: 'active', type: 'webSearch', query: 'active' } },
    ], nextCursor: null };
  });
  const history = await p.adapter.history(saved);
  assert.deepEqual(history.items.map(item => [item.id, item.status]), [['active', 'running'], ['done', 'completed'], ['missing', 'unknown']]);
  const changes: NativeChange[] = [];
  await p.adapter.watch(saved, change => changes.push(change));
  const params = { threadId: saved.id, turnId: 'run-1', item: { id: 'live-web', type: 'webSearch', action: { type: 'findInPage', url: 'https://example.com/', pattern: 'needle' } } };
  p.notify('item/started', params);
  p.notify('item/completed', params);
  await until(() => changes.filter(change => change.type === 'item').length === 2);
  const items = changes.flatMap(change => change.type === 'item' ? [change.item] : []);
  assert.deepEqual(items.map(item => [item.id, item.status]), [['live-web', 'running'], ['live-web', 'completed']]);
  assert.equal(items[1]?.tool?.input, 'https://example.com/\nneedle');
});

test('Codex resolves explicit skill occurrences from the current cwd and observes usage on the bound thread', async t => {
  let enabled = true;
  const path = saved.cwd + '/.agents/skills/zhi-proof/SKILL.md';
  const p = await peer(t, request => {
    if (request.method === 'skills/list') return { data: [{ cwd: saved.cwd, skills: [
      { name: 'zhi-proof', path, enabled, description: 'Synthetic skill', interface: { displayName: 'Proof' } },
      { name: 'invalid', path: '/foreign/file.txt', enabled: true, description: 'Invalid path' },
    ] }] };
    return undefined;
  });
  const [skill] = await p.adapter.skills!(saved);
  assert.ok(skill);
  assert.equal(skill.label, 'Proof');
  assert.equal('path' in skill, false);
  const operation = { id: 'explicit', text: '⬡ Proof now', skills: [{ id: skill.id, label: skill.label, start: 0, end: 7 }] };
  assert.deepEqual(await p.adapter.submitQueued!(saved, operation, { mode: 'current', target: 'run-1' }),
    { outcome: 'rejected', reason: 'queue_skill_requires_next_turn' });
  assert.equal(p.calls.some(call => call.method === 'turn/steer'), false);
  assert.equal((await p.adapter.submit(saved, operation)).outcome, 'accepted');
  const inputs = () => p.calls.filter(call => call.method === 'turn/start').map(call => call.params.input);
  assert.deepEqual(inputs()[0], [{ type: 'text', text: ' $zhi-proof  now', text_elements: [] }, { type: 'skill', name: 'zhi-proof', path }]);
  assert.equal((await p.adapter.submit(saved, { id: 'manual', text: '/zhi-proof now' })).outcome, 'accepted');
  assert.deepEqual(inputs()[1], [{ type: 'text', text: '/zhi-proof now', text_elements: [] }]);
  enabled = false;
  assert.deepEqual(await p.adapter.submit(saved, { ...operation, id: 'stale' }), { outcome: 'rejected', reason: 'skill_reference_unavailable' });
  assert.equal(inputs().length, 2);
  const changes: NativeChange[] = [];
  await p.adapter.watch(saved, change => changes.push(change));
  const tokenUsage = { total: { totalTokens: 1024 }, last: { totalTokens: 128 }, modelContextWindow: 4096 };
  p.notify('thread/tokenUsage/updated', { threadId: 'another-thread', tokenUsage });
  p.notify('thread/tokenUsage/updated', { threadId: saved.id, tokenUsage });
  await until(() => changes.some(change => change.type === 'usage'));
  assert.deepEqual(changes.filter(change => change.type === 'usage'), [{ type: 'usage', usage: { total: 1024, context: { used: 128, capacity: 4096, estimated: true } } }]);
});

test('Codex uses a guarded native steer and reconciles a pending next-turn item by client identity', async t => {
  const p = await peer(t, (request, socket) => {
    if (request.method === 'thread/read') return { thread: { id: saved.id, status: { type: 'active' } } };
    if (request.method === 'thread/turns/list') return { data: [{ id: 'run-1', status: 'inProgress' }], nextCursor: null };
    if (request.method === 'turn/steer') {
      assert.equal(request.params.expectedTurnId, 'run-1');
      socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'no active turn to steer' } }));
      return NO_RESPONSE;
    }
    if (request.method === 'thread/queue/add') return { queuedSubmission: { id: 'queued-1', clientUserMessageId: 'queued-op' } };
    if (request.method === 'thread/queue/list') return { data: [{ id: 'queued-1', clientUserMessageId: 'queued-op' }], nextCursor: null };
    return undefined;
  });
  assert.deepEqual(await p.adapter.submitQueued!(saved, { id: 'steered-op', text: 'guarded' }, { mode: 'current', target: 'run-1' }),
    { outcome: 'rejected', reason: 'native_run_changed' });
  assert.deepEqual(await p.adapter.submitQueued!(saved, { id: 'queued-op', text: 'next round' }, { mode: 'next' }), { outcome: 'accepted' });
  assert.deepEqual(await p.adapter.reconcile(saved, 'queued-op'), { outcome: 'accepted' });
  assert.equal(p.calls.some(call => call.method === 'turn/start'), false);
});

test('Codex persists the native identity before configuration verification can fail', async t => {
  const p = await peer(t, request => request.method === 'thread/start' ? { ...nativeConfiguration(), model: 'unexpected-model' } : undefined);
  let bound: Binding | undefined;
  await assert.rejects(p.adapter.create({ cwd: saved.cwd, configuration: saved.configuration }, value => { bound = value; }), { message: 'codex_configuration_mismatch' });
  assert.deepEqual(bound, created);
  assert.equal(p.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(p.calls.some(call => call.method === 'turn/start'), false);
});

test('Codex binds before naming, then names a new conversation before releasing its native observation', async t => {
  let bound = false;
  const p = await peer(t, request => {
    if (request.method === 'thread/name/set') assert.equal(bound, true);
    return undefined;
  });
  const binding = await p.adapter.create({ cwd: saved.cwd, configuration: saved.configuration, title: 'Synthetic empty conversation' }, () => { bound = true; });
  assert.deepEqual(binding, { ...created, details: { ...created.details, title: 'Synthetic empty conversation' } });
  const methods = p.calls.map(call => call.method);
  assert.equal(methods.indexOf('thread/name/set') > methods.indexOf('thread/start'), true);
  assert.equal(methods.indexOf('thread/unsubscribe') > methods.indexOf('thread/name/set'), true);
  assert.equal(p.calls.find(call => call.method === 'thread/name/set')?.params.name, 'Synthetic empty conversation');
  assert.equal(p.calls.some(call => call.method === 'turn/start'), false);
});

test('A failed native name acknowledgement preserves the bound identity and never creates a replacement', async t => {
  let bound: Binding | undefined;
  const p = await peer(t, (request, socket) => {
    if (request.method !== 'thread/name/set') return undefined;
    socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Synthetic unsupported naming' } }));
    return NO_RESPONSE;
  });
  await assert.rejects(p.adapter.create({ cwd: saved.cwd, configuration: saved.configuration, title: 'Synthetic empty conversation' }, value => { bound = value; }));
  assert.deepEqual(bound, { ...created, details: { ...created.details, title: 'Synthetic empty conversation' } });
  assert.equal(p.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(p.calls.filter(call => call.method === 'thread/unsubscribe').length, 1);
  assert.equal(p.calls.some(call => call.method === 'turn/start'), false);
});

test('An interrupted empty-thread naming step is completed from its durable binding without replacement or model work', async t => {
  let named = false;
  const p = await peer(t, (request, socket) => {
    if (request.method === 'thread/resume' && !named) {
      socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: `no rollout found for thread id ${saved.id}` } }));
      return NO_RESPONSE;
    }
    if (request.method === 'thread/name/set') named = true;
    return undefined;
  });
  const binding = { ...saved, details: { ...saved.details, title: 'Recovered empty conversation' } };
  assert.deepEqual(await p.adapter.state(binding), { status: 'idle', pendingInputs: 0, configurationVerified: true });
  assert.equal(p.calls.filter(call => call.method === 'thread/resume').length, 2);
  assert.equal(p.calls.find(call => call.method === 'thread/name/set')?.params.name, binding.details.title);
  assert.equal(p.calls.some(call => call.method === 'thread/start' || call.method === 'turn/start'), false);
});

test('An unrelated native invalid request does not trigger naming or resume retries', async t => {
  const p = await peer(t, (request, socket) => {
    if (request.method !== 'thread/resume') return undefined;
    socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'Synthetic invalid request' } }));
    return NO_RESPONSE;
  });
  const result = await p.adapter.state({ ...saved, details: { ...saved.details, title: 'Saved title' } });
  assert.equal(result.status, 'unknown');
  assert.equal(p.calls.filter(call => call.method === 'thread/resume').length, 1);
  assert.equal(p.calls.some(call => call.method === 'thread/name/set' || call.method === 'thread/start' || call.method === 'turn/start'), false);
});

test('Codex history requests latest native page and preserves stable older cursor and operation identities', async t => {
  const p = await peer(t, request => request.method === 'thread/items/list' ? request.params.cursor ? { data: [userItem('old')], nextCursor: null } : { data: [userItem('new', 'op-new'), userItem('middle')], nextCursor: 'opaque-native-older' } : undefined);
  const latest = await p.adapter.history(saved, undefined, 2);
  assert.deepEqual(latest.items.map(item => item.id), ['middle', 'new']);
  assert.equal(latest.items[1]?.operationId, 'op-new');
  assert.equal(latest.olderCursor, 'opaque-native-older');
  const older = await p.adapter.history(saved, latest.olderCursor!, 2);
  assert.deepEqual(older.items.map(item => item.id), ['old']);
  const reads = p.calls.filter(call => call.method === 'thread/items/list');
  assert.deepEqual(reads.map(call => call.params.sortDirection), ['desc', 'desc']);
  assert.equal(reads[1]?.params.cursor, 'opaque-native-older');
});

test('Codex history widens requests for small items, narrows for large inline images, and reports unsupported legacy threads', async t => {
  // A synthetic native list: item N is large when N is in the large set; cursors are positions.
  const total = 60; const large = new Set([40, 41, 42]);
  const item = (n: number) => ({ turnId: 'run-1', item: { id: `item-${n}`, type: 'userMessage', clientId: `item-${n}`,
    content: [{ type: 'text', text: large.has(n) ? 'x'.repeat(400 * 1024) : `item ${n}` }] }, completedAtMs: 1 });
  const p = await peer(t, (request, socket) => {
    if (request.method !== 'thread/items/list') return undefined;
    if (request.params.threadId === 'legacy-thread') { socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'thread/items/list is not supported yet' } })); return NO_RESPONSE; }
    const end = request.params.cursor ? Number(request.params.cursor) : total; const start = Math.max(0, end - Number(request.params.limit));
    return { data: Array.from({ length: end - start }, (_, index) => item(end - 1 - index)), nextCursor: start ? String(start) : null };
  });
  const page = await p.adapter.history(saved, undefined, 50);
  assert.deepEqual(page.items.map(value => value.id), Array.from({ length: 50 }, (_, index) => `item-${10 + index}`));
  assert.equal(page.olderCursor, '10');
  const limits = p.calls.filter(call => call.method === 'thread/items/list').map(call => Number(call.params.limit));
  assert.equal(limits[0], 2); assert.ok(limits.length < 25, 'small items widen later requests'); assert.ok(limits.some((limit, index) => index > 0 && limit < limits[index - 1]! && limits[index - 1]! >= 8), 'large inline items narrow the next request');
  assert.equal(p.calls.some(call => call.method === 'thread/resume'), false);
  await assert.rejects(p.adapter.history({ ...saved, id: 'legacy-thread' }), { code: 'codex_history_unsupported' });
});

test('History reads never resume or unsubscribe, even beside a concurrent state read (ADR 0014)', async t => {
  let held = 0;
  const p = await peer(t, request => request.method === 'thread/resume' || (request.method === 'thread/items/list' && held++ === 0) ? NO_RESPONSE : undefined);
  const state = p.adapter.state(saved); const history = p.adapter.history(saved);
  await until(() => p.calls.some(call => call.method === 'thread/resume') && p.calls.some(call => call.method === 'thread/items/list'));
  assert.equal(p.calls.filter(call => call.method === 'thread/resume').length, 1, 'only the state read loads the thread');
  const items = p.calls.find(call => call.method === 'thread/items/list')!;
  for (const socket of p.sockets) socket.send(JSON.stringify({ id: items.id, result: { data: [], nextCursor: null } }));
  assert.deepEqual(await history, { items: [], olderCursor: null });
  assert.equal(p.calls.filter(call => call.method === 'thread/unsubscribe').length, 0);
  const resume = p.calls.find(call => call.method === 'thread/resume')!;
  for (const socket of p.sockets) socket.send(JSON.stringify({ id: resume.id, result: nativeConfiguration() }));
  assert.equal((await state).status, 'idle');
  await until(() => p.calls.filter(call => call.method === 'thread/unsubscribe').length === 1);
  await p.adapter.history(saved);
  assert.equal(p.calls.filter(call => call.method === 'thread/resume').length, 1);
  assert.equal(p.calls.filter(call => call.method === 'thread/unsubscribe').length, 1);
});
test('A new observer waits for an earlier unsubscribe before resuming the same native thread', async t => {
  let firstUnsubscribe = true;
  const p = await peer(t, request => {
    if (request.method === 'thread/unsubscribe' && firstUnsubscribe) { firstUnsubscribe = false; return NO_RESPONSE; }
    return undefined;
  });
  const state = p.adapter.state(saved);
  await until(() => p.calls.some(call => call.method === 'thread/unsubscribe'));
  const observed = p.adapter.watch(saved, () => {});
  await delay(20);
  assert.equal(p.calls.filter(call => call.method === 'thread/resume').length, 1);
  const releaseRequest = p.calls.find(call => call.method === 'thread/unsubscribe')!;
  for (const socket of p.sockets) socket.send(JSON.stringify({ id: releaseRequest.id, result: { status: 'unsubscribed' } }));
  await state; const release = await observed;
  assert.equal(p.calls.filter(call => call.method === 'thread/resume').length, 2);
  release();
  await until(() => p.calls.filter(call => call.method === 'thread/unsubscribe').length === 2);
});
test('Permission labels translate known native profiles and retain custom names without narrowing their permissions', async t => {
  const p = await peer(t, request => request.method === 'permissionProfile/list' ? { data: [':read-only', ':workspace', ':danger-full-access', 'custom-profile'].map(id => ({ id, allowed: true, description: 'Native permission definition.' })), nextCursor: null } : undefined);
  const catalog = await p.adapter.catalog();
  assert.deepEqual(catalog.permissions.map(profile => profile.label), ['只读', '工作区读写', '完全访问', 'custom-profile']);
  assert.equal(catalog.permissions.every(profile => profile.description.includes('Native permission definition.')), true);
  assert.deepEqual(catalog.permissions.map(profile => profile.description.endsWith(profile.id === ':danger-full-access' ? '不会请求审批。' : '需要越界时会请求你批准。')), [true, true, true, true], 'the description states whether the conversation asks for approval (ADR 0016)');
});

test('A lost send receipt is unknown and reconciliation finds the same native operation without another send', async t => {
  let accepted = false;
  const p = await peer(t, (request, socket) => {
    if (request.method === 'turn/start') { accepted = true; socket.terminate(); return NO_RESPONSE; }
    if (request.method === 'thread/items/list') return { data: accepted ? [userItem('user-1', 'operation-1')] : [], nextCursor: null };
    return undefined;
  });
  const receipt = await p.adapter.submit(saved, { id: 'operation-1', text: 'Synthetic task' });
  assert.equal(receipt.outcome, 'unknown');
  assert.deepEqual(await p.adapter.reconcile(saved, 'operation-1'), { outcome: 'accepted', runId: 'run-1' });
  const sends = p.calls.filter(call => call.method === 'turn/start');
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.params.clientUserMessageId, 'operation-1');
  assert.equal(sends[0]?.params.model, 'model-a');
  assert.equal(sends[0]?.params.permissions, 'workspace');
});

test('Native -32601 is unknown, is not retried, and does not leak native error text', async t => {
  const p = await peer(t, (request, socket) => {
    if (request.method !== 'thread/resume') return undefined;
    socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'synthetic-private-detail' } }));
    return NO_RESPONSE;
  });
  assert.deepEqual(await p.adapter.reconcile(saved, 'operation-1'), { outcome: 'unknown', reason: 'codex_native_result_unknown' });
  assert.equal(p.calls.filter(call => call.method === 'thread/resume').length, 1);
  assert.equal(p.calls.some(call => call.method === 'turn/start'), false);
});

test('Configuration drift blocks sending but still permits stopping the verified active run', async t => {
  const p = await peer(t, request => {
    if (request.method === 'thread/resume') return { ...nativeConfiguration(), model: 'changed-externally' };
    if (request.method === 'thread/read') return { thread: { id: saved.id, status: { type: 'active', activeFlags: [] } } };
    if (request.method === 'thread/turns/list') return { data: [{ id: 'active-run', status: 'inProgress' }], nextCursor: null };
    return undefined;
  });
  assert.deepEqual(await p.adapter.submit(saved, { id: 'new-operation', text: 'Synthetic' }), { outcome: 'rejected', reason: 'codex_configuration_mismatch' });
  assert.deepEqual(await p.adapter.stop(saved, 'active-run'), { outcome: 'accepted', runId: 'active-run' });
  assert.equal(p.calls.some(call => call.method === 'turn/start'), false);
  assert.equal(p.calls.filter(call => call.method === 'turn/interrupt').length, 1);
});

test('Before its first turn a resumed thread reports no effort; that gap alone is not drift', async t => {
  let native: Record<string, unknown> = { ...nativeConfiguration(), reasoningEffort: null };
  let turns: unknown[] = [];
  const p = await peer(t, request => {
    if (request.method === 'thread/resume') return native;
    if (request.method === 'thread/turns/list') return { data: turns, nextCursor: null };
    return undefined;
  });
  const binding = { ...saved, configuration: { ...saved.configuration, reasoningEffort: 'high' } };
  assert.equal((await p.adapter.state(binding)).configurationVerified, true);
  assert.equal((await p.adapter.submit(binding, { id: 'first-turn', text: 'Synthetic' })).outcome, 'accepted');
  assert.equal(p.calls.find(call => call.method === 'turn/start')?.params.effort, 'high');
  native = { ...native, model: 'changed-externally' };
  assert.equal((await p.adapter.state(binding)).configurationVerified, false, 'other fields still have to match');
  native = { ...native, model: nativeConfiguration().model };
  turns = [{ id: 'run-1', status: 'completed' }];
  assert.equal((await p.adapter.state(binding)).configurationVerified, false, 'a thread with turns must report its effort');
});

test('Codex persists the managed workspace selection before releasing an empty thread', async t => {
  const profile = 'managed-workspace';
  const selected = { ...nativeConfiguration(), approvalPolicy: 'on-request',
    activePermissionProfile: { id: profile }, reasoningEffort: 'max' };
  let persisted = false;
  const p = await peer(t, request => {
    if (request.method === 'model/list') return { data: [{ model: 'model-a', displayName: 'Model A', hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'max', description: 'Max' }] }], nextCursor: null };
    if (request.method === 'thread/start') return selected;
    if (request.method === 'thread/settings/update') {
      assert.deepEqual(request.params, { threadId: saved.id, model: 'model-a', effort: 'max',
        permissions: profile, approvalPolicy: 'on-request' });
      persisted = true;
      return {};
    }
    if (request.method === 'thread/resume') return persisted ? selected : { ...selected, model: 'default-model',
      activePermissionProfile: { id: ':workspace' }, reasoningEffort: null };
    return undefined;
  }, profile);
  const binding = await p.adapter.create({ cwd: saved.cwd, title: 'Synthetic',
    configuration: { modelId: 'model-a', permissionId: ':workspace', reasoningEffort: 'max' } }, () => {});
  assert.deepEqual(await p.adapter.state(binding), { status: 'idle', pendingInputs: 0, configurationVerified: true });
  assert.equal((await p.adapter.submit(binding, { id: 'first-turn', text: 'Synthetic' })).outcome, 'accepted');
  assert.equal(p.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(p.calls.filter(call => call.method === 'thread/settings/update').length, 1);
  assert.equal(p.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.ok(p.calls.findIndex(call => call.method === 'thread/settings/update') < p.calls.findIndex(call => call.method === 'thread/unsubscribe'));
});

test('An idle completed readback retains the latest native run identity', async t => {
  const p = await peer(t, request => request.method === 'thread/turns/list' ? { data: [{ id: 'completed-run', status: 'completed' }], nextCursor: null } : undefined);
  assert.deepEqual(await p.adapter.state(saved), { status: 'idle', runId: 'completed-run', pendingInputs: 0, configurationVerified: true });
});

test('Codex proves the exact older target through native turn pages and does not reuse it for another target', async t => {
  const p = await peer(t, request => {
    if (request.method !== 'thread/turns/list') return undefined;
    if (request.params.limit === 1) return { data: [{ id: 'notification-run', status: 'completed' }], nextCursor: null };
    return request.params.cursor === 'older-turns'
      ? { data: [{ id: 'user-run', status: 'interrupted' }], nextCursor: null }
      : { data: [{ id: 'notification-run', status: 'completed' }], nextCursor: 'older-turns' };
  });
  assert.deepEqual(await p.adapter.state(saved, 'user-run'), { status: 'idle', runId: 'notification-run', terminalRunId: 'user-run', terminalStatus: 'interrupted', pendingInputs: 0, configurationVerified: true });
  assert.equal(p.calls.filter(call => call.method === 'thread/turns/list' && call.params.limit === 100).length, 2);
  assert.equal((await p.adapter.state(saved, 'newly-accepted-run')).terminalRunId, undefined);
  assert.equal((await p.adapter.state(saved)).terminalRunId, undefined);
  assert.equal(p.calls.some(call => call.method === 'turn/start'), false);
});

test('Codex rereads current activity after target proof, so a notification turn started during lookup stays running', async t => {
  let targetRead = false;
  const p = await peer(t, request => {
    if (request.method === 'thread/turns/list') {
      if (request.params.limit === 100) { targetRead = true; return { data: [{ id: 'user-run', status: 'completed' }], nextCursor: null }; }
      return { data: [{ id: 'notification-run', status: 'inProgress' }], nextCursor: null };
    }
    if (request.method === 'thread/read') { assert.equal(targetRead, true); return { thread: { id: saved.id, status: { type: 'active', activeFlags: [] } } }; }
    return undefined;
  });
  const state = await p.adapter.state(saved, 'user-run');
  assert.equal(state.terminalRunId, 'user-run'); assert.equal(state.status, 'running'); assert.equal(state.runId, 'notification-run');
});

test('Codex target proof requires an exact terminal record and remains bounded when it is absent', async t => {
  let unfinished = true; let pages = 0;
  const p = await peer(t, request => {
    if (request.method !== 'thread/turns/list') return undefined;
    if (request.params.limit === 1) return { data: [{ id: 'notification-run', status: 'completed' }], nextCursor: null };
    pages++;
    return unfinished ? { data: [{ id: 'user-run', status: 'inProgress' }], nextCursor: null }
      : { data: [{ id: 'unrelated-' + pages, status: 'completed' }], nextCursor: 'page-' + pages };
  });
  assert.equal((await p.adapter.state(saved, 'user-run')).terminalRunId, undefined);
  unfinished = false; pages = 0;
  const missing = await p.adapter.state(saved, 'missing-run');
  assert.equal(missing.status, 'idle'); assert.equal(missing.terminalRunId, undefined); assert.equal(pages, 10);
});

test('Watch streams stable live items, refuses requests it cannot answer, reports unavailability and releases without cancelling', async t => {
  const p = await peer(t);
  const changes: NativeChange[] = [];
  const release = await p.adapter.watch(saved, change => changes.push(change));
  p.notify('item/started', { threadId: saved.id, turnId: 'run-1', item: { type: 'agentMessage', id: 'reply-1', text: '' } });
  p.notify('item/agentMessage/delta', { threadId: saved.id, turnId: 'run-1', itemId: 'reply-1', delta: 'hello' });
  p.notify('item/agentMessage/delta', { threadId: saved.id, turnId: 'run-1', itemId: 'reply-1', delta: ' world' });
  await until(() => changes.some(change => change.type === 'item' && change.item.text === 'hello world'));
  assert.equal(changes.filter(change => change.type === 'item').every(change => change.item.id === 'reply-1'), true);
  // Dynamic client tools and malformed approvals are refused at once, granting nothing.
  for (const socket of p.sockets) socket.send(JSON.stringify({ id: 'tool-1', method: 'item/tool/call', params: { threadId: saved.id } }));
  for (const socket of p.sockets) socket.send(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: saved.id } }));
  await until(() => p.clientResponses.length > 1);
  const refusal = { code: -32601, message: 'This client does not support this interaction and grants no additional permissions.' };
  assert.deepEqual(p.clientResponses, [{ id: 'tool-1', error: refusal }, { id: 'approval-1', error: refusal }]);
  assert.deepEqual(await p.adapter.requests!(saved), []);
  const before = changes.filter(change => change.type === 'unavailable').length;
  for (const socket of p.sockets) socket.terminate();
  await until(() => changes.filter(change => change.type === 'unavailable').length > before);
  await until(() => p.calls.filter(call => call.method === 'initialize').length === 2);
  release();
  await until(() => p.calls.some(call => call.method === 'thread/unsubscribe'));
  assert.equal(p.calls.some(call => call.method === 'turn/interrupt' || call.method === 'turn/start'), false);
});

test('Oversized live accumulation falls back to invalidation instead of growing the item indefinitely', async t => {
  const p = await peer(t); const changes: NativeChange[] = [];
  await p.adapter.watch(saved, change => changes.push(change));
  p.notify('item/started', { threadId: saved.id, turnId: 'run-1', item: { type: 'agentMessage', id: 'large', text: '' } });
  const before = changes.filter(change => change.type === 'invalidate').length;
  for (let part = 0; part < 5; part++) p.notify('item/agentMessage/delta', { threadId: saved.id, turnId: 'run-1', itemId: 'large', delta: 'x'.repeat(64 * 1024) });
  await until(() => changes.filter(change => change.type === 'invalidate').length > before);
  assert.equal(changes.filter(change => change.type === 'item').every(change => change.item.text.length <= 256 * 1024), true);
});

test('Concurrent calls share one bounded connection and close rejects outstanding requests promptly', async t => {
  const p = await peer(t, request => request.method === 'thread/items/list' ? NO_RESPONSE : undefined);
  const pending = Promise.allSettled(Array.from({ length: 70 }, (_, index) => p.adapter.history({ ...saved, id: `thread-${index}` })));
  await until(() => p.calls.filter(call => call.method === 'thread/items/list').length === 64);
  assert.equal(p.calls.filter(call => call.method === 'initialize').length, 1);
  assert.equal(p.calls.filter(call => call.method === 'thread/resume').length, 0);
  await p.adapter.close();
  const settled = await pending;
  assert.equal(settled.length, 70);
  assert.equal(settled.every(result => result.status === 'rejected'), true);
  assert.equal(p.calls.filter(call => call.method === 'thread/items/list').length, 64);
});
test('Invalid native frames revoke observation without exposing the malformed payload', async t => {
  const p = await peer(t); const changes: NativeChange[] = [];
  const release = await p.adapter.watch(saved, change => changes.push(change));
  const before = changes.filter(change => change.type === 'unavailable').length;
  for (const socket of p.sockets) socket.send('synthetic-private-malformed-frame');
  await until(() => changes.filter(change => change.type === 'unavailable').length > before);
  assert.equal(JSON.stringify(changes).includes('synthetic-private'), false);
  release();
});

test('Codex discovers effort options and pins selected effort at create, send and resume', async t => {
  let nativeEffort = 'high';
  const p = await peer(t, request => {
    if (request.method === 'model/list') return { data: [{ model: 'model-a', displayName: 'Model A', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }, { reasoningEffort: 'high', description: 'Deeper' }] }], nextCursor: null };
    if (request.method === 'thread/start' || request.method === 'thread/resume') return { ...nativeConfiguration(), reasoningEffort: nativeEffort };
  });
  const catalog = await p.adapter.catalog();
  assert.equal(catalog.defaultModelId, 'model-a');
  assert.equal(catalog.models[0]?.defaultReasoningEffort, 'medium');
  assert.deepEqual(catalog.models[0]?.reasoningEfforts?.map(option => option.id), ['medium', 'high']);
  const binding = await p.adapter.create({ cwd: saved.cwd, configuration: { ...saved.configuration, reasoningEffort: 'high' } }, () => {});
  assert.deepEqual(p.calls.find(call => call.method === 'thread/start')?.params.config, { model_reasoning_effort: 'high' });
  assert.equal((await p.adapter.submit(binding, { id: 'effort-message', text: 'Synthetic message' })).outcome, 'accepted');
  assert.equal(p.calls.find(call => call.method === 'turn/start')?.params.effort, 'high');
  nativeEffort = 'medium';
  assert.equal((await p.adapter.state(binding)).configurationVerified, false);
  assert.equal((await p.adapter.submit(binding, { id: 'effort-drift', text: 'Should not run' })).outcome, 'rejected');
  await assert.rejects(p.adapter.create({ cwd: saved.cwd, configuration: { ...saved.configuration, reasoningEffort: 'unsupported' } }, () => {}), /codex_reasoning_effort_unavailable/);
  assert.equal(p.calls.filter(call => call.method === 'thread/start').length, 1);
});

test('Codex draft skill discovery creates no thread and selected references survive first binding', async t => {
  const path = saved.cwd + '/.agents/skills/proof/SKILL.md';
  let enabled = true;
  const p = await peer(t, request => request.method === 'skills/list' ? { data: [{ cwd: saved.cwd, skills: [{ name: 'proof', path, enabled, description: 'Proof' }] }] } : undefined);
  const [draft] = await p.adapter.draftSkills!(saved.cwd);
  assert.ok(draft);
  assert.equal(p.calls.some(call => call.method.startsWith('thread/')), false);
  const [bound] = await p.adapter.skills!(saved);
  assert.notEqual(draft.id, bound?.id);
  const operation = { id: 'draft-skill', text: '⬡ proof now', skills: [{ id: draft.id, label: draft.label, start: 0, end: 7 }] };
  assert.equal((await p.adapter.submit(saved, operation)).outcome, 'accepted');
  assert.deepEqual(p.calls.find(call => call.method === 'turn/start')?.params.input, [{ type: 'text', text: ' $proof  now', text_elements: [] }, { type: 'skill', name: 'proof', path }]);
  enabled = false;
  assert.deepEqual(await p.adapter.submit(saved, { ...operation, id: 'removed-draft-skill' }), { outcome: 'rejected', reason: 'skill_reference_unavailable' });
});

test('Codex deletion does not resume history and accepts only exact native absence on retry', async t => {
  let deleted = false;
  const p = await peer(t, (request, socket) => {
    if (request.method !== 'thread/delete') return undefined;
    assert.deepEqual(request.params, { threadId: saved.id });
    if (!deleted) { deleted = true; return {}; }
    socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: `thread not found: ${saved.id}` } }));
    return NO_RESPONSE;
  });
  await p.adapter.delete!(saved);
  await p.adapter.delete!(saved);
  assert.deepEqual(p.calls.map(call => call.method), ['initialize', 'thread/delete', 'thread/delete']);
});

test('Codex deletion retains native rejection, unrelated absence and malformed success as failures', async t => {
  for (const message of ['thread another-thread already has an active writer', 'thread not found: another-thread', 'no rollout found for thread id thread-1']) {
    await t.test(message, async t => {
      const p = await peer(t, (request, socket) => {
        if (request.method !== 'thread/delete') return undefined;
        socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message } }));
        return NO_RESPONSE;
      });
      await assert.rejects(p.adapter.delete!(saved), { message: 'codex_native_error' });
    });
  }
  const p = await peer(t, request => request.method === 'thread/delete' ? { deleted: false } : undefined);
  await assert.rejects(p.adapter.delete!(saved), { message: 'codex_invalid_data' });
});

test('Codex deletion requires observation release and never deletes through a live watcher', async t => {
  const p = await peer(t, request => request.method === 'thread/delete' ? {} : undefined);
  const stop = await p.adapter.watch(saved, () => {});
  await assert.rejects(p.adapter.delete!(saved), { message: 'codex_delete_observation_active' });
  assert.equal(p.calls.some(call => call.method === 'thread/delete'), false);
  stop();
  await p.adapter.delete!(saved);
  const methods = p.calls.map(call => call.method);
  assert.ok(methods.indexOf('thread/unsubscribe') < methods.indexOf('thread/delete'));
});

// ADR 0016: pending requests stay native-owned; answers travel on the connection that received them.
const approvalParams = (threadId = saved.id, itemId = 'cmd-1') => ({ threadId, turnId: 'run-1', itemId, startedAtMs: 1000, reason: 'Sandbox blocked the network.',
  command: 'curl -sS https://example.com', cwd: saved.cwd, availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['curl'] } }, 'cancel'] });
function sendRequest(p: Awaited<ReturnType<typeof peer>>, id: number | string, method: string, params: unknown) {
  for (const socket of p.sockets) socket.send(JSON.stringify({ id, method, params }));
}

test('Codex holds an approval, answers on the receiving connection and reports accepted only after native resolution', async t => {
  const p = await peer(t); const changes: NativeChange[] = [];
  await p.adapter.watch(saved, change => changes.push(change));
  sendRequest(p, 7, 'item/commandExecution/requestApproval', approvalParams());
  await until(() => changes.some(change => change.type === 'requests'));
  const [request] = await p.adapter.requests!(saved);
  assert.ok(request);
  assert.equal(request.kind, 'approval'); assert.equal(request.agentId, undefined);
  assert.deepEqual(request.approval, { action: 'command', decisions: ['accept', 'cancel'], reason: 'Sandbox blocked the network.', command: 'curl -sS https://example.com', cwd: saved.cwd });
  assert.equal(p.clientResponses.length, 0, 'an answerable request waits for the person');
  // A decision the native request does not offer is refused locally and nothing is sent.
  assert.deepEqual(await p.adapter.answer!(saved, request.id, { kind: 'approval', decision: 'decline' }), { outcome: 'rejected', reason: 'answer_invalid' });
  assert.deepEqual(await p.adapter.answer!(saved, 'cx_unknown', { kind: 'approval', decision: 'accept' }), { outcome: 'rejected', reason: 'request_not_open' });
  const receipt = p.adapter.answer!(saved, request.id, { kind: 'approval', decision: 'accept' });
  await until(() => p.clientResponses.length === 1);
  assert.deepEqual(p.clientResponses[0], { id: 7, result: { decision: 'accept' } });
  assert.deepEqual(await p.adapter.answer!(saved, request.id, { kind: 'approval', decision: 'accept' }), { outcome: 'rejected', reason: 'request_answer_pending' });
  p.notify('serverRequest/resolved', { threadId: saved.id, requestId: 7 });
  assert.deepEqual(await receipt, { outcome: 'accepted' });
  assert.deepEqual(await p.adapter.requests!(saved), []);
});

test('A lost connection clears open requests; the resume after reconnect replays them with the same identity', async t => {
  const p = await peer(t, (request, socket) => {
    if (request.method === 'thread/resume' && p.calls.filter(call => call.method === 'thread/resume').length > 1)
      setTimeout(() => socket.send(JSON.stringify({ id: 3, method: 'item/commandExecution/requestApproval', params: approvalParams() })), 10);
    return undefined;
  });
  const changes: NativeChange[] = [];
  await p.adapter.watch(saved, change => changes.push(change));
  sendRequest(p, 3, 'item/commandExecution/requestApproval', approvalParams());
  await until(() => changes.some(change => change.type === 'requests'));
  const [before] = await p.adapter.requests!(saved);
  const requestHints = () => changes.filter(change => change.type === 'requests').length;
  const hints = requestHints();
  for (const socket of p.sockets) socket.terminate();
  await until(() => requestHints() > hints);
  assert.deepEqual(await p.adapter.requests!(saved), [], 'request ids are scoped to the lost connection');
  await until(() => p.calls.filter(call => call.method === 'thread/resume').length > 1);
  let replayed: Awaited<ReturnType<NonNullable<typeof p.adapter.requests>>> = [];
  for (let tries = 0; tries < 100 && !replayed.length; tries++) { await delay(20); replayed = await p.adapter.requests!(saved); }
  assert.equal(replayed[0]?.id, before?.id);
  const receipt = p.adapter.answer!(saved, replayed[0]!.id, { kind: 'approval', decision: 'cancel' });
  await until(() => p.clientResponses.length === 1);
  p.notify('serverRequest/resolved', { threadId: saved.id, requestId: 3 });
  assert.deepEqual(await receipt, { outcome: 'accepted' });
});

test('A sub-agent request routes to its conversation; a lost answer is unknown and an ended turn drops its requests', async t => {
  const p = await peer(t, request => {
    if (request.method === 'thread/read' && (request.params as { threadId: string }).threadId === 'child-1')
      return { thread: { id: 'child-1', parentThreadId: saved.id, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } };
    return undefined;
  });
  const changes: NativeChange[] = [];
  await p.adapter.watch(saved, change => changes.push(change));
  sendRequest(p, 11, 'item/commandExecution/requestApproval', approvalParams('child-1', 'child-cmd'));
  let routed: Awaited<ReturnType<NonNullable<typeof p.adapter.requests>>> = [];
  for (let tries = 0; tries < 100 && !routed.length; tries++) { await delay(20); routed = await p.adapter.requests!(saved); }
  assert.equal(routed[0]?.agentId, 'child-1');
  const receipt = p.adapter.answer!(saved, routed[0]!.id, { kind: 'approval', decision: 'accept' });
  await until(() => p.clientResponses.length === 1);
  for (const socket of p.sockets) socket.terminate();
  assert.deepEqual(await receipt, { outcome: 'unknown', reason: 'codex_answer_unconfirmed' }, 'no native resolution, no claim');
  await until(() => p.calls.filter(call => call.method === 'initialize').length === 2);
  sendRequest(p, 12, 'item/commandExecution/requestApproval', approvalParams());
  for (let tries = 0; tries < 100 && !(await p.adapter.requests!(saved)).length; tries++) await delay(20);
  p.notify('turn/completed', { threadId: saved.id, turn: { id: 'run-1', status: 'interrupted' } });
  for (let tries = 0; tries < 100 && (await p.adapter.requests!(saved)).length; tries++) await delay(20);
  assert.deepEqual(await p.adapter.requests!(saved), []);
});

test('An MCP request the product cannot present is declined at once and the conversation is told why', async t => {
  const p = await peer(t); const changes: NativeChange[] = [];
  await p.adapter.watch(saved, change => changes.push(change));
  sendRequest(p, 'mcp-1', 'mcpServer/elicitation/request', { threadId: saved.id, turnId: 'run-1', serverName: 'synthetic', mode: 'openai/userVerification', title: 'T', description: 'D', challenge: 'C' });
  await until(() => p.clientResponses.length === 1);
  assert.deepEqual(p.clientResponses[0], { id: 'mcp-1', result: { action: 'decline', content: null, _meta: null } });
  await until(() => changes.some(change => change.type === 'item' && change.item.kind === 'notice' && change.item.text.includes('synthetic')));
  assert.deepEqual(await p.adapter.requests!(saved), []);
});

test('New conversations ask for approval unless they have full access, and every turn pins that policy', async t => {
  const p = await peer(t, request => request.method === 'thread/start' || request.method === 'thread/resume'
    ? { ...nativeConfiguration(), activePermissionProfile: { id: (request.params as { permissions?: string }).permissions ?? ':danger-full-access' } } : undefined);
  const full = await p.adapter.create({ cwd: saved.cwd, configuration: { modelId: 'model-a', permissionId: ':danger-full-access' } }, () => {});
  assert.equal(full.details.approvalPolicy, 'never');
  assert.equal(p.calls.filter(call => call.method === 'thread/start').at(-1)?.params.approvalPolicy, 'never');
  assert.equal((await p.adapter.submit(full, { id: 'full-send', text: 'Synthetic' })).outcome, 'accepted');
  assert.equal(p.calls.filter(call => call.method === 'turn/start').at(-1)?.params.approvalPolicy, 'never');
  const asking = await p.adapter.create({ cwd: saved.cwd, configuration: { modelId: 'model-a', permissionId: ':workspace' } }, () => {});
  assert.equal(asking.details.approvalPolicy, 'on-request');
  assert.equal(p.calls.filter(call => call.method === 'thread/start').at(-1)?.params.approvalPolicy, 'on-request');
});

// Plan mode (ADR 0016): the mode is a thread setting natively, so every turn names it explicitly.
test('Codex names the collaboration mode on every turn, with the conversation model and effort', async t => {
  const p = await peer(t, request => request.method === 'thread/start' || request.method === 'thread/resume'
    ? { ...nativeConfiguration(), reasoningEffort: 'high' } : undefined);
  const binding = { ...saved, configuration: { ...saved.configuration, reasoningEffort: 'high' } };
  assert.equal((await p.adapter.submit(binding, { id: 'plan-turn', text: 'Plan this', plan: true })).outcome, 'accepted');
  assert.deepEqual(p.calls.filter(call => call.method === 'turn/start').at(-1)?.params.collaborationMode,
    { mode: 'plan', settings: { model: 'model-a', reasoning_effort: 'high', developer_instructions: null } });
  assert.equal((await p.adapter.submit(binding, { id: 'default-turn', text: 'Do it' })).outcome, 'accepted');
  assert.equal((p.calls.filter(call => call.method === 'turn/start').at(-1)?.params.collaborationMode as { mode: string }).mode, 'default',
    'leaving the mode out would keep the thread in Plan');
  assert.equal(p.adapter.planMode, 'per-turn');
});

test('A proposed plan is shown as a plan, and Plan-mode questions are answered as the official client does', async t => {
  const p = await peer(t); const changes: NativeChange[] = [];
  await p.adapter.watch(saved, change => changes.push(change));
  p.notify('item/completed', { threadId: saved.id, turnId: 'run-1', item: { type: 'plan', id: 'run-1-plan', text: '## Plan\n1. Read\n2. Write' } });
  await until(() => changes.some(change => change.type === 'item' && change.item.id === 'run-1-plan'));
  const plan = changes.find(change => change.type === 'item' && change.item.id === 'run-1-plan');
  assert.deepEqual(plan?.type === 'item' && [plan.item.kind, plan.item.plan, plan.item.text], ['assistant', true, '## Plan\n1. Read\n2. Write']);
  sendRequest(p, 21, 'item/tool/requestUserInput', { threadId: saved.id, turnId: 'run-1', itemId: 'ask-1', isBlocking: true, questions: [
    { id: 'scope', header: 'Scope', question: 'Body only?', isOther: true, isSecret: false, options: [{ label: 'Body (Recommended)', description: 'Smaller' }, { label: 'Both', description: 'Larger' }] },
    { id: 'when', header: '', question: 'When?', isOther: true, isSecret: false, options: [{ label: 'Today', description: '' }, { label: 'Later', description: '' }] },
  ] });
  let requests: Awaited<ReturnType<NonNullable<typeof p.adapter.requests>>> = [];
  for (let tries = 0; tries < 100 && !requests.length; tries++) { await delay(20); requests = await p.adapter.requests!(saved); }
  const [question] = requests;
  assert.deepEqual(question?.questions?.map(item => [item.id, item.header ?? null, item.multiple, item.custom, item.options.map(option => option.label)]),
    [['scope', 'Scope', false, true, ['Body (Recommended)', 'Both']], ['when', null, false, true, ['Today', 'Later']]]);
  assert.deepEqual(await p.adapter.answer!(saved, question!.id, { kind: 'question', answers: [{ id: 'scope', selected: ['Body (Recommended)', 'Both'] }, { id: 'when', selected: [] }] }),
    { outcome: 'rejected', reason: 'answer_invalid' }, 'one option at most');
  const receipt = p.adapter.answer!(saved, question!.id, { kind: 'question', answers: [{ id: 'scope', selected: ['Body (Recommended)'], custom: 'keep the table' }, { id: 'when', selected: [], custom: 'Friday' }] });
  await until(() => p.clientResponses.length === 1);
  assert.deepEqual(p.clientResponses[0], { id: 21, result: { answers: {
    scope: { answers: ['Body (Recommended)', 'user_note: keep the table'] },
    when: { answers: ['None of the above', 'user_note: Friday'] },
  } } });
  p.notify('serverRequest/resolved', { threadId: saved.id, requestId: 21 });
  assert.deepEqual(await receipt, { outcome: 'accepted' });
});

test('Codex account: the vendor decides; a 401 that survives one refresh is rejected, other failures unverified', async t => {
  let limits: 'ok' | '401' | '401-once' | '500' = 'ok'; let refreshes = 0; let stale = false;
  let account: unknown = { type: 'chatgpt', email: 'someone@example.com', planType: 'pro' };
  const p = await peer(t, (request, socket) => {
    if (request.method === 'account/read') {
      if (request.params.refreshToken) refreshes++;
      if (account === 'refresh-failed') { socket.send(JSON.stringify({ id: request.id, error: { code: -32603, message: 'Your access token could not be refreshed. Please log out and sign in again.' } })); return NO_RESPONSE; }
      return { account, requiresOpenaiAuth: true };
    }
    if (request.method === 'account/rateLimits/read') {
      const rejected = limits === '401' || (limits === '401-once' && refreshes === 0);
      const message = rejected ? 'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; body={"detail":"x"}'
        : limits === '500' ? 'failed to fetch codex rate limits: error sending request' : undefined;
      if (message) { socket.send(JSON.stringify({ id: request.id, error: { code: -32603, message } })); return NO_RESPONSE; }
      return { rateLimits: { primary: { usedPercent: 74, windowDurationMins: 10080, resetsAt: 1794443511 } } };
    }
    if (request.method === 'getAuthStatus') return { authMethod: stale ? 'chatgpt' : null, authToken: null, requiresOpenaiAuth: true };
    if (request.method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGHJ' };
    if (request.method === 'account/login/cancel') return { status: 'canceled' };
    return undefined;
  });
  const signedIn = account; account = null;
  assert.deepEqual(await p.adapter.account!(), { state: 'signed-out' }, 'no account and no stored credential');
  stale = true;
  assert.deepEqual(await p.adapter.account!(), { state: 'rejected' }, 'a stored credential that no longer yields an account is rejected');
  stale = false; account = signedIn;
  assert.deepEqual(await p.adapter.account!(), { state: 'valid', identity: 's***@example.com', plan: 'Pro', usage: { usedPercent: 74, resetsAt: 1794443511000, windowMinutes: 10080 } });
  assert.deepEqual(p.calls.find(call => call.method === 'account/read')!.params, { refreshToken: false }, 'plain reads never force a refresh');
  limits = '401-once'; refreshes = 0;
  assert.equal((await p.adapter.account!()).state, 'valid', 'a renewable token is refreshed once, not reported as rejected');
  assert.equal(refreshes, 1);
  limits = '401';
  assert.deepEqual(await p.adapter.account!(), { state: 'rejected', identity: 's***@example.com', plan: 'Pro' });
  limits = '500';
  assert.equal((await p.adapter.account!()).state, 'unverified');
  account = 'refresh-failed';
  assert.deepEqual(await p.adapter.account!(), { state: 'rejected' }, 'an unrenewable credential is reported as rejected');
  account = null;
  assert.deepEqual(await p.adapter.account!(), { state: 'rejected' }, 'later plain absence is still the lost credential');
  assert.equal((await p.adapter.catalog()).reason, 'codex_login_required');
  account = { type: 'chatgpt', email: 'someone@example.com', planType: 'pro' }; limits = 'ok';
  await p.adapter.account!();
  account = null;
  assert.deepEqual(await p.adapter.account!(), { state: 'rejected' }, 'an account that disappears was rejected');
  const events: unknown[] = []; p.adapter.onAccountEvent!(event => events.push(event));
  assert.deepEqual(await p.adapter.startLogin!(), { kind: 'device-code', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGHJ' });
  assert.deepEqual(p.calls.find(call => call.method === 'account/login/start')!.params, { type: 'chatgptDeviceCode' });
  p.notify('account/login/completed', { loginId: 'login-1', success: false, error: 'Login was not completed', onboardingEntrypoint: null });
  p.notify('account/updated', { authMode: 'chatgpt', planType: 'pro' });
  await until(() => events.length === 2);
  assert.deepEqual(events, [{ type: 'login', loginId: 'login-1', success: false, reason: 'Login was not completed' }, { type: 'changed' }]);
  assert.equal(await p.adapter.cancelLogin!('login-1'), 'canceled');
});

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
const nativeConfiguration = () => ({ thread: { id: saved.id, status: { type: 'idle' } }, cwd: saved.cwd, model: 'model-a', activePermissionProfile: { id: 'workspace' }, approvalPolicy: 'never' });
function userItem(id: string, clientId = id) { return { turnId: 'run-1', item: { id, type: 'userMessage', clientId, content: [{ type: 'text', text: id }] }, completedAtMs: 1 }; }

async function peer(t: TestContext, override?: (request: Request, socket: WebSocket) => unknown, managedExecution = false) {
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
  const adapter = createCodexAdapter({ socketPath, managedExecution });
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
  assert.deepEqual(bound, saved);
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
  assert.deepEqual(binding, { ...saved, details: { ...saved.details, title: 'Synthetic empty conversation' } });
  const methods = p.calls.map(call => call.method);
  assert.equal(methods.indexOf('thread/name/set') > methods.indexOf('thread/start'), true);
  assert.equal(methods.indexOf('thread/unsubscribe') > methods.indexOf('thread/name/set'), true);
  assert.equal(p.calls.find(call => call.method === 'thread/name/set')?.params.name, 'Synthetic empty conversation');
  assert.equal(p.calls.some(call => call.method === 'turn/start'), false);
});

test('Codex awaits durable async binding before naming and rejects a failed persistence promise', async t => {
  const p = await peer(t); let release!: () => void; let entered = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const creating = p.adapter.create({ cwd: saved.cwd, configuration: saved.configuration, title: 'Durable binding' }, async () => { entered = true; await barrier; });
  await until(() => entered); assert.equal(p.calls.some(call => call.method === 'thread/name/set'), false);
  release(); await creating; assert.equal(p.calls.some(call => call.method === 'thread/name/set'), true);
  const before = p.calls.filter(call => call.method === 'thread/name/set').length;
  await assert.rejects(p.adapter.create({ cwd: saved.cwd, configuration: saved.configuration, title: 'Failed binding' }, async () => { throw new Error('synthetic persistence failure'); }), { message: 'codex_binding_persistence_failed' });
  assert.equal(p.calls.filter(call => call.method === 'thread/name/set').length, before);
});

test('A failed native name acknowledgement preserves the bound identity and never creates a replacement', async t => {
  let bound: Binding | undefined;
  const p = await peer(t, (request, socket) => {
    if (request.method !== 'thread/name/set') return undefined;
    socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Synthetic unsupported naming' } }));
    return NO_RESPONSE;
  });
  await assert.rejects(p.adapter.create({ cwd: saved.cwd, configuration: saved.configuration, title: 'Synthetic empty conversation' }, value => { bound = value; }));
  assert.deepEqual(bound, { ...saved, details: { ...saved.details, title: 'Synthetic empty conversation' } });
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
  const p = await peer(t, request => {
    if (request.method === 'thread/read') return { thread: { id: saved.id, status: { type: 'notLoaded' } } };
    if (request.method === 'thread/resume') return NO_RESPONSE;
    if (request.method === 'thread/items/list') return request.params.cursor ? { data: [userItem('old')], nextCursor: null } : { data: [userItem('new', 'op-new'), userItem('middle')], nextCursor: 'opaque-native-older' };
    return undefined;
  });
  const latest = await p.adapter.history(saved, undefined, 2);
  assert.deepEqual(latest.items.map(item => item.id), ['middle', 'new']);
  assert.equal(latest.items[1]?.operationId, 'op-new');
  assert.equal(latest.olderCursor, 'opaque-native-older');
  const older = await p.adapter.history(saved, latest.olderCursor!, 2);
  assert.deepEqual(older.items.map(item => item.id), ['old']);
  const reads = p.calls.filter(call => call.method === 'thread/items/list');
  assert.deepEqual(reads.map(call => call.params.sortDirection), ['desc', 'desc']);
  assert.equal(reads[1]?.params.cursor, 'opaque-native-older');
  assert.deepEqual(p.calls.filter(call => call.method === 'thread/read').map(call => call.params), [
    { threadId: saved.id, includeTurns: false }, { threadId: saved.id, includeTurns: false },
  ]);
  assert.equal(p.calls.some(call => call.method === 'thread/resume' || call.method === 'thread/unsubscribe'), false);
});

test('Codex history refuses a different native thread identity before reading any body', async t => {
  const p = await peer(t, request => request.method === 'thread/read' ? { thread: { id: 'another-thread' } } : undefined);
  await assert.rejects(p.adapter.history(saved), { message: 'codex_native_identity_mismatch' });
  assert.equal(p.calls.some(call => call.method === 'thread/items/list' || call.method === 'thread/resume' || call.method === 'thread/unsubscribe'), false);
});

test('History completes independently while concurrent execution verification waits for resume', async t => {
  const p = await peer(t, request => ['thread/resume', 'thread/items/list'].includes(request.method) ? NO_RESPONSE : undefined);
  const state = p.adapter.state(saved); const history = p.adapter.history(saved);
  await until(() => p.calls.some(call => call.method === 'thread/resume'));
  assert.equal(p.calls.filter(call => call.method === 'thread/resume').length, 1);
  await until(() => p.calls.some(call => call.method === 'thread/items/list'));
  const items = p.calls.find(call => call.method === 'thread/items/list')!;
  for (const socket of p.sockets) socket.send(JSON.stringify({ id: items.id, result: { data: [], nextCursor: null } }));
  assert.deepEqual(await history, { items: [], olderCursor: null });
  assert.equal(p.calls.filter(call => call.method === 'thread/unsubscribe').length, 0);
  const resume = p.calls.find(call => call.method === 'thread/resume')!;
  for (const socket of p.sockets) socket.send(JSON.stringify({ id: resume.id, result: nativeConfiguration() }));
  assert.equal((await state).status, 'idle');
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
  assert.equal(catalog.permissions.every(profile => profile.description.includes('Native permission definition.') && profile.description.includes('不支持额外审批')), true);
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

test('Watch streams stable live items, rejects interactive requests, reports unavailability and releases without cancelling', async t => {
  const p = await peer(t);
  const changes: NativeChange[] = [];
  const release = await p.adapter.watch(saved, change => changes.push(change));
  p.notify('item/started', { threadId: saved.id, turnId: 'run-1', item: { type: 'agentMessage', id: 'reply-1', text: '' } });
  p.notify('item/agentMessage/delta', { threadId: saved.id, turnId: 'run-1', itemId: 'reply-1', delta: 'hello' });
  p.notify('item/agentMessage/delta', { threadId: saved.id, turnId: 'run-1', itemId: 'reply-1', delta: ' world' });
  await until(() => changes.some(change => change.type === 'item' && change.item.text === 'hello world'));
  assert.equal(changes.filter(change => change.type === 'item').every(change => change.item.id === 'reply-1'), true);
  for (const socket of p.sockets) socket.send(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: saved.id } }));
  await until(() => p.clientResponses.length > 0);
  assert.deepEqual(p.clientResponses[0], { id: 'approval-1', error: { code: -32601, message: 'This client does not support this interaction and grants no additional permissions.' } });
  assert.equal(changes.some(change => change.type === 'state' && change.state.status === 'waiting'), true);
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
  const p = await peer(t, request => request.method === 'thread/read' ? NO_RESPONSE : undefined);
  const pending = Promise.allSettled(Array.from({ length: 70 }, (_, index) => p.adapter.history({ ...saved, id: `thread-${index}` })));
  await until(() => p.calls.filter(call => call.method === 'thread/read').length === 64);
  assert.equal(p.calls.filter(call => call.method === 'initialize').length, 1);
  await p.adapter.close();
  const settled = await pending;
  assert.equal(settled.length, 70);
  assert.equal(settled.every(result => result.status === 'rejected'), true);
  assert.equal(p.calls.filter(call => call.method === 'thread/read').length, 64);
  assert.equal(p.calls.some(call => call.method === 'thread/resume' || call.method === 'thread/unsubscribe'), false);
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

test('Managed Codex observation loss cannot activate a reconnect without a new caller operation', async t => {
  const f = await peer(t, undefined, true), changes: NativeChange[] = [];
  const stop = await f.adapter.watch(saved, change => changes.push(change)); t.after(stop);
  const count = f.calls.filter(call => call.method === 'thread/resume').length;
  for (const socket of f.sockets) socket.terminate();
  await until(() => changes.some(change => change.type === 'unavailable'));
  await delay(650);
  assert.equal(f.calls.filter(call => call.method === 'thread/resume').length, count);
  await f.adapter.state(saved);
  assert.equal(f.calls.filter(call => call.method === 'thread/resume').length, count + 1);
});

test('Codex custom providers may explicitly require no OpenAI account; missing auth proof still blocks', async t => {
  for (const requiresOpenaiAuth of [false, true, undefined]) {
    const f = await peer(t, request => request.method === 'account/read' ? { account: null, ...(requiresOpenaiAuth === undefined ? {} : { requiresOpenaiAuth }) } : undefined);
    const catalog = await f.adapter.catalog(); assert.equal(catalog.available, requiresOpenaiAuth === false);
    if (requiresOpenaiAuth !== false) assert.equal(catalog.reason, 'codex_login_required');
  }
});

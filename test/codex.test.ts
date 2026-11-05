import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

async function peer(t: TestContext, override?: (request: Request, socket: WebSocket) => unknown, managedExecution = false, persistentQueries = false, persistCreationSettings = true) {
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
          case 'initialize': result = { codexHome: nativeRoot }; break;
          case 'account/read': result = { account: { type: 'chatgpt' } }; break;
          case 'model/list': result = { data: [{ model: 'model-a', displayName: 'Model A', hidden: false }], nextCursor: null }; break;
          case 'permissionProfile/list': result = { data: [{ id: 'workspace', allowed: true, description: 'Synthetic workspace permission' }], nextCursor: null }; break;
          case 'thread/start': case 'thread/resume': result = nativeConfiguration(); break;
          case 'thread/read': result = { thread: { id: saved.id, status: { type: 'idle' } } }; break;
          case 'thread/turns/list': case 'thread/queue/list': result = { data: [], nextCursor: null }; break;
          case 'thread/items/list': result = { data: [], nextCursor: null }; break;
          case 'thread/unsubscribe': result = { status: 'unsubscribed' }; break;
          case 'thread/name/set': result = {}; break;
          case 'thread/settings/update': result = {}; break;
          case 'turn/start': result = { turn: { id: 'run-1', status: 'inProgress' } }; break;
          case 'turn/interrupt': result = {}; break;
          default: socket.send(JSON.stringify({ id: data.id, error: { code: -32601, message: 'Synthetic unsupported method' } })); return;
        }
      }
      const path = (id: string) => join(nativeRoot, 'sessions', `rollout-${id}.jsonl`);
      if (data.method === 'thread/start') {
        const id = (result as ReturnType<typeof nativeConfiguration>).thread.id;
        writeFileSync(path(id), JSON.stringify({ ordinal: 0, type: 'session_meta', payload: { id, cwd: data.params.cwd, cli_version: '0.166.0-alpha.5.1', history_mode: 'paginated' } }) + '\n');
      }
      if (data.method === 'thread/settings/update' && persistCreationSettings) {
        appendFileSync(path(String(data.params.threadId)), JSON.stringify({ ordinal: 1, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: data.params.threadId, thread_settings: { model: data.params.model, cwd: data.params.cwd, approval_policy: data.params.approvalPolicy, active_permission_profile: { id: data.params.permissions } } } }) + '\n');
      }
      if (data.method === 'thread/read') {
        const value = result as { thread: { id: string; path?: string; cliVersion?: string } };
        if (existsSync(path(value.thread.id))) { value.thread.path = path(value.thread.id); value.thread.cliVersion = '0.166.0-alpha.5.1'; }
      }
      socket.send(JSON.stringify({ id: data.id, result }));
    });
  });
  await new Promise<void>(resolve => http.listen(socketPath, resolve));
  const nativeRoot = join(dir, 'native'), cacheRoot = join(dir, 'cache');
  await mkdir(join(nativeRoot, 'sessions'), { recursive: true });
  const options = { socketPath, managedExecution, ...(persistentQueries ? { boundedHistory: { nativeRoot, cacheRoot } } : {}) };
  let adapter = createCodexAdapter(options);
  t.after(async () => {
    await adapter.close();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { get adapter() { return adapter; }, calls, sockets, clientResponses, cacheRoot, nativeRoot,
    async restart() { await adapter.close(); adapter = createCodexAdapter(options); },
    notify(method: string, params: unknown) { for (const socket of sockets) socket.send(JSON.stringify({ method, params })); } };
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
  assert.deepEqual(bound, { ...saved, details: { ...saved.details, title: '新对话' } });
  assert.equal(p.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(p.calls.some(call => call.method === 'turn/start'), false);
  assert.equal(p.calls.some(call => call.method === 'thread/settings/update'), false);
});

test('Codex creation settings survive cold empty-thread resume and stay isolated across concurrent bindings', async t => {
  let next = 0, cold = false;
  const selected = new Map<string, ReturnType<typeof nativeConfiguration>>(), persisted = new Map<string, ReturnType<typeof nativeConfiguration>>();
  const p = await peer(t, request => {
    const id = String(request.params.threadId);
    if (request.method === 'thread/start') {
      const config = { ...nativeConfiguration(), thread: { id: `empty-${++next}`, status: { type: 'idle' } }, cwd: String(request.params.cwd), model: String(request.params.model), activePermissionProfile: { id: String(request.params.permissions) } };
      selected.set(config.thread.id, config); return config;
    }
    if (request.method === 'thread/settings/update') {
      const expected = selected.get(id)!;
      assert.deepEqual(request.params, { threadId: id, cwd: expected.cwd, model: expected.model, permissions: expected.activePermissionProfile.id, approvalPolicy: 'never' });
      assert(p.calls.some(call => call.method === 'thread/name/set' && call.params.threadId === id));
      persisted.set(id, expected); return {};
    }
    if (request.method === 'thread/resume') {
      assert.deepEqual(request.params, { threadId: id, excludeTurns: true }, 'verification must not overwrite externally changed settings');
      return !cold ? selected.get(id) : persisted.get(id) ?? { ...selected.get(id)!, model: 'native-default', approvalPolicy: 'on-request', activePermissionProfile: null };
    }
    if (request.method === 'thread/read') return { thread: { id, status: { type: 'idle' } } };
    return undefined;
  });
  const bound: Binding[] = [];
  const bindings = await Promise.all(Array.from({ length: 4 }, (_, n) => p.adapter.create({ cwd: saved.cwd, configuration: { modelId: `model-${n}`, permissionId: n % 2 ? 'read-only' : 'workspace' }, title: `Empty ${n}` }, binding => { bound.push(binding); })));
  assert.deepEqual(new Set(bound.map(binding => binding.id)), new Set(bindings.map(binding => binding.id)));
  cold = true; await p.restart();
  for (const binding of bindings) assert.deepEqual(await p.adapter.state(binding), { status: 'idle', pendingInputs: 0, configurationVerified: true });
  assert.equal(p.calls.filter(call => call.method === 'thread/start').length, 4);
  assert.equal(p.calls.filter(call => call.method === 'thread/settings/update').length, 4);
  for (const binding of bindings) {
    const update = p.calls.findIndex(call => call.method === 'thread/settings/update' && call.params.threadId === binding.id);
    assert(update < p.calls.findIndex(call => call.method === 'thread/unsubscribe' && call.params.threadId === binding.id));
  }
  const first = bindings[0]!;
  persisted.set(first.id, { ...persisted.get(first.id)!, activePermissionProfile: { id: 'changed-externally' } });
  assert.equal((await p.adapter.state(first)).reason, 'codex_configuration_mismatch');
  assert.deepEqual(await p.adapter.submit(first, { id: 'original-operation', text: 'synthetic' }), { outcome: 'rejected', reason: 'codex_configuration_mismatch' });
  assert.equal(p.calls.filter(call => call.method === 'thread/settings/update').length, 4, 'recovery must not repair permission drift by writing saved settings');
  assert.equal(p.calls.some(call => call.method === 'turn/start'), false);
});

test('Codex creation settings failure retains the bound identity without replacing or resending work', async t => {
  const p = await peer(t, (request, socket) => {
    if (request.method !== 'thread/settings/update') return undefined;
    socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'synthetic settings failure' } })); return NO_RESPONSE;
  });
  let bound: Binding | undefined;
  await assert.rejects(p.adapter.create({ cwd: saved.cwd, configuration: saved.configuration, title: 'Empty bound thread' }, binding => { bound = binding; }));
  assert.equal(bound?.id, saved.id); assert.deepEqual(bound?.configuration, saved.configuration);
  assert.equal(p.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(p.calls.filter(call => call.method === 'thread/settings/update').length, 1);
  assert.equal(p.calls.filter(call => call.method === 'thread/unsubscribe').length, 1);
  assert.equal(p.calls.some(call => call.method === 'turn/start'), false);
});

test('Codex waits for the physical creation record after an empty settings acknowledgement', async t => {
  const p = await peer(t, undefined, false, true, false);
  let bound: Binding | undefined, finished = false;
  const creating = p.adapter.create({ cwd: saved.cwd, configuration: saved.configuration, title: 'Delayed physical settings' }, binding => { bound = binding; }).then(value => { finished = true; return value; });
  await until(() => p.calls.some(call => call.method === 'thread/read'));
  await delay(150); assert.equal(finished, false); assert.equal(bound?.id, saved.id);
  assert.equal(p.calls.filter(call => call.method === 'thread/settings/update').length, 1);
  assert.equal(p.calls.some(call => call.method === 'thread/unsubscribe'), false);
  appendFileSync(join(p.nativeRoot, 'sessions', `rollout-${saved.id}.jsonl`), JSON.stringify({ ordinal: 1, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: saved.id, thread_settings: { model: saved.configuration.modelId, cwd: saved.cwd, approval_policy: 'never', active_permission_profile: { id: saved.configuration.permissionId } } } }) + '\n');
  assert.equal((await creating).id, saved.id);
  assert.equal(p.calls.filter(call => call.method === 'thread/settings/update').length, 1);
  assert.equal(p.calls.some(call => call.method === 'turn/start'), false);
});

test('Codex leaves an unproven creation bound after its finite persistence budget', async t => {
  const p = await peer(t, undefined, false, true, false); let bound: Binding | undefined;
  await assert.rejects(p.adapter.create({ cwd: saved.cwd, configuration: saved.configuration, title: 'Unproven settings' }, binding => { bound = binding; }), { message: 'codex_configuration_persistence_unconfirmed' });
  assert.equal(bound?.id, saved.id);
  assert.equal(p.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(p.calls.filter(call => call.method === 'thread/settings/update').length, 1);
  assert.equal(p.calls.some(call => call.method === 'turn/start'), false);
});

test('Codex socket-only creation keeps its connection contract, default title and strict drift refusal', async t => {
  let drift = false;
  const direct = await peer(t, request => {
    if (request.method === 'initialize') return {};
    if (request.method === 'thread/resume' && drift) return { ...nativeConfiguration(), model: 'native-default' };
    return undefined;
  }, false, false, false);
  const binding = await direct.adapter.create({ cwd: saved.cwd, configuration: saved.configuration }, () => {});
  assert.equal(binding.details.title, '新对话');
  assert.deepEqual(direct.calls.find(call => call.method === 'thread/name/set')?.params, { threadId: saved.id, name: '新对话' });
  assert.equal(direct.calls.some(call => call.method === 'thread/read' || call.method === 'thread/resume'), false, 'socket-only creation does not require native files or hydrate history');
  drift = true;
  assert.equal((await direct.adapter.state(binding)).reason, 'codex_configuration_mismatch');
  assert.deepEqual(await direct.adapter.submit(binding, { id: 'same-operation', text: 'synthetic' }), { outcome: 'rejected', reason: 'codex_configuration_mismatch' });
  assert.equal(direct.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(direct.calls.filter(call => call.method === 'thread/settings/update').length, 1);
  assert.equal(direct.calls.some(call => call.method === 'turn/start'), false);
  const configured = await peer(t, undefined, false, true);
  const created = await configured.adapter.create({ cwd: saved.cwd, configuration: saved.configuration }, () => {});
  assert.equal(created.id, saved.id); assert.equal(created.details.title, '新对话');
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

test('Codex does not expose a transient terminal projection for the same active turn', async t => {
  let activity = 'active', target = 'interrupted', latest = 'inProgress';
  const p = await peer(t, request => {
    if (request.method === 'thread/turns/list') return { data: [{ id: 'user-run', status: request.params.limit === 100 ? target : latest }], nextCursor: null };
    if (request.method === 'thread/read') return { thread: { id: saved.id, status: { type: activity, activeFlags: [] } } };
    return undefined;
  });
  for (const projected of ['interrupted', 'completed', 'failed']) {
    target = projected;
    const state = await p.adapter.state(saved, 'user-run');
    assert.equal(state.status, 'running'); assert.equal(state.runId, 'user-run');
    assert.equal(state.terminalStatus, undefined); assert.equal(state.terminalRunId, undefined);
  }
  // Even two identical terminal projections cannot override current activity.
  target = latest = 'interrupted';
  assert.equal((await p.adapter.state(saved, 'user-run')).terminalStatus, undefined);
  activity = 'idle'; latest = 'completed';
  assert.equal((await p.adapter.state(saved, 'user-run')).terminalStatus, undefined, 'disagreeing target/current views are not a coherent terminal proof');
  target = latest = 'completed';
  const completed = await p.adapter.state(saved, 'user-run');
  assert.equal(completed.status, 'idle'); assert.equal(completed.terminalStatus, 'completed');
  target = latest = 'interrupted';
  assert.equal((await p.adapter.state(saved, 'user-run')).terminalStatus, 'interrupted');
  activity = 'systemError'; latest = 'inProgress';
  const unknown = await p.adapter.state(saved, 'user-run');
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.reason, 'codex_native_failure');
  assert.equal(unknown.terminalStatus, undefined);
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

test('Codex exact target beyond 2000 turns progresses across bounded state calls and reader restarts', async t => {
  const offsets: number[] = [];
  let terminal = 'completed';
  const p = await peer(t, request => {
    if (request.method !== 'thread/turns/list') return undefined;
    if (request.params.limit === 1) return { data: [{ id: 'notification-run', status: 'completed' }], nextCursor: null };
    const offset = Number(request.params.cursor ?? 0); offsets.push(offset);
    return { data: Array.from({ length: Math.min(100, 2001 - offset) }, (_, n) => ({ id: offset + n === 2000 ? 'old-user-run' : `turn-${offset + n}`, status: offset + n === 2000 ? terminal : 'completed' })),
      nextCursor: offset + 100 < 2001 ? String(offset + 100) : null };
  }, false, true);
  for (let round = 0; round < 2; round++) {
    const before = offsets.length;
    assert.equal((await p.adapter.state(saved, 'old-user-run')).terminalRunId, undefined);
    assert.equal(offsets.length - before, 10);
    await p.restart();
  }
  const found = await p.adapter.state(saved, 'old-user-run');
  assert.equal(found.terminalRunId, 'old-user-run');
  assert.equal(found.terminalStatus, 'completed');
  assert.deepEqual(offsets, [...Array.from({ length: 10 }, (_, n) => n * 100), 0, ...Array.from({ length: 9 }, (_, n) => 1000 + n * 100), 0, 1900, 2000]);
  // A second forced proof reads the native page again, including a changed result.
  terminal = 'inProgress';
  assert.equal((await p.adapter.state(saved, 'old-user-run')).terminalRunId, undefined);
  terminal = 'interrupted';
  assert.equal((await p.adapter.state(saved, 'old-user-run')).terminalStatus, 'interrupted');
  assert.deepEqual(offsets.slice(-4), [0, 2000, 0, 2000]);
});

test('Codex target progress survives disconnect, resets invalid cursors and never publishes a cached terminal fact', async t => {
  let disconnected = false, invalidate = false, generation = 'first';
  let terminal = 'completed';
  const offsets: string[] = [];
  const p = await peer(t, (request, socket) => {
    if (request.method !== 'thread/turns/list') return undefined;
    if (request.params.limit === 1) return { data: [{ id: 'latest', status: 'completed' }], nextCursor: null };
    const entry = String(request.params.cursor ?? `${generation}:0`); offsets.push(entry);
    if (!disconnected && entry === 'first:300') { disconnected = true; socket.terminate(); return NO_RESPONSE; }
    if (invalidate && request.params.cursor) {
      invalidate = false; generation = 'second';
      socket.send(JSON.stringify({ id: request.id, error: { code: -32602, message: 'Synthetic cursor invalid' } })); return NO_RESPONSE;
    }
    const offset = Number(entry.split(':')[1]);
    return { data: [{ id: offset === 1100 ? 'target' : 'other-' + offset, status: offset === 1100 ? terminal : 'completed' }],
      nextCursor: offset < 1100 ? `${generation}:${offset + 100}` : null };
  }, false, true);
  assert.equal((await p.adapter.state(saved, 'target')).status, 'unknown');
  assert.deepEqual(offsets, ['first:0', 'first:100', 'first:200', 'first:300']);
  await p.restart();
  assert.equal((await p.adapter.state(saved, 'target')).terminalStatus, 'completed');
  assert.deepEqual(offsets.slice(4, 6), ['first:0', 'first:300']);
  invalidate = true;
  const invalid = await p.adapter.state(saved, 'target');
  assert.equal(invalid.status, 'unknown'); assert.equal(invalid.reason, 'codex_turn_cursor_reset'); assert.equal(invalid.terminalRunId, undefined);
  const before = offsets.length;
  assert.equal((await p.adapter.state(saved, 'target')).terminalRunId, undefined);
  assert.equal(offsets[before], 'second:0'); assert.equal(offsets.length - before, 10);
  terminal = 'inProgress';
  assert.equal((await p.adapter.state(saved, 'target')).terminalRunId, undefined);
  terminal = 'failed';
  assert.equal((await p.adapter.state(saved, 'target')).terminalStatus, 'failed');
  assert.equal(offsets.at(-1), 'second:1100');
});

test('Codex more than 64 unresolved bindings retain independent query progress without LRU starvation', async t => {
  const starts: string[] = [];
  const p = await peer(t, request => {
    if (request.method === 'thread/resume') return { ...nativeConfiguration(), thread: { id: request.params.threadId, status: { type: 'idle' } } };
    if (request.method === 'thread/read') return { thread: { id: request.params.threadId, status: { type: 'idle' } } };
    if (request.method !== 'thread/turns/list') return undefined;
    if (request.params.limit === 1) return { data: [{ id: 'latest', status: 'completed' }], nextCursor: null };
    const offset = Number(request.params.cursor ?? 0);
    if (!offset) starts.push(String(request.params.threadId));
    return { data: [{ id: offset === 1000 ? 'target' : `other-${offset}`, status: 'completed' }], nextCursor: offset < 1000 ? String(offset + 100) : null };
  }, false, true);
  for (let n = 0; n < 70; n++) assert.equal((await p.adapter.state({ ...saved, id: `binding-${n}` }, 'target')).terminalRunId, undefined);
  await p.restart();
  const before = p.calls.length;
  for (let n = 0; n < 70; n++) assert.equal((await p.adapter.state({ ...saved, id: `binding-${n}` }, 'target')).terminalRunId, 'target');
  assert.equal(starts.length, 140);
  assert.equal(p.calls.slice(before).filter(call => call.method === 'thread/turns/list' && call.params.limit === 100).length, 140);
});

test('Codex target positions isolate target, cwd and configuration; in-process compatibility also progresses', async t => {
  let expected = saved, actualTarget = 'target-a';
  const starts: string[] = [];
  const p = await peer(t, request => {
    if (request.method === 'thread/resume') return { ...nativeConfiguration(), cwd: expected.cwd, model: expected.configuration.modelId, activePermissionProfile: { id: expected.configuration.permissionId } };
    if (request.method !== 'thread/turns/list') return undefined;
    if (request.params.limit === 1) return { data: [{ id: 'latest', status: 'completed' }], nextCursor: null };
    const offset = Number(request.params.cursor ?? 0);
    if (!offset) starts.push(actualTarget + ':' + expected.cwd + ':' + expected.configuration.modelId + ':' + expected.configuration.permissionId);
    return { data: [{ id: offset === 1000 ? actualTarget : 'other-' + offset, status: 'completed' }], nextCursor: offset < 1000 ? String(offset + 100) : null };
  });
  const lookup = async () => {
    assert.equal((await p.adapter.state(expected, actualTarget)).terminalRunId, undefined);
    assert.equal((await p.adapter.state(expected, actualTarget)).terminalRunId, actualTarget);
  };
  await lookup();
  actualTarget = 'target-b'; await lookup();
  expected = { ...saved, cwd: '/workspace/other' }; await lookup();
  expected = { ...expected, configuration: { ...saved.configuration, modelId: 'model-b' } }; await lookup();
  expected = { ...expected, configuration: { modelId: 'model-b', permissionId: 'read-only' } }; await lookup();
  assert.equal(starts.length, 10); assert.equal(new Set(starts).size, 5);
});

test('Codex repeated cursor fails closed and resets its position for recovery', async t => {
  let cycle = true;
  const p = await peer(t, request => {
    if (request.method !== 'thread/turns/list') return undefined;
    if (request.params.limit === 1) return { data: [], nextCursor: null };
    return cycle ? { data: [], nextCursor: 'same' } : { data: [{ id: 'target', status: 'completed' }], nextCursor: null };
  }, false, true);
  const failed = await p.adapter.state(saved, 'target'); assert.equal(failed.status, 'unknown'); assert.equal(failed.reason, 'codex_history_no_progress');
  cycle = false;
  assert.equal((await p.adapter.state(saved, 'target')).terminalRunId, 'target');
  assert.equal(p.calls.filter(call => call.method === 'thread/turns/list' && call.params.limit === 100).at(-1)!.params.cursor, undefined);
});

test('Codex concurrent delayed page cannot roll back a newer target checkpoint or publish stale proof', async t => {
  let held: { request: Request; socket: WebSocket } | undefined, heldOnce = false;
  const p = await peer(t, (request, socket) => {
    if (request.method !== 'thread/turns/list') return undefined;
    if (request.params.limit === 1) return { data: [], nextCursor: null };
    const offset = Number(request.params.cursor ?? 0);
    if (offset === 100 && !heldOnce) { held = { request, socket }; heldOnce = true; return NO_RESPONSE; }
    return { data: [{ id: offset === 1000 ? 'target' : 'other-' + offset, status: 'completed' }], nextCursor: offset < 1000 ? String(offset + 100) : null };
  }, false, true);
  const old = p.adapter.state(saved, 'target');
  await until(() => !!held);
  assert.equal((await p.adapter.state(saved, 'target')).terminalRunId, undefined);
  assert.equal((await p.adapter.state(saved, 'target')).terminalRunId, 'target');
  held!.socket.send(JSON.stringify({ id: held!.request.id, result: { data: [], nextCursor: '200' } }));
  const stale = await old; assert.equal(stale.status, 'unknown'); assert.equal(stale.reason, 'codex_turn_query_conflict');
  assert.equal((await p.adapter.state(saved, 'target')).terminalRunId, 'target');
  assert.equal(p.calls.filter(call => call.method === 'thread/turns/list' && call.params.limit === 100).at(-1)!.params.cursor, '1000');
});

test('Codex recent target proof never creates a cache directory or checkpoint', async t => {
  let status = 'completed';
  const p = await peer(t, request => request.method === 'thread/turns/list'
    ? { data: [{ id: 'recent', status }], nextCursor: null } : undefined, false, true);
  assert.equal((await p.adapter.state(saved, 'recent')).terminalStatus, 'completed');
  status = 'inProgress'; assert.equal((await p.adapter.state(saved, 'recent')).terminalRunId, undefined);
  status = 'interrupted'; assert.equal((await p.adapter.state(saved, 'recent')).terminalStatus, 'interrupted');
  await assert.rejects(stat(p.cacheRoot), { code: 'ENOENT' });
  assert.equal(p.calls.filter(call => call.method === 'thread/turns/list' && call.params.limit === 100).length, 3);
});

test('Codex newly materialized target at the head supersedes its old scanning position', async t => {
  let materialized = false;
  const p = await peer(t, request => {
    if (request.method !== 'thread/turns/list') return undefined;
    if (request.params.limit === 1) return { data: [], nextCursor: null };
    const offset = Number(request.params.cursor ?? 0);
    return { data: [{ id: materialized && !offset ? 'target' : 'unrelated-' + offset, status: 'completed' }], nextCursor: String(offset + 100) };
  }, false, true);
  assert.equal((await p.adapter.state(saved, 'target')).terminalRunId, undefined);
  const active = new DatabaseSync(join(p.cacheRoot, '.bounded-cache.sqlite'), { readOnly: true });
  try { assert.equal(active.prepare('SELECT count(*) n FROM query_positions WHERE expires IS NULL').get()!.n, 1); }
  finally { active.close(); }
  await p.restart(); await delay(2);
  const before = p.calls.length; materialized = true;
  assert.equal((await p.adapter.state(saved, 'target')).terminalRunId, 'target');
  const lookups = p.calls.slice(before).filter(call => call.method === 'thread/turns/list' && call.params.limit === 100);
  assert.equal(lookups.length, 1); assert.equal(lookups[0]!.params.cursor, undefined);
  const cleared = new DatabaseSync(join(p.cacheRoot, '.bounded-cache.sqlite'), { readOnly: true });
  try { assert.equal(cleared.prepare('SELECT count(*) n FROM query_positions').get()!.n, 0); }
  finally { cleared.close(); }
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

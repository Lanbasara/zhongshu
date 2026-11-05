import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { Binding, HarnessAdapter, NativeChange, NativeState } from '../src/harness/types.ts';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { Workbench } from '../src/server/workbench.ts';
import { ManagedHarnessRpc, serveManagedHarness } from '../src/server/managed-harness-rpc.ts';
import type { NativeInvocation } from '../src/server/execution-host.ts';

const idle: NativeState = { status: 'idle', pendingInputs: 0, configurationVerified: true };
async function until(check: () => boolean) { const deadline = Date.now() + 4000; while (!check()) { if (Date.now() > deadline) throw Error('condition_timeout'); await delay(5); } }
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'zh-life-'));
  const db = openDatabase(root, productMigrations); const store = createWorkbenchStore(db);
  const listeners = new Map<string, (change: NativeChange) => void>();
  let states = 0, watches = 0, releases = 0;
  const adapter: HarnessAdapter = { id: 'codex', historyReadOnly: true, observationReleaseSafe: true,
    async catalog() { return { id: 'codex', available: true, models: [{ id: 'm', label: 'm' }], permissions: [{ id: 'p', label: 'p', description: 'synthetic' }] }; },
    async create() { throw Error('unused'); }, async state() { states++; return idle; },
    async history() { return { items: [], olderCursor: null }; }, async submit() { return { outcome: 'unknown', reason: 'synthetic' }; },
    async reconcile() { return { outcome: 'unknown', reason: 'synthetic' }; }, async stop() { return { outcome: 'accepted' }; },
    async watch(binding, listener) { watches++; listeners.set(binding.id, listener); let released = false; return () => { if (!released) { released = true; releases++; if (listeners.get(binding.id) === listener) listeners.delete(binding.id); } }; },
    async close() { listeners.clear(); },
  };
  let service = new Workbench(store, [{ id: 'w', label: 'w', directory: '/synthetic' }], new Map([['codex', adapter]]));
  function add(state = idle) {
    const id = randomUUID(); const binding: Binding = { id, cwd: '/synthetic', configuration: { modelId: 'm', permissionId: 'p' }, details: {} };
    store.createConversation({ id, harnessId: 'codex', workspaceId: 'w', cwd: binding.cwd, configuration: binding.configuration });
    store.saveBinding(id, binding); store.setConversationState(id, { state, readiness: 'ready' }); return { id, binding };
  }
  t.after(async () => { await service.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, adapter, add, listeners, get service() { return service; }, replace(value: HarnessAdapter) { service = new Workbench(store, [{ id: 'w', label: 'w', directory: '/synthetic' }], new Map([['codex', value]])); }, get states() { return states; }, get watches() { return watches; }, get releases() { return releases; } };
}

test('startup and reading 100 cold conversations acquire no native observation or execution state', async t => {
  const f = fixture(t); const conversations = Array.from({ length: 100 }, () => f.add());
  await f.service.start(); for (const { id } of conversations) await f.service.open(id);
  await delay(200);
  assert.equal(f.watches, 0); assert.equal(f.states, 0); assert.equal(f.releases, 0);
});

test('cold reads cannot consume observation capacity or turn a known running record unknown', async t => {
  const f = fixture(t); const running = { ...idle, status: 'running' as const, runId: 'run' };
  const conversations = Array.from({ length: 17 }, () => f.add(running));
  f.adapter.state = async () => running;
  for (const { id } of conversations.slice(0, 16)) await f.service.reconcile(id);
  const last = conversations.at(-1)!; const result = await f.service.open(last.id);
  assert.equal(result.conversation.state.status, 'running'); assert.equal(f.watches, 16);
  assert.equal(f.store.getConversation(last.id)?.error, null);
});

test('idle observations release only under an explicit safe-release capability', async t => {
  const f = fixture(t); const { id } = f.add();
  // Time advances only for observation maintenance; no native execution is simulated by the clock.
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  await f.service.reconcile(id); await delay(1);
  for (let step = 0; step < 9; step++) { t.mock.timers.tick(5000); await delay(2); }
  assert.equal(f.releases, 1); assert.equal(f.listeners.size, 0);
  const calls = f.states; await f.service.open(id); assert.equal(f.states, calls);
});

test('managed RPC timeout restores the event watch without replaying a mutation', async t => {
  const f = fixture(t); const { id, binding } = f.add();
  const options = { socketPath: join(f.root, 'native.sock'), token: randomBytes(32).toString('base64url'), timeoutMs: 100 };
  let submissions = 0;
  f.adapter.submit = async () => { submissions++; await delay(250); return { outcome: 'accepted' }; };
  const server = await serveManagedHarness(f.adapter, options); const rpc = new ManagedHarnessRpc(options);
  const invocation = (method: NativeInvocation['method'], args: unknown[]): NativeInvocation => ({ method, args, requestId: randomUUID(), harnessId: 'codex', conversationId: id, workspaceId: 'w' } as NativeInvocation);
  const proxy: HarnessAdapter = { ...f.adapter,
    state: async b => await rpc.invoke(invocation('state', [b]), async () => {}) as NativeState,
    async watch(b, listener) { const request = invocation('watch', [b]); await rpc.invoke(request, async () => {}, listener); return () => rpc.releaseWatch(request.requestId); },
    async close() { await rpc.close(); },
  };
  await f.service.close(); f.replace(proxy);
  // Close this server before fixture cleanup removes its socket.
  t.after(async () => { await f.service.close(); await server.close(); });
  await f.service.reconcile(id);
  await assert.rejects(rpc.invoke(invocation('submit', [binding, { id: randomUUID(), text: 'synthetic' }]), async () => {}));
  await until(() => f.watches >= 2);
  f.listeners.get(binding.id)?.({ type: 'invalidate' });
  const before = f.states; await until(() => f.states > before);
  assert.equal(submissions, 1); assert.equal(f.listeners.size, 1);
  assert.equal(f.releases, 1);
});

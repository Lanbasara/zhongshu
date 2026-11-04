import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { Binding, HarnessAdapter, NativeChange } from '../src/harness/types.ts';
import { ManagedHarnessRpc, serveManagedHarness } from '../src/server/managed-harness-rpc.ts';
import { managedHarnessReadAdapter } from '../src/server/managed-harness-adapter.ts';
import type { PluginBackend } from '../src/server/plugin-backend.ts';
import type { NativeInvocation } from '../src/server/execution-host.ts';
const binding: Binding = { id: 'synthetic-binding', cwd: '/synthetic', configuration: { modelId: 'synthetic', permissionId: 'workspace' }, details: {} };
async function fixture(t: TestContext, plugins?: PluginBackend) {
  const root = await mkdtemp(join(tmpdir(), 'zh-rpc-')); const options = { socketPath: join(root, 'native.sock'), token: randomBytes(32).toString('base64url'), timeoutMs: 250 };
  let created = 0, configured = 0, activated = 0, released = 0; let callback: (change: NativeChange) => void = () => {};
  let submit: HarnessAdapter['submit'] = async () => ({ outcome: 'accepted', runId: 'run' });
  const adapter: HarnessAdapter = {
    id: 'codex', earlyInput: 'current', async catalog() { return { id: 'codex', available: true, models: [], permissions: [] }; },
    async create(_input, bound) { created++; await bound(binding); configured++; return binding; },
    async state() { activated++; return { status: 'idle', configurationVerified: true, pendingInputs: 0 }; },
    async history() { return { items: [], olderCursor: null }; }, async submit(...args) { return await submit(...args); },
    async reconcile() { activated++; return { outcome: 'unknown', reason: 'synthetic' }; }, async stop() { return { outcome: 'accepted' }; },
    async watch(_binding, listener) { activated++; callback = listener; return () => { released++; }; },
    async readBodyChunk(_binding, _token, offset) { return { version: 'a'.repeat(64), bytes: 65536, offset, nextOffset: null, data: new Uint8Array(65536).fill(7) }; }, async close() {},
  };
  const server = await serveManagedHarness(adapter, options, plugins); const client = new ManagedHarnessRpc(options);
  t.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const invocation = (method: Exclude<NativeInvocation['method'], 'pluginChange' | 'pluginSource'>, args: unknown[]): NativeInvocation => ({ requestId: randomUUID(), harnessId: 'codex', method, args, conversationId: randomUUID(), workspaceId: 'synthetic' });
  return { client, options, invocation, setSubmit(value: HarnessAdapter['submit']) { submit = value; }, get created() { return created; }, get configured() { return configured; }, get activated() { return activated; }, get released() { return released; }, emit() { callback({ type: 'item', item: { id: 'huge', kind: 'assistant', text: 'x'.repeat(2 * 1024 ** 2), status: 'running' } }); } };
}
test('private native RPC waits for durable binding acknowledgement and does not continue after rejected persistence', async t => {
  const f = await fixture(t); let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }); let seen = false;
  const request = f.client.invoke(f.invocation('create', [{ cwd: binding.cwd, configuration: binding.configuration }]), async received => { assert.deepEqual(received, binding); seen = true; await barrier; });
  while (!seen) await delay(1);
  assert.equal(f.created, 1); assert.equal(f.configured, 0); release(); assert.deepEqual(await request, binding); assert.equal(f.configured, 1);
  await assert.rejects(f.client.invoke(f.invocation('create', [{}]), async () => { throw new Error('persistence failed'); }), { code: 'managed_native_result_unknown' });
  assert.equal(f.created, 2); assert.equal(f.configured, 1);
});
test('physical read projection cannot activate state/watch/reconcile; bodies remain binary and optional capabilities honest', async t => {
  const f = await fixture(t); const raw = await managedHarnessReadAdapter(f.client);
  for (const method of ['state', 'reconcile', 'watch', 'skills'] as const) await assert.rejects(f.client.read(method, [binding]), { code: 'managed_native_activation_requires_permission' });
  await assert.rejects(raw.state(binding)); assert.equal(f.activated, 0); assert.equal(raw.readItems, undefined);
  const chunk = await raw.readBodyChunk!(binding, 'private-token', 0, 65536); assert.ok(chunk.data instanceof Uint8Array); assert.equal(chunk.data.length, 65536); assert.equal(chunk.data[65535], 7);
});

test('a managed read projection created offline discovers body and revision methods after Host recovery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zh-rpc-cold-'));
  const options = { socketPath: join(root, 'native.sock'), token: randomBytes(32).toString('base64url'), timeoutMs: 250 };
  const client = new ManagedHarnessRpc(options);
  let server: Awaited<ReturnType<typeof serveManagedHarness>> | undefined;
  let activated = 0, historyReads = 0;
  const adapter: HarnessAdapter = {
    id: 'codex', earlyInput: 'current', async catalog() { return { id: 'codex', available: true, models: [], permissions: [] }; },
    async create() { activated++; throw Error('must_not_activate'); }, async state() { activated++; throw Error('must_not_activate'); },
    async submit() { activated++; throw Error('must_not_activate'); }, async reconcile() { activated++; throw Error('must_not_activate'); },
    async stop() { activated++; throw Error('must_not_activate'); }, async watch() { activated++; throw Error('must_not_activate'); },
    async history() { historyReads++; return { items: [], olderCursor: null }; },
    async historyChanges() { return { itemIds: ['revised'], cursor: 'cut', hasMore: false }; },
    async readItems() { return [{ id: 'revised', kind: 'assistant', text: 'revised body', status: 'completed' }]; },
    async readBodyChunk(_binding, _token, offset) { return { version: 'a'.repeat(64), bytes: 4, offset, nextOffset: null, data: Uint8Array.of(1, 2, 3, 4) }; },
    async releaseBodySource() {}, async close() {},
  };
  t.after(async () => { await client.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
  const raw = await managedHarnessReadAdapter(client, 'codex');
  await assert.rejects(raw.history(binding));
  server = await serveManagedHarness(adapter, options);
  await raw.history(binding);
  assert.equal(typeof raw.readBodyChunk, 'function', 'temporary offline discovery must not permanently remove body reading');
  assert.deepEqual(Array.from((await raw.readBodyChunk!(binding, 'body', 0, 4)).data), [1, 2, 3, 4]);
  assert.deepEqual(await raw.historyChanges!(binding), { itemIds: ['revised'], cursor: 'cut', hasMore: false });
  assert.equal((await raw.readItems!(binding, ['revised']))[0]?.text, 'revised body');
  await raw.releaseBodySource!(binding, 'body');
  for (const method of ['state', 'watch', 'reconcile'] as const) await assert.rejects(raw[method](binding, '' as never));
  assert.equal(activated, 0);
  await server.close(); server = undefined;
  await assert.rejects(raw.history(binding));
  server = await serveManagedHarness({ ...adapter, id: 'dsh' }, options);
  const before = historyReads;
  await assert.rejects(raw.history(binding), { code: 'managed_native_harness_changed' });
  assert.equal(historyReads, before, 'a reconnected Host of another identity must not receive the history request');
  await server.close(); server = undefined;
  await assert.rejects(raw.history(binding));
  server = await serveManagedHarness({ ...adapter, historyChanges: undefined }, options);
  await assert.rejects(raw.historyChanges!(binding), { code: 'managed_native_method_unavailable' });
  assert.deepEqual(Array.from((await raw.readBodyChunk!(binding, 'body', 0, 4)).data), [1, 2, 3, 4]);
  assert.equal(activated, 0);
});

test('declared RPC capabilities remain readable when the native catalog is temporarily unavailable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zh-rpc-caps-'));
  const options = { socketPath: join(root, 'native.sock'), token: randomBytes(32).toString('base64url'), timeoutMs: 250 };
  let catalogReads = 0;
  const unusable = async (): Promise<never> => { throw Error('must_not_activate'); };
  const adapter: HarnessAdapter = { id: 'codex', async catalog() { catalogReads++; return { id: 'codex', available: false, models: [], permissions: [] }; },
    async history() { return { items: [], olderCursor: null }; }, async close() {},
    create: unusable, state: unusable, submit: unusable, reconcile: unusable, stop: unusable, watch: unusable };
  const server = await serveManagedHarness(adapter, options); const client = new ManagedHarnessRpc(options);
  t.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  assert.ok((await client.capabilities()).methods.includes('history'));
  assert.equal(catalogReads, 0, 'protocol discovery must not depend on execution readiness');
  await assert.rejects(client.ready(), { code: 'managed_native_unavailable' });
  assert.equal(catalogReads, 1, 'explicit Host readiness still requires an available native catalog');
});
test('watch sends bounded invalidation hints, releases native watchers, and timeout never retransmits', async t => {
  const f = await fixture(t); let hints = 0;
  const request = f.invocation('watch', [binding]);
  await f.client.invoke(request, async () => {}, change => { assert.equal(change.type, 'invalidate'); hints++; });
  f.emit(); while (!hints) await delay(1); f.client.releaseWatch(request.requestId); while (!f.released) await delay(1);
  let calls = 0; f.setSubmit(async () => { calls++; await delay(350); return { outcome: 'accepted' }; });
  await assert.rejects(f.client.invoke(f.invocation('submit', [binding, { id: randomUUID(), text: 'synthetic' }]), async () => {}), { code: 'managed_native_result_unknown' });
  await delay(400); assert.equal(calls, 1); assert.equal(f.released, 1);
});
test('private native socket rejects another credential before adapter work', async t => {
  const f = await fixture(t); const wrong = new ManagedHarnessRpc({ ...f.options, token: randomBytes(32).toString('base64url') });
  await assert.rejects(wrong.ready()); assert.equal(f.created, 0); assert.equal(f.activated, 0); await wrong.close();
});

test('plugin mutations require gateway invocation and recovery cannot settle an in-flight source effect', async t => {
  let release!: () => void; let entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  let changed = 0, recovered = 0;
  const plugins: PluginBackend = { async list() { return []; }, async change() { changed++; return 'applied'; }, async recover() { recovered++; return 'applied'; },
    async updateSource() { entered(); await barrier; }, async recoverSource() { recovered++; return 'applied'; } };
  const f = await fixture(t, plugins); t.after(release);
  await assert.rejects(f.client.read('pluginChange', [{}]), { code: 'managed_native_activation_requires_permission' });
  await assert.rejects(f.client.read('pluginSource', [{}]), { code: 'managed_native_activation_requires_permission' });
  const id = randomUUID(); const command = { action: 'add', source: 'synthetic/market' };
  const effect = f.client.invoke({ requestId: id, operationId: id, harnessId: 'codex', method: 'pluginSource', args: [command, id] }, async () => {});
  await started; assert.equal(await f.client.read('pluginRecoverSource', [command, id]), 'unknown'); assert.equal(recovered, 0);
  release(); assert.deepEqual(await effect, { status: 'applied' });
  assert.equal(await f.client.read('pluginRecoverSource', [command, id]), 'applied'); assert.equal(recovered, 1); assert.equal(changed, 0);
});

test('four supported 2 MiB images fit the bounded native request without raising the per-image limit', async t => {
  const f = await fixture(t); const client = new ManagedHarnessRpc({ ...f.options, timeoutMs: 5000 }); t.after(() => client.close());
  const imageData = Array.from({ length: 4 }, () => ({ mediaType: 'image/png', data: Buffer.alloc(2 * 1024 ** 2, 7).toString('base64') }));
  let received = 0; f.setSubmit(async (_binding, input) => { received = input.imageData?.length ?? 0; return { outcome: 'accepted' }; });
  const invocation = f.invocation('submit', [binding, { id: randomUUID(), text: 'synthetic image request', imageData }]);
  const { nativeWireDigest } = await import('../src/server/execution-host.ts'); assert.match(nativeWireDigest(invocation), /^[a-f0-9]{64}$/);
  assert.deepEqual(await client.invoke(invocation, async () => {}), { outcome: 'accepted' }); assert.equal(received, 4);
});

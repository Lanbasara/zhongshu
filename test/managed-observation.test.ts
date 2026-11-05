import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { Binding, HarnessAdapter, NativeState } from '../src/harness/types.ts';
import { createStorageClient } from '../src/server/storage-client.ts';
import { WorkspaceRegistry } from '../src/server/workspace-registry.ts';
import { createExecutionHostLedger } from '../src/server/execution-host-ledger.ts';
import { acquireExecutionHostOwnership, ExecutionHost } from '../src/server/execution-host.ts';
import { createManagedHarnessAuthority } from '../src/server/managed-harness-authority.ts';
import { createManagedHarnessAdapter } from '../src/server/managed-harness-adapter.ts';
import { ManagedHarnessRpc, serveManagedHarness } from '../src/server/managed-harness-rpc.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idle: NativeState = { status: 'idle', configurationVerified: true, pendingInputs: 0 };
const unknown: NativeState = { status: 'unknown', configurationVerified: false, pendingInputs: 0, reason: 'synthetic_configuration_mismatch' };

/** Real production storage/ledger workers and Unix RPC; only Native behavior and
 * Docker process proof are controlled peers, not claims about actual Harnesses. */
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zh-observe-'))), workspace = join(root, 'workspace');
  await mkdir(workspace);
  const workspaces = [{ id: 'workspace', label: 'Synthetic observation', directory: workspace, managedWrites: true }];
  let storage = createStorageClient({ dataDirectory: join(root, 'product') }); await storage.ready;
  let registry = new WorkspaceRegistry(storage.workspaces, workspaces, []); await registry.ready;
  let observe = async (): Promise<NativeState> => unknown, calls = 0;
  const native: HarnessAdapter = {
    id: 'codex', async catalog() { return { id: 'codex', available: true, models: [], permissions: [] }; },
    async create() { throw new Error('unexpected create'); }, async state() { calls++; return await observe(); },
    async history() { return { items: [], olderCursor: null }; }, async submit() { throw new Error('unexpected submit'); },
    async reconcile() { return { outcome: 'unknown', reason: 'synthetic_unknown' }; },
    async stop() { throw new Error('unexpected stop'); }, async watch() { return () => {}; }, async close() {},
  };
  const rpcOptions = { socketPath: join(root, 'n.sock'), token: randomBytes(32).toString('base64url') };
  const server = await serveManagedHarness(native, rpcOptions);
  let client = new ManagedHarnessRpc(rpcOptions), ownership = await acquireExecutionHostOwnership(0);
  const ownershipPort = ownership.port, configurationDigest = digest('observation-fixture');
  const ledgerOptions = { directory: join(root, 'ledger'), groupId: 'group', configurationDigest };
  let ledger = createExecutionHostLedger(ledgerOptions); await ledger.ready;
  const generation = (await ledger.load()).state.generation;
  const physical = () => ({ id: 'a'.repeat(64), groupId: 'group', generation, configurationDigest, running: true, pid: 123, status: 'running' });
  const makeHost = () => new ExecutionHost(ledger, { async prepare() { return physical(); }, async inspect() { return physical(); },
    async start() { return physical(); }, async quiesce() { throw new Error('unknown work must not quiesce'); } }, client,
  createManagedHarnessAuthority({ groupId: 'group', harnessId: 'codex', store: storage.store, execution: storage.execution, registry }), ownership);
  let host = makeHost(); await host.bootstrap();
  await storage.execution.registerGroup((await ledger.load()).state);
  await storage.execution.registerScope({ workspaceId: 'workspace', groupId: 'group' });
  const baseline = await storage.execution.beginBaseline('group');
  for (const source of ['operations', 'queues'] as const) await storage.execution.seedLegacyAdmissions({ groupId: 'group', source, after: 0, limit: 8, byteLimit: 4096 });
  await storage.execution.commitBaselineBatch({ groupId: 'group', through: baseline.through, limit: 8, byteLimit: 4096,
    expectedRevision: (await storage.execution.load(['group']))[0]!.revision, observations: [], proof: digest('empty') });
  const configuration = { modelId: 'synthetic', permissionId: 'workspace' };
  async function conversation() {
    const id = randomUUID(), binding: Binding = { id: 'binding-' + id, cwd: workspace, configuration, details: {} };
    await storage.store.createConversation({ id, workspaceId: 'workspace', harnessId: 'codex', cwd: workspace, configuration });
    await storage.store.saveBinding(id, binding); return { id, binding };
  }
  const first = await conversation(), second = await conversation();
  const operation = { id: randomUUID(), conversationId: first.id, type: 'message' as const, payload: { text: 'original queued input must remain' } };
  await storage.store.enqueueOperation(operation);
  const reader = new DatabaseSync(join(root, 'product', 'zhongshu.sqlite'), { readOnly: true });
  const ledgerReader = new DatabaseSync(join(root, 'ledger', 'zhongshu.sqlite'), { readOnly: true });
  const pending = () => reader.prepare('SELECT a.* FROM execution_pending p JOIN execution_admissions a ON a.id=p.admission_id ORDER BY a.sequence').all();
  const adapter = async (id = first.id, context = {}) => createManagedHarnessAdapter(host, client, (await storage.store.getConversation(id))!, context);
  t.after(async () => { reader.close(); ledgerReader.close(); await host.close(); await client.close(); await server.close(); await storage.close(); await rm(root, { recursive: true, force: true }); });
  return { first, second, operation, pending, reader, ledgerReader, adapter, calls: () => calls, setObserve: (next: typeof observe) => { observe = next; },
    storage: () => storage, host: () => host, ledger: () => ledger,
    async restart() {
      await host.close(); await client.close(); await storage.close();
      storage = createStorageClient({ dataDirectory: join(root, 'product') }); await storage.ready;
      registry = new WorkspaceRegistry(storage.workspaces, workspaces, []); await registry.ready;
      client = new ManagedHarnessRpc(rpcOptions); ownership = await acquireExecutionHostOwnership(ownershipPort);
      ledger = createExecutionHostLedger(ledgerOptions); await ledger.ready; host = makeHost(); await host.bootstrap();
    },
  };
}

test('unknown background observations share one durable admission across concurrency and restart, retaining each request once', async t => {
  const f = await fixture(t), adapter = await f.adapter();
  await adapter.state(f.first.binding);
  const originalAdmission = f.pending().find(row => row.source === 'native')!.id;
  for (let i = 0; i < 500; i++) await adapter.state(f.first.binding);
  await Promise.all(Array.from({ length: 20 }, () => adapter.state(f.first.binding)));
  assert.equal(f.pending().length, 2, 'one unknown observation plus the original queued operation');
  assert.equal(f.pending().find(row => row.source === 'native')!.id, originalAdmission);
  await f.restart();
  const reopened = await f.adapter();
  for (let i = 0; i < 500; i++) await reopened.state(f.first.binding);
  assert.equal(f.pending().length, 2);
  assert.equal(f.pending().find(row => row.source === 'native')!.id, originalAdmission);
  const request = { kind: 'observe' as const, requestId: 'observe:' + randomUUID(), conversationId: f.first.id, method: 'state' as const };
  const before = f.calls(); await Promise.all([f.host().dispatch(request), f.host().dispatch(request)]);
  assert.equal(f.calls(), before + 1); await f.restart(); await f.host().dispatch(request); assert.equal(f.calls(), before + 1);
  f.setObserve(async () => idle); await (await f.adapter()).state(f.first.binding);
  assert.equal((await f.storage().execution.admission(String(originalAdmission)))!.kind, 'settled');
  assert.deepEqual(f.pending().map(row => row.id), ['o:' + f.operation.id]);
  assert.equal((await f.storage().store.getOperation(f.operation.id))!.status, 'queued');
  assert.deepEqual((await f.storage().store.getOperation(f.operation.id))!.payload, f.operation.payload);
  assert.equal(Number(f.reader.prepare('SELECT COUNT(*) count FROM execution_observation_requests').get()!.count), f.calls(), 'request identities remain distinct; this is not constant total journal storage');
  const journal = f.ledgerReader.prepare(`SELECT COUNT(*) requests,SUM(length(request_id)+length(admission_id)+length(content_digest)+length(wire_digest)+length(groups_json)+COALESCE(length(result_json),0)) payload_bytes FROM execution_host_forwards`).get()!;
  assert.equal(journal.requests, f.calls());
  t.diagnostic(JSON.stringify({ observations: f.calls(), remainingPending: f.pending().length, settledAndUnknownReceiptJournal: journal }));
  const beforeIdle = Number(f.reader.prepare("SELECT COUNT(*) count FROM execution_admissions WHERE source='native'").get()!.count);
  const ready = await f.adapter();
  for (let i = 0; i < 20; i++) await ready.state(f.first.binding);
  const idleAdmissions = Number(f.reader.prepare("SELECT COUNT(*) count FROM execution_admissions WHERE source='native'").get()!.count) - beforeIdle;
  assert.equal(idleAdmissions, 20); assert.equal(f.pending().length, 1);
  t.diagnostic(JSON.stringify({ normalIdleObservations: 20, additionalDurableAdmissions: idleAdmissions, additionalOnceReceipts: f.calls() - Number(journal.requests), remainingPending: f.pending().length }));
});

test('direct gateway callers cannot settle an earlier still-active observation', async t => {
  const f = await fixture(t);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.setObserve(async () => { if (f.calls() === 1) { await gate; return unknown; } return idle; });
  const request = () => ({ kind: 'observe' as const, requestId: 'direct-state-' + randomUUID(), conversationId: f.first.id, method: 'state' as const });
  const first = f.host().dispatch(request());
  while (f.calls() === 0) await delay(1);
  const second = f.host().dispatch(request()); await delay(20);
  const during = f.calls(); release(); await Promise.all([first, second]);
  assert.equal(during, 1, 'same-binding observation activation is serialized');
  assert.deepEqual(f.pending().map(row => row.id), ['o:' + f.operation.id]);
});

test('legacy unknown observations remain until paged fresh terminal proof; a fence admits no new binding', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 70; i++) await f.storage().execution.registerNative({ sourceKey: 'observe:' + randomUUID(), workspaceId: 'workspace',
    conversationId: f.first.id, bindingId: f.first.binding.id, purpose: 'execute', wireDigest: digest(i) });
  const ids = f.pending().filter(row => row.source === 'native').map(row => row.id);
  const adapter = await f.adapter();
  for (let i = 0; i < 10; i++) await adapter.state(f.first.binding);
  assert.equal(f.pending().length, 71, 'old unknown records are retained, not multiplied or silently deleted');
  const rows = await f.storage().execution.load(['group']);
  const [frozen] = await f.storage().execution.freezeAdmissions({ windowId: 'window', groups: rows.map(({ groupId, revision }) => ({ groupId, revision })) });
  const fenced = await f.host().controller.fence({ requestId: 'fence', expected: { generation: frozen!.controller.generation, epoch: frozen!.controller.epoch }, frozenSetId: frozen!.frozenSetId! });
  assert.equal(fenced.status, 'known'); if (fenced.status !== 'known') return;
  assert.equal(await f.storage().execution.save('group', frozen!.revision, { ...frozen!, revision: frozen!.revision + 1, stage: 'drain', controller: fenced.state }), true);
  assert.equal((await adapter.state(f.first.binding)).status, 'unknown', 'only the already-frozen observation admission is reusable');
  await assert.rejects((await f.adapter(f.second.id)).state(f.second.binding), { code: 'execution_admission_closed' });
  await assert.rejects(f.storage().store.enqueueOperation({ ...f.operation, id: randomUUID() }), { code: 'execution_admission_closed' });
  assert.equal(f.pending().length, 71);
  f.setObserve(async () => idle);
  let pages = 0;
  for (;;) {
    const page = await f.storage().execution.pendingPage({ groupId: 'group', frozenSetId: frozen!.frozenSetId!, limit: 8, byteLimit: 4096 });
    const native = page.entries.filter(entry => entry.id !== 'o:' + f.operation.id); if (!native.length) break;
    pages++;
    for (const entry of native) {
      const state = await (await f.adapter(f.first.id, { admissionId: entry.id })).state(f.first.binding);
      assert.equal(state.status, 'idle');
      await f.storage().execution.confirmTerminal({ admissionId: entry.id, bindingId: f.first.binding.id, operationId: null, proof: digest([entry.id, null, f.first.binding.id, state]) });
    }
  }
  assert.ok(pages >= 9);
  for (const id of ids) assert.equal((await f.storage().execution.admission(String(id)))!.kind, 'settled');
  assert.deepEqual(f.pending().map(row => row.id), ['o:' + f.operation.id]);
  assert.equal((await f.storage().store.getOperation(f.operation.id))!.status, 'queued');
});

test('atomic observation registration deduplicates concurrent callers and rejects identity changes', async t => {
  const f = await fixture(t);
  const request = { requestId: 'observe:' + randomUUID(), conversationId: f.first.id, workspaceId: 'workspace', bindingId: f.first.binding.id, wireDigest: digest('first wire') };
  const first = await f.storage().execution.registerObservation(request);
  const permits = await Promise.all(Array.from({ length: 40 }, (_, i) => f.storage().execution.registerObservation({ ...request, requestId: 'observe:' + randomUUID(), wireDigest: digest(i) })));
  assert.ok(permits.every(permit => permit.admissionId === first.admissionId)); assert.equal(f.pending().length, 2);
  await assert.rejects(f.storage().execution.registerObservation({ ...request, wireDigest: digest('changed') }), { code: 'execution_native_request_conflict' });
  await assert.rejects(f.storage().execution.registerObservation({ ...request, conversationId: f.second.id, bindingId: f.second.binding.id }), { code: 'execution_observation_identity_changed' });
  await assert.rejects(f.storage().execution.registerObservation({ ...request, bindingId: 'foreign' }), { code: 'execution_native_scope_mismatch' });
});

test('late pending-reconciler confirmation cannot settle a new observation admission', async t => {
  const f = await fixture(t); await (await f.adapter()).state(f.first.binding);
  const old = String(f.pending().find(row => row.source === 'native')!.id);
  f.setObserve(async () => idle);
  const result = await (await f.adapter(f.first.id, { admissionId: old })).state(f.first.binding);
  assert.equal(result.status, 'idle'); assert.equal((await f.storage().execution.admission(old))!.kind, 'settled');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.setObserve(async () => { await gate; return unknown; });
  const before = f.calls(), pending = (await f.adapter()).state(f.first.binding);
  while (f.calls() === before) await delay(1);
  const next = String(f.pending().find(row => row.source === 'native')!.id); assert.notEqual(next, old);
  try {
    await f.storage().execution.confirmTerminal({ admissionId: old, bindingId: f.first.binding.id, operationId: null, proof: digest([old, null, f.first.binding.id, result]) });
    assert.equal((await f.storage().execution.admission(next))!.kind, 'receipt-unknown');
  } finally { release(); await pending; }
});

test('lost observation receipt remains once across restart; bounded queues and shutdown release every slot', async t => {
  const f = await fixture(t);
  const request = () => ({ kind: 'observe' as const, requestId: 'observe:' + randomUUID(), conversationId: f.first.id, method: 'state' as const });
  const lost = request(); f.setObserve(async () => { throw new Error('synthetic transport outcome unknown'); });
  assert.equal((await f.host().dispatch(lost)).status, 'unknown'); const calls = f.calls();
  await f.restart(); assert.equal((await f.host().dispatch(lost)).status, 'unknown'); assert.equal(f.calls(), calls);
  f.setObserve(async () => idle); await f.host().dispatch(request());
  assert.deepEqual(f.pending().map(row => row.id), ['o:' + f.operation.id]);
  assert.equal(f.ledgerReader.prepare('SELECT status FROM execution_host_forwards WHERE request_id=?').get(lost.requestId)!.status, 'forwarding', 'fresh terminal proof does not erase an unknown once receipt');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.setObserve(async () => { await gate; return unknown; });
  const before = f.calls(), waiting = Array.from({ length: 32 }, () => f.host().dispatch(request()));
  const results = Promise.allSettled(waiting);
  while (f.calls() === before) await delay(1);
  await assert.rejects(f.host().dispatch(request()), { code: 'execution_gateway_busy' });
  const closing = f.host().close(); release(); await closing;
  const finished = await results; assert.equal(finished.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(finished.filter(result => result.status === 'rejected').length, 31);
  await f.restart(); f.setObserve(async () => unknown);
  for (let i = 0; i < 40; i++) assert.equal((await f.host().dispatch(request())).status, 'settled');
  assert.equal(f.pending().length, 2);
});

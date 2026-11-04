import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { serveExecutionGateway } from '../src/server/managed-harness-gateway.ts';
import { test, type TestContext } from 'node:test';
import { createExecutionHostLedger, type HostPermission } from '../src/server/execution-host-ledger.ts';
import { acquireExecutionHostOwnership, ExecutionHost, type ExecutionGatewayAuthority, type NativeInvocation, type ManagedNativeInvoker } from '../src/server/execution-host.ts';
import type { ContainerProof, ExecutionHostRuntime } from '../src/server/execution-host-docker.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const frozen = digest('synthetic frozen membership');
async function fixture(t: TestContext, capacity?: { quotaBytes: number; reserveBytes: number; minimumFreeBytes: number }) {
  const root = await mkdtemp(join(tmpdir(), 'zhongshu-execution-host-'));
  let owner = await acquireExecutionHostOwnership(0);
  const options = { directory: join(root, 'ledger'), groupId: 'synthetic-group', configurationDigest: digest('synthetic-configuration:' + owner.port), ...(capacity ? { capacity } : {}) };
  let ledger = createExecutionHostLedger(options); await ledger.ready;
  const generation = (await ledger.load()).state.generation;
  let physical: ContainerProof = { id: 'c'.repeat(64), groupId: options.groupId, generation, configurationDigest: options.configurationDigest, running: false, pid: 0, status: 'created' };
  let starts = 0; let stops = 0; let resolved = 0; let throwAfterStop = false; let drained = true; let forgedEpoch: number | undefined;
  const runtime: ExecutionHostRuntime = {
    async prepare() { return { ...physical }; }, async inspect() { return { ...physical }; },
    async start() { starts++; physical = { ...physical, running: true, pid: 123, status: 'running' }; return { ...physical }; },
    async quiesce() { stops++; physical = { ...physical, running: false, pid: 0, status: 'exited' }; if (throwAfterStop) { throwAfterStop = false; throw new Error('receipt lost after real stop'); } return { ...physical }; },
  };
  const invocations = new Map<string, NativeInvocation>(); const allowed = new Set<string>(); const sent: string[] = []; const bound: string[] = [];
  const authority: ExecutionGatewayAuthority = {
    async resolve(request) { resolved++; const key = request.kind === 'operation' || request.kind === 'plugin' ? request.operationId : request.kind === 'create' ? 'create:' + request.conversationId : request.requestId;
      const invocation = invocations.get(key); if (!invocation) throw new Error('missing trusted business record'); return invocation;
    },
    async authorize(invocation, wireDigest): Promise<HostPermission> {
      if (!allowed.has(invocation.requestId)) throw new Error('not in durable admitted set');
      const row = await ledger.load();
      return { requestId: invocation.requestId, admissionId: 'admission:' + invocation.requestId, contentDigest: digest('immutable business payload'), wireDigest,
        purpose: invocation.method === 'stop' ? 'stop' : 'execute', groups: [{ groupId: row.state.groupId, generation: row.state.generation, epoch: forgedEpoch ?? row.state.epoch,
          ...(row.state.frozenSetId ? { frozenSetId: row.state.frozenSetId } : {}) }] };
    },
    async onBound(_invocation, binding) { bound.push(binding.id); }, async drained() { return drained; },
  };
  let invoke: ManagedNativeInvoker['invoke'] = async invocation => { sent.push(invocation.requestId); return { outcome: 'accepted', runId: 'synthetic-run' }; };
  const native: ManagedNativeInvoker = { async ready() {}, invoke: (...args) => invoke(...args) };
  let host = new ExecutionHost(ledger, runtime, native, authority, owner); await host.bootstrap();
  function operation() {
    const operationId = randomUUID(); const conversationId = randomUUID();
    invocations.set(operationId, { requestId: operationId, operationId, conversationId, workspaceId: 'synthetic-workspace', harnessId: 'dsh', method: 'submit', args: [{ id: 'binding', cwd: '/synthetic' }, { id: operationId, text: 'synthetic input' }] }); allowed.add(operationId); return operationId;
  }
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { root, options, generation, sent, bound, invocations, allowed, operation,
    get resolved() { return resolved; }, get host() { return host; }, get ledger() { return ledger; }, get starts() { return starts; }, get stops() { return stops; }, get owner() { return owner; },
    setInvoke(value: ManagedNativeInvoker['invoke']) { invoke = value; }, setDrained(value: boolean) { drained = value; }, forgeEpoch(value: number | undefined) { forgedEpoch = value; }, loseStopReceipt() { throwAfterStop = true; },
    async restart() { const port = owner.port; await host.close(); owner = await acquireExecutionHostOwnership(port); ledger = createExecutionHostLedger(options); await ledger.ready;
      host = new ExecutionHost(ledger, runtime, native, authority, owner); await host.bootstrap(); },
  };
}

test('gateway durably consumes an execution once and never resends an unknown result after restart', async t => {
  const f = await fixture(t); const operationId = f.operation();
  f.setInvoke(async invocation => { f.sent.push(invocation.requestId); throw new Error('native receipt lost after send'); });
  assert.deepEqual(await f.host.dispatch({ kind: 'operation', operationId }), { status: 'unknown' });
  assert.deepEqual(await f.host.dispatch({ kind: 'operation', operationId }), { status: 'unknown' });
  await f.restart(); assert.equal(f.starts, 1, 'gateway restart must not automatically start/restart the native Host');
  assert.deepEqual(await f.host.dispatch({ kind: 'operation', operationId }), { status: 'unknown' });
  assert.deepEqual(f.sent, [operationId]);
  f.invocations.get(operationId)!.args[1] = { id: operationId, text: 'changed payload' };
  await assert.rejects(f.host.dispatch({ kind: 'operation', operationId }), { code: 'execution_forward_identity_changed' });
  assert.deepEqual(f.sent, [operationId]);
});

test('fence admits only frozen work at the new epoch; quiescence persists through controller restart and stable replay', async t => {
  const f = await fixture(t); const operationId = f.operation();
  const fence = { requestId: 'fence-once', expected: { generation: f.generation, epoch: 0 }, frozenSetId: frozen };
  const fenced = await f.host.controller.fence(fence); assert.equal(fenced.status, 'known'); if (fenced.status !== 'known') throw new Error('expected_state');
  assert.equal(fenced.state.admission, 'drain'); assert.equal(fenced.state.epoch, 1);
  assert.deepEqual(await f.host.controller.fence(fence), fenced);
  f.forgeEpoch(0); await assert.rejects(f.host.dispatch({ kind: 'operation', operationId }), { code: 'execution_host_epoch_changed' });
  f.forgeEpoch(undefined);
  const newer = f.operation(); f.allowed.delete(newer);
  await assert.rejects(f.host.dispatch({ kind: 'operation', operationId: newer }));
  assert.equal((await f.host.dispatch({ kind: 'operation', operationId })).status, 'settled');
  const quiesce = { requestId: 'quiesce-once', expected: { generation: f.generation, epoch: 1 }, frozenSetId: frozen };
  f.setDrained(false); assert.equal((await f.host.controller.quiesce(quiesce)).status, 'unknown'); assert.equal(f.stops, 0);
  f.setDrained(true); f.loseStopReceipt(); assert.equal((await f.host.controller.quiesce(quiesce)).status, 'unknown');
  assert.equal((await f.host.controller.inspect('inspect-unknown')).status, 'unknown');
  await f.restart(); assert.equal(f.starts, 1, 'stopped writers must remain stopped across application/controller restart');
  const closed = await f.host.controller.quiesce(quiesce); assert.equal(closed.status, 'known'); if (closed.status !== 'known') throw new Error('expected_state');
  assert.equal(closed.state.epoch, 2); assert.equal(closed.state.writers, 'quiescent');
  assert.equal((await f.host.controller.resume({ requestId: 'old-resume', expected: { generation: f.generation, epoch: 0 } })).status, 'unknown');
  const resumed = await f.host.controller.resume({ requestId: 'resume-once', expected: { generation: f.generation, epoch: 2 } });
  assert.equal(resumed.status, 'known'); if (resumed.status === 'known') { assert.equal(resumed.state.epoch, 3); assert.equal(resumed.state.frozenSetId, undefined); }
  assert.equal(f.starts, 2); assert.deepEqual(f.sent, [operationId]);
});

test('create persists its early binding before native configuration and retains it on an unknown result', async t => {
  const f = await fixture(t); const conversationId = randomUUID(); const requestId = 'create:' + conversationId;
  f.allowed.add(requestId); f.invocations.set(requestId, { requestId, conversationId, workspaceId: 'synthetic-workspace', harnessId: 'dsh', method: 'create', args: [{ cwd: '/synthetic', configuration: { modelId: 'model', permissionId: 'safe' } }] });
  const binding = { id: 'durable-native-binding', cwd: '/synthetic', configuration: { modelId: 'model', permissionId: 'safe' }, details: {} };
  f.setInvoke(async (invocation, onBound) => { f.sent.push(invocation.requestId); await onBound(binding); assert.deepEqual(f.bound, [binding.id]); throw new Error('configuration receipt lost'); });
  assert.deepEqual(await f.host.dispatch({ kind: 'create', conversationId }), { status: 'unknown', binding });
  await f.restart(); assert.deepEqual(await f.host.dispatch({ kind: 'create', conversationId }), { status: 'unknown', binding });
  assert.deepEqual(f.sent, [requestId]);
});

test('kernel ownership excludes a second controller and the journal rejects configuration replacement', async t => {
  const f = await fixture(t);
  await assert.rejects(acquireExecutionHostOwnership(f.owner.port), { code: 'EADDRINUSE' });
  const changed = createExecutionHostLedger({ ...f.options, configurationDigest: digest('different Docker mounts or owner port') });
  await assert.rejects(changed.ready, { code: 'execution_ledger_unavailable' }); await changed.close();
  assert.equal((await f.host.controller.inspect('still-owned')).status, 'known');
});

 test('controller journal capacity preserves prior once receipts and leaves reserve for fencing', async t => {
  const f = await fixture(t, { quotaBytes: 1024 ** 2, reserveBytes: 256 * 1024, minimumFreeBytes: 0 });
  f.setInvoke(async invocation => { f.sent.push(invocation.requestId); return { outcome: 'accepted', evidence: 'x'.repeat(48 * 1024) }; });
  const first = f.operation(); assert.equal((await f.host.dispatch({ kind: 'operation', operationId: first })).status, 'settled');
  let rejected = false;
  for (let index = 0; index < 100; index++) {
    try { await f.host.dispatch({ kind: 'operation', operationId: f.operation() }); } catch { rejected = true; break; }
  }
  assert.equal(rejected, true); const calls = f.sent.length;
  assert.equal((await f.host.dispatch({ kind: 'operation', operationId: first })).status, 'settled'); assert.equal(f.sent.length, calls);
  const fenced = await f.host.controller.fence({ requestId: 'capacity-fence', expected: { generation: f.generation, epoch: 0 }, frozenSetId: frozen });
  assert.equal(fenced.status, 'known');
});

test('private gateway authorizes opaque IDs and rejects caller native payloads and foreign credentials', async t => {
  const f = await fixture(t); const socketPath = join(f.root, 'gateway.sock'); const token = randomBytes(32).toString('base64url');
  const server = await serveExecutionGateway(f.host, { socketPath, token }); t.after(() => server.close());
  const post = (path: string, value: unknown, bearer = token) => new Promise<{status:number;value:unknown}>((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(value));
    const call = request({ socketPath, path, method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json', 'content-length': body.length } }, response => {
      const chunks: Buffer[] = []; response.on('data', data => chunks.push(data)); response.on('end', () => resolve({ status: response.statusCode!, value: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null }));
    }); call.on('error', reject); call.end(body);
  });
  const operationId = f.operation();
  assert.equal((await post('/execute', { kind: 'operation', operationId }, randomBytes(32).toString('base64url'))).status, 403);
  assert.equal((await post('/execute', { kind: 'operation', operationId, binding: { cwd: '/elsewhere' }, text: 'replacement command' })).status, 409);
  assert.equal(f.sent.length, 0);
  assert.equal((await post('/execute', { kind: 'operation', operationId })).status, 200);
  assert.equal((await post('/execute', { kind: 'operation', operationId })).status, 200); assert.deepEqual(f.sent, [operationId]);
  const capacity = await post('/control', { action: 'capacity', requestId: 'capacity-probe' }); assert.equal(capacity.status, 200);
  assert.equal(JSON.stringify(capacity.value).includes(f.root), false);
});

test('large operation payloads are resolved only when one of two bounded slots is free', async t => {
  const f = await fixture(t); let release!: () => void; let entered!: () => void; let active = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; }); const atTwo = new Promise<void>(resolve => { entered = resolve; });
  t.after(release);
  f.setInvoke(async () => { if (++active === 2) entered(); await blocked; return { outcome: 'accepted' }; });
  const jobs = Array.from({ length: 8 }, () => f.host.dispatch({ kind: 'operation', operationId: f.operation() }));
  await atTwo; assert.equal(f.resolved, 2, 'waiting IDs cannot allocate their image payloads');
  release(); const results = await Promise.all(jobs); assert(results.every(result => result.status === 'settled')); assert.equal(f.resolved, 8);
});

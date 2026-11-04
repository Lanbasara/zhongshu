import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HarnessAdapter } from '../src/harness/types.ts';
import { createStorageClient } from '../src/server/storage-client.ts';
import { WorkspaceRegistry } from '../src/server/workspace-registry.ts';
import { createExecutionHostLedger } from '../src/server/execution-host-ledger.ts';
import { acquireExecutionHostOwnership, ExecutionHost } from '../src/server/execution-host.ts';
import { createManagedHarnessAuthority } from '../src/server/managed-harness-authority.ts';
import { ManagedHarnessRpc, serveManagedHarness } from '../src/server/managed-harness-rpc.ts';
import { managedHarnessPlugins } from '../src/server/managed-harness-plugins.ts';
import type { ContainerProof } from '../src/server/execution-host-docker.ts';

function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

test('real worker, native RPC and Host ledger preserve plugin unknown identity and drain an already admitted source without resending', { timeout: 10_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zh-plugin-gateway-')));
  const storage = createStorageClient({ dataDirectory: join(root, 'product') }); await storage.ready;
  const registry = new WorkspaceRegistry(storage.workspaces, [], []); await registry.ready;
  const entered = latch(); const release = latch(); const sourceEntered = latch(); const sourceRelease = latch();
  let changed = 0, recovered = 0, sourceChanges = 0, sourceRecovered = 0, running = true, loseReply = true;
  const unusable = async (): Promise<never> => { throw new Error('conversation methods are not plugin identities'); };
  const adapter: HarnessAdapter = { id: 'codex', catalog: async () => ({ id: 'codex', available: true, models: [], permissions: [] }),
    create: unusable, state: unusable, history: unusable, submit: unusable, reconcile: unusable, stop: unusable, watch: unusable, close: async () => {} };
  const rpcOptions = { socketPath: join(root, 'native.sock'), token: randomBytes(32).toString('base64url') };
  const server = await serveManagedHarness(adapter, rpcOptions, {
    list: async () => [], sources: async () => [],
    async change(command) { assert.equal(command.pluginId, 'synthetic/original'); changed++; entered.resolve(); await release.promise; return 'applied'; },
    async recover() { recovered++; return 'applied'; },
    async updateSource() { sourceChanges++; sourceEntered.resolve(); await sourceRelease.promise; },
    async recoverSource() { sourceRecovered++; return 'applied'; },
  });
  const client = new ManagedHarnessRpc(rpcOptions);
  const ownership = await acquireExecutionHostOwnership(0); const configurationDigest = hash('synthetic native plugin ' + ownership.port);
  const ledger = createExecutionHostLedger({ directory: join(root, 'host'), groupId: 'group', configurationDigest }); await ledger.ready;
  const generation = (await ledger.load()).state.generation;
  const physical = (): ContainerProof => ({ id: 'c'.repeat(64), groupId: 'group', generation, configurationDigest, running, pid: running ? 123 : 0, status: running ? 'running' : 'exited' });
  const host = new ExecutionHost(ledger, { prepare: async () => physical(), inspect: async () => physical(), start: async () => { running = true; return physical(); }, quiesce: async () => { running = false; return physical(); } }, {
    ready: () => client.ready(), async invoke(invocation, onBound) {
      const result = await client.invoke(invocation, onBound);
      if (loseReply) { loseReply = false; throw new Error('synthetic reply loss after actual RPC completion'); }
      return result;
    },
  }, createManagedHarnessAuthority({ groupId: 'group', harnessId: 'codex', store: storage.store, execution: storage.execution, registry }), ownership);
  t.after(async () => { release.resolve(); sourceRelease.resolve(); await host.close(); await client.close(); await server.close(); await storage.close(); await rm(root, { recursive: true, force: true }); });
  await host.bootstrap();
  const inspected = await host.controller.inspect('initial'); assert.equal(inspected.status, 'known'); if (inspected.status !== 'known') return;
  await storage.execution.registerGroup(inspected.state); await storage.execution.registerHostGroup({ groupId: 'group', harnessId: 'codex' });
  const baseline = await storage.execution.beginBaseline('group');
  for (const source of ['operations', 'queues'] as const) await storage.execution.seedLegacyAdmissions({ groupId: 'group', source, after: 0, limit: 64, byteLimit: 4096 });
  await storage.execution.commitBaselineBatch({ groupId: 'group', through: baseline.through, limit: 8, byteLimit: 4096, expectedRevision: (await storage.execution.load(['group']))[0]!.revision, observations: [], proof: hash('empty baseline') });
  const backend = managedHarnessPlugins({ harnessId: 'codex', host, client, store: storage.plugins, execution: storage.execution });
  const command = { id: randomUUID(), pluginId: 'synthetic/original', action: 'enable' as const };
  await storage.plugins.claim('codex', command);
  const changing = backend.change(command); await entered.promise;
  assert.equal(await backend.recover(command), 'unknown'); assert.equal(recovered, 0, 'native active mutation prevents a premature terminal catalog inference');
  release.resolve(); assert.equal(await changing, 'unknown');
  assert.equal(await backend.change({ ...command, pluginId: 'caller-cannot-replace-original' }), 'unknown'); assert.equal(changed, 1);
  assert.equal((await storage.execution.unresolvedPage({ groupId: 'group', limit: 8 })).entries.length, 1);
  assert.equal(await backend.recover(command), 'applied'); assert.equal(recovered, 1);
  assert.equal((await storage.plugins.find(command.id))!.status, 'applied');
  assert.equal((await storage.execution.unresolvedPage({ groupId: 'group', limit: 8 })).entries.length, 0);

  const requestId = randomUUID(); const source = { action: 'add' as const, source: 'https://github.com/synthetic/source' };
  await storage.plugins.claimSource('codex', requestId, source);
  const [frozen] = await storage.execution.freezeAdmissions({ windowId: 'plugins-frozen', groups: (await storage.execution.load(['group'])).map(row => ({ groupId: row.groupId, revision: row.revision })) });
  const fenced = await host.controller.fence({ requestId: 'plugin-fence', expected: { generation, epoch: frozen!.controller.epoch }, frozenSetId: frozen!.frozenSetId! });
  assert.equal(fenced.status, 'known'); if (fenced.status !== 'known') return;
  await storage.execution.save('group', frozen!.revision, { ...frozen!, revision: frozen!.revision + 1, stage: 'drain', controller: fenced.state });
  const sourceChange = backend.updateSource!(source, requestId); await sourceEntered.promise;
  assert.equal(await backend.recoverSource!(source, requestId), 'unknown'); assert.equal(sourceRecovered, 0);
  sourceRelease.resolve(); await sourceChange;
  await storage.plugins.settleSource(requestId, 'applied');
  assert.equal(sourceChanges, 1); await backend.updateSource!(source, requestId); assert.equal(sourceChanges, 1, 'same source ID reads its durable Host receipt');
  await assert.rejects(storage.plugins.claim('codex', { ...command, id: randomUUID() }), { code: 'execution_admission_closed' });
  await assert.rejects(storage.plugins.claimSource('codex', randomUUID(), source), { code: 'execution_admission_closed' });
  assert.equal((await storage.execution.pendingPage({ groupId: 'group', frozenSetId: frozen!.frozenSetId!, limit: 8, byteLimit: 4096 })).entries.length, 0);
  const closed = await host.controller.quiesce({ requestId: 'plugin-quiesce', expected: { generation, epoch: fenced.state.epoch }, frozenSetId: frozen!.frozenSetId! });
  assert.equal(closed.status, 'known'); assert.equal(running, false);
  t.diagnostic('SQLite workers, private Unix RPC and Host journals are real; native plugin methods and container runtime are explicit substitutes.');
});

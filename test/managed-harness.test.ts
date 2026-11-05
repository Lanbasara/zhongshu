import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { Binding, HarnessAdapter, NativeState } from '../src/harness/types.ts';
import { createStorageClient } from '../src/server/storage-client.ts';
import { WorkspaceRegistry } from '../src/server/workspace-registry.ts';
import { createExecutionHostLedger } from '../src/server/execution-host-ledger.ts';
import { acquireExecutionHostOwnership, ExecutionHost } from '../src/server/execution-host.ts';
import { createManagedHarnessAuthority } from '../src/server/managed-harness-authority.ts';
import { ManagedHarnessRpc, serveManagedHarness } from '../src/server/managed-harness-rpc.ts';
import { createManagedHarnessAdapter, managedHarnessReadAdapter } from '../src/server/managed-harness-adapter.ts';
import { ManagedWorkspaceExecution } from '../src/server/execution-workspaces.ts';
import { Workbench } from '../src/server/workbench.ts';
import { WorkspaceFileWriter } from '../src/server/workspace-writer.ts';
import type { ContainerProof } from '../src/server/execution-host-docker.ts';
import { dockerHostDigest } from '../src/server/execution-host-docker.ts';
import { managedHostConfigurationSchema, startManagedHarnesses } from '../src/server/managed-harness-config.ts';
import type { PluginBackend } from '../src/server/plugin-backend.ts';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function until(action: () => Promise<boolean>) { const end = Date.now() + 8000; while (!await action()) { if (Date.now() > end) throw new Error('condition timeout'); await delay(5); } }

test('reopening an initialized Host with plugin management offline preserves archive access and closed execution admission', { skip: process.platform !== 'linux' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zh-offline-')));
  const workspace = join(root, 'workspace'), writer = join(root, 'writer'), nativeData = join(root, 'native');
  for (const directory of [workspace, writer, nativeData]) await mkdir(directory, { mode: 0o700 });
  const allocator = createServer(); await new Promise<void>(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const address = allocator.address(); assert.ok(address && typeof address === 'object');
  const ownershipPort = address.port; await new Promise<void>((resolve, reject) => allocator.close(error => error ? reject(error) : resolve()));
  const nativeToken = join(root, 'native-token'), gatewayToken = join(root, 'gateway-token');
  await writeFile(nativeToken, randomBytes(32).toString('base64url'), { mode: 0o600 });
  await writeFile(gatewayToken, randomBytes(32).toString('base64url'), { mode: 0o600 });
  const config = managedHostConfigurationSchema.parse({ groupId: 'offline', harnessId: 'codex', workspaceIds: ['synthetic'],
    ledgerDirectory: join(root, 'ledger'), pluginManagement: true,
    native: { socketPath: join(root, 'n.sock'), tokenFile: nativeToken }, gateway: { socketPath: join(root, 'g.sock'), tokenFile: gatewayToken },
    docker: { socketPath: join(root, 'absent-docker.sock'), ownershipPort, image: 'sha256:' + 'a'.repeat(64), argv: ['/synthetic'], user: '1000:1000',
      mounts: [{ source: nativeData, target: '/native', kind: 'data' }] } });
  // Durable evidence of an earlier successful bootstrap; the native and Docker
  // sockets are now absent. No process is launched by this isolated test.
  const configurationDigest = dockerHostDigest(config.docker, writer, 'codex-bwrap-v1');
  const ledger = createExecutionHostLedger({ directory: config.ledgerDirectory, groupId: config.groupId, configurationDigest });
  await ledger.ready;
  const generation = (await ledger.load()).state.generation;
  const proof = { id: 'b'.repeat(64), groupId: config.groupId, generation, configurationDigest, running: true, pid: 123, status: 'running' };
  await ledger.attachContainer(proof); await ledger.initialize(proof); await ledger.close();
  const storage = createStorageClient({ dataDirectory: join(root, 'product') }); await storage.ready;
  const workspaces = [{ id: 'synthetic', label: 'Synthetic', directory: workspace, managedWrites: true }];
  const registry = new WorkspaceRegistry(storage.workspaces, workspaces, []); await registry.ready;
  const id = randomUUID(), configuration = { modelId: 'synthetic', permissionId: 'workspace' };
  await storage.store.createConversation({ id, workspaceId: 'synthetic', harnessId: 'codex', cwd: workspace, configuration });
  await storage.store.saveBinding(id, { id: 'offline-binding', cwd: workspace, configuration, details: {} });
  await storage.store.setConversationState(id, { readiness: 'ready', state: { status: 'idle', configurationVerified: true, pendingInputs: 0 } });
  await storage.store.mergeHistory(id, [{ id: 'archived', kind: 'assistant', text: 'durable synthetic archive', status: 'completed' }]);
  const adapters = new Map<'codex' | 'dsh', HarnessAdapter>();
  const plugins: Partial<Record<'codex' | 'dsh', PluginBackend>> = {};
  let managed: Awaited<ReturnType<typeof startManagedHarnesses>> | undefined, service: Workbench | undefined;
  t.after(async () => { await service?.close(); await managed?.close(); await storage.close(); await rm(root, { recursive: true, force: true }); });
  managed = await startManagedHarnesses({ configurations: [config], storage, registry, adapters, plugins, dataDirectory: join(root, 'product'), workspaceWriterDirectory: writer });
  service = new Workbench(storage.store, workspaces, adapters, registry, undefined, managed);
  await service.start();
  const snapshot = await service.snapshot(id);
  assert.equal(snapshot.history.items.find(item => item.id === 'archived')?.text, 'durable synthetic archive');
  assert.equal(snapshot.conversation.readiness, 'blocked');
  assert.equal(snapshot.conversation.state.configurationVerified, false);
  assert.equal(snapshot.conversation.error, 'workspace_execution_blocked');
  assert.equal((await storage.store.getConversation(id))!.state.configurationVerified, true, 'the read projection does not rewrite persistent historical state');
  assert.equal((await service.workspaceEditStatus('synthetic')).editable, false);
  const rejectedId = randomUUID();
  await assert.rejects(service.enqueue({ id: rejectedId, conversationId: id, type: 'message', payload: { text: 'must not execute' } }), { code: 'workspace_execution_blocked' });
  assert.equal(await storage.store.getOperation(rejectedId), null);
  await assert.rejects(plugins.codex!.catalog!());
  assert.equal(typeof adapters.get('codex')?.readBodyChunk, 'function');
});

test('trusted worker admission, Unix native RPC and durable Host gateway drain before file editing and resume the same binding', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zh-managed-'))); const workspace = join(root, 'workspace'); await mkdir(workspace); await writeFile(join(workspace, 'note.md'), 'original');
  const storage = createStorageClient({ dataDirectory: join(root, 'product') }); await storage.ready;
  const workspaces = [{ id: 'synthetic', label: 'Synthetic', directory: workspace, managedWrites: true }];
  const registry = new WorkspaceRegistry(storage.workspaces, workspaces, []); await registry.ready;
  const id = randomUUID(); const configuration = { modelId: 'synthetic', permissionId: 'workspace' };
  await storage.store.createConversation({ id, workspaceId: 'synthetic', harnessId: 'codex', cwd: workspace, configuration });
  const binding: Binding = { id: 'native-' + id, cwd: workspace, configuration, details: {} }; await storage.store.saveBinding(id, binding);
  let state: NativeState = { status: 'idle', configurationVerified: true, pendingInputs: 0 }; await storage.store.setConversationState(id, { readiness: 'ready', state });
  let submitted = 0, activated = 0, running = true, creates = 0;
  const native: HarnessAdapter = {
    id: 'codex', async catalog() { return { id: 'codex', available: true, models: [{ id: 'synthetic', label: 'Synthetic' }], permissions: [{ id: 'workspace', label: 'Workspace', description: '' }] }; },
    async create(input, onBound) { creates++; const next = { ...binding, id: 'new-' + creates, cwd: input.cwd, configuration: input.configuration }; await onBound(next); return next; },
    async state() { assert(running); activated++; return state; }, async history() { return { items: [], olderCursor: null }; },
    async submit(_binding, operation) { assert(running); submitted++; state = { status: 'running', configurationVerified: true, pendingInputs: 0, runId: 'run-' + operation.id }; return { outcome: 'accepted', runId: state.runId }; },
    async reconcile() { assert(running); activated++; return { outcome: 'accepted', runId: state.runId }; }, async stop() { return { outcome: 'accepted' }; },
    async watch() { assert(running); activated++; return () => {}; }, async close() {},
  };
  const rpcOptions = { socketPath: join(root, 'n.sock'), token: randomBytes(32).toString('base64url') };
  const server = await serveManagedHarness(native, rpcOptions); const client = new ManagedHarnessRpc(rpcOptions);
  const ownership = await acquireExecutionHostOwnership(0); const configurationDigest = hash('isolated test ' + ownership.port);
  const ledger = createExecutionHostLedger({ directory: join(root, 'controller'), groupId: 'group', configurationDigest }); await ledger.ready;
  const generation = (await ledger.load()).state.generation;
  const physical = (): ContainerProof => ({ id: 'a'.repeat(64), groupId: 'group', generation, configurationDigest, running, pid: running ? 123 : 0, status: running ? 'running' : 'exited' });
  const host = new ExecutionHost(ledger, { async prepare() { return physical(); }, async inspect() { return physical(); }, async start() { running = true; return physical(); }, async quiesce() { running = false; return physical(); } }, client,
    createManagedHarnessAuthority({ groupId: 'group', harnessId: 'codex', store: storage.store, execution: storage.execution, registry }), ownership);
  await host.bootstrap();
  const execution = new ManagedWorkspaceExecution({ port: storage.execution, workspaces: storage.workspaces, groups: [{ groupId: 'group', workspaceIds: ['synthetic'], workspaceRootIds: [], controller: host.controller }] });
  const service = new Workbench(storage.store, workspaces, new Map([['codex', await managedHarnessReadAdapter(client)]]), registry, undefined,
    { execution, recoverCreation: conversation => host.recoverCreation(conversation.id), writer: new WorkspaceFileWriter({ dataDirectory: join(root, 'writer') }), managedAdapter: (conversation, _raw, context) => createManagedHarnessAdapter(host, client, conversation, context) });
  t.after(async () => { await service.close(); await host.close(); await client.close(); await server.close(); await storage.close(); await rm(root, { recursive: true, force: true }); });
  await service.start(); await until(async () => execution.initialized);
  const operationId = randomUUID();
  await service.enqueue({ id: operationId, conversationId: id, type: 'message', payload: { text: 'only the trusted persisted input is sent' } });
  await until(async () => (await storage.store.getOperation(operationId))?.status === 'accepted'); assert.equal(submitted, 1);
  const paused = await service.changeWorkspaceMaintenance('synthetic', 'pause'); assert.equal(paused.editable, false); assert.equal(running, true);
  await assert.rejects(service.enqueue({ id: randomUUID(), conversationId: id, type: 'message', payload: { text: 'must not enter frozen set' } }));
  state = { ...state, status: 'idle', terminalRunId: state.runId, terminalStatus: 'completed' };
  await until(async () => (await service.workspaceEditStatus('synthetic')).editable); assert.equal(running, false);
  const activationCount = activated;
  const pausedSnapshot = await service.snapshot(id);
  assert.equal(pausedSnapshot.conversation.state.configurationVerified, false);
  assert.equal(pausedSnapshot.conversation.error, 'workspace_execution_blocked');
  const admittedReplay = await service.enqueue({ id: operationId, conversationId: id, type: 'message', payload: { text: 'only the trusted persisted input is sent' } });
  assert.equal(admittedReplay.status, 'accepted', 'a closed gate must still return the original durable receipt for an already admitted ID');
  assert.equal(submitted, 1);
  const file = await service.openWorkspaceFile('synthetic', 'note.md');
  await service.saveWorkspaceFile('synthetic', 'note.md', file.version, 'saved while whole host stopped', randomUUID());
  assert.equal(await readFile(join(workspace, 'note.md'), 'utf8'), 'saved while whole host stopped'); assert.equal(activated, activationCount);
  assert.equal((await service.changeWorkspaceMaintenance('synthetic', 'resume')).maintenance, 'online'); assert.equal(running, true);
  await service.reconcile(id);
  assert.equal((await service.snapshot(id)).conversation.state.configurationVerified, true);
  assert.equal((await storage.store.getConversation(id))?.binding?.id, binding.id); assert.equal(submitted, 1); assert.equal(creates, 0);
  const replay = await host.dispatch({ kind: 'operation', operationId }); assert.equal(replay.status, 'settled'); assert.equal(submitted, 1);
  const creationId = randomUUID(); const saveBinding = storage.store.saveBinding;
  storage.store.saveBinding = async () => { throw new Error('simulated unknown business commit'); };
  await service.create({ id: creationId, workspaceId: 'synthetic', harnessId: 'codex', configuration });
  await until(async () => (await storage.store.getConversation(creationId))?.readiness === 'blocked');
  assert.equal(creates, 1); assert.equal((await storage.store.getConversation(creationId))?.binding, null);
  storage.store.saveBinding = saveBinding;
  await service.reconcile(creationId);
  assert.equal((await storage.store.getConversation(creationId))?.binding?.id, 'new-1');
  assert.equal(creates, 1, 'binding recovery must never call native create again');
});

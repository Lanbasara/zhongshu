import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function until(action: () => Promise<boolean>) { const end = Date.now() + 8000; while (!await action()) { if (Date.now() > end) throw new Error('condition timeout'); await delay(5); } }

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
  const file = await service.openWorkspaceFile('synthetic', 'note.md');
  await service.saveWorkspaceFile('synthetic', 'note.md', file.version, 'saved while whole host stopped', randomUUID());
  assert.equal(await readFile(join(workspace, 'note.md'), 'utf8'), 'saved while whole host stopped'); assert.equal(activated, activationCount);
  assert.equal((await service.changeWorkspaceMaintenance('synthetic', 'resume')).maintenance, 'online'); assert.equal(running, true);
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

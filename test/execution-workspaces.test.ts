import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { HarnessAdapter, NativeState, NativeChange } from '../src/harness/types.ts';
import type { ExecutionController, ExecutionControllerMutation, ExecutionGroupState } from '../src/server/execution-controller.ts';
import { ManagedWorkspaceExecution } from '../src/server/execution-workspaces.ts';
import { createStorageClient, type StorageClient } from '../src/server/storage-client.ts';
import { WorkspaceRegistry } from '../src/server/workspace-registry.ts';
import { Workbench, type ManagedAdapterContext } from '../src/server/workbench.ts';
import { WorkspaceFileWriter } from '../src/server/workspace-writer.ts';
import { pausedWriter } from './support/workspace-writer-fixture.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function until(action: () => Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!await action()) { if (Date.now() >= end) throw new Error('execution fixture timed out'); await delay(5); }
}

/** Real filesystem, Workbench, registry and storage worker; explicitly synthetic
 * native/controller endpoints. These tests do not prove OS containment. */
async function fixture(t: TestContext, count: number) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'zhongshu-managed-workbench-')));
  const workspaceDirectory = join(directory, 'workspace'); await mkdir(workspaceDirectory); await writeFile(join(workspaceDirectory, 'note.md'), 'original');
  const dataDirectory = join(directory, 'data'); const workspaces = [{ id: 'workspace', label: 'Workspace', directory: workspaceDirectory, managedWrites: true }];
  const owned: { client: StorageClient; workbench?: Workbench }[] = [];
  t.after(async () => { for (const value of owned.reverse()) { await value.workbench?.close(); await value.client.close(); } await rm(directory, { recursive: true, force: true }); });
  let stateReads = 0; let watches = 0; let submits = 0; let stops = 0; let keepRunning = false;
  const states = new Map<string, NativeState>();
  const listeners = new Set<(change: NativeChange) => void>();
  let controllerState: ExecutionGroupState = { groupId: 'host', generation: 'synthetic-durable-generation', epoch: 0, admission: 'open', writers: 'running', durable: true };
  const receipts = new Map<string, { signature: string; state: ExecutionGroupState }>();
  async function mutation(action: 'fence' | 'quiesce' | 'resume', input: ExecutionControllerMutation) {
    const signature = digest([action, input]); const old = receipts.get(input.requestId);
    if (old) return old.signature === signature ? { status: 'known' as const, state: old.state } : { status: 'unknown' as const, reason: 'controller_unknown' as const };
    if (input.expected.generation !== controllerState.generation || input.expected.epoch !== controllerState.epoch ||
      action === 'quiesce' && [...states.values()].some(state => ['running', 'waiting'].includes(state.status))) return { status: 'unknown' as const, reason: 'controller_unknown' as const };
    controllerState = { ...controllerState, epoch: controllerState.epoch + 1, admission: action === 'fence' ? 'drain' : action === 'quiesce' ? 'closed' : 'open',
      writers: action === 'quiesce' ? 'quiescent' : 'running', ...(action === 'resume' ? { frozenSetId: undefined } : { frozenSetId: input.frozenSetId }) };
    receipts.set(input.requestId, { signature, state: controllerState }); return { status: 'known' as const, state: controllerState };
  }
  const controller: ExecutionController = { inspect: async () => ({ status: 'known', state: controllerState }), fence: input => mutation('fence', input), quiesce: input => mutation('quiesce', input), resume: input => mutation('resume', input) };
  const raw: HarnessAdapter = {
    id: 'codex', catalog: async () => ({ id: 'codex', available: true, models: [{ id: 'model', label: 'Model' }], permissions: [{ id: 'workspace', label: 'Workspace', description: '' }] }),
    create: async () => { throw new Error('this fixture seeds pre-upgrade bindings'); },
    state: async binding => { stateReads++; if (controllerState.admission === 'closed') throw new Error('synthetic host is stopped'); return states.get(binding.id)!; },
    history: async () => ({ items: [], olderCursor: null }),
    submit: async (binding, input) => { submits++; const runId = 'run-' + input.id; states.set(binding.id, { status: keepRunning ? 'running' : 'idle', runId, terminalRunId: keepRunning ? undefined : runId, terminalStatus: keepRunning ? undefined : 'completed', pendingInputs: 0, configurationVerified: true }); return { outcome: 'accepted', runId }; },
    reconcile: async (binding, operationId) => { const state = states.get(binding.id)!; return state.runId === 'run-' + operationId ? { outcome: 'accepted', runId: state.runId } : { outcome: 'unknown', reason: 'synthetic-no-receipt' }; },
    stop: async () => { stops++; return { outcome: 'unknown', reason: 'explicit-stop-not-used' }; },
    watch: async (_binding, listener) => { watches++; listeners.add(listener); return () => { listeners.delete(listener); }; }, close: async () => {},
  };
  const seed = createStorageClient({ dataDirectory }); owned.push({ client: seed }); await seed.ready;
  const registry = new WorkspaceRegistry(seed.workspaces, workspaces, []); await registry.ready;
  const conversationIds: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = randomUUID(); conversationIds.push(id); const configuration = { modelId: 'model', permissionId: 'workspace' };
    await seed.store.createConversation({ id, harnessId: 'codex', workspaceId: 'workspace', cwd: workspaceDirectory, configuration });
    const bindingId = 'native-' + id;
    await seed.store.saveBinding(id, { id: bindingId, cwd: workspaceDirectory, configuration, details: {} });
    states.set(bindingId, { status: 'idle', pendingInputs: 0, configurationVerified: true });
    await seed.store.setConversationState(id, { readiness: 'ready', state: states.get(bindingId)! });
  }
  await seed.close();
  async function open(waitForInitialization = true) {
    const client = createStorageClient({ dataDirectory }); await client.ready;
    const registry = new WorkspaceRegistry(client.workspaces, workspaces, []); await registry.ready;
    const execution = new ManagedWorkspaceExecution({ port: client.execution, workspaces: client.workspaces, groups: [{ groupId: 'host', workspaceIds: ['workspace'], workspaceRootIds: [], controller }] });
    const wrapper = async (conversation: { id: string; workspaceId: string }, adapter: HarnessAdapter, context?: ManagedAdapterContext): Promise<HarnessAdapter> => ({ ...adapter,
      state: async (binding, target) => {
        const wireDigest = digest(['state', binding.id, target ?? null]);
        if (context?.baseline) await client.execution.registerBaselineObservation({ ...context.baseline, conversationId: conversation.id, wireDigest });
        else if (context?.admissionId) await client.execution.bindObservationRequest({ admissionId: context.admissionId, requestId: randomUUID(), wireDigest });
        else await client.execution.registerObservation({ requestId: randomUUID(), workspaceId: conversation.workspaceId, conversationId: conversation.id, bindingId: binding.id, wireDigest });
        return adapter.state(binding, target);
      },
      submit: async (binding, input) => { await client.execution.bindNativeRequest(input.id, digest(['submit', binding.id, input])); return adapter.submit(binding, input); },
    });
    const writer = new WorkspaceFileWriter({ dataDirectory: join(dataDirectory, 'workspace-writer') });
    const workbench = new Workbench(client.store, workspaces, new Map([['codex', raw]]), registry, undefined, { execution, managedAdapter: wrapper, writer });
    owned.push({ client, workbench }); await workbench.start();
    if (waitForInitialization) await until(async () => execution.initialized, 30_000);
    return { client, execution, workbench, writer };
  }
  return { open, controller, conversationIds, workspaceDirectory, writerDirectory: join(dataDirectory, 'workspace-writer'), controllerState: () => controllerState,
    disconnect: () => { for (const listener of listeners) listener({ type: 'unavailable', reason: 'managed_native_disconnected' }); },
    counts: () => ({ stateReads, watches, submits, stops }), runContinuously: () => { keepRunning = true; },
    finish: () => { keepRunning = false; for (const [id, state] of states) states.set(id, { ...state, status: 'idle', terminalRunId: state.runId, terminalStatus: state.runId ? 'completed' : undefined }); } };
}

test('file editing never stops the Host and accepts conditional saves while a task runs', async t => {
  const f = await fixture(t, 1); const instance = await f.open(); const id = f.conversationIds[0]!;
  f.runContinuously();
  const operation = randomUUID();
  await instance.workbench.enqueue({ id: operation, conversationId: id, type: 'message', payload: { text: 'keep working during editing' } });
  await until(async () => (await instance.client.store.getOperation(operation))?.status === 'accepted');
  const before = f.controllerState();
  const original = await instance.workbench.openWorkspaceFile('workspace', 'note.md');
  assert.equal((await instance.workbench.changeWorkspaceMaintenance('workspace', 'pause')).editable, true, 'old clients cannot stop a Host by requesting editing');
  const saved = await instance.workbench.saveWorkspaceFile('workspace', 'note.md', original.version, 'edited while running', randomUUID());
  assert.equal(saved.text, 'edited while running');
  assert.equal(await readFile(join(f.workspaceDirectory, 'note.md'), 'utf8'), saved.text);
  assert.deepEqual(f.controllerState(), before);
  assert.equal(f.counts().stops, 0);
  assert.equal((await instance.workbench.open(id)).conversation.state.status, 'running');
  await assert.rejects(instance.workbench.saveWorkspaceFile('workspace', 'note.md', original.version, 'stale draft', randomUUID()), { message: 'file_version_changed' });
  assert.equal(await readFile(join(f.workspaceDirectory, 'note.md'), 'utf8'), saved.text);
  f.finish();
});

test('online Host recovery is bounded per second and explicit recovery works before initialization after restart', async t => {
  const f = await fixture(t, 1); const first = await f.open();
  let unavailable = true; const calls: { requestId: string; explicit: boolean }[] = [];
  f.controller.recover = async request => {
    calls.push(request); if (request.explicit) unavailable = false;
    return unavailable ? { status: 'unknown', reason: 'execution_host_recovery_exhausted' } : { status: 'known', state: f.controllerState() };
  };
  // A scheduled initialization step may still be active when the synthetic
  // failure is installed. Observe the resulting gate, not that tick's promise.
  await until(async () => {
    await first.execution.step().catch(error => assert.equal(error.code, 'execution_host_recovery_exhausted'));
    return (await first.execution.status('workspace')).canRecover === true;
  });
  for (let index = 0; index < 10; index++) {
    await first.execution.step().catch(error => assert.equal(error.code, 'execution_host_recovery_exhausted'));
    assert.equal((await first.execution.status('workspace')).canRecover, true);
  }
  assert.equal(calls.length, 1); await assert.rejects(first.execution.assertAdmission('workspace'), { code: 'execution_admission_closed' });
  const failed = await first.execution.status('workspace'); assert.equal(failed.canRecover, true); assert.equal(failed.editable, false);
  await first.workbench.close(); await first.client.close();
  const second = await f.open(false);
  await until(async () => (await second.execution.status('workspace')).canRecover === true);
  assert.equal(second.execution.initialized, false, 'failed bootstrap inspect does not hide the recovery entry');
  assert.equal(calls.filter(call => call.explicit).length, 0);
  await second.workbench.changeWorkspaceMaintenance('workspace', 'resume');
  await until(async () => second.execution.initialized);
  assert.equal(calls.filter(call => call.explicit).length, 1);
  assert.equal(new Set(calls.map(call => call.requestId)).size, calls.length);
  assert.equal((await second.execution.status('workspace')).maintenance, 'online');
  await second.execution.assertAdmission('workspace');
});

test('persistent edit windows veto automatic and explicit crash recovery after application restart', async t => {
  const f = await fixture(t, 1); const first = await f.open();
  await first.execution.change('workspace', 'pause');
  const windowId = (await first.execution.status('workspace')).windowId;
  let recoveryCalls = 0; f.controller.recover = async () => { recoveryCalls++; return { status: 'known', state: f.controllerState() }; };
  await first.workbench.close(); await first.client.close();
  const second = await f.open();
  for (let index = 0; index < 10; index++) await second.execution.step();
  assert.equal(recoveryCalls, 0); const status = await second.execution.status('workspace');
  assert.equal(status.windowId, windowId); assert.equal(status.editable, false, 'legacy windows require explicit recovery before new saves'); assert.notEqual(status.canRecover, true);
  await second.workbench.changeWorkspaceMaintenance('workspace', 'resume');
  assert.equal((await second.execution.status('workspace')).maintenance, 'online', 'explicit legacy resume completes before routine online health checks');
});

for (const count of [40, 1000]) test(`${count} historical conversations initialize once; editing and saving need no historical observations`, { timeout: 60_000 }, async t => {
  const seedStarted = performance.now(); const f = await fixture(t, count); const seedMs = performance.now() - seedStarted;
  const baselineStarted = performance.now(); const instance = await f.open(); const baselineMs = performance.now() - baselineStarted;
  const counts = f.counts(); assert.equal(counts.stateReads, count); assert.equal(counts.watches, 0);
  const status = await instance.workbench.workspaceEditStatus('workspace'); assert.equal(status.editable, true); assert.equal(status.canPause, false);
  const started = performance.now();
  assert.equal((await instance.workbench.changeWorkspaceMaintenance('workspace', 'pause')).editable, true);
  const opened = await instance.workbench.openWorkspaceFile('workspace', 'note.md');
  const first = await instance.workbench.saveWorkspaceFile('workspace', 'note.md', opened.version, 'first save', randomUUID());
  const second = await instance.workbench.saveWorkspaceFile('workspace', 'note.md', first.version, 'second save', randomUUID());
  assert.equal(second.text, 'second save'); assert.equal(await readFile(join(f.workspaceDirectory, 'note.md'), 'utf8'), 'second save');
  assert.equal((await instance.workbench.workspaceEditStatus('workspace')).editable, true);
  assert.deepEqual(f.counts(), counts); assert.equal(f.controllerState().admission, 'open');
  t.diagnostic(JSON.stringify({ scenario: 'managed-edit-historical-bindings', actualConversations: count, seedMs, baselineMs, baselineStateReads: counts.stateReads, additionalStateReads: 0, watches: counts.watches, saves: 2, elapsedMs: performance.now() - started, native: 'synthetic', filesystemAndWorker: 'real' }));
});

test('an old exclusive edit window survives restart and must be explicitly resumed before online editing', async t => {
  const f = await fixture(t, 2); const first = await f.open();
  await first.execution.change('workspace', 'pause');
  const original = await first.workbench.openWorkspaceFile('workspace', 'note.md');
  const beforeRestart = f.counts(); await first.workbench.close(); await first.client.close();
  assert.equal(f.controllerState().admission, 'closed');
  const second = await f.open(); assert.equal((await second.workbench.workspaceEditStatus('workspace')).editable, false);
  assert.equal(f.counts().stateReads, beforeRestart.stateReads);
  await assert.rejects(second.workbench.saveWorkspaceFile('workspace', 'note.md', original.version, 'not yet', randomUUID()));
  assert.equal((await second.workbench.changeWorkspaceMaintenance('workspace', 'resume')).maintenance, 'online');
  const saved = await second.workbench.saveWorkspaceFile('workspace', 'note.md', original.version, 'saved after recovery', randomUUID());
  assert.equal(saved.text, 'saved after recovery');
  assert.equal(f.controllerState().admission, 'open');
});

test('invalid UTF-8 save payloads are rejected before acquiring a save or starting the writer', async t => {
  const f = await fixture(t, 1); const instance = await f.open();
  const original = await instance.workbench.openWorkspaceFile('workspace', 'note.md');
  const valid = '中'.repeat(87_381) + 'a';
  assert.equal(Buffer.byteLength(valid), 256 * 1024);
  const inputs = [
    { text: valid + 'x', code: 'file_too_large', statusCode: 413 },
    { text: 'embedded\0null', code: 'file_encoding_unsupported', statusCode: 415 },
    { text: 'lone\ud800surrogate', code: 'file_encoding_unsupported', statusCode: 415 },
  ];
  for (const input of inputs) {
    await assert.rejects(instance.workbench.saveWorkspaceFile('workspace', 'note.md', original.version, input.text, randomUUID()),
      { message: input.code, statusCode: input.statusCode });
    assert.equal((await instance.client.execution.load(['host']))[0]!.windowId, undefined);
    await assert.rejects(stat(f.writerDirectory), { code: 'ENOENT' });
    assert.equal(await readFile(join(f.workspaceDirectory, 'note.md'), 'utf8'), original.text);
  }
  assert.equal((await instance.workbench.changeWorkspaceMaintenance('workspace', 'pause')).editable, true);
  assert.equal((await stat(f.writerDirectory)).isDirectory(), true, 'editable requires the writer to be ready');
  assert.equal(f.controllerState().admission, 'open');
  const owner = await instance.writer.owner();
  for (const input of inputs) {
    await assert.rejects(instance.workbench.saveWorkspaceFile('workspace', 'note.md', original.version, input.text, randomUUID()),
      { message: input.code, statusCode: input.statusCode });
    assert.equal((await instance.client.execution.pendingConcurrentSaves({ limit: 16 })).entries.length, 0);
    assert.equal(await instance.writer.owner(), owner);
    assert.equal((await instance.workbench.workspaceEditStatus('workspace')).editable, true);
    assert.equal(await readFile(join(f.workspaceDirectory, 'note.md'), 'utf8'), original.text);
  }
  const before = f.counts();
  const saved = await instance.workbench.saveWorkspaceFile('workspace', 'note.md', original.version, valid, randomUUID());
  const persisted = await readFile(join(f.workspaceDirectory, 'note.md'));
  assert.equal(persisted.byteLength, 256 * 1024);
  assert.equal(createHash('sha256').update(persisted).digest('hex'), createHash('sha256').update(valid).digest('hex'));
  assert.equal((await instance.client.execution.pendingConcurrentSaves({ limit: 16 })).entries.length, 0);
  assert.equal((await instance.workbench.workspaceEditStatus('workspace')).editable, true);
  assert.equal(await instance.writer.owner(), owner, 'first save reuses the prewarmed writer');
  assert.deepEqual(f.counts(), before);
  const escaped = '\u0001'.repeat(256 * 1024);
  await instance.workbench.saveWorkspaceFile('workspace', 'note.md', saved.version, escaped, randomUUID());
  const escapedBytes = await readFile(join(f.workspaceDirectory, 'note.md'));
  assert.equal(escapedBytes.byteLength, 256 * 1024);
  assert.equal(createHash('sha256').update(escapedBytes).digest('hex'), createHash('sha256').update(escaped).digest('hex'));
  assert.equal((await instance.client.execution.pendingConcurrentSaves({ limit: 16 })).entries.length, 0);
  assert.equal((await instance.workbench.workspaceEditStatus('workspace')).editable, true);
  assert.equal(await instance.writer.owner(), owner);
  assert.deepEqual(f.counts(), before);
});

test('a legacy administrative freeze cannot overtake an online file save', async t => {
  const f = await fixture(t, 1); const instance = await f.open();
  const original = await instance.workbench.openWorkspaceFile('workspace', 'note.md');
  const actualWrite = instance.writer.write.bind(instance.writer);
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const gate = new Promise<void>(done => { release = done; });
  instance.writer.write = async input => { entered(); await gate; return actualWrite(input); };
  const save = instance.workbench.saveWorkspaceFile('workspace', 'note.md', original.version, 'save before administration', randomUUID());
  try {
    await started;
    const rows = await instance.client.execution.load(['host']);
    await assert.rejects(instance.client.execution.freezeAdmissions({ windowId: randomUUID(), groups: rows.map(({ groupId, revision }) => ({ groupId, revision })) }), { code: 'execution_save_unresolved' });
    assert.equal(f.controllerState().admission, 'open');
  } finally { release(); }
  await save;
});

test('Workbench automatically reconciles a killed online writer without stopping or restarting the Host', async t => {
  const f = await fixture(t, 1); const instance = await f.open();
  const oldWriter = await pausedWriter(t, f.writerDirectory, 'renamed');
  const unavailable = await instance.workbench.changeWorkspaceMaintenance('workspace', 'pause');
  assert.equal(unavailable.editable, false);
  assert.equal(unavailable.reason, 'file_writer_unavailable');
  assert.equal(f.controllerState().admission, 'open');
  const registration = (await instance.client.workspaces.get('workspace'))!;
  const document = await instance.workbench.openWorkspaceFile('workspace', 'note.md');
  const gates = await instance.client.execution.load(['host']);
  const admitted = await instance.client.execution.acquireSave({ mode: 'concurrent', saveId: randomUUID(), windowId: 'file-' + digest('workspace'), writerId: oldWriter.ownerId,
    write: { workspaceId: 'workspace', directoryIdentity: registration.identity, path: 'note.md', expectedVersion: document.version, contentDigest: createHash('sha256').update('recovered actual write').digest('hex') },
    groups: gates.map(({ groupId, revision }) => ({ groupId, revision })) });
  assert.equal(admitted.created, true); if (!admitted.created) return;
  await oldWriter.write({ root: f.workspaceDirectory, permit: admitted.permit, text: 'recovered actual write' });
  assert.equal((await instance.workbench.workspaceEditStatus('workspace')).editable, false);
  oldWriter.child.kill('SIGKILL'); await oldWriter.exited;
  await until(async () => (await instance.workbench.workspaceEditStatus('workspace')).editable, 10_000);
  assert.equal((await instance.client.execution.pendingSaves({ windowId: admitted.permit.windowId, limit: 16 })).entries.length, 0);
  assert.equal(await readFile(join(f.workspaceDirectory, 'note.md'), 'utf8'), 'recovered actual write');
  assert.equal(f.controllerState().admission, 'open', 'recovery never changes native execution');
  assert.equal((await instance.workbench.changeWorkspaceMaintenance('workspace', 'resume')).maintenance, 'online');
});

test('online save receipts survive application restart and a repeated ID never overwrites later external work', async t => {
  const f = await fixture(t, 1); const first = await f.open();
  const original = await first.workbench.openWorkspaceFile('workspace', 'note.md'); const saveId = randomUUID();
  await first.workbench.saveWorkspaceFile('workspace', 'note.md', original.version, 'committed once', saveId);
  await first.workbench.close(); await first.client.close();
  await writeFile(join(f.workspaceDirectory, 'note.md'), 'later external work');
  const second = await f.open();
  await assert.rejects(second.workbench.saveWorkspaceFile('workspace', 'note.md', original.version, 'committed once', saveId), { code: 'execution_save_already_resolved' });
  assert.equal(await readFile(join(f.workspaceDirectory, 'note.md'), 'utf8'), 'later external work');
  assert.equal(f.controllerState().admission, 'open');
});

test('an uncertain online write remains unresolved after restart when external content prevents proof', async t => {
  const f = await fixture(t, 1); const first = await f.open();
  const oldWriter = await pausedWriter(t, f.writerDirectory, 'renamed');
  const registration = (await first.client.workspaces.get('workspace'))!;
  const document = await first.workbench.openWorkspaceFile('workspace', 'note.md');
  const gates = await first.client.execution.load(['host']);
  const admitted = await first.client.execution.acquireSave({ mode: 'concurrent', saveId: randomUUID(), windowId: 'file-' + digest('workspace'), writerId: oldWriter.ownerId,
    write: { workspaceId: 'workspace', directoryIdentity: registration.identity, path: 'note.md', expectedVersion: document.version, contentDigest: createHash('sha256').update('uncertain write').digest('hex') },
    groups: gates.map(({ groupId, revision }) => ({ groupId, revision })) });
  assert.equal(admitted.created, true); if (!admitted.created) return;
  await oldWriter.write({ root: f.workspaceDirectory, permit: admitted.permit, text: 'uncertain write' });
  await writeFile(join(f.workspaceDirectory, 'note.md'), 'external third content');
  oldWriter.child.kill('SIGKILL'); await oldWriter.exited;
  await first.workbench.close(); await first.client.close();
  const second = await f.open();
  // The real new writer owns the OS lock and independently inspects disk. The
  // unknown receipt is not an invitation to apply the original write again.
  const recovered = await second.writer.recover({ root: f.workspaceDirectory, permit: admitted.permit });
  assert.equal(recovered.outcome, 'unknown');
  assert.equal((await second.workbench.workspaceEditStatus('workspace')).editable, false);
  assert.equal((await second.client.execution.pendingConcurrentSaves({ limit: 16 })).entries.length, 1);
  await assert.rejects(second.workbench.saveWorkspaceFile('workspace', 'note.md', document.version, 'uncertain write', admitted.permit.saveId), { code: 'execution_save_unresolved' });
  assert.equal(await readFile(join(f.workspaceDirectory, 'note.md'), 'utf8'), 'external third content');
  assert.equal(f.controllerState().admission, 'open', 'unknown file effects do not cancel ongoing native work');
});

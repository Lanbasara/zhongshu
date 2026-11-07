import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { Binding, Catalog, Configuration, HarnessAdapter, HarnessId, HarnessInput, HistoryPage, NativeChange, NativeItem, NativeState, Receipt } from '../src/harness/types.ts';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { Workbench } from '../src/server/workbench.ts';

async function until(predicate: () => boolean) { const end = Date.now() + 3000; while (!predicate()) { if (Date.now() > end) throw new Error('condition_timeout'); await delay(2); } }

/** Deterministic native peer for the Plan contract (ADR 0016). It proves workbench rules, not real Harness behaviour. */
class Peer implements HarnessAdapter {
  readonly id: HarnessId;
  readonly planMode: 'per-turn' | 'native';
  nativeState: NativeState = { status: 'idle', pendingInputs: 0, configurationVerified: true };
  items: NativeItem[] = [];
  submitted: HarnessInput[] = [];
  planCalls: boolean[] = [];
  planReceipt: Receipt = { outcome: 'accepted' };
  constructor(id: HarnessId, planMode: 'per-turn' | 'native') { this.id = id; this.planMode = planMode; }
  async catalog(): Promise<Catalog> { return { id: this.id, available: true, models: [{ id: 'model', label: 'model' }], permissions: [{ id: 'workspace', label: 'workspace', description: 'synthetic' }] }; }
  async create(input: { cwd: string; configuration: Configuration }, bound: (value: Binding) => void): Promise<Binding> { const value = { id: 'root', cwd: input.cwd, configuration: input.configuration, details: {} }; bound(value); return value; }
  async state(): Promise<NativeState> { return structuredClone(this.nativeState); }
  async history(): Promise<HistoryPage> { return { items: structuredClone(this.items), olderCursor: null }; }
  async submit(_binding: Binding, input: HarnessInput): Promise<Receipt> { this.submitted.push(input); return { outcome: 'accepted', runId: 'run-2' }; }
  async reconcile(): Promise<Receipt> { return { outcome: 'unknown', reason: 'not_found' }; }
  async stop(_binding: Binding, runId: string): Promise<Receipt> { return { outcome: 'accepted', runId }; }
  async watch(_binding: Binding, _listener: (change: NativeChange) => void) { return () => {}; }
  async close() {}
  setPlan?: (binding: Binding, active: boolean) => Promise<Receipt>;
}

function fixture(t: TestContext, harness: HarnessId, planMode: 'per-turn' | 'native') {
  const directory = mkdtempSync(join(tmpdir(), 'zhongshu-plan-')); const db = openDatabase(directory, productMigrations);
  const store = createWorkbenchStore(db); const peer = new Peer(harness, planMode);
  if (planMode === 'native') peer.setPlan = async (_binding, active) => {
    peer.planCalls.push(active);
    if (peer.planReceipt.outcome === 'accepted') peer.nativeState = { ...peer.nativeState, plan: { active, pending: false } };
    return peer.planReceipt;
  };
  const workspaces = [{ id: 'fixture', label: 'fixture', directory: '/synthetic/workspace' }];
  const service = new Workbench(store, workspaces, new Map([[harness, peer]]));
  const id = randomUUID(); const configuration = { modelId: 'model', permissionId: 'workspace' };
  store.createConversation({ id, harnessId: harness, workspaceId: 'fixture', cwd: workspaces[0]!.directory, configuration });
  store.saveBinding(id, { id: 'root', cwd: workspaces[0]!.directory, configuration, details: {} });
  store.setConversationState(id, { readiness: 'ready', state: peer.nativeState });
  t.after(async () => { await service.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, peer, service, id };
}

test('Codex Plan is the conversation\'s choice, changes only between turns and travels with each dispatched message', async t => {
  const f = fixture(t, 'codex', 'per-turn');
  assert.deepEqual(f.service.planOf(f.store.getConversation(f.id)!), { active: false });
  const on = await f.service.setPlan(f.id, true);
  assert.deepEqual(f.service.planOf(on), { active: true });
  await f.service.enqueue({ id: randomUUID(), conversationId: f.id, type: 'message', payload: { text: 'Plan the report' } });
  await until(() => f.peer.submitted.length === 1);
  assert.equal(f.peer.submitted[0]!.plan, true);
  f.store.setConversationState(f.id, { state: { status: 'running', runId: 'run-2', pendingInputs: 0, configurationVerified: true } });
  await assert.rejects(f.service.setPlan(f.id, false), { code: 'plan_change_while_running' });
  // The accepted turn ends; the next send waits for that terminal proof.
  f.peer.nativeState = { status: 'idle', runId: 'run-2', terminalRunId: 'run-2', terminalStatus: 'completed', pendingInputs: 0, configurationVerified: true };
  await f.service.reconcile(f.id);
  assert.deepEqual(f.service.planOf(await f.service.setPlan(f.id, false)), { active: false });
  await f.service.enqueue({ id: randomUUID(), conversationId: f.id, type: 'message', payload: { text: 'Go' } });
  await until(() => f.peer.submitted.length === 2);
  assert.equal(f.peer.submitted[1]!.plan, undefined, 'off means the default mode');
});

test('A plan is ready only after a Plan turn ends with a proposed plan and nothing after it', async t => {
  const f = fixture(t, 'codex', 'per-turn');
  await f.service.setPlan(f.id, true);
  f.peer.nativeState = { status: 'idle', runId: 'run-1', pendingInputs: 0, configurationVerified: true };
  f.store.setConversationState(f.id, { state: f.peer.nativeState });
  f.peer.items = [
    { id: 'u1', kind: 'user', text: 'Plan it', status: 'completed', runId: 'run-1' },
    { id: 'run-1-plan', kind: 'assistant', plan: true, text: '## Plan', status: 'completed', runId: 'run-1' },
  ];
  await f.service.open(f.id);
  assert.deepEqual(f.service.snapshot(f.id).planReady, { runId: 'run-1' });
  f.peer.items = [...f.peer.items, { id: 'u2', kind: 'user', text: 'Also add tests', status: 'completed', runId: 'run-1' }];
  await f.service.reconcile(f.id);
  assert.equal(f.service.snapshot(f.id).planReady, undefined, 'a later message supersedes the offer');
  f.peer.items = f.peer.items.slice(0, 2);
  await f.service.reconcile(f.id);
  assert.deepEqual(f.service.snapshot(f.id).planReady, { runId: 'run-1' });
  await f.service.setPlan(f.id, false);
  assert.equal(f.service.snapshot(f.id).planReady, undefined, 'only while Plan is on');
});

test('DSH Plan is native session state: changing it runs the native command and the native state is shown', async t => {
  const f = fixture(t, 'dsh', 'native');
  assert.equal(f.service.planOf(f.store.getConversation(f.id)!), undefined, 'nothing reported yet');
  const on = await f.service.setPlan(f.id, true);
  assert.deepEqual(f.peer.planCalls, [true]);
  assert.deepEqual(f.service.planOf(on), { active: true });
  f.peer.planReceipt = { outcome: 'rejected', reason: 'plan_unavailable' };
  await assert.rejects(f.service.setPlan(f.id, false), { code: 'plan_unavailable' });
  assert.deepEqual(f.service.planOf(f.store.getConversation(f.id)!), { active: true }, 'a refused change leaves the native state as it was');
  assert.equal(f.store.getConversation(f.id)!.planMode, undefined, 'native Plan is never stored as a Zhongshu choice');
});

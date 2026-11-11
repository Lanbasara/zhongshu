import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { Binding, Catalog, Configuration, HarnessAdapter, HistoryPage, NativeChange, NativeItem, NativeState, Receipt } from '../src/harness/types.ts';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore, type OperationInput } from '../src/server/workbench-store.ts';
import { Workbench } from '../src/server/workbench.ts';
import { createCodexAutomations } from '../src/server/codex-automations.ts';
import type { LiveEvent, QueueDelivery } from '../src/shared/workbench.ts';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const terminal = (runId?: string): NativeState => ({ status: 'idle', pendingInputs: 0, configurationVerified: true, ...(runId ? { runId } : {}) });
const nativeItem = (id: string): NativeItem => ({ id, kind: 'assistant', text: 'full-' + id, status: 'completed' });
const operation = (conversationId: string): OperationInput => ({ id: randomUUID(), conversationId, type: 'message', payload: { text: 'synthetic request' } });
async function until(predicate: () => boolean) { const until = Date.now() + 2000; while (!predicate()) { if (Date.now() > until) throw new Error('condition_timeout'); await delay(1); } }

/** Deterministic native-contract peer. These fault tests do not claim real Harness or browser acceptance. */
class Peer implements HarnessAdapter {
  readonly id = 'codex' as const;
  readonly earlyInput = 'current' as const;
  queuedRead?: (input: { id: string; text: string }, delivery: QueueDelivery) => Promise<Receipt>;
  current = terminal(); records: NativeItem[] = []; listener?: (change: NativeChange) => void;
  stateCalls = 0; stateTargets: (string | undefined)[] = []; historyCalls: (string | undefined)[] = []; submitCalls: string[] = []; stopCalls: string[] = []; reconcileCalls: string[] = [];
  createCalls = 0; closed = false; unwatchCount = 0;
  stateRead?: (targetRunId?: string) => Promise<NativeState>;
  historyRead?: (cursor?: string) => Promise<HistoryPage>;
  submitRead?: (id: string) => Promise<Receipt>;
  createRead?: (input: { cwd: string; configuration: Configuration }, bound: (value: Binding) => void) => Promise<Binding>;
  closeRead?: () => Promise<void>;
  async catalog(): Promise<Catalog> { return { id: 'codex', available: true, models: [{ id: 'model', label: 'model' }], permissions: [{ id: 'workspace', label: 'workspace', description: 'synthetic fixture' }] }; }
  async create(input: { cwd: string; configuration: Configuration }, bound: (value: Binding) => void): Promise<Binding> {
    this.createCalls++; if (this.createRead) return this.createRead(input, bound);
    const binding = { id: 'native-' + randomUUID(), cwd: input.cwd, configuration: input.configuration, details: {} }; bound(binding); return binding;
  }
  async state(_binding: Binding, targetRunId?: string): Promise<NativeState> { this.stateCalls++; this.stateTargets.push(targetRunId); return this.stateRead ? this.stateRead(targetRunId) : this.current; }
  async history(_binding: Binding, cursor?: string, limit = 100): Promise<HistoryPage> {
    this.historyCalls.push(cursor); if (this.historyRead) return this.historyRead(cursor);
    const end = cursor ? Number(cursor) : this.records.length; const start = Math.max(0, end - limit);
    return { items: this.records.slice(start, end), olderCursor: start ? String(start) : null };
  }
  async submit(_binding: Binding, input: { id: string; text: string }): Promise<Receipt> { this.submitCalls.push(input.id); return this.submitRead ? this.submitRead(input.id) : { outcome: 'accepted', runId: 'run-' + input.id }; }
  async submitQueued(_binding: Binding, input: { id: string; text: string }, delivery: QueueDelivery): Promise<Receipt> {
    assert.ok(this.queuedRead);
    return this.queuedRead(input, delivery);
  }
  async reconcile(_binding: Binding, id: string): Promise<Receipt> { this.reconcileCalls.push(id); return { outcome: 'unknown', reason: 'not_found' }; }
  async stop(_binding: Binding, runId: string): Promise<Receipt> { this.stopCalls.push(runId); return { outcome: 'accepted', runId }; }
  async watch(_binding: Binding, listener: (change: NativeChange) => void) { this.listener = listener; return () => { this.listener = undefined; this.unwatchCount++; }; }
  emit(change: NativeChange) { this.listener?.(change); }
  async close() { this.closed = true; this.listener = undefined; await this.closeRead?.(); }
}

test('turn files keep edited paths from live items and native pages after the edit leaves the latest page', async t => {
  const f = fixture(t);
  const edit: NativeItem = { ...nativeItem('edit'), kind: 'tool', runId: 'first', fileEdits: ['a.tsx', 'b/a.tsx'] };
  await f.service.reading(f.id, 'page');
  f.peer.emit({ type: 'item', item: edit });
  f.peer.emit({ type: 'item', item: { ...edit, id: 'failed', status: 'failed', fileEdits: ['failed.ts'] } });
  await until(() => f.store.readTurnFiles(f.id, ['first']).length === 1);
  f.peer.records = [edit, ...Array.from({ length: 105 }, (_, index) => ({ ...nativeItem('step-' + index), runId: 'first' })), { ...edit, id: 'next-edit', runId: 'second', fileEdits: ['a.tsx'] }];
  await f.service.reconcile(f.id);
  const snapshot = f.service.snapshot(f.id);
  assert.equal(snapshot.history.items.some(item => item.id === edit.id), false);
  assert.equal(snapshot.history.liveItems.some(item => item.id === edit.id), false, 'a settled live copy retires once older than the latest page');
  assert.deepEqual(snapshot.turnFiles, [
    { runId: 'second', paths: ['a.tsx'], limited: false },
    { runId: 'first', paths: ['a.tsx', 'b/a.tsx'], limited: false },
  ]);
  assert.ok((['workbench_items', 'workbench_live_items'].every(name => !f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name))), 'no history body table exists');
});
test('one immutable queue claim wins edit, manual send and automatic dispatch; lost receipt resolves from original history', async t => {
  const f = fixture(t);
  const active = { ...terminal('original-run'), status: 'running' as const };
  f.peer.current = active;
  f.store.setConversationState(f.id, { state: active });
  const first = randomUUID(); const early = randomUUID();
  await f.service.changeQueue(f.id, { action: 'add', entryId: first, content: { text: 'first' } });
  await f.service.changeQueue(f.id, { action: 'add', entryId: early, content: { text: 'early' } });
  await f.service.changeQueue(f.id, { action: 'edit', entryId: early, version: 0, content: { text: 'edited' } });
  const receipt = deferred<Receipt>();
  const calls: { id: string; text: string; mode: string }[] = [];
  f.peer.queuedRead = async (input, delivery) => {
    calls.push({ ...input, mode: delivery.mode });
    if (input.text === 'edited') return receipt.promise;
    f.peer.current = { ...terminal('next-run'), status: 'running' };
    return { outcome: 'accepted', runId: 'next-run' };
  };
  const operationId = randomUUID();
  const send = { action: 'send' as const, entryId: early, version: 1, operationId, mode: 'current' as const, target: 'original-run' };
  await f.service.changeQueue(f.id, send);
  await f.service.changeQueue(f.id, send);
  await assert.rejects(f.service.changeQueue(f.id, { ...send, target: 'another-run' }), { code: 'operation_id_conflict' });
  await assert.rejects(f.service.changeQueue(f.id, { action: 'remove', entryId: early, version: 1 }), { code: 'queue_entry_changed' });
  f.peer.current = terminal('original-run');
  await f.service.reconcile(f.id);
  assert.equal(calls.length, 1);
  receipt.resolve({ outcome: 'unknown', reason: 'synthetic_lost_ack' });
  await until(() => f.store.getOperation(operationId)?.status === 'unknown');
  await f.service.reconcile(f.id);
  assert.equal(calls.length, 1);
  f.peer.records.push({ id: 'native-user-early', kind: 'user', text: 'edited', status: 'completed', runId: 'original-run', operationId });
  await f.service.reconcile(f.id);
  await until(() => calls.length === 2);
  assert.deepEqual(calls.map(({ text, mode }) => ({ text, mode })), [{ text: 'edited', mode: 'current' }, { text: 'first', mode: 'next' }]);
  assert.equal(f.store.getOperation(operationId)?.runId, 'original-run');
  await f.service.changeQueue(f.id, { action: 'add', entryId: early, content: { text: 'early' } });
  assert.equal(f.store.readQueue(f.id).entries.some(item => item.entryId === early), false);
});

test('queue pauses on the exact interrupted predecessor even after a later native turn completed', async t => {
  const f = fixture(t);
  const active = { ...terminal('original-run'), status: 'running' as const };
  f.peer.current = active;
  f.store.setConversationState(f.id, { state: active });
  await f.service.changeQueue(f.id, { action: 'add', entryId: randomUUID(), content: { text: 'after original' } });
  let calls = 0;
  f.peer.queuedRead = async () => { calls++; return { outcome: 'accepted', runId: 'resumed-run' }; };
  f.peer.current = { ...terminal('later-run'), terminalRunId: 'original-run', terminalStatus: 'interrupted' };
  await f.service.reconcile(f.id);
  await until(() => f.store.readQueue(f.id).pause === 'stopped');
  assert.equal(calls, 0);
  await f.service.changeQueue(f.id, { action: 'resume', version: f.store.readQueue(f.id).version });
  await until(() => calls === 1 && f.store.readQueue(f.id).entries.length === 0);
});

test('a late manual send cannot reclaim the same row after automatic dispatch claims it', async t => {
  const f = fixture(t);
  const active = { ...terminal('previous-run'), status: 'running' as const };
  f.peer.current = active;
  f.store.setConversationState(f.id, { state: active });
  const entryId = randomUUID();
  await f.service.changeQueue(f.id, { action: 'add', entryId, content: { text: 'race for this row' } });
  let calls = 0;
  const ack = deferred<Receipt>();
  f.peer.queuedRead = async (_input, delivery) => { calls++; assert.equal(delivery.mode, 'next'); return ack.promise; };
  f.peer.current = terminal('previous-run');
  await f.service.reconcile(f.id);
  try {
    await until(() => calls === 1);
    await assert.rejects(f.service.changeQueue(f.id, { action: 'send', entryId, version: 0, operationId: randomUUID(), mode: 'current', target: 'previous-run' }),
      { code: 'operation_needs_reconciliation' });
  } finally { ack.resolve({ outcome: 'accepted', runId: 'queued-run' }); }
  await until(() => f.store.readQueue(f.id).entries.length === 0);
  assert.equal(calls, 1);
});

test('startup recovers claimed queue input by identity and observes older queued conversations', async t => {
  const f = fixture(t);
  f.store.setConversationState(f.id, { state: { ...terminal('old-run'), status: 'running' } });
  const admitted = randomUUID(); const next = randomUUID(); const operationId = randomUUID();
  f.store.changeQueue(f.id, { action: 'add', entryId: admitted, content: { text: 'admitted before exit' } });
  f.store.changeQueue(f.id, { action: 'add', entryId: next, content: { text: 'still waiting' } });
  f.store.claimQueue(f.id, admitted, 0, operationId, { mode: 'current', target: 'old-run' });
  await delay(2);
  for (let index = 0; index < 16; index++) {
    f.store.createConversation({ id: randomUUID(), harnessId: 'codex', workspaceId: 'fixture', cwd: f.workspaces[0]!.directory,
      configuration: { modelId: 'model', permissionId: 'workspace' } });
  }
  assert.equal(f.store.listConversations({ limit: 16 }).some(item => item.id === f.id), false);
  await f.service.close();
  const peer = new Peer();
  peer.current = terminal('old-run');
  peer.records.push({ id: 'old-user', kind: 'user', text: 'admitted before exit', status: 'completed', runId: 'old-run', operationId });
  const calls: string[] = [];
  peer.queuedRead = async input => { calls.push(input.text); return { outcome: 'accepted', runId: 'new-run' }; };
  const restarted = new Workbench(f.store, f.workspaces, new Map([['codex', peer]]));
  try {
    await restarted.start();
    await until(() => calls.length === 1);
    assert.deepEqual(calls, ['still waiting']);
    assert.equal(f.store.getOperation(operationId)?.runId, 'old-run');
  } finally { await restarted.close(); }
});
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'zhongshu-service-')); const db = openDatabase(directory, productMigrations);
  const store = createWorkbenchStore(db); const peer = new Peer(); const workspaces = [{ id: 'fixture', label: 'fixture', directory: '/synthetic/workspace' }];
  const service = new Workbench(store, workspaces, new Map([['codex', peer]]));
  const id = randomUUID(); const configuration = { modelId: 'model', permissionId: 'workspace' };
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: workspaces[0]!.directory, configuration });
  store.saveBinding(id, { id: 'native-fixture', cwd: workspaces[0]!.directory, configuration, details: {} });
  store.setConversationState(id, { readiness: 'ready', state: terminal() });
  let databaseClosed = false;
  const closeDatabase = () => { if (!databaseClosed) { db.close(); databaseClosed = true; } };
  t.after(async () => { await service.close(); closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
  return { db, directory, store, peer, service, id, workspaces, closeDatabase };
}

test('Codex scheduler recovers one due occurrence, reconciles a lost ACK and marks the original conversation', async t => {
  const f = fixture(t);
  let clock = Date.parse('2027-01-01T00:00:00.000Z');
  const scheduler = () => createCodexAutomations(f.db, f.service, f.peer, () => {}, () => clock);
  const old = scheduler();
  const task = await old.operations.create({ title: 'check', prompt: 'synthetic scheduled task',
    timing: { kind: 'cron', expression: '*/5 * * * *', timeZone: 'Asia/Shanghai' },
    target: { kind: 'session', sessionId: 'native-fixture' } });
  await old.close();
  clock += 17 * 60_000;
  const resumed = scheduler();
  f.peer.submitRead = async id => {
    const runId = 'scheduled-run';
    const message = f.store.getOperation(id);
    assert.equal(message?.conversationId, f.id);
    f.peer.records.push({ id: 'scheduled-input', kind: 'user', text: 'native delivery', status: 'completed', runId, operationId: id });
    f.peer.current = { ...terminal(runId), terminalRunId: runId, terminalStatus: 'completed' };
    return { outcome: 'unknown', reason: 'synthetic_lost_ack' };
  };
  try {
    resumed.start();
    await until(() => f.peer.submitCalls.length === 1);
    await f.service.reconcile(f.id);
    await until(() => f.store.isScheduledRun(f.id, 'scheduled-run'));
    await until(() => !!f.db.prepare('SELECT 1 FROM codex_automation_runs WHERE task_id=? AND settled=1').get(task.id));
    const latest = await resumed.operations.view(task.id);
    assert.equal(latest?.lastDelivery?.scheduledAt, '2027-01-01T00:15:00.000Z');
    assert.equal(latest?.scheduledAt, '2027-01-01T00:20:00.000Z');
    assert.equal(latest?.lastDelivery?.runId, 'scheduled-run');
    assert.equal(f.peer.submitCalls.length, 1);
    assert.equal((await f.service.open(f.id)).history.items.find(item => item.id === 'scheduled-input')?.automation?.messageId, f.peer.submitCalls[0]);
  } finally { await resumed.close(); }
});

test('accepted ACK cannot open the next send until the same native run reaches a terminal state', async t => {
  const f = fixture(t); const first = operation(f.id); await f.service.enqueue(first);
  await until(() => f.store.getOperation(first.id)?.status === 'accepted');
  await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'operation_needs_reconciliation' });
  assert.equal(f.peer.submitCalls.length, 1);
  const runId = f.store.getOperation(first.id)!.runId!;
  f.peer.current = terminal('another-terminal-run'); await f.service.reconcile(f.id);
  await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'operation_needs_reconciliation' });
  f.peer.current = terminal(runId); await f.service.reconcile(f.id);
  const second = operation(f.id); await f.service.enqueue(second); await until(() => f.peer.submitCalls.length === 2);
  assert.deepEqual(f.peer.submitCalls, [first.id, second.id]);
});

test('a later native notification turn permits another message only with exact terminal evidence for the accepted user run', async t => {
  const f = fixture(t); const first = operation(f.id);
  f.store.enqueueOperation(first); f.store.claimOperation(first.id); f.store.settleOperation(first.id, { outcome: 'accepted', runId: 'user-run' });
  f.peer.current = terminal('notification-run'); await f.service.reconcile(f.id);
  assert.equal(f.peer.stateTargets.at(-1), 'user-run');
  await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'operation_needs_reconciliation' });
  f.peer.current = { ...terminal('notification-run'), terminalRunId: 'user-run' }; await f.service.reconcile(f.id);
  // ADR 0021: once the user run is proven, the later run nobody here started is read for its own result.
  assert.equal(f.peer.stateTargets.at(-1), 'notification-run');
  const before = f.peer.stateCalls; const second = operation(f.id); await f.service.enqueue(second); await until(() => f.peer.submitCalls.length === 1);
  assert.ok(f.peer.stateCalls > before, 'dispatch rechecks the native target immediately before submit');
  assert.equal(f.peer.stateTargets[before], 'user-run');
  await until(() => f.store.getOperation(second.id)?.status === 'accepted');
  await f.service.reconcile(f.id);
  assert.equal(f.peer.stateTargets.at(-1), 'run-' + second.id);
  await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'operation_needs_reconciliation' });
  assert.deepEqual(f.peer.submitCalls, [second.id], 'the preceding target proof cannot authorize a newer accepted run');
});

test('an accepted target changed during a state read fences the old target proof before it reaches snapshots', async t => {
  const f = fixture(t); const first = operation(f.id);
  f.store.enqueueOperation(first); f.store.claimOperation(first.id); f.store.settleOperation(first.id, { outcome: 'accepted', runId: 'user-run-1' });
  const old = deferred<NativeState>(); const fresh = deferred<NativeState>();
  f.peer.stateRead = async target => target === 'user-run-1' ? old.promise : fresh.promise;
  const syncing = f.service.reconcile(f.id);
  try {
    await until(() => f.peer.stateTargets.includes('user-run-1'));
    const next = operation(f.id); f.store.enqueueOperation(next); f.store.claimOperation(next.id); f.store.settleOperation(next.id, { outcome: 'accepted', runId: 'user-run-2' });
    old.resolve({ ...terminal('stale-notification'), terminalRunId: 'user-run-1' });
    await until(() => f.peer.stateTargets.includes('user-run-2'));
    assert.notEqual(f.store.getConversation(f.id)?.state.runId, 'stale-notification');
    fresh.resolve(terminal('current-notification')); await syncing;
    assert.equal(f.store.getConversation(f.id)?.state.terminalRunId, undefined);
    await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'operation_needs_reconciliation' });
  } finally { old.resolve(terminal()); fresh.resolve(terminal()); await syncing; }
});

test('terminal target evidence cannot override a current running, waiting, pending or unverified native state', async t => {
  const f = fixture(t); const first = operation(f.id);
  f.store.enqueueOperation(first); f.store.claimOperation(first.id); f.store.settleOperation(first.id, { outcome: 'accepted', runId: 'user-run' });
  for (const state of [
    { ...terminal('notification-run'), status: 'running' as const },
    { ...terminal('notification-run'), status: 'waiting' as const },
    { ...terminal('notification-run'), pendingInputs: 1 },
    { ...terminal('notification-run'), configurationVerified: false },
  ]) {
    f.peer.current = { ...state, terminalRunId: 'user-run' }; await f.service.reconcile(f.id);
    await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'operation_needs_reconciliation' });
  }
  assert.equal(f.peer.submitCalls.length, 0);
});

test('a restarted service rechecks a persisted target proof before dispatch and clears absent proof', async t => {
  const f = fixture(t); const first = operation(f.id);
  f.store.enqueueOperation(first); f.store.claimOperation(first.id); f.store.settleOperation(first.id, { outcome: 'accepted', runId: 'user-run' });
  f.store.setConversationState(f.id, { state: { ...terminal('notification-run'), terminalRunId: 'user-run' } });
  const next = operation(f.id); f.store.enqueueOperation(next); await f.service.close();
  const peer = new Peer(); peer.current = terminal('notification-run');
  const restarted = new Workbench(f.store, f.workspaces, new Map([['codex', peer]]));
  try {
    await restarted.start(); await restarted.reconcile(f.id);
    assert.equal(peer.stateTargets.at(-1), 'user-run');
    assert.equal(f.store.getConversation(f.id)?.state.terminalRunId, undefined);
    assert.equal(f.store.getOperation(next.id)?.status, 'queued'); assert.equal(peer.submitCalls.length, 0);
    peer.current = { ...terminal('notification-run'), terminalRunId: 'user-run' }; await restarted.reconcile(f.id);
    await until(() => peer.submitCalls.length === 1); assert.deepEqual(peer.submitCalls, [next.id]);
  } finally { await restarted.close(); }
});

test('unique user operationId evidence fills accepted runId and reconciles unknown without a duplicate submit', async t => {
  const f = fixture(t); const accepted = operation(f.id); f.store.enqueueOperation(accepted); f.store.claimOperation(accepted.id); f.store.settleOperation(accepted.id, { outcome: 'accepted' });
  await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'operation_needs_reconciliation' });
  const user: NativeItem = { id: 'user-accepted', kind: 'user', status: 'completed', text: 'request', operationId: accepted.id, runId: 'turn-1' };
  f.peer.records = [user]; f.peer.current = terminal('turn-1'); await f.service.reconcile(f.id);
  assert.equal(f.store.getOperation(accepted.id)?.runId, 'turn-1');
  const unknown = operation(f.id); f.store.enqueueOperation(unknown); f.store.claimOperation(unknown.id); f.store.settleOperation(unknown.id, { outcome: 'unknown', reason: 'reply_lost' });
  f.peer.records.push({ ...user, id: 'user-unknown', operationId: unknown.id, runId: 'turn-2' }); f.peer.current = terminal('turn-2');
  await f.service.reconcile(f.id); assert.equal(f.store.getOperation(unknown.id)?.status, 'accepted'); assert.equal(f.store.getOperation(unknown.id)?.runId, 'turn-2');
  assert.equal(f.peer.submitCalls.length, 0); assert.equal(f.peer.reconcileCalls.length, 0);
  // Evidence naming two runs is ambiguous: the receipt is reconciled natively instead of guessed.
  const ambiguous = operation(f.id); f.store.enqueueOperation(ambiguous); f.store.claimOperation(ambiguous.id); f.store.settleOperation(ambiguous.id, { outcome: 'unknown', reason: 'reply_lost' });
  f.peer.records.push({ ...user, id: 'ambiguous-1', operationId: ambiguous.id, runId: 'turn-3' }, { ...user, id: 'ambiguous-2', operationId: ambiguous.id, runId: 'turn-4' });
  await f.service.reconcile(f.id);
  assert.equal(f.store.getOperation(ambiguous.id)?.status, 'unknown'); assert.deepEqual(f.peer.reconcileCalls, [ambiguous.id]);
});

test('snapshots show the latest 100 operations, while older unresolved operations still block sending', async t => {
  const f = fixture(t); const unknown = operation(f.id); f.store.enqueueOperation(unknown); f.store.claimOperation(unknown.id); f.store.settleOperation(unknown.id, { outcome: 'unknown', reason: 'old_unknown' });
  const ids: string[] = [];
  for (let index = 0; index < 140; index++) { const value = operation(f.id); ids.push(value.id); f.store.enqueueOperation(value); f.store.claimOperation(value.id); f.store.settleOperation(value.id, { outcome: 'accepted', runId: 'run-' + index }); }
  f.store.setConversationState(f.id, { state: terminal('run-139') });
  const snapshot = f.service.snapshot(f.id); assert.equal(snapshot.operations.length, 100); assert.equal(snapshot.operations[0]?.id, ids.at(-1)); assert.equal(snapshot.operations.at(-1)?.id, ids[40]);
  await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'operation_needs_reconciliation' }); assert.equal(f.peer.submitCalls.length, 0);
});

test('a gap of any size opens at the latest native page, stays sendable, and older pages read through to the first item', async t => {
  const f = fixture(t); const records = Array.from({ length: 5000 }, (_, index) => nativeItem('item-' + index));
  f.peer.records = records;
  await f.service.reconcile(f.id);
  assert.deepEqual([...new Set(f.peer.historyCalls)], [undefined], 'opening never walks back to fill a gap');
  const snapshot = f.service.snapshot(f.id);
  assert.equal(snapshot.conversation.state.status, 'idle'); assert.equal(snapshot.conversation.error, null);
  assert.equal(snapshot.history.items.length, 50); assert.equal(snapshot.history.items.at(-1)?.id, 'item-4999');
  const seen = snapshot.history.items.map(item => item.id); let cursor = snapshot.history.olderCursor;
  while (cursor) { const page = await f.service.history(f.id, cursor); seen.unshift(...page.items.map(item => item.id)); cursor = page.olderCursor; }
  assert.deepEqual(seen, records.map(item => item.id));
  assert.ok((['workbench_items', 'workbench_live_items'].every(name => !f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name))), 'no history body table exists');
  const next = operation(f.id); await f.service.enqueue(next); await until(() => f.peer.submitCalls.length === 1);
});
test('cursors are bound to their conversation and native page faults stay reading problems, not execution fences', async t => {
  const f = fixture(t); f.peer.records = Array.from({ length: 120 }, (_, index) => nativeItem('item-' + index));
  const opened = await f.service.open(f.id); assert.equal(opened.history.items.length, 50);
  const foreign = Buffer.from(JSON.stringify({ c: randomUUID(), n: '70' })).toString('base64url');
  await assert.rejects(f.service.history(f.id, foreign), { code: 'history_cursor_invalid', statusCode: 400 });
  await assert.rejects(f.service.history(f.id, 'not-a-cursor'), { code: 'history_cursor_invalid' });
  f.peer.historyRead = async () => ({ items: [], olderCursor: 'cycle' });
  await f.service.reconcile(f.id);
  const cycled = f.service.snapshot(f.id);
  assert.equal(cycled.history.error, 'history_no_progress'); assert.equal(cycled.history.items.length, 50, 'already loaded content is kept');
  assert.equal(cycled.conversation.state.status, 'idle');
  f.peer.historyRead = async () => { throw new Error('native_down'); };
  await assert.rejects(f.service.history(f.id, opened.history.olderCursor!), { code: 'native_history_unavailable', statusCode: 502 });
  const next = operation(f.id); await f.service.enqueue(next); await until(() => f.peer.submitCalls.length === 1);
});
test('invalidate during sync forces another read, and a late state result cannot overwrite a newer native event', async t => {
  const f = fixture(t); const old = deferred<NativeState>(); let first = true;
  f.peer.stateRead = async () => { if (first) { first = false; return old.promise; } return f.peer.current; };
  const syncing = f.service.reconcile(f.id); await until(() => f.peer.stateCalls === 1);
  f.peer.current = { status: 'running', runId: 'new-run', pendingInputs: 0, configurationVerified: true };
  f.peer.emit({ type: 'state', state: f.peer.current }); f.peer.emit({ type: 'invalidate' }); old.resolve(terminal('old-run'));
  await syncing; assert.ok(f.peer.stateCalls >= 2); assert.equal(f.store.getConversation(f.id)?.state.runId, 'new-run'); assert.equal(f.store.getConversation(f.id)?.state.status, 'running');
});

test('unavailable immediately clears verification while retaining the last known run, queue and saved content', async t => {
  const f = fixture(t);
  f.peer.records = [nativeItem('saved')];
  f.peer.current = { status: 'running', runId: 'known-run', terminalRunId: 'older-terminal', pendingInputs: 3, configurationVerified: true };
  await f.service.reconcile(f.id);
  const before = f.service.snapshot(f.id);
  f.peer.stateRead = async () => { throw new Error('synthetic_offline'); };
  f.peer.historyRead = async () => { throw new Error('synthetic_offline'); };
  f.peer.emit({ type: 'unavailable', reason: 'synthetic_connection_lost' });
  const lost = f.service.snapshot(f.id);
  assert.deepEqual(lost.conversation.state, { status: 'unknown', runId: 'known-run', pendingInputs: 3, configurationVerified: false, reason: 'synthetic_connection_lost' });
  assert.deepEqual(lost.conversation.binding, before.conversation.binding);
  assert.deepEqual(lost.history.items, before.history.items);
  assert.ok(lost.revision > before.revision);
  await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'operation_needs_reconciliation' });
  await f.service.reconcile(f.id);
  assert.equal(f.store.getConversation(f.id)?.state.status, 'unknown');
  assert.equal(f.peer.submitCalls.length, 0);
});

test('a late successful transport read cannot revive a disconnected run', async t => {
  const f = fixture(t); await f.service.reconcile(f.id);
  const old = deferred<NativeState>(); let reads = 0;
  f.peer.stateRead = async () => { if (++reads === 1) return old.promise; throw new Error('still_offline'); };
  const syncing = f.service.reconcile(f.id);
  try {
    await until(() => reads === 1);
    f.peer.emit({ type: 'unavailable', reason: 'synthetic_connection_lost' });
    old.resolve({ status: 'running', runId: 'stale-run', pendingInputs: 0, configurationVerified: true });
    await syncing;
    assert.equal(f.store.getConversation(f.id)?.state.status, 'unknown');
    assert.equal(f.store.getConversation(f.id)?.state.configurationVerified, false);
    assert.notEqual(f.store.getConversation(f.id)?.state.runId, 'stale-run');
  } finally { old.resolve(terminal()); await syncing; }
});

for (const outcome of ['success', 'failure'] as const) test(`late transport ${outcome} cannot overwrite a newer recovered state`, async t => {
  const f = fixture(t); await f.service.reconcile(f.id);
  const old = deferred<NativeState>(); const fresh = deferred<NativeState>(); let reads = 0;
  f.peer.stateRead = async () => ++reads === 1 ? old.promise : fresh.promise;
  const syncing = f.service.reconcile(f.id);
  try {
    await until(() => reads === 1);
    f.peer.emit({ type: 'unavailable', reason: 'synthetic_connection_lost' });
    assert.equal(f.store.getConversation(f.id)?.state.status, 'unknown');
    const recovered = terminal('new-run');
    f.peer.emit({ type: 'state', state: recovered });
    if (outcome === 'success') old.resolve({ status: 'running', runId: 'stale-run', pendingInputs: 0, configurationVerified: true });
    else old.reject(new Error('synthetic_old_failure'));
    await until(() => reads >= 2);
    assert.deepEqual(f.store.getConversation(f.id)?.state, recovered, 'old read must not overwrite the new native event');
    fresh.resolve(recovered);
    await syncing;
    assert.deepEqual(f.store.getConversation(f.id)?.state, recovered);
    assert.equal(f.peer.submitCalls.length, 0);
  } finally { old.resolve(terminal()); fresh.resolve(terminal('new-run')); await syncing; }
});

test('continuous text during every read cannot starve running state or cancellation', async t => {
  const f = fixture(t); await f.service.reconcile(f.id);
  const before = f.peer.stateCalls; let updates = 0;
  f.peer.current = { status: 'running', runId: 'streaming-run', pendingInputs: 0, configurationVerified: true };
  // Every read overlaps another text update, with no quiet interval for synchronization.
  f.peer.stateRead = async () => {
    f.peer.emit({ type: 'item', item: { id: 'streaming-body', kind: 'assistant', status: 'running', runId: 'streaming-run', text: 'partial-' + ++updates } });
    return f.peer.current;
  };
  await f.service.reconcile(f.id);
  assert.equal(f.store.getConversation(f.id)?.state.status, 'running');
  assert.equal(f.store.getConversation(f.id)?.state.runId, 'streaming-run');
  assert.ok(updates > 1); assert.ok(f.peer.stateCalls - before <= 6, 'each explicit reconcile keeps its bounded sync passes');
  const stop: OperationInput = { id: randomUUID(), conversationId: f.id, type: 'stop', payload: { runId: 'streaming-run' } };
  await f.service.enqueue(stop); await until(() => f.store.getOperation(stop.id)?.status === 'accepted');
  assert.deepEqual(f.peer.stopCalls, ['streaming-run']);
  f.peer.stateRead = undefined; await f.service.reconcile(f.id);
  assert.equal(f.service.liveItem(f.id, 'streaming-body')?.text, 'partial-' + updates);
});

test('a dirty history read is repeated and does not overwrite a later complete live body', async t => {
  const f = fixture(t); const old = deferred<HistoryPage>(); let first = true;
  f.peer.historyRead = async () => { if (first) { first = false; return old.promise; } return { items: [nativeItem('same-id')], olderCursor: null }; };
  const syncing = f.service.reconcile(f.id); await until(() => f.peer.historyCalls.length === 1);
  f.peer.emit({ type: 'item', item: { ...nativeItem('same-id'), text: 'new complete body' } }); f.peer.emit({ type: 'invalidate' });
  old.resolve({ items: [{ ...nativeItem('same-id'), text: 'old body' }], olderCursor: null });
  await syncing;
  assert.ok(f.peer.historyCalls.length >= 2); assert.equal(f.service.liveItem(f.id, 'same-id')?.text, 'new complete body');
  assert.equal(f.service.snapshot(f.id).history.liveItems.find(item => item.id === 'same-id')?.text, 'new complete body');
  f.peer.historyRead = async () => ({ items: [{ ...nativeItem('same-id'), text: 'new complete body' }], olderCursor: null });
  await f.service.reconcile(f.id); assert.equal(f.service.liveItem(f.id, 'same-id')?.text, 'new complete body');
  assert.equal(f.service.snapshot(f.id).history.liveItems.length, 0, 'the canonical body retires the live copy');
});

test('a saved workspace drift blocks both startup queued work and new dispatch', async t => {
  const f = fixture(t); const queued = operation(f.id); f.store.enqueueOperation(queued); f.workspaces[0]!.directory = '/different/configured/workspace';
  await f.service.start(); await f.service.open(f.id);
  assert.equal(f.store.getConversation(f.id)?.readiness, 'blocked'); assert.equal(f.store.getOperation(queued.id)?.status, 'queued');
  await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'conversation_configuration_changed' }); assert.equal(f.peer.submitCalls.length, 0);
});

test('unknown stop is reconciled only against its exact terminal run, never another idle run', async t => {
  const f = fixture(t); const stop: OperationInput = { id: randomUUID(), conversationId: f.id, type: 'stop', payload: { runId: 'target-run' } };
  f.store.enqueueOperation(stop); f.store.claimOperation(stop.id); f.store.settleOperation(stop.id, { outcome: 'unknown', reason: 'cancel_reply_lost' });
  f.peer.current = terminal('other-run'); await f.service.reconcile(f.id); assert.equal(f.store.getOperation(stop.id)?.status, 'unknown');
  f.peer.current = terminal('target-run'); await f.service.reconcile(f.id); assert.equal(f.store.getOperation(stop.id)?.status, 'accepted'); assert.equal(f.peer.stopCalls.length, 0);
});

test('close closes adapters first, waits for preparation, and saves an identity bound during shutdown', async t => {
  const f = fixture(t); const waiting = deferred<void>(); let lateBound: ((binding: Binding) => void) | undefined;
  f.peer.createRead = async (input, bound) => { lateBound = bound; await waiting.promise; const binding = { id: 'created-before-close', cwd: input.cwd, configuration: input.configuration, details: {} }; bound(binding); return binding; };
  const id = randomUUID(); await f.service.create({ id, harnessId: 'codex', workspaceId: 'fixture', configuration: { modelId: 'model', permissionId: 'workspace' } });
  await until(() => f.peer.createCalls === 1); let complete = false; const closing = f.service.close().then(() => { complete = true; });
  await delay(1); const observed = { closed: f.peer.closed, complete }; waiting.resolve(); await closing;
  assert.deepEqual(observed, { closed: true, complete: false }); assert.equal(f.store.getConversation(id)?.binding?.id, 'created-before-close');
  f.closeDatabase(); assert.doesNotThrow(() => lateBound?.({ id: 'late-untrusted-callback', cwd: '/synthetic/workspace', configuration: { modelId: 'model', permissionId: 'workspace' }, details: {} }));
});

test('close waits for an in-flight dispatch receipt before its caller can close SQLite', async t => {
  const f = fixture(t); const receipt = deferred<Receipt>(); f.peer.submitRead = async () => receipt.promise;
  const request = operation(f.id); await f.service.enqueue(request); await until(() => f.peer.submitCalls.length === 1);
  let complete = false; const closing = f.service.close().then(() => { complete = true; }); await delay(1);
  const observed = { closed: f.peer.closed, complete }; receipt.resolve({ outcome: 'unknown', reason: 'connection_closed' }); await closing;
  assert.deepEqual(observed, { closed: true, complete: false }); assert.equal(f.store.getOperation(request.id)?.status, 'unknown');
  assert.equal(f.peer.unwatchCount, 1); f.closeDatabase(); await delay(1);
});

test('close waits for both sides of a sync even when one request has already failed', async t => {
  const f = fixture(t); const history = deferred<HistoryPage>(); const state = deferred<NativeState>();
  f.peer.historyRead = async () => history.promise; f.peer.stateRead = async () => state.promise;
  const syncing = f.service.reconcile(f.id).catch(() => {}); await until(() => f.peer.historyCalls.length === 1);
  const before = f.store.version(); let complete = false; const closing = f.service.close().then(() => { complete = true; });
  state.reject(new Error('connection_closed')); await delay(1); const observed = complete;
  history.resolve({ items: [nativeItem('late-history')], olderCursor: null }); await Promise.all([closing, syncing]);
  assert.equal(observed, false); assert.equal(f.store.version(), before); f.closeDatabase();
});


test('ordinary startup dispatches known queued work in order and holds the next request through the ACK gap', async t => {
  const f = fixture(t); const first = operation(f.id); const second = operation(f.id); f.store.enqueueOperation(first); f.store.enqueueOperation(second);
  await f.service.start(); await until(() => f.store.getOperation(first.id)?.status === 'accepted');
  await delay(5); assert.deepEqual(f.peer.submitCalls, [first.id]); assert.equal(f.store.getOperation(second.id)?.status, 'queued');
  const runId = f.store.getOperation(first.id)!.runId!; f.peer.current = terminal(runId);
  f.peer.records = [{ id: 'native-first-user', kind: 'user', status: 'completed', text: 'first', operationId: first.id, runId }];
  await f.service.reconcile(f.id); await until(() => f.store.getOperation(second.id)?.status === 'accepted');
  assert.deepEqual(f.peer.submitCalls, [first.id, second.id]);
});

test('a failed native configuration keeps its early binding and retrying create never creates a second native identity', async t => {
  const f = fixture(t); f.peer.createRead = async (input, bound) => { bound({ id: 'partially-created', cwd: input.cwd, configuration: input.configuration, details: {} }); throw new Error('configuration_failed'); };
  const input = { id: randomUUID(), harnessId: 'codex' as const, workspaceId: 'fixture', configuration: { modelId: 'model', permissionId: 'workspace' } };
  await f.service.create(input); await until(() => f.store.getConversation(input.id)?.readiness === 'blocked');
  const reused = await f.service.create(input); assert.equal(reused.binding?.id, 'partially-created'); assert.equal(f.peer.createCalls, 1);
});

test('stop preflight rejects a changed native run before invoking the adapter cancellation', async t => {
  const f = fixture(t); f.store.setConversationState(f.id, { state: { ...terminal('old-run'), status: 'running' } });
  f.peer.current = { ...terminal('new-run'), status: 'running' };
  const stop: OperationInput = { id: randomUUID(), conversationId: f.id, type: 'stop', payload: { runId: 'old-run' } };
  await f.service.enqueue(stop); await until(() => f.store.getOperation(stop.id)?.status === 'rejected');
  assert.equal(f.peer.stopCalls.length, 0); assert.equal(f.store.getOperation(stop.id)?.reason, 'native_run_changed');
});

test('shutdown keeps live bodies out of the database; the native Harness stays authoritative', async t => {
  const f = fixture(t); await f.service.reconcile(f.id);
  f.peer.emit({ type: 'item', item: { ...nativeItem('pending-live'), text: 'latest complete live body' } });
  await f.service.close();
  assert.ok((['workbench_items', 'workbench_live_items'].every(name => !f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name))), 'no history body table exists');
  f.closeDatabase(); await delay(45);
});
test('older paging crosses an empty native record page when its cursor advances', async t => {
  const f = fixture(t);
  f.peer.historyRead = async cursor => cursor === undefined ? { items: [nativeItem('known')], olderCursor: 'empty-record-page' }
    : cursor === 'empty-record-page' ? { items: [], olderCursor: 'older-body-page' }
      : { items: [nativeItem('older')], olderCursor: null };
  const opened = await f.service.open(f.id); assert.deepEqual(opened.history.items.map(item => item.id), ['known']);
  const page = await f.service.history(f.id, opened.history.olderCursor!);
  assert.deepEqual(page.items.map(item => item.id), ['older']); assert.equal(page.olderCursor, null);
  assert.deepEqual(f.peer.historyCalls, [undefined, 'empty-record-page', 'older-body-page']);
});
test('accepted messages without a run ID can reconcile evidence outside the locally loaded page', async t => {
  const f = fixture(t); const sent = operation(f.id);
  f.store.enqueueOperation(sent); f.store.claimOperation(sent.id); f.store.settleOperation(sent.id, { outcome: 'accepted' });
  f.peer.current = terminal('remote-run');
  f.peer.reconcile = async (_binding, operationId) => { assert.equal(operationId, sent.id); return { outcome: 'unknown', reason: 'lookup_unavailable' }; };
  await f.service.reconcile(f.id);
  assert.equal(f.store.getOperation(sent.id)?.status, 'accepted'); assert.equal(f.store.getOperation(sent.id)?.runId, null);
  f.peer.reconcile = async (_binding, operationId) => { assert.equal(operationId, sent.id); return { outcome: 'accepted', runId: 'remote-run' }; };
  await f.service.reconcile(f.id);
  assert.equal(f.store.getOperation(sent.id)?.runId, 'remote-run'); assert.equal(f.peer.submitCalls.length, 0);
});

test('configuration drift still permits stopping the same verified native run while blocking messages', async t => {
  const f = fixture(t); f.peer.current = { status: 'running', runId: 'active-run', pendingInputs: 0, configurationVerified: false, reason: 'model_changed' };
  await f.service.reconcile(f.id);
  await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'operation_needs_reconciliation' });
  const stop: OperationInput = { id: randomUUID(), conversationId: f.id, type: 'stop', payload: { runId: 'active-run' } };
  await f.service.enqueue(stop); await until(() => f.store.getOperation(stop.id)?.status === 'accepted');
  assert.deepEqual(f.peer.stopCalls, ['active-run']); assert.equal(f.peer.submitCalls.length, 0);
});

test('workspace saving fences a competing send and retains a newer file on stale saves', async t => {
  const f = fixture(t);
  const { mkdtemp, readFile, realpath, rm, writeFile } = await import('node:fs/promises');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zhongshu-edit-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = { modelId: 'model', permissionId: 'workspace' };
  const id = randomUUID();
  const workspace = { id: 'editable', label: 'Editable', directory: root, managedWrites: true };
  f.service.workspaces.push(workspace);
  f.store.createConversation({ id, harnessId: 'codex', workspaceId: workspace.id, cwd: root, configuration });
  f.store.saveBinding(id, { id: 'native-editor', cwd: root, configuration, details: {} });
  const path = join(root, 'notes.md');
  await writeFile(path, 'original');
  const original = await f.service.openWorkspaceFile(workspace.id, 'notes.md');
  await f.service.reconcile(id);
  assert.equal(f.service.workspaceEditStatus(workspace.id).editable, true);
  const readingNativeState = deferred<NativeState>();
  f.peer.stateRead = async () => readingNativeState.promise;
  const saving = f.service.saveWorkspaceFile(workspace.id, 'notes.md', original.version, 'saved');
  const sending = f.service.enqueue(operation(id));
  const sendRejected = assert.rejects(sending, { code: 'workspace_save_in_progress' });
  await delay(5);
  readingNativeState.resolve(terminal());
  await Promise.all([saving, sendRejected]);
  assert.equal(await readFile(path, 'utf8'), 'saved');
  await assert.rejects(f.service.saveWorkspaceFile(workspace.id, 'notes.md', original.version, 'stale'), { message: 'file_version_changed' });
  assert.equal(await readFile(path, 'utf8'), 'saved');
  const second = randomUUID();
  f.store.createConversation({ id: second, harnessId: 'codex', workspaceId: workspace.id, cwd: root, configuration });
  f.store.saveBinding(second, { id: 'native-competitor', cwd: root, configuration, details: {} });
  await f.service.reconcile(second);
  f.peer.stateRead = async () => ({ status: 'running', runId: 'active', pendingInputs: 0, configurationVerified: true });
  await f.service.reconcile(second);
  assert.equal(f.service.workspaceEditStatus(workspace.id).editable, false);
  assert.throws(() => f.service.saveWorkspaceFile(workspace.id, 'notes.md', original.version, 'unsafe'), { code: 'workspace_not_idle' });
  assert.equal((await f.service.openWorkspaceFile(workspace.id, 'notes.md')).text, 'saved');
});

test('an idle conversation nobody is reading still allows a save, which checks native state first', async t => {
  const f = fixture(t);
  const { mkdtemp, readFile, realpath, rm, writeFile } = await import('node:fs/promises');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zhongshu-edit-unobserved-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = { modelId: 'model', permissionId: 'workspace' };
  const id = randomUUID();
  const workspace = { id: 'unobserved', label: 'Unobserved', directory: root, managedWrites: true };
  f.service.workspaces.push(workspace);
  f.store.createConversation({ id, harnessId: 'codex', workspaceId: workspace.id, cwd: root, configuration });
  f.store.saveBinding(id, { id: 'native-unobserved', cwd: root, configuration, details: {} });
  await writeFile(join(root, 'notes.md'), 'original');
  const original = await f.service.openWorkspaceFile(workspace.id, 'notes.md');
  await f.service.reconcile(id);
  // No page reads the conversation, so its runtime is released; it is still idle.
  await delay(400);
  assert.equal(f.service.workspaceEditStatus(workspace.id).editable, true);
  await f.service.saveWorkspaceFile(workspace.id, 'notes.md', original.version, 'saved');
  assert.equal(await readFile(join(root, 'notes.md'), 'utf8'), 'saved');
  // A run started elsewhere is found by the save's own native read, and nothing is written.
  const current = await f.service.openWorkspaceFile(workspace.id, 'notes.md');
  f.peer.stateRead = async () => ({ status: 'running', runId: 'elsewhere', pendingInputs: 0, configurationVerified: true });
  await assert.rejects(f.service.saveWorkspaceFile(workspace.id, 'notes.md', current.version, 'unsafe'), { code: 'workspace_not_idle' });
  assert.equal(await readFile(join(root, 'notes.md'), 'utf8'), 'saved');
});

test('dedicated Host maintenance gates execution, persists through controller state and fails closed', async t => {
  const f = fixture(t);
  const { mkdtemp, readFile, realpath, rm, writeFile } = await import('node:fs/promises');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zhongshu-maintenance-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { Workbench } = await import('../src/server/workbench.ts');
  let host: 'online' | 'paused' | 'unknown' = 'online';
  const pause = deferred<void>();
  const service = new Workbench(f.store, [{
    id: 'dedicated', label: 'Dedicated', directory: root, managedWrites: true,
    async maintenance(action) {
      if (action === 'pause') { await pause.promise; host = 'paused'; }
      if (action === 'resume' && host !== 'unknown') host = 'online';
      return host;
    },
  }], new Map());
  t.after(() => service.close());
  const path = join(root, 'notes.md');
  await writeFile(path, 'before');
  const original = await service.openWorkspaceFile('dedicated', 'notes.md');
  await service.start();
  assert.equal(service.workspaceEditStatus('dedicated').editable, false);
  const pending = service.changeWorkspaceMaintenance('dedicated', 'pause');
  assert.equal(service.workspaceEditStatus('dedicated').editable, false);
  assert.throws(() => service.saveWorkspaceFile('dedicated', 'notes.md', original.version, 'unsafe'));
  pause.resolve();
  await pending;
  assert.equal(service.workspaceEditStatus('dedicated').editable, true);
  const saved = await service.saveWorkspaceFile('dedicated', 'notes.md', original.version, 'saved');
  assert.equal(await readFile(path, 'utf8'), 'saved');
  host = 'unknown';
  await assert.rejects(service.saveWorkspaceFile('dedicated', 'notes.md', saved.version, 'unsafe'), { code: 'workspace_maintenance_unavailable' });
  await assert.rejects(async () => service.changeWorkspaceMaintenance('dedicated', 'resume'), { code: 'workspace_maintenance_unavailable' });
  assert.equal(service.workspaceEditStatus('dedicated').editable, false);
  host = 'paused';
  await service.start();
  assert.equal(service.workspaceEditStatus('dedicated').editable, true);
  await service.changeWorkspaceMaintenance('dedicated', 'resume');
  assert.equal(service.workspaceEditStatus('dedicated').editable, false);
  assert.equal(await readFile(path, 'utf8'), 'saved');
});

test('maintenance checks cold native sessions without fetching conversation history', async t => {
  const f = fixture(t);
  const workspace = { id: 'fixture', label: 'Fixture', directory: '/synthetic/workspace', managedWrites: true,
    async maintenance(action: 'status' | 'pause' | 'resume') {
      if (action === 'pause') phase = 'paused';
      if (action === 'resume') phase = 'online';
      return phase;
    } };
  let phase: 'online' | 'paused' = 'online';
  const service = new Workbench(f.store, [workspace], new Map([['codex', f.peer]]));
  t.after(() => service.close());
  await service.start();
  assert.deepEqual(f.peer.historyCalls, []); // Completed history is cold at startup.
  const configuration = { modelId: 'model', permissionId: 'workspace' };
  f.peer.historyCalls.length = 0;
  f.peer.current = { status: 'waiting', pendingInputs: 1, configurationVerified: true };
  await assert.rejects(async () => service.changeWorkspaceMaintenance('fixture', 'pause'), { code: 'workspace_not_idle' });
  assert.equal(phase, 'online');
  f.peer.current = terminal();
  let count = 1;
  for (const target of [1, 20, 100]) {
    while (count < target) {
      const id = randomUUID();
      f.store.createConversation({ id, harnessId: 'codex', workspaceId: workspace.id, cwd: workspace.directory, configuration });
      f.store.saveBinding(id, { id: 'cold-native-' + count, cwd: workspace.directory, configuration, details: {} });
      count++;
    }
    const before = f.peer.stateCalls;
    await service.changeWorkspaceMaintenance('fixture', 'pause');
    await service.changeWorkspaceMaintenance('fixture', 'resume');
    assert.equal(f.peer.stateCalls - before, target * 2);
    assert.deepEqual(f.peer.historyCalls, []);
  }
});

test('prepare validates model effort before creating a native session', async t => {
  const f = fixture(t);
  f.peer.catalog = async () => ({ id: 'codex', available: true,
    models: [{ id: 'model', label: 'Model', reasoningEfforts: [{ id: 'high', label: 'High' }] }],
    permissions: [{ id: 'workspace', label: 'Workspace', description: '' }] });
  const input = { id: randomUUID(), harnessId: 'codex' as const, workspaceId: 'fixture',
    configuration: { modelId: 'model', permissionId: 'workspace', reasoningEffort: 'unsupported' } };
  await f.service.create(input);
  await until(() => f.store.getConversation(input.id)?.readiness === 'blocked');
  assert.equal(f.peer.createCalls, 0);
  const supported = { ...input, id: randomUUID(), configuration: { ...input.configuration, reasoningEffort: 'high' } };
  await f.service.create(supported);
  await until(() => f.store.getConversation(supported.id)?.readiness === 'ready');
  assert.equal(f.peer.createCalls, 1);
  assert.equal(f.store.getConversation(supported.id)?.binding?.configuration.reasoningEffort, 'high');
});

test('cold completed histories neither restore at startup nor acquire observers when read', async t => {
  const f = fixture(t);
  for (let index = 0; index < 80; index++) {
    const id = randomUUID();
    f.store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic/workspace', configuration: { modelId: 'model', permissionId: 'workspace' } });
    f.store.saveBinding(id, { id: 'cold-' + index, cwd: '/synthetic/workspace', configuration: { modelId: 'model', permissionId: 'workspace' }, details: {} });
    f.store.setConversationState(id, { readiness: 'ready', state: terminal() });
    await f.service.open(id);
  }
  // Opening reads exactly one native page; it never restores execution or acquires an observer.
  assert.equal(f.peer.historyCalls.length, 80);
  await f.service.start();
  assert.equal(f.peer.stateCalls, 0);
  assert.equal(f.peer.historyCalls.length, 80);
  assert.equal(f.peer.listener, undefined);
});

test('reading leases share observation, never poll idle history, and release after the last reader leaves', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  await f.service.reading(f.id, 'page-one');
  const listener = f.peer.listener;
  const reads = f.peer.stateCalls;
  await f.service.reading(f.id, 'page-two');
  assert.equal(f.peer.listener, listener);
  assert.equal(f.peer.stateCalls, reads);
  t.mock.timers.tick(6000);
  await Promise.resolve();
  assert.equal(f.peer.stateCalls, reads);
  assert.equal(f.peer.historyCalls.length, reads);
  f.service.releaseReading(f.id, 'page-one');
  t.mock.timers.tick(300);
  assert.equal(f.peer.unwatchCount, 0);
  f.service.releaseReading(f.id, 'page-two');
  t.mock.timers.tick(300);
  assert.equal(f.peer.unwatchCount, 1);
  assert.equal(f.peer.listener, undefined);
});

test('lost browser readers expire without a disconnect message', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  await f.service.reading(f.id, 'lost-page');
  const calls = f.peer.stateCalls;
  t.mock.timers.tick(46_000);
  t.mock.timers.tick(300);
  assert.equal(f.peer.listener, undefined);
  assert.equal(f.peer.unwatchCount, 1);
  assert.equal(f.peer.stateCalls, calls);
});

test('closing every reader retains execution observation until canonical terminal history is saved', async t => {
  const f = fixture(t);
  f.peer.current = { ...terminal('active-run'), status: 'running' };
  f.store.setConversationState(f.id, { state: f.peer.current });
  await f.service.reading(f.id, 'page');
  f.service.releaseReading(f.id, 'page');
  await delay(300);
  assert.equal(f.peer.unwatchCount, 0);
  const order: string[] = [];
  f.peer.historyRead = async () => { order.push('history'); return { items: [{ ...nativeItem('final'), runId: 'active-run' }], olderCursor: null }; };
  f.peer.current = terminal('active-run');
  f.peer.emit({ type: 'state', state: f.peer.current });
  await until(() => f.peer.unwatchCount === 1);
  assert.ok(order.includes('history'), 'the terminal native page is read before observation ends');
  assert.equal(f.peer.stopCalls.length, 0);
});

test('startup restores an old running conversation even outside the newest sixteen histories', async t => {
  const f = fixture(t);
  f.store.setConversationState(f.id, { state: { ...terminal('old-run'), status: 'running' } });
  const observed: string[] = [];
  const watch = f.peer.watch.bind(f.peer);
  f.peer.watch = async (binding, listener) => { observed.push(binding.id); return watch(binding, listener); };
  for (let index = 0; index < 25; index++) {
    const id = randomUUID();
    f.store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic/workspace', configuration: { modelId: 'model', permissionId: 'workspace' } });
    f.store.saveBinding(id, { id: 'cold-' + index, cwd: '/synthetic/workspace', configuration: { modelId: 'model', permissionId: 'workspace' }, details: {} });
    f.store.setConversationState(id, { readiness: 'ready', state: terminal() });
  }
  await f.service.start();
  await until(() => observed.length > 0);
  assert.deepEqual(observed, ['native-fixture']);
});

test('deletion fences new work and retries partial native success without restoring the deleted identity', async t => {
  const f = fixture(t);
  const deleting = deferred<void>();
  let calls = 0;
  const peer = f.peer as Peer & { delete: (binding: Binding) => Promise<void> };
  peer.delete = async () => { calls++; if (calls === 1) await deleting.promise; };
  await f.service.reading(f.id, 'page');
  const deletion = f.service.deleteConversation(f.id);
  const rejected = assert.rejects(deletion, /lost_reply/);
  await until(() => calls === 1);
  assert.equal(f.peer.listener, undefined);
  await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'conversation_deleting' });
  await assert.rejects(f.service.reading(f.id, 'other-page'), { code: 'conversation_deleting' });
  deleting.reject(new Error('lost_reply'));
  await rejected;
  assert.equal(f.store.deletions.get(f.id)?.status, 'failed');
  const reads = f.peer.stateCalls;
  await f.service.deleteConversation(f.id);
  assert.equal(f.peer.stateCalls, reads);
  assert.equal(calls, 2);
  assert.equal(f.store.deletions.get(f.id)?.status, 'completed');
  assert.equal(f.store.getConversation(f.id), null);
  await f.service.deleteConversation(f.id);
  assert.equal(calls, 2);
});

test('startup finishes already verified native deletion without reading or deleting native data again', async t => {
  const f = fixture(t);
  f.store.deletions.begin(f.id); f.store.deletions.nativeDone(f.id);
  await f.service.start();
  await until(() => f.store.deletions.get(f.id)?.status === 'completed');
  assert.equal(f.store.getConversation(f.id), null);
  assert.equal(f.peer.stateCalls, 0);
  assert.deepEqual(f.peer.historyCalls, []);
});


test('startup marks interrupted creation without a saved native identity as unresolved instead of creating again', async t => {
  const f = fixture(t);
  const id = randomUUID();
  f.store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic/workspace', configuration: { modelId: 'model', permissionId: 'workspace' } });
  await f.service.start();
  assert.equal(f.store.getConversation(id)?.readiness, 'blocked');
  assert.equal(f.store.getConversation(id)?.error, 'native_creation_result_unknown');
  assert.equal(f.peer.createCalls, 0);
});

test('deletion fences an older-page request suspended in its native read', async t => {
  const f = fixture(t);
  const page = deferred<HistoryPage>();
  f.peer.historyRead = async cursor => cursor === undefined ? { items: [nativeItem('latest')], olderCursor: '1' } : page.promise;
  const opened = await f.service.open(f.id);
  const older = f.service.history(f.id, opened.history.olderCursor!);
  const olderRejected = assert.rejects(older, { code: 'conversation_deleting' });
  await until(() => f.peer.historyCalls.includes('1'));
  const peer = f.peer as Peer & { delete: (binding: Binding) => Promise<void> };
  const nativeDelete = deferred<void>(); let deleted = 0; peer.delete = async () => { deleted++; await nativeDelete.promise; };
  const deletion = f.service.deleteConversation(f.id);
  assert.throws(() => f.service.renameConversation(f.id, 'cannot race deletion'), { code: 'conversation_deleting' });
  await until(() => deleted === 1);
  page.resolve({ items: [nativeItem('older')], olderCursor: null });
  await olderRejected;
  nativeDelete.resolve(); await deletion;
  assert.equal(f.store.getConversation(f.id), null);
});
test('startup recovery retains its cursor when 64 execution slots are occupied and admits the next after release', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const listeners = new Map<string, (change: NativeChange) => void>();
  let finished = false;
  f.peer.watch = async (binding, listener) => { listeners.set(binding.id, listener); return () => { listeners.delete(binding.id); }; };
  f.peer.state = async binding => binding.id === 'recovery-0' && finished ? terminal('run-0') : { ...terminal('run-' + binding.id), status: 'running' };
  for (let index = 0; index < 65; index++) {
    const id = '00000000-0000-4000-8000-' + String(index).padStart(12, '0');
    f.store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic/workspace', configuration: { modelId: 'model', permissionId: 'workspace' } });
    f.store.saveBinding(id, { id: 'recovery-' + index, cwd: '/synthetic/workspace', configuration: { modelId: 'model', permissionId: 'workspace' }, details: {} });
    f.store.setConversationState(id, { readiness: 'ready', state: { ...terminal('run-' + index), status: 'running' } });
  }
  const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
  await f.service.start(); await flush();
  assert.equal(listeners.size, 64);
  t.mock.timers.tick(5000); await flush();
  assert.equal(listeners.has('recovery-64'), false);
  finished = true;
  listeners.get('recovery-0')!({ type: 'state', state: terminal('run-0') });
  t.mock.timers.tick(125); await flush();
  t.mock.timers.tick(300); await flush();
  assert.equal(listeners.has('recovery-0'), false);
  t.mock.timers.tick(5000); await flush();
  assert.equal(listeners.has('recovery-64'), true);
  assert.equal(listeners.size, 64);
});

test('unknown native creation cannot be reported as fully deleted without its native identity', async t => {
  const f = fixture(t);
  const id = randomUUID();
  f.store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic/workspace', configuration: { modelId: 'model', permissionId: 'workspace' } });
  await f.service.start();
  await assert.rejects(f.service.deleteConversation(id), { code: 'conversation_preparation_incomplete' });
  assert.equal(f.store.deletions.get(id), null);
  assert.ok(f.store.getConversation(id));
});

test('a terminal canonical item closes an interrupted live delta even when the final event was missed', async t => {
  const f = fixture(t);
  f.peer.current = { ...terminal('run'), status: 'running' };
  await f.service.reading(f.id, 'page');
  f.peer.emit({ type: 'item', item: { ...nativeItem('reply'), runId: 'run', text: 'partial', status: 'running' } });
  f.peer.records = [{ ...nativeItem('reply'), runId: 'run', text: 'canonical complete response' }];
  f.peer.current = terminal('run');
  f.peer.emit({ type: 'invalidate' });
  await until(() => f.service.liveItem(f.id, 'reply')?.status === 'completed');
  assert.equal(f.service.liveItem(f.id, 'reply')?.text, 'canonical complete response');
  assert.equal(f.service.snapshot(f.id).history.liveItems.length, 0);
  f.service.releaseReading(f.id, 'page');
  await until(() => f.peer.unwatchCount === 1);
});

const finished = (runId: string, terminalStatus: 'completed' | 'interrupted' | 'failed'): NativeState => ({
  ...terminal(runId), status: terminalStatus === 'completed' ? 'idle' : terminalStatus, terminalRunId: runId, terminalStatus,
});

test('an unread result clears when a page reads it, a result arriving during reading is never unread, and seen survives release and restart', async t => {
  const f = fixture(t);
  const unread = (service = f.service, store = f.store) => service.unread([store.getConversation(f.id)!]).has(f.id);
  f.peer.current = finished('run-1', 'completed');
  f.store.setConversationState(f.id, { state: f.peer.current });
  assert.equal(unread(), true);
  assert.equal(f.service.attention().unread, 1);
  await f.service.reading(f.id, 'desktop');
  assert.equal(unread(), false); assert.equal(f.store.unseen([f.id]).size, 0, 'opening the conversation persists seen');
  // The result arrives while the page is visible: no device may show it as unread, before or after release.
  f.peer.current = finished('run-2', 'failed');
  f.peer.emit({ type: 'state', state: f.peer.current });
  await until(() => f.store.getConversation(f.id)?.state.terminalRunId === 'run-2');
  assert.equal(unread(), false);
  assert.deepEqual(f.service.attention(), { unread: 0, conversations: [{ conversation: f.store.getConversation(f.id)!, unread: false }] });
  f.service.releaseReading(f.id, 'desktop');
  assert.equal(unread(), false); assert.equal(f.store.unseen([f.id]).size, 0, 'release persists what the lease covered');
  // A hidden page renews with active:false; without a lease it saw nothing.
  f.store.setConversationState(f.id, { state: finished('run-3', 'completed') });
  f.service.releaseReading(f.id, 'hidden-page');
  assert.equal(unread(), true);
  await f.service.close(); f.closeDatabase();
  const db = openDatabase(f.directory, productMigrations);
  try {
    const store = createWorkbenchStore(db); const restarted = new Workbench(store, f.workspaces, new Map([['codex', new Peer()]]));
    assert.equal(unread(restarted, store), true, 'unread is durable server state');
    store.markSeen(f.id);
    assert.equal(unread(restarted, store), false);
    await restarted.close();
  } finally { db.close(); }
});

test('an expired reading lease marks the result it covered as seen', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  await f.service.reading(f.id, 'lost-page');
  f.store.setConversationState(f.id, { state: finished('run-1', 'completed') });
  assert.equal(f.service.unread([f.store.getConversation(f.id)!]).size, 0);
  assert.equal(f.store.unseen([f.id]).size, 1);
  t.mock.timers.tick(46_000);
  assert.equal(f.store.unseen([f.id]).size, 0);
  assert.equal(f.service.unread([f.store.getConversation(f.id)!]).size, 0);
});

test('stopping a run through the workbench is not unread; an interruption nobody requested is', async t => {
  const f = fixture(t);
  const unread = () => f.service.unread([f.store.getConversation(f.id)!]).has(f.id);
  f.peer.current = { ...terminal('stopped-run'), status: 'running' }; await f.service.reconcile(f.id);
  const stop: OperationInput = { id: randomUUID(), conversationId: f.id, type: 'stop', payload: { runId: 'stopped-run' } };
  await f.service.enqueue(stop);
  await until(() => f.store.getOperation(stop.id)?.status === 'accepted');
  f.peer.current = finished('stopped-run', 'interrupted'); await f.service.reconcile(f.id);
  assert.equal(f.store.getConversation(f.id)?.state.terminalStatus, 'interrupted');
  assert.equal(unread(), false);
  f.peer.current = { ...terminal('native-run'), status: 'running' }; await f.service.reconcile(f.id);
  f.peer.current = finished('native-run', 'interrupted'); await f.service.reconcile(f.id);
  assert.equal(unread(), true);
});
test('re-reading an unobserved conversation announces native page changes, never an unchanged page again', async t => {
  // The runtime of a conversation nobody observes is released shortly after each read (250 ms). Every open
  // page re-reads on an announcement, so announcing an unchanged page again would loop over the network (ADR 0019).
  const f = fixture(t); f.peer.records = [nativeItem('a'), nativeItem('b')];
  const released = () => delay(400);
  await f.service.open(f.id); await released();
  const before = f.store.version(); const reads = f.peer.historyCalls.length;
  for (let index = 0; index < 3; index++) { await f.service.open(f.id); await released(); }
  assert.equal(f.peer.historyCalls.length, reads + 3, 'each open re-reads native history after release');
  assert.equal(f.store.version(), before, 'an unchanged native page is not announced again');
  f.peer.records.push(nativeItem('c'));
  await f.service.open(f.id); await released();
  const changed = f.store.version(); assert.ok(changed > before, 'a changed native page is announced');
  f.peer.historyRead = async () => { throw new Error('native_down'); };
  await f.service.open(f.id); await released();
  const failing = f.store.version(); assert.ok(failing > changed, 'a new reading failure is announced');
  await f.service.open(f.id); await released();
  assert.equal(f.store.version(), failing, 'a repeated reading failure is not announced again');
});
test('live growth reaches listeners as appended text and writes no change rows (ADR 0019)', async t => {
  const f = fixture(t); const frames: LiveEvent[] = [];
  f.service.onLive(batch => frames.push(...batch));
  await f.service.reading(f.id, 'live-reader');
  const before = f.store.version(); const start = f.service.liveCursor().sequence;
  f.peer.emit({ type: 'item', item: { id: 'reply', kind: 'assistant', status: 'running', text: 'Hello' } });
  await until(() => frames.length === 1);
  f.peer.emit({ type: 'item', item: { id: 'reply', kind: 'assistant', status: 'running', text: 'Hello, world' } });
  await until(() => frames.length === 2);
  f.peer.emit({ type: 'item', item: { id: 'reply', kind: 'assistant', status: 'running', text: 'Rewritten' } });
  await until(() => frames.length === 3);
  assert.deepEqual(frames.map(frame => 'item' in frame ? frame.text : null), [{ value: 'Hello' }, { at: 5, append: ', world' }, { value: 'Rewritten' }]);
  assert.deepEqual(frames.map(frame => frame.sequence), [start + 1, start + 2, start + 3]);
  assert.equal(f.store.version(), before, 'in-flight growth is not a durable change');
  assert.equal(f.service.snapshot(f.id).live?.sequence, start + 3);
});

test('what a run did before observation started reaches the observers through the next changed history read (ADR 0021)', async t => {
  const f = fixture(t);
  const seen: string[][] = [];
  f.service.onObserved((id, items) => { if (id === f.id) seen.push(items.map(item => item.id)); });
  const notice: NativeItem = { id: 'tool-1', kind: 'tool', text: '', status: 'completed', tool: { name: 'mcp__zhongshu__notify_user', output: '已通知用户。' } };
  f.peer.historyRead = async () => ({ items: [nativeItem('reply'), notice], olderCursor: null });
  await f.service.noticeActivity(f.id);
  await until(() => seen.some(ids => ids.includes('tool-1')));
  const reports = seen.length;
  await f.service.noticeActivity(f.id);
  await delay(30);
  assert.equal(seen.length, reports, 'reading an unchanged page reports nothing again');
});

test('idle automation runs archive after the retention period and stay readable under their task (ADR 0025)', async t => {
  const f = fixture(t);
  const configuration = { modelId: 'model', permissionId: 'workspace' };
  const adopt = (native: string) => f.store.adoptConversation({ id: randomUUID(), harnessId: 'dsh', workspaceId: 'fixture',
    cwd: f.workspaces[0]!.directory, title: '运行', configuration,
    binding: { id: native, cwd: f.workspaces[0]!.directory, configuration, details: {} }, automationId: 'task-1' });
  const idle = adopt('native-idle'); const busy = adopt('native-busy');
  f.store.setConversationState(idle.id, { state: terminal() });
  f.store.setConversationState(busy.id, { state: { status: 'running', runId: 'run-busy', pendingInputs: 0, configurationVerified: true } });
  const old = Date.now() - 91 * 24 * 60 * 60_000;
  f.db.prepare('UPDATE workbench_conversations SET last_activity_at=? WHERE id IN (?,?)').run(old, idle.id, busy.id);
  assert.equal(f.service.archiveIdleAutomations(), 1);
  assert.equal(f.store.getConversation(idle.id)?.archived, true);
  assert.equal(f.store.getConversation(busy.id)?.archived, false, 'a running run is never archived');
  assert.deepEqual(f.store.listConversations({ automationId: 'task-1' }).map(row => row.id).sort(), [idle.id, busy.id].sort(),
    'archived runs stay in the task history');
  assert.equal(f.store.getConversation(idle.id)?.binding?.id, 'native-idle', 'archiving keeps the full native identity');
  assert.equal(f.service.archiveIdleAutomations(), 0, 'the next pass has nothing left to archive');
});

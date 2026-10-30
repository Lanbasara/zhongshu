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

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const terminal = (runId?: string): NativeState => ({ status: 'idle', pendingInputs: 0, configurationVerified: true, ...(runId ? { runId } : {}) });
const nativeItem = (id: string): NativeItem => ({ id, kind: 'assistant', text: 'full-' + id, status: 'completed' });
const operation = (conversationId: string): OperationInput => ({ id: randomUUID(), conversationId, type: 'message', payload: { text: 'synthetic request' } });
async function until(predicate: () => boolean) { const until = Date.now() + 2000; while (!predicate()) { if (Date.now() > until) throw new Error('condition_timeout'); await delay(1); } }

/** Deterministic native-contract peer. These fault tests do not claim real Harness or browser acceptance. */
class Peer implements HarnessAdapter {
  readonly id = 'codex' as const;
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
  async reconcile(_binding: Binding, id: string): Promise<Receipt> { this.reconcileCalls.push(id); return { outcome: 'unknown', reason: 'not_found' }; }
  async stop(_binding: Binding, runId: string): Promise<Receipt> { this.stopCalls.push(runId); return { outcome: 'accepted', runId }; }
  async watch(_binding: Binding, listener: (change: NativeChange) => void) { this.listener = listener; return () => { this.listener = undefined; this.unwatchCount++; }; }
  emit(change: NativeChange) { this.listener?.(change); }
  async close() { this.closed = true; this.listener = undefined; await this.closeRead?.(); }
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'zhongshu-service-')); const db = openDatabase(directory, productMigrations);
  const store = createWorkbenchStore(db); const peer = new Peer(); const workspaces = [{ id: 'fixture', label: 'fixture', directory: '/synthetic/workspace' }];
  const service = new Workbench(store, workspaces, new Map([['codex', peer]]));
  const id = randomUUID(); const configuration = { modelId: 'model', permissionId: 'workspace' };
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: workspaces[0]!.directory, configuration });
  store.saveBinding(id, { id: 'native-fixture', cwd: workspaces[0]!.directory, configuration, details: {} });
  store.setConversationState(id, { readiness: 'ready', state: terminal() }); store.setHistoryCursor(id, { loaded: true, olderCursor: null, beforeItemId: null });
  let databaseClosed = false;
  const closeDatabase = () => { if (!databaseClosed) { db.close(); databaseClosed = true; } };
  t.after(async () => { await service.close(); closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
  return { db, store, peer, service, id, workspaces, closeDatabase };
}

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
  f.store.saveLiveItem(f.id, { ...user, id: 'ambiguous', runId: 'other-run' });
  assert.equal(f.store.operationRunId(f.id, accepted.id), null);
});

test('snapshots show the latest 100 operations, while older unresolved operations still block sending', async t => {
  const f = fixture(t); const unknown = operation(f.id); f.store.enqueueOperation(unknown); f.store.claimOperation(unknown.id); f.store.settleOperation(unknown.id, { outcome: 'unknown', reason: 'old_unknown' });
  const ids: string[] = [];
  for (let index = 0; index < 140; index++) { const value = operation(f.id); ids.push(value.id); f.store.enqueueOperation(value); f.store.claimOperation(value.id); f.store.settleOperation(value.id, { outcome: 'accepted', runId: 'run-' + index }); }
  f.store.setConversationState(f.id, { state: terminal('run-139') });
  const snapshot = f.service.snapshot(f.id); assert.equal(snapshot.operations.length, 100); assert.equal(snapshot.operations[0]?.id, ids.at(-1)); assert.equal(snapshot.operations.at(-1)?.id, ids[40]);
  await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'operation_needs_reconciliation' }); assert.equal(f.peer.submitCalls.length, 0);
});

test('a disconnected gap larger than one page is bridged to canonical history; live IDs are not false intersections', async t => {
  const f = fixture(t); const records = Array.from({ length: 251 }, (_, index) => nativeItem('item-' + index));
  f.store.mergeHistory(f.id, [records[0]!]); f.store.saveLiveItem(f.id, records[250]!); f.peer.records = records;
  await f.service.reconcile(f.id);
  assert.deepEqual(f.peer.historyCalls.slice(0, 3), [undefined, '151', '51']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM workbench_items WHERE conversation_id=?').get(f.id)?.count, 251);
  assert.equal(f.store.hasHistoryItem(f.id, 'item-100'), true); assert.equal(f.store.readHistory(f.id).liveItems.length, 0);
  const snapshot = f.service.snapshot(f.id); assert.equal(snapshot.history.items[0]?.id, 'item-151'); assert.equal(snapshot.history.items.at(-1)?.id, 'item-250');
});

test('gap bounds and cursor cycles retain explicit unknown state rather than committing a discontinuous latest page', async t => {
  const f = fixture(t); f.store.mergeHistory(f.id, [nativeItem('old-anchor')]); f.peer.records = Array.from({ length: 1100 }, (_, index) => nativeItem('new-' + index));
  await f.service.reconcile(f.id); assert.equal(f.store.getConversation(f.id)?.state.status, 'unknown'); assert.equal(f.store.getConversation(f.id)?.error, 'history_gap_limit');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM workbench_items').get()?.count, 1); assert.equal(f.store.hasHistoryItem(f.id, 'new-1099'), false);
  f.peer.historyRead = async () => ({ items: [nativeItem('new-page')], olderCursor: 'cycle' });
  await f.service.reconcile(f.id); assert.equal(f.store.getConversation(f.id)?.error, 'history_no_progress');
  await assert.rejects(f.service.enqueue(operation(f.id)), { code: 'operation_needs_reconciliation' });
});

test('invalidate during sync forces another read, and a late state result cannot overwrite a newer native event', async t => {
  const f = fixture(t); const old = deferred<NativeState>(); let first = true;
  f.peer.stateRead = async () => { if (first) { first = false; return old.promise; } return f.peer.current; };
  const syncing = f.service.reconcile(f.id); await until(() => f.peer.stateCalls === 1);
  f.peer.current = { status: 'running', runId: 'new-run', pendingInputs: 0, configurationVerified: true };
  f.peer.emit({ type: 'state', state: f.peer.current }); f.peer.emit({ type: 'invalidate' }); old.resolve(terminal('old-run'));
  await syncing; assert.ok(f.peer.stateCalls >= 2); assert.equal(f.store.getConversation(f.id)?.state.runId, 'new-run'); assert.equal(f.store.getConversation(f.id)?.state.status, 'running');
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
  assert.equal(f.store.getItem(f.id, 'streaming-body')?.text, 'partial-' + updates);
});

test('a dirty history read is repeated and does not overwrite a later complete live body', async t => {
  const f = fixture(t); const old = deferred<HistoryPage>(); let first = true;
  f.peer.historyRead = async () => { if (first) { first = false; return old.promise; } return { items: [nativeItem('same-id')], olderCursor: null }; };
  const syncing = f.service.reconcile(f.id); await until(() => f.peer.historyCalls.length === 1);
  f.peer.emit({ type: 'item', item: { ...nativeItem('same-id'), text: 'new complete body' } }); f.peer.emit({ type: 'invalidate' });
  old.resolve({ items: [{ ...nativeItem('same-id'), text: 'old body' }], olderCursor: null });
  await syncing;
  assert.ok(f.peer.historyCalls.length >= 2); assert.equal(f.store.getItem(f.id, 'same-id')?.text, 'new complete body');
  f.peer.historyRead = async () => ({ items: [{ ...nativeItem('same-id'), text: 'new complete body' }], olderCursor: null });
  await f.service.reconcile(f.id); assert.equal(f.store.getItem(f.id, 'same-id')?.text, 'new complete body');
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
  assert.equal(observed, false); assert.equal(f.store.version(), before); assert.equal(f.store.hasHistoryItem(f.id, 'late-history'), false); f.closeDatabase();
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

test('shutdown persists the latest complete live item even before its batching timer fires', async t => {
  const f = fixture(t); await f.service.reconcile(f.id);
  f.peer.emit({ type: 'item', item: { ...nativeItem('pending-live'), text: 'latest complete live body' } });
  await f.service.close(); assert.equal(f.store.getItem(f.id, 'pending-live')?.text, 'latest complete live body');
  f.closeDatabase(); await delay(45);
});


test('older paging crosses an empty native record page when its cursor advances', async t => {
  const f = fixture(t); f.store.mergeHistory(f.id, [nativeItem('known')]);
  f.store.setHistoryCursor(f.id, { loaded: true, olderCursor: 'empty-record-page', beforeItemId: 'known' });
  f.peer.historyRead = async cursor => cursor === undefined ? { items: [nativeItem('known')], olderCursor: 'empty-record-page' }
    : cursor === 'empty-record-page' ? { items: [], olderCursor: 'older-body-page' }
      : { items: [nativeItem('older')], olderCursor: null };
  const snapshot = await f.service.older(f.id, 'known'); assert.deepEqual(snapshot.history.items.map(item => item.id), ['older']);
  assert.equal(snapshot.history.nativeOlderCursor, null);
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

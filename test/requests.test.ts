import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { Binding, Catalog, Configuration, HarnessAdapter, HistoryPage, NativeChange, NativeRequest, NativeState, Receipt, SubagentSnapshot } from '../src/harness/types.ts';
import type { RequestAnswer } from '../src/shared/workbench.ts';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { Workbench } from '../src/server/workbench.ts';

const waiting = (): NativeState => ({ status: 'waiting', runId: 'run', pendingInputs: 0, configurationVerified: true });
async function until(predicate: () => boolean) { const end = Date.now() + 3000; while (!predicate()) { if (Date.now() > end) throw new Error('condition_timeout'); await delay(2); } }

/** Deterministic native peer for the request contract (ADR 0016). It proves workbench rules, not real Harness behaviour. */
class Peer implements HarnessAdapter {
  readonly id = 'codex' as const;
  open: NativeRequest[] = [];
  answers: { requestId: string; answer: RequestAnswer }[] = [];
  answerWith?: (requestId: string) => Promise<Receipt>;
  tree: SubagentSnapshot = { agents: [] };
  nativeState: NativeState = waiting();
  listener?: (change: NativeChange) => void;
  async catalog(): Promise<Catalog> { return { id: 'codex', available: true, models: [{ id: 'model', label: 'model' }], permissions: [{ id: 'workspace', label: 'workspace', description: 'synthetic' }] }; }
  async create(input: { cwd: string; configuration: Configuration }, bound: (value: Binding) => void): Promise<Binding> { const value = { id: 'root', cwd: input.cwd, configuration: input.configuration, details: {} }; bound(value); return value; }
  async state(): Promise<NativeState> { return this.nativeState; }
  async history(): Promise<HistoryPage> { return { items: [], olderCursor: null }; }
  async submit(): Promise<Receipt> { return { outcome: 'accepted', runId: 'run' }; }
  async reconcile(): Promise<Receipt> { return { outcome: 'unknown', reason: 'not_found' }; }
  async stop(_binding: Binding, runId: string): Promise<Receipt> { return { outcome: 'accepted', runId }; }
  async watch(_binding: Binding, listener: (change: NativeChange) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  async close() { this.listener = undefined; }
  async subagents(): Promise<SubagentSnapshot> { return structuredClone(this.tree); }
  async requests(): Promise<NativeRequest[]> { return structuredClone(this.open); }
  async answer(_binding: Binding, requestId: string, answer: RequestAnswer): Promise<Receipt> {
    this.answers.push({ requestId, answer });
    if (this.answerWith) return this.answerWith(requestId);
    this.open = this.open.filter(request => request.id !== requestId);
    return { outcome: 'accepted' };
  }
  emit(change: NativeChange) { this.listener?.(change); }
}

const approval = (id = 'cx_approval', agentId?: string): NativeRequest => ({ id, kind: 'approval', createdAt: 1000, ...(agentId ? { agentId } : {}),
  approval: { action: 'command', command: 'curl -sS https://example.com', reason: 'network', decisions: ['accept', 'cancel'] } });
const question: NativeRequest = { id: 'ds_question', kind: 'question', createdAt: 2000,
  questions: [{ id: 'format', text: 'Which format?', multiple: false, custom: true, options: [{ label: 'Markdown' }, { label: 'HTML' }] }] };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'zhongshu-requests-')); const db = openDatabase(directory, productMigrations);
  const store = createWorkbenchStore(db); const peer = new Peer(); const workspaces = [{ id: 'fixture', label: 'fixture', directory: '/synthetic/workspace' }];
  const service = new Workbench(store, workspaces, new Map([['codex', peer]]));
  const id = randomUUID(); const configuration = { modelId: 'model', permissionId: 'workspace' };
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: workspaces[0]!.directory, configuration });
  store.saveBinding(id, { id: 'root', cwd: workspaces[0]!.directory, configuration, details: {} });
  store.setConversationState(id, { readiness: 'ready', state: waiting() });
  t.after(async () => { await service.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  await service.reading(id, 'reader-1');
  await until(() => !!peer.listener);
  const requests = () => service.snapshot(id).requests ?? [];
  const announce = async (expected: number) => { peer.emit({ type: 'requests' }); await until(() => requests().filter(request => request.status === 'open').length === expected); };
  return { db, store, peer, service, id, requests, announce };
}

test('open native requests appear in the snapshot; one answer is delivered and every device sees it answered', async t => {
  const f = await fixture(t);
  f.peer.tree = { agents: [{ id: 'child-a', parentId: 'root', name: '检查员', status: 'running' }] };
  await f.service.subagents(f.id);
  f.peer.open = [approval(), approval('cx_child', 'child-a'), question];
  await f.announce(3);
  const [first, child, asked] = f.requests();
  assert.deepEqual([first!.id, first!.status, first!.agent], ['cx_approval', 'open', undefined]);
  assert.deepEqual(child!.agent, { id: 'child-a', name: '检查员' }, 'a sub-agent request names its asker');
  assert.equal(asked!.kind, 'question');
  // Answers that do not fit the request are refused before anything is stored.
  assert.throws(() => f.service.answerRequest(f.id, 'cx_approval', randomUUID(), { kind: 'approval', decision: 'decline' }), { code: 'answer_invalid' });
  assert.throws(() => f.service.answerRequest(f.id, 'ds_question', randomUUID(), { kind: 'question', answers: [{ id: 'other', selected: [] }] }), { code: 'answer_invalid' });
  assert.throws(() => f.service.answerRequest(f.id, 'cx_missing', randomUUID(), { kind: 'approval', decision: 'accept' }), { code: 'request_not_found' });
  const answerId = randomUUID();
  const queued = f.service.answerRequest(f.id, 'cx_approval', answerId, { kind: 'approval', decision: 'accept' });
  assert.equal(queued.summary, '允许运行');
  await until(() => f.requests().find(request => request.id === 'cx_approval')?.status === 'answered');
  const answered = f.requests().find(request => request.id === 'cx_approval')!;
  assert.deepEqual([answered.answer?.status, answered.answer?.summary], ['accepted', '允许运行']);
  assert.deepEqual(f.peer.answers, [{ requestId: 'cx_approval', answer: { kind: 'approval', decision: 'accept' } }]);
  assert.equal(f.service.answerRequest(f.id, 'cx_approval', answerId, { kind: 'approval', decision: 'accept' }).id, answerId, 'retrying the same identity returns the same answer');
  assert.throws(() => f.service.answerRequest(f.id, 'cx_approval', randomUUID(), { kind: 'approval', decision: 'accept' }), { code: 'request_not_open' }, 'a second device cannot answer again');
  assert.throws(() => f.service.answerRequest(f.id, 'ds_question', answerId, { kind: 'question', answers: [{ id: 'format', selected: ['HTML'] }] }), { code: 'operation_id_conflict' });
  const row = f.db.prepare('SELECT answer_json, summary FROM workbench_request_answers WHERE id=?').get(answerId) as { answer_json: string | null; summary: string };
  assert.deepEqual([row.answer_json, row.summary], [null, '允许运行'], 'the submitted answer is cleared once delivery settles');
});

test('an unconfirmed answer is never resent; a request still open afterwards reopens for a new answer', async t => {
  const f = await fixture(t);
  f.peer.open = [approval()];
  await f.announce(1);
  f.peer.answerWith = async () => ({ outcome: 'unknown', reason: 'codex_answer_unconfirmed' });
  const lost = f.service.answerRequest(f.id, 'cx_approval', randomUUID(), { kind: 'approval', decision: 'cancel' });
  await until(() => f.store.requests.get(lost.id)?.status !== 'queued' && f.store.requests.get(lost.id)?.status !== 'dispatching');
  // The native side still holds the request: the unconfirmed answer was not taken.
  const settled = await f.service.reconcileAnswer(f.id, lost.id);
  assert.deepEqual([settled.status, settled.reason], ['rejected', 'answer_not_delivered']);
  assert.equal(f.peer.answers.length, 1, 'reconciliation reads; it never resends');
  f.peer.answerWith = undefined;
  const retry = f.service.answerRequest(f.id, 'cx_approval', randomUUID(), { kind: 'approval', decision: 'accept' });
  await until(() => f.store.requests.get(retry.id)?.status === 'accepted');
  assert.equal(f.peer.answers.length, 2);
});

test('a request that disappears unanswered expires, but not while observation is unverified', async t => {
  const f = await fixture(t);
  f.peer.open = [question];
  await f.announce(1);
  f.store.setConversationState(f.id, { state: { status: 'unknown', pendingInputs: 0, configurationVerified: false, reason: 'codex_disconnected' } });
  f.peer.open = [];
  f.peer.emit({ type: 'requests' }); await delay(120);
  assert.equal(f.requests()[0]?.status, 'open', 'a lost connection cannot vouch that the request is gone');
  f.store.setConversationState(f.id, { state: { ...waiting(), status: 'interrupted' } });
  f.peer.emit({ type: 'requests' });
  await until(() => f.requests()[0]?.status === 'expired');
  assert.throws(() => f.service.answerRequest(f.id, 'ds_question', randomUUID(), { kind: 'question', answers: [{ id: 'format', selected: ['HTML'] }] }), { code: 'request_not_open' });
});

test('a restart turns an answer caught mid-delivery into unknown and keeps the conversation observed', async t => {
  const f = await fixture(t);
  f.peer.open = [approval()];
  await f.announce(1);
  let release!: (receipt: Receipt) => void;
  f.peer.answerWith = () => new Promise(resolve => { release = resolve; });
  const pending = f.service.answerRequest(f.id, 'cx_approval', randomUUID(), { kind: 'approval', decision: 'accept' });
  await until(() => f.store.requests.get(pending.id)?.status === 'dispatching');
  assert.equal(f.store.requests.busy(f.id), true, 'an unsettled answer is execution responsibility');
  const unsent = randomUUID();
  f.store.requests.enqueue({ id: unsent, conversationId: f.id, requestId: 'cx_other', answer: { kind: 'approval', decision: 'accept' }, summary: '允许运行' });
  assert.equal(f.store.requests.recoverDispatching(), 1);
  assert.deepEqual([f.store.requests.get(pending.id)?.status, f.store.requests.get(pending.id)?.answer], ['unknown', null]);
  assert.deepEqual([f.store.requests.get(unsent)?.status, f.store.requests.get(unsent)?.reason, f.store.requests.get(unsent)?.answer], ['rejected', 'answer_not_sent', null], 'an answer that never left the process is refused, not stuck');
  release({ outcome: 'accepted' });
});

test('the card and the server describe an answer in the same words', async () => {
  const shared = await import('../src/shared/requests.ts');
  const card = await import('../src/web/patterns/request-words.ts');
  for (const action of ['command', 'fileChange', 'permissions', 'other'] as const)
    for (const decision of ['accept', 'acceptForSession', 'decline', 'cancel'] as const)
      assert.equal(card.decisionLabel(decision, action), shared.decisionLabel(decision, action));
  const answers: RequestAnswer[] = [
    { kind: 'question', answers: [{ id: 'a', selected: ['Markdown', 'HTML'], custom: ' 附表 ' }, { id: 'b', selected: [] }] },
    { kind: 'form', action: 'decline' }, { kind: 'approval', decision: 'acceptForSession' },
  ];
  for (const answer of answers) assert.equal(card.answerSummary({ approval: { action: 'command', decisions: ['accept'] } }, answer), shared.answerSummary({ approval: { action: 'command', decisions: ['accept'] } }, answer));
});

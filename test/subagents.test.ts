import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { Binding, Catalog, Configuration, HarnessAdapter, HistoryPage, NativeChange, NativeState, Receipt, SubagentHistory, SubagentSnapshot } from '../src/harness/types.ts';
import { HarnessError } from '../src/harness/types.ts';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { Workbench } from '../src/server/workbench.ts';

const idle = (): NativeState => ({ status: 'idle', pendingInputs: 0, configurationVerified: true });
async function until(predicate: () => boolean) { const end = Date.now() + 3000; while (!predicate()) { if (Date.now() > end) throw new Error('condition_timeout'); await delay(2); } }

/** Deterministic native peer for the sub-agent contract. It proves workbench rules, not real Harness behaviour. */
class Peer implements HarnessAdapter {
  readonly id = 'codex' as const;
  tree: SubagentSnapshot = { agents: [] };
  listener?: (change: NativeChange) => void;
  subagentReads = 0; stopCalls: string[] = []; observed: string[] = []; released: string[] = [];
  stopRead?: (agentId: string) => Promise<Receipt>;
  treeRead?: () => Promise<SubagentSnapshot>;
  async catalog(): Promise<Catalog> { return { id: 'codex', available: true, models: [{ id: 'model', label: 'model' }], permissions: [{ id: 'workspace', label: 'workspace', description: 'synthetic' }] }; }
  async create(input: { cwd: string; configuration: Configuration }, bound: (value: Binding) => void): Promise<Binding> { const value = { id: 'root', cwd: input.cwd, configuration: input.configuration, details: {} }; bound(value); return value; }
  async state(): Promise<NativeState> { return idle(); }
  records: HistoryPage['items'] = [];
  async history(): Promise<HistoryPage> { return { items: structuredClone(this.records), olderCursor: null }; }
  async submit(): Promise<Receipt> { return { outcome: 'accepted', runId: 'run' }; }
  async reconcile(): Promise<Receipt> { return { outcome: 'unknown', reason: 'not_found' }; }
  async stop(_binding: Binding, runId: string): Promise<Receipt> { return { outcome: 'accepted', runId }; }
  async watch(_binding: Binding, listener: (change: NativeChange) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  async close() { this.listener = undefined; }
  async subagents(): Promise<SubagentSnapshot> { this.subagentReads++; return this.treeRead ? this.treeRead() : structuredClone(this.tree); }
  async subagentHistory(_binding: Binding, agentId: string): Promise<SubagentHistory> {
    if (!this.tree.agents.some(agent => agent.id === agentId)) throw new HarnessError('subagent_not_owned');
    return { brief: 'delegated instruction', olderCursor: null, items: [
      { id: 'a1', kind: 'assistant', text: 'child reply', status: 'completed', runId: 'child-run' },
      { id: 'img', kind: 'assistant', text: '', status: 'completed', imageSources: [{ data: 'AAAA' }], images: [{ id: randomUUID(), name: 'x.png', mediaType: 'image/png' }] },
    ] };
  }
  async observeSubagent(_binding: Binding, agentId: string) { this.observed.push(agentId); return () => { this.released.push(agentId); }; }
  async stopSubagent(_binding: Binding, agentId: string): Promise<Receipt> { this.stopCalls.push(agentId); return this.stopRead ? this.stopRead(agentId) : { outcome: 'accepted' }; }
  emit(change: NativeChange) { this.listener?.(change); }
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'zhongshu-subagents-')); const db = openDatabase(directory, productMigrations);
  const store = createWorkbenchStore(db); const peer = new Peer(); const workspaces = [{ id: 'fixture', label: 'fixture', directory: '/synthetic/workspace' }];
  const service = new Workbench(store, workspaces, new Map([['codex', peer]]));
  const id = randomUUID(); const configuration = { modelId: 'model', permissionId: 'workspace' };
  store.createConversation({ id, harnessId: 'codex', workspaceId: 'fixture', cwd: workspaces[0]!.directory, configuration });
  store.saveBinding(id, { id: 'root', cwd: workspaces[0]!.directory, configuration, details: {} });
  store.setConversationState(id, { readiness: 'ready', state: idle() });
  t.after(async () => { await service.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, store, peer, service, id };
}
const running = { id: 'child-a', parentId: 'root', name: 'browser_a', task: 'core journey', status: 'running' as const, startedAt: 1000 };
const nested = { id: 'child-b', parentId: 'child-a', name: 'rollout', status: 'completed' as const, endedAt: 2000 };

test('the native tree becomes an index with ownership, nesting and conversation summaries; transcripts are read through', async t => {
  const f = fixture(t);
  f.peer.tree = { agents: [running, nested, { id: 'external', parentId: 'root', name: 'codex-check', status: 'completed', external: true }] };
  const list = await f.service.subagents(f.id);
  assert.deepEqual(list.agents.map(agent => [agent.id, agent.status, agent.spawnedBy ?? null]), [['child-a', 'running', null], ['child-b', 'completed', 'browser_a'], ['external', 'completed', null]]);
  assert.equal(list.stale, false);
  assert.deepEqual(f.store.getConversation(f.id)!.subagents, { total: 3, running: 1, unverified: 0, resultsPending: false, revision: 1 });
  assert.equal(f.store.recoverableConversations('').includes(f.id), true, 'a running sub-agent is execution responsibility');
  const page = await f.service.subagentHistory(f.id, 'child-a');
  assert.equal(page.brief, 'delegated instruction');
  assert.deepEqual(page.items.map(item => [item.id, item.text, 'images' in item]), [['a1', 'child reply', false], ['img', '子 Agent 生成的图片暂不在此显示。', false]]);
  assert.deepEqual(await f.service.subagentHistory(f.id, 'external'), { items: [], olderCursor: null });
  await assert.rejects(f.service.subagentHistory(f.id, 'other-conversation-agent'), { code: 'subagent_not_found' });
  await assert.rejects(f.service.subagentHistory(f.id, '../escape'), { code: 'invalid_request' });
  await assert.rejects(f.service.subagentHistory(f.id, 'a..b'), { code: 'invalid_request' }, 'dot segments are refused even without a slash');
  assert.ok((['workbench_items', 'workbench_live_items'].every(name => !f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name))), 'child transcripts are never stored');
});

test('lost observation downgrades every surface to unverified and refuses stops until a verified read', async t => {
  const f = fixture(t);
  f.peer.tree = { agents: [running] };
  await f.service.subagents(f.id);
  f.peer.treeRead = async () => { throw new Error('host_unreachable'); };
  await f.service.subagents(f.id);
  const list = f.store.subagents.view(f.id);
  assert.equal(list.stale, true);
  assert.deepEqual([list.agents[0]!.status, list.agents[0]!.lastStatus], ['unknown', 'running']);
  assert.deepEqual(f.store.getConversation(f.id)!.subagents, { total: 1, running: 0, unverified: 1, resultsPending: false, revision: 2 });
  assert.throws(() => f.service.stopSubagent(f.id, 'child-a', randomUUID()), { code: 'subagent_state_unverified' });
  f.peer.treeRead = undefined;
  assert.equal((await f.service.subagents(f.id)).stale, false);
});

test('stop is one durable operation per identity; a different target is a conflict and a finished agent cannot be stopped', async t => {
  const f = fixture(t);
  f.peer.tree = { agents: [running, { ...running, id: 'child-c', name: 'browser_b' }] };
  await f.service.subagents(f.id);
  const id = randomUUID();
  const first = f.service.stopSubagent(f.id, 'child-a', id);
  assert.equal(first.agentId, 'child-a');
  f.peer.tree = { agents: [{ ...running, status: 'interrupted', endedAt: 3000 }, { ...running, id: 'child-c', name: 'browser_b' }] };
  await until(() => f.store.subagents.getStop(id)?.status === 'accepted');
  assert.equal(f.service.stopSubagent(f.id, 'child-a', id).id, id, 'retrying the same identity returns the same request');
  assert.throws(() => f.service.stopSubagent(f.id, 'child-c', id), { code: 'operation_id_conflict' });
  assert.deepEqual(f.peer.stopCalls, ['child-a']);
  await until(() => f.store.subagents.view(f.id).agents[0]!.status === 'interrupted');
  assert.throws(() => f.service.stopSubagent(f.id, 'child-a', randomUUID()), { code: 'subagent_not_running' });
});

test('an unknown stop receipt is reconciled only from a verified read and is never resent', async t => {
  const f = fixture(t);
  f.peer.tree = { agents: [running] };
  await f.service.subagents(f.id);
  f.peer.stopRead = async () => { throw new Error('connection_lost'); };
  const id = randomUUID();
  f.service.stopSubagent(f.id, 'child-a', id);
  await until(() => f.store.subagents.getStop(id)?.status === 'unknown');
  assert.equal((await f.service.reconcileSubagentStop(f.id, id)).status, 'unknown', 'still running: the result stays unknown');
  f.peer.tree = { agents: [{ ...running, status: 'interrupted', endedAt: 3000 }] };
  assert.equal((await f.service.reconcileSubagentStop(f.id, id)).status, 'accepted');
  assert.deepEqual(f.peer.stopCalls, ['child-a'], 'reconciliation never calls the native stop again');
  await assert.rejects(f.service.reconcileSubagentStop(randomUUID(), id), { code: 'operation_not_found' });
});

test('running sub-agents block archive and keep execution responsibility; settled agents release it', async t => {
  const f = fixture(t);
  f.peer.tree = { agents: [running] };
  await f.service.subagents(f.id);
  await assert.rejects(f.service.setArchived(f.id, true), { code: 'subagents_running' });
  f.peer.tree = { agents: [{ ...running, status: 'completed', endedAt: 4000 }] };
  const archived = await f.service.setArchived(f.id, true);
  assert.equal(archived.archived, true);
  assert.equal(f.store.recoverableConversations('').includes(f.id), false);
});

test('native hints coalesce: transcript growth bumps one agent revision, structural hints re-read the tree', async t => {
  const f = fixture(t);
  f.peer.tree = { agents: [running] };
  await f.service.reading(f.id, randomUUID());
  await until(() => f.store.subagents.view(f.id).agents.length === 1);
  const before = f.store.subagents.view(f.id).agents[0]!.revision;
  const reads = f.peer.subagentReads;
  for (let index = 0; index < 20; index++) f.peer.emit({ type: 'subagents', agentId: 'child-a', transcript: true });
  await until(() => f.store.subagents.view(f.id).agents[0]!.revision === before + 1);
  await delay(450);
  assert.equal(f.peer.subagentReads, reads, 'transcript growth does not re-read the native tree');
  f.peer.tree = { agents: [{ ...running, status: 'completed', endedAt: 5000 }] };
  f.peer.emit({ type: 'subagents', agentId: 'child-a' });
  await until(() => f.store.subagents.view(f.id).agents[0]!.status === 'completed');
});

test('a reading lease observes one owned sub-agent and releases it when the reader leaves', async t => {
  const f = fixture(t);
  f.peer.tree = { agents: [running] };
  await f.service.subagents(f.id);
  const reader = randomUUID();
  await f.service.readingSubagent(f.id, 'child-a', reader, true);
  assert.deepEqual(f.peer.observed, ['child-a']);
  await assert.rejects(f.service.readingSubagent(f.id, 'unknown-agent', randomUUID(), true), { code: 'subagent_not_found' });
  await f.service.readingSubagent(f.id, 'child-a', reader, false);
  assert.deepEqual(f.peer.released, ['child-a']);
});

test('a dispatching stop interrupted by a restart becomes unknown, and an empty tree writes nothing', t => {
  const f = fixture(t);
  f.store.subagents.save(f.id, 'root', { agents: [running] });
  const id = randomUUID();
  f.store.subagents.enqueueStop({ id, conversationId: f.id, agentId: 'child-a' });
  assert.ok(f.store.subagents.claimStop(id));
  assert.equal(f.store.subagents.recoverDispatching(), 1);
  assert.equal(f.store.subagents.getStop(id)?.status, 'unknown');
  const other = randomUUID();
  f.store.createConversation({ id: other, harnessId: 'codex', workspaceId: 'fixture', cwd: '/synthetic/workspace', configuration: { modelId: 'model', permissionId: 'workspace' } });
  const version = f.store.version();
  f.store.subagents.save(other, 'other-root', { agents: [] });
  assert.equal(f.store.version(), version, 'conversations without sub-agents produce no change events');
  assert.equal(f.store.getConversation(other)!.subagents, undefined);
});

test('collaboration records read from native history and live events replay into snapshots', async t => {
  const f = fixture(t);
  f.peer.records = [{ id: 'collab', kind: 'notice', text: '派出子 Agent', status: 'completed', runId: 'run', collaboration: { action: 'started', agentIds: ['child-a', 'child-b'] } }];
  const opened = await f.service.open(f.id);
  assert.deepEqual(opened.history.items[0]!.collaboration, { action: 'started', agentIds: ['child-a', 'child-b'] });
  await f.service.reading(f.id, randomUUID());
  f.peer.emit({ type: 'item', item: { id: 'collab-live', kind: 'notice', text: '子 Agent 已完成', status: 'completed', runId: 'run', collaboration: { action: 'completed', agentIds: ['child-a'] } } });
  assert.deepEqual(f.service.liveItem(f.id, 'collab-live')!.collaboration, { action: 'completed', agentIds: ['child-a'] });
  assert.ok((['workbench_items', 'workbench_live_items'].every(name => !f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name))), 'live bodies stay in memory');
});
test('a later verified read settles an unknown stop whose target no longer runs, without another native call', async t => {
  const f = fixture(t);
  f.peer.tree = { agents: [running] };
  await f.service.subagents(f.id);
  f.peer.stopRead = async () => { f.peer.tree = { agents: [{ ...running, status: 'interrupted', endedAt: 6000 }] }; throw new Error('response_lost'); };
  const id = randomUUID();
  f.service.stopSubagent(f.id, 'child-a', id);
  await until(() => f.store.subagents.getStop(id)?.status === 'accepted');
  assert.deepEqual(f.peer.stopCalls, ['child-a']);
  assert.equal(f.store.subagents.busy(f.id), false, 'a settled tree no longer holds execution responsibility');
});

test('an unreadable tree blocks archive only when sub-agents are already known', async t => {
  const f = fixture(t);
  f.peer.treeRead = async () => { throw new Error('unsupported'); };
  const archived = await f.service.setArchived(f.id, true);
  assert.equal(archived.archived, true, 'no observed sub-agents: archive proceeds');
  const g = fixture(t);
  g.peer.tree = { agents: [{ ...running, status: 'completed', endedAt: 1 }] };
  await g.service.subagents(g.id);
  g.peer.treeRead = async () => { throw new Error('host_unreachable'); };
  await assert.rejects(g.service.setArchived(g.id, true), { code: 'subagents_unverified' });
});

test('an unknown native state from the watch revokes sub-agent verification immediately', async t => {
  const f = fixture(t);
  f.peer.tree = { agents: [running] };
  await f.service.reading(f.id, randomUUID());
  await until(() => f.store.subagents.view(f.id).agents.length === 1);
  f.peer.treeRead = async () => { throw new Error('host_unreachable'); };
  f.peer.emit({ type: 'state', state: { status: 'unknown', pendingInputs: 0, configurationVerified: false, reason: 'DSH 连接中断' } });
  await until(() => f.store.subagents.view(f.id).stale);
  assert.equal(f.store.getConversation(f.id)!.subagents?.running, 0);
});

test('pending Codex results hold observation and recovery without blocking archive', async t => {
  const f = fixture(t);
  f.peer.tree = { agents: [{ ...running, status: 'completed', endedAt: 9000 }], resultsPending: true };
  await f.service.subagents(f.id);
  assert.equal(f.store.subagents.holdsObservation(f.id), true);
  assert.equal(f.store.recoverableConversations('').includes(f.id), true, 'a restart restores the parent that still holds results');
  assert.equal((await f.service.setArchived(f.id, true)).archived, true, 'pending results never block archive');
  assert.equal(f.store.recoverableConversations('').includes(f.id), false, 'an archived tree no longer holds the parent');
});

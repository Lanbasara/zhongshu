import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { automationOf, targetInput, timingInput } from '../src/harness/dsh/automations.ts';
import { itemFrom } from '../src/harness/dsh/native.ts';
import { createAgentTools, oneLine, relativeFile, RESULT_INSTRUCTIONS } from '../src/server/agent-tools.ts';
import { createAgentNotifications } from '../src/server/agent-notifications.ts';
import { createAgentResults } from '../src/server/agent-results.ts';
import { parseTimeline } from '../src/server/automations.ts';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import type { PushEvent } from '../src/server/push.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { readWorkspaceTimeline } from '../src/server/workspace-documents.ts';
import { pushMessage } from '../src/shared/push.ts';

function database(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'zhongshu-automations-'));
  const db = openDatabase(directory, productMigrations);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return db;
}
const TOKEN = 'synthetic-tool-token-0123456789abcdef';
const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });

test('DSH schedule records map to automations, and product input maps back to native timing and targets', () => {
  const daily = automationOf({ id: 'schedule-1', kind: 'daily', title: '盘前简报', prompt: '写简报', time: '08:50:00.000', timeZone: 'Asia/Shanghai', scheduledAt: '2026-11-09T00:50:00.000Z',
    target: { kind: 'new', create: { cwd: '/workspace/stock', agentPreset: 'standard' } }, involvedSessionIds: ['s-1'], status: 'active', updatedAt: '2026-11-08T12:00:00.000Z',
    lastDelivery: { scheduledAt: '2026-11-06T00:50:00.000Z', deliveredAt: '2026-11-06T04:02:00.000Z', messageId: 'm-1', targetSessionId: 's-9' } });
  assert.deepEqual(daily.timing, { kind: 'daily', time: '08:50', timeZone: 'Asia/Shanghai' });
  assert.deepEqual(daily.target, { kind: 'new', cwd: '/workspace/stock', preset: 'standard' });
  assert.deepEqual(daily.lastDelivery, { scheduledAt: '2026-11-06T00:50:00.000Z', deliveredAt: '2026-11-06T04:02:00.000Z', messageId: 'm-1', sessionId: 's-9' });
  assert.equal(daily.executing, false);
  const once = automationOf({ id: 'schedule-2', kind: 'rrule', title: '盘中验证', prompt: '读 tracking.md', rrule: 'DTSTART:20261108T124630Z\nRRULE:FREQ=DAILY;COUNT=1',
    scheduledAt: '2026-11-08T12:46:30.000Z', target: { kind: 'session', sessionId: 's-1' }, involvedSessionIds: [], status: 'ended', executionActive: true });
  assert.equal(once.timing.kind, 'rrule'); assert.equal(once.status, 'ended'); assert.equal(once.executing, true);
  assert.deepEqual(automationOf({ id: 'a', kind: 'at', title: 't', prompt: 'p', scheduledAt: '2026-11-28T02:00:00.000Z', target: { kind: 'new_once', sessionId: 'r', create: {} }, involvedSessionIds: [], status: 'paused' }).timing,
    { kind: 'once', at: '2026-11-28T02:00:00.000Z' });
  assert.throws(() => automationOf({ id: 'x', kind: 'unknown-rule', title: 't', prompt: 'p', scheduledAt: '2026-11-28T02:00:00.000Z' }));
  assert.deepEqual(timingInput({ kind: 'weekly', time: '09:30', timeZone: 'Asia/Shanghai', weekdays: [1, 3] }), { kind: 'weekly', weekly: { time: '09:30:00', time_zone: 'Asia/Shanghai', weekdays: [1, 3] } });
  assert.deepEqual(timingInput({ kind: 'every', seconds: 600 }), { kind: 'every', every_seconds: 600 });
  assert.deepEqual(targetInput({ kind: 'new', cwd: '/workspace/stock' }), { kind: 'new', create: { cwd: '/workspace/stock' } });
  assert.deepEqual(targetInput({ kind: 'session', sessionId: 's-1' }), { kind: 'session', sessionId: 's-1' });
});

test('a schedule delivery in native history is shown as the user-side message it is, marked with its origin', () => {
  const item = itemFrom('s-1', { type: 'user/message', seq: 7, time: 1, data: { id: 'm-1', content: [{ type: 'text', text: '【定时】读 tracking.md' }], source: { kind: 'schedule' } } });
  assert.deepEqual(item && { kind: item.kind, text: item.text, automation: item.automation }, { kind: 'user', text: '【定时】读 tracking.md', automation: { messageId: 'm-1' } });
  // A message without a schedule or Zhongshu origin stays hidden as before.
  assert.equal(itemFrom('s-1', { type: 'user/message', seq: 8, time: 1, data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'other' } } }), undefined);
});

test('the agent tool endpoint speaks minimal MCP, accepts only its token, refuses browsers and validates input', async t => {
  const calls: [string, string | undefined][] = []; const recorded: string[] = [];
  const tools = createAgentTools({ token: TOKEN, port: 0, version: '0.2.0', notify: (summary, file) => { calls.push([summary, file]); return { id: '11111111-2222-4333-8444-555555555555' }; },
    record: summary => { recorded.push(summary); return { id: '22222222-3333-4444-8555-666666666666' }; } });
  t.after(() => tools.close());
  const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) => tools.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(body) });
  assert.equal((await post(rpc('tools/list'), {})).statusCode, 401);
  assert.equal((await post(rpc('tools/list'), { authorization: 'Bearer wrong-token-0123456789abcdefgh' })).statusCode, 401);
  assert.equal((await post(rpc('tools/list'), { authorization: `Bearer ${TOKEN}`, origin: 'https://example.com' })).statusCode, 403);
  const init = (await post(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh', version: '0' } }))).json();
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  // Without 司辰 the instructions still carry the rule that a scheduled run ends with record_result.
  assert.equal(init.result.instructions, RESULT_INSTRUCTIONS); assert.match(RESULT_INSTRUCTIONS, /record_result/);
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode, 202);
  const list = (await post(rpc('tools/list'))).json();
  assert.deepEqual(list.result.tools.map((entry: { name: string }) => entry.name), ['notify_user', 'record_result']);
  assert.ok(JSON.stringify(list.result.tools).length < 1800, 'tool schemas stay small; every model request carries them');
  // The conclusion goes onto the task card; it is a separate tool from notifying the user (ADR 0021, 2026-11-09).
  const written = (await post(rpc('tools/call', { name: 'record_result', arguments: { summary: '黄金周检：\n4,122 未进低区，未触发' } }))).json();
  assert.match(written.result.content[0].text, /结论编号 22222222-3333-4444-8555-666666666666/);
  assert.deepEqual(recorded, ['黄金周检： 4,122 未进低区，未触发']);
  assert.equal((await post(rpc('tools/call', { name: 'record_result', arguments: { summary: 'x', file: 'a.md' } }))).json().result.isError, true);
  assert.equal((await post(rpc('tools/call', { name: 'record_result', arguments: { summary: ' ' } }))).json().result.isError, true);
  const sent = (await post(rpc('tools/call', { name: 'notify_user', arguments: { summary: '上证跌破\n3,600，T1 触发', file: './2026-11-09/case-001/work/tracking.md' } }))).json();
  assert.match(sent.result.content[0].text, /通知编号 11111111-2222-4333-8444-555555555555/);
  assert.deepEqual(calls, [['上证跌破 3,600，T1 触发', '2026-11-09/case-001/work/tracking.md']]);
  const escaping = (await post(rpc('tools/call', { name: 'notify_user', arguments: { summary: 'x', file: '../secrets' } }))).json();
  assert.equal(escaping.result.isError, true);
  const extra = (await post(rpc('tools/call', { name: 'notify_user', arguments: { summary: 'x', url: 'https://evil' } }))).json();
  assert.equal(extra.result.isError, true);
  assert.equal((await post(rpc('tools/call', { name: 'other_tool', arguments: {} }))).json().error.code, -32602);
  assert.equal((await tools.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode, 405);
  assert.equal(calls.length, 1);
  assert.equal(oneLine('a'.repeat(200)).length, 120);
  assert.throws(() => relativeFile('/etc/passwd')); assert.throws(() => relativeFile('a//b')); assert.equal(relativeFile(undefined), undefined);
});

test('a written-back conclusion is tied to its conversation by the tool record and belongs to the run delivered before it', t => {
  const db = database(t); let clock = 1_000_000;
  const results = createAgentResults(db, { now: () => clock });
  const first = results.record('周检：未进低区'); assert.ok('id' in first);
  assert.equal(results.within('c-1', 0), undefined, 'not placed until its tool record is seen');
  results.observed('c-1', [{ id: 'dsh:s:tool:call-1', kind: 'tool', text: '', status: 'completed', tool: { name: 'mcp__zhongshu__record_result', output: `已写到任务卡上。结论编号 ${first.id}` } }]);
  results.observed('c-2', [{ id: 'dsh:s2:tool:call-1', kind: 'tool', text: '', status: 'completed', tool: { name: 'mcp__zhongshu__record_result', output: `结论编号 ${first.id}` } }]);
  assert.equal(results.within('c-1', 0), '周检：未进低区'); assert.equal(results.within('c-2', 0), undefined, 'placed once, where it was first seen');
  clock += 7 * 86_400_000;
  const second = results.record('周检：进入低区，触发'); assert.ok('id' in second);
  results.observed('c-1', [{ id: 'dsh:s:tool:call-9', kind: 'tool', text: '', status: 'completed', tool: { name: 'mcp__zhongshu__record_result', output: `结论编号 ${second.id}` } }]);
  // A reused conversation: each delivery's window ends where the next one began.
  assert.equal(results.within('c-1', 0, 1_000_000 + 86_400_000), '周检：未进低区');
  assert.equal(results.within('c-1', 1_000_000 + 86_400_000), '周检：进入低区，触发');
  assert.equal(results.within('c-1', 0, 1_000_000), undefined);
  // A notify record is not a conclusion.
  results.observed('c-3', [{ id: 'x', kind: 'tool', text: '', status: 'completed', tool: { name: 'mcp__zhongshu__notify_user', output: `通知编号 ${second.id}` } }]);
  assert.equal(results.within('c-3', 0), undefined);
});

test('a notification is pushed with a direct link once its tool record is observed, and otherwise opens the schedule', async t => {
  const db = database(t); const pushed: PushEvent[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const notifications = createAgentNotifications(db, { push: event => pushed.push(event), title: id => id === 'c-1' ? '11-06 盘中跟踪' : undefined });
  t.after(() => notifications.close());
  const first = notifications.notify('T2 临近：A50 下探 12,710', undefined); assert.ok('id' in first);
  assert.equal(notifications.get(first.id)?.state, 'pending');
  notifications.observed('c-1', [{ id: 'dsh:s:tool:call-1', kind: 'tool', text: 'mcp__zhongshu__notify_user', status: 'completed', tool: { name: 'mcp__zhongshu__notify_user', output: `已通知用户。通知编号 ${first.id}` } }]);
  assert.deepEqual(pushed, [{ kind: 'agent', conversationId: 'c-1', title: '11-06 盘中跟踪', body: 'T2 临近：A50 下探 12,710', notice: first.id }]);
  // Observing the same record again never pushes twice.
  notifications.observed('c-1', [{ id: 'dsh:s:tool:call-1', kind: 'tool', text: '', status: 'completed', tool: { name: 'mcp__zhongshu__notify_user', output: `通知编号 ${first.id}` } }]);
  assert.equal(pushed.length, 1);
  const second = notifications.notify('收盘验证：判断维持', 'a.md'); assert.ok('id' in second);
  t.mock.timers.tick(20_000);
  assert.deepEqual(pushed[1], { kind: 'agent', body: '收盘验证：判断维持', notice: second.id });
  assert.equal(notifications.get(second.id)?.state, 'unplaced');
  assert.equal(pushMessage(pushed[0]!).url, `/#c-1:notice:${first.id}`);
  assert.equal(pushMessage(pushed[1]!).url, '/#schedule');
  // Found in history after its push went to the schedule: it now points at its turn, with no second push.
  notifications.observed('c-2', [{ id: 'dsh:s2:tool:call-9', kind: 'tool', text: '', status: 'completed', tool: { name: 'mcp__zhongshu__notify_user', output: `已通知用户。通知编号 ${second.id}` } }]);
  assert.deepEqual([notifications.get(second.id)?.state, notifications.get(second.id)?.conversationId, notifications.get(second.id)?.itemId], ['placed', 'c-2', 'dsh:s2:tool:call-9']);
  assert.equal(pushed.length, 2);
  assert.equal(pushMessage(pushed[0]!).body, 'T2 临近：A50 下探 12,710');
  for (let index = 0; index < 28; index++) notifications.notify(`n${index}`, undefined);
  assert.ok('refused' in notifications.notify('one too many', undefined), 'a looping agent cannot flood the phone');
});

test('the store adopts a session an automation created once, finds it by native identity, and lists it like any conversation', t => {
  const db = database(t); const store = createWorkbenchStore(db);
  const configuration = { modelId: 'fixture-model', permissionId: 'danger-full-access' };
  const input = { id: randomUUID(), harnessId: 'dsh' as const, workspaceId: 'fixture', cwd: '/workspace/stock', title: '每日盘前简报', configuration,
    binding: { id: 's-run-1', cwd: '/workspace/stock', configuration, details: {} }, automationId: 'schedule-1' };
  const adopted = store.adoptConversation(input);
  assert.equal(adopted.readiness, 'ready'); assert.equal(adopted.automationId, 'schedule-1');
  assert.equal(store.adoptConversation({ ...input, id: randomUUID() }).id, adopted.id, 'the same native session is adopted once');
  assert.equal(store.conversationForNative('dsh', 's-run-1')?.id, adopted.id);
  assert.equal(store.conversationForNative('dsh', 's-unknown'), null);
  const ordinary = store.createConversation({ id: randomUUID(), harnessId: 'dsh', workspaceId: 'fixture', cwd: '/workspace/stock', configuration }).conversation;
  // Run conversations are ordinary sidebar rows (ADR 0021, 2026-11-09); a native run moves one to the top.
  assert.deepEqual(store.listConversations().map(entry => entry.id), [ordinary.id, adopted.id]);
  assert.deepEqual(store.listConversations({ automationId: 'schedule-1' }).map(entry => entry.id), [adopted.id]);
  store.setConversationState(adopted.id, { state: { status: 'running', runId: 'dsh:s-run-1:1', pendingInputs: 0, configurationVerified: true } });
  assert.deepEqual(store.listConversations().map(entry => entry.id), [adopted.id, ordinary.id]);
});

test('the workspace timeline file is read whole from its fixed hidden path; bad lines are reported and the last line per id wins', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zhongshu-timeline-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(await readWorkspaceTimeline(root), null);
  mkdirSync(join(root, '.zhongshu'));
  const lines = [
    { id: 'a-1127', date: '2026-11-27', time: '15:00', tz: 'Asia/Shanghai', kind: 'action', title: '第一阶段实操截止', link: '2026-11-02/decision.md' },
    { id: 'e-fomc', date: '2026-12-10', kind: 'event', title: 'FOMC 利率决议' },
    { id: 'a-1127', date: '2026-11-28', time: '10:00', kind: 'action', title: '第一阶段实操截止（改期）', status: 'done' },
  ].map(value => JSON.stringify(value));
  writeFileSync(join(root, '.zhongshu', 'timeline.jsonl'), [...lines, 'not json', JSON.stringify({ id: 'x', date: '2026-11-01', kind: 'gossip', title: 'x' }),
    JSON.stringify({ id: 'y', date: '2026-11-01', kind: 'decision', title: 'y', link: '../outside.md' }), JSON.stringify({ id: 'z', date: '2026-11-01', kind: 'research', title: 'z', link: 'https://example.com' }), ''].join('\n'));
  const text = await readWorkspaceTimeline(root); assert.ok(text);
  const parsed = parseTimeline(text, { id: 'stock', label: 'haokun-stock' });
  assert.deepEqual(parsed.entries.map(entry => [entry.id, entry.date, entry.time, entry.status]), [['a-1127', '2026-11-28', '10:00', 'done'], ['e-fomc', '2026-12-10', undefined, undefined]]);
  assert.deepEqual(parsed.problems.map(problem => problem.reason), ['not_json', 'invalid_fields', 'link_outside_workspace', 'link_outside_workspace']);
  assert.equal(parsed.entries[0]!.workspaceLabel, 'haokun-stock');
  const tidy = parseTimeline([JSON.stringify({ id: 'l', date: '2026-11-01', kind: 'research', title: 'l', link: './reports//2026-11.md' }),
    JSON.stringify({ id: 'f', date: '2026-02-30', kind: 'event', title: 'no such day' }), JSON.stringify({ id: 'e', date: '2026-11-01', kind: 'event', title: 'e', link: './' })].join('\n'), { id: 'w', label: 'W' });
  assert.deepEqual(tidy.entries.map(entry => entry.link), ['reports/2026-11.md'], 'links are kept relative to the workspace root');
  assert.deepEqual(tidy.problems.map(problem => problem.reason), ['invalid_date', 'link_outside_workspace']);
  // A symlinked directory is never followed out of the workspace.
  const outside = mkdtempSync(join(tmpdir(), 'zhongshu-outside-')); t.after(() => rmSync(outside, { recursive: true, force: true }));
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'zhongshu-timeline-link-'))); t.after(() => rmSync(other, { recursive: true, force: true }));
  mkdirSync(join(outside, 'data')); writeFileSync(join(outside, 'data', 'timeline.jsonl'), lines[0]!);
  symlinkSync(join(outside, 'data'), join(other, '.zhongshu'));
  assert.equal(await readWorkspaceTimeline(other), null, 'nothing is read through the link');
});

test('a run an automation started does not push its completion, since the agent decides; its failure still pushes', async () => {
  const { createPushTriggers } = await import('../src/server/push-triggers.ts');
  type State = import('../src/harness/types.ts').NativeState;
  const base: State = { status: 'running', runId: 'turn-7', pendingInputs: 0, configurationVerified: true, terminalRunId: 'turn-6', terminalStatus: 'completed' };
  let state: State = base;
  const conversation = () => ({ id: 'c-1', harnessId: 'dsh', title: '盘中跟踪', archived: false, state }) as unknown as import('../src/server/workbench-store.ts').Conversation;
  const pushed: PushEvent[] = [];
  const triggers = createPushTriggers({ conversation, unread: () => new Set(['c-1']), isReading: () => false, active: () => [conversation()] }, event => pushed.push(event));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const change = { conversationId: 'c-1' } as unknown as import('../src/server/workbench-store.ts').WorkbenchChange;
  state = { ...base, status: 'idle', latest: { runId: 'turn-7', status: 'completed' } };
  triggers.changed(change); await settle();
  assert.equal(pushed.length, 0, 'completion of an automation run is left to notify_user');
  state = { ...base, status: 'running', runId: 'turn-8' };
  triggers.changed(change); await settle();
  state = { ...base, status: 'failed', runId: 'turn-8', latest: { runId: 'turn-8', status: 'failed' } };
  triggers.changed(change); await settle();
  assert.deepEqual(pushed.map(event => event.kind), ['failed']);
  triggers.close();
});

test('the automation service shows native tasks in product terms, adopts sessions a task created, and passes edits through', async t => {
  const { default: Fastify } = await import('fastify');
  const { createAutomations } = await import('../src/server/automations.ts');
  type Native = import('../src/harness/types.ts').NativeAutomation;
  const db = database(t); const store = createWorkbenchStore(db);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'zhongshu-automation-ws-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configuration = { modelId: 'fixture-model', permissionId: 'danger-full-access' };
  const existing = store.createConversation({ id: randomUUID(), harnessId: 'dsh', workspaceId: 'stock', cwd: directory, configuration }).conversation;
  store.saveBinding(existing.id, { id: 's-existing', cwd: directory, configuration, details: {} });
  const noticed: string[] = [];
  const workbench = {
    store, workspaces: [{ id: 'stock', label: 'Stock', directory }], workspaceView: () => ({ workspaces: [{ id: 'stock', label: 'Stock' }] }),
    unread: (list: { id: string; state: { status: string } }[]) => new Set(list.filter(entry => entry.state.status === 'idle').map(entry => entry.id)),
    noticeActivity: async (id: string) => { noticed.push(id); }, onObserved: () => () => {},
  } as unknown as import('../src/server/workbench.ts').Workbench;
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 9, 1, minutes)).toISOString();
  let tasks: Native[] = [
    { id: 'routine', title: '盘前简报', prompt: '写简报', timing: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, scheduledAt: at(0), status: 'active',
      target: { kind: 'new', cwd: directory }, involved: [], executing: false, updatedAt: at(0),
      lastDelivery: { scheduledAt: at(0), deliveredAt: at(20), messageId: 'm-1', sessionId: 's-run-1' } },
    { id: 'follow', title: '回看', prompt: '复核', timing: { kind: 'once', at: at(30) }, scheduledAt: at(30), status: 'active', target: { kind: 'session', sessionId: 's-existing' }, involved: [], executing: false, updatedAt: at(1) },
    { id: 'elsewhere', title: '外部', prompt: 'x', timing: { kind: 'every', seconds: 3600 }, scheduledAt: at(40), status: 'active', target: { kind: 'session', sessionId: 's-unknown' }, involved: [], executing: false,
      lastDelivery: { scheduledAt: at(40), deliveredAt: at(40), messageId: 'm-x', sessionId: 's-unknown' } },
    { id: 'once', title: '持续跟踪', prompt: '跟踪', timing: { kind: 'every', seconds: 3600 }, scheduledAt: at(50), status: 'active', target: { kind: 'new_once', sessionId: 's-once', cwd: directory }, involved: [], executing: false },
  ];
  const edits: unknown[] = []; const created: unknown[] = []; const sessions: unknown[] = []; let lateReady = false;
  const source = {
    list: async () => tasks, view: async (id: string) => tasks.find(task => task.id === id), history: async () => undefined,
    create: async (input: { title: string; prompt: string; target?: { kind: string; sessionId?: string } }) => {
      const made: Native = { id: 'made', title: input.title, prompt: input.prompt, timing: { kind: 'daily', time: '09:30', timeZone: 'Asia/Shanghai' }, scheduledAt: at(90), status: 'active',
        target: { kind: 'session', sessionId: input.target!.sessionId! }, involved: [], executing: false, updatedAt: at(5) };
      created.push(input); tasks = [...tasks, made]; return made;
    }, remove: async () => 'notFound' as const, run: async (id: string) => (tasks.some(task => task.id === id) ? 'pending' as const : 'notFound' as const),
    update: async (id: string, patch: unknown, expected?: string) => { edits.push({ id, patch, expected }); return expected === at(1) ? { ...tasks[1]!, title: '回看（改）', updatedAt: at(2) } : 'conflict' as const; },
    onChange: () => () => {},
    inspect: async (sessionId: string) => (['s-run-1', 's-once', 's-unknown'].includes(sessionId) || (sessionId === 's-late' && lateReady) ? { cwd: directory, configuration } : undefined),
  };
  const adapters = new Map([['dsh', { automations: source, create: async (input: { cwd: string; configuration: typeof configuration }) => { sessions.push(input); return { id: 's-made', cwd: input.cwd, configuration: input.configuration, details: {} }; } }]]) as unknown as Parameters<typeof createAutomations>[2];
  const notifications = createAgentNotifications(db, { push: () => {}, title: () => undefined });
  const service = createAutomations(db, workbench, adapters, notifications, () => {});
  const app = Fastify(); await app.register(service.routes); t.after(() => { service.close(); return app.close(); });

  const first = (await app.inject({ method: 'GET', url: '/automations' })).json();
  const byId = new Map(first.automations.map((task: { id: string }) => [task.id, task]));
  const adopted = store.conversationForNative('dsh', 's-run-1');
  assert.ok(adopted, 'the session a routine task created is adopted into its workspace');
  assert.equal(adopted.automationId, 'routine');
  assert.deepEqual(noticed, [adopted.id], 'the delivery starts observation of the run');
  assert.deepEqual(byId.get('routine'), { ...byId.get('routine') as object, target: { kind: 'new', workspaceId: 'stock', workspaceLabel: 'Stock' }, runs: 1,
    latestRun: { conversationId: adopted.id, status: adopted.state.status, unread: adopted.state.status === 'idle' } });
  assert.equal((byId.get('routine') as { lastDelivery: { late: boolean; conversationId: string } }).lastDelivery.late, true, 'twenty minutes after its time is late');
  assert.deepEqual((byId.get('follow') as { target: unknown }).target, { kind: 'conversation', conversationId: existing.id, conversationTitle: existing.title, configuration },
    'runs into a conversation use its configuration');
  assert.deepEqual((byId.get('elsewhere') as { target: unknown }).target, { kind: 'unknown' });
  // The agent writes its conclusion back; it shows on the card of the run it concludes (ADR 0021, 2026-11-09).
  const conclusion = service.results.record('简报：外部平稳，无需动作'); assert.ok('id' in conclusion);
  service.results.observed(adopted.id, [{ id: 'dsh:s-run-1:tool:c1', kind: 'tool', text: '', status: 'completed', tool: { name: 'mcp__zhongshu__record_result', output: `结论编号 ${conclusion.id}` } }]);
  const concluded = (await app.inject({ method: 'GET', url: '/automations' })).json().automations.find((task: { id: string }) => task.id === 'routine');
  assert.equal(concluded.lastDelivery.result, '简报：外部平稳，无需动作');

  await app.inject({ method: 'GET', url: '/automations' });
  assert.equal(noticed.length, 1, 'a delivery is handled once');
  // Another task delivering into the same session later: each card keeps only its own run's conclusion.
  const laterAt = new Date(Date.now() + 1000).toISOString();
  tasks = [...tasks, { id: 'later', title: '午后检查', prompt: '查', timing: { kind: 'once', at: laterAt }, scheduledAt: laterAt, status: 'ended', target: { kind: 'session', sessionId: 's-run-1' },
    involved: [], executing: false, lastDelivery: { scheduledAt: laterAt, deliveredAt: laterAt, messageId: 'm-later', sessionId: 's-run-1' } }];
  await new Promise(resolve => setTimeout(resolve, 3100));
  const afternoon = service.results.record('午后：维持'); assert.ok('id' in afternoon);
  service.results.observed(adopted.id, [{ id: 'dsh:s-run-1:tool:c2', kind: 'tool', text: '', status: 'completed', tool: { name: 'mcp__zhongshu__record_result', output: `结论编号 ${afternoon.id}` } }]);
  const shared = new Map((await app.inject({ method: 'GET', url: '/automations' })).json().automations.map((task: { id: string; lastDelivery?: { result?: string } }) => [task.id, task.lastDelivery?.result]));
  assert.deepEqual([shared.get('routine'), shared.get('later')], ['简报：外部平稳，无需动作', '午后：维持']);
  tasks = tasks.filter(task => task.id !== 'later');
  assert.equal(store.conversationForNative('dsh', 's-unknown'), null, 'a session the task did not create stays the Harness\'s own');

  // After its first delivery the Harness rewrites a "new once" target to a plain session; the reservation still adopts it.
  tasks = tasks.map(task => (task.id === 'once' ? { ...task, target: { kind: 'session', sessionId: 's-once' }, lastDelivery: { scheduledAt: at(50), deliveredAt: at(50), messageId: 'm-once', sessionId: 's-once' } } : task));
  await new Promise(resolve => setTimeout(resolve, 3_100)); // past the list cache
  const later = (await app.inject({ method: 'GET', url: '/automations' })).json();
  const tracked = store.conversationForNative('dsh', 's-once');
  assert.ok(tracked, 'the reserved session is adopted at its first delivery');
  assert.deepEqual(later.automations.find((task: { id: string }) => task.id === 'once').target, { kind: 'new_once', conversationId: tracked.id, workspaceId: 'stock', workspaceLabel: 'Stock', configuration });
  const runs = (await app.inject({ method: 'GET', url: '/automations/routine/runs' })).json();
  assert.deepEqual(runs.conversations.map((entry: { id: string }) => entry.id), [adopted.id]);

  const stale = (await app.inject({ method: 'POST', url: '/automations/follow/edit', payload: { patch: { title: '回看（改）' }, expectedUpdatedAt: at(0) } })).json();
  assert.deepEqual(stale, { outcome: 'conflict' });
  const fresh = (await app.inject({ method: 'POST', url: '/automations/follow/edit', payload: { patch: { title: '回看（改）' }, expectedUpdatedAt: at(1) } })).json();
  assert.equal(fresh.outcome, 'ok'); assert.equal(fresh.automation.title, '回看（改）');
  assert.equal((await app.inject({ method: 'POST', url: '/automations/follow/edit', payload: { patch: {} } })).statusCode, 400, 'an empty change is refused');
  // A session the Harness just created may not report its configuration yet: adoption is retried shortly, not dropped.
  tasks = [...tasks, { id: 'late', title: '刚建的会话', prompt: 'x', timing: { kind: 'every', seconds: 3600 }, scheduledAt: at(70), status: 'active', target: { kind: 'new', cwd: directory },
    involved: [], executing: false, lastDelivery: { scheduledAt: new Date().toISOString(), deliveredAt: new Date().toISOString(), messageId: 'm-late', sessionId: 's-late' } }];
  await new Promise(resolve => setTimeout(resolve, 3_100));
  await app.inject({ method: 'GET', url: '/automations' });
  assert.equal(store.conversationForNative('dsh', 's-late'), null, 'not ready yet');
  lateReady = true;
  await new Promise(resolve => setTimeout(resolve, 3_500));
  const late = store.conversationForNative('dsh', 's-late');
  assert.equal(late?.automationId, 'late', 'adopted on the quick retry');
  assert.ok(noticed.includes(late!.id), 'and observed, so its notices can still be placed');

  // Deleting a task elsewhere leaves its results as ordinary conversations.
  tasks = tasks.filter(task => task.id !== 'routine');
  await new Promise(resolve => setTimeout(resolve, 3_100));
  await app.inject({ method: 'GET', url: '/automations' });
  assert.equal(store.getConversation(adopted.id)?.automationId, undefined);
  assert.ok(store.listConversations().some(entry => entry.id === adopted.id), 'the released run is back in the sidebar list');
  assert.equal(store.getConversation(tracked.id)?.automationId, 'once', 'conversations of tasks still listed stay with them');
  assert.deepEqual((await app.inject({ method: 'POST', url: '/automations/once/run' })).json(), { outcome: 'pending' });

  // Zhongshu never opens a conversation before a run (ADR 0021, 2026-11-09): neither target takes a configuration.
  const chosen = { modelId: 'deep-model', reasoningEffort: 'high', permissionId: 'danger-full-access', agentPreset: 'ptc' };
  for (const kind of ['new_once', 'new']) {
    const refused = await app.inject({ method: 'POST', url: '/automations', payload: { harnessId: 'dsh', title: '每日研判', prompt: 'x',
      timing: { kind: 'daily', time: '09:30', timeZone: 'Asia/Shanghai' }, target: { kind, workspaceId: 'stock', configuration: chosen } } });
    assert.equal(refused.statusCode, 400, `${kind} cannot carry a configuration the Harness would not apply`);
  }
  assert.deepEqual(sessions, [], 'no session was opened ahead of a run');
  assert.deepEqual((await app.inject({ method: 'POST', url: '/automations/missing/run' })).json(), { outcome: 'not_found' });
});

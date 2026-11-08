import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { automationOf, targetInput, timingInput } from '../src/harness/dsh/automations.ts';
import { itemFrom } from '../src/harness/dsh/native.ts';
import { createAgentTools, oneLine, relativeFile } from '../src/server/agent-tools.ts';
import { createAgentNotifications } from '../src/server/agent-notifications.ts';
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
  const calls: [string, string | undefined][] = [];
  const tools = createAgentTools({ token: TOKEN, port: 0, version: '0.2.0', notify: (summary, file) => { calls.push([summary, file]); return { id: '11111111-2222-4333-8444-555555555555' }; } });
  t.after(() => tools.close());
  const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) => tools.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(body) });
  assert.equal((await post(rpc('tools/list'), {})).statusCode, 401);
  assert.equal((await post(rpc('tools/list'), { authorization: 'Bearer wrong-token-0123456789abcdefgh' })).statusCode, 401);
  assert.equal((await post(rpc('tools/list'), { authorization: `Bearer ${TOKEN}`, origin: 'https://example.com' })).statusCode, 403);
  const init = (await post(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh', version: '0' } }))).json();
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode, 202);
  const list = (await post(rpc('tools/list'))).json();
  assert.deepEqual(list.result.tools.map((entry: { name: string }) => entry.name), ['notify_user']);
  assert.ok(JSON.stringify(list.result.tools).length < 1200, 'tool schema stays small; every model request carries it');
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
  assert.equal(pushMessage(pushed[0]!).body, 'T2 临近：A50 下探 12,710');
  for (let index = 0; index < 28; index++) notifications.notify(`n${index}`, undefined);
  assert.ok('refused' in notifications.notify('one too many', undefined), 'a looping agent cannot flood the phone');
});

test('the store adopts a session an automation created once, finds it by native identity, and keeps it out of the sidebar list', t => {
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
  assert.deepEqual(store.listConversations().map(entry => entry.id), [ordinary.id]);
  assert.deepEqual(store.listConversations({ automationId: 'schedule-1' }).map(entry => entry.id), [adopted.id]);
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

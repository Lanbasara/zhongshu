import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliveredReminders } from '../src/web/automation-delivery.ts';
import { instructionWithSkill, localDate, localTime, movable, runConfigurationText, scheduleItems, summarize, zonedInstant } from '../src/web/schedule-model.ts';
import type { AutomationView, TimelineEntry } from '../src/shared/automations.ts';

const framing = 'This is a scheduled message from the user';

test('a one-shot delivery yields its task id, occurrence and decoded prompt', () => {
  const text = ['[SCHEDULE REMINDER]', framing, 'schedule_id_json: "schedule-1"', 'occurrence_at: 2026-11-08T14:02:00.000Z',
    `reminder_prompt_json: ${JSON.stringify('第一行\n第二行 "引号"')}`].join('\n');
  assert.deepEqual(deliveredReminders(text), [{ scheduleId: 'schedule-1', occurrenceAt: '2026-11-08T14:02:00.000Z', prompt: '第一行\n第二行 "引号"' }]);
});

test('a recurring batch yields every reminder in order', () => {
  const payload = [{ schedule_id: 'a', occurrence_at: '2026-11-08T01:00:00.000Z', reminder_prompt: '盘前' }, { schedule_id: 'b', occurrence_at: '2026-11-08T07:00:00.000Z', reminder_prompt: '收盘' }];
  const text = ['[SCHEDULE REMINDER BATCH]', framing, `reminders_json: ${JSON.stringify(payload)}`].join('\n');
  assert.deepEqual(deliveredReminders(text)?.map(entry => [entry.scheduleId, entry.prompt]), [['a', '盘前'], ['b', '收盘']]);
});

test('anything that is not a well-formed frame is shown as written', () => {
  assert.equal(deliveredReminders('just a message'), undefined);
  assert.equal(deliveredReminders('[SCHEDULE REMINDER]\nreminder_prompt_json: not json'), undefined);
  assert.equal(deliveredReminders('[SCHEDULE REMINDER]\nschedule_id_json: "x"\noccurrence_at: 2026-11-08T00:00:00.000Z'), undefined);
  assert.equal(deliveredReminders('[SCHEDULE REMINDER BATCH]\nreminders_json: []'), undefined);
  assert.equal(deliveredReminders('[SCHEDULE REMINDER BATCH]\nreminders_json: [{"schedule_id":"a"}]'), undefined);
  assert.equal(deliveredReminders('see [SCHEDULE REMINDER]\nreminder_prompt_json: "x"'), undefined);
});

test('wall-clock times resolve in the task zone, and a skipped hour resolves just after the gap', () => {
  assert.equal(zonedInstant('2026-11-09', '09:30', 'Asia/Shanghai'), Date.UTC(2026, 10, 9, 1, 30));
  assert.equal(zonedInstant('2026-07-01', '09:30', 'America/New_York'), Date.UTC(2026, 6, 1, 13, 30));
  assert.equal(zonedInstant('2026-03-08', '02:30', 'America/New_York'), Date.UTC(2026, 2, 8, 7, 30));
  // The repeated hour picks one of its two instants, either of which shows the wanted time.
  const repeated = zonedInstant('2026-11-01', '01:30', 'America/New_York');
  assert.ok([Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 6, 30)].includes(repeated));
});

const now = Date.UTC(2026, 10, 9, 0, 0);
const task = (overrides: Partial<AutomationView>): AutomationView => ({
  id: 'schedule-x', harnessId: 'dsh', title: '任务', prompt: '做事', timing: { kind: 'once', at: new Date(now + 3_600_000).toISOString() },
  scheduledAt: new Date(now + 3_600_000).toISOString(), status: 'active', target: { kind: 'new', workspaceId: 'w' }, executing: false, runs: 0, ...overrides,
});

test('only an unrun one-shot task may be dragged', () => {
  assert.equal(movable(task({}), now), true);
  assert.equal(movable(task({ timing: { kind: 'rrule', rrule: 'DTSTART:20261109T010000Z\nRRULE:FREQ=DAILY;COUNT=1' } }), now), true);
  assert.equal(movable(task({ timing: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }), now), false);
  assert.equal(movable(task({ status: 'paused' }), now), false);
  assert.equal(movable(task({ executing: true }), now), false);
  assert.equal(movable(task({ scheduledAt: new Date(now - 60_000).toISOString() }), now), false);
});

test('a daily task expands once per day in its zone, and the earliest pending one is next', () => {
  const daily = task({ id: 'daily', timing: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, scheduledAt: new Date(Date.UTC(2026, 10, 9, 1, 0)).toISOString() });
  const once = task({ id: 'once', scheduledAt: new Date(Date.UTC(2026, 10, 10, 12, 0)).toISOString() });
  const from = localDate(new Date(Date.UTC(2026, 10, 8, 12))); const to = localDate(new Date(Date.UTC(2026, 10, 11, 12)));
  const items = scheduleItems({ automations: [daily, once], timeline: [], notifications: [], from, to, now });
  const dailyItems = items.filter(item => item.automationId === 'daily');
  assert.ok(dailyItems.length >= 3 && dailyItems.length <= 5);
  assert.equal(new Set(dailyItems.map(item => item.at)).size, dailyItems.length);
  for (const item of dailyItems) {
    assert.equal(item.routine, true);
    assert.equal(new Date(item.at!).getUTCHours(), 1); // 09:00 in Shanghai, whatever zone runs the test
    assert.equal(item.time, localTime(new Date(item.at!)));
  }
  assert.equal(items.filter(item => item.status === 'next').length, 1);
  assert.equal(items.find(item => item.status === 'next')?.at, Date.UTC(2026, 10, 9, 1, 0));
  assert.equal(items.find(item => item.automationId === 'once')?.movable, true);
});

test('a delivered run shows once, with the notice the agent sent after it', () => {
  const delivered = task({ id: 'ran', status: 'ended', scheduledAt: new Date(now - 7_200_000).toISOString(), target: { kind: 'conversation', conversationId: '11111111-1111-4111-8111-111111111111' },
    lastDelivery: { scheduledAt: new Date(now - 7_200_000).toISOString(), deliveredAt: new Date(now - 7_190_000).toISOString(), late: true } });
  const notice = { id: '22222222-2222-4222-8222-222222222222', summary: '结论一句话', file: null, createdAt: now - 7_100_000, state: 'placed' as const,
    conversationId: '11111111-1111-4111-8111-111111111111', itemId: 'item' };
  const day = localDate(new Date(now - 7_190_000));
  const items = scheduleItems({ automations: [delivered], timeline: [], notifications: [notice], from: day, to: day, now });
  assert.equal(items.length, 1);
  assert.deepEqual([items[0]!.status, items[0]!.late, items[0]!.notified], ['done', true, '结论一句话']);
  const counts = summarize(items, day);
  assert.deepEqual([counts.notified, counts.late, counts.tasks], [1, 1, 0]);
});

test('timeline entries with a zone land on the viewer day; past or finished ones count as done', () => {
  const entry = (overrides: Partial<TimelineEntry>): TimelineEntry => ({ id: 'e', date: '2026-11-10', kind: 'event', title: '财报', workspaceId: 'w', workspaceLabel: 'W', ...overrides });
  const zoned = entry({ id: 'zoned', time: '21:30', tz: 'America/New_York' });
  const instant = Date.UTC(2026, 10, 11, 2, 30);
  const wide = { from: '2026-11-01', to: '2026-11-30', automations: [], notifications: [], now };
  const items = scheduleItems({ ...wide, timeline: [zoned, entry({ id: 'cancelled', kind: 'action', status: 'cancelled' }), entry({ id: 'old', date: '2026-11-02', kind: 'research' })] });
  const placed = items.find(item => item.key === 'timeline:w:zoned')!;
  assert.deepEqual([placed.at, placed.date, placed.time, placed.status], [instant, localDate(new Date(instant)), localTime(new Date(instant)), 'todo']);
  assert.equal(items.find(item => item.key === 'timeline:w:cancelled')?.status, 'done');
  assert.equal(items.find(item => item.key === 'timeline:w:old')?.status, 'done');
  assert.equal(summarize(items, '2026-11-09').actions, 0);
});

test('a chosen skill is named first, in the words that make a DSH agent load it', () => {
  assert.equal(instructionWithSkill('  写今日研判  ', { name: 'jianwei-brief' }), '使用技能 jianwei-brief（/jianwei-brief）。\n\n写今日研判');
  assert.equal(instructionWithSkill('', { name: 'jianwei-brief' }), '使用技能 jianwei-brief（/jianwei-brief）。');
  assert.equal(instructionWithSkill(' 只写研判 '), '只写研判');
});

test('the run configuration says what the Harness will apply', () => {
  const configuration = { workspaces: [], harnesses: [{ id: 'dsh' as const, available: true, models: [{ id: 'm', label: 'DeepSeek-V4.1', reasoningEfforts: [{ id: 'high', label: 'high' }] }],
    permissions: [{ id: 'danger-full-access', label: '完全访问', description: '' }], presets: [{ id: 'ptc', label: 'PTC', description: '', available: true }, { id: 'standard', label: '标准', description: '', available: true }] }] };
  const fixed = task({ target: { kind: 'new_once', conversationId: '11111111-1111-4111-8111-111111111111', configuration: { modelId: 'm', reasoningEffort: 'high', permissionId: 'danger-full-access', agentPreset: 'ptc' } } });
  assert.equal(runConfigurationText(fixed, configuration as never), 'DeepSeek-V4.1 · high · 完全访问 · PTC');
  assert.equal(runConfigurationText(task({ target: { kind: 'new', workspaceId: 'w', preset: 'ptc' } }), configuration as never), 'PTC · 模型、思考深度和权限用宿主默认');
  assert.equal(runConfigurationText(task({ target: { kind: 'new', workspaceId: 'w' } }), configuration as never), '默认预设 · 模型、思考深度和权限用宿主默认');
  assert.equal(runConfigurationText(task({ target: { kind: 'unknown' } }), configuration as never), '中书之外的会话');
});

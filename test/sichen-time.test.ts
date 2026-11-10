import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, describe, fromNative, parseWeekdays, toNative, upcoming, type When } from '../src/sichen/time.ts';

const SH = 'Asia/Shanghai';
// 2026-11-09 12:30 in Shanghai, a Monday.
const now = Date.UTC(2026, 10, 9, 4, 30);
const at = (iso: string) => new Date(iso).getTime();

test('a once rule must name a real, future wall-clock time', () => {
  assert.deepEqual(check({ rule: { kind: 'once', date: '2026-11-10', time: '21:40' }, timeZone: SH }, now), []);
  assert.match(check({ rule: { kind: 'once', date: '2026-02-30', time: '09:00' }, timeZone: SH }, now)[0]!, /不存在/);
  assert.match(check({ rule: { kind: 'once', date: '2026-11-09', time: '09:00' }, timeZone: SH }, now)[0]!, /已经过去/);
  assert.match(check({ rule: { kind: 'once', date: '2026-11-10', time: '25:00' }, timeZone: SH }, now)[0]!, /钟点/);
  assert.match(check({ rule: { kind: 'once', date: '2026-11-10', time: '09:00' }, timeZone: 'Mars/Base' }, now)[0]!, /时区/);
  assert.deepEqual(toNative({ rule: { kind: 'once', date: '2026-11-10', time: '21:40' }, timeZone: SH }, now), { kind: 'at', at: '2026-11-10T13:40:00.000Z' });
});

test('an end date becomes an RFC 5545 UNTIL at the last second of that day, in UTC', () => {
  const scan: When = { rule: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '14:45' }, timeZone: SH, until: '2027-01-31' };
  assert.deepEqual(check(scan, now), []);
  assert.deepEqual(toNative(scan, now), { kind: 'rrule', rrule: 'DTSTART;TZID=Asia/Shanghai:20261109T144500\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20270131T155959Z' });
  const gold: When = { rule: { kind: 'weekly', weekdays: [1], time: '10:00' }, timeZone: SH, until: '2027-01-29' };
  assert.equal((toNative(gold, now) as { rrule: string }).rrule, 'DTSTART;TZID=Asia/Shanghai:20261109T100000\nRRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20270129T155959Z');
  // Without a start or an end, plain shapes stay plain.
  assert.deepEqual(toNative({ rule: { kind: 'daily', time: '09:00' }, timeZone: SH }, now), { kind: 'daily', time: '09:00', timeZone: SH });
});

test('month rules, starts and ends are checked before anything is created', () => {
  assert.equal((toNative({ rule: { kind: 'monthly', day: 30, months: [12, 3, 9, 6], time: '10:00' }, timeZone: SH }, now) as { rrule: string }).rrule,
    'DTSTART;TZID=Asia/Shanghai:20261109T100000\nRRULE:FREQ=MONTHLY;BYMONTH=3,6,9,12;BYMONTHDAY=30');
  assert.match(check({ rule: { kind: 'monthly', day: 31, months: [2, 4], time: '10:00' }, timeZone: SH }, now).join(), /永远不会运行/);
  assert.match(check({ rule: { kind: 'daily', time: '09:00' }, timeZone: SH, until: '2026-11-01' }, now).join(), /已经过去/);
  assert.match(check({ rule: { kind: 'daily', time: '09:00' }, timeZone: SH, from: '2026-12-10', until: '2026-12-01' }, now).join(), /早于开始/);
  assert.match(check({ rule: { kind: 'cron', expression: '0 10 * *' }, timeZone: SH }, now).join(), /五段/);
  assert.match(check({ rule: { kind: 'cron', expression: '0 10 15 * *' }, timeZone: SH, until: '2027-01-01' }, now).join(), /cron 写法不能设/);
  assert.match(check({ rule: { kind: 'weekly', weekdays: [], time: '09:00' }, timeZone: SH }, now).join(), /星期/);
  // Today's 09:00 has passed and today is the last day: nothing would ever run.
  assert.match(check({ rule: { kind: 'daily', time: '09:00' }, timeZone: SH, until: '2026-11-09' }, now).join(), /一次都不会运行/);
});

test('upcoming runs follow the zone, skip past times, cross months and years, and stop on the end day', () => {
  const scan: When = { rule: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '14:45' }, timeZone: SH, until: '2027-01-31' };
  assert.deepEqual(upcoming(scan, now, 3).map(value => new Date(value).toISOString()), ['2026-11-09T06:45:00.000Z', '2026-11-10T06:45:00.000Z', '2026-11-11T06:45:00.000Z']);
  // 2027-01-29 is a Friday; nothing falls after it before the end on Sunday the 31st.
  const tail = upcoming(scan, at('2027-01-28T08:00:00Z'), 5);
  assert.deepEqual(tail.map(value => new Date(value).toISOString()), ['2027-01-29T06:45:00.000Z']);
  const quarter: When = { rule: { kind: 'monthly', day: 30, months: [3, 6, 9, 12], time: '10:00' }, timeZone: SH };
  assert.deepEqual(upcoming(quarter, now, 2).map(value => new Date(value).toISOString()), ['2026-12-30T02:00:00.000Z', '2027-03-30T02:00:00.000Z']);
  assert.deepEqual(upcoming({ rule: { kind: 'cron', expression: '0 9 * * *' }, timeZone: SH }, now, 3), []);
});

test('a before boundary stops expansion at the view edge instead of walking dates nobody sees', () => {
  const daily: When = { rule: { kind: 'daily', time: '09:00' }, timeZone: SH };
  const end = at('2026-11-12T01:00:00Z');
  assert.deepEqual(upcoming(daily, now, 800, end).map(value => new Date(value).toISOString()),
    ['2026-11-10T01:00:00.000Z', '2026-11-11T01:00:00.000Z', '2026-11-12T01:00:00.000Z']);
  assert.deepEqual(upcoming({ rule: { kind: 'once', date: '2026-11-13', time: '09:00' }, timeZone: SH }, now, 1, end), []);
});

test('what the Harness reports reads back as the rule that wrote it', () => {
  const scan: When = { rule: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '14:45' }, timeZone: SH, until: '2027-01-31' };
  const native = toNative(scan, now) as { kind: 'rrule'; rrule: string };
  assert.deepEqual(fromNative(native, SH), { ...scan, from: '2026-11-09' });
  assert.deepEqual(fromNative({ kind: 'cron', expression: '0 10 30 3-12/3 *', timeZone: SH }, SH), { rule: { kind: 'monthly', day: 30, months: [3, 6, 9, 12], time: '10:00' }, timeZone: SH });
  assert.deepEqual(fromNative({ kind: 'cron', expression: '0 10 15 * *', timeZone: SH }, SH), { rule: { kind: 'monthly', day: 15, time: '10:00' }, timeZone: SH });
  assert.deepEqual(fromNative({ kind: 'rrule', rrule: 'DTSTART;TZID=Asia/Shanghai:20261109T084400\nRRULE:FREQ=DAILY;COUNT=1' }, SH), { rule: { kind: 'once', date: '2026-11-09', time: '08:44' }, timeZone: SH });
  assert.equal(fromNative({ kind: 'rrule', rrule: 'DTSTART:20261109T084400Z\nRRULE:FREQ=HOURLY' }, SH), undefined);
  assert.deepEqual(fromNative({ kind: 'once', at: '2026-11-10T13:40:00.000Z' }, SH), { rule: { kind: 'once', date: '2026-11-10', time: '21:40' }, timeZone: SH });
});

test('descriptions read the way a person says them', () => {
  assert.equal(describe({ rule: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '14:45' }, timeZone: SH, until: '2027-01-31' }, SH), '每个工作日 14:45 · 到 2027-01-31');
  assert.equal(describe({ rule: { kind: 'weekly', weekdays: [3, 1], time: '10:00' }, timeZone: SH }, SH), '每周一、三 10:00');
  assert.equal(describe({ rule: { kind: 'monthly', day: 30, months: [3, 6, 9, 12], time: '10:00' }, timeZone: SH }, SH), '3、6、9、12 月的 30 日 10:00');
  assert.equal(describe({ rule: { kind: 'daily', time: '09:00' }, timeZone: 'America/New_York' }, SH), '每天 09:00（America/New_York）');
});

test('weekday words in Chinese or English become ISO weekdays', () => {
  assert.deepEqual(parseWeekdays('工作日'), [1, 2, 3, 4, 5]);
  assert.equal(parseWeekdays('每天'), 'daily');
  assert.deepEqual(parseWeekdays('周一,周三'), [1, 3]);
  assert.deepEqual(parseWeekdays('一、三、五'), [1, 3, 5]);
  assert.deepEqual(parseWeekdays('mon-fri'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseWeekdays('sat,sun'), [6, 7]);
  assert.equal(parseWeekdays('周八'), undefined);
});

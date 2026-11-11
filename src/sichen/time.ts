/**
 * 司辰's time model (ADR 0022): human time rules, their checks, the native timing a Harness executes, a description,
 * and the next occurrences. Pure and dependency-free: Zhongshu's server and page and the `sichen` command share it.
 * Wall-clock rules carry an IANA zone; instants are milliseconds since the epoch.
 */

/** ISO weekday: Monday 1 through Sunday 7. */
export type Rule =
  | { kind: 'once'; date: string; time: string }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekdays: number[]; time: string }
  | { kind: 'monthly'; day: number; months?: number[]; time: string }
  | { kind: 'cron'; expression: string };
/** `from` and `until` are calendar days in the rule's zone; `until` includes its whole day. */
export type When = { rule: Rule; timeZone: string; from?: string; until?: string };
/** The shapes a Harness accepts; `rrule` carries a start, an end and month rules the others cannot. */
export type NativeTiming =
  | { kind: 'at'; at: string }
  | { kind: 'daily'; time: string; timeZone: string }
  | { kind: 'weekly'; time: string; timeZone: string; weekdays: number[] }
  | { kind: 'cron'; expression: string; timeZone: string }
  | { kind: 'rrule'; rrule: string };
/** What a Harness reports back; `once` is an instant. */
export type ReportedTiming =
  | { kind: 'once'; at: string }
  | { kind: 'every'; seconds: number }
  | { kind: 'daily'; time: string; timeZone: string }
  | { kind: 'weekly'; time: string; timeZone: string; weekdays: number[] }
  | { kind: 'cron'; expression: string; timeZone: string }
  | { kind: 'rrule'; rrule: string };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

export function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}
export function realDate(value: string): boolean {
  const match = DATE.exec(value); if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
export const realClock = (value: string) => CLOCK.test(value);

/** A formatter is expensive to build and reusable; a page expands hundreds of occurrences per render (ADR 0025). */
const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
    zoneFormats.set(timeZone, format);
  }
  return format;
}
/** Wall-clock parts of an instant in a zone. */
export function zoned(instant: number, timeZone: string) {
  const parts = Object.fromEntries(zoneFormat(timeZone)
    .formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(String(parts.weekday)) + 1 };
}
/** The instant a wall-clock date and time names in a zone; two passes settle offsets, gaps resolve forward. */
export function zonedInstant(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number); const [hh, mm] = time.split(':').map(Number);
  const wanted = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  const drift = (instant: number) => { const seen = zoned(instant, timeZone); const [sy, sm, sd] = seen.date.split('-').map(Number); const [sh, smm] = seen.time.split(':').map(Number); return wanted - Date.UTC(sy!, sm! - 1, sd!, sh!, smm!); };
  const first = wanted + drift(wanted);
  const second = first + drift(first);
  // In a skipped hour neither guess shows the wanted time; the later one lies just after the gap.
  return drift(second) === 0 ? second : Math.max(first, second);
}
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number); const value = new Date(Date.UTC(y!, m! - 1, d! + days));
  return value.toISOString().slice(0, 10);
}
function weekdayOf(date: string): number { const [y, m, d] = date.split('-').map(Number); return ((new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7) + 1; }
const compact = (date: string, time: string) => `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;
const utcStamp = (instant: number) => new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** Problems in plain words; empty when the rule can be scheduled. `now` decides what is already past. */
export function check(when: When, now: number): string[] {
  const problems: string[] = [];
  if (!validZone(when.timeZone)) return [`时区“${when.timeZone}”不认识，请写 IANA 时区，例如 Asia/Shanghai。`];
  const today = zoned(now, when.timeZone).date;
  const rule = when.rule;
  if (rule.kind !== 'cron' && !realClock(rule.time)) problems.push(`钟点“${rule.time}”不对，请写成 24 小时制的 HH:mm，例如 09:30。`);
  if (rule.kind === 'once') {
    if (!realDate(rule.date)) problems.push(`日期“${rule.date}”不存在，请写成 YYYY-MM-DD。`);
    else if (realClock(rule.time) && zonedInstant(rule.date, rule.time, when.timeZone) <= now + 30_000) problems.push(`${rule.date} ${rule.time} 已经过去了，一次性任务要定在将来。`);
    if (when.from || when.until) problems.push('一次性任务不需要开始或结束日期。');
  }
  if (rule.kind === 'weekly' && (!rule.weekdays.length || rule.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(rule.weekdays).size !== rule.weekdays.length))
    problems.push('星期要写周一到周日中的若干天，不能重复。');
  if (rule.kind === 'monthly') {
    if (!Number.isInteger(rule.day) || rule.day < 1 || rule.day > 31) problems.push(`每月的日子“${rule.day}”不对，要在 1 到 31 之间。`);
    if (rule.months && (!rule.months.length || rule.months.some(month => !Number.isInteger(month) || month < 1 || month > 12) || new Set(rule.months).size !== rule.months.length))
      problems.push('月份要写 1 到 12 中的若干个，不能重复。');
    else if (rule.months && rule.day > 28 && rule.months.every(month => rule.day > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!))
      problems.push(`所选月份都没有 ${rule.day} 日，这个任务永远不会运行。`);
  }
  if (rule.kind === 'cron') {
    if (rule.expression.trim().split(/\s+/).length !== 5) problems.push('cron 要写五段：分 时 日 月 星期，例如 "0 10 30 3,6,9,12 *"。');
    if (when.from || when.until) problems.push('cron 写法不能设开始或结束日期；需要结束日期时，请用 --every 或 --monthly。');
  }
  if (when.from && !realDate(when.from)) problems.push(`开始日期“${when.from}”不存在，请写成 YYYY-MM-DD。`);
  if (when.until && !realDate(when.until)) problems.push(`结束日期“${when.until}”不存在，请写成 YYYY-MM-DD。`);
  if (when.until && realDate(when.until) && when.until < today) problems.push(`结束日期 ${when.until} 已经过去了。`);
  if (when.from && when.until && realDate(when.from) && realDate(when.until) && when.until < when.from) problems.push(`结束日期 ${when.until} 早于开始日期 ${when.from}。`);
  if (!problems.length && rule.kind !== 'cron' && rule.kind !== 'once' && !upcoming(when, now, 1).length) problems.push('按这个规则，到结束日期之前一次都不会运行。');
  return problems;
}

/** The timing to hand the Harness. Start, end and month rules need an RFC 5545 rule; plain ones keep their own shape. */
export function toNative(when: When, now: number): NativeTiming {
  const { rule, timeZone } = when;
  if (rule.kind === 'once') return { kind: 'at', at: new Date(zonedInstant(rule.date, rule.time, timeZone)).toISOString() };
  if (rule.kind === 'cron') return { kind: 'cron', expression: rule.expression.trim().replace(/\s+/g, ' '), timeZone };
  if (rule.kind !== 'monthly' && !when.from && !when.until) {
    return rule.kind === 'daily' ? { kind: 'daily', time: rule.time, timeZone } : { kind: 'weekly', time: rule.time, timeZone, weekdays: [...rule.weekdays].sort((a, b) => a - b) };
  }
  const start = when.from ?? zoned(now, timeZone).date;
  const parts = rule.kind === 'daily' ? ['FREQ=DAILY']
    : rule.kind === 'weekly' ? ['FREQ=WEEKLY', `BYDAY=${[...rule.weekdays].sort((a, b) => a - b).map(day => DAY_CODES[day - 1]).join(',')}`]
    : ['FREQ=MONTHLY', ...(rule.months ? [`BYMONTH=${[...rule.months].sort((a, b) => a - b).join(',')}`] : []), `BYMONTHDAY=${rule.day}`];
  // The end is the last instant of `until` in the rule's zone, written as UTC as RFC 5545 requires with a zoned start.
  if (when.until) parts.push(`UNTIL=${utcStamp(zonedInstant(addDays(when.until, 1), '00:00', timeZone) - 1000)}`);
  return { kind: 'rrule', rrule: `DTSTART;TZID=${timeZone}:${compact(start, rule.time)}\nRRULE:${parts.join(';')}` };
}

/** The rule behind what a Harness reports, when it is one this module writes or an equivalent plain shape. */
export function fromNative(timing: ReportedTiming, fallbackZone: string): When | undefined {
  switch (timing.kind) {
    case 'once': { const at = zoned(Date.parse(timing.at), fallbackZone); return { rule: { kind: 'once', date: at.date, time: at.time }, timeZone: fallbackZone }; }
    case 'daily': return { rule: { kind: 'daily', time: timing.time.slice(0, 5) }, timeZone: timing.timeZone };
    case 'weekly': return { rule: { kind: 'weekly', weekdays: [...timing.weekdays], time: timing.time.slice(0, 5) }, timeZone: timing.timeZone };
    case 'cron': {
      const fields = timing.expression.trim().split(/\s+/);
      const monthly = fields.length === 5 && /^\d{1,2}$/.test(fields[0]!) && /^\d{1,2}$/.test(fields[1]!) && /^\d{1,2}$/.test(fields[2]!) && fields[4] === '*' ? months(fields[3]!) : undefined;
      if (monthly !== undefined) return { rule: { kind: 'monthly', day: Number(fields[2]), ...(monthly.length ? { months: monthly } : {}), time: `${fields[1]!.padStart(2, '0')}:${fields[0]!.padStart(2, '0')}` }, timeZone: timing.timeZone };
      return { rule: { kind: 'cron', expression: timing.expression }, timeZone: timing.timeZone };
    }
    case 'rrule': return fromRrule(timing.rrule);
    default: return undefined;
  }
}
/** Month field of a cron: `*` is every month (empty list); lists and steps such as 3-12/3 become their months. */
function months(field: string): number[] | undefined {
  if (field === '*') return [];
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const step = /^(\d{1,2})-(\d{1,2})\/(\d{1,2})$/.exec(part); const range = /^(\d{1,2})-(\d{1,2})$/.exec(part);
    if (step) for (let m = Number(step[1]); m <= Number(step[2]); m += Number(step[3])) values.add(m);
    else if (range) for (let m = Number(range[1]); m <= Number(range[2]); m++) values.add(m);
    else if (/^\d{1,2}$/.test(part)) values.add(Number(part));
    else return undefined;
  }
  const list = [...values].sort((a, b) => a - b);
  return list.every(m => m >= 1 && m <= 12) ? list : undefined;
}
function fromRrule(text: string): When | undefined {
  const [start, rule] = text.split('\n');
  const head = /^DTSTART;TZID=([A-Za-z_+\-/0-9]+):(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})00$/.exec(start ?? '');
  if (!head || !rule?.startsWith('RRULE:')) return undefined;
  const fields = Object.fromEntries(rule.slice(6).split(';').map(part => part.split('=') as [string, string]));
  const timeZone = head[1]!; const from = `${head[2]}-${head[3]}-${head[4]}`; const time = `${head[5]}:${head[6]}`;
  const known = new Set(['FREQ', 'BYDAY', 'BYMONTH', 'BYMONTHDAY', 'UNTIL', 'COUNT']);
  if (Object.keys(fields).some(key => !known.has(key))) return undefined;
  let until: string | undefined;
  if (fields.UNTIL) {
    const u = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(fields.UNTIL); if (!u) return undefined;
    until = zoned(Date.UTC(+u[1]!, +u[2]! - 1, +u[3]!, +u[4]!, +u[5]!, +u[6]!), timeZone).date;
  }
  if (fields.COUNT === '1' && fields.FREQ === 'DAILY' && !fields.BYDAY && !until) return { rule: { kind: 'once', date: from, time }, timeZone };
  if (fields.COUNT) return undefined;
  const base = { timeZone, from, ...(until ? { until } : {}) };
  if (fields.FREQ === 'DAILY' && !fields.BYDAY && !fields.BYMONTH && !fields.BYMONTHDAY) return { rule: { kind: 'daily', time }, ...base };
  if ((fields.FREQ === 'WEEKLY' || fields.FREQ === 'DAILY') && fields.BYDAY && !fields.BYMONTH && !fields.BYMONTHDAY) {
    const days = fields.BYDAY.split(',').map(code => DAY_CODES.indexOf(code) + 1);
    return days.every(day => day > 0) ? { rule: { kind: 'weekly', weekdays: days, time }, ...base } : undefined;
  }
  if (fields.FREQ === 'MONTHLY' && fields.BYMONTHDAY && /^\d{1,2}$/.test(fields.BYMONTHDAY) && !fields.BYDAY) {
    const list = fields.BYMONTH ? fields.BYMONTH.split(',').map(Number) : undefined;
    return { rule: { kind: 'monthly', day: Number(fields.BYMONTHDAY), ...(list ? { months: list } : {}), time }, ...base };
  }
  return undefined;
}

/** "每个工作日 14:45 · 到 2027-01-31"; the zone is named when it is not the viewer's. */
export function describe(when: When, viewerZone?: string): string {
  const { rule } = when;
  const zone = viewerZone && viewerZone !== when.timeZone ? `（${zoneLabel(when.timeZone)}）` : '';
  const days = (list: number[]) => list.length === 5 && [1, 2, 3, 4, 5].every(day => list.includes(day)) ? '每个工作日'
    : list.length === 7 ? '每天' : `每周${[...list].sort((a, b) => a - b).map(day => DAY_NAMES[day - 1]).join('、')}`;
  const text = rule.kind === 'once' ? `${rule.date} ${rule.time}${zone}（一次）`
    : rule.kind === 'daily' ? `每天 ${rule.time}${zone}`
    : rule.kind === 'weekly' ? `${days(rule.weekdays)} ${rule.time}${zone}`
    : rule.kind === 'monthly' ? `${rule.months?.length ? `${rule.months.join('、')} 月的` : '每月'} ${rule.day} 日 ${rule.time}${zone}`
    : `按 cron「${rule.expression}」${zone}`;
  return [text, when.from ? `从 ${when.from} 起` : '', when.until ? `到 ${when.until}` : ''].filter(Boolean).join(' · ');
}
export function zoneLabel(zone: string): string { return zone === 'Asia/Shanghai' ? '上海时间' : zone; }

/** The next `count` occurrences strictly after `after`, within `from`/`until`; none for cron, which only the Harness expands.
 * `before` bounds the work to a view window as well, so a page never computes dates it cannot show (ADR 0025). */
export function upcoming(when: When, after: number, count: number, before?: number): number[] {
  const { rule, timeZone } = when; const result: number[] = [];
  if (rule.kind === 'cron' || !validZone(timeZone)) return result;
  if (rule.kind === 'once') { const at = zonedInstant(rule.date, rule.time, timeZone); return at > after && at <= (before ?? Infinity) && count > 0 ? [at] : []; }
  let day = zoned(after, timeZone).date;
  const lastDay = before === undefined ? undefined : zoned(before, timeZone).date;
  if (when.from && when.from > day) day = when.from;
  for (let guard = 0; result.length < count && guard < 3700; guard++, day = addDays(day, 1)) {
    if (when.until && day > when.until) break;
    if (lastDay !== undefined && day > lastDay) break;
    const [, m, d] = day.split('-').map(Number);
    const fits = rule.kind === 'daily' || (rule.kind === 'weekly' && rule.weekdays.includes(weekdayOf(day)))
      || (rule.kind === 'monthly' && d === rule.day && (!rule.months?.length || rule.months.includes(m!)));
    if (!fits) continue;
    const at = zonedInstant(day, rule.time, timeZone);
    if (at > after) {
      if (before !== undefined && at > before) break;
      result.push(at);
    }
  }
  return result;
}

/** Latest calendar occurrence in a committed delivery window. */
export function latestOccurrence(when: When, at: number, floor: number): number {
  const { rule, timeZone } = when;
  if (rule.kind === 'once' || rule.kind === 'cron') return floor;
  const firstDay = zoned(floor, timeZone).date;
  let day = zoned(at, timeZone).date;
  if (when.until && when.until < day) day = when.until;
  for (let guard = 0; guard < 3700 && day >= firstDay; guard++, day = addDays(day, -1)) {
    const [, month, date] = day.split('-').map(Number);
    const fits = rule.kind === 'daily' || (rule.kind === 'weekly' && rule.weekdays.includes(weekdayOf(day)))
      || (rule.kind === 'monthly' && date === rule.day && (!rule.months?.length || rule.months.includes(month!)));
    if (!fits) continue;
    const occurrence = zonedInstant(day, rule.time, timeZone);
    if (occurrence <= at && occurrence >= floor) return occurrence;
  }
  return floor;
}

/** Weekday words a person or an agent writes: 工作日, 每天, 周一,三, mon-fri, 1-5. */
export function parseWeekdays(text: string): number[] | 'daily' | undefined {
  const value = text.trim().toLowerCase();
  if (['每天', '天天', 'daily', 'everyday', 'every day'].includes(value)) return 'daily';
  if (['工作日', '每个工作日', 'weekdays', 'weekday', 'workdays', 'workday'].includes(value)) return [1, 2, 3, 4, 5];
  if (['周末', 'weekend', 'weekends'].includes(value)) return [6, 7];
  const names: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
  const token = (word: string) => { const plain = word.replace(/^(周|星期|礼拜)/, ''); return /^[1-7]$/.test(plain) ? Number(plain) : names[plain]; };
  const days = new Set<number>();
  for (const part of value.split(/[,，、\s]+/).filter(Boolean)) {
    const range = /^(.+?)[-~至到](.+)$/.exec(part);
    if (range) { const a = token(range[1]!); const b = token(range[2]!); if (!a || !b || a > b) return undefined; for (let d = a; d <= b; d++) days.add(d); continue; }
    const one = token(part); if (!one) return undefined; days.add(one);
  }
  return days.size ? [...days].sort((a, b) => a - b) : undefined;
}

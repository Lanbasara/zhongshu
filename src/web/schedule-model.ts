/**
 * Pure model of the schedule page (ADR 0021): native automations and workspace timeline entries become dated items.
 * Dates are the viewer's local calendar days. Daily and weekly tasks are expanded in their own time zone; other
 * recurring rules show only the occurrence the Harness reports, so nothing here guesses a native rule.
 */
import type { AgentNotificationView, AutomationView, TimelineEntry } from '../shared/automations.ts';

export type ItemKind = 'agent' | 'action' | 'event' | 'decision' | 'research';
export type ItemStatus = 'done' | 'running' | 'next' | 'todo' | 'paused';
export type ScheduleItem = {
  key: string; kind: ItemKind; date: string; time?: string; at?: number; title: string; detail?: string;
  status: ItemStatus; routine?: boolean; late?: boolean; notified?: string;
  automationId?: string; conversationId?: string; entry?: TimelineEntry; movable?: boolean;
};
export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

export function localDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
export const localTime = (value: Date) => `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
export function parseDate(value: string): Date { const [y, m, d] = value.split('-').map(Number); return new Date(y!, m! - 1, d!); }
export function addDays(value: string, days: number): string { const date = parseDate(value); date.setDate(date.getDate() + days); return localDate(date); }
export function mondayOf(value: string): string { const date = parseDate(value); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return localDate(date); }
export function dayLabel(value: string): string { const date = parseDate(value); return `${date.getMonth() + 1} 月 ${date.getDate()} 日 周${WEEKDAYS[(date.getDay() + 6) % 7]}`; }

/** Wall-clock parts of an instant in a time zone. */
function zoned(instant: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(String(parts.weekday)) + 1 };
}
/** The instant a wall-clock date and time names in a zone; two passes settle offsets, gaps resolve forward. */
export function zonedInstant(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number); const [hh, mm] = time.split(':').map(Number);
  const wanted = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  let guess = wanted;
  for (let pass = 0; pass < 2; pass++) {
    const seen = zoned(guess, timeZone); const [sy, sm, sd] = seen.date.split('-').map(Number); const [sh, smm] = seen.time.split(':').map(Number);
    guess += wanted - Date.UTC(sy!, sm! - 1, sd!, sh!, smm!);
  }
  return guess;
}
function validZone(timeZone: string): boolean { try { new Intl.DateTimeFormat('en', { timeZone }); return true; } catch { return false; } }

/** One-shot tasks that have not run may be moved in time; recurring ones are edited in the form. */
export function movable(task: AutomationView, now: number): boolean {
  const oneShot = task.timing.kind === 'once' || (task.timing.kind === 'rrule' && /(^|;)COUNT=1(;|$)/m.test(task.timing.rrule));
  return task.status === 'active' && oneShot && Date.parse(task.scheduledAt) > now && !task.executing;
}

/** Items of all tasks and timeline entries between two local dates, inclusive. */
export function scheduleItems(input: { automations: AutomationView[]; timeline: TimelineEntry[]; notifications: AgentNotificationView[]; from: string; to: string; now: number }): ScheduleItem[] {
  const items: ScheduleItem[] = [];
  const at = (instant: number) => { const date = new Date(instant); return { date: localDate(date), time: localTime(date), at: instant }; };
  const inRange = (date: string) => date >= input.from && date <= input.to;
  const placed = input.notifications.filter(entry => entry.conversationId).sort((a, b) => a.createdAt - b.createdAt);
  const noticeAfter = (conversationId: string | undefined, since: number, until = Infinity) =>
    conversationId ? placed.filter(entry => entry.conversationId === conversationId && entry.createdAt >= since - 60_000 && entry.createdAt < until).at(-1)?.summary : undefined;
  let next: { key: string; at: number } | undefined;
  for (const task of input.automations) {
    const routine = task.timing.kind !== 'once' && task.timing.kind !== 'rrule';
    const delivered = task.lastDelivery;
    const conversationId = task.target.conversationId ?? delivered?.conversationId;
    if (delivered) {
      const when = at(Date.parse(delivered.deliveredAt));
      if (inRange(when.date)) items.push({ key: `${task.id}:delivered`, kind: 'agent', ...when, title: task.title, status: task.executing ? 'running' : 'done', routine,
        late: delivered.late, notified: noticeAfter(delivered.conversationId ?? conversationId, Date.parse(delivered.deliveredAt)), automationId: task.id, ...(delivered.conversationId ?? conversationId ? { conversationId: delivered.conversationId ?? conversationId } : {}) });
    }
    if (task.status === 'ended') continue;
    const planned = Date.parse(task.scheduledAt);
    const occurrences: number[] = [];
    if (task.status === 'active' && (task.timing.kind === 'daily' || task.timing.kind === 'weekly') && validZone(task.timing.timeZone)) {
      const timing = task.timing;
      for (let day = addDays(input.from, -1); day <= addDays(input.to, 1); day = addDays(day, 1)) {
        const instant = zonedInstant(day, timing.time, timing.timeZone);
        if (instant < planned - 60_000) continue;
        if (timing.kind === 'weekly' && !timing.weekdays.includes(zoned(instant, timing.timeZone).weekday)) continue;
        occurrences.push(instant);
      }
    } else occurrences.push(planned);
    for (const instant of occurrences) {
      if (delivered && Math.abs(Date.parse(delivered.scheduledAt) - instant) < 60_000) continue; // already shown as delivered
      const when = at(instant);
      if (!inRange(when.date)) continue;
      const key = `${task.id}:${instant}`;
      items.push({ key, kind: 'agent', ...when, title: task.title, status: task.status === 'paused' ? 'paused' : 'todo', routine, automationId: task.id,
        ...(conversationId ? { conversationId } : {}), ...(occurrences.length === 1 && movable(task, input.now) ? { movable: true } : {}) });
      if (task.status === 'active' && instant > input.now && (!next || instant < next.at)) next = { key, at: instant };
    }
  }
  if (next) { const item = items.find(entry => entry.key === next!.key); if (item) item.status = 'next'; }
  for (const entry of input.timeline) {
    let date = entry.date; let time = entry.time; let instant: number | undefined;
    if (entry.time && entry.tz && validZone(entry.tz)) { const local = at(zonedInstant(entry.date, entry.time, entry.tz)); date = local.date; time = local.time; instant = local.at; }
    if (!inRange(date)) continue;
    const past = instant !== undefined ? instant < input.now : date < localDate(new Date(input.now));
    items.push({ key: `timeline:${entry.workspaceId}:${entry.id}`, kind: entry.kind, date, ...(time ? { time } : {}), ...(instant !== undefined ? { at: instant } : {}),
      title: entry.title, ...(entry.detail ? { detail: entry.detail } : {}), status: entry.status === 'done' || entry.status === 'cancelled' || past ? 'done' : 'todo', entry });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
}

/** Counts for the summary strip; busy days have at least three non-routine, non-record items from today on. */
export function summarize(items: ScheduleItem[], today: string) {
  const pending = (item: ScheduleItem) => item.status === 'todo' || item.status === 'next';
  const perDay = new Map<string, number>();
  for (const item of items) if (!item.routine && item.kind !== 'decision' && item.kind !== 'research' && item.date >= today) perDay.set(item.date, (perDay.get(item.date) ?? 0) + 1);
  return {
    tasks: items.filter(item => item.kind === 'agent' && !item.routine && pending(item)).length,
    routine: items.filter(item => item.kind === 'agent' && item.routine && pending(item)).length,
    actions: items.filter(item => item.kind === 'action' && item.status !== 'done').length,
    notified: items.filter(item => item.notified).length,
    late: items.filter(item => item.late).length,
    paused: new Set(items.filter(item => item.status === 'paused').map(item => item.automationId)).size,
    busy: [...perDay.values()].filter(count => count >= 3).length,
    busyDays: new Set([...perDay].filter(([, count]) => count >= 3).map(([day]) => day)),
  };
}

export function timingText(task: AutomationView): string {
  const timing = task.timing;
  const zone = (value: string) => value === Intl.DateTimeFormat().resolvedOptions().timeZone ? '' : ` · ${value}`;
  switch (timing.kind) {
    case 'once': { const date = new Date(timing.at); return `一次 · ${date.getMonth() + 1}-${date.getDate()} ${localTime(date)}`; }
    case 'every': return timing.seconds % 3600 === 0 ? `每 ${timing.seconds / 3600} 小时` : `每 ${Math.round(timing.seconds / 60)} 分钟`;
    case 'daily': return `每天 ${timing.time}${zone(timing.timeZone)}`;
    case 'weekly': return `每周${timing.weekdays.map(day => WEEKDAYS[day - 1]).join('、')} ${timing.time}${zone(timing.timeZone)}`;
    case 'cron': return `按规则 ${timing.expression}${zone(timing.timeZone)}`;
    case 'rrule': return /COUNT=1\b/.test(timing.rrule) ? `一次 · ${localTime(new Date(task.scheduledAt))}` : '按 RRULE 规则';
  }
}

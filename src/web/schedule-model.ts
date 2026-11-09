/**
 * Pure model of the schedule page (ADR 0021): native automations and workspace timeline entries become dated items.
 * Dates are the viewer's local calendar days. Daily and weekly tasks are expanded in their own time zone; other
 * recurring rules show only the occurrence the Harness reports, so nothing here guesses a native rule.
 */
import type { AgentNotificationView, AutomationView, TimelineEntry } from '../shared/automations.ts';
import type { WorkbenchConfiguration } from '../shared/workbench.ts';
import { conversationConfigurationLabel } from './conversation-configuration-label.ts';
import { describe, fromNative, upcoming, validZone, zoned, zonedInstant, type When } from '../sichen/time.ts';

export { zonedInstant };

export type ItemKind = 'agent' | 'action' | 'event' | 'decision' | 'research';
/** `overdue`: an action of the user's whose time passed; nothing here knows whether it was done. */
export type ItemStatus = 'done' | 'running' | 'next' | 'todo' | 'paused' | 'overdue';
export type ScheduleItem = {
  key: string; kind: ItemKind; date: string; time?: string; at?: number; title: string; detail?: string;
  status: ItemStatus; routine?: boolean; late?: boolean; notified?: string;
  /** The one-line conclusion the agent wrote back for this run (ADR 0021, 2026-11-09). */
  result?: string;
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
/** "11 月 15 日 10:00（6 天后）": an instant with how far it is from today in calendar days. */
export function whenText(instant: number, now: number): string {
  const date = new Date(instant);
  const days = Math.round((parseDate(localDate(date)).getTime() - parseDate(localDate(new Date(now))).getTime()) / 86_400_000);
  const relative = days === 0 ? '今天' : days === 1 ? '明天' : days === -1 ? '昨天' : days > 0 ? `${days} 天后` : `${-days} 天前`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${localTime(date)}（${relative}）`;
}
export function dayLabel(value: string): string { const date = parseDate(value); return `${date.getMonth() + 1} 月 ${date.getDate()} 日 周${WEEKDAYS[(date.getDay() + 6) % 7]}`; }

/** Wall-clock parts of an instant in a time zone. */
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
  // A conversation can receive several tasks' runs; a notice belongs to the run delivered last before it.
  const deliveries = new Map<string, number[]>();
  for (const task of input.automations) {
    const id = task.lastDelivery?.conversationId ?? task.target.conversationId;
    if (task.lastDelivery && id) deliveries.set(id, [...(deliveries.get(id) ?? []), Date.parse(task.lastDelivery.deliveredAt)].sort((a, b) => a - b));
  }
  const nextDelivery = (conversationId: string | undefined, after: number) => (conversationId ? deliveries.get(conversationId)?.find(value => value > after) : undefined) ?? Infinity;
  let next: { key: string; at: number } | undefined;
  for (const task of input.automations) {
    const routine = task.timing.kind !== 'once' && task.timing.kind !== 'rrule';
    const delivered = task.lastDelivery;
    const conversationId = task.target.conversationId ?? delivered?.conversationId;
    if (delivered) {
      const when = at(Date.parse(delivered.deliveredAt));
      if (inRange(when.date)) items.push({ key: `${task.id}:delivered`, kind: 'agent', ...when, title: task.title, status: task.executing ? 'running' : 'done', routine,
        late: delivered.late, notified: noticeAfter(delivered.conversationId ?? conversationId, Date.parse(delivered.deliveredAt), nextDelivery(delivered.conversationId ?? conversationId, Date.parse(delivered.deliveredAt))), automationId: task.id,
        ...(delivered.result ? { result: delivered.result } : {}), ...(delivered.conversationId ?? conversationId ? { conversationId: delivered.conversationId ?? conversationId } : {}) });
    }
    if (task.status === 'ended') continue;
    const planned = Date.parse(task.scheduledAt);
    const occurrences: number[] = [];
    // Recurring rules the time model reads (daily, weekly, monthly, with starts and ends) are laid out up to their end;
    // other rules show only the occurrence the Harness reports.
    const rule = task.status === 'active' ? fromNative(task.timing, Intl.DateTimeFormat().resolvedOptions().timeZone) : undefined;
    if (rule && rule.rule.kind !== 'once' && rule.rule.kind !== 'cron' && validZone(rule.timeZone)) {
      const end = zonedInstant(addDays(input.to, 2), '00:00', rule.timeZone);
      for (const instant of upcoming(rule, planned - 60_000, 800)) { if (instant > end) break; occurrences.push(instant); }
    } else occurrences.push(planned);
    for (const instant of occurrences) {
      if (delivered && Math.abs(Date.parse(delivered.scheduledAt) - instant) < 60_000) continue; // already shown as delivered
      const when = at(instant);
      if (!inRange(when.date)) continue;
      const key = `${task.id}:${instant}`;
      // A future run opens a known conversation only when the task always returns to one; a new conversation per run has none yet.
      items.push({ key, kind: 'agent', ...when, title: task.title, status: task.status === 'paused' ? 'paused' : 'todo', routine, automationId: task.id,
        ...(task.target.conversationId ? { conversationId: task.target.conversationId } : {}), ...(occurrences.length === 1 && movable(task, input.now) ? { movable: true } : {}) });
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
      title: entry.title, ...(entry.detail ? { detail: entry.detail } : {}),
      // A user's action is done only when its line says so; a passed time alone proves nothing (2026-11-09).
      status: entry.status === 'done' || entry.status === 'cancelled' ? 'done' : !past ? 'todo' : entry.kind === 'action' ? 'overdue' : 'done', entry });
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

/** The rule in words, through 司辰's time model (ADR 0022): "每个工作日 14:45 · 到 2027-01-31". */
export function timingText(task: AutomationView, now = Date.now()): string {
  const timing = task.timing;
  if (timing.kind === 'every') return timing.seconds % 3600 === 0 ? `每 ${timing.seconds / 3600} 小时` : `每 ${Math.round(timing.seconds / 60)} 分钟`;
  const viewer = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = ruleOf(task, now);
  if (!when) return timing.kind === 'cron' ? `按规则 ${timing.expression}` : '按原生规则';
  if (when.rule.kind === 'once') { const date = new Date(task.scheduledAt); return `一次 · ${date.getMonth() + 1}-${date.getDate()} ${localTime(date)}`; }
  return describe(when, viewer);
}
/** The task's rule when the time model reads it; a start that has already come is dropped from what is shown. */
export function ruleOf(task: AutomationView, now = Date.now()): When | undefined {
  if (task.timing.kind === 'every') return undefined;
  const read = fromNative(task.timing, Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (!read?.from || read.from > zoned(now, read.timeZone).date) return read;
  const { from: _from, ...rest } = read; return rest;
}

/** The instruction a task delivers: an optional skill named first, so the agent loads it before anything else. */
export function instructionWithSkill(prompt: string, skill?: { name: string }) {
  const text = prompt.trim();
  return skill ? `使用技能 ${skill.name}（/${skill.name}）。${text ? `\n\n${text}` : ''}` : text;
}

/** What the runs of a task use, in words: the conversation's fixed configuration, or the Harness defaults with a preset. */
export function runConfigurationText(task: AutomationView, configuration?: WorkbenchConfiguration) {
  const dsh = configuration?.harnesses.find(item => item.id === 'dsh');
  const fixed = task.target.configuration;
  if (fixed) {
    const label = conversationConfigurationLabel({ harnessId: 'dsh', configuration: fixed }, configuration?.harnesses);
    const permission = dsh?.permissions.find(item => item.id === fixed.permissionId)?.label ?? fixed.permissionId;
    return [label.model, label.reasoningEffort, permission, label.agentPreset].filter(Boolean).join(' · ');
  }
  if (task.target.kind === 'new' || task.target.kind === 'new_once') {
    const preset = task.target.preset ? dsh?.presets?.find(item => item.id === task.target.preset)?.label ?? task.target.preset : '默认预设';
    return `${preset} · 模型、思考深度和权限用宿主默认`;
  }
  return '中书之外的会话';
}

/**
 * The schedule page (ADR 0021): calendar, today, future, look-back and all tasks. Native automations are read and
 * changed through the private API; the workspace timeline is read-only. Nothing about a task is kept in the browser.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Bell, ChevronLeft, ChevronRight, Clock, Pause, Play, Plus, Trash2, X } from 'lucide-react';
import { z } from 'zod';
import {
  agentNotificationListSchema, automationHistorySchema, automationListSchema, automationResultSchema, timelineSchema,
  type AgentNotificationView, type AutomationDeliveryView, type AutomationView, type TimelineView,
} from '../shared/automations.ts';
import type { WorkbenchConfiguration } from '../shared/workbench.ts';
import { Button, IconButton } from './ui/controls.tsx';
import { request } from './workbench-client.ts';
import { useBackDismiss } from './navigation.ts';
import { useNarrow } from './patterns/workbench-frame.tsx';
import { CreateForm, Field, TimingFields, initialTiming, timingFrom } from './schedule-forms.tsx';
import { addDays, dayLabel, localDate, localTime, mondayOf, parseDate, ruleOf, runConfigurationText, scheduleItems, summarize, timingText, whenText, WEEKDAYS, type ScheduleItem } from './schedule-model.ts';
import './schedule.css';

export type ScheduleTab = 'calendar' | 'today' | 'future' | 'past' | 'tasks';
export const scheduleTabs: { id: ScheduleTab; label: string }[] = [
  { id: 'calendar', label: '日历' }, { id: 'today', label: '今天' }, { id: 'future', label: '未来' }, { id: 'past', label: '回看' }, { id: 'tasks', label: '全部任务' },
];
type Filters = Record<'agent' | 'routine' | 'action' | 'event' | 'record', boolean>;
type Panel = { kind: 'task'; id: string } | { kind: 'create'; conversationId?: string } | { kind: 'entry'; item: ScheduleItem };
const kindLabel: Record<ScheduleItem['kind'], string> = { agent: 'Agent 任务', action: '你要做的', event: '外部大事', decision: '决定', research: '研究' };
const HOUR = 48; const START = 7; const END = 24;

function useScheduleData(csrf: string, revision: number, report: (reason: unknown) => void) {
  const [automations, setAutomations] = useState<AutomationView[]>([]);
  const [available, setAvailable] = useState(true);
  const [timeline, setTimeline] = useState<TimelineView>({ entries: [], problems: [] });
  const [notifications, setNotifications] = useState<AgentNotificationView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    try {
      const [list, line, notes] = await Promise.all([request('/automations', automationListSchema), request('/timeline', timelineSchema), request('/notifications', agentNotificationListSchema)]);
      setAutomations(list.automations); setAvailable(list.available); setTimeline(line); setNotifications(notes.notifications);
    } catch (error) { report(error); } finally { setLoaded(true); }
  }, [report]);
  useEffect(() => { void reload(); }, [reload, revision]);
  useEffect(() => {
    // Deliveries happen on the Host's clock; a visible page re-reads now and then instead of holding a stream.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, 30_000);
    return () => clearInterval(timer);
  }, [reload]);
  void csrf;
  return { automations, available, timeline, notifications, loaded, reload };
}

export function ScheduleView({ csrf, report, configuration, revision, tab, onTab, openConversation, openFile, createFor, onCreateHandled }: {
  csrf: string; report(reason: unknown): void; configuration?: WorkbenchConfiguration; revision: number;
  tab: ScheduleTab; onTab(tab: ScheduleTab): void; openConversation(id: string): void; openFile(workspaceId: string, path: string): void;
  /** Open the form already pointed at this conversation (from its automations strip). */
  createFor?: string; onCreateHandled?(): void;
}) {
  const data = useScheduleData(csrf, revision, report);
  const [panel, setPanel] = useState<Panel>();
  // On a phone the task card covers the page; the back gesture closes it first.
  useBackDismiss(!!panel, () => setPanel(undefined), useNarrow());
  // Refusals from the Harness (a newer edit elsewhere, a finished or running task) are explained here, not as connection errors.
  const [notice, setNotice] = useState<string>();
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(undefined), 8000); return () => clearTimeout(timer); }, [notice]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (createFor) { setPanel({ kind: 'create', conversationId: createFor }); onCreateHandled?.(); } }, [createFor, onCreateHandled]);
  const today = localDate(new Date(now));
  const [mode, setMode] = useState<'month' | 'week'>('month');
  const [selected, setSelected] = useState(today);
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [filters, setFilters] = useState<Filters>({ agent: true, routine: true, action: true, event: true, record: true });
  const [week, setWeek] = useState(0);
  const items = useMemo(() => scheduleItems({ automations: data.automations, timeline: data.timeline.entries, notifications: data.notifications,
    from: addDays(today, -400), to: addDays(today, 400), now }), [data.automations, data.timeline.entries, data.notifications, today, now]);
  const visible = useMemo(() => items.filter(item => filters[item.kind === 'agent' ? (item.routine ? 'routine' : 'agent') : item.kind === 'decision' || item.kind === 'research' ? 'record' : item.kind]), [items, filters]);
  const open = (item: ScheduleItem) => {
    // A card opens the card first, like the native app; its conversation is one step away on it (ADR 0021, 2026-11-09).
    if (item.automationId) return setPanel({ kind: 'task', id: item.automationId });
    setPanel({ kind: 'entry', item });
  };
  /** Write one change to the native task; true when the Harness accepted it. */
  const edit = async (task: AutomationView, body: { patch: Record<string, unknown> }): Promise<boolean> => {
    let accepted = false;
    try {
      const result = await request(`/automations/${encodeURIComponent(task.id)}/edit`, automationResultSchema, { csrf, body: { ...body, ...(task.updatedAt ? { expectedUpdatedAt: task.updatedAt } : {}) } });
      accepted = result.outcome === 'ok';
      if (!accepted) setNotice(refusals[result.outcome] ?? refusals.not_found);
    } catch (error) { report(error); }
    await data.reload();
    return accepted;
  };
  const content = !data.loaded ? <p className="quiet">正在读取日程…</p>
    : tab === 'calendar' ? <CalendarTab items={visible} all={items} today={today} now={now} mode={mode} setMode={setMode} selected={selected} setSelected={setSelected}
      month={month} setMonth={setMonth} filters={filters} setFilters={setFilters} open={open} automations={data.automations} edit={edit}/>
    : tab === 'today' ? <DayList items={visible.filter(item => item.date === today)} now={now} today={today} open={open} heading={`${dayLabel(today)} · 现在 ${localTime(new Date(now))}`}/>
    : tab === 'future' ? <FutureTab items={visible} today={today} week={week} setWeek={setWeek} open={open}/>
    : tab === 'past' ? <PastTab items={visible} today={today} open={open} problems={data.timeline.problems} labels={configuration?.workspaces}/>
    : <TasksTab automations={data.automations} open={id => setPanel({ kind: 'task', id })} now={now}/>;
  return <div className="schedule">
    <div className="schedule-tabs" role="tablist" aria-label="日程视图">
      {scheduleTabs.map(entry => <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className="schedule-tab" onClick={() => onTab(entry.id)}>{entry.label}</button>)}
      <span className="schedule-tabs-spacer"/>
      {data.available && <Button size="small" aria-label="新建自动任务" onClick={() => setPanel({ kind: 'create' })}><Plus size={14}/><span className="sch-new-label">新建自动任务</span></Button>}
    </div>
    <div className="schedule-body">
      {notice && !panel && <p className="sch-notice" role="status">{notice}</p>}
      {!data.available && data.loaded && <p className="schedule-note">这个实例没有可用的原生自动任务（需要 DSH 0.2.2 及以上）。时间轴文件仍会显示。</p>}
      {content}
    </div>
    {panel && <SchedulePanel panel={panel} automations={data.automations} configuration={configuration} csrf={csrf} report={report} close={() => setPanel(undefined)} now={now}
      notice={notice} notify={setNotice} reload={data.reload} edit={edit} openConversation={id => { setPanel(undefined); openConversation(id); }} openFile={(workspaceId, path) => { setPanel(undefined); openFile(workspaceId, path); }} notifications={data.notifications}/>}
  </div>;
}

function KindMark({ item }: { item: ScheduleItem }) { return <i className={`sch-kind sch-kind-${item.kind}${item.routine ? ' sch-routine' : ''}`} aria-hidden="true"/>; }
function StatusMark({ item }: { item: ScheduleItem }) {
  if (item.status === 'paused') return <span className="sch-status" title="已暂停"><Pause size={10}/></span>;
  if (item.late) return <span className="sch-status sch-late" title="迟到">迟</span>;
  if (item.status === 'running') return <span className="sch-status sch-running" title="运行中"/>;
  if (item.notified) return <span className="sch-status sch-notified" title="已通知你"><Bell size={10}/></span>;
  if (item.status === 'next') return <span className="sch-status sch-next" title="下一个">●</span>;
  if (item.status === 'overdue') return <span className="sch-status sch-overdue" title="已过时间，还不知道做没做">!</span>;
  if (item.status === 'done') return <span className="sch-status" title={item.kind === 'agent' ? '已运行' : '已过'}>✓</span>;
  return null;
}
function Row({ item, open, showDate }: { item: ScheduleItem; open(item: ScheduleItem): void; showDate?: boolean }) {
  return <button type="button" className={`sch-row${item.status === 'done' ? ' sch-past' : ''}`} onClick={() => open(item)}>
    <span className="sch-time">{showDate ? item.date.slice(5) + ' ' : ''}{item.time ?? '全天'}</span>
    <KindMark item={item}/>
    <span className="sch-main">
      <span className="sch-title">{item.title}{item.status === 'paused' ? '（已暂停）' : ''}</span>
      {item.result && <span className="sch-summary sch-result">{item.result}</span>}
      {item.notified && <span className="sch-summary">“{item.notified}”</span>}
      {item.detail && <span className="sch-summary">{item.detail}</span>}
      <span className="sch-chips">
        {item.kind !== 'agent' && <span className="sch-chip">{kindLabel[item.kind]}{item.entry ? ` · ${item.entry.workspaceLabel}` : ''}</span>}
        {item.routine && <span className="sch-chip">例行</span>}
        {item.notified && <span className="sch-chip sch-chip-notified"><Bell size={10}/>已通知你</span>}
        {item.late && <span className="sch-chip sch-chip-late">迟到</span>}
        {item.kind === 'agent' && item.status === 'done' && <span className="sch-chip">已运行</span>}
        {item.kind === 'agent' && item.status === 'todo' && <span className="sch-chip">待运行</span>}
        {item.status === 'overdue' && <span className="sch-chip sch-chip-late">已过时间</span>}
        {item.status === 'running' && <span className="sch-chip sch-chip-next">运行中</span>}
        {item.status === 'next' && <span className="sch-chip sch-chip-next">下一个</span>}
      </span>
    </span>
  </button>;
}
function Legend() {
  return <div className="sch-legend"><span><i className="sch-kind sch-kind-agent"/>Agent 的自动任务</span><span><i className="sch-kind sch-kind-action"/>你要做的操作</span>
    <span><i className="sch-kind sch-kind-event"/>外部大事</span><span><i className="sch-kind sch-kind-decision"/>研究与决定</span></div>;
}
function DayList({ items, now, today, open, heading }: { items: ScheduleItem[]; now: number; today: string; open(item: ScheduleItem): void; heading: string }) {
  const nowTime = localTime(new Date(now)); let placed = false;
  return <section className="sch-column">
    <h2 className="sch-heading">{heading}</h2><Legend/>
    {items.length === 0 && <p className="quiet">今天没有安排。</p>}
    {items.map(item => {
      const line = !placed && items[0]!.date === today && (item.time ?? '') > nowTime ? (placed = true) : false;
      return <div key={item.key}>{line && <div className="sch-now" aria-label={`现在 ${nowTime}`}><span>{nowTime}</span><i/></div>}<Row item={item} open={open}/></div>;
    })}
    <p className="schedule-note">蓝色来自原生自动任务，中书直接读取；其余来自工作区的时间轴文件（Agent 写，中书只读）。</p>
  </section>;
}

function CalendarTab(props: {
  items: ScheduleItem[]; all: ScheduleItem[]; today: string; now: number; mode: 'month' | 'week'; setMode(mode: 'month' | 'week'): void;
  selected: string; setSelected(date: string): void; month: string; setMonth(month: string): void; filters: Filters; setFilters(filters: Filters): void;
  open(item: ScheduleItem): void; automations: AutomationView[]; edit(task: AutomationView, body: { patch: Record<string, unknown> }): Promise<boolean>;
}) {
  const { items, today, mode, selected, month } = props;
  const monthStart = `${month}-01`;
  const from = mode === 'month' ? monthStart : mondayOf(selected);
  const to = mode === 'month' ? localDate(new Date(parseDate(monthStart).getFullYear(), parseDate(monthStart).getMonth() + 1, 0)) : addDays(from, 6);
  const range = items.filter(item => item.date >= from && item.date <= to);
  const stats = summarize(range, today);
  const shiftMonth = (delta: number) => { const date = parseDate(monthStart); date.setMonth(date.getMonth() + delta); props.setMonth(localDate(date).slice(0, 7)); };
  const title = mode === 'month' ? `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月` : `${from.slice(5).replace('-', '/')} – ${to.slice(5).replace('-', '/')}`;
  const filterRow: [keyof Filters, string, string][] = [['agent', 'agent', 'Agent 任务'], ['routine', 'agent', '例行'], ['action', 'action', '你要做的'], ['event', 'event', '外部大事'], ['record', 'decision', '研究与决定']];
  return <section className="sch-calendar">
    <div className="sch-bar">
      <h2>{title}</h2>
      <IconButton label={mode === 'month' ? '上个月' : '上一周'} onClick={() => mode === 'month' ? shiftMonth(-1) : props.setSelected(addDays(selected, -7))}><ChevronLeft size={16}/></IconButton>
      <IconButton label={mode === 'month' ? '下个月' : '下一周'} onClick={() => mode === 'month' ? shiftMonth(1) : props.setSelected(addDays(selected, 7))}><ChevronRight size={16}/></IconButton>
      <Button size="small" onClick={() => { props.setSelected(today); props.setMonth(today.slice(0, 7)); }}>今天</Button>
      <span className="sch-spacer"/>
      <div className="sch-seg" role="group" aria-label="视图">
        <button type="button" aria-pressed={mode === 'month'} onClick={() => { props.setMode('month'); props.setMonth(selected.slice(0, 7)); }}>月</button>
        <button type="button" aria-pressed={mode === 'week'} onClick={() => props.setMode('week')}>周</button>
      </div>
    </div>
    <div className="sch-filters" role="group" aria-label="显示哪些内容">
      {filterRow.map(([key, kind, label]) => <button key={key} type="button" className="sch-filter" aria-pressed={props.filters[key]} onClick={() => props.setFilters({ ...props.filters, [key]: !props.filters[key] })}>
        <i className={`sch-kind sch-kind-${kind}${key === 'routine' ? ' sch-routine' : ''}`}/>{label}</button>)}
    </div>
    <div className="sch-stats" role="status">
      <span><b>{stats.tasks}</b>个 Agent 任务待跑</span><span><b>{stats.routine}</b>次例行待跑</span><span><b>{stats.actions}</b>件你要做</span>
      <span><b>{stats.notified}</b>次通知过你</span><span className={stats.late ? 'sch-warn' : ''}><b>{stats.late}</b>次迟到</span>
      <span className={stats.paused ? 'sch-warn' : ''}><b>{stats.paused}</b>个已暂停</span><span className={stats.busy ? 'sch-warn' : ''}><b>{stats.busy}</b>个密集日</span>
    </div>
    {mode === 'month'
      ? <div className="sch-layout"><MonthGrid items={items} month={month} today={today} selected={selected} busy={stats.busyDays} select={props.setSelected}/><DaySide items={items} date={selected} today={today} open={props.open}/></div>
      : <><WeekGrid items={items} from={from} today={today} now={props.now} open={props.open} automations={props.automations} edit={props.edit} select={props.setSelected}/>
        <p className="schedule-note">电脑上可以拖动还没跑的一次性任务改期（15 分钟一格）；循环任务点开后在表单里改。</p>
        <DaySide items={items} date={selected} today={today} open={props.open}/></>}
  </section>;
}
function MonthGrid({ items, month, today, selected, busy, select }: { items: ScheduleItem[]; month: string; today: string; selected: string; busy: Set<string>; select(date: string): void }) {
  const first = `${month}-01`; const start = mondayOf(first);
  const days: string[] = [];
  for (let index = 0; index < 42; index++) { const day = addDays(start, index); if (index >= 35 && day.slice(0, 7) !== month && index % 7 === 0) break; days.push(day); }
  const byDay = new Map<string, ScheduleItem[]>();
  for (const item of items) { const list = byDay.get(item.date); if (list) list.push(item); else byDay.set(item.date, [item]); }
  return <div className="sch-month">
    <div className="sch-dow">{WEEKDAYS.map(day => <span key={day}>周{day}</span>)}</div>
    <div className="sch-grid">{days.map(day => {
      const list = byDay.get(day) ?? []; const main = list.filter(item => !item.routine); const routine = list.filter(item => item.routine);
      // Today and later: timed work first. Past days: what was decided first.
      const ordered = [...main].sort((a, b) => day >= today ? Number(!a.time) - Number(!b.time) || (a.time ?? '').localeCompare(b.time ?? '') : Number(!!a.time) - Number(!!b.time) || (a.time ?? '').localeCompare(b.time ?? ''));
      const other = day.slice(0, 7) !== month;
      return <button key={day} type="button" className={`sch-cell${other ? ' sch-other' : ''}${day < today ? ' sch-before' : ''}${day === today ? ' sch-today' : ''}${busy.has(day) ? ' sch-busy' : ''}`}
        aria-pressed={day === selected} aria-label={`${dayLabel(day)}，${list.length} 项`} onClick={() => select(day)}>
        <span className="sch-cell-top"><span className="sch-dn">{parseDate(day).getDate()}</span>{busy.has(day) && <span className="sch-busy-tag">密集</span>}</span>
        {ordered.slice(0, 3).map(item => <span key={item.key} className={`sch-ev sch-ev-${item.kind}${item.status === 'done' ? ' sch-done' : ''}${item.status === 'paused' ? ' sch-paused' : ''}`}>
          <StatusMark item={item}/>{item.time && <span className="sch-ev-time">{item.time}</span>}<span className="sch-ev-name">{item.title}</span></span>)}
        {ordered.length > 3 && <span className="sch-more">还有 {ordered.length - 3} 项</span>}
        {routine.length > 0 && <span className="sch-routine-dots">{routine.slice(0, 6).map(item => <i key={item.key}/>)}<span>例行</span></span>}
        <span className="sch-mini" aria-hidden="true">{list.slice(0, 5).map(item => <i key={item.key} className={`sch-kind-bg-${item.kind}${item.routine ? ' sch-routine' : ''}`}/>)}</span>
      </button>;
    })}</div>
  </div>;
}
function DaySide({ items, date, today, open }: { items: ScheduleItem[]; date: string; today: string; open(item: ScheduleItem): void }) {
  const list = items.filter(item => item.date === date).sort((a, b) => Number(!!a.time) - Number(!!b.time) || (a.time ?? '').localeCompare(b.time ?? ''));
  const count = (kind: ScheduleItem['kind']) => list.filter(item => item.kind === kind).length;
  return <aside className="sch-day" aria-label="所选日期">
    <h3>{dayLabel(date)}{date === today ? ' · 今天' : ''}</h3>
    <p className="sch-day-sub">Agent {count('agent')} · 你要做 {count('action')} · 外部 {count('event')}</p>
    {list.length ? list.map(item => <Row key={item.key} item={item} open={open}/>) : <p className="quiet">这天没有安排。</p>}
  </aside>;
}
function WeekGrid({ items, from, today, now, open, automations, edit, select }: {
  items: ScheduleItem[]; from: string; today: string; now: number; open(item: ScheduleItem): void; automations: AutomationView[];
  edit(task: AutomationView, body: { patch: Record<string, unknown> }): Promise<boolean>; select(date: string): void;
}) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(from, index));
  const wrap = useRef<HTMLDivElement>(null);
  const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  // Open on today's column and on the hours that matter: an hour before now this week, else the week's first timed item.
  // The header, all-day row and hour labels stay put, so nothing is hidden by the scroll.
  useEffect(() => {
    const element = wrap.current; if (!element) return;
    const column = element.querySelector<HTMLElement>(`.sch-wk-col[data-date="${today}"]`);
    const hours = element.querySelector<HTMLElement>('.sch-wk-hours');
    if (column && element.scrollWidth > element.clientWidth) element.scrollLeft = Math.max(0, column.offsetLeft - (hours?.offsetWidth ?? 0));
    const timed = items.filter(item => item.time && item.date >= from && item.date <= addDays(from, 6) && toMinutes(item.time) >= START * 60).map(item => toMinutes(item.time!));
    const focus = days.includes(today) ? toMinutes(localTime(new Date(now))) - 60 : timed.length ? Math.min(...timed) - 30 : START * 60;
    element.scrollTop = Math.max(0, (Math.min(focus, END * 60 - 120) - START * 60) / 60 * HOUR);
    // Only when the week or the day changes; a data refresh keeps where the reader scrolled.
  }, [today, from]);
  const drag = (item: ScheduleItem, event: ReactPointerEvent<HTMLButtonElement>) => {
    const task = automations.find(entry => entry.id === item.automationId);
    if (!item.movable || !task || event.pointerType !== 'mouse' || event.button !== 0 || !item.time) return;
    // The block only moves visually (top and a horizontal shift); React keeps owning where it lives in the tree.
    const block = event.currentTarget; const home = block.parentElement as HTMLElement; const startY = event.clientY; const startX = event.clientX;
    const label = block.querySelector('.sch-blk-time'); const original = { top: block.style.top, label: label?.textContent ?? '' };
    let moved = false; let minutes = toMinutes(item.time); let column = home;
    const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    const restore = () => { block.classList.remove('sch-dragging'); block.style.top = original.top; block.style.transform = ''; if (label) label.textContent = original.label; };
    const move = (next: PointerEvent) => {
      if (!moved && Math.abs(next.clientY - startY) < 4 && Math.abs(next.clientX - startX) < 4) return;
      moved = true; block.classList.add('sch-dragging');
      minutes = Math.min(Math.max(toMinutes(item.time!) + Math.round((next.clientY - startY) / (HOUR / 4)) * 15, START * 60), END * 60 - 15);
      block.style.top = `${(minutes - START * 60) / 60 * HOUR}px`;
      if (label) label.textContent = `${clock(minutes)} `;
      const under = document.elementsFromPoint(next.clientX, next.clientY).find(node => node instanceof HTMLElement && node.classList.contains('sch-wk-col') && node.dataset.date) as HTMLElement | undefined;
      if (under && (under.dataset.date ?? '') >= today) column = under;
      block.style.transform = `translateX(${column.getBoundingClientRect().left - home.getBoundingClientRect().left}px)`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (!moved) return;
      block.dataset.dragged = '1';
      const [y, m, d] = column.dataset.date!.split('-').map(Number);
      const instant = new Date(y!, m! - 1, d!, Math.floor(minutes / 60), minutes % 60);
      if (instant.getTime() <= now) { restore(); return; }
      select(column.dataset.date!);
      // On success the item re-renders under its new key; on a refusal the block goes back where it was.
      void edit(task, { patch: { timing: { kind: 'at', at: instant.toISOString() } } }).finally(restore);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const nowTop = (toMinutes(localTime(new Date(now))) - START * 60) / 60 * HOUR;
  return <div className="sch-week-wrap" ref={wrap}><div className="sch-week" style={{ ['--sch-hour' as string]: `${HOUR}px` }}>
    <div className="sch-wk-head"/>
    {days.map(day => <button key={day} type="button" className={`sch-wk-head${day === today ? ' sch-today' : ''}`} onClick={() => select(day)}>
      <span>周{WEEKDAYS[(parseDate(day).getDay() + 6) % 7]}</span><b>{parseDate(day).getDate()}</b></button>)}
    <div className="sch-wk-label">全天</div>
    {days.map(day => <div key={day} className="sch-wk-allday">{items.filter(item => item.date === day && (!item.time || toMinutes(item.time) < START * 60)).map(item =>
      <button key={item.key} type="button" className={`sch-ev sch-ev-${item.kind}${item.status === 'done' ? ' sch-done' : ''}`} onClick={() => open(item)}>
        <StatusMark item={item}/>{item.time && <span className="sch-ev-time">{item.time}</span>}<span className="sch-ev-name">{item.title}</span></button>)}</div>)}
    <div className="sch-wk-hours">{Array.from({ length: END - START }, (_, index) => <div key={index}>{START + index}:00</div>)}</div>
    {days.map(day => {
      const list = items.filter(item => item.date === day && item.time && toMinutes(item.time) >= START * 60).sort((a, b) => a.time!.localeCompare(b.time!));
      // Overlapping blocks cascade: each later one indents and sits on top, so titles stay readable on narrow columns.
      let lane = 0; let end = -1;
      return <div key={day} data-date={day} className={`sch-wk-col${day < today ? ' sch-before' : ''}`} style={{ height: (END - START) * HOUR }}>
        {list.map(item => {
          const start = toMinutes(item.time!); lane = start < end ? lane + 1 : 0; end = Math.max(start < end ? end : 0, start + 30);
          const indent = Math.min(lane, 3) * 16;
          return <button key={item.key} type="button" className={`sch-blk sch-blk-${item.kind} sch-blk-${item.status}${item.movable ? ' sch-movable' : ''}`}
            style={{ top: (start - START * 60) / 60 * HOUR, height: HOUR / 2 - 2, left: `calc(${indent}% + 2px)`, width: `calc(${100 - indent}% - 4px)`, zIndex: 1 + lane }}
            title={item.title} onPointerDown={event => drag(item, event)} onClick={event => { if (event.currentTarget.dataset.dragged) { delete event.currentTarget.dataset.dragged; return; } open(item); }}>
            <span className="sch-blk-time">{item.time} </span><span className="sch-blk-name">{item.title}</span>
          </button>;
        })}
        {day === today && nowTop > 0 && <div className="sch-now-rule" style={{ top: nowTop }}/>}
      </div>;
    })}
  </div></div>;
}
function FutureTab({ items, today, week, setWeek, open }: { items: ScheduleItem[]; today: string; week: number; setWeek(week: number): void; open(item: ScheduleItem): void }) {
  const start = mondayOf(addDays(today, 1));
  const weeks = Array.from({ length: 8 }, (_, index) => ({ from: addDays(start, index * 7), to: addDays(start, index * 7 + 6) }));
  const future = items.filter(item => item.date > today && item.kind !== 'decision' && item.kind !== 'research');
  const current = weeks[week]!;
  const list = future.filter(item => item.date >= current.from && item.date <= current.to);
  const days = [...new Set(list.map(item => item.date))];
  return <section className="sch-column sch-wide">
    <Legend/>
    <div className="sch-weeks" role="group" aria-label="未来 8 周">{weeks.map((entry, index) => {
      const its = future.filter(item => !item.routine && item.date >= entry.from && item.date <= entry.to);
      return <button key={entry.from} type="button" className={`sch-weekbox${its.length >= 4 ? ' sch-hot' : ''}`} aria-pressed={index === week} onClick={() => setWeek(index)}>
        <span className="sch-weekbox-label">{entry.from.slice(5)} 周</span>
        <span className="sch-weekbox-bars">{its.map(item => <i key={item.key} className={`sch-kind-bg-${item.kind}`}/>)}</span>
        <span className="sch-weekbox-count">{its.length ? `${its.length} 项${its.length >= 4 ? ' · 密集' : ''}` : '—'}</span>
      </button>;
    })}</div>
    <p className="schedule-note">每天都跑的例行任务不计入密度，但仍出现在下面每天的列表里。</p>
    {days.length === 0 ? <p className="quiet">这一周没有安排。</p> : days.map(day => <div key={day}>
      <h3 className="sch-dayhead">{dayLabel(day)}</h3>
      {list.filter(item => item.date === day).map(item => <Row key={item.key} item={item} open={open}/>)}
    </div>)}
  </section>;
}
function PastTab({ items, today, open, problems, labels }: { items: ScheduleItem[]; today: string; open(item: ScheduleItem): void; problems: TimelineView['problems']; labels?: { id: string; label: string }[] }) {
  const past = items.filter(item => item.date <= today && (item.kind === 'decision' || item.kind === 'research' || item.status === 'done' || item.status === 'overdue')).reverse();
  const days = [...new Set(past.map(item => item.date))].slice(0, 60);
  return <section className="sch-column">
    <p className="schedule-note">按日期列出做过的研究、下过的决定和已经跑过的任务。研究和决定来自工作区的时间轴文件；中书只按文件里的类型和链接显示。</p>
    {problems.length > 0 && <p className="schedule-note sch-warn-note">时间轴文件里有 {problems.length} 行没有读懂（{[...new Set(problems.map(problem => labels?.find(entry => entry.id === problem.workspaceId)?.label ?? problem.workspaceId))].join('、')}），已跳过。可以让 Agent 检查 `.zhongshu/timeline.jsonl`。</p>}
    {days.length === 0 && <p className="quiet">还没有记录。</p>}
    {days.map(day => <div key={day}><h3 className="sch-dayhead">{dayLabel(day)}</h3>{past.filter(item => item.date === day).map(item => <Row key={item.key} item={item} open={open}/>)}</div>)}
  </section>;
}
const taskFilters = [['active', '已开启'], ['paused', '已暂停'], ['ended', '已结束'], ['all', '全部']] as const;
/** All tasks as one list, like the native app: filtered by state, searchable, each row opening its card. */
function TasksTab({ automations, open, now }: { automations: AutomationView[]; open(id: string): void; now: number }) {
  const [filter, setFilter] = useState<(typeof taskFilters)[number][0]>('active');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = automations.filter(task => (filter === 'all' || task.status === filter) && (!needle || `${task.title}\n${task.prompt}`.toLowerCase().includes(needle)))
    .sort((a, b) => a.status === 'ended' && b.status === 'ended' ? (b.lastDelivery?.deliveredAt ?? '').localeCompare(a.lastDelivery?.deliveredAt ?? '') : a.scheduledAt.localeCompare(b.scheduledAt));
  if (!automations.length) return <p className="quiet sch-column">还没有自动任务。可以在对话里让 Agent 按计划建，或点「新建自动任务」。</p>;
  return <section className="sch-column sch-wide">
    <div className="sch-task-tools">
      <div className="sch-seg" role="group" aria-label="按状态筛选">{taskFilters.map(([id, label]) =>
        <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
      <input className="sch-search" type="search" placeholder="搜索自动任务" aria-label="搜索自动任务" value={query} onChange={event => setQuery(event.target.value)}/>
    </div>
    {shown.length === 0 ? <p className="quiet">没有符合条件的任务。</p> : <div className="sch-task-list">{shown.map(task =>
      <button key={task.id} type="button" className={`sch-task${task.status === 'ended' ? ' sch-past' : ''}`} onClick={() => open(task.id)}>
        <Clock size={15} aria-hidden="true"/>
        <span>
          <span className="sch-title">{task.title}</span>
          <small>{timingText(task)}{task.status === 'active' ? ` · 下次计划时间：${whenText(Date.parse(task.scheduledAt), now)}`
            : task.lastDelivery ? ` · 最近一次：${whenText(Date.parse(task.lastDelivery.deliveredAt), now)}` : ''}{task.target.workspaceLabel ? ` · ${task.target.workspaceLabel}` : ''}</small>
          {task.lastDelivery?.result && <small className="sch-result">{task.lastDelivery.result}</small>}
        </span>
        <span className="sch-chips">
          {task.executing && <span className="sch-chip sch-chip-next">运行中</span>}
          {task.lastDelivery?.late && <span className="sch-chip sch-chip-late">迟到</span>}
          {task.status === 'paused' && <span className="sch-chip"><Pause size={10}/>已暂停</span>}
        </span>
      </button>)}</div>}
  </section>;
}

function SchedulePanel({ panel, automations, configuration, csrf, report, close, notice, notify, reload, edit, openConversation, openFile, notifications, now }: {
  panel: Panel; automations: AutomationView[]; configuration?: WorkbenchConfiguration; csrf: string; report(reason: unknown): void; close(): void;
  notice?: string; notify(message: string): void;
  reload(): Promise<void>; edit(task: AutomationView, body: { patch: Record<string, unknown> }): Promise<boolean>; openConversation(id: string): void;
  openFile(workspaceId: string, path: string): void; notifications: AgentNotificationView[]; now: number;
}) {
  const ref = useRef<HTMLElement>(null);
  // Focus moves into the panel itself: not the close button, and no field that would pop up a phone keyboard.
  useEffect(() => { ref.current?.focus({ preventScroll: true }); const key = (event: KeyboardEvent) => {
    // Escape first closes an open picker inside the panel (rendered in a portal); only then the panel.
    if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[data-radix-popper-content-wrapper]')) close();
  }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [close]);
  return <>
    <div className="sch-scrim" onClick={close}/>
    <aside className="sch-panel" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={panel.kind === 'create' ? '新建自动任务' : '详情'}>
      {panel.kind === 'task' ? <TaskDetail task={automations.find(task => task.id === panel.id)} configuration={configuration} csrf={csrf} report={report} close={close} notice={notice} notify={notify} reload={reload} edit={edit} openConversation={openConversation} notifications={notifications} now={now}/>
        : panel.kind === 'create' ? <><PanelHead title="新建自动任务" close={close}/><CreateForm configuration={configuration} csrf={csrf} report={report} close={close} reload={reload} conversationId={panel.conversationId}/></>
        : <EntryDetail item={panel.item} close={close} openFile={openFile}/>}
    </aside>
  </>;
}
const refusals: Record<string, string> & { conflict: string; not_found: string } = {
  conflict: '这个任务刚在别处改过，已重新读取。请看一眼再操作。',
  ended: '任务已经跑完，不能再修改。',
  pending: '这个任务正在运行，等它结束再试。',
  not_found: '这个任务已经不存在。',
};
function PanelHead({ title, close }: { title: string; close(): void }) {
  return <header className="sch-panel-head"><Clock size={15}/><h2>{title}</h2><IconButton label="关闭" onClick={close}><X size={16}/></IconButton></header>;
}
/**
 * The task card (ADR 0021, 2026-11-09): what it is, whether it ran and when it runs next, the conclusion written back,
 * and one step to its conversation. Name, instruction and timing are edited in place, like the native app.
 */
function TaskDetail({ task, configuration, csrf, report, close, notice, notify, reload, edit, openConversation, notifications, now }: {
  task?: AutomationView; configuration?: WorkbenchConfiguration; csrf: string; report(reason: unknown): void; close(): void; notice?: string; notify(message: string): void; reload(): Promise<void>;
  edit(task: AutomationView, body: { patch: Record<string, unknown> }): Promise<boolean>; openConversation(id: string): void; notifications: AgentNotificationView[]; now: number;
}) {
  const [history, setHistory] = useState<AutomationDeliveryView[]>();
  const [title, setTitle] = useState(task?.title ?? ''); const [prompt, setPrompt] = useState(task?.prompt ?? '');
  const [timing, setTiming] = useState(() => initialTiming(task)); const [changeTiming, setChangeTiming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const discard = useCallback(() => { setTitle(task?.title ?? ''); setPrompt(task?.prompt ?? ''); setTiming(initialTiming(task)); setChangeTiming(false); }, [task]);
  // A change made elsewhere shows up as long as nothing here is being edited.
  const dirty = !!task && (title !== task.title || prompt !== task.prompt || changeTiming);
  useEffect(() => { if (!dirty) discard(); }, [task?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!task) return; let alive = true;
    request(`/automations/${encodeURIComponent(task.id)}/history`, automationHistorySchema).then(page => { if (alive) setHistory(page.records); }).catch(error => { if (alive) { setHistory([]); report(error); } });
    return () => { alive = false; };
  }, [task?.id, task?.updatedAt, task?.lastDelivery?.deliveredAt, report]);
  if (!task) return <><PanelHead title="任务" close={close}/><div className="sch-panel-body"><p className="quiet">这个任务已不存在。</p></div></>;
  const act = async (action: () => Promise<void>) => { setBusy(true); try { await action(); } catch (error) { report(error); } finally { setBusy(false); } };
  const run = () => act(async () => {
    const result = await request(`/automations/${encodeURIComponent(task.id)}/run`, automationResultSchema, { csrf, body: {} });
    if (result.outcome !== 'ok') notify(refusals[result.outcome] ?? refusals.not_found);
    await reload();
  });
  const remove = () => act(async () => {
    const result = await request(`/automations/${encodeURIComponent(task.id)}/delete`, automationResultSchema, { csrf, body: task.updatedAt ? { expectedUpdatedAt: task.updatedAt } : {} });
    await reload();
    if (result.outcome === 'conflict') { notify(refusals.conflict); setConfirmDelete(false); } else close();
  });
  const save = () => act(async () => {
    const patch = { ...(title !== task.title ? { title } : {}), ...(prompt !== task.prompt ? { prompt } : {}), ...(changeTiming ? { timing: timingFrom(timing) } : {}) };
    if (await edit(task, { patch })) setChangeTiming(false);
  });
  const target = task.target.kind === 'conversation' ? `回到对话：${task.target.conversationTitle ?? ''}` : task.target.kind === 'new' ? `每次新开一段对话${task.target.workspaceLabel ? `（${task.target.workspaceLabel}）` : ''}`
    : task.target.kind === 'new_once' ? `首次新开，之后都回到那段${task.target.workspaceLabel ? `（${task.target.workspaceLabel}）` : ''}` : '中书之外的原生会话';
  const noticeFor = (record: AutomationDeliveryView, until?: string) => record.conversationId ? notifications.filter(entry => entry.conversationId === record.conversationId
    && entry.createdAt >= Date.parse(record.deliveredAt) - 60_000 && (!until || entry.createdAt < Date.parse(until))).at(-1)?.summary : undefined;
  const status = task.executing ? '运行中' : task.status === 'paused' ? '已暂停' : task.status === 'ended' ? '已跑完' : task.lastDelivery ? '已运行' : '待运行';
  const conversation = task.latestRun?.conversationId ?? task.lastDelivery?.conversationId ?? task.target.conversationId;
  const latest = task.lastDelivery;
  const editable = task.status !== 'ended';
  // The page edits the rules it can show in its own fields; month and cron rules are changed with sichen or by the agent.
  const rule = ruleOf(task);
  const editableTiming = task.timing.kind === 'every' || (!!rule && ['once', 'daily', 'weekly'].includes(rule.rule.kind));
  const empty = !title.trim() || !prompt.trim();
  return <>
    <PanelHead title={task.title} close={close}/>
    <div className="sch-panel-body sch-card">
      {notice && <p className="sch-notice" role="status">{notice}</p>}
      <p className="sch-card-when">
        <span className={`sch-chip${task.executing ? ' sch-chip-next' : ''}`}>{status}</span>
        {task.status === 'active' && <span>下次运行 {whenText(Date.parse(task.scheduledAt), now)}</span>}
      </p>
      <section className="sch-latest">
        {latest ? <>
          <small>最近一次 · {whenText(Date.parse(latest.deliveredAt), now)}{latest.late ? ' · 迟到' : ''}</small>
          <p>{latest.result ?? '这次没有写回结论，打开对话看过程。'}</p>
          {noticeFor(latest) && <small><Bell size={10}/> 已通知你：“{noticeFor(latest)}”</small>}
        </> : <p className="quiet">还没跑过。{task.target.kind === 'new' || (task.target.kind === 'new_once' && !conversation) ? '到点后会新开一段对话。' : ''}</p>}
        {conversation && <Button size="small" variant="primary" onClick={() => openConversation(conversation)}>打开对话<ChevronRight size={14}/></Button>}
      </section>
      <div className="sch-form">
        <Field label="名称">{editable ? <input aria-invalid={!title.trim() || undefined} value={title} maxLength={120} onChange={event => setTitle(event.target.value)}/> : <p className="sch-static">{task.title}</p>}</Field>
        <Field label="任务内容">{editable ? <textarea aria-invalid={!prompt.trim() || undefined} value={prompt} maxLength={32000} onChange={event => setPrompt(event.target.value)}/> : <div className="sch-prompt">{task.prompt}</div>}</Field>
        {editable && editableTiming && changeTiming ? <TimingFields draft={timing} change={setTiming}/>
          : <Field label="运行时间"><div className="sch-static-row"><span>{timingText(task)}</span>{editable && editableTiming && <Button size="small" onClick={() => setChangeTiming(true)}>改时间</Button>}</div></Field>}
        {editable && !editableTiming && <p className="sch-help">这条任务按月或按 cron 运行，时间请用 sichen schedule edit 改，或在对话里让 Agent 改。</p>}
      </div>
      <dl className="sch-kv">
        <dt>执行位置</dt><dd>{target}</dd>
        <dt>运行配置</dt><dd>{runConfigurationText(task, configuration)}</dd>
      </dl>
      <h3 className="sch-sub">运行记录</h3>
      {!history ? <p className="quiet">正在读取…</p> : history.length === 0 ? <p className="quiet">还没跑过。</p> : <div className="sch-history">{history.map((record, index) => {
        const later = history.map(entry => entry.deliveredAt).filter(at => at > record.deliveredAt).sort()[0];
        const said = noticeFor(record, later);
        return <button key={record.deliveredAt + index} type="button" disabled={!record.conversationId} onClick={() => record.conversationId && openConversation(record.conversationId)}>
          <span>{dayLabel(localDate(new Date(record.deliveredAt)))} {localTime(new Date(record.deliveredAt))}</span>
          {record.late && <span className="sch-chip sch-chip-late">迟到 {Math.round((Date.parse(record.deliveredAt) - Date.parse(record.scheduledAt)) / 60_000)} 分钟</span>}
          {record.conversationId && <ChevronRight size={13} aria-hidden="true"/>}
          {record.result && <small>{record.result}</small>}
          {said && <small><Bell size={10}/> “{said}”</small>}
        </button>; })}</div>}
    </div>
    <footer className="sch-panel-actions">
      {dirty ? <>
        {empty && <span className="sch-missing" role="status">名称和内容不能为空</span>}
        <span className="sch-spacer"/>
        <Button variant="quiet" disabled={busy} onClick={discard}>放弃</Button>
        <Button variant="primary" disabled={busy || empty} onClick={() => void save()}>{busy ? '正在保存…' : '保存修改'}</Button>
      </> : <>
        {task.status !== 'ended' && <Button size="small" disabled={busy} onClick={() => act(async () => { await edit(task, { patch: { active: task.status === 'paused' } }); })}>{task.status === 'paused' ? <><Play size={13}/>恢复</> : <><Pause size={13}/>暂停</>}</Button>}
        <Button size="small" disabled={busy || task.executing} onClick={() => void run()}><Play size={13}/>立即运行</Button>
        {confirmDelete ? <Button size="small" variant="danger" disabled={busy} onClick={() => void remove()}>确认删除</Button>
          : <Button size="small" variant="quiet" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={13}/>删除</Button>}
      </>}
    </footer>
  </>;
}
function EntryDetail({ item, close, openFile }: { item: ScheduleItem; close(): void; openFile(workspaceId: string, path: string): void }) {
  return <>
    <PanelHead title={item.title} close={close}/>
    <div className="sch-panel-body">
      <dl className="sch-kv"><dt>类型</dt><dd>{kindLabel[item.kind]}</dd><dt>时间</dt><dd>{dayLabel(item.date)}{item.time ? ` ${item.time}` : ' · 全天'}</dd>
        {item.entry && <><dt>工作区</dt><dd>{item.entry.workspaceLabel}</dd></>}{item.detail && <><dt>说明</dt><dd>{item.detail}</dd></>}
        {item.entry?.link && <><dt>链接</dt><dd><button type="button" className="text-button sch-mono" onClick={() => openFile(item.entry!.workspaceId, item.entry!.link!)}>{item.entry.link}</button></dd></>}
        {item.entry?.status && <><dt>状态</dt><dd>{item.entry.status === 'done' ? '已完成' : '已取消'}</dd></>}</dl>
      <p className="schedule-note">这一条来自工作区的时间轴文件 <code>.zhongshu/timeline.jsonl</code>：Agent 建操作提醒、整理事件或写完研究和决定时记下一条。中书只读；要改它，在对话里告诉 Agent。</p>
    </div>
  </>;
}
export const scheduleTabSchema = z.enum(['calendar', 'today', 'future', 'past', 'tasks']);

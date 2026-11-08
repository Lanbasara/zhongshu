/**
 * Automations seen from one conversation (ADR 0021): the tasks that deliver into it, and for a conversation an
 * automation created, its other runs. Both read the same private list the schedule page uses.
 */
import { useCallback, useEffect, useState } from 'react';
import { Bell, ChevronDown, Clock } from 'lucide-react';
import { z } from 'zod';
import { agentNotificationListSchema, automationListSchema, type AgentNotificationView, type AutomationView } from '../shared/automations.ts';
import type { Conversation } from '../shared/workbench.ts';
import { request } from './workbench-client.ts';
import { localTime, timingText } from './schedule-model.ts';
import './conversation-automations.css';

export function useAutomations(revision: number, active: boolean) {
  const [automations, setAutomations] = useState<AutomationView[]>([]);
  const [notifications, setNotifications] = useState<AgentNotificationView[]>([]);
  const reload = useCallback(async () => {
    try {
      const [list, notes] = await Promise.all([request('/automations', automationListSchema), request('/notifications', agentNotificationListSchema)]);
      setAutomations(list.automations); setNotifications(notes.notifications);
    } catch { /* the strip is an aid; the conversation itself still works */ }
  }, []);
  useEffect(() => { if (active) void reload(); }, [reload, revision, active]);
  return { automations, notifications, reload };
}

const when = (value: string) => { const date = new Date(value); return `${date.getMonth() + 1}-${date.getDate()} ${localTime(date)}`; };

export function AutomationStrip({ conversation, automations, notifications, openTasks }: {
  conversation: Conversation; automations: AutomationView[]; notifications: AgentNotificationView[]; openTasks(): void;
}) {
  const [open, setOpen] = useState(false);
  const tasks = automations.filter(task => task.target.conversationId === conversation.id || task.lastDelivery?.conversationId === conversation.id)
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  if (!tasks.length) return null;
  const now = Date.now();
  const pending = tasks.filter(task => task.status === 'active' && Date.parse(task.scheduledAt) > now);
  const next = pending[0];
  const done = tasks.filter(task => task.status === 'ended' || task.lastDelivery).length;
  const noticeFor = (task: AutomationView) => task.lastDelivery && notifications.filter(entry => entry.conversationId === conversation.id && entry.createdAt >= Date.parse(task.lastDelivery!.deliveredAt) - 60_000).at(-1)?.summary;
  return <section className="automation-strip" data-open={open}>
    <button type="button" className="automation-strip-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Clock size={14} aria-hidden="true"/>
      <span>这段对话的自动任务 {tasks.length} · 已跑 {done}</span>
      <span className="automation-progress" aria-hidden="true">{tasks.slice(0, 16).map(task => <i key={task.id} data-state={task.executing ? 'running' : task.lastDelivery || task.status === 'ended' ? 'done' : task.status === 'paused' ? 'paused' : 'todo'}/>)}</span>
      {next && <span className="automation-next">下一个 {when(next.scheduledAt)} {next.title}</span>}
      <ChevronDown size={14} className="automation-chevron" aria-hidden="true"/>
    </button>
    {open && <div className="automation-list">
      {tasks.map(task => {
        const note = noticeFor(task);
        return <div key={task.id} className="automation-row" data-state={task.executing ? 'running' : task.lastDelivery ? 'done' : task.status}>
          <span className="automation-time">{task.lastDelivery ? when(task.lastDelivery.deliveredAt) : when(task.scheduledAt)}</span>
          <i aria-hidden="true"/>
          <span className="automation-main"><span>{task.title}</span><small>{timingText(task)}{task.status === 'paused' ? ' · 已暂停' : ''}{task.lastDelivery?.late ? ' · 迟到' : ''}</small>
            {note && <small className="automation-note"><Bell size={10}/> 已通知你：“{note}”</small>}</span>
        </div>;
      })}
      <button type="button" className="text-button" onClick={openTasks}>在日程里管理</button>
    </div>}
  </section>;
}

const runsSchema = z.object({ conversations: z.array(z.object({ id: z.uuid(), title: z.string(), createdAt: z.number() })).max(200) });
/** A conversation an automation created: which task it belongs to, and its other runs. */
export function AutomationRunBar({ conversation, automations, revision, choose, openTasks }: {
  conversation: Conversation; automations: AutomationView[]; revision: number; choose(id: string): void; openTasks(): void;
}) {
  const [runs, setRuns] = useState<z.infer<typeof runsSchema>['conversations']>([]);
  const automationId = conversation.automationId;
  useEffect(() => {
    if (!automationId) return; let alive = true;
    request(`/automations/${encodeURIComponent(automationId)}/runs`, runsSchema).then(value => { if (alive) setRuns(value.conversations); }).catch(() => {});
    return () => { alive = false; };
  }, [automationId, revision]);
  if (!automationId) return null;
  const task = automations.find(entry => entry.id === automationId);
  return <nav className="automation-runbar" aria-label="这个自动任务的历次运行">
    <Clock size={13} aria-hidden="true"/>
    <span className="automation-runbar-label">{task ? `${task.title} · ${timingText(task)}` : '来自自动任务'}</span>
    {runs.slice(0, 30).map(run => <button key={run.id} type="button" className="automation-run" aria-current={run.id === conversation.id} onClick={() => choose(run.id)}>
      {new Date(run.createdAt).getMonth() + 1}-{new Date(run.createdAt).getDate()} {localTime(new Date(run.createdAt))}</button>)}
    <button type="button" className="text-button" onClick={openTasks}>任务详情</button>
  </nav>;
}

/**
 * Automations (ADR 0021). The native Harness schedules, stores and delivers them; this module lists and manages
 * them for the page, notices deliveries so the resulting runs are observed like sent messages, adopts sessions a
 * task created, and reads each workspace's timeline file. It keeps no copy of a task, only the last delivery acted on.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HarnessError, type AutomationDelivery, type HarnessAdapter, type HarnessAutomations, type HarnessId, type NativeAutomation } from '../harness/types.ts';
import {
  automationCreateSchema, automationDeleteSchema, automationEditSchema, timelineLineSchema,
  type AutomationDeliveryView, type AutomationView, type TimelineEntry, type TimelineView,
} from '../shared/automations.ts';
import type { Workbench } from './workbench.ts';
import type { AgentNotifications } from './agent-notifications.ts';
import { readWorkspaceTimeline } from './workspace-documents.ts';

const LATE_MS = 5 * 60_000;
const POLL_MS = 60_000;
const FRESH_MS = 3_000;
class AutomationError extends Error {
  readonly statusCode: number;
  constructor(code: string, statusCode = 400) { super(code); this.statusCode = statusCode; }
}
const late = (delivery: { scheduledAt: string; deliveredAt: string }) => Date.parse(delivery.deliveredAt) - Date.parse(delivery.scheduledAt) > LATE_MS;

export function createAutomations(db: DatabaseSync, workbench: Workbench, adapters: Map<HarnessId, HarnessAdapter>, notifications: AgentNotifications, log: (event: Record<string, unknown>) => void) {
  const sources = new Map<'dsh', HarnessAutomations>();
  const dsh = adapters.get('dsh')?.automations;
  if (dsh) sources.set('dsh', dsh);
  const cache = new Map<'dsh', { at: number; tasks: NativeAutomation[] }>();
  const executing = new Set<string>();
  const unsubscribe: (() => void)[] = [];
  let refreshing: Promise<void> | undefined; let again = false;
  let debounce: NodeJS.Timeout | undefined; let poll: NodeJS.Timeout | undefined; let closed = false;

  const handled = (id: string) => db.prepare('SELECT message_id FROM automation_deliveries WHERE automation_id=?').get(id) as { message_id: string } | undefined;
  const remember = (id: string, delivery: AutomationDelivery) => db.prepare(`INSERT INTO automation_deliveries(automation_id,message_id,session_id,scheduled_at,delivered_at,handled_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(automation_id) DO UPDATE SET message_id=excluded.message_id,session_id=excluded.session_id,scheduled_at=excluded.scheduled_at,
    delivered_at=excluded.delivered_at,handled_at=excluded.handled_at`).run(id, delivery.messageId, delivery.sessionId, delivery.scheduledAt, delivery.deliveredAt, Date.now());

  const reserved = (id: string) => (db.prepare('SELECT session_id FROM automation_reservations WHERE automation_id=?').get(id) as { session_id: string } | undefined)?.session_id;
  const reserve = (id: string, sessionId: string) => db.prepare(`INSERT INTO automation_reservations(automation_id,session_id,seen_at) VALUES(?,?,?)
    ON CONFLICT(automation_id) DO UPDATE SET session_id=excluded.session_id,seen_at=excluded.seen_at WHERE session_id<>excluded.session_id`).run(id, sessionId, Date.now());
  /** Reservations of tasks the Harness no longer lists (deleted) are dropped; the list is complete when it succeeds. */
  const forget = (present: Set<string>) => {
    const rows = db.prepare('SELECT automation_id FROM automation_reservations').all() as { automation_id: string }[];
    for (const row of rows) if (!present.has(row.automation_id)) db.prepare('DELETE FROM automation_reservations WHERE automation_id=?').run(row.automation_id);
  };
  /** The session a task created for itself: every run of a "new" task, or the one a "new once" task reserved. */
  const createdFor = (task: NativeAutomation, sessionId: string) => task.target.kind === 'new' || task.target.kind === 'new_once' || reserved(task.id) === sessionId;

  /** A session a task created becomes a conversation only inside a registered workspace, with the configuration it runs with. */
  async function adopt(source: HarnessAutomations, task: NativeAutomation, sessionId: string): Promise<string | undefined> {
    const known = workbench.store.conversationForNative('dsh', sessionId);
    if (known) return known.id;
    if (!createdFor(task, sessionId)) return undefined; // a session Zhongshu never knew stays the Harness's own
    const native = await source.inspect(sessionId);
    if (!native) return undefined;
    const workspace = workbench.workspaces.find(entry => entry.directory === native.cwd);
    if (!workspace) return undefined;
    const conversation = workbench.store.adoptConversation({ id: randomUUID(), harnessId: 'dsh', workspaceId: workspace.id, cwd: native.cwd, title: task.title.slice(0, 200) || '自动任务',
      configuration: native.configuration, binding: { id: sessionId, cwd: native.cwd, configuration: native.configuration, details: {} }, automationId: task.id });
    log({ event: 'automation_session_adopted' });
    return conversation.id;
  }
  async function deliveries(source: HarnessAutomations, tasks: NativeAutomation[]): Promise<void> {
    for (const task of tasks) {
      if (closed) return;
      try {
        if (task.target.kind === 'new_once' && task.target.sessionId) reserve(task.id, task.target.sessionId);
        const delivery = task.lastDelivery;
        const target = delivery?.sessionId ?? (task.target.kind === 'session' ? task.target.sessionId : undefined);
        const fresh = delivery && handled(task.id)?.message_id !== delivery.messageId;
        const started = task.executing && !executing.has(task.id);
        if (task.executing) executing.add(task.id); else executing.delete(task.id);
        if (!fresh && !started) continue;
        const conversationId = target ? (delivery && target === delivery.sessionId ? await adopt(source, task, target) : workbench.store.conversationForNative('dsh', target)?.id) : undefined;
        if (conversationId) await workbench.noticeActivity(conversationId).catch(() => {});
        if (fresh && delivery) remember(task.id, delivery);
      } catch { log({ event: 'automation_delivery_unhandled' }); }
    }
  }
  async function refresh(): Promise<void> {
    if (refreshing) { again = true; return refreshing; }
    refreshing = (async () => {
      do {
        again = false;
        for (const [harness, source] of sources) {
          try {
            const tasks = await source.list();
            cache.set(harness, { at: Date.now(), tasks });
            await deliveries(source, tasks);
            forget(new Set(tasks.map(task => task.id)));
          } catch (error) { if (!(error instanceof HarnessError)) log({ event: 'automation_refresh_failed' }); }
        }
      } while (again && !closed);
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }
  function changed(): void {
    if (closed || debounce) return;
    debounce = setTimeout(() => { debounce = undefined; void refresh(); }, 300); debounce.unref();
  }

  function workspaceOf(cwd: string | undefined) { return cwd ? workbench.workspaceView().workspaces.find(entry => workbench.workspaces.find(w => w.id === entry.id)?.directory === cwd) : undefined; }
  function deliveryView(delivery: AutomationDelivery): AutomationDeliveryView {
    const conversation = workbench.store.conversationForNative('dsh', delivery.sessionId);
    return { scheduledAt: delivery.scheduledAt, deliveredAt: delivery.deliveredAt, late: late(delivery), ...(conversation ? { conversationId: conversation.id } : {}), ...(delivery.prompt ? { prompt: delivery.prompt } : {}) };
  }
  function view(task: NativeAutomation): AutomationView {
    let target: AutomationView['target'];
    if (task.target.kind === 'session') {
      const conversation = workbench.store.conversationForNative('dsh', task.target.sessionId);
      const workspace = conversation && workbench.workspaceView().workspaces.find(entry => entry.id === conversation.workspaceId);
      // A "new once" task after its first run: still shown as such, with the conversation it created and reuses.
      target = conversation?.automationId === task.id ? { kind: 'new_once', conversationId: conversation.id, workspaceId: conversation.workspaceId, ...(workspace ? { workspaceLabel: workspace.label } : {}) }
        : conversation ? { kind: 'conversation', conversationId: conversation.id, conversationTitle: conversation.title } : { kind: 'unknown' };
    } else {
      const workspace = workspaceOf(task.target.cwd);
      target = { kind: task.target.kind, ...(workspace ? { workspaceId: workspace.id, workspaceLabel: workspace.label } : {}) };
    }
    const runs = workbench.store.listConversations({ automationId: task.id, limit: 1000 });
    const latest = runs[0];
    return { id: task.id, harnessId: 'dsh', title: task.title, prompt: task.prompt, timing: task.timing, scheduledAt: task.scheduledAt, status: task.status, target,
      executing: task.executing, ...(task.createdAt ? { createdAt: task.createdAt } : {}), ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
      ...(task.lastDelivery ? { lastDelivery: deliveryView(task.lastDelivery) } : {}), runs: runs.length,
      ...(latest ? { latestRun: { conversationId: latest.id, status: latest.state.status, unread: workbench.unread([latest]).has(latest.id) } } : {}) };
  }
  function source(harness: string): HarnessAutomations {
    const value = harness === 'dsh' ? sources.get('dsh') : undefined;
    if (!value) throw new AutomationError('automations_unavailable', 409);
    return value;
  }
  async function current(): Promise<NativeAutomation[]> {
    const entry = cache.get('dsh');
    if (!entry || Date.now() - entry.at > FRESH_MS) await refresh();
    return cache.get('dsh')?.tasks ?? [];
  }
  async function find(id: string): Promise<NativeAutomation> {
    const task = (await current()).find(entry => entry.id === id) ?? await source('dsh').view(id);
    if (!task) throw new AutomationError('automation_not_found', 404);
    return task;
  }
  function targetInput(input: z.infer<typeof automationCreateSchema>['target']) {
    if (input.kind === 'conversation') {
      const conversation = workbench.store.getConversation(input.conversationId);
      if (!conversation?.binding || conversation.harnessId !== 'dsh') throw new AutomationError('automation_target_unavailable', 409);
      return { kind: 'session' as const, sessionId: conversation.binding.id };
    }
    // New sessions start in the workspace the user chose, never the Host's default directory.
    const workspace = workbench.workspaces.find(entry => entry.id === input.workspaceId);
    if (!workspace) throw new AutomationError('workspace_not_found', 404);
    return { kind: input.kind, cwd: workspace.directory, ...(input.preset ? { preset: input.preset } : {}) };
  }

  /** The timeline of every active workspace; invalid lines are skipped and reported, never guessed. */
  async function timeline(): Promise<TimelineView> {
    const entries: TimelineEntry[] = []; const problems: TimelineView['problems'] = [];
    const labels = new Map(workbench.workspaceView().workspaces.map(entry => [entry.id, entry.label]));
    for (const workspace of workbench.workspaces) {
      let text: string | null;
      try { text = await readWorkspaceTimeline(workspace.directory); }
      catch { problems.push({ workspaceId: workspace.id, line: 1, reason: 'file_unreadable' }); continue; }
      if (!text) continue;
      const parsed = parseTimeline(text, { id: workspace.id, label: labels.get(workspace.id) ?? workspace.id });
      entries.push(...parsed.entries); problems.push(...parsed.problems.slice(0, Math.max(0, 200 - problems.length)));
    }
    return { entries: entries.sort(byWhen), problems };
  }

  async function routes(app: FastifyInstance): Promise<void> {
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AutomationError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof HarnessError) return reply.code(502).send({ error: 'harness_unavailable' });
      const code = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
      const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
      if (status === 500) app.log.error({ event: 'automation_request_failed' });
      return reply.code(status).send({ error: status === 500 ? 'service_unavailable' : 'invalid_request' });
    });
    const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const parsed = schema.safeParse(value); if (!parsed.success) throw new AutomationError('invalid_request'); return parsed.data; };
    const params = z.object({ id: z.string().min(1).max(240) }).strict();
    app.get('/automations', async () => {
      if (!sources.size) return { available: false, automations: [] };
      await current();
      return { available: true, automations: (cache.get('dsh')?.tasks ?? []).map(view) };
    });
    app.get('/automations/:id/history', async request => {
      const { id } = parse(params, request.params);
      const query = parse(z.object({ before: z.string().min(1).max(240).optional() }).strict(), request.query);
      const page = await source('dsh').history(id, 50, query.before);
      if (!page) throw new AutomationError('automation_not_found', 404);
      return { records: page.records.map(deliveryView), earlierUnavailable: page.earlierUnavailable, ...(page.before ? { before: page.before } : {}) };
    });
    app.get('/automations/:id/runs', async request => {
      const { id } = parse(params, request.params);
      return { conversations: workbench.store.listConversations({ automationId: id, limit: 200 }).map(entry => ({ id: entry.id, title: entry.title, createdAt: entry.createdAt })) };
    });
    app.post('/automations', { bodyLimit: 64 * 1024 }, async request => {
      const input = parse(automationCreateSchema, request.body);
      const task = await source(input.harnessId).create({ title: input.title, prompt: input.prompt, timing: input.timing, target: targetInput(input.target) });
      log({ event: 'automation_created' }); await refresh();
      return { outcome: 'ok', automation: view(task) };
    });
    app.post('/automations/:id/edit', { bodyLimit: 64 * 1024 }, async request => {
      const { id } = parse(params, request.params);
      const input = parse(automationEditSchema, request.body);
      await find(id);
      const result = await source('dsh').update(id, input.patch, input.expectedUpdatedAt);
      await refresh();
      if (result === 'conflict') return { outcome: 'conflict' };
      if (result === 'notFound') return { outcome: 'not_found' };
      if (result === 'ended') return { outcome: 'ended' };
      log({ event: 'automation_changed' });
      return { outcome: 'ok', automation: view(result) };
    });
    app.post('/automations/:id/delete', async request => {
      const { id } = parse(params, request.params);
      const input = parse(automationDeleteSchema, request.body ?? {});
      const result = await source('dsh').remove(id, input.expectedUpdatedAt);
      await refresh();
      if (result === 'conflict') return { outcome: 'conflict' };
      if (result === 'notFound') return { outcome: 'not_found' };
      log({ event: 'automation_deleted' });
      return { outcome: 'deleted' };
    });
    app.post('/automations/:id/run', async request => {
      const { id } = parse(params, request.params);
      const result = await source('dsh').run(id);
      await refresh();
      if (result === 'pending') return { outcome: 'pending' };
      if (result === 'notFound') return { outcome: 'not_found' };
      log({ event: 'automation_run_requested' });
      return { outcome: 'ok', automation: view(result) };
    });
    app.get('/notifications', async () => ({ notifications: notifications.list(100) }));
    app.get('/notifications/:id', async request => {
      const { id } = parse(z.object({ id: z.uuid() }).strict(), request.params);
      const value = notifications.get(id);
      if (!value) throw new AutomationError('notification_not_found', 404);
      return value;
    });
    app.get('/timeline', async () => timeline());
  }

  return {
    routes,
    available: () => sources.size > 0,
    async start(): Promise<void> {
      for (const value of sources.values()) unsubscribe.push(value.onChange(changed));
      unsubscribe.push(workbench.onObserved((id, items) => notifications.observed(id, items)));
      notifications.start();
      // Missed events are recovered by a slow re-list; deliveries still reach observation within a minute.
      poll = setInterval(() => { void refresh(); }, POLL_MS); poll.unref();
      void refresh();
    },
    close(): void {
      closed = true;
      if (debounce) clearTimeout(debounce); if (poll) clearInterval(poll);
      for (const stop of unsubscribe.splice(0)) stop();
      notifications.close();
    },
  };
}
export type Automations = ReturnType<typeof createAutomations>;

const byWhen = (a: TimelineEntry, b: TimelineEntry) => (a.date + (a.time ?? '')).localeCompare(b.date + (b.time ?? ''));
/** One workspace's `.zhongshu/timeline.jsonl`. The last line with an id wins, so agents append corrections instead of rewriting. */
export function parseTimeline(text: string, workspace: { id: string; label: string }): Pick<TimelineView, 'entries' | 'problems'> {
  const entries = new Map<string, TimelineEntry>(); const problems: TimelineView['problems'] = [];
  const report = (line: number, reason: string) => { if (problems.length < 200) problems.push({ workspaceId: workspace.id, line, reason }); };
  const lines = text.split('\n');
  for (let index = 0; index < lines.length && index < 20_000; index++) {
    const line = lines[index]!.trim(); if (!line) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { report(index + 1, 'not_json'); continue; }
    const parsed = timelineLineSchema.safeParse(raw);
    if (!parsed.success) { report(index + 1, 'invalid_fields'); continue; }
    const value = parsed.data;
    if (Number.isNaN(Date.parse(value.date + 'T00:00:00Z'))) { report(index + 1, 'invalid_date'); continue; }
    if (value.link !== undefined && (!value.link || value.link.startsWith('/') || value.link.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(value.link) || value.link.split('/').some(part => part === '..'))) {
      report(index + 1, 'link_outside_workspace'); continue;
    }
    entries.set(value.id, { ...value, workspaceId: workspace.id, workspaceLabel: workspace.label });
  }
  return { entries: [...entries.values()].sort(byWhen), problems };
}

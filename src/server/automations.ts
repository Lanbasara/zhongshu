/**
 * Automations (ADR 0021). The native Harness schedules, stores and delivers them; this module lists and manages
 * them for the page, notices deliveries so the resulting runs are observed like sent messages, adopts sessions a
 * task created, and reads each workspace's timeline file. It keeps no copy of a task, only the last delivery acted on.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HarnessError, type AutomationDelivery, type AutomationEdit, type AutomationPatch, type AutomationTargetInput, type AutomationTimingInput, type HarnessAdapter, type HarnessAutomations, type HarnessId, type NativeAutomation } from '../harness/types.ts';
import { check, toNative, type When } from '../sichen/time.ts';
import {
  automationCreateSchema, automationDeleteSchema, automationEditSchema, timelineLineSchema,
  type AutomationDeliveryView, type AutomationView, type TimelineEntry, type TimelineView,
} from '../shared/automations.ts';
import type { Workbench } from './workbench.ts';
import type { AgentNotifications } from './agent-notifications.ts';
import { createAgentResults } from './agent-results.ts';
import { readWorkspaceTimeline } from './workspace-documents.ts';

const LATE_MS = 5 * 60_000;
const POLL_MS = 60_000;
/** A session the Harness just created may not have its configuration yet; adoption is retried this often, this long. */
const ADOPT_RETRY_MS = 3_000;
const ADOPT_WINDOW_MS = 10 * 60_000;
const FRESH_MS = 3_000;
export class AutomationError extends Error {
  readonly statusCode: number;
  /** For `invalid_time`: what is wrong with the rule, in plain words (ADR 0022). */
  readonly problems?: string[];
  constructor(code: string, statusCode = 400, problems?: string[]) { super(code); this.statusCode = statusCode; if (problems) this.problems = problems; }
}
/** Page and 司辰 timing to native timing: a people's rule is checked here, then handed over in a shape the Harness runs. */
export function nativeTiming(timing: AutomationTimingInput | { kind: 'when'; when: When }, now = Date.now()): AutomationTimingInput {
  if (timing.kind !== 'when') return timing;
  const problems = check(timing.when, now);
  if (problems.length) throw new AutomationError('invalid_time', 400, problems);
  return toNative(timing.when, now);
}
const late = (delivery: { scheduledAt: string; deliveredAt: string }) => Date.parse(delivery.deliveredAt) - Date.parse(delivery.scheduledAt) > LATE_MS;

export function createAutomations(db: DatabaseSync, workbench: Workbench, adapters: Map<HarnessId, HarnessAdapter>, notifications: AgentNotifications, log: (event: Record<string, unknown>) => void) {
  const sources = new Map<'dsh', HarnessAutomations>();
  /** Conclusions agents write back to the card of the run they finished (ADR 0021, 2026-11-09). */
  const results = createAgentResults(db);
  const dsh = adapters.get('dsh')?.automations;
  if (dsh) sources.set('dsh', dsh);
  const cache = new Map<'dsh', { at: number; tasks: NativeAutomation[] }>();
  const executing = new Set<string>();
  const unsubscribe: (() => void)[] = [];
  let refreshing: Promise<void> | undefined; let again = false;
  let debounce: NodeJS.Timeout | undefined; let poll: NodeJS.Timeout | undefined; let retry: NodeJS.Timeout | undefined; let closed = false;

  const handled = (id: string) => db.prepare('SELECT message_id FROM automation_deliveries WHERE automation_id=?').get(id) as { message_id: string } | undefined;
  const remember = (id: string, delivery: AutomationDelivery) => db.prepare(`INSERT INTO automation_deliveries(automation_id,message_id,session_id,scheduled_at,delivered_at,handled_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(automation_id) DO UPDATE SET message_id=excluded.message_id,session_id=excluded.session_id,scheduled_at=excluded.scheduled_at,
    delivered_at=excluded.delivered_at,handled_at=excluded.handled_at`).run(id, delivery.messageId, delivery.sessionId, delivery.scheduledAt, delivery.deliveredAt, Date.now());

  const reserved = (id: string) => (db.prepare('SELECT session_id FROM automation_reservations WHERE automation_id=?').get(id) as { session_id: string } | undefined)?.session_id;
  const reserve = (id: string, sessionId: string) => db.prepare(`INSERT INTO automation_reservations(automation_id,session_id,seen_at) VALUES(?,?,?)
    ON CONFLICT(automation_id) DO UPDATE SET session_id=excluded.session_id,seen_at=excluded.seen_at WHERE session_id<>excluded.session_id`).run(id, sessionId, Date.now());
  /**
   * A task the Harness no longer lists was deleted: drop its reservation, and turn the conversations it created into
   * ordinary ones so its results do not disappear with it. A successful list is complete.
   */
  const forget = (present: Set<string>) => {
    const rows = db.prepare('SELECT automation_id FROM automation_reservations').all() as { automation_id: string }[];
    for (const row of rows) if (!present.has(row.automation_id)) db.prepare('DELETE FROM automation_reservations WHERE automation_id=?').run(row.automation_id);
    for (const owner of workbench.store.automationOwners()) if (!present.has(owner)) { workbench.store.releaseAutomation(owner); log({ event: 'automation_conversations_released' }); }
  };
  /** The session a task created for itself: every run of a "new" task, or the one a "new once" task reserved. */
  const createdFor = (task: NativeAutomation, sessionId: string) => task.target.kind === 'new' || task.target.kind === 'new_once' || reserved(task.id) === sessionId;

  /**
   * A session a task created becomes a conversation only inside a registered workspace, with the configuration it runs
   * with. `later` means the Harness has not recorded that configuration yet (a session it just created), so try again.
   */
  async function adopt(source: HarnessAutomations, task: NativeAutomation, sessionId: string): Promise<string | 'later' | undefined> {
    const known = workbench.store.conversationForNative('dsh', sessionId);
    if (known) return known.id;
    if (!createdFor(task, sessionId)) return undefined; // a session Zhongshu never knew stays the Harness's own
    const native = await source.inspect(sessionId);
    if (!native) return 'later';
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
        const adopted = target ? (delivery && target === delivery.sessionId ? await adopt(source, task, target) : workbench.store.conversationForNative('dsh', target)?.id) : undefined;
        if (adopted === 'later' && delivery && Date.now() - Date.parse(delivery.deliveredAt) < ADOPT_WINDOW_MS) { retrySoon(); continue; }
        if (adopted && adopted !== 'later') await workbench.noticeActivity(adopted).catch(() => {});
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
  /** A delivery whose new session is not ready to adopt is looked at again shortly, not at the next slow poll. */
  function retrySoon(): void {
    if (closed || retry) return;
    retry = setTimeout(() => { retry = undefined; void refresh(); }, ADOPT_RETRY_MS); retry.unref();
  }
  function changed(): void {
    if (closed || debounce) return;
    debounce = setTimeout(() => { debounce = undefined; void refresh(); }, 300); debounce.unref();
  }

  function workspaceOf(cwd: string | undefined) { return cwd ? workbench.workspaceView().workspaces.find(entry => workbench.workspaces.find(w => w.id === entry.id)?.directory === cwd) : undefined; }
  /**
   * When the next delivery into the same session arrived, from this task or another one sharing the conversation;
   * a conclusion written after it belongs to that later run.
   */
  function nextInSession(delivery: AutomationDelivery): string | undefined {
    let next: string | undefined;
    for (const task of cache.get('dsh')?.tasks ?? []) {
      const other = task.lastDelivery;
      if (other && other.sessionId === delivery.sessionId && other.deliveredAt > delivery.deliveredAt && (!next || other.deliveredAt < next)) next = other.deliveredAt;
    }
    return next;
  }
  /** `until`: when the next delivery arrived; without it, the next one known in the same session. */
  function deliveryView(delivery: AutomationDelivery, until = nextInSession(delivery)): AutomationDeliveryView {
    const conversation = workbench.store.conversationForNative('dsh', delivery.sessionId);
    // A conclusion is written after its delivery and before the next one into the same session.
    const result = conversation ? results.within(conversation.id, Date.parse(delivery.deliveredAt), until ? Date.parse(until) : undefined) : undefined;
    return { scheduledAt: delivery.scheduledAt, deliveredAt: delivery.deliveredAt, late: late(delivery), ...(conversation ? { conversationId: conversation.id } : {}),
      ...(delivery.prompt ? { prompt: delivery.prompt } : {}), ...(result ? { result } : {}) };
  }
  function view(task: NativeAutomation): AutomationView {
    let target: AutomationView['target'];
    if (task.target.kind === 'session') {
      const conversation = workbench.store.conversationForNative('dsh', task.target.sessionId);
      const workspace = conversation && workbench.workspaceView().workspaces.find(entry => entry.id === conversation.workspaceId);
      // A "new once" task after its first run: still shown as such, with the conversation it created and reuses.
      target = conversation?.automationId === task.id ? { kind: 'new_once', conversationId: conversation.id, workspaceId: conversation.workspaceId, ...(workspace ? { workspaceLabel: workspace.label } : {}), configuration: conversation.configuration }
        : conversation ? { kind: 'conversation', conversationId: conversation.id, conversationTitle: conversation.title, configuration: conversation.configuration } : { kind: 'unknown' };
    } else {
      const workspace = workspaceOf(task.target.cwd);
      target = { kind: task.target.kind, ...(workspace ? { workspaceId: workspace.id, workspaceLabel: workspace.label } : {}), ...(task.target.preset ? { preset: task.target.preset } : {}) };
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
  /** DSH 0.2.2 accepts an edit to an ended task and revives a one-shot one, so the rule is kept here, on a fresh native read. */
  async function update(id: string, patch: AutomationPatch, expectedUpdatedAt?: string): Promise<AutomationEdit> {
    const task = await source('dsh').view(id);
    if (!task) return 'notFound';
    if (task.status === 'ended') return 'ended';
    return source('dsh').update(id, patch, expectedUpdatedAt);
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
      if (error instanceof AutomationError) return reply.code(error.statusCode).send({ error: error.message, ...(error.problems ? { problems: error.problems } : {}) });
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
      // Each run ends where the next later delivery of the same task arrived; its conclusion is written before that.
      const times = page.records.map(record => record.deliveredAt).sort();
      const next = (record: AutomationDelivery) => [times.find(other => other > record.deliveredAt), nextInSession(record)].filter((value): value is string => !!value).sort()[0];
      return { records: page.records.map(record => deliveryView(record, next(record))), earlierUnavailable: page.earlierUnavailable, ...(page.before ? { before: page.before } : {}) };
    });
    app.get('/automations/:id/runs', async request => {
      const { id } = parse(params, request.params);
      return { conversations: workbench.store.listConversations({ automationId: id, limit: 200 }).map(entry => ({ id: entry.id, title: entry.title, createdAt: entry.createdAt })) };
    });
    app.post('/automations', { bodyLimit: 64 * 1024 }, async request => {
      const input = parse(automationCreateSchema, request.body);
      const task = await source(input.harnessId).create({ title: input.title, prompt: input.prompt, timing: nativeTiming(input.timing), target: targetInput(input.target) });
      log({ event: 'automation_created' }); await refresh();
      return { outcome: 'ok', automation: view(task) };
    });
    app.post('/automations/:id/edit', { bodyLimit: 64 * 1024 }, async request => {
      const { id } = parse(params, request.params);
      const input = parse(automationEditSchema, request.body);
      await find(id);
      const { timing, ...rest } = input.patch;
      const result = await update(id, { ...rest, ...(timing ? { timing: nativeTiming(timing) } : {}) }, input.expectedUpdatedAt);
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

  /** The same operations, for 司辰's command line (ADR 0022); it reaches them through the agent endpoint, not the page. */
  const operations = {
    async list() { return (await current()).map(view); },
    async get(id: string) { return view(await find(id)); },
    async native(id: string) { return find(id); },
    async create(input: { title: string; prompt: string; timing: AutomationTimingInput; target: AutomationTargetInput }) {
      const task = await source('dsh').create(input);
      log({ event: 'automation_created', via: 'sichen' }); await refresh();
      return view(task);
    },
    async edit(id: string, patch: AutomationPatch, expectedUpdatedAt?: string) {
      await find(id);
      const result = await update(id, patch, expectedUpdatedAt);
      await refresh();
      if (typeof result === 'string') return result;
      log({ event: 'automation_changed', via: 'sichen' });
      return view(result);
    },
    async remove(id: string, expectedUpdatedAt?: string) {
      const result = await source('dsh').remove(id, expectedUpdatedAt); await refresh();
      if (result === 'deleted') log({ event: 'automation_deleted', via: 'sichen' });
      return result;
    },
    async run(id: string) { const result = await source('dsh').run(id); await refresh(); return typeof result === 'string' ? result : view(result); },
    available: () => sources.has('dsh'),
  };

  return {
    routes,
    results,
    operations,
    available: () => sources.size > 0,
    async start(): Promise<void> {
      for (const value of sources.values()) unsubscribe.push(value.onChange(changed));
      unsubscribe.push(workbench.onObserved((id, items) => { notifications.observed(id, items); results.observed(id, items); }));
      notifications.start();
      // Missed events are recovered by a slow re-list; deliveries still reach observation within a minute.
      poll = setInterval(() => { void refresh(); }, POLL_MS); poll.unref();
      void refresh();
    },
    close(): void {
      closed = true;
      if (debounce) clearTimeout(debounce); if (poll) clearInterval(poll); if (retry) clearTimeout(retry);
      for (const stop of unsubscribe.splice(0)) stop();
      notifications.close();
    },
  };
}
export type Automations = ReturnType<typeof createAutomations>;

/** A calendar date that exists: JavaScript would roll 2026-02-30 over to March. */
const realDate = (value: string) => { const [y, m, d] = value.split('-').map(Number); const date = new Date(Date.UTC(y!, m! - 1, d!)); return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d; };
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
    if (!realDate(value.date)) { report(index + 1, 'invalid_date'); continue; }
    let link: string | undefined;
    if (value.link !== undefined) {
      // A path inside the workspace, written relative to its root; "./" and doubled slashes are tidied, anything else is refused.
      const parts = value.link.split('/').filter(part => part && part !== '.');
      if (!parts.length || value.link.startsWith('/') || value.link.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(value.link) || parts.includes('..')) {
        report(index + 1, 'link_outside_workspace'); continue;
      }
      link = parts.join('/');
    }
    entries.set(value.id, { ...value, ...(link ? { link } : {}), workspaceId: workspace.id, workspaceLabel: workspace.label });
  }
  return { entries: [...entries.values()].sort(byWhen), problems };
}

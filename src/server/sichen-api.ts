/**
 * 司辰's endpoints on the agent tool server (ADR 0022). The `sichen` command calls them over loopback with the agent
 * token. Every rule goes through the shared time model, tasks go to the Harness through the automation operations, and
 * timeline lines are validated with the same parser the calendar reads them with.
 */
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { whenSchema, type AutomationView } from '../shared/automations.ts';
import { describe, fromNative, upcoming, validZone, zoned, type When } from '../sichen/time.ts';
import { PROTOCOL_HEADER, SICHEN_PROTOCOL, ZONE_HEADER, type SichenTask } from '../sichen/protocol.ts';
import { AutomationError, nativeTiming, parseTimeline, type createAutomations } from './automations.ts';
import type { Workbench } from './workbench.ts';
import { appendWorkspaceTimeline, readWorkspaceTimeline } from './workspace-documents.ts';
import { HarnessError } from '../harness/types.ts';

type Operations = ReturnType<typeof createAutomations>['operations'];
const name = z.string().trim().min(1).max(120);
const prompt = z.string().trim().min(1).max(32_000);
const cwd = z.string().min(1).max(4096).refine(value => value.startsWith('/') && !value.includes('\0'));
const session = z.string().min(1).max(240).regex(/^[A-Za-z0-9._:-]+$/);
const id = z.string().min(1).max(240).regex(/^[A-Za-z0-9._:-]+$/);
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const addSchema = z.object({ name, prompt, when: whenSchema, to: z.enum(['here', 'new', 'new_once']), session: session.optional(), cwd, preset: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional() }).strict();
const editSchema = z.object({ name: name.optional(), prompt: prompt.optional(), when: whenSchema.optional(), until: dateText.nullable().optional(), expectedUpdatedAt: z.string().max(40).optional() }).strict()
  .refine(value => Object.keys(value).some(key => key !== 'expectedUpdatedAt'));
const timelineAdd = z.object({ cwd, kind: z.enum(['action', 'event', 'decision', 'research']), title: z.string().trim().min(1).max(200), date: dateText, time: clock.optional(), tz: z.string().max(80).optional(),
  link: z.string().max(1024).optional(), detail: z.string().max(2000).optional(), id: id.optional() }).strict();
const timelineMark = z.object({ cwd }).strict();
const message: Record<string, string> = {
  protocol_mismatch: '命令行和中书的版本不一致，请更新 sichen。',
  invalid_request: '参数不完整或格式不对，请运行 sichen --help 查看用法。',
  not_in_workspace: '当前目录不在中书登记的任何工作区里，请在工作区目录里运行。',
  session_required: '“回到本对话”需要在 DSH 的对话里运行（缺少 DSH_SESSION_ID）。',
  automations_unavailable: '这个实例没有接通 DSH 定时任务。',
  automation_not_found: '找不到这个任务，可能已被删除。请用 sichen schedule list 查看编号。',
  conflict: '这个任务刚在别处改过，请重新读取后再改。',
  ended: '这个任务已经结束，不能再改。',
  pending: '上一次运行还没结束，请稍后再试。',
  rule_not_editable: '这个任务的时间规则不是司辰能改的写法，请用 --every/--monthly/--at 重新给出完整时间。',
  invalid_time: '时间写法有问题。',
  harness_unavailable: '暂时连不上 DSH，请稍后再试。',
  timeline_entry_invalid: '这一条日历条目不合格。',
  timeline_entry_not_found: '时间轴里找不到这个编号。',
  workspace_file_unavailable: '无法读写这个工作区的时间轴文件。',
};
class SichenFailure extends Error {
  readonly code: string; readonly statusCode: number; readonly problems?: string[];
  constructor(code: string, statusCode = 400, problems?: string[]) { super(code); this.code = code; this.statusCode = statusCode; if (problems) this.problems = problems; }
}

export function sichenRoutes(options: { operations: Operations; workbench: Workbench; version: string; revision?: string }) {
  const { operations, workbench } = options;
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const parsed = schema.safeParse(value); if (!parsed.success) throw new SichenFailure('invalid_request'); return parsed.data; };
  /** The registered workspace holding a directory; the deepest one when workspaces nest. */
  function workspaceFor(directory: string) {
    const path = posix.normalize(directory).replace(/\/+$/, '') || '/';
    const match = workbench.workspaces.filter(entry => path === entry.directory || path.startsWith(entry.directory.replace(/\/+$/, '') + '/'))
      .sort((a, b) => b.directory.length - a.directory.length)[0];
    if (!match) throw new SichenFailure('not_in_workspace', 404);
    const label = workbench.workspaceView().workspaces.find(entry => entry.id === match.id)?.label ?? match.id;
    return { ...match, label };
  }
  function zoneOf(request: FastifyRequest): string {
    const value = request.headers[ZONE_HEADER];
    return typeof value === 'string' && validZone(value) ? value : 'UTC';
  }
  function taskView(task: AutomationView, zone: string, now = Date.now()): SichenTask {
    const read = fromNative(task.timing, zone);
    // A start that has already come is not worth saying; only a future start changes what the reader expects.
    const when = read?.from && read.from <= zoned(now, read.timeZone).date ? (({ from: _from, ...rest }) => rest)(read) : read;
    const next = task.status !== 'active' ? [] : when && when.rule.kind !== 'cron' ? upcoming(when, now - 1, 3).map(value => new Date(value).toISOString()) : [task.scheduledAt];
    const target = task.target;
    const to = target.kind === 'conversation' ? `回到对话「${target.conversationTitle ?? ''}」` : target.kind === 'new' ? `每次新开一段对话${target.workspaceLabel ? `（${target.workspaceLabel}）` : ''}`
      : target.kind === 'new_once' ? `首次新开，之后回到那段${target.workspaceLabel ? `（${target.workspaceLabel}）` : ''}` : '中书之外的原生会话';
    const conversationId = target.conversationId ?? task.latestRun?.conversationId;
    return { id: task.id, name: task.title, status: task.status, prompt: task.prompt, ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
      rule: when ? describe(when, zone) : `原生规则：${JSON.stringify(task.timing)}`, ...(when ? { timeZone: when.timeZone } : {}), ...(when?.until ? { until: when.until } : {}),
      next, to, ...(conversationId ? { conversationId } : {}),
      ...(task.lastDelivery ? { lastRun: { at: task.lastDelivery.deliveredAt, late: task.lastDelivery.late, ...(task.lastDelivery.result ? { result: task.lastDelivery.result } : {}) } } : {}) };
  }
  async function entries(directory: string, workspace: { id: string; label: string }) {
    let text: string | null;
    try { text = await readWorkspaceTimeline(directory); } catch { throw new SichenFailure('workspace_file_unavailable', 409); }
    return parseTimeline(text ?? '', workspace);
  }
  async function append(directory: string, line: Record<string, unknown>, workspace: { id: string; label: string }) {
    const text = JSON.stringify(line);
    const parsed = parseTimeline(text, workspace);
    if (parsed.problems.length || parsed.entries.length !== 1) throw new SichenFailure('timeline_entry_invalid', 400, parsed.problems.map(problem => problem.reason));
    try { await appendWorkspaceTimeline(directory, text); } catch { throw new SichenFailure('workspace_file_unavailable', 409); }
    return parsed.entries[0]!;
  }

  return async function routes(app: FastifyInstance, guard: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
    app.setErrorHandler((error, _request, reply) => {
      const failure = error instanceof SichenFailure ? error
        : error instanceof AutomationError ? new SichenFailure(error.message, error.statusCode, error.problems)
        : error instanceof HarnessError ? new SichenFailure('harness_unavailable', 502) : new SichenFailure('invalid_request', 400);
      return reply.code(failure.statusCode).send({ error: failure.code, message: message[failure.code] ?? failure.code, ...(failure.problems?.length ? { problems: failure.problems } : {}) });
    });
    // The version answers even across protocols, so the command can say which side to update.
    app.get('/sichen/v1/version', { preHandler: guard }, async () => ({ protocol: SICHEN_PROTOCOL, version: options.version, ...(options.revision ? { revision: options.revision } : {}), schedule: operations.available() }));
    app.register(async scoped => {
      scoped.addHook('preHandler', guard);
      scoped.addHook('preHandler', async request => { if (request.headers[PROTOCOL_HEADER] !== String(SICHEN_PROTOCOL)) throw new SichenFailure('protocol_mismatch', 409); });
      scoped.post('/sichen/v1/schedule/add', async request => {
        const input = parse(addSchema, request.body);
        const target = input.to === 'here'
          ? (input.session ? { kind: 'session' as const, sessionId: input.session } : (() => { throw new SichenFailure('session_required'); })())
          : { kind: input.to, cwd: workspaceFor(input.cwd).directory, ...(input.preset ? { preset: input.preset } : {}) };
        if (input.to !== 'here') workspaceFor(input.cwd);
        const task = await operations.create({ title: input.name, prompt: input.prompt, timing: nativeTiming({ kind: 'when', when: input.when }), target });
        return { task: taskView(task, zoneOf(request)) };
      });
      scoped.get('/sichen/v1/schedule', async request => {
        const { state } = parse(z.object({ state: z.enum(['active', 'paused', 'ended', 'all']).default('active') }).strict(), request.query);
        const zone = zoneOf(request);
        const tasks = (await operations.list()).filter(task => state === 'all' || task.status === state)
          .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).map(task => taskView(task, zone));
        return { tasks };
      });
      scoped.get('/sichen/v1/schedule/:id', async request => ({ task: taskView(await operations.get(parse(z.object({ id }).strict(), request.params).id), zoneOf(request)) }));
      scoped.post('/sichen/v1/schedule/:id/edit', async request => {
        const { id: taskId } = parse(z.object({ id }).strict(), request.params);
        const input = parse(editSchema, request.body);
        let when: When | undefined = input.when;
        if (input.until !== undefined) {
          const current = when ?? fromNative((await operations.native(taskId)).timing, zoneOf(request));
          if (!current || current.rule.kind === 'once' || current.rule.kind === 'cron') throw new SichenFailure('rule_not_editable');
          const { until: _old, ...rest } = current;
          when = { ...rest, ...(input.until ? { until: input.until } : {}) };
        }
        const result = await operations.edit(taskId, { ...(input.name ? { title: input.name } : {}), ...(input.prompt ? { prompt: input.prompt } : {}), ...(when ? { timing: nativeTiming({ kind: 'when', when }) } : {}) }, input.expectedUpdatedAt);
        if (result === 'conflict' || result === 'ended') throw new SichenFailure(result, 409);
        if (result === 'notFound') throw new SichenFailure('automation_not_found', 404);
        return { task: taskView(result, zoneOf(request)) };
      });
      for (const action of ['pause', 'resume'] as const) {
        scoped.post(`/sichen/v1/schedule/:id/${action}`, async request => {
          const { id: taskId } = parse(z.object({ id }).strict(), request.params);
          const result = await operations.edit(taskId, { active: action === 'resume' });
          if (result === 'conflict' || result === 'ended') throw new SichenFailure(result, 409);
          if (result === 'notFound') throw new SichenFailure('automation_not_found', 404);
          return { task: taskView(result, zoneOf(request)) };
        });
      }
      scoped.post('/sichen/v1/schedule/:id/delete', async request => {
        const { id: taskId } = parse(z.object({ id }).strict(), request.params);
        const result = await operations.remove(taskId);
        if (result === 'notFound') throw new SichenFailure('automation_not_found', 404);
        if (result === 'conflict') throw new SichenFailure('conflict', 409);
        return { deleted: taskId };
      });
      scoped.post('/sichen/v1/schedule/:id/run', async request => {
        const { id: taskId } = parse(z.object({ id }).strict(), request.params);
        const result = await operations.run(taskId);
        if (result === 'pending') throw new SichenFailure('pending', 409);
        if (result === 'notFound') throw new SichenFailure('automation_not_found', 404);
        return { task: taskView(result, zoneOf(request)) };
      });
      scoped.post('/sichen/v1/timeline/add', async request => {
        const input = parse(timelineAdd, request.body);
        const workspace = workspaceFor(input.cwd);
        const zone = input.tz ?? zoneOf(request);
        const line = { id: input.id ?? `${input.kind}-${input.date.replaceAll('-', '')}-${randomBytes(3).toString('hex')}`, date: input.date,
          ...(input.time ? { time: input.time, tz: zone } : {}), kind: input.kind, title: input.title,
          ...(input.detail ? { detail: input.detail } : {}), ...(input.link ? { link: input.link } : {}) };
        return { entry: await append(workspace.directory, line, workspace), workspace: workspace.label };
      });
      for (const status of ['done', 'cancelled'] as const) {
        scoped.post(`/sichen/v1/timeline/:id/${status === 'done' ? 'done' : 'cancel'}`, async request => {
          const { id: entryId } = parse(z.object({ id }).strict(), request.params);
          const { cwd: directory } = parse(timelineMark, request.body);
          const workspace = workspaceFor(directory);
          const found = (await entries(workspace.directory, workspace)).entries.find(entry => entry.id === entryId);
          if (!found) throw new SichenFailure('timeline_entry_not_found', 404);
          const { workspaceId: _w, workspaceLabel: _l, ...line } = found;
          return { entry: await append(workspace.directory, { ...line, status }, workspace), workspace: workspace.label };
        });
      }
      scoped.get('/sichen/v1/timeline', async request => {
        const query = parse(z.object({ cwd, from: dateText.optional(), to: dateText.optional() }).strict(), request.query);
        const workspace = workspaceFor(query.cwd);
        const read = await entries(workspace.directory, workspace);
        const today = zoned(Date.now(), zoneOf(request)).date;
        const from = query.from ?? today;
        return { workspace: workspace.label, entries: read.entries.filter(entry => entry.date >= from && (!query.to || entry.date <= query.to)), problems: read.problems.length };
      });
    });
  };
}

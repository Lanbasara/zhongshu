/** DSH Host schedule tasks as Zhongshu automations (ADR 0021). The Host owns them; nothing here is cached. */
import { z } from 'zod';
import { HarnessError } from '../types.ts';
import type { AutomationDelivery, AutomationEdit, AutomationPatch, AutomationTarget, AutomationTargetInput, AutomationTiming, AutomationTimingInput, HarnessAutomations, NativeAutomation } from '../types.ts';
import type { Connection } from './connection.ts';

const id = z.string().min(1).max(240);
const instant = z.string().min(20).max(40);
const text = (max: number) => z.string().max(max);
const receipt = z.object({ scheduledAt: instant, deliveredAt: instant, messageId: id, targetSessionId: id }).passthrough();
const createSpec = z.object({ cwd: z.string().max(4096).optional(), agentPreset: z.string().max(200).optional() }).passthrough();
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: id }).passthrough(),
  z.object({ kind: z.literal('new_once'), sessionId: id, create: createSpec }).passthrough(),
  z.object({ kind: z.literal('new'), create: createSpec }).passthrough(),
]);
const base = { id, title: text(200), prompt: text(64_000), scheduledAt: instant };
const record = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('after'), afterSeconds: z.number() }).passthrough(),
  z.object({ ...base, kind: z.literal('at') }).passthrough(),
  z.object({ ...base, kind: z.literal('every'), everySeconds: z.number().int().positive() }).passthrough(),
  z.object({ ...base, kind: z.literal('daily'), time: text(20), timeZone: text(80) }).passthrough(),
  z.object({ ...base, kind: z.literal('weekly'), time: text(20), timeZone: text(80), weekdays: z.array(z.number().int().min(1).max(7)).max(7) }).passthrough(),
  z.object({ ...base, kind: z.literal('cron'), expression: text(200), timeZone: text(80) }).passthrough(),
  z.object({ ...base, kind: z.literal('rrule'), rrule: text(2000) }).passthrough(),
]);
const extra = z.object({
  target, involvedSessionIds: z.array(id).max(1000).default([]), status: z.enum(['active', 'paused', 'ended']),
  createdAt: instant.optional(), updatedAt: instant.optional(), executionActive: z.literal(true).optional(), lastDelivery: receipt.optional(),
}).passthrough();
const entry = z.intersection(record, extra);
const miss = z.object({ id, code: z.string().max(80) }).passthrough();
const historyPage = z.object({ id, records: z.array(receipt.extend({ prompt: text(64_000).optional() })).max(100), earlierRecordsUnavailable: z.boolean(), nextBefore: id.optional() }).passthrough();

/** Clock times keep minutes only; the Host normalizes to HH:mm:ss.SSS. */
const clock = (value: string) => value.slice(0, 5);
function timingOf(value: z.infer<typeof record>): AutomationTiming {
  switch (value.kind) {
    case 'after': case 'at': return { kind: 'once', at: value.scheduledAt };
    case 'every': return { kind: 'every', seconds: value.everySeconds };
    case 'daily': return { kind: 'daily', time: clock(value.time), timeZone: value.timeZone };
    case 'weekly': return { kind: 'weekly', time: clock(value.time), timeZone: value.timeZone, weekdays: value.weekdays };
    case 'cron': return { kind: 'cron', expression: value.expression, timeZone: value.timeZone };
    case 'rrule': return { kind: 'rrule', rrule: value.rrule };
  }
}
function targetOf(value: z.infer<typeof target>): AutomationTarget {
  if (value.kind === 'session') return { kind: 'session', sessionId: value.sessionId };
  const spec = { ...(value.create.cwd ? { cwd: value.create.cwd } : {}), ...(value.create.agentPreset ? { preset: value.create.agentPreset } : {}) };
  return value.kind === 'new_once' ? { kind: 'new_once', sessionId: value.sessionId, ...spec } : { kind: 'new', ...spec };
}
const delivery = (value: z.infer<typeof receipt> & { prompt?: string }): AutomationDelivery =>
  ({ scheduledAt: value.scheduledAt, deliveredAt: value.deliveredAt, messageId: value.messageId, sessionId: value.targetSessionId, ...(value.prompt ? { prompt: value.prompt } : {}) });
export function automationOf(value: unknown): NativeAutomation {
  const parsed = entry.parse(value);
  return {
    id: parsed.id, title: parsed.title, prompt: parsed.prompt, timing: timingOf(parsed), scheduledAt: parsed.scheduledAt, status: parsed.status,
    target: targetOf(parsed.target), involved: parsed.involvedSessionIds, executing: parsed.executionActive === true,
    ...(parsed.createdAt ? { createdAt: parsed.createdAt } : {}), ...(parsed.updatedAt ? { updatedAt: parsed.updatedAt } : {}),
    ...(parsed.lastDelivery ? { lastDelivery: delivery(parsed.lastDelivery) } : {}),
  };
}
const seconds = (time: string) => (time.length === 5 ? time + ':00' : time);
export function timingInput(value: AutomationTimingInput): Record<string, unknown> {
  switch (value.kind) {
    case 'at': return { kind: 'at', at: value.at };
    case 'every': return { kind: 'every', every_seconds: value.seconds };
    case 'daily': return { kind: 'daily', daily: { time: seconds(value.time), time_zone: value.timeZone } };
    case 'weekly': return { kind: 'weekly', weekly: { time: seconds(value.time), time_zone: value.timeZone, weekdays: value.weekdays } };
    case 'cron': return { kind: 'cron', cron: { expression: value.expression, time_zone: value.timeZone } };
    case 'rrule': return { kind: 'rrule', rrule: value.rrule };
  }
}
export function targetInput(value: AutomationTargetInput): Record<string, unknown> {
  if (value.kind === 'session') return { kind: 'session', sessionId: value.sessionId };
  const create = { ...(value.cwd ? { cwd: value.cwd } : {}), ...(value.preset ? { agentPreset: value.preset } : {}) };
  return { kind: value.kind, ...(Object.keys(create).length ? { create } : {}) };
}
function patchInput(patch: AutomationPatch): Record<string, unknown> {
  return {
    ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
    ...(patch.timing ? { timing: timingInput(patch.timing) } : {}), ...(patch.target ? { target: targetInput(patch.target) } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  };
}
const codeOf = (value: unknown) => miss.safeParse(value).data?.code;
const PAGE = 500;

export function dshAutomations(connection: Connection, inspect: HarnessAutomations['inspect']): HarnessAutomations & { changed(): void } {
  const listeners = new Set<() => void>();
  const call = (method: string, request: Record<string, unknown>) => connection.call(`schedule/${method}`, { request });
  return {
    changed() { for (const listener of listeners) { try { listener(); } catch { /* one listener cannot stop the others */ } } },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    inspect,
    async list() {
      const out: NativeAutomation[] = [];
      for (let offset = 0; offset < 5000; offset += PAGE) {
        const page = z.object({ items: z.array(z.unknown()).max(PAGE), total: z.number().int().nonnegative() }).passthrough().parse(await call('list', { limit: PAGE, offset }));
        // A task the adapter cannot read is skipped rather than hiding the others.
        for (const item of page.items) { try { out.push(automationOf(item)); } catch { /* unsupported shape */ } }
        if (offset + PAGE >= page.total || page.items.length === 0) break;
      }
      return out;
    },
    async view(automationId) {
      const value = await call('view', { id: automationId });
      return codeOf(value) ? undefined : automationOf(value);
    },
    async history(automationId, limit, before) {
      const value = await call('history', { id: automationId, limit: Math.min(100, Math.max(1, Math.trunc(limit))), ...(before ? { before } : {}) });
      if (codeOf(value)) return undefined;
      const page = historyPage.parse(value);
      return { records: page.records.map(delivery), earlierUnavailable: page.earlierRecordsUnavailable, ...(page.nextBefore ? { before: page.nextBefore } : {}) };
    },
    async create(input) {
      return automationOf(await call('create', { title: input.title, prompt: input.prompt, timing: timingInput(input.timing), ...(input.target ? { target: targetInput(input.target) } : {}) }));
    },
    async update(automationId, patch, expectedUpdatedAt): Promise<AutomationEdit> {
      const value = await call('edit', { id: automationId, action: 'update', patch: patchInput(patch), ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) });
      const code = codeOf(value);
      if (code === 'schedule_conflict') return 'conflict';
      if (code === 'schedule_not_found') return 'notFound';
      if (code === 'schedule_ended') return 'ended';
      if (code) throw new HarnessError('DSH_SCHEDULE_REJECTED');
      return automationOf(value);
    },
    async remove(automationId, expectedUpdatedAt) {
      const value = await call('edit', { id: automationId, action: 'delete', ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) });
      const code = codeOf(value);
      if (code === 'schedule_conflict') return 'conflict';
      if (code === 'schedule_not_found') return 'notFound';
      if (code) throw new HarnessError('DSH_SCHEDULE_REJECTED');
      return 'deleted';
    },
    async run(automationId) {
      const value = await call('run', { id: automationId });
      const code = codeOf(value);
      if (code === 'schedule_execution_pending') return 'pending';
      if (code === 'schedule_not_found') return 'notFound';
      if (code) throw new HarnessError('DSH_SCHEDULE_REJECTED');
      return automationOf(value);
    },
  };
}

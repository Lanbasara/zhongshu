/** Browser contract for automations, agent notifications and the workspace timeline (ADR 0021). */
import { z } from 'zod';

const instant = z.string().min(20).max(40);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const zone = z.string().min(1).max(80).regex(/^[A-Za-z_+\-/0-9]+$/);
export const automationTimingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: instant }).strict(),
  z.object({ kind: z.literal('every'), seconds: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('daily'), time: clock, timeZone: zone }).strict(),
  z.object({ kind: z.literal('weekly'), time: clock, timeZone: zone, weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7) }).strict(),
  z.object({ kind: z.literal('cron'), expression: z.string().min(1).max(200), timeZone: zone }).strict(),
  z.object({ kind: z.literal('rrule'), rrule: z.string().min(1).max(2000) }).strict(),
]);
/** What the page may ask for; `at` is an absolute instant the page computed from the user's local date and time. */
export const automationTimingInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), at: instant }).strict(),
  z.object({ kind: z.literal('every'), seconds: z.number().int().min(60).max(366 * 86400) }).strict(),
  z.object({ kind: z.literal('daily'), time: clock, timeZone: zone }).strict(),
  z.object({ kind: z.literal('weekly'), time: clock, timeZone: zone, weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7) }).strict(),
  z.object({ kind: z.literal('cron'), expression: z.string().min(9).max(200), timeZone: zone }).strict(),
]);
/** A target in product terms: a conversation, or a new conversation in a registered workspace. */
export const automationTargetInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation'), conversationId: z.uuid() }).strict(),
  z.object({ kind: z.enum(['new', 'new_once']), workspaceId: z.string().min(1).max(64), preset: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional() }).strict(),
]);
const title = z.string().trim().min(1).max(120);
const prompt = z.string().trim().min(1).max(32_000);
export const automationCreateSchema = z.object({ harnessId: z.enum(['dsh']), title, prompt, timing: automationTimingInputSchema, target: automationTargetInputSchema }).strict();
export const automationEditSchema = z.object({
  patch: z.object({ title: title.optional(), prompt: prompt.optional(), timing: automationTimingInputSchema.optional(), active: z.boolean().optional() }).strict()
    .refine(value => Object.keys(value).length > 0),
  expectedUpdatedAt: instant.optional(),
}).strict();
export const automationDeleteSchema = z.object({ expectedUpdatedAt: instant.optional() }).strict();

export const automationDeliverySchema = z.object({
  scheduledAt: instant, deliveredAt: instant,
  /** Delivered noticeably after its planned time, for example after a Host restart. */
  late: z.boolean(),
  conversationId: z.uuid().optional(), prompt: z.string().max(64_000).optional(),
}).strict();
export const automationTargetSchema = z.object({
  kind: z.enum(['conversation', 'new', 'new_once', 'unknown']),
  conversationId: z.uuid().optional(), conversationTitle: z.string().max(200).optional(),
  workspaceId: z.string().max(64).optional(), workspaceLabel: z.string().max(100).optional(),
}).strict();
export const automationSchema = z.object({
  id: z.string().min(1).max(240), harnessId: z.enum(['dsh']), title: z.string().max(200), prompt: z.string().max(64_000),
  timing: automationTimingSchema, scheduledAt: instant, status: z.enum(['active', 'paused', 'ended']),
  target: automationTargetSchema, executing: z.boolean(), createdAt: instant.optional(), updatedAt: instant.optional(),
  lastDelivery: automationDeliverySchema.optional(),
  /** Conversations this automation created and Zhongshu adopted. */
  runs: z.number().int().nonnegative(),
}).strict();
export const automationListSchema = z.object({ available: z.boolean(), automations: z.array(automationSchema).max(5000) }).strict();
export const automationHistorySchema = z.object({ records: z.array(automationDeliverySchema).max(100), before: z.string().max(240).optional(), earlierUnavailable: z.boolean() }).strict();
export const automationResultSchema = z.object({ automation: automationSchema.optional(), outcome: z.enum(['ok', 'conflict', 'not_found', 'ended', 'pending', 'deleted']) }).strict();

export const agentNotificationSchema = z.object({
  id: z.uuid(), summary: z.string().max(400), file: z.string().max(1024).nullable(), createdAt: z.number().int(),
  state: z.enum(['pending', 'placed', 'unplaced']), conversationId: z.uuid().nullable(), itemId: z.string().max(600).nullable(),
}).strict();
export const agentNotificationListSchema = z.object({ notifications: z.array(agentNotificationSchema).max(200) }).strict();

/** One line of a workspace's `.zhongshu/timeline.jsonl`, as agents write it. The last line with an id wins. */
export const timelineKinds = ['action', 'event', 'decision', 'research'] as const;
export const timelineLineSchema = z.object({
  id: z.string().min(1).max(120),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: clock.optional(),
  tz: zone.optional(),
  kind: z.enum(timelineKinds),
  title: z.string().trim().min(1).max(200),
  detail: z.string().max(2000).optional(),
  link: z.string().max(512).optional(),
  status: z.enum(['done', 'cancelled']).optional(),
}).strip();
export const timelineEntrySchema = timelineLineSchema.extend({ workspaceId: z.string().max(64), workspaceLabel: z.string().max(100) }).strict();
export const timelineSchema = z.object({
  entries: z.array(timelineEntrySchema).max(20_000),
  /** Lines skipped because they were not valid, per workspace; shown so the agent can be asked to fix them. */
  problems: z.array(z.object({ workspaceId: z.string().max(64), line: z.number().int().positive(), reason: z.string().max(80) }).strict()).max(200),
}).strict();

export type AutomationView = z.infer<typeof automationSchema>;
export type AutomationDeliveryView = z.infer<typeof automationDeliverySchema>;
export type AutomationTimingView = z.infer<typeof automationTimingSchema>;
export type AutomationCreate = z.infer<typeof automationCreateSchema>;
export type AutomationEditInput = z.infer<typeof automationEditSchema>;
export type AgentNotificationView = z.infer<typeof agentNotificationSchema>;
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;
export type TimelineView = z.infer<typeof timelineSchema>;

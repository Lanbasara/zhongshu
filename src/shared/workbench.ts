import { z } from 'zod';
import { contentFields, inputFields, recordedFilePath, toolSchema, validSkillSpans, type InputContent } from './content.ts';

const utf8 = new TextEncoder();
const boundedText = (bytes: number) => z.string().max(bytes).refine(value => utf8.encode(value).byteLength <= bytes);
export const identifierSchema = boundedText(1024).min(1).refine(value => !value.includes('\0'));
export const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const usageSchema = z.object({
  total: revisionSchema.optional(),
  context: z.object({ used: revisionSchema, capacity: revisionSchema.min(1), estimated: z.boolean() }).strict().optional(),
}).strict().refine(value => value.total !== undefined || value.context !== undefined);
export type ConversationUsage = z.infer<typeof usageSchema>;
export const presetIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const configurationSchema = z.object({ modelId: identifierSchema, permissionId: identifierSchema, reasoningEffort: boundedText(240).min(1).optional(), agentPreset: presetIdSchema.optional() }).strict();
export const stateSchema = z.object({
  status: z.enum(['idle', 'running', 'waiting', 'interrupted', 'failed', 'unknown']),
  runId: identifierSchema.optional(), terminalRunId: identifierSchema.optional(),
  terminalStatus: z.enum(['completed', 'interrupted', 'failed']).optional(), pendingInputs: z.number().int().min(0).max(1_000_000),
  configurationVerified: z.boolean(), reason: boundedText(4096).optional(),
  /** Native Plan mode, for Harnesses that keep it as session state (DSH). */
  plan: z.object({ active: z.boolean(), pending: z.boolean() }).strict().optional(),
}).strict();
/** Native identities of sub-agents are opaque, URL-safe values verified against the owning conversation. */
/** Native sub-agent identity as it may appear in a URL path; dot segments are refused outright. */
export const subagentIdSchema = z.string().regex(/^[A-Za-z0-9:._-]{1,240}$/).refine(value => !value.includes('..'), 'dot_segment');
export const subagentLimit = 200;
export const collaborationActionSchema = z.enum(['started', 'completed', 'interrupted', 'closed', 'messaged', 'waiting']);
/** A native collaboration record in the main transcript; agent bodies are never inlined. */
export const collaborationSchema = z.object({ action: collaborationActionSchema, agentIds: z.array(subagentIdSchema).min(1).max(32) }).strict();
export const itemSchema = z.object({
  id: identifierSchema, kind: z.enum(['user', 'assistant', 'tool', 'notice']),
  text: boundedText(1_048_576), status: z.enum(['running', 'completed', 'failed', 'unknown']),
  runId: identifierSchema.optional(), operationId: identifierSchema.optional(),
  ...contentFields, tool: toolSchema.optional(), collaboration: collaborationSchema.optional(),
  /** A plan the agent proposed in Plan mode (Codex); shown as a plan block, not as an ordinary reply. */
  plan: z.literal(true).optional(),
}).strict();
export const subagentStatusSchema = z.enum(['running', 'idle', 'completed', 'interrupted', 'failed', 'unknown']);
/** Counts come from the last verified native snapshot; unverified active agents are never counted as running. */
export const subagentSummarySchema = z.object({
  total: z.number().int().min(1).max(subagentLimit), running: z.number().int().min(0).max(subagentLimit),
  unverified: z.number().int().min(0).max(subagentLimit), resultsPending: z.boolean(), revision: revisionSchema,
}).strict();
export const conversationSchema = z.object({
  id: z.uuid(), title: boundedText(200), harnessId: z.enum(['codex', 'dsh']), workspaceId: identifierSchema,
  configuration: configurationSchema, readiness: z.enum(['preparing', 'ready', 'blocked']),
  archived: z.boolean().default(false), state: stateSchema, error: boundedText(4096).nullable(), createdAt: revisionSchema,
  subagents: subagentSummarySchema.optional(),
  /** Plan mode, when the Harness offers it. `pending`: a requested change has not taken effect natively yet. */
  plan: z.object({ active: z.boolean(), pending: z.boolean().optional() }).strict().optional(),
  /** A completed, failed, 待核实 or not user-caused interrupted result that no device has seen; shared through the server. */
  unread: z.boolean().optional(),
}).strict();
const operationStatusSchema = z.enum(['queued', 'dispatching', 'accepted', 'unknown', 'rejected']);
export const subagentStopSchema = z.object({ id: z.uuid(), status: operationStatusSchema, reason: boundedText(4096).nullable(), updatedAt: revisionSchema }).strict();
export const subagentSchema = z.object({
  id: subagentIdSchema, name: boundedText(400).min(1), task: boundedText(4000).optional(), role: boundedText(400).optional(),
  model: boundedText(800).optional(), status: subagentStatusSchema,
  /** The last verified status, kept when the current status is unknown. */
  lastStatus: subagentStatusSchema.optional(), spawnedBy: boundedText(400).optional(), external: z.literal(true).optional(),
  startedAt: revisionSchema.optional(), endedAt: revisionSchema.optional(), verifiedAt: revisionSchema.optional(),
  revision: revisionSchema, stop: subagentStopSchema.optional(),
}).strict();
export const teamSchema = z.object({
  members: z.array(z.object({ id: subagentIdSchema, name: boundedText(400).min(1), status: z.enum(['running', 'idle', 'unknown']),
    lead: z.literal(true).optional(), agentId: subagentIdSchema.optional() }).strict()).max(64),
  tasks: z.array(z.object({ id: boundedText(240).min(1), title: boundedText(2000), description: boundedText(16_000),
    status: z.enum(['pending', 'in_progress', 'completed']), owner: boundedText(400).optional(),
    writeScopes: z.array(boundedText(4096)).max(32) }).strict()).max(200),
}).strict();
export const subagentListSchema = z.object({
  agents: z.array(subagentSchema).max(subagentLimit), team: teamSchema.optional(), stale: z.boolean(),
  verifiedAt: revisionSchema.optional(), revision: revisionSchema,
}).strict();
export const subagentHistorySchema = z.object({
  brief: boundedText(64 * 1024).optional(), items: z.array(itemSchema).max(100), olderCursor: z.string().min(1).max(4096).nullable(),
}).strict();
export const subagentStopResponseSchema = z.object({ stop: subagentStopSchema }).strict();
export const catalogSchema = z.object({
  id: z.enum(['codex', 'dsh']), available: z.boolean(), reason: boundedText(4096).optional(),
  models: z.array(z.object({ id: identifierSchema, label: boundedText(1024), reasoningEfforts: z.array(z.object({ id: boundedText(240).min(1), label: boundedText(500) }).strict()).max(32).optional(), defaultReasoningEffort: boundedText(240).min(1).optional() }).strict()).max(1000),
  defaultModelId: identifierSchema.optional(),
  permissions: z.array(z.object({ id: identifierSchema, label: boundedText(1024), description: boundedText(4096) }).strict()).max(100),
  presets: z.array(z.object({ id: presetIdSchema, label: boundedText(200), description: boundedText(1000), available: z.boolean() }).strict()).max(16).optional(),
  defaultPresetId: presetIdSchema.optional(),
}).strict();
export const workspaceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const workspaceLimit = 256;
export const workspaceLabelSchema = boundedText(400).max(100).refine(value => !!value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
export const folderName = boundedText(255).min(1).refine(value => !value.startsWith('.') && !/[\\/\u0000-\u001f\u007f]|%2[ef]|%5c/i.test(value) && value === value.trim());
const folderPath = z.array(folderName).max(12);
const directorySelection = { rootId: workspaceIdSchema, path: folderPath };
export const workspaceBrowseSchema = z.object(directorySelection).strict();
export const workspaceAddSchema = z.object({ ...directorySelection, name: folderName.optional() }).strict();
export const workspaceManagementSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), label: workspaceLabelSchema }).strict(),
  z.object({ action: z.literal('pin'), pinned: z.boolean() }).strict(),
  z.object({ action: z.literal('remove') }).strict(),
  z.object({ action: z.literal('restore') }).strict(),
]);
export const workspaceDirectoryListSchema = z.object({
  currentDirectory: boundedText(4096).min(1), names: z.array(folderName).max(200), limited: z.boolean(),
}).strict();
export const workbenchConfigurationSchema = z.object({
  harnesses: z.array(catalogSchema).max(2),
  workspaces: z.array(z.object({ id: identifierSchema, label: boundedText(400), directoryName: boundedText(1024).optional(), pinned: z.boolean().optional() }).strict()).max(workspaceLimit),
  removedWorkspaces: z.array(z.object({ id: identifierSchema, label: boundedText(400) }).strict()).max(workspaceLimit).optional(),
  workspaceRoots: z.array(z.object({ id: workspaceIdSchema, label: workspaceLabelSchema }).strict()).max(16).optional(),
}).strict();
export const createConversationSchema = z.object({
  id: z.uuid(), harnessId: z.enum(['codex', 'dsh']), workspaceId: identifierSchema,
  configuration: configurationSchema, title: boundedText(200).min(1).optional(), preparationId: z.uuid().optional(),
}).strict();
export const conversationTitleSchema = boundedText(200).refine(title => !!title.trim() && !title.includes('\0'));
export const conversationManagementSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), title: conversationTitleSchema }).strict(),
  z.object({ action: z.literal('archive'), archived: z.boolean() }).strict(),
]);
export const conversationSearchSchema = z.object({
  workspaceId: identifierSchema.optional(), unregistered: z.literal(true).optional(),
  title: boundedText(800).max(200).optional(), archived: z.boolean().default(false),
  beforeId: z.string().min(1).max(512).optional(),
}).strict().refine(query => !(query.workspaceId && query.unregistered));
export const messagePayload = z.object({ text: boundedText(48 * 1024).max(16_000), ...inputFields }).strict()
  .refine(v => v.text.trim() || v.images?.length || v.references?.length).refine(validSkillSpans);
export const earlyModeSchema = z.enum(['current', 'soon']);
export const queueDeliverySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('next') }).strict(),
  z.object({ mode: z.literal('current'), target: identifierSchema }).strict(),
  z.object({ mode: z.literal('soon'), target: identifierSchema }).strict(),
]);
export const queueLimit = 20;
const queueIdentity = { entryId: z.uuid(), version: revisionSchema };
export const queueCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), entryId: z.uuid(), content: messagePayload }).strict(),
  z.object({ action: z.literal('edit'), ...queueIdentity, content: messagePayload }).strict(),
  z.object({ action: z.literal('remove'), ...queueIdentity }).strict(),
  z.object({ action: z.literal('send'), ...queueIdentity, operationId: z.uuid(), mode: earlyModeSchema, target: identifierSchema }).strict(),
  z.object({ action: z.literal('resume'), version: revisionSchema }).strict(),
]);
export const queueEntrySchema = z.object({ ...queueIdentity, content: messagePayload,
  status: z.enum(['waiting', 'dispatching', 'accepted', 'unknown', 'held']),
  skillUnavailable: z.literal(true).optional(),
}).strict();
export const queuePauseSchema = z.enum(['stopped', 'failed', 'rejected', 'missed', 'restored']);
export const queueViewSchema = z.object({
  entries: z.array(queueEntrySchema).max(queueLimit), mode: earlyModeSchema.nullable(),
  pause: queuePauseSchema.nullable(), version: revisionSchema,
}).strict();
export type QueueCommand = z.infer<typeof queueCommandSchema>;
export type QueueDelivery = z.infer<typeof queueDeliverySchema>;
/** Codex current-turn input accepts text but omits native skill instruction loading. */
export function skillRequiresNextTurn(mode: QueueDelivery['mode'] | null, content: Pick<InputContent, 'skills'>): boolean {
  return mode === 'current' && !!content.skills?.length;
}
export type QueueView = z.infer<typeof queueViewSchema>;
export type QueuePause = z.infer<typeof queuePauseSchema>;
const stopPayload = z.object({ runId: identifierSchema }).strict();
export const enqueueOperationSchema = z.discriminatedUnion('type', [
  z.object({ id: z.uuid(), type: z.literal('message'), payload: messagePayload }).strict(),
  z.object({ id: z.uuid(), type: z.literal('stop'), payload: stopPayload }).strict(),
]);
const operationFields = {
  id: z.uuid(), conversationId: z.uuid(), status: operationStatusSchema,
  runId: identifierSchema.nullable(), reason: boundedText(4096).nullable(), createdAt: revisionSchema, updatedAt: revisionSchema,
};
export const operationSchema = z.object({ ...operationFields, type: z.enum(['message', 'stop']), delivery: queueDeliverySchema.optional() }).strict();
/** Opaque, URL-safe identity of one native pending request; meaningful only within its conversation. */
export const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const requestLimit = 32;
export const approvalDecisionSchema = z.enum(['accept', 'acceptForSession', 'decline', 'cancel']);
export const requestQuestionSchema = z.object({
  id: boundedText(240).min(1), header: boundedText(400).optional(), text: boundedText(16_000),
  options: z.array(z.object({ label: boundedText(400).min(1), description: boundedText(4000).optional() }).strict()).max(16),
  /** Several options may be chosen; otherwise at most one. */
  multiple: z.boolean(),
  /** A typed answer is accepted in addition to (or instead of) the options. */
  custom: z.boolean(),
  /** The agent asks to approve this plan: `approve` and `keep` are the native option labels; `plan` is markdown. */
  review: z.object({ approve: boundedText(400).min(1), keep: boundedText(400).min(1), plan: boundedText(64 * 1024) }).strict().optional(),
}).strict();
export const requestFieldSchema = z.object({
  name: boundedText(200).min(1), label: boundedText(400).min(1), description: boundedText(4000).optional(),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'enum']), required: z.boolean(),
  options: z.array(boundedText(400)).max(32).optional(),
}).strict();
const answerViewSchema = z.object({ id: z.uuid(), status: operationStatusSchema, reason: boundedText(4096).nullable(), updatedAt: revisionSchema, summary: boundedText(2000).optional() }).strict();
/**
 * A question, approval or form a native agent is waiting on. Native Harnesses own the request; the
 * view keeps a resolved request briefly so every device can see that it was answered or expired.
 */
export const pendingRequestSchema = z.object({
  id: requestIdSchema, kind: z.enum(['question', 'approval', 'form']), status: z.enum(['open', 'answered', 'expired']),
  createdAt: revisionSchema,
  /** The sub-agent that asked; absent when the conversation's main agent asked. */
  agent: z.object({ id: subagentIdSchema, name: boundedText(400).min(1) }).strict().optional(),
  questions: z.array(requestQuestionSchema).min(1).max(8).optional(),
  /** When the native agent stops waiting in the foreground; the question stays answerable afterwards. */
  deadline: revisionSchema.optional(),
  approval: z.object({
    action: z.enum(['command', 'fileChange', 'permissions', 'other']),
    reason: boundedText(8000).optional(), command: boundedText(32_000).optional(), cwd: boundedText(4096).optional(),
    paths: z.array(boundedText(4096)).max(64).optional(), network: z.boolean().optional(),
    /** Exactly the decisions the native request offers, in native order. */
    decisions: z.array(approvalDecisionSchema).min(1).max(4),
  }).strict().optional(),
  form: z.object({ source: boundedText(400).min(1), message: boundedText(16_000), url: z.url({ protocol: /^https$/ }).max(4096).optional(), fields: z.array(requestFieldSchema).max(24) }).strict().optional(),
  answer: answerViewSchema.optional(),
}).strict();
export const requestAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('question'), answers: z.array(z.object({ id: boundedText(240).min(1), selected: z.array(boundedText(400).min(1)).max(16), custom: boundedText(16_000).optional() }).strict()).min(1).max(8) }).strict(),
  z.object({ kind: z.literal('approval'), decision: approvalDecisionSchema }).strict(),
  z.object({ kind: z.literal('form'), action: z.enum(['accept', 'decline', 'cancel']),
    values: z.record(boundedText(200).min(1), z.union([boundedText(16_000), z.number().finite(), z.boolean()])).optional() }).strict(),
]);
export const answerRequestSchema = z.object({ id: z.uuid(), answer: requestAnswerSchema }).strict();
export const requestAnswerResponseSchema = z.object({ answer: answerViewSchema }).strict();
export type PendingRequest = z.infer<typeof pendingRequestSchema>;
export type RequestAnswer = z.infer<typeof requestAnswerSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type RequestQuestion = z.infer<typeof requestQuestionSchema>;
export type RequestField = z.infer<typeof requestFieldSchema>;
export type RequestAnswerView = z.infer<typeof answerViewSchema>;
export const conversationListSchema = z.object({
  conversations: z.array(conversationSchema).max(100), olderBeforeId: z.string().min(1).max(512).nullable(), revision: revisionSchema,
}).strict();
export const conversationResponseSchema = z.object({ conversation: conversationSchema }).strict();
export const attentionLimit = 50;
/** Non-archived conversations needing a look: running, waiting, failed, unknown, then unread; `unread` counts all of them, uncapped. */
export const attentionSchema = z.object({
  unread: revisionSchema, conversations: z.array(conversationSchema).max(attentionLimit),
}).strict();
export const operationResponseSchema = z.object({ operation: operationSchema }).strict();
export const turnFileLimit = 500;
const turnFilesSchema = z.object({ runId: identifierSchema, paths: z.array(recordedFilePath).max(turnFileLimit), limited: z.boolean() }).strict();
export type TurnFileSummary = z.infer<typeof turnFilesSchema>;
/** Opaque, conversation-bound position in native history (ADR 0014). */
export const historyCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,8192}$/);
export const historyPageItemLimit = 400;
/**
 * Position in the in-memory live stream (ADR 0019). `epoch` names one server process; `sequence` counts every live frame
 * that process sent. A snapshot carries the position it already reflects, so older frames are skipped.
 */
export const liveCursorSchema = z.object({ epoch: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), sequence: revisionSchema }).strict();
export const snapshotSchema = z.object({
  conversation: conversationSchema,
  /** The native latest page plus in-flight items; `error` keeps already loaded content readable when native reads fail. */
  history: z.object({ items: z.array(itemSchema).max(historyPageItemLimit), liveItems: z.array(itemSchema).max(100), liveItemsLimited: z.boolean(),
    olderCursor: historyCursorSchema.nullable(), loaded: z.boolean(), error: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).optional() }).strict(),
  operations: z.array(operationSchema).max(100), queue: queueViewSchema.optional(), turnFiles: z.array(turnFilesSchema).max(200).optional(), usage: usageSchema.optional(),
  /** Questions and approvals the agents are waiting on, plus recently resolved ones. */
  requests: z.array(pendingRequestSchema).max(requestLimit).optional(),
  /** A Plan-mode turn ended with a proposed plan and nothing came after it: offer to carry it out (Codex). */
  planReady: z.object({ runId: identifierSchema }).strict().optional(),
  revision: revisionSchema,
  /** The live-stream position this snapshot's `liveItems` already reflect (ADR 0019). */
  live: liveCursorSchema.optional(),
}).strict();
/** One older native page. `olderCursor` is null at the first message of the conversation. */
export const historyPageSchema = z.object({
  items: z.array(itemSchema).max(historyPageItemLimit), olderCursor: historyCursorSchema.nullable(), turnFiles: z.array(turnFilesSchema).max(200),
}).strict();
export const storageSchema = z.object({
  used: revisionSchema, budget: revisionSchema.min(1), warning: z.boolean(), full: z.boolean(),
  images: z.object({ owned: revisionSchema, cache: revisionSchema }).strict(),
}).strict();
/** `summary` marks a change to what conversation lists show (status, unread, title, archive, sub-agent counts); content and usage changes omit it. */
export const changeEventSchema = z.object({ type: z.literal('change'), revision: revisionSchema, conversationId: z.uuid(), deleted: z.boolean().optional(), summary: z.literal(true).optional() }).strict();
export const resetEventSchema = z.object({ type: z.literal('reset'), revision: revisionSchema }).strict();
export const readyEventSchema = z.object({ type: z.literal('ready'), revision: revisionSchema, live: liveCursorSchema }).strict();
/** Heartbeats carry the latest live sequence, so a page notices a frame it never received. */
export const heartbeatEventSchema = z.object({ live: revisionSchema }).strict();
/** A growing body: the whole value, or what was appended at offset `at` (UTF-16 code units) since the previous frame. */
export const bodyPatchSchema = z.union([
  z.object({ value: z.string().max(1_048_576) }).strict(),
  z.object({ at: revisionSchema, append: z.string().max(1_048_576) }).strict(),
]);
/** A live item without its growing bodies; `text` and the tool output travel as patches beside it. */
export const liveItemSchema = itemSchema.omit({ text: true }).extend({ tool: toolSchema.omit({ output: true }).optional() }).strict();
/** One in-flight item update. It is never stored; a page that misses one re-reads the snapshot. */
export const liveEventSchema = z.union([
  z.object({ type: z.literal('live'), sequence: revisionSchema, conversationId: z.uuid(), item: liveItemSchema, text: bodyPatchSchema, output: bodyPatchSchema.optional() }).strict(),
  /** The update was too large for one frame; the snapshot carries it. */
  z.object({ type: z.literal('live'), sequence: revisionSchema, conversationId: z.uuid(), itemId: identifierSchema, omitted: z.literal(true) }).strict(),
]);
export type WorkbenchConfiguration = z.infer<typeof workbenchConfigurationSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type AttentionView = z.infer<typeof attentionSchema>;
export type WorkbenchSnapshot = z.infer<typeof snapshotSchema>;
export type HistoryPageView = z.infer<typeof historyPageSchema>;
export type StorageView = z.infer<typeof storageSchema>;
export type WorkbenchItem = z.infer<typeof itemSchema>;
export type WorkbenchOperation = z.infer<typeof operationSchema>;
export type ChangeEvent = z.infer<typeof changeEventSchema>;
export type LiveCursor = z.infer<typeof liveCursorSchema>;
export type BodyPatch = z.infer<typeof bodyPatchSchema>;
export type LiveEvent = z.infer<typeof liveEventSchema>;
export type Collaboration = z.infer<typeof collaborationSchema>;
export type SubagentStatus = z.infer<typeof subagentStatusSchema>;
export type SubagentView = z.infer<typeof subagentSchema>;
export type SubagentList = z.infer<typeof subagentListSchema>;
export type SubagentSummary = z.infer<typeof subagentSummarySchema>;
export type TeamView = z.infer<typeof teamSchema>;

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
export const configurationSchema = z.object({ modelId: identifierSchema, permissionId: identifierSchema }).strict();
export const stateSchema = z.object({
  status: z.enum(['idle', 'running', 'waiting', 'interrupted', 'failed', 'unknown']),
  runId: identifierSchema.optional(), terminalRunId: identifierSchema.optional(),
  terminalStatus: z.enum(['completed', 'interrupted', 'failed']).optional(), pendingInputs: z.number().int().min(0).max(1_000_000),
  configurationVerified: z.boolean(), reason: boundedText(4096).optional(),
}).strict();
export const itemSchema = z.object({
  id: identifierSchema, kind: z.enum(['user', 'assistant', 'tool', 'notice']),
  text: boundedText(1_048_576), status: z.enum(['running', 'completed', 'failed']),
  runId: identifierSchema.optional(), operationId: identifierSchema.optional(),
  ...contentFields, tool: toolSchema.optional(),
}).strict();
export const conversationSchema = z.object({
  id: z.uuid(), title: boundedText(200), harnessId: z.enum(['codex', 'dsh']), workspaceId: identifierSchema,
  configuration: configurationSchema, readiness: z.enum(['preparing', 'ready', 'blocked']),
  archived: z.boolean().default(false), state: stateSchema, error: boundedText(4096).nullable(), createdAt: revisionSchema,
}).strict();
export const catalogSchema = z.object({
  id: z.enum(['codex', 'dsh']), available: z.boolean(), reason: boundedText(4096).optional(),
  models: z.array(z.object({ id: identifierSchema, label: boundedText(1024) }).strict()).max(1000),
  permissions: z.array(z.object({ id: identifierSchema, label: boundedText(1024), description: boundedText(4096) }).strict()).max(100),
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
  configuration: configurationSchema, title: boundedText(200).min(1).optional(),
}).strict();
export const conversationTitleSchema = boundedText(200).refine(title => !!title.trim() && !title.includes('\0'));
export const conversationManagementSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), title: conversationTitleSchema }).strict(),
  z.object({ action: z.literal('archive'), archived: z.boolean() }).strict(),
]);
export const conversationSearchSchema = z.object({
  workspaceId: identifierSchema.optional(), unregistered: z.literal(true).optional(),
  title: boundedText(800).max(200).optional(), archived: z.boolean().default(false),
  beforeId: z.uuid().optional(),
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
  id: z.uuid(), conversationId: z.uuid(), status: z.enum(['queued', 'dispatching', 'accepted', 'unknown', 'rejected']),
  runId: identifierSchema.nullable(), reason: boundedText(4096).nullable(), createdAt: revisionSchema, updatedAt: revisionSchema,
};
export const operationSchema = z.object({ ...operationFields, type: z.enum(['message', 'stop']), delivery: queueDeliverySchema.optional() }).strict();
export const conversationListSchema = z.object({
  conversations: z.array(conversationSchema).max(100), olderBeforeId: z.uuid().nullable(), revision: revisionSchema,
}).strict();
export const conversationResponseSchema = z.object({ conversation: conversationSchema }).strict();
export const operationResponseSchema = z.object({ operation: operationSchema }).strict();
export const turnFileLimit = 500;
const turnFilesSchema = z.object({ runId: identifierSchema, paths: z.array(recordedFilePath).max(turnFileLimit), limited: z.boolean() }).strict();
export type TurnFileSummary = z.infer<typeof turnFilesSchema>;
export const snapshotSchema = z.object({
  conversation: conversationSchema,
  history: z.object({ items: z.array(itemSchema).max(100), liveItems: z.array(itemSchema).max(100), liveItemsLimited: z.boolean(), olderBeforeItemId: identifierSchema.nullable(), hasOlder: z.boolean(), loaded: z.boolean() }).strict(),
  operations: z.array(operationSchema).max(100), queue: queueViewSchema.optional(), turnFiles: z.array(turnFilesSchema).max(200).optional(), usage: usageSchema.optional(), revision: revisionSchema,
}).strict();
export const changeEventSchema = z.object({ type: z.literal('change'), revision: revisionSchema, conversationId: z.uuid(), item: itemSchema.optional() }).strict();
export const resetEventSchema = z.object({ type: z.literal('reset'), revision: revisionSchema }).strict();
export const readyEventSchema = z.object({ type: z.literal('ready'), revision: revisionSchema }).strict();
export type WorkbenchConfiguration = z.infer<typeof workbenchConfigurationSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type WorkbenchSnapshot = z.infer<typeof snapshotSchema>;
export type WorkbenchItem = z.infer<typeof itemSchema>;
export type WorkbenchOperation = z.infer<typeof operationSchema>;
export type ChangeEvent = z.infer<typeof changeEventSchema>;

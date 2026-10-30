import { z } from 'zod';

const utf8 = new TextEncoder();
const boundedText = (bytes: number) => z.string().max(bytes).refine(value => utf8.encode(value).byteLength <= bytes);
export const identifierSchema = boundedText(1024).min(1).refine(value => !value.includes('\0'));
export const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const configurationSchema = z.object({ modelId: identifierSchema, permissionId: identifierSchema }).strict();
export const stateSchema = z.object({
  status: z.enum(['idle', 'running', 'waiting', 'interrupted', 'failed', 'unknown']),
  runId: identifierSchema.optional(), terminalRunId: identifierSchema.optional(), pendingInputs: z.number().int().min(0).max(1_000_000),
  configurationVerified: z.boolean(), reason: boundedText(4096).optional(),
}).strict();
export const itemSchema = z.object({
  id: identifierSchema, kind: z.enum(['user', 'assistant', 'tool', 'notice']),
  text: boundedText(1_048_576), status: z.enum(['running', 'completed', 'failed']),
  runId: identifierSchema.optional(), operationId: identifierSchema.optional(),
}).strict();
export const conversationSchema = z.object({
  id: z.uuid(), title: boundedText(200), harnessId: z.enum(['codex', 'dsh']), workspaceId: identifierSchema,
  configuration: configurationSchema, readiness: z.enum(['preparing', 'ready', 'blocked']),
  state: stateSchema, error: boundedText(4096).nullable(), createdAt: revisionSchema,
}).strict();
export const catalogSchema = z.object({
  id: z.enum(['codex', 'dsh']), available: z.boolean(), reason: boundedText(4096).optional(),
  models: z.array(z.object({ id: identifierSchema, label: boundedText(1024) }).strict()).max(1000),
  permissions: z.array(z.object({ id: identifierSchema, label: boundedText(1024), description: boundedText(4096) }).strict()).max(100),
}).strict();
export const workbenchConfigurationSchema = z.object({
  harnesses: z.array(catalogSchema).max(2),
  workspaces: z.array(z.object({ id: identifierSchema, label: boundedText(400) }).strict()).max(16),
}).strict();
export const createConversationSchema = z.object({
  id: z.uuid(), harnessId: z.enum(['codex', 'dsh']), workspaceId: identifierSchema,
  configuration: configurationSchema, title: boundedText(200).min(1).optional(),
}).strict();
const messagePayload = z.object({ text: boundedText(48 * 1024).max(16_000).min(1).refine(value => value.trim().length > 0) }).strict();
const stopPayload = z.object({ runId: identifierSchema }).strict();
export const enqueueOperationSchema = z.discriminatedUnion('type', [
  z.object({ id: z.uuid(), type: z.literal('message'), payload: messagePayload }).strict(),
  z.object({ id: z.uuid(), type: z.literal('stop'), payload: stopPayload }).strict(),
]);
const operationFields = {
  id: z.uuid(), conversationId: z.uuid(), status: z.enum(['queued', 'dispatching', 'accepted', 'unknown', 'rejected']),
  runId: identifierSchema.nullable(), reason: boundedText(4096).nullable(), createdAt: revisionSchema, updatedAt: revisionSchema,
};
export const operationSchema = z.object({ ...operationFields, type: z.enum(['message', 'stop']) }).strict();
export const conversationListSchema = z.object({
  conversations: z.array(conversationSchema).max(100), olderBeforeId: z.uuid().nullable(), revision: revisionSchema,
}).strict();
export const conversationResponseSchema = z.object({ conversation: conversationSchema }).strict();
export const operationResponseSchema = z.object({ operation: operationSchema }).strict();
export const snapshotSchema = z.object({
  conversation: conversationSchema,
  history: z.object({ items: z.array(itemSchema).max(100), liveItems: z.array(itemSchema).max(100), liveItemsLimited: z.boolean(), olderBeforeItemId: identifierSchema.nullable(), hasOlder: z.boolean(), loaded: z.boolean() }).strict(),
  operations: z.array(operationSchema).max(100), revision: revisionSchema,
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

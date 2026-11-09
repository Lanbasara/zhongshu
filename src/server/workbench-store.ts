import { createDeletionStore, type DeletionStore } from './conversation-deletions.ts';
import { createSubagentStore, summarizeSubagents, type SubagentStore } from './subagent-store.ts';
import { createRequestStore, type RequestStore } from './request-store.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { z } from 'zod';
import { collaborationSchema, conversationTitleSchema, identifierSchema, messagePayload, queueCommandSchema, queueDeliverySchema, queueLimit, queuePauseSchema, skillRequiresNextTurn, stateSchema, turnFileLimit, usageSchema, workspaceLimit } from '../shared/workbench.ts';
import type { ConversationUsage, QueueCommand, QueueDelivery, QueuePause, QueueView, SubagentSummary, TurnFileSummary } from '../shared/workbench.ts';
import { contentFields, inputFields, recordedFilePath, toolSchema, validSkillSpans, type InputContent } from '../shared/content.ts';
import { createResourceStore } from './resources.ts';
import { createStorageAccounting, type StorageAccounting } from './storage.ts';
import type { Binding, Configuration, HarnessId, NativeItem, NativeState, Receipt } from '../harness/types.ts';

export type Readiness = 'preparing' | 'ready' | 'blocked';
export type Conversation = {
  nativePreparationId?: string;
  id: string; harnessId: HarnessId; workspaceId: string; cwd: string; title: string;
  configuration: Configuration; binding: Binding | null; readiness: Readiness;
  archived: boolean; state: NativeState; error: string | null; createdAt: number; lastActivityAt: number;
  usage?: ConversationUsage;
  subagents?: SubagentSummary;
  /** The native automation that created this conversation (ADR 0021). */
  automationId?: string;
  /** Plan mode chosen in Zhongshu for Harnesses that take the mode per turn (Codex). */
  planMode?: true;
};
export type CreateConversation = Pick<Conversation, 'id' | 'harnessId' | 'workspaceId' | 'cwd' | 'configuration'> & { title?: string; preparationId?: string };
export type OperationStatus = 'queued' | 'dispatching' | 'accepted' | 'unknown' | 'rejected';
export type OperationInput = { id: string; conversationId: string } & (
  { type: 'message'; payload: InputContent; queuedInput?: { entryId: string; version: number; delivery: QueueDelivery } }
  | { type: 'stop'; payload: { runId: string } }
);
export type Operation = OperationInput & {
  sequence: number;
  digest: string; status: OperationStatus; runId: string | null; reason: string | null;
  createdAt: number; updatedAt: number;
};
/** `state`: the change leaves history untouched, so pages refresh only the conversation's state (ADR 0020). */
export type ChangeScope = 'state';
export type WorkbenchChange = { sequence: number; conversationId: string; itemId?: string; scope?: ChangeScope };
export type ListOperations = { conversationId?: string; status?: OperationStatus; type?: 'message' | 'stop'; order?: 'asc' | 'desc'; afterId?: string; limit?: number };
export type ConversationList = {
  beforeId?: string; limit?: number; workspaceId?: string; archived?: boolean;
  title?: string; excludeWorkspaces?: string[];
  /** Only the conversations this automation created (ADR 0021); without it, those conversations are left out. */
  automationId?: string;
};
// The cursor owns its ordering boundary, so deleting or moving the anchor does not invalidate it.
// It contains no title: the query fingerprint binds a cursor to its authorized query scope.
const conversationPageCursor = z.object({ time: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), id: z.uuid(), scope: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
function conversationScope(query: ConversationList): string {
  return createHash('sha256').update(JSON.stringify([query.workspaceId ?? null, query.archived ?? null,
    query.title ?? '', [...(query.excludeWorkspaces ?? [])].sort(), ...(query.automationId ? [query.automationId] : [])])).digest('hex');
}
export function conversationCursor(conversation: Conversation, query: ConversationList = {}): string {
  return Buffer.from(JSON.stringify({ time: conversation.lastActivityAt, id: conversation.id, scope: conversationScope(query) })).toString('base64url');
}
type StoredQueue = Omit<QueueView, 'mode'> & { afterRunId: string | null };
export interface WorkbenchStore {
  deletions: DeletionStore;
  subagents: SubagentStore;
  requests: RequestStore;
  resources: ReturnType<typeof createResourceStore>;
  reservePreparation(workspaceId: string, cwd: string, id: string, expectedId?: string): { preparationId: string; nativeId: string };
  completePreparation(id: string): void;
  createConversation(input: CreateConversation): { conversation: Conversation; created: boolean };
  /**
   * Record a native session an automation created as a ready conversation (ADR 0021). It runs with the configuration
   * the Harness gave it; the native identity is its binding, and repeating the same adoption returns the same row.
   */
  adoptConversation(input: { id: string; harnessId: HarnessId; workspaceId: string; cwd: string; title: string; configuration: Configuration; binding: Binding; automationId: string }): Conversation;
  /** The conversation bound to a native session, if Zhongshu knows it. */
  conversationForNative(harnessId: HarnessId, nativeId: string): Conversation | null;
  /** Automations that own at least one adopted conversation. */
  automationOwners(): string[];
  /** The automation is gone: its conversations become ordinary ones, so the results stay in the sidebar. */
  releaseAutomation(automationId: string): void;
  getConversation(id: string): Conversation | null;
  listConversations(options?: ConversationList): Conversation[];
  recentAcceptedConversation(workspaces: { id: string; directory: string }[], harnessIds: HarnessId[]): Conversation | null;
  renameConversation(id: string, title: string): Conversation;
  /** Record the Plan choice of a per-turn Harness conversation; a change emits a conversation change. */
  setPlanMode(id: string, active: boolean): Conversation;
  setArchived(id: string, archived: boolean, canArchive: (conversation: Conversation) => boolean): Conversation;
  saveBinding(id: string, binding: Binding): Conversation;
  setConversationState(id: string, change: { readiness?: Readiness; state?: NativeState; error?: string | null }): Conversation;
  setUsage(id: string, value: ConversationUsage): void;
  enqueueOperation(input: OperationInput): { operation: Operation; created: boolean };
  getOperation(id: string): Operation | null;
  listOperations(options?: ListOperations): Operation[];
  claimOperation(id: string): Operation | null;
  settleOperation(id: string, receipt: Receipt): Operation;
  recoverDispatching(): number;
  readQueue(id: string): StoredQueue;
  queuedConversations(after: string): string[];
  recoverableConversations(after: string): string[];
  queueAdmissionExists(id: string, entryId: string, content: InputContent): boolean;
  changeQueue(id: string, command: Exclude<QueueCommand, { action: 'send' }>): void;
  claimQueue(id: string, entryId: string, version: number, operationId: string, delivery: QueueDelivery): Operation;
  pauseQueue(id: string, reason: QueuePause): void;
  changes(after: number, limit?: number): { events: WorkbenchChange[]; latest: number; reset: boolean };
  version(): number;
  /** Record a change hint (optionally naming a live item) without persisting any history body (ADR 0014). */
  touch(conversationId: string, itemId?: string, scope?: ChangeScope): void;
  /**
   * Record what the native latest page looks like now; announces a change only when it differs from the last
   * recorded mark, so reading unchanged history is never a change (ADR 0019). Returns whether it announced.
   */
  markNative(conversationId: string, mark: string): boolean;
  /** Keep the per-turn edited-path index; paths only, never message bodies. */
  recordTurnFiles(conversationId: string, items: NativeItem[]): void;
  storage: StorageAccounting;
  readTurnFiles(conversationId: string, runIds: readonly string[]): TurnFileSummary[];
  /** Record the current result as seen; emits a change hint only when an unseen result became seen. */
  markSeen(id: string): boolean;
  /** The ids among `ids` whose current result differs from what a reader last saw. */
  unseen(ids: readonly string[]): Set<string>;
  /** Non-archived conversations needing a look, and the uncapped unseen count; `reading` ids count as seen now. */
  attention(reading: readonly string[], limit: number): { unseen: number; conversations: { conversation: Conversation; unseen: boolean }[] };
}

export class StoreError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode = 500) { super(code); this.name = 'StoreError'; this.code = code; this.statusCode = statusCode; }
}

const MAX_TEXT_BYTES = 1_048_576;
const boundedText = (bytes: number) => z.string().max(bytes).refine(value => Buffer.byteLength(value, 'utf8') <= bytes);
const identifier = boundedText(1024).min(1).refine(value => !value.includes('\0'));
const uuid = z.uuid();
const nativeMark = z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/);
const configurationSchema = z.object({ modelId: identifier, permissionId: identifier, reasoningEffort: identifier.optional(), agentPreset: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional() }).strict();
const nativeStateSchema = stateSchema;
const itemSchema = z.object({
  id: identifier, kind: z.enum(['user', 'assistant', 'tool', 'notice']), text: boundedText(MAX_TEXT_BYTES),
  status: z.enum(['running', 'completed', 'failed', 'unknown']), runId: identifier.optional(), operationId: identifier.optional(),
  ...contentFields, tool: toolSchema.optional(), collaboration: collaborationSchema.optional(), plan: z.literal(true).optional(),
}).strict();
const turnFileItemSchema = z.object({ kind: z.literal('tool'), status: z.literal('completed'), runId: identifier, fileEdits: z.array(recordedFilePath).min(1).max(400) }).strict();
const nativeItemSchema = itemSchema.extend({ fileEdits: z.array(recordedFilePath).max(400).optional() });
const bindingSchema = z.object({
  id: identifier, cwd: boundedText(4096).min(1), configuration: configurationSchema, details: z.record(z.string(), z.unknown()),
}).strict();
const createConversationSchema = z.object({
  id: uuid, harnessId: z.enum(['codex', 'dsh']), workspaceId: identifier, cwd: boundedText(4096).min(1),
  configuration: configurationSchema, title: boundedText(200).min(1).optional(), preparationId: uuid.optional(),
}).strict();
const operationInputSchema = z.discriminatedUnion('type', [
  z.object({ id: uuid, conversationId: uuid, type: z.literal('message'), payload: z.object({ text: boundedText(MAX_TEXT_BYTES), ...inputFields }).strict().refine(v => v.text.trim() || v.images?.length || v.references?.length).refine(validSkillSpans),
    queuedInput: z.object({ entryId: uuid, version: z.number().int().nonnegative(), delivery: queueDeliverySchema }).strict().optional() }).strict(),
  z.object({ id: uuid, conversationId: uuid, type: z.literal('stop'), payload: z.object({ runId: identifier }).strict() }).strict(),
]);
const statusSchema = z.enum(['queued', 'dispatching', 'accepted', 'unknown', 'rejected']);
const receiptSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('accepted'), runId: identifier.optional() }).strict(),
  z.object({ outcome: z.literal('unknown'), reason: boundedText(4096).min(1) }).strict(),
  z.object({ outcome: z.literal('rejected'), reason: boundedText(4096).min(1) }).strict(),
]);

/**
 * The result a reader has yet to see, as one SQL definition over a conversation row aliased `c`.
 * NULL when archived, preparing, running or waiting, without a terminal result, or for an interruption
 * caused by a user stop that reached the Harness (dispatching, accepted or unknown receipt).
 */
const ATTENTION_KEY = `(CASE
  WHEN c.archived = 1 OR c.readiness = 'preparing' OR json_extract(c.state_json,'$.status') IN ('running','waiting') THEN NULL
  WHEN json_extract(c.state_json,'$.status') = 'unknown'
    THEN 'unknown:' || COALESCE(json_extract(c.state_json,'$.runId'), json_extract(c.state_json,'$.terminalRunId'), '')
  WHEN json_extract(c.state_json,'$.terminalStatus') = 'interrupted' AND EXISTS (SELECT 1 FROM workbench_operations o
    WHERE o.conversation_id = c.id AND o.type = 'stop' AND o.status IN ('dispatching','accepted','unknown')
      AND json_extract(o.payload_json,'$.runId') = json_extract(c.state_json,'$.terminalRunId')) THEN NULL
  WHEN json_extract(c.state_json,'$.latest.status') = 'interrupted' AND EXISTS (SELECT 1 FROM workbench_operations o
    WHERE o.conversation_id = c.id AND o.type = 'stop' AND o.status IN ('dispatching','accepted','unknown')
      AND json_extract(o.payload_json,'$.runId') = json_extract(c.state_json,'$.latest.runId')) THEN NULL
  -- ADR 0021: a later run Zhongshu did not start (an automation delivery) is the newest result.
  ELSE COALESCE(json_extract(c.state_json,'$.latest.status') || ':' || json_extract(c.state_json,'$.latest.runId'),
    json_extract(c.state_json,'$.terminalStatus') || ':' || json_extract(c.state_json,'$.terminalRunId'))
END)`;
const ATTENTION_ROWS = `SELECT c.id, c.last_activity_at, json_extract(c.state_json,'$.status') AS status,
  c.seen_key, c.seen_result_key, ${ATTENTION_KEY} AS attention_key FROM workbench_conversations c`;
const UNSEEN = 'attention_key IS NOT NULL AND attention_key IS NOT seen_key AND attention_key IS NOT seen_result_key';
/** Attention buckets: running, waiting, failed, unknown, then unseen results. */
const ATTENTION_BUCKET = "CASE status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 WHEN 'failed' THEN 2 WHEN 'unknown' THEN 3 ELSE 4 END";

type Row = Record<string, string | number | bigint | Uint8Array | null>;
type PositionedId = { id: string; position: number };
function parse<T>(schema: z.ZodType<T>, input: unknown, code = 'invalid_workbench_input'): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new StoreError(code, 400);
  return parsed.data;
}
function parseJson<T>(schema: z.ZodType<T>, json: unknown): T {
  if (typeof json !== 'string') throw new StoreError('corrupt_workbench_data');
  try { return parse(schema, JSON.parse(json), 'corrupt_workbench_data'); }
  catch { throw new StoreError('corrupt_workbench_data'); }
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function storage<T>(action: () => T): T {
  try { return action(); }
  catch (error) { throw error instanceof StoreError ? error : new StoreError('workbench_storage_failed'); }
}
function transaction<T>(db: DatabaseSync, action: () => T, mode: 'read' | 'write' = 'write'): T {
  return storage(() => {
    db.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try { const value = action(); db.exec('COMMIT'); return value; }
    catch (error) { try { db.exec('ROLLBACK'); } catch { /* original failure remains authoritative */ } throw error; }
  });
}
/** The adapter owns details, but persistence accepts only bounded JSON (no credentials). */
function bindingJson(value: Binding): string {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 16) throw new StoreError('invalid_binding_details', 400);
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      for (const child of Object.values(item)) visit(child, depth + 1);
      return;
    }
    throw new StoreError('invalid_binding_details', 400);
  };
  visit(value.details, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 65_536) throw new StoreError('binding_too_large', 413);
  return json;
}
function conversationFromRow(row: Row): Conversation {
  return {
    ...(row.native_preparation_id == null ? {} : { nativePreparationId: String(row.native_preparation_id) }),
    id: String(row.id), harnessId: parse(z.enum(['codex', 'dsh']), row.harness_id, 'corrupt_workbench_data'),
    workspaceId: String(row.workspace_id), cwd: String(row.cwd), title: String(row.title), archived: row.archived === 1,
    configuration: parseJson(configurationSchema, row.configuration_json), binding: row.binding_json === null ? null : parseJson(bindingSchema, row.binding_json),
    readiness: parse(z.enum(['preparing', 'ready', 'blocked']), row.readiness, 'corrupt_workbench_data'),
    state: parseJson(nativeStateSchema, row.state_json), error: row.error === null ? null : String(row.error), createdAt: Number(row.created_at), lastActivityAt: Number(row.last_activity_at ?? row.created_at),
    ...(row.usage_json == null ? {} : { usage: parseJson(usageSchema, row.usage_json) }),
    ...(summarizeSubagents(row.subagents_json) ? { subagents: summarizeSubagents(row.subagents_json)! } : {}),
    ...(row.plan_mode === 1 ? { planMode: true as const } : {}),
    ...(row.automation_id == null ? {} : { automationId: String(row.automation_id) }),
  };
}
/** Plan mode as lists and headers show it: Zhongshu's choice for per-turn Harnesses, the native state otherwise. */
export function planView(conversation: Conversation, mode: 'per-turn' | 'native' | undefined): { active: boolean; pending?: boolean } | undefined {
  if (mode === 'per-turn') return { active: !!conversation.planMode };
  if (mode === 'native' && conversation.state.plan) return { active: conversation.state.plan.active, ...(conversation.state.plan.pending ? { pending: true } : {}) };
  return undefined;
}
function operationFromRow(row: Row): Operation {
  const payload = parseJson(z.unknown(), row.payload_json);
  const stored = z.object({ queueRecord: z.literal(true), content: z.unknown(), queuedInput: z.unknown() }).strict().safeParse(payload);
  const input = parse(operationInputSchema, { id: row.id, conversationId: row.conversation_id, type: row.type,
    ...(stored.success ? { payload: stored.data.content, queuedInput: stored.data.queuedInput } : { payload }) }, 'corrupt_workbench_data');
  return { ...input, sequence: Number(row.sequence), digest: String(row.digest), status: parse(statusSchema, row.status, 'corrupt_workbench_data'),
    runId: row.run_id === null ? null : String(row.run_id), reason: row.reason === null ? null : String(row.reason),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

/** Local durable facts; this module never calls a native Harness or retries an operation. */
export function createWorkbenchStore(db: DatabaseSync, options: { now?: () => number; onChange?: (event: WorkbenchChange) => void; storageBudget?: number } = {}): WorkbenchStore {
  const now = options.now ?? Date.now;
  const version = (): number => Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS version FROM workbench_changes').get()!.version);
  const mutate = <T>(action: (changed: (conversationId: string, itemId?: string, scope?: ChangeScope) => void) => T): T => {
    const events: WorkbenchChange[] = [];
    const value = transaction(db, () => {
      const changed = new Map<string, { itemId?: string; scope?: ChangeScope }>();
      const result = action((id, itemId, scope) => {
        const previous = changed.get(id);
        if (!previous) { changed.set(id, { itemId, scope }); return; }
        // Several changes in one transaction: a differing item names none, and any change that may touch history wins.
        changed.set(id, { itemId: previous.itemId === itemId ? itemId : undefined, scope: previous.scope === 'state' && scope === 'state' ? 'state' : undefined });
      });
      const insert = db.prepare('INSERT INTO workbench_changes(conversation_id,item_id,scope,created_at) VALUES(?,?,?,?)');
      for (const [conversationId, { itemId, scope }] of changed) {
        const row = insert.run(conversationId, itemId ?? null, scope ?? null, now());
        events.push({ sequence: Number(row.lastInsertRowid), conversationId, ...(itemId === undefined ? {} : { itemId }), ...(scope ? { scope } : {}) });
      }
      if (changed.size) db.exec('DELETE FROM workbench_changes WHERE sequence <= (SELECT sequence FROM workbench_changes ORDER BY sequence DESC LIMIT 1 OFFSET 2000)');
      return result;
    });
    for (const event of events) { try { options.onChange?.(event); } catch { /* hints are recoverable through the durable cursor; never undo a committed result */ } }
    return value;
  };
  const conversationRow = (id: string) => db.prepare('SELECT * FROM workbench_conversations WHERE id = ?').get(id);
  const removedWorkspace = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='workbench_workspaces'").get() ?
    db.prepare('SELECT 1 FROM workbench_workspaces WHERE id=? AND removed=1') : undefined;
  const assertWorkspaceActive = (id: string) => {
    if (removedWorkspace?.get(id)) throw new StoreError('workspace_removed', 409);
  };
  const requireConversation = (id: string): Conversation => {
    const row = conversationRow(id); if (!row) throw new StoreError('conversation_not_found', 404); return conversationFromRow(row);
  };
  const operationRow = (id: string) => db.prepare('SELECT * FROM workbench_operations WHERE id = ?').get(id);
  const requireOperation = (id: string): Operation => {
    const row = operationRow(id); if (!row) throw new StoreError('operation_not_found', 404); return operationFromRow(row);
  };
  let insertTurnFile: StatementSync | undefined;
  let countTurnFiles: StatementSync | undefined;
  let selectTurnFiles: StatementSync | undefined;
  function recordTurnFiles(conversationId: string, item: NativeItem): boolean {
    if (item.kind !== 'tool' || item.status !== 'completed' || !item.runId || !item.fileEdits?.length) return false;
    insertTurnFile ??= db.prepare('INSERT OR IGNORE INTO workbench_turn_files(conversation_id,run_id,path) VALUES(?,?,?)');
    countTurnFiles ??= db.prepare('SELECT COUNT(*) AS count FROM workbench_turn_files WHERE conversation_id=? AND run_id=?');
    // Keep one extra distinct target to signal truncation, without growing the per-turn index further.
    let count = Number(countTurnFiles.get(conversationId, item.runId)!.count);
    const before = count;
    for (const path of item.fileEdits) {
      if (count > turnFileLimit) break;
      count += Number(insertTurnFile.run(conversationId, item.runId, path).changes);
    }
    return count !== before;
  }
  const accounting = createStorageAccounting(db, options.storageBudget);
  const resources = createResourceStore(db, accounting);
  const queueRow = (id: string) => db.prepare('SELECT * FROM workbench_queues WHERE conversation_id=?').get(id);
  const hasQueue = (id: string) => !!db.prepare('SELECT 1 FROM workbench_queue_entries WHERE conversation_id=? AND content_json IS NOT NULL LIMIT 1').get(id);
  const bumpQueue = (id: string) => db.prepare('UPDATE workbench_queues SET version=version+1 WHERE conversation_id=?').run(id);
  const setPause = (id: string, reason: QueuePause) => db.prepare('UPDATE workbench_queues SET pause=?,version=version+1 WHERE conversation_id=? AND pause IS NOT ?').run(reason, id, reason).changes;
  const unsettledOperation = (id: string) => db.prepare(
    "SELECT 1 FROM workbench_operations WHERE conversation_id=? AND (status IN ('queued','dispatching','unknown') OR (type='message' AND status='accepted' AND run_id IS NULL)) LIMIT 1",
  ).get(id);
  const existingAdmission = (id: string, entryId: string, content: InputContent) => {
    const row = db.prepare('SELECT admission_digest FROM workbench_queue_entries WHERE id=?').get(entryId);
    if (!row) return false;
    if (row.admission_digest !== digest([id, content])) throw new StoreError('operation_id_conflict', 409);
    return true;
  };
  const clearQueuePins = (entryId: string) => db.prepare('DELETE FROM workbench_resource_refs WHERE owner_id=?').run('queue:' + entryId);
  const setQueuePins = (id: string, entryId: string, content: InputContent) => {
    clearQueuePins(entryId);
    for (const image of content.images ?? []) resources.pin(id, image.id, 'queue:' + entryId);
  };
  const checkQueueConversation = (id: string) => {
    const conversation = requireConversation(id);
    assertWorkspaceActive(conversation.workspaceId);
    if (conversation.archived) throw new StoreError('conversation_archived', 409);
    return conversation;
  };
  const mutableEntry = (id: string, entryId: string, version: number) => {
    const row = db.prepare('SELECT * FROM workbench_queue_entries WHERE conversation_id=? AND id=?').get(id, entryId);
    if (!row || row.content_json === null || row.operation_id !== null || row.version !== version)
      throw new StoreError('queue_entry_changed', 409);
    return row;
  };
  const store: WorkbenchStore = {
    deletions: createDeletionStore(db, event => options.onChange?.(event), now),
    subagents: createSubagentStore(db, event => options.onChange?.(event), now),
    requests: createRequestStore(db, event => options.onChange?.(event), now),
    resources,
    reservePreparation(workspaceId, cwd, id, expectedId) {
      parse(identifier, workspaceId); parse(boundedText(4096).min(1), cwd); parse(uuid, id); if (expectedId) parse(uuid, expectedId);
      return transaction(db, () => {
        assertWorkspaceActive(workspaceId);
        const row = db.prepare('SELECT * FROM workbench_draft_preparations WHERE workspace_id=?').get(workspaceId);
        if (row && row.cwd !== cwd) throw new StoreError('draft_preparation_workspace_changed', 409);
        if (expectedId && (!row || row.preparation_id !== expectedId || row.claimed_by !== null)) throw new StoreError('draft_preparation_claimed', 409);
        if (row && row.claimed_by === null) return { preparationId: String(row.preparation_id), nativeId: String(row.native_id) };
        if (!row && Number(db.prepare('SELECT COUNT(*) AS count FROM workbench_draft_preparations').get()!.count) >= workspaceLimit)
          throw new StoreError('draft_preparation_capacity_reached', 409);
        const nativeId = randomUUID();
        db.prepare('INSERT INTO workbench_draft_preparations(workspace_id,cwd,preparation_id,native_id,claimed_by) VALUES(?,?,?,?,NULL) ON CONFLICT(workspace_id) DO UPDATE SET preparation_id=excluded.preparation_id,native_id=excluded.native_id,claimed_by=NULL').run(workspaceId,cwd,id,nativeId);
        return { preparationId: id, nativeId };
      });
    },
    completePreparation(id) { parse(uuid,id); storage(() => db.prepare('UPDATE workbench_conversations SET native_preparation_id=NULL WHERE id=?').run(id)); },
    createConversation(value) {
      const input = parse(createConversationSchema, value);
      const creationDigest = digest([input.harnessId, input.workspaceId, input.cwd, input.configuration.modelId, input.configuration.permissionId,
        ...(input.configuration.reasoningEffort === undefined ? [] : [input.configuration.reasoningEffort]), ...(input.preparationId ? ['prepared', input.preparationId] : []),
        // Appended only when chosen, so digests of conversations created before presets stay the same (ADR 0017).
        ...(input.configuration.agentPreset === undefined ? [] : ['preset', input.configuration.agentPreset])]);
      return mutate(changed => {
        if (db.prepare('SELECT 1 FROM workbench_deletions WHERE id=?').get(input.id)) throw new StoreError('conversation_deleted', 409);
        const existing = conversationRow(input.id);
        if (existing) {
          if (existing.creation_digest !== creationDigest) throw new StoreError('conversation_id_conflict', 409);
          return { conversation: conversationFromRow(existing), created: false };
        }
        assertWorkspaceActive(input.workspaceId);
        const count = Number(db.prepare('SELECT COUNT(*) AS count FROM workbench_conversations').get()!.count);
        if (count >= 10_000) throw new StoreError('conversation_capacity_reached', 409);
        let nativePreparationId: string | undefined;
        if (input.preparationId) {
          const row = db.prepare('SELECT * FROM workbench_draft_preparations WHERE workspace_id=?').get(input.workspaceId);
          if (input.harnessId !== 'dsh' || !row || row.cwd !== input.cwd || row.preparation_id !== input.preparationId || row.claimed_by !== null)
            throw new StoreError('draft_preparation_claimed', 409);
          nativePreparationId = String(row.native_id);
          db.prepare('UPDATE workbench_draft_preparations SET claimed_by=? WHERE workspace_id=?').run(input.id,input.workspaceId);
        }
        const initial: NativeState = { status: 'unknown', pendingInputs: 0, configurationVerified: false };
        db.prepare(`INSERT INTO workbench_conversations(id,harness_id,workspace_id,cwd,title,configuration_json,creation_digest,
          readiness,state_json,created_at) VALUES(?,?,?,?,?,?,?,'preparing',?,?)`).run(input.id, input.harnessId, input.workspaceId,
          input.cwd, input.title ?? '新对话', JSON.stringify(input.configuration), creationDigest, JSON.stringify(initial), now());
        db.prepare('UPDATE workbench_conversations SET last_activity_at=created_at WHERE id=?').run(input.id);
        if (nativePreparationId) db.prepare('UPDATE workbench_conversations SET native_preparation_id=? WHERE id=?').run(nativePreparationId,input.id);
        changed(input.id);
        return { conversation: requireConversation(input.id), created: true };
      });
    },
    getConversation(id) { parse(uuid, id); return storage(() => { const row = conversationRow(id); return row ? conversationFromRow(row) : null; }); },
    automationOwners() {
      return (db.prepare('SELECT DISTINCT automation_id FROM workbench_conversations WHERE automation_id IS NOT NULL LIMIT 10000').all() as { automation_id: string }[]).map(row => row.automation_id);
    },
    releaseAutomation(automationId) {
      parse(z.string().min(1).max(240), automationId);
      mutate(changed => {
        const rows = db.prepare('SELECT id FROM workbench_conversations WHERE automation_id=?').all(automationId) as { id: string }[];
        db.prepare('UPDATE workbench_conversations SET automation_id=NULL WHERE automation_id=?').run(automationId);
        for (const row of rows) changed(row.id);
      });
    },
    adoptConversation(value) {
      const input = parse(createConversationSchema.omit({ preparationId: true }).extend({ title: boundedText(200).min(1), binding: bindingSchema, automationId: z.string().min(1).max(240) }).strict(), value);
      return mutate(changed => {
        const known = db.prepare("SELECT id FROM workbench_conversations WHERE harness_id=? AND json_extract(binding_json,'$.id')=?").get(input.harnessId, input.binding.id);
        if (known) return requireConversation(String(known.id));
        assertWorkspaceActive(input.workspaceId);
        const count = Number(db.prepare('SELECT COUNT(*) AS count FROM workbench_conversations').get()!.count);
        if (count >= 10_000) throw new StoreError('conversation_capacity_reached', 409);
        const creationDigest = digest([input.harnessId, input.workspaceId, input.cwd, 'automation', input.automationId, input.binding.id]);
        const initial: NativeState = { status: 'unknown', pendingInputs: 0, configurationVerified: false };
        db.prepare(`INSERT INTO workbench_conversations(id,harness_id,workspace_id,cwd,title,configuration_json,creation_digest,binding_json,
          readiness,state_json,created_at,automation_id) VALUES(?,?,?,?,?,?,?,?,'ready',?,?,?)`).run(input.id, input.harnessId, input.workspaceId, input.cwd,
          input.title, JSON.stringify(input.configuration), creationDigest, JSON.stringify(input.binding), JSON.stringify(initial), now(), input.automationId);
        db.prepare('UPDATE workbench_conversations SET last_activity_at=created_at WHERE id=?').run(input.id);
        changed(input.id);
        return requireConversation(input.id);
      });
    },
    conversationForNative(harnessId, nativeId) {
      parse(z.enum(['codex', 'dsh']), harnessId); parse(z.string().min(1).max(240), nativeId);
      return storage(() => {
        const row = db.prepare("SELECT * FROM workbench_conversations WHERE harness_id=? AND json_extract(binding_json,'$.id')=? LIMIT 1").get(harnessId, nativeId);
        return row ? conversationFromRow(row) : null;
      });
    },
    recentAcceptedConversation(workspaces, harnessIds) {
      const eligible = parse(z.array(z.object({ id: identifier, directory: boundedText(4096).min(1) }).strict()).max(workspaceLimit), workspaces);
      const harnesses = parse(z.array(z.enum(['codex', 'dsh'])).max(2), harnessIds);
      return storage(() => {
        const row = db.prepare(`SELECT c.* FROM workbench_conversations c
          JOIN workbench_operations o ON o.conversation_id = c.id
          WHERE c.archived = 0 AND o.type = 'message' AND o.status = 'accepted'
            AND c.harness_id IN (SELECT value FROM json_each(?))
            AND EXISTS (SELECT 1 FROM json_each(?) w
              WHERE json_extract(w.value, '$.id') = c.workspace_id
                AND json_extract(w.value, '$.directory') = c.cwd)
          ORDER BY o.created_at DESC, o.sequence DESC LIMIT 1`).get(JSON.stringify(harnesses), JSON.stringify(eligible));
        return row ? conversationFromRow(row) : null;
      });
    },
    listConversations(value = {}) {
      const input = parse(z.object({
        beforeId: z.string().min(1).max(512).optional(), limit: z.number().int().min(1).max(1000).default(100),
        workspaceId: identifierSchema.optional(), archived: z.boolean().optional(),
        title: z.string().max(200).optional(), excludeWorkspaces: z.array(identifierSchema).max(workspaceLimit).optional(),
        automationId: z.string().min(1).max(240).optional(),
      }).strict(), value);
      return storage(() => {
        let cursor: readonly [number | bigint, string] = [9223372036854775807n, ''];
        if (input.beforeId) {
          if (uuid.safeParse(input.beforeId).success) {
            // Compatibility for a page opened before an application upgrade.
            const before = requireConversation(input.beforeId);
            cursor = [before.lastActivityAt, before.id];
          } else {
            let raw: unknown;
            try { raw = JSON.parse(Buffer.from(input.beforeId, 'base64url').toString('utf8')); }
            catch { throw new StoreError('invalid_conversation_cursor', 400); }
            const before = parse(conversationPageCursor, raw, 'invalid_conversation_cursor');
            if (before.scope !== conversationScope(input)) throw new StoreError('conversation_cursor_scope_changed', 400);
            cursor = [before.time, before.id];
          }
        }
        const title = input.title ?? '';
        const exclusions = JSON.stringify(input.excludeWorkspaces ?? []);
        const automation = input.automationId ?? null;
        const rows = input.workspaceId !== undefined && input.archived !== undefined
          ? db.prepare(`
              SELECT * FROM workbench_conversations
              WHERE workspace_id = ? AND archived = ? AND (last_activity_at,id) < (?,?)
                AND workspace_id NOT IN (SELECT value FROM json_each(?))
                AND instr(lower(title), lower(?)) > 0
                AND (? IS NULL OR automation_id = ?)
              ORDER BY last_activity_at DESC,id DESC LIMIT ?
            `).all(input.workspaceId, Number(input.archived), ...cursor, exclusions, title, automation, automation, input.limit)
          : input.archived !== undefined && input.workspaceId === undefined
            ? db.prepare(`
                SELECT * FROM workbench_conversations
                WHERE archived = ? AND (last_activity_at,id) < (?,?)
                  AND workspace_id NOT IN (SELECT value FROM json_each(?))
                  AND instr(lower(title), lower(?)) > 0
                  AND (? IS NULL OR automation_id = ?)
                ORDER BY last_activity_at DESC,id DESC LIMIT ?
              `).all(Number(input.archived), ...cursor, exclusions, title, automation, automation, input.limit)
            : db.prepare(`
                SELECT * FROM workbench_conversations
                WHERE (last_activity_at,id) < (?,?) AND (? IS NULL OR workspace_id = ?)
                  AND workspace_id NOT IN (SELECT value FROM json_each(?))
                  AND instr(lower(title), lower(?)) > 0
                  AND (? IS NULL OR automation_id = ?)
                ORDER BY last_activity_at DESC,id DESC LIMIT ?
              `).all(...cursor, input.workspaceId ?? null, input.workspaceId ?? null, exclusions, title, automation, automation, input.limit);
        return rows.map(conversationFromRow);
      });
    },
    renameConversation(id, value) {
      parse(uuid, id);
      const title = parse(conversationTitleSchema, value).trim();
      return mutate(changed => {
        const current = requireConversation(id);
        if (current.title === title) return current;
        db.prepare('UPDATE workbench_conversations SET title=? WHERE id=?').run(title, id);
        changed(id, undefined, 'state');
        return requireConversation(id);
      });
    },
    setPlanMode(id, active) {
      parse(uuid, id); parse(z.boolean(), active);
      return mutate(changed => {
        const current = requireConversation(id);
        if (!!current.planMode === active) return current;
        db.prepare('UPDATE workbench_conversations SET plan_mode=? WHERE id=?').run(active ? 1 : 0, id);
        changed(id, undefined, 'state');
        return requireConversation(id);
      });
    },
    setArchived(id, archived, canArchive) {
      parse(uuid, id);
      parse(z.boolean(), archived);
      return mutate(changed => {
        const current = requireConversation(id);
        if (current.archived === archived) return current;
        if (archived && !canArchive(current)) throw new StoreError('conversation_archive_busy', 409);
        db.prepare('UPDATE workbench_conversations SET archived=? WHERE id=?').run(Number(archived), id);
        changed(id, undefined, 'state');
        return requireConversation(id);
      });
    },
    saveBinding(id, value) {
      parse(uuid, id); const binding = parse(bindingSchema, value); const json = bindingJson(binding);
      return mutate(changed => {
        const conversation = requireConversation(id);
        if (binding.cwd !== conversation.cwd || binding.configuration.modelId !== conversation.configuration.modelId || binding.configuration.permissionId !== conversation.configuration.permissionId || binding.configuration.reasoningEffort !== conversation.configuration.reasoningEffort
          || binding.configuration.agentPreset !== conversation.configuration.agentPreset)
          throw new StoreError('binding_configuration_conflict', 409);
        if (conversation.binding && conversation.binding.id !== binding.id) throw new StoreError('native_binding_conflict', 409);
        if (conversation.binding && bindingJson(conversation.binding) === json) return conversation;
        db.prepare('UPDATE workbench_conversations SET binding_json = ? WHERE id = ?').run(json, id);
        changed(id);
        return requireConversation(id);
      });
    },
    setConversationState(id, value) {
      parse(uuid, id);
      const change = parse(z.object({ readiness: z.enum(['preparing', 'ready', 'blocked']).optional(), state: nativeStateSchema.optional(), error: boundedText(4096).nullable().optional() }).strict(), value);
      return mutate(changed => {
        const conversation = requireConversation(id);
        if (change.readiness === 'ready' && !conversation.binding) throw new StoreError('native_binding_required', 409);
        const readiness = change.readiness ?? conversation.readiness;
        const state = change.state ?? conversation.state;
        const error = change.error === undefined ? conversation.error : change.error;
        if (readiness === conversation.readiness && JSON.stringify(state) === JSON.stringify(conversation.state) && error === conversation.error) return conversation;
        db.prepare('UPDATE workbench_conversations SET readiness=?,state_json=?,error=? WHERE id=?').run(readiness, JSON.stringify(state), error, id);
        // A native run Zhongshu did not start, such as an automation delivery, is new activity: the conversation moves up
        // the list like one the user just wrote in (ADR 0021, 2026-11-09). Runs Zhongshu starts were counted on acceptance.
        if (state.runId && state.runId !== conversation.state.runId) {
          db.prepare('UPDATE workbench_conversations SET last_activity_at=MAX(last_activity_at,?) WHERE id=?').run(now(), id);
        }
        changed(id, undefined, 'state');
        return requireConversation(id);
      });
    },
    setUsage(id, value) {
      parse(uuid, id);
      const incoming = parse(usageSchema, value);
      mutate(changed => {
        const current = requireConversation(id).usage;
        if (current?.total !== undefined && incoming.total !== undefined && incoming.total < current.total) return;
        const usage = { total: incoming.total ?? current?.total, context: incoming.context };
        const json = JSON.stringify(usage);
        if (json === JSON.stringify(current)) return;
        db.prepare('UPDATE workbench_conversations SET usage_json=? WHERE id=?').run(json, id);
        changed(id, undefined, 'state');
      });
    },
    enqueueOperation(value) {
      const input = parse(operationInputSchema, value);
      if (input.type === 'message' && input.queuedInput) throw new StoreError('invalid_workbench_input', 400);
      const contentDigest = digest([input.conversationId, input.type, input.type === 'message' ? input.payload.text : input.payload.runId,
        ...(input.type === 'message' && input.payload.skills?.length ? [input.payload.skills] : [])]);
      return mutate(changed => {
        const existing = operationRow(input.id);
        if (existing) {
          if (existing.digest !== contentDigest) throw new StoreError('operation_id_conflict', 409);
          return { operation: operationFromRow(existing), created: false };
        }
        const conversation = requireConversation(input.conversationId);
        assertWorkspaceActive(conversation.workspaceId);
        if (conversation.archived) throw new StoreError('conversation_archived', 409);
        const count = Number(db.prepare('SELECT COUNT(*) AS count FROM workbench_operations WHERE conversation_id=?').get(input.conversationId)!.count);
        if (count >= 50_000) throw new StoreError('operation_capacity_reached', 409);
        if (input.type === 'message') for (const image of input.payload.images ?? []) resources.pin(input.conversationId, image.id, input.id);
        const at = now();
        db.prepare(`INSERT INTO workbench_operations(id,conversation_id,type,payload_json,digest,status,created_at,updated_at)
          VALUES(?,?,?,?,?,'queued',?,?)`).run(input.id, input.conversationId, input.type, JSON.stringify(input.payload), contentDigest, at, at);
        if (input.type === 'stop' && hasQueue(input.conversationId)) setPause(input.conversationId, 'stopped');
        changed(input.conversationId, undefined, 'state');
        return { operation: requireOperation(input.id), created: true };
      });
    },
    getOperation(id) { parse(uuid, id); return storage(() => { const row = operationRow(id); return row ? operationFromRow(row) : null; }); },
    listOperations(value = {}) {
      const input = parse(z.object({ conversationId: uuid.optional(), status: statusSchema.optional(), type: z.enum(['message', 'stop']).optional(),
        order: z.enum(['asc', 'desc']).default('asc'), afterId: uuid.optional(), limit: z.number().int().min(1).max(1000).default(100) }).strict(), value);
      return storage(() => {
        const after = input.afterId ? requireOperation(input.afterId) : null;
        const descending = input.order === 'desc';
        const sequence = after?.sequence ?? (descending ? Number.MAX_SAFE_INTEGER : 0);
        const type = input.type ?? null;
        // Sort direction selects a fixed SQL branch; neither clauses nor values are interpolated.
        const rows = descending
          ? input.conversationId && input.status
            ? db.prepare('SELECT * FROM workbench_operations WHERE conversation_id=? AND status=? AND (? IS NULL OR type=?) AND sequence<? ORDER BY sequence DESC LIMIT ?').all(input.conversationId, input.status, type, type, sequence, input.limit)
            : input.conversationId
              ? db.prepare('SELECT * FROM workbench_operations WHERE conversation_id=? AND (? IS NULL OR type=?) AND sequence<? ORDER BY sequence DESC LIMIT ?').all(input.conversationId, type, type, sequence, input.limit)
              : input.status
                ? db.prepare('SELECT * FROM workbench_operations WHERE status=? AND (? IS NULL OR type=?) AND sequence<? ORDER BY sequence DESC LIMIT ?').all(input.status, type, type, sequence, input.limit)
                : db.prepare('SELECT * FROM workbench_operations WHERE (? IS NULL OR type=?) AND sequence<? ORDER BY sequence DESC LIMIT ?').all(type, type, sequence, input.limit)
          : input.conversationId && input.status
            ? db.prepare('SELECT * FROM workbench_operations WHERE conversation_id=? AND status=? AND (? IS NULL OR type=?) AND sequence>? ORDER BY sequence LIMIT ?').all(input.conversationId, input.status, type, type, sequence, input.limit)
            : input.conversationId
              ? db.prepare('SELECT * FROM workbench_operations WHERE conversation_id=? AND (? IS NULL OR type=?) AND sequence>? ORDER BY sequence LIMIT ?').all(input.conversationId, type, type, sequence, input.limit)
              : input.status
                ? db.prepare('SELECT * FROM workbench_operations WHERE status=? AND (? IS NULL OR type=?) AND sequence>? ORDER BY sequence LIMIT ?').all(input.status, type, type, sequence, input.limit)
                : db.prepare('SELECT * FROM workbench_operations WHERE (? IS NULL OR type=?) AND sequence>? ORDER BY sequence LIMIT ?').all(type, type, sequence, input.limit);
        return rows.map(operationFromRow);
      });
    },
    claimOperation(id) {
      parse(uuid, id);
      return mutate(changed => {
        const row = db.prepare("UPDATE workbench_operations SET status='dispatching',updated_at=? WHERE id=? AND status='queued' RETURNING *").get(now(), id);
        if (row) changed(String(row.conversation_id), undefined, 'state');
        return row ? operationFromRow(row) : null;
      });
    },
    settleOperation(id, value) {
      parse(uuid, id); const receipt = parse(receiptSchema, value);
      return mutate(changed => {
        const operation = requireOperation(id);
        const runId = receipt.outcome === 'accepted' ? (receipt.runId ?? operation.runId) : operation.runId;
        const reason = receipt.outcome === 'accepted' ? null : receipt.reason;
        if ((operation.status === 'accepted' || operation.status === 'rejected') &&
          (operation.status !== receipt.outcome || (operation.runId !== null && operation.runId !== runId) || operation.reason !== reason))
          throw new StoreError('operation_result_conflict', 409);
        if (operation.status === 'queued' && receipt.outcome !== 'rejected') throw new StoreError('operation_not_claimed', 409);
        if (operation.status === receipt.outcome && operation.runId === runId && operation.reason === reason) return operation;
        changed(operation.conversationId, undefined, 'state');
        db.prepare('UPDATE workbench_operations SET status=?,run_id=?,reason=?,updated_at=? WHERE id=?').run(receipt.outcome, runId, reason, now(), id);
        if (operation.type === 'message' && receipt.outcome === 'accepted') {
          db.prepare('UPDATE workbench_conversations SET last_activity_at=MAX(last_activity_at,?) WHERE id=?')
            .run(operation.createdAt, operation.conversationId);
        }
        if (operation.type === 'message' && operation.queuedInput) {
          const entryId = operation.queuedInput.entryId;
          if (receipt.outcome === 'accepted' && runId) {
            db.prepare('UPDATE workbench_queue_entries SET content_json=NULL,operation_id=NULL WHERE id=? AND operation_id=?').run(entryId, id);
            clearQueuePins(entryId);
            db.prepare('UPDATE workbench_queues SET after_run_id=?,version=version+1 WHERE conversation_id=?').run(runId, operation.conversationId);
          } else if (receipt.outcome === 'rejected') {
            db.prepare('DELETE FROM workbench_resource_refs WHERE owner_id=?').run(id);
            db.prepare('UPDATE workbench_queue_entries SET held=1,operation_id=NULL,version=version+1,skill_unavailable=? WHERE id=? AND operation_id=?')
              .run(Number(reason === 'skill_reference_unavailable'), entryId, id);
            if (!setPause(operation.conversationId, reason === 'native_run_changed' ? 'missed' : 'rejected')) bumpQueue(operation.conversationId);
          }
        }
        return requireOperation(id);
      });
    },
    recoverDispatching() {
      return mutate(changed => {
        const conversations = db.prepare("SELECT DISTINCT conversation_id FROM workbench_operations WHERE status='dispatching' LIMIT 10000").all();
        const count = Number(db.prepare("UPDATE workbench_operations SET status='unknown',reason='application_restarted_during_dispatch',updated_at=? WHERE status='dispatching'").run(now()).changes);
        for (const conversation of conversations) changed(String(conversation.conversation_id), undefined, 'state');
        return count;
      });
    },
    readQueue(id) {
      parse(uuid, id);
      return storage(() => {
        const state = queueRow(id);
        const rows = db.prepare(`SELECT e.*, o.status AS operation_status FROM workbench_queue_entries e
          LEFT JOIN workbench_operations o ON o.id=e.operation_id
          WHERE e.conversation_id=? AND e.content_json IS NOT NULL ORDER BY e.sequence LIMIT ?`).all(id, queueLimit);
        return {
          entries: rows.map(row => ({
            entryId: String(row.id), version: Number(row.version), content: parseJson(messagePayload, row.content_json),
            ...(row.skill_unavailable === 1 ? { skillUnavailable: true as const } : {}),
            status: row.operation_status === null ? (row.held ? 'held' : 'waiting')
              : parse(z.enum(['dispatching', 'accepted', 'unknown']), row.operation_status, 'corrupt_workbench_data'),
          })),
          pause: state?.pause == null ? null : parse(queuePauseSchema, state.pause, 'corrupt_workbench_data'),
          afterRunId: state?.after_run_id == null ? null : String(state.after_run_id),
          version: Number(state?.version ?? 0),
        };
      });
    },
    recoverableConversations(after) {
      if (after) parse(uuid, after);
      return storage(() => db.prepare(`SELECT c.id FROM workbench_conversations c
        WHERE c.id > ? AND (c.binding_json IS NOT NULL OR c.native_preparation_id IS NOT NULL OR c.readiness='preparing') AND (
          c.readiness='preparing' OR json_extract(c.state_json,'$.status') IN ('running','waiting','unknown')
          OR json_extract(c.state_json,'$.pendingInputs') > 0
          OR EXISTS (SELECT 1 FROM workbench_operations o WHERE o.conversation_id=c.id AND o.status IN ('queued','dispatching','unknown'))
          OR EXISTS (SELECT 1 FROM workbench_operations o WHERE o.conversation_id=c.id AND o.type='message' AND o.status='accepted'
            AND o.sequence=(SELECT MAX(last.sequence) FROM workbench_operations last WHERE last.conversation_id=c.id AND last.type='message' AND last.status='accepted')
            AND (o.run_id IS NULL OR (o.run_id IS NOT json_extract(c.state_json,'$.runId') AND o.run_id IS NOT json_extract(c.state_json,'$.terminalRunId'))))
          OR EXISTS (SELECT 1 FROM workbench_queues q JOIN workbench_queue_entries e ON e.conversation_id=q.conversation_id
            WHERE q.conversation_id=c.id AND q.pause IS NULL AND e.content_json IS NOT NULL)
          OR json_extract(c.subagents_json,'$.active') > 0
          OR (c.archived = 0 AND json_extract(c.subagents_json,'$.verified') = 1 AND json_extract(c.subagents_json,'$.resultsPending') = 1)
          OR EXISTS (SELECT 1 FROM workbench_subagent_stops s WHERE s.conversation_id=c.id AND s.status IN ('queued','dispatching','unknown'))
        ) ORDER BY c.id LIMIT 64`).all(after).map(row => String(row.id)));
    },
    queuedConversations(after) {
      if (after) parse(uuid, after);
      return storage(() => db.prepare(`SELECT q.conversation_id FROM workbench_queues q
        JOIN workbench_conversations c ON c.id=q.conversation_id WHERE q.conversation_id>? AND c.archived=0 AND EXISTS (
          SELECT 1 FROM workbench_queue_entries e WHERE e.conversation_id=q.conversation_id AND e.content_json IS NOT NULL
          AND (q.pause IS NULL OR e.operation_id IS NOT NULL)
        ) ORDER BY q.conversation_id LIMIT 64`).all(after).map(row => String(row.conversation_id)));
    },
    queueAdmissionExists(id, entryId, content) {
      parse(uuid, id); parse(uuid, entryId);
      return storage(() => existingAdmission(id, entryId, parse(messagePayload, content)));
    },
    changeQueue(id, value) {
      parse(uuid, id);
      const command = parse(queueCommandSchema, value);
      if (command.action === 'send') throw new StoreError('invalid_workbench_input', 400);
      return mutate(changed => {
        const conversation = checkQueueConversation(id);
        if (command.action === 'add') {
          if (existingAdmission(id, command.entryId, command.content)) return;
          const count = db.prepare('SELECT COUNT(*) AS total, COUNT(content_json) AS active FROM workbench_queue_entries WHERE conversation_id=?').get(id)!;
          if (Number(count.active) >= queueLimit || Number(count.total) >= 50_000) throw new StoreError('queue_full', 409);
          if (!count.active) {
            const pause = conversation.state.status === 'failed' ? 'failed' : conversation.state.status === 'interrupted' ? 'stopped' : null;
            db.prepare(`INSERT INTO workbench_queues(conversation_id,after_run_id,pause) VALUES(?,?,?)
              ON CONFLICT(conversation_id) DO UPDATE SET after_run_id=excluded.after_run_id,pause=excluded.pause`)
              .run(id, conversation.state.runId ?? null, pause);
          }
          setQueuePins(id, command.entryId, command.content);
          db.prepare('INSERT INTO workbench_queue_entries(id,conversation_id,content_json,admission_digest) VALUES(?,?,?,?)')
            .run(command.entryId, id, JSON.stringify(command.content), digest([id, command.content]));
        } else if (command.action === 'resume') {
          const state = queueRow(id);
          if (!state?.pause || state.version !== command.version) throw new StoreError('queue_entry_changed', 409);
          if (!hasQueue(id)) return;
          if (unsettledOperation(id)) throw new StoreError('operation_needs_reconciliation', 409);
          const after = ['running', 'waiting'].includes(conversation.state.status) ? conversation.state.runId ?? null : null;
          db.prepare('UPDATE workbench_queues SET pause=NULL,after_run_id=? WHERE conversation_id=?').run(after, id);
          db.prepare('UPDATE workbench_queue_entries SET held=0,version=version+1 WHERE conversation_id=? AND held=1').run(id);
        } else {
          mutableEntry(id, command.entryId, command.version);
          const content = command.action === 'edit' ? command.content : null;
          if (content) setQueuePins(id, command.entryId, content); else clearQueuePins(command.entryId);
          db.prepare('UPDATE workbench_queue_entries SET content_json=?,version=version+1,skill_unavailable=0 WHERE id=? AND conversation_id=?')
            .run(content ? JSON.stringify(content) : null, command.entryId, id);
        }
        bumpQueue(id);
        changed(id, undefined, 'state');
      });
    },
    claimQueue(id, entryId, version, operationId, rawDelivery) {
      parse(uuid, id); parse(uuid, entryId); parse(uuid, operationId);
      const delivery = parse(queueDeliverySchema, rawDelivery);
      return mutate(changed => {
        checkQueueConversation(id);
        if (operationRow(operationId)) throw new StoreError('operation_id_conflict', 409);
        if (unsettledOperation(id) || queueRow(id)?.pause === 'restored')
          throw new StoreError('operation_needs_reconciliation', 409);
        const entry = mutableEntry(id, entryId, version);
        if (delivery.mode === 'next') {
          const head = db.prepare('SELECT id FROM workbench_queue_entries WHERE conversation_id=? AND content_json IS NOT NULL ORDER BY sequence LIMIT 1').get(id);
          if (queueRow(id)?.pause || entry.held || head?.id !== entryId) throw new StoreError('queue_entry_changed', 409);
        }
        const count = db.prepare('SELECT COUNT(*) AS n FROM workbench_operations WHERE conversation_id=?').get(id)!;
        if (Number(count.n) >= 50_000) throw new StoreError('operation_capacity_reached', 409);
        const content = parseJson(messagePayload, entry.content_json);
        if (skillRequiresNextTurn(delivery.mode, content)) throw new StoreError('queue_skill_requires_next_turn', 409);
        const queuedInput = { entryId, version, delivery };
        for (const image of content.images ?? []) resources.pin(id, image.id, operationId);
        const at = now();
        db.prepare(`INSERT INTO workbench_operations(id,conversation_id,type,payload_json,digest,status,created_at,updated_at)
          VALUES(?,?,'message',?,?,'dispatching',?,?)`).run(operationId, id,
            JSON.stringify({ queueRecord: true, content, queuedInput }), digest([id, content, queuedInput]), at, at);
        db.prepare('UPDATE workbench_queue_entries SET operation_id=?,held=0,skill_unavailable=0 WHERE id=? AND conversation_id=?').run(operationId, entryId, id);
        bumpQueue(id);
        changed(id, undefined, 'state');
        return requireOperation(operationId);
      });
    },
    pauseQueue(id, reason) {
      parse(uuid, id); parse(queuePauseSchema, reason);
      return mutate(changed => { if (hasQueue(id) && setPause(id, reason)) changed(id, undefined, 'state'); });
    },
    version() { return storage(version); },
    changes(after, limit = 200) {
      parse(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), after);
      parse(z.number().int().min(1).max(200), limit);
      return transaction(db, () => {
        const latest = version();
        const first = db.prepare('SELECT sequence FROM workbench_changes ORDER BY sequence LIMIT 1').get();
        const oldest = first ? Number(first.sequence) : 1;
        const reset = after > latest || after < oldest - 1;
        const events = reset ? [] : db.prepare('SELECT sequence,conversation_id,item_id,scope FROM workbench_changes WHERE sequence>? ORDER BY sequence LIMIT ?')
          .all(after, limit).map(row => ({ sequence: Number(row.sequence), conversationId: String(row.conversation_id), ...(row.item_id === null ? {} : { itemId: String(row.item_id) }), ...(row.scope === 'state' ? { scope: 'state' as const } : {}) }));
        return { events, latest, reset };
      }, 'read');
    },
    touch(conversationId, itemId, scope) {
      parse(uuid, conversationId); if (itemId !== undefined) parse(identifier, itemId);
      mutate(changed => { requireConversation(conversationId); changed(conversationId, itemId, scope); });
    },
    markNative(conversationId, mark) {
      parse(uuid, conversationId); parse(nativeMark, mark);
      const current = () => {
        const row = db.prepare('SELECT native_mark FROM workbench_conversations WHERE id=?').get(conversationId);
        if (!row) throw new StoreError('conversation_not_found', 404);
        return row.native_mark === null ? null : String(row.native_mark);
      };
      // The common case, an unchanged page, is a plain read without taking the write lock.
      if (current() === mark) return false;
      return mutate(changed => {
        if (current() === mark) return false;
        db.prepare('UPDATE workbench_conversations SET native_mark=? WHERE id=?').run(mark, conversationId);
        changed(conversationId);
        return true;
      });
    },
    recordTurnFiles(conversationId, value) {
      parse(uuid, conversationId);
      const candidates = value.filter(item => item.kind === 'tool' && item.status === 'completed' && item.runId && item.fileEdits?.length);
      if (!candidates.length) return;
      const items = parse(z.array(turnFileItemSchema).max(1000), candidates.map(item => ({ kind: item.kind, status: item.status, runId: item.runId, fileEdits: item.fileEdits })));
      mutate(changed => {
        requireConversation(conversationId);
        let recorded = false;
        for (const item of items) recorded = recordTurnFiles(conversationId, item as NativeItem) || recorded;
        if (recorded) changed(conversationId);
      });
    },
    storage: accounting,
    readTurnFiles(conversationId, runIds) {
      if (!runIds.length) return [];
      return storage(() => {
        selectTurnFiles ??= db.prepare('SELECT path FROM workbench_turn_files WHERE conversation_id=? AND run_id=? ORDER BY path LIMIT ?');
        const summaries: TurnFileSummary[] = [];
        let remaining = 2 * 1024 * 1024;
        for (const runId of runIds) {
          const rows = selectTurnFiles.all(conversationId, runId, turnFileLimit + 1);
          if (!rows.length) continue;
          const summary = { runId, paths: rows.slice(0, turnFileLimit).map(row => String(row.path)), limited: rows.length > turnFileLimit };
          remaining -= Buffer.byteLength(JSON.stringify(summary)) + 1;
          if (remaining < 0) break;
          summaries.push(summary);
        }
        return summaries;
      });
    },
    markSeen(id) {
      parse(uuid, id);
      return mutate(changed => {
        const row = db.prepare(`${ATTENTION_ROWS} WHERE c.id = ?`).get(id);
        if (!row) throw new StoreError('conversation_not_found', 404);
        if (row.attention_key === null) return false;
        const key = String(row.attention_key);
        // An "unknown" key never replaces the last seen result, so resolving back to it stays seen.
        const result = !key.startsWith('unknown:');
        if (row.seen_key === key && (!result || row.seen_result_key === key)) return false;
        const unseen = key !== row.seen_key && key !== row.seen_result_key;
        if (result) db.prepare('UPDATE workbench_conversations SET seen_key=?,seen_result_key=? WHERE id=?').run(key, key, id);
        else db.prepare('UPDATE workbench_conversations SET seen_key=? WHERE id=?').run(key, id);
        if (unseen) changed(id, undefined, 'state');
        return unseen;
      });
    },
    unseen(ids) {
      const values = parse(z.array(uuid).max(1000), ids);
      if (!values.length) return new Set<string>();
      return storage(() => new Set(db.prepare(`SELECT id FROM (${ATTENTION_ROWS} WHERE c.id IN (SELECT value FROM json_each(?))) WHERE ${UNSEEN}`)
        .all(JSON.stringify(values)).map(row => String(row.id))));
    },
    attention(reading, limit) {
      const readers = JSON.stringify(parse(z.array(uuid).max(1000), reading));
      parse(z.number().int().min(1).max(100), limit);
      // Bounded by the conversation capacity: one pass over non-archived rows (archive/activity index).
      const scope = `SELECT id, last_activity_at, ${ATTENTION_BUCKET} AS bucket, status,
        (${UNSEEN} AND id NOT IN (SELECT value FROM json_each(?))) AS unseen
        FROM (${ATTENTION_ROWS} WHERE c.archived = 0)`;
      return transaction(db, () => {
        const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM (${scope}) WHERE unseen`).get(readers)!.count);
        const rows = db.prepare(`SELECT c.*, a.unseen AS attention_unseen FROM (${scope}) a JOIN workbench_conversations c ON c.id = a.id
          WHERE a.status IN ('running','waiting','failed','unknown') OR a.unseen
          ORDER BY a.bucket, a.last_activity_at DESC, a.id DESC LIMIT ?`).all(readers, limit);
        return { unseen: count, conversations: rows.map(row => ({ conversation: conversationFromRow(row), unseen: Number(row.attention_unseen) === 1 })) };
      }, 'read');
    },
  };
  return store;
}

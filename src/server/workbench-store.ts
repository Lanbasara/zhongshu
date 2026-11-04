import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { z } from 'zod';
import { conversationTitleSchema, identifierSchema, messagePayload, queueCommandSchema, queueDeliverySchema, queueLimit, queuePauseSchema, stateSchema, turnFileLimit, usageSchema, workspaceLimit } from '../shared/workbench.ts';
import type { ConversationUsage, QueueCommand, QueueDelivery, QueuePause, QueueView, TurnFileSummary } from '../shared/workbench.ts';
import { contentFields, inputFields, recordedFilePath, toolSchema, validSkillSpans, type InputContent } from '../shared/content.ts';
import { createResourceStore } from './resources.ts';
import type { Binding, Configuration, HarnessId, NativeItem, NativeState, Receipt } from '../harness/types.ts';

export type Readiness = 'preparing' | 'ready' | 'blocked';
export type Conversation = {
  id: string; harnessId: HarnessId; workspaceId: string; cwd: string; title: string;
  configuration: Configuration; binding: Binding | null; readiness: Readiness;
  archived: boolean; state: NativeState; error: string | null; createdAt: number;
  usage?: ConversationUsage;
  historyLoaded: boolean; nativeOlderCursor: string | null; nativeOlderBeforeItemId: string | null;
};
export type CreateConversation = Pick<Conversation, 'id' | 'harnessId' | 'workspaceId' | 'cwd' | 'configuration'> & { title?: string };
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
export type WorkbenchChange = { sequence: number; conversationId: string; itemId?: string };
export type HistorySnapshot = {
  revision: number;
  items: NativeItem[]; liveItems: NativeItem[]; olderBeforeItemId: string | null;
  liveItemsLimited: boolean;
  historyLoaded: boolean; nativeOlderCursor: string | null; nativeOlderBeforeItemId: string | null;
};
export type ListOperations = { conversationId?: string; status?: OperationStatus; type?: 'message' | 'stop'; order?: 'asc' | 'desc'; afterId?: string; limit?: number };
type ConversationList = {
  beforeId?: string; limit?: number; workspaceId?: string; archived?: boolean;
  title?: string; excludeWorkspaces?: string[];
};
type StoredQueue = Omit<QueueView, 'mode'> & { afterRunId: string | null };
export interface WorkbenchStore {
  resources: ReturnType<typeof createResourceStore>;
  createConversation(input: CreateConversation): { conversation: Conversation; created: boolean };
  getConversation(id: string): Conversation | null;
  listConversations(options?: ConversationList): Conversation[];
  renameConversation(id: string, title: string): Conversation;
  setArchived(id: string, archived: boolean, canArchive: (conversation: Conversation) => boolean): Conversation;
  saveBinding(id: string, binding: Binding): Conversation;
  setConversationState(id: string, change: { readiness?: Readiness; state?: NativeState; error?: string | null }): Conversation;
  setUsage(id: string, value: ConversationUsage): void;
  setHistoryCursor(id: string, cursor: { loaded: boolean; olderCursor: string | null; beforeItemId: string | null }): Conversation;
  enqueueOperation(input: OperationInput): { operation: Operation; created: boolean };
  getOperation(id: string): Operation | null;
  listOperations(options?: ListOperations): Operation[];
  claimOperation(id: string): Operation | null;
  settleOperation(id: string, receipt: Receipt): Operation;
  recoverDispatching(): number;
  readQueue(id: string): StoredQueue;
  queuedConversations(after: string): string[];
  queueAdmissionExists(id: string, entryId: string, content: InputContent): boolean;
  changeQueue(id: string, command: Exclude<QueueCommand, { action: 'send' }>): void;
  claimQueue(id: string, entryId: string, version: number, operationId: string, delivery: QueueDelivery): Operation;
  pauseQueue(id: string, reason: QueuePause): void;
  changes(after: number, limit?: number): { events: WorkbenchChange[]; latest: number; reset: boolean };
  version(): number;
  mergeHistory(conversationId: string, items: NativeItem[], beforeItemId?: string): void;
  saveLiveItem(conversationId: string, item: NativeItem): void;
  getItem(conversationId: string, itemId: string): NativeItem | null;
  hasHistoryItem(conversationId: string, itemId: string): boolean;
  operationRunId(conversationId: string, operationId: string): string | null;
  readHistory(conversationId: string, options?: { beforeItemId?: string; limit?: number }): HistorySnapshot;
  readTurnFiles(conversationId: string, runIds: readonly string[]): TurnFileSummary[];
}

export class StoreError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode = 500) { super(code); this.name = 'StoreError'; this.code = code; this.statusCode = statusCode; }
}

const MAX_ITEMS = 50_000;
const MAX_LIVE_ITEMS = 100;
const MAX_TEXT_BYTES = 1_048_576;
const POSITION_STEP = 1024;
const POSITION_BOUND = Math.floor(Number.MAX_SAFE_INTEGER / 2);
const boundedText = (bytes: number) => z.string().max(bytes).refine(value => Buffer.byteLength(value, 'utf8') <= bytes);
const identifier = boundedText(1024).min(1).refine(value => !value.includes('\0'));
const uuid = z.uuid();
const configurationSchema = z.object({ modelId: identifier, permissionId: identifier }).strict();
const nativeStateSchema = stateSchema;
const itemSchema = z.object({
  id: identifier, kind: z.enum(['user', 'assistant', 'tool', 'notice']), text: boundedText(MAX_TEXT_BYTES),
  status: z.enum(['running', 'completed', 'failed']), runId: identifier.optional(), operationId: identifier.optional(),
  ...contentFields, tool: toolSchema.optional(),
}).strict();
const nativeItemSchema = itemSchema.extend({ fileEdits: z.array(recordedFilePath).max(400).optional() });
const bindingSchema = z.object({
  id: identifier, cwd: boundedText(4096).min(1), configuration: configurationSchema, details: z.record(z.string(), z.unknown()),
}).strict();
const createConversationSchema = z.object({
  id: uuid, harnessId: z.enum(['codex', 'dsh']), workspaceId: identifier, cwd: boundedText(4096).min(1),
  configuration: configurationSchema, title: boundedText(200).min(1).optional(),
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
function itemFromRow(row: Row): NativeItem {
  return parse(itemSchema, {
    ...JSON.parse(String(row.metadata_json ?? '{}')),
    id: row.id, kind: row.kind, text: row.text, status: row.status,
    ...(row.run_id === null ? {} : { runId: row.run_id }), ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
  }, 'corrupt_workbench_data');
}
function conversationFromRow(row: Row): Conversation {
  return {
    id: String(row.id), harnessId: parse(z.enum(['codex', 'dsh']), row.harness_id, 'corrupt_workbench_data'),
    workspaceId: String(row.workspace_id), cwd: String(row.cwd), title: String(row.title), archived: row.archived === 1,
    configuration: parseJson(configurationSchema, row.configuration_json), binding: row.binding_json === null ? null : parseJson(bindingSchema, row.binding_json),
    readiness: parse(z.enum(['preparing', 'ready', 'blocked']), row.readiness, 'corrupt_workbench_data'),
    state: parseJson(nativeStateSchema, row.state_json), error: row.error === null ? null : String(row.error), createdAt: Number(row.created_at),
    ...(row.usage_json == null ? {} : { usage: parseJson(usageSchema, row.usage_json) }),
    historyLoaded: row.history_loaded === 1, nativeOlderCursor: row.native_older_cursor === null ? null : String(row.native_older_cursor),
    nativeOlderBeforeItemId: row.native_older_before_item_id === null ? null : String(row.native_older_before_item_id),
  };
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
export function createWorkbenchStore(db: DatabaseSync, options: { now?: () => number; onChange?: (event: WorkbenchChange) => void } = {}): WorkbenchStore {
  const now = options.now ?? Date.now;
  const version = (): number => Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS version FROM workbench_changes').get()!.version);
  const mutate = <T>(action: (changed: (conversationId: string, itemId?: string) => void) => T): T => {
    const events: WorkbenchChange[] = [];
    const value = transaction(db, () => {
      const changed = new Map<string, string | undefined>();
      const result = action((id, itemId) => {
        if (!changed.has(id)) changed.set(id, itemId);
        else if (changed.get(id) !== itemId) changed.set(id, undefined);
      });
      const insert = db.prepare('INSERT INTO workbench_changes(conversation_id,item_id,created_at) VALUES(?,?,?)');
      for (const [conversationId, itemId] of changed) {
        const row = insert.run(conversationId, itemId ?? null, now());
        events.push({ sequence: Number(row.lastInsertRowid), conversationId, ...(itemId === undefined ? {} : { itemId }) });
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
  const upsertItem = db.prepare(`INSERT INTO workbench_items(conversation_id,id,position,kind,text,status,run_id,operation_id,metadata_json)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id,id) DO UPDATE SET kind=excluded.kind,text=excluded.text,
    status=excluded.status,run_id=excluded.run_id,operation_id=excluded.operation_id,metadata_json=excluded.metadata_json
    WHERE workbench_items.kind IS NOT excluded.kind OR workbench_items.text IS NOT excluded.text
      OR workbench_items.status IS NOT excluded.status OR workbench_items.run_id IS NOT excluded.run_id
      OR workbench_items.operation_id IS NOT excluded.operation_id OR workbench_items.metadata_json IS NOT excluded.metadata_json`);
  const deleteLive = db.prepare('DELETE FROM workbench_live_items WHERE conversation_id = ? AND id = ?');
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
  const resources = createResourceStore(db);
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
  const metadata = (item: NativeItem) => JSON.stringify({ ...(item.images?.length ? { images: item.images } : {}), ...(item.references?.length ? { references: item.references } : {}), ...(item.tool ? { tool: item.tool } : {}) });
  const store: WorkbenchStore = {
    resources,
    createConversation(value) {
      const input = parse(createConversationSchema, value);
      const creationDigest = digest([input.harnessId, input.workspaceId, input.cwd, input.configuration.modelId, input.configuration.permissionId]);
      return mutate(changed => {
        const existing = conversationRow(input.id);
        if (existing) {
          if (existing.creation_digest !== creationDigest) throw new StoreError('conversation_id_conflict', 409);
          return { conversation: conversationFromRow(existing), created: false };
        }
        assertWorkspaceActive(input.workspaceId);
        const count = Number(db.prepare('SELECT COUNT(*) AS count FROM workbench_conversations').get()!.count);
        if (count >= 10_000) throw new StoreError('conversation_capacity_reached', 409);
        const initial: NativeState = { status: 'unknown', pendingInputs: 0, configurationVerified: false };
        db.prepare(`INSERT INTO workbench_conversations(id,harness_id,workspace_id,cwd,title,configuration_json,creation_digest,
          readiness,state_json,created_at) VALUES(?,?,?,?,?,?,?,'preparing',?,?)`).run(input.id, input.harnessId, input.workspaceId,
          input.cwd, input.title ?? '新对话', JSON.stringify(input.configuration), creationDigest, JSON.stringify(initial), now());
        changed(input.id);
        return { conversation: requireConversation(input.id), created: true };
      });
    },
    getConversation(id) { parse(uuid, id); return storage(() => { const row = conversationRow(id); return row ? conversationFromRow(row) : null; }); },
    listConversations(value = {}) {
      const input = parse(z.object({
        beforeId: uuid.optional(), limit: z.number().int().min(1).max(1000).default(100),
        workspaceId: identifierSchema.optional(), archived: z.boolean().optional(),
        title: z.string().max(200).optional(), excludeWorkspaces: z.array(identifierSchema).max(workspaceLimit).optional(),
      }).strict(), value);
      return storage(() => {
        const before = input.beforeId ? requireConversation(input.beforeId) : null;
        const cursor = [before?.createdAt ?? 9223372036854775807n, before?.id ?? ''] as const;
        const title = input.title ?? '';
        const exclusions = JSON.stringify(input.excludeWorkspaces ?? []);
        const rows = input.workspaceId !== undefined && input.archived !== undefined
          ? db.prepare(`
              SELECT * FROM workbench_conversations
              WHERE workspace_id = ? AND archived = ? AND (created_at,id) < (?,?)
                AND workspace_id NOT IN (SELECT value FROM json_each(?))
                AND instr(lower(title), lower(?)) > 0
              ORDER BY created_at DESC,id DESC LIMIT ?
            `).all(input.workspaceId, Number(input.archived), ...cursor, exclusions, title, input.limit)
          : input.archived !== undefined && input.workspaceId === undefined
            ? db.prepare(`
                SELECT * FROM workbench_conversations
                WHERE archived = ? AND (created_at,id) < (?,?)
                  AND workspace_id NOT IN (SELECT value FROM json_each(?))
                  AND instr(lower(title), lower(?)) > 0
                ORDER BY created_at DESC,id DESC LIMIT ?
              `).all(Number(input.archived), ...cursor, exclusions, title, input.limit)
            : db.prepare(`
                SELECT * FROM workbench_conversations
                WHERE (created_at,id) < (?,?) AND (? IS NULL OR workspace_id = ?)
                  AND workspace_id NOT IN (SELECT value FROM json_each(?))
                  AND instr(lower(title), lower(?)) > 0
                ORDER BY created_at DESC,id DESC LIMIT ?
              `).all(...cursor, input.workspaceId ?? null, input.workspaceId ?? null, exclusions, title, input.limit);
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
        changed(id);
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
        changed(id);
        return requireConversation(id);
      });
    },
    saveBinding(id, value) {
      parse(uuid, id); const binding = parse(bindingSchema, value); const json = bindingJson(binding);
      return mutate(changed => {
        const conversation = requireConversation(id);
        if (binding.cwd !== conversation.cwd || binding.configuration.modelId !== conversation.configuration.modelId || binding.configuration.permissionId !== conversation.configuration.permissionId)
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
        changed(id);
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
        changed(id);
      });
    },
    setHistoryCursor(id, value) {
      parse(uuid, id);
      const cursor = parse(z.object({ loaded: z.boolean(), olderCursor: boundedText(8192).min(1).nullable(), beforeItemId: identifier.nullable() }).strict(), value);
      return mutate(changed => {
        const conversation = requireConversation(id);
        if (cursor.olderCursor !== null && (!cursor.loaded || cursor.beforeItemId === null)) throw new StoreError('history_cursor_requires_anchor', 409);
        if (cursor.beforeItemId !== null && !db.prepare('SELECT id FROM workbench_items WHERE conversation_id=? AND id=?').get(id, cursor.beforeItemId))
          throw new StoreError('history_anchor_not_found', 409);
        if (conversation.historyLoaded === cursor.loaded && conversation.nativeOlderCursor === cursor.olderCursor && conversation.nativeOlderBeforeItemId === cursor.beforeItemId) return conversation;
        changed(id);
        db.prepare('UPDATE workbench_conversations SET history_loaded=?,native_older_cursor=?,native_older_before_item_id=? WHERE id=?')
          .run(cursor.loaded ? 1 : 0, cursor.olderCursor, cursor.beforeItemId, id);
        return requireConversation(id);
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
        changed(input.conversationId);
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
        if (row) changed(String(row.conversation_id));
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
        changed(operation.conversationId);
        db.prepare('UPDATE workbench_operations SET status=?,run_id=?,reason=?,updated_at=? WHERE id=?').run(receipt.outcome, runId, reason, now(), id);
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
        for (const conversation of conversations) changed(String(conversation.conversation_id));
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
        changed(id);
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
        const queuedInput = { entryId, version, delivery };
        for (const image of content.images ?? []) resources.pin(id, image.id, operationId);
        const at = now();
        db.prepare(`INSERT INTO workbench_operations(id,conversation_id,type,payload_json,digest,status,created_at,updated_at)
          VALUES(?,?,'message',?,?,'dispatching',?,?)`).run(operationId, id,
            JSON.stringify({ queueRecord: true, content, queuedInput }), digest([id, content, queuedInput]), at, at);
        db.prepare('UPDATE workbench_queue_entries SET operation_id=?,held=0,skill_unavailable=0 WHERE id=? AND conversation_id=?').run(operationId, entryId, id);
        bumpQueue(id);
        changed(id);
        return requireOperation(operationId);
      });
    },
    pauseQueue(id, reason) {
      parse(uuid, id); parse(queuePauseSchema, reason);
      return mutate(changed => { if (hasQueue(id) && setPause(id, reason)) changed(id); });
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
        const events = reset ? [] : db.prepare('SELECT sequence,conversation_id,item_id FROM workbench_changes WHERE sequence>? ORDER BY sequence LIMIT ?')
          .all(after, limit).map(row => ({ sequence: Number(row.sequence), conversationId: String(row.conversation_id), ...(row.item_id === null ? {} : { itemId: String(row.item_id) }) }));
        return { events, latest, reset };
      }, 'read');
    },
    mergeHistory(conversationId, value, beforeItemId) {
      parse(uuid, conversationId); if (beforeItemId !== undefined) parse(identifier, beforeItemId);
      const items = parse(z.array(nativeItemSchema).max(1000), value);
      // Duplicate native IDs carry the final body in the page, retaining their first order.
      const incoming = new Map(items.map(item => [item.id, item]));
      return mutate(changed => {
        requireConversation(conversationId);
        const find = db.prepare('SELECT id,position FROM workbench_items WHERE conversation_id=? AND id=?');
        const anchor = beforeItemId === undefined ? null : find.get(conversationId, beforeItemId) as PositionedId | undefined;
        if (beforeItemId !== undefined && !anchor) throw new StoreError('history_anchor_not_found', 409);
        const known = new Map<string, number>();
        for (const id of incoming.keys()) { const row = find.get(conversationId, id) as PositionedId | undefined; if (row) known.set(id, row.position); }
        const newCount = incoming.size - known.size;
        const positions = new Map(known);
        if (newCount > 0) {
          // Reordering reads at most the bounded ID index, never historical message bodies.
          const current = db.prepare('SELECT id,position FROM workbench_items WHERE conversation_id=? ORDER BY position LIMIT ?').all(conversationId, MAX_ITEMS + 1) as PositionedId[];
          if (current.length + newCount > MAX_ITEMS) throw new StoreError('history_capacity_reached', 409);
          let lastPosition = -Infinity;
          for (const id of incoming.keys()) {
            const position = known.get(id);
            if (position !== undefined) {
              if (position < lastPosition || (anchor && position > anchor.position)) throw new StoreError('history_order_conflict', 409);
              lastPosition = position;
            }
          }
          const before = new Map<string | null, string[]>();
          let pending: string[] = [];
          for (const id of incoming.keys()) {
            if (known.has(id)) { if (pending.length) { before.set(id, pending); pending = []; } }
            else pending.push(id);
          }
          if (pending.length) {
            const boundary = beforeItemId ?? null;
            if (boundary !== null && incoming.has(boundary)) throw new StoreError('history_order_conflict', 409);
            before.set(boundary, [...(before.get(boundary) ?? []), ...pending]);
          }
          const ordered: string[] = [];
          for (const row of current) { ordered.push(...(before.get(row.id) ?? []), row.id); positions.set(row.id, row.position); }
          ordered.push(...(before.get(null) ?? []));
          let compact = false;
          for (let start = 0; start < ordered.length;) {
            if (positions.has(ordered[start]!)) { start++; continue; }
            let end = start;
            while (end < ordered.length && !positions.has(ordered[end]!)) end++;
            const left = start === 0 ? undefined : positions.get(ordered[start - 1]!);
            const right = end === ordered.length ? undefined : positions.get(ordered[end]!);
            const count = end - start;
            const step = left === undefined || right === undefined ? POSITION_STEP : Math.floor((right - left) / (count + 1));
            const first = left === undefined ? (right === undefined ? 0 : right - step * count) : left + step;
            if (step < 1 || Math.abs(first) > POSITION_BOUND || Math.abs(first + step * (count - 1)) > POSITION_BOUND) { compact = true; break; }
            for (let offset = 0; offset < count; offset++) positions.set(ordered[start + offset]!, first + step * offset);
            start = end;
          }
          if (compact) {
            const finalPositions = new Map(ordered.map((id, index) => [id, index * POSITION_STEP]));
            const reordered = current.filter(row => row.position !== finalPositions.get(row.id));
            const move = db.prepare('UPDATE workbench_items SET position=? WHERE conversation_id=? AND id=?');
            // Temporary reserved negative positions avoid UNIQUE collisions during the atomic compaction.
            for (let index = 0; index < reordered.length; index++) move.run(Number.MIN_SAFE_INTEGER + index, conversationId, reordered[index]!.id);
            for (const row of reordered) move.run(finalPositions.get(row.id)!, conversationId, row.id);
            for (const [id, position] of finalPositions) positions.set(id, position);
          }
        }
        for (const item of incoming.values()) {
          const written = upsertItem.run(conversationId, item.id, positions.get(item.id)!, item.kind, item.text, item.status, item.runId ?? null, item.operationId ?? null, metadata(item));
          const removed = deleteLive.run(conversationId, item.id);
          const recorded = recordTurnFiles(conversationId, item);
          if (recorded || Number(written.changes) + Number(removed.changes) > 0) changed(conversationId);
        }
      });
    },
    saveLiveItem(conversationId, value) {
      parse(uuid, conversationId); const item = parse(nativeItemSchema, value);
      return mutate(changed => {
        requireConversation(conversationId);
        if (recordTurnFiles(conversationId, item)) changed(conversationId);
        const canonical = db.prepare('SELECT position FROM workbench_items WHERE conversation_id=? AND id=?').get(conversationId, item.id);
        if (canonical) {
          const written = upsertItem.run(conversationId, item.id, Number(canonical.position), item.kind, item.text, item.status, item.runId ?? null, item.operationId ?? null, metadata(item));
          const removed = deleteLive.run(conversationId, item.id);
          if (Number(written.changes) + Number(removed.changes) > 0) changed(conversationId, item.id);
          return;
        }
        const existing = db.prepare('SELECT id FROM workbench_live_items WHERE conversation_id=? AND id=?').get(conversationId, item.id);
        if (!existing && Number(db.prepare('SELECT COUNT(*) AS count FROM workbench_live_items WHERE conversation_id=?').get(conversationId)!.count) >= MAX_LIVE_ITEMS)
          throw new StoreError('live_history_capacity_reached', 409);
        const written = db.prepare(`INSERT INTO workbench_live_items(conversation_id,id,kind,text,status,run_id,operation_id,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(conversation_id,id) DO UPDATE SET kind=excluded.kind,text=excluded.text,status=excluded.status,
          run_id=excluded.run_id,operation_id=excluded.operation_id,updated_at=excluded.updated_at,metadata_json=excluded.metadata_json
          WHERE workbench_live_items.kind IS NOT excluded.kind OR workbench_live_items.text IS NOT excluded.text
            OR workbench_live_items.status IS NOT excluded.status OR workbench_live_items.run_id IS NOT excluded.run_id
            OR workbench_live_items.operation_id IS NOT excluded.operation_id OR workbench_live_items.metadata_json IS NOT excluded.metadata_json`)
          .run(conversationId, item.id, item.kind, item.text, item.status, item.runId ?? null, item.operationId ?? null, now(), metadata(item));
        if (Number(written.changes) > 0) changed(conversationId, item.id);
      });
    },
    hasHistoryItem(conversationId, itemId) {
      parse(uuid, conversationId); parse(identifier, itemId);
      return storage(() => Boolean(db.prepare('SELECT id FROM workbench_items WHERE conversation_id=? AND id=?').get(conversationId, itemId)));
    },
    operationRunId(conversationId, operationId) {
      parse(uuid, conversationId); parse(uuid, operationId);
      return storage(() => {
        const rows = db.prepare(`SELECT DISTINCT run_id FROM (
          SELECT run_id FROM workbench_items WHERE conversation_id=? AND kind='user' AND operation_id=?
          UNION ALL SELECT run_id FROM workbench_live_items WHERE conversation_id=? AND kind='user' AND operation_id=?
        ) WHERE run_id IS NOT NULL LIMIT 2`).all(conversationId, operationId, conversationId, operationId);
        return rows.length === 1 ? String(rows[0]!.run_id) : null;
      });
    },
    getItem(conversationId, itemId) {
      parse(uuid, conversationId); parse(identifier, itemId);
      return storage(() => {
        const row = db.prepare(`SELECT id,kind,text,status,run_id,operation_id,metadata_json FROM workbench_live_items WHERE conversation_id=? AND id=?
          UNION ALL SELECT id,kind,text,status,run_id,operation_id,metadata_json FROM workbench_items WHERE conversation_id=? AND id=? LIMIT 1`)
          .get(conversationId, itemId, conversationId, itemId);
        return row ? itemFromRow(row) : null;
      });
    },
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
    readHistory(conversationId, value = {}) {
      parse(uuid, conversationId);
      const input = parse(z.object({ beforeItemId: identifier.optional(), limit: z.number().int().min(1).max(100).default(100) }).strict(), value);
      return transaction(db, () => {
        const conversation = requireConversation(conversationId);
        const before = input.beforeItemId === undefined ? null : db.prepare('SELECT position FROM workbench_items WHERE conversation_id=? AND id=?').get(conversationId, input.beforeItemId);
        if (input.beforeItemId !== undefined && !before) throw new StoreError('history_anchor_not_found', 404);
        // Iterate rows so a valid page of many maximum-size bodies cannot allocate them all
        // before the HTTP layer applies its wire budget. Every returned body remains complete.
        const rows = before
          ? db.prepare('SELECT * FROM workbench_items WHERE conversation_id=? AND position<? ORDER BY position DESC LIMIT ?').iterate(conversationId, Number(before.position), input.limit + 1)
          : db.prepare('SELECT * FROM workbench_items WHERE conversation_id=? ORDER BY position DESC LIMIT ?').iterate(conversationId, input.limit + 1);
        const items: NativeItem[] = []; let bytes = 0; let hasOlder = false;
        for (const row of rows) {
          const item = itemFromRow(row); bytes += Buffer.byteLength(item.text) + 2048;
          if (items.length >= input.limit || bytes > 8 * 1024 * 1024) { hasOlder = true; break; }
          items.push(item);
        }
        items.reverse();
        const liveItems: NativeItem[] = []; let liveBytes = 0; let liveItemsLimited = false;
        for (const row of db.prepare('SELECT * FROM workbench_live_items WHERE conversation_id=? ORDER BY updated_at DESC,id DESC LIMIT ?').iterate(conversationId, MAX_LIVE_ITEMS)) {
          const item = itemFromRow(row); liveBytes += Buffer.byteLength(item.text) + 2048;
          if (liveBytes > 4 * 1024 * 1024) { liveItemsLimited = true; break; }
          liveItems.push(item);
        }
        liveItems.reverse();
        return { revision: version(), items, liveItems, liveItemsLimited, olderBeforeItemId: hasOlder ? items[0]!.id : null, historyLoaded: conversation.historyLoaded,
          nativeOlderCursor: conversation.nativeOlderCursor, nativeOlderBeforeItemId: conversation.nativeOlderBeforeItemId };
      }, 'read');
    },
  };
  return store;
}

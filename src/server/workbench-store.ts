import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { z } from 'zod';
import { conversationPageInput, scanConversationIds, type ConversationSearch } from './conversation-search.ts';
import { createExecutionAdmissionHooks } from './execution-store.ts';
import { conversationTitleSchema, identifierSchema, messagePayload, queueCommandSchema, queueDeliverySchema, queueLimit, queuePauseSchema, skillRequiresNextTurn, stateSchema, turnFileLimit, usageSchema, workspaceLimit } from '../shared/workbench.ts';
import type { ConversationUsage, QueueCommand, QueueDelivery, QueuePause, QueueView, QueueSummary, TurnFileSummary, TurnFilePage, WorkbenchOperation } from '../shared/workbench.ts';
import { bodyReferencesSchema, contentFields, inputFields, recordedFilePath, toolSchema, validSkillSpans, type InputContent } from '../shared/content.ts';
import { createBodyStore, projectBodyPreview } from './body-store.ts';
import { createCapacityGuard, type CapacityOptions, type StorageCapacity } from './storage-capacity.ts';
import { createOperationPayloadStore } from './operation-payload-store.ts';
import { activeHistoryOrder, advanceHistoryRebuild, allocateHistoryPositions, requestHistoryRebuild } from './history-order.ts';
import { createResourceStore } from './resources.ts';
import type { Binding, Configuration, HarnessId, HistoryChanges, NativeItem, NativeState, Receipt } from '../harness/types.ts';

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
export type ArchiveJob = {
  conversationId: string; kind: 'latest' | 'backfill'; bindingId: string; epoch: number;
  cursor: string | null; anchorId: string | null; pages: number; complete: boolean;
  nextAt: number; lastSuccessAt: number | null; error: string | null; failures: number;
  scanGeneration: number; targetId: string | null; targetSeen: boolean; coverageError: string | null;
  refreshAfter: string | null; working: boolean;
  updatesComplete?: boolean; updatesLastSuccessAt?: number | null;
};
export type ArchiveUpdateCheckpoint = { cursor: string | null; complete: boolean; lastSuccessAt: number | null };
type ConversationList = {
  beforeId?: string; limit?: number; workspaceId?: string; archived?: boolean;
};
type StoredQueue = Omit<QueueView, 'mode'> & { afterRunId: string | null };
export interface WorkbenchStore {
  resources: ReturnType<typeof createResourceStore>;
  createConversation(input: CreateConversation): { conversation: Conversation; created: boolean };
  getConversation(id: string): Conversation | null;
  listConversations(options?: ConversationList): Conversation[];
  searchConversations(options?: ConversationSearch): { entries: Conversation[]; beforeId: string | null; scanned: number; scanLimited: boolean };
  renameConversation(id: string, title: string): Conversation;
  setArchived(id: string, archived: boolean, canArchive: (conversation: Conversation) => boolean): Conversation;
  setArchivedChecked(id: string, archived: boolean, expected: Pick<Conversation, 'state' | 'readiness' | 'binding'>): Conversation;
  saveBinding(id: string, binding: Binding): Conversation;
  setConversationState(id: string, change: { readiness?: Readiness; state?: NativeState; error?: string | null }): Conversation;
  setUsage(id: string, value: ConversationUsage): void;
  setHistoryCursor(id: string, cursor: { loaded: boolean; olderCursor: string | null; beforeItemId: string | null }): Conversation;
  enqueueOperation(input: OperationInput): { operation: Operation; created: boolean };
  getOperation(id: string): Operation | null;
  listOperations(options?: ListOperations): Operation[];
  readOperationViews(conversationId: string): WorkbenchOperation[];
  operationState(conversationId: string): { unresolved: boolean; latestAcceptedMessage: { id: string; runId: string | null } | null };
  claimOperation(id: string): Operation | null;
  settleOperation(id: string, receipt: Receipt): Operation;
  recoverDispatching(): number;
  readQueue(id: string): StoredQueue;
  readQueueSummary(id: string): Omit<QueueSummary, 'mode'>;
  readQueueEntry(id: string, entryId: string, version: number): QueueView['entries'][number];
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
  readTurnFiles(conversationId: string, runIds: readonly string[], summaryOnly?: boolean): TurnFileSummary[];
  readTurnFilesPage(conversationId: string, runId: string, afterPath?: string): TurnFilePage;
  archiveJobs(conversationId: string): ArchiveJob[];
  dueArchiveJobs(limit?: number): ArchiveJob[];
  claimArchiveJob(conversationId: string, kind: ArchiveJob['kind'], force?: boolean): ArchiveJob | null;
  commitArchivePage(job: ArchiveJob, items: NativeItem[], olderCursor: string | null): boolean;
  failArchiveJob(job: ArchiveJob, reason: string): void;
  yieldArchiveJob(job: ArchiveJob): void;
  restartArchiveJob(job: ArchiveJob, reason: string): void;
  advanceArchiveMaintenance(): boolean;
  advanceStorageMaintenance(): boolean;
  pendingArchiveItems(conversationId: string, after: string | null): string[];
  refreshArchiveItems(job: ArchiveJob, items: NativeItem[], requested: string[]): void;
  archiveUpdates(conversationId: string): ArchiveUpdateCheckpoint | null;
  commitArchiveUpdates(job: ArchiveJob, expectedCursor: string | null, page: HistoryChanges, items: NativeItem[]): boolean;
  resetArchiveUpdates(job: ArchiveJob, expectedCursor: string | null): void;
  readBody: ReturnType<typeof createBodyStore>['read'];
  beginBodyStage: ReturnType<typeof createBodyStore>['begin'];
  stageBodyChunk: ReturnType<typeof createBodyStore>['append'];
  finishBodyStage: ReturnType<typeof createBodyStore>['finish'];
  validateBodyStage: ReturnType<typeof createBodyStore>['validate'];
  capacity(): StorageCapacity;
  advanceHistoryIndex(): boolean;
}

export class StoreError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode = 500) { super(code); this.name = 'StoreError'; this.code = code; this.statusCode = statusCode; }
}

const MAX_LIVE_ITEMS = 100;
const MAX_TEXT_BYTES = 1_048_576;
const boundedText = (bytes: number) => z.string().max(bytes).refine(value => Buffer.byteLength(value, 'utf8') <= bytes);
const identifier = boundedText(1024).min(1).refine(value => !value.includes('\0'));
const uuid = z.uuid();
const configurationSchema = z.object({ modelId: identifier, permissionId: identifier }).strict();
const nativeStateSchema = stateSchema;
const itemSchema = z.object({
  id: identifier, kind: z.enum(['user', 'assistant', 'tool', 'notice']), text: boundedText(MAX_TEXT_BYTES),
  status: z.enum(['running', 'completed', 'failed']), runId: identifier.optional(), operationId: identifier.optional(),
  bodies: bodyReferencesSchema.optional(),
  previewOnly: z.literal(true).optional(),
  mediaPending: z.literal(true).optional(),
  sourceRevision: z.object({ generation: boundedText(256).min(1), sequence: z.number().int().nonnegative().safe() }).strict().optional(),
  ...contentFields, tool: toolSchema.optional(),
}).strict();
const nativeItemSchema = itemSchema.extend({ text: boundedText(64 * 1024 * 1024), fileEdits: z.array(recordedFilePath).max(400).optional(), fileEditsLimited: z.literal(true).optional() });
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
/** Native sequence comparisons are valid only within the same immutable source.
 * A tool result may be encountered before its call during reverse pagination;
 * older immutable input can fill a missing field without reverting the result.
 */
function mergeNativeRevision(previous: NativeItem | null, incoming: NativeItem): NativeItem {
  if (!previous?.sourceRevision) return incoming;
  if (previous.status === 'running' && incoming.previewOnly && !incoming.sourceRevision) return incoming;
  if (!incoming.sourceRevision || previous.sourceRevision.generation !== incoming.sourceRevision.generation) return previous;
  const mediaRepair = previous.sourceRevision.sequence === incoming.sourceRevision.sequence && previous.mediaPending && !incoming.mediaPending;
  const newer = previous.sourceRevision.sequence >= incoming.sourceRevision.sequence && !mediaRepair ? previous : incoming;
  const older = newer === previous ? incoming : previous;
  if (!newer.tool || !older.tool) return newer;
  const needsInput = newer.tool.input === undefined && !newer.bodies?.input;
  return { ...newer, tool: { ...newer.tool,
    ...(newer.tool.name === '工具执行' ? { name: older.tool.name } : {}),
    ...(needsInput && older.tool.input !== undefined ? { input: older.tool.input } : {}),
  }, ...(needsInput && older.bodies?.input ? { bodies: { ...newer.bodies, input: older.bodies.input } } : {}) };
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
function operationFromRow(row: Row, payloadJson: string): Operation {
  const payload = parseJson(z.unknown(), payloadJson);
  const stored = z.object({ queueRecord: z.literal(true), content: z.unknown(), queuedInput: z.unknown() }).strict().safeParse(payload);
  const input = parse(operationInputSchema, { id: row.id, conversationId: row.conversation_id, type: row.type,
    ...(stored.success ? { payload: stored.data.content, queuedInput: stored.data.queuedInput } : { payload }) }, 'corrupt_workbench_data');
  return { ...input, sequence: Number(row.sequence), digest: String(row.digest), status: parse(statusSchema, row.status, 'corrupt_workbench_data'),
    runId: row.run_id === null ? null : String(row.run_id), reason: row.reason === null ? null : String(row.reason),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

function archiveJobFromRow(row: Row): ArchiveJob {
  return { conversationId: String(row.conversation_id), kind: row.kind as ArchiveJob['kind'], bindingId: String(row.binding_id),
    epoch: Number(row.epoch), cursor: row.cursor === null ? null : String(row.cursor), anchorId: row.anchor_id === null ? null : String(row.anchor_id),
    pages: Number(row.pages), complete: row.complete === 1, nextAt: Number(row.next_at), lastSuccessAt: row.last_success_at === null ? null : Number(row.last_success_at),
    error: row.error === null ? null : String(row.error), failures: Number(row.failures),
    scanGeneration: Number(row.scan_generation), targetId: row.target_id === null ? null : String(row.target_id),
    targetSeen: row.target_seen === 1, coverageError: row.coverage_error === null ? null : String(row.coverage_error), refreshAfter: row.refresh_after == null ? null : String(row.refresh_after), working: row.working === 1 };
}

/** Local durable facts; this module never calls a native Harness or retries an operation. */
export function createWorkbenchStore(db: DatabaseSync, options: { now?: () => number; onChange?: (event: WorkbenchChange) => void; capacity?: CapacityOptions } = {}): WorkbenchStore {
  const now = options.now ?? Date.now;
  const capacity = createCapacityGuard(db, options.capacity);
  const execution = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='execution_groups'").get() ? createExecutionAdmissionHooks(db) : undefined;
  const version = (): number => Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS version FROM workbench_changes').get()!.version);
  let nestedChange: ((conversationId: string, itemId?: string) => void) | undefined;
  const mutate = <T>(action: (changed: (conversationId: string, itemId?: string) => void) => T): T => {
    if (nestedChange) return action(nestedChange);
    const events: WorkbenchChange[] = [];
    const value = transaction(db, () => {
      const changed = new Map<string, string | undefined>();
      nestedChange = (id, itemId) => {
        if (!changed.has(id)) changed.set(id, itemId);
        else if (changed.get(id) !== itemId) changed.set(id, undefined);
      };
      let result: T;
      try { result = action(nestedChange); } finally { nestedChange = undefined; }
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
  const hasArchiveTables = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='workbench_archive_jobs'").get());
  const hasArchiveUpdates = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='workbench_archive_updates'").get());
  const bodies = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='workbench_bodies'").get() ? createBodyStore(db, {
    transientBytes: options.capacity?.transientBytes, assertRetentionCapacity: bytes => capacity.assertWritable('archive', bytes),
  }) : undefined;
  const operationPayloads = createOperationPayloadStore(db);
  const readOperation = (row: Row) => operationFromRow(row, operationPayloads.read(String(row.id), String(row.payload_json)));
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
    const row = operationRow(id); if (!row) throw new StoreError('operation_not_found', 404); return readOperation(row);
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
  const limitedTurnFiles = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='workbench_turn_files_limited'").get()
    ? db.prepare('SELECT 1 FROM workbench_turn_files_limited WHERE conversation_id=? AND run_id=?') : undefined;
  function recordTurnFiles(conversationId: string, item: NativeItem): boolean {
    if (item.kind !== 'tool' || item.status !== 'completed' || !item.runId || !item.fileEdits?.length && !item.fileEditsLimited) return false;
    const marked = item.fileEditsLimited && limitedTurnFiles
      ? Number(db.prepare('INSERT OR IGNORE INTO workbench_turn_files_limited VALUES(?,?)').run(conversationId, item.runId).changes) : 0;
    insertTurnFile ??= db.prepare('INSERT OR IGNORE INTO workbench_turn_files(conversation_id,run_id,path) VALUES(?,?,?)');
    countTurnFiles ??= db.prepare('SELECT COUNT(*) AS count FROM workbench_turn_files WHERE conversation_id=? AND run_id=?');
    // Keep one extra distinct target to signal truncation, without growing the per-turn index further.
    let count = Number(countTurnFiles.get(conversationId, item.runId)!.count);
    const before = count;
    for (const path of item.fileEdits ?? []) {
      if (count > turnFileLimit) break;
      count += Number(insertTurnFile.run(conversationId, item.runId, path).changes);
    }
    return count !== before || marked > 0;
  }
  const resources = createResourceStore(db, capacity.assertWritable);
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
  const metadata = (item: NativeItem) => JSON.stringify({ ...(item.images?.length ? { images: item.images } : {}), ...(item.references?.length ? { references: item.references } : {}), ...(item.tool ? { tool: item.tool } : {}), ...(item.bodies ? { bodies: item.bodies } : {}), ...(item.previewOnly ? { previewOnly: true } : {}), ...(item.mediaPending ? { mediaPending: true } : {}), ...(item.sourceRevision ? { sourceRevision: item.sourceRevision } : {}) });
  const preserveReplaced = (conversationId: string, incoming: NativeItem, canonicalExists = true): NativeItem => {
    const itemId = incoming.id;
    if (!bodies) return mergeNativeRevision(store.getItem(conversationId, itemId), incoming);
    const canonical = canonicalExists ? db.prepare('SELECT * FROM workbench_items WHERE conversation_id=? AND id=?').get(conversationId, itemId) : undefined;
    const live = db.prepare('SELECT * FROM workbench_live_items WHERE conversation_id=? AND id=?').get(conversationId, itemId);
    const previous: NativeItem[] = [];
    for (const [row, statement] of [[canonical, 'UPDATE workbench_items SET text=?,metadata_json=? WHERE conversation_id=? AND id=?'],
      [live, 'UPDATE workbench_live_items SET text=?,metadata_json=? WHERE conversation_id=? AND id=?']] as const) {
      if (!row) continue;
      const raw = itemFromRow(row);
      const projected = projectBodyPreview(raw);
      if (raw.text === projected.text && raw.tool?.input === projected.tool?.input && raw.tool?.output === projected.tool?.output && raw.references === projected.references) { previous.push(raw); continue; }
      capacity.assertWritable('archive', Buffer.byteLength(raw.text) + 4096);
      const preview = bodies.publish(conversationId, raw);
      bodies.confirmPublication(conversationId, preview);
      db.prepare(statement).run(preview.text, metadata(preview), conversationId, itemId);
      previous.push(preview);
    }
    // Match getItem's live-before-canonical precedence without another lookup.
    const accepted = mergeNativeRevision(previous.at(-1) ?? null, incoming);
    for (const old of previous) bodies.retainReplaced(conversationId, old, accepted);
    return accepted;
  };
  const store: WorkbenchStore = {
    resources,
    capacity: capacity.status,
    advanceStorageMaintenance() {
      // Collection releases space and must remain available after the admission
      // fence closes. Each command has independent row/byte bounds.
      capacity.status();
      return transaction(db, () => {
        const body = bodies?.maintenance() ?? false;
        const resource = resources.maintenance();
        const operation = operationPayloads.maintenance();
        return body || resource || operation || capacity.pending();
      });
    },
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
        execution?.assertWorkspaceAdmission(input.workspaceId);
        capacity.assertWritable('admission', 8192);
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
      }).strict(), value);
      return storage(() => {
        const before = input.beforeId ? requireConversation(input.beforeId) : null;
        return scanConversationIds(db, input, before, input.limit).ids.map(requireConversation);
      });
    },
    searchConversations(value = {}) {
      const input = parse(conversationPageInput, value);
      return storage(() => {
        const before = input.beforeId ? requireConversation(input.beforeId) : null;
        const { ids, ...page } = scanConversationIds(db, input, before);
        return { ...page, entries: ids.map(requireConversation) };
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
    setArchivedChecked(id, archived, expected) {
      return store.setArchived(id, archived, current => {
        if (current.readiness !== expected.readiness || JSON.stringify(current.state) !== JSON.stringify(expected.state) ||
          JSON.stringify(current.binding) !== JSON.stringify(expected.binding)) return false;
        if (!current.binding) return current.readiness === 'blocked' && current.state.pendingInputs === 0 && !['running', 'waiting'].includes(current.state.status);
        if (current.readiness !== 'ready' || !current.state.configurationVerified || current.state.pendingInputs ||
          !['idle', 'interrupted', 'failed'].includes(current.state.status) || hasQueue(id) || unsettledOperation(id)) return false;
        const previous = store.listOperations({ conversationId: id, status: 'accepted', type: 'message', order: 'desc', limit: 1 })[0];
        return !previous || previous.runId !== null && (previous.runId === current.state.runId || previous.runId === current.state.terminalRunId);
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
        if (hasArchiveTables) for (const kind of ['latest', 'backfill']) db.prepare('INSERT OR IGNORE INTO workbench_archive_jobs(conversation_id,kind,binding_id) VALUES(?,?,?)').run(id, kind, binding.id);
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
          if (existing.digest !== contentDigest || JSON.stringify(readOperation(existing).payload) !== JSON.stringify(input.payload)) throw new StoreError('operation_id_conflict', 409);
          return { operation: readOperation(existing), created: false };
        }
        const conversation = requireConversation(input.conversationId);
        assertWorkspaceActive(conversation.workspaceId);
        if (conversation.archived) throw new StoreError('conversation_archived', 409);
        if (input.type === 'message') capacity.assertWritable('admission', Buffer.byteLength(JSON.stringify(input)) + 8192);
        if (input.type === 'message') for (const image of input.payload.images ?? []) resources.pin(input.conversationId, image.id, input.id);
        const at = now();
        db.prepare(`INSERT INTO workbench_operations(id,conversation_id,type,payload_json,digest,status,created_at,updated_at)
          VALUES(?,?,?,?,?,'queued',?,?)`).run(input.id, input.conversationId, input.type, JSON.stringify(input.payload), contentDigest, at, at);
        execution?.admitOperation(input.id);
        if (input.type === 'stop' && hasQueue(input.conversationId)) setPause(input.conversationId, 'stopped');
        changed(input.conversationId);
        return { operation: requireOperation(input.id), created: true };
      });
    },
    getOperation(id) { parse(uuid, id); return storage(() => { const row = operationRow(id); return row ? readOperation(row) : null; }); },
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
        return rows.map(readOperation);
      });
    },
    claimOperation(id) {
      parse(uuid, id);
      return mutate(changed => {
        const row = db.prepare("UPDATE workbench_operations SET status='dispatching',updated_at=? WHERE id=? AND status='queued' RETURNING *").get(now(), id);
        if (row) { execution?.claimOperation(id); changed(String(row.conversation_id)); }
        return row ? readOperation(row) : null;
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
        execution?.settleReceipt(id, receipt.outcome);
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
    readOperationViews(conversationId) {
      parse(uuid, conversationId);
      return storage(() => {
        const rows = db.prepare(`SELECT id,type,status,run_id,substr(reason,1,256) AS reason,created_at,updated_at,
          CASE WHEN type='message' AND json_extract(payload_json,'$.queueRecord')=1 THEN json_extract(payload_json,'$.queuedInput.delivery') END AS delivery
          FROM workbench_operations WHERE conversation_id=? ORDER BY sequence DESC LIMIT 100`).iterate(conversationId);
        const result: WorkbenchOperation[] = [];
        for (const row of rows) result.push({ id: String(row.id), conversationId, type: row.type as 'message' | 'stop', status: row.status as OperationStatus,
          runId: row.run_id === null ? null : String(row.run_id), reason: row.reason === null ? null : String(row.reason),
          createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
          ...(row.delivery ? { delivery: parseJson(queueDeliverySchema, row.delivery) } : {}) });
        return result;
      });
    },
    operationState(conversationId) {
      parse(uuid, conversationId);
      return storage(() => {
        const unresolved = !!db.prepare("SELECT 1 FROM workbench_operations WHERE conversation_id=? AND status IN ('queued','dispatching','unknown') LIMIT 1").get(conversationId);
        const row = db.prepare("SELECT id,run_id FROM workbench_operations WHERE conversation_id=? AND type='message' AND status='accepted' ORDER BY sequence DESC LIMIT 1").get(conversationId);
        return { unresolved, latestAcceptedMessage: row ? { id: String(row.id), runId: row.run_id === null ? null : String(row.run_id) } : null };
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
    readQueueSummary(id) {
      const { entries, pause, version } = store.readQueue(id);
      return { pause, version, entries: entries.map(({ content, ...entry }) => ({ ...entry, preview: {
        text: [...content.text.slice(0, 400)].slice(0, 200).join(''), images: content.images?.length ?? 0,
        references: content.references?.length ?? 0, skills: content.skills?.length ?? 0,
      } })) };
    },
    readQueueEntry(id, entryId, version) {
      parse(uuid, id); parse(uuid, entryId); parse(z.number().int().nonnegative().safe(), version);
      return storage(() => {
        const row = db.prepare(`SELECT e.*,o.status AS operation_status FROM workbench_queue_entries e LEFT JOIN workbench_operations o ON o.id=e.operation_id
          WHERE e.conversation_id=? AND e.id=? AND e.content_json IS NOT NULL`).get(id, entryId);
        if (!row) throw new StoreError('queue_entry_not_found', 404);
        if (Number(row.version) !== version) throw new StoreError('queue_version_conflict', 409);
        return { entryId, version, content: parseJson(messagePayload, row.content_json),
          ...(row.skill_unavailable === 1 ? { skillUnavailable: true as const } : {}),
          status: row.operation_status === null ? (row.held ? 'held' as const : 'waiting' as const)
            : parse(z.enum(['dispatching', 'accepted', 'unknown']), row.operation_status, 'corrupt_workbench_data') };
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
          capacity.assertWritable('admission', Buffer.byteLength(JSON.stringify(command.content)) + 8192);
          const count = db.prepare('SELECT COUNT(*) AS active FROM workbench_queue_entries WHERE conversation_id=? AND content_json IS NOT NULL').get(id)!;
          if (Number(count.active) >= queueLimit) throw new StoreError('queue_full', 409);
          if (!count.active) {
            const pause = conversation.state.status === 'failed' ? 'failed' : conversation.state.status === 'interrupted' ? 'stopped' : null;
            db.prepare(`INSERT INTO workbench_queues(conversation_id,after_run_id,pause) VALUES(?,?,?)
              ON CONFLICT(conversation_id) DO UPDATE SET after_run_id=excluded.after_run_id,pause=excluded.pause`)
              .run(id, conversation.state.runId ?? null, pause);
          }
          setQueuePins(id, command.entryId, command.content);
          db.prepare('INSERT INTO workbench_queue_entries(id,conversation_id,content_json,admission_digest) VALUES(?,?,?,?)')
            .run(command.entryId, id, JSON.stringify(command.content), digest([id, command.content]));
          execution?.admitQueue(command.entryId);
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
          execution?.changeQueue(command.entryId, command.action);
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
        const content = parseJson(messagePayload, entry.content_json);
        if (skillRequiresNextTurn(delivery.mode, content)) throw new StoreError('queue_skill_requires_next_turn', 409);
        const queuedInput = { entryId, version, delivery };
        for (const image of content.images ?? []) resources.pin(id, image.id, operationId);
        const at = now();
        db.prepare(`INSERT INTO workbench_operations(id,conversation_id,type,payload_json,digest,status,created_at,updated_at)
          VALUES(?,?,'message',?,?,'dispatching',?,?)`).run(operationId, id,
            JSON.stringify({ queueRecord: true, content, queuedInput }), digest([id, content, queuedInput]), at, at);
        db.prepare('UPDATE workbench_queue_entries SET operation_id=?,held=0,skill_unavailable=0 WHERE id=? AND conversation_id=?').run(operationId, entryId, id);
        execution?.admitOperation(operationId, entryId);
        execution?.claimOperation(operationId);
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
      try { return mutate(changed => {
        requireConversation(conversationId);
        capacity.assertWritable('archive', items.reduce((bytes, item) => bytes + Buffer.byteLength(item.text) + 4096, 0));
        // The order allocator inserts empty positioning placeholders. They are
        // not published completed bodies and must never create retained empty
        // versions. Capture only the existing IDs, not full legacy payloads.
        const existing = new Set(db.prepare('SELECT id FROM workbench_items WHERE conversation_id=? AND id IN (SELECT value FROM json_each(?))')
          .all(conversationId, JSON.stringify([...incoming.keys()])).map(row => String(row.id)));
        const added = existing.size < incoming.size;
        const positions = allocateHistoryPositions(db, conversationId, [...incoming.keys()], beforeItemId);
        if (added) changed(conversationId);
        for (const raw of incoming.values()) {
          const accepted = preserveReplaced(conversationId, raw, existing.has(raw.id));
          const item = bodies?.publish(conversationId, accepted) ?? accepted;
          bodies?.confirmPublication(conversationId, item);
          const written = upsertItem.run(conversationId, item.id, positions.get(item.id)!, item.kind, item.text, item.status, item.runId ?? null, item.operationId ?? null, metadata(item));
          const removed = deleteLive.run(conversationId, item.id);
          const recorded = recordTurnFiles(conversationId, item);
          if (recorded || Number(written.changes) + Number(removed.changes) > 0) changed(conversationId);
        }
      }); } catch (error) {
        if (error instanceof StoreError && error.code === 'history_index_rebuild_required') requestHistoryRebuild(db, conversationId);
        throw error;
      }
    },
    saveLiveItem(conversationId, value) {
      parse(uuid, conversationId); const raw = parse(nativeItemSchema, value);
      return mutate(changed => {
        requireConversation(conversationId);
        capacity.assertWritable('archive', Buffer.byteLength(raw.text) + 4096);
        const accepted = preserveReplaced(conversationId, raw);
        const item = bodies?.publish(conversationId, accepted) ?? accepted;
        bodies?.confirmPublication(conversationId, item);
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
        return row ? projectBodyPreview(itemFromRow(row)) : null;
      });
    },
    readTurnFiles(conversationId, runIds, summaryOnly = false) {
      parse(uuid, conversationId); parse(z.array(identifier).max(200), runIds);
      if (!runIds.length) return [];
      return storage(() => {
        selectTurnFiles ??= db.prepare('SELECT path FROM workbench_turn_files WHERE conversation_id=? AND run_id=? ORDER BY path LIMIT ?');
        const summaries: TurnFileSummary[] = [];
        let remaining = 2 * 1024 * 1024;
        for (const runId of runIds) {
          const sourceLimited = !!limitedTurnFiles?.get(conversationId, runId);
          if (summaryOnly) {
            const count = Number(db.prepare('SELECT COUNT(*) AS n FROM workbench_turn_files WHERE conversation_id=? AND run_id=?').get(conversationId, runId)!.n);
            if (count || sourceLimited) summaries.push({ runId, paths: [], count: Math.min(count, turnFileLimit), limited: sourceLimited || count > turnFileLimit });
            continue;
          }
          const rows = selectTurnFiles.all(conversationId, runId, turnFileLimit + 1);
          if (!rows.length && !sourceLimited) continue;
          const summary = { runId, paths: rows.slice(0, turnFileLimit).map(row => String(row.path)), limited: sourceLimited || rows.length > turnFileLimit };
          remaining -= Buffer.byteLength(JSON.stringify(summary)) + 1;
          if (remaining < 0) break;
          summaries.push(summary);
        }
        return summaries;
      });
    },
    readTurnFilesPage(conversationId, runId, afterPath) {
      parse(uuid, conversationId); parse(identifier, runId); if (afterPath !== undefined) parse(recordedFilePath, afterPath);
      return storage(() => {
        const count = Number(db.prepare('SELECT COUNT(*) AS n FROM workbench_turn_files WHERE conversation_id=? AND run_id=?').get(conversationId, runId)!.n);
        // The existing per-turn record retains 500 paths plus one truncation sentinel.
        const last = db.prepare('SELECT path FROM workbench_turn_files WHERE conversation_id=? AND run_id=? ORDER BY path LIMIT 1 OFFSET ?').get(conversationId, runId, turnFileLimit - 1)?.path;
        const rows = last === undefined
          ? db.prepare('SELECT path FROM workbench_turn_files WHERE conversation_id=? AND run_id=? AND path>? ORDER BY path LIMIT 51').all(conversationId, runId, afterPath ?? '')
          : db.prepare('SELECT path FROM workbench_turn_files WHERE conversation_id=? AND run_id=? AND path>? AND path<=? ORDER BY path LIMIT 51').all(conversationId, runId, afterPath ?? '', last);
        const paths: string[] = []; let bytes = 0;
        for (const row of rows.slice(0, 50)) { const path = String(row.path); const size = Buffer.byteLength(JSON.stringify(path)) + 1; if (bytes + size > 48 * 1024) break; paths.push(path); bytes += size; }
        return { runId, paths, count: Math.min(count, turnFileLimit), limited: !!limitedTurnFiles?.get(conversationId, runId) || count > turnFileLimit,
          afterPath: paths.length < rows.length ? paths.at(-1) ?? null : null };
      });
    },
    advanceHistoryIndex() {
      capacity.assertWritable('archive', 65536);
      return storage(() => advanceHistoryRebuild(db));
    },
    readBody(...args) {
      if (!bodies) throw new StoreError('body_not_found', 404);
      return storage(() => bodies.read(...args));
    },
    beginBodyStage(...args) {
      if (!bodies) throw new StoreError('body_not_found', 404);
      capacity.assertWritable('archive', 4096);
      return transaction(db, () => bodies.begin(...args));
    },
    stageBodyChunk(...args) {
      if (!bodies) throw new StoreError('body_not_found', 404);
      capacity.assertWritable('archive', args[2].byteLength + 4096);
      return transaction(db, () => bodies.append(...args));
    },
    finishBodyStage(...args) {
      if (!bodies) throw new StoreError('body_not_found', 404);
      return storage(() => bodies.finish(...args));
    },
    validateBodyStage(...args) {
      if (!bodies) throw new StoreError('body_not_found', 404);
      return storage(() => bodies.validate(...args));
    },
    archiveJobs(conversationId) {
      parse(uuid, conversationId);
      return storage(() => {
        const pending = db.prepare("SELECT id FROM workbench_items WHERE conversation_id=? AND (status='running' OR json_extract(metadata_json,'$.previewOnly')=1 OR json_extract(metadata_json,'$.mediaPending')=1) LIMIT 1").get(conversationId)
          ?? db.prepare("SELECT id FROM workbench_live_items WHERE conversation_id=? AND (status='running' OR json_extract(metadata_json,'$.previewOnly')=1 OR json_extract(metadata_json,'$.mediaPending')=1) LIMIT 1").get(conversationId);
        return db.prepare('SELECT * FROM workbench_archive_jobs WHERE conversation_id=? ORDER BY kind').all(conversationId).map(row => {
          const job = archiveJobFromRow(row);
          if (job.kind === 'latest' && hasArchiveUpdates) {
            const updates = store.archiveUpdates(conversationId);
            job.updatesComplete = updates?.complete ?? false;
            job.updatesLastSuccessAt = updates?.lastSuccessAt ?? null;
          }
          return pending && !job.error ? { ...job, error: 'archive_items_pending' } : job;
        });
      });
    },
    pendingArchiveItems(conversationId, after) {
      parse(uuid, conversationId); if (after !== null) parse(identifier, after);
      return storage(() => {
        const canonical = db.prepare(`SELECT id FROM workbench_items WHERE conversation_id=? AND (status='running' OR json_extract(metadata_json,'$.previewOnly')=1 OR json_extract(metadata_json,'$.mediaPending')=1) AND id>? ORDER BY id LIMIT 16`).all(conversationId, after ?? '');
        const live = db.prepare(`SELECT id FROM workbench_live_items WHERE conversation_id=? AND (status='running' OR json_extract(metadata_json,'$.previewOnly')=1 OR json_extract(metadata_json,'$.mediaPending')=1) AND id>? ORDER BY id LIMIT 16`).all(conversationId, after ?? '');
        return [...new Set([...canonical, ...live].map(row => String(row.id)))].sort().slice(0, 16);
      });
    },
    refreshArchiveItems(job, values, requested) {
      const items = parse(z.array(nativeItemSchema).max(16), values);
      parse(z.array(identifier).max(16), requested);
      if (new Set(items.map(item => item.id)).size !== items.length || items.some(item => !requested.includes(item.id))) throw new StoreError('native_item_identity_changed', 502);
      mutate(changed => {
        const row = db.prepare('SELECT epoch,binding_id FROM workbench_archive_jobs WHERE conversation_id=? AND kind=?').get(job.conversationId, job.kind);
        if (!row || Number(row.epoch) !== job.epoch || row.binding_id !== job.bindingId || requireConversation(job.conversationId).binding?.id !== job.bindingId) return;
        for (const item of items) {
          if (!store.getItem(job.conversationId, item.id)) throw new StoreError('archive_item_not_found', 409);
          if (store.hasHistoryItem(job.conversationId, item.id)) store.mergeHistory(job.conversationId, [item]);
          else store.saveLiveItem(job.conversationId, item);
        }
        db.prepare('UPDATE workbench_archive_jobs SET refresh_after=?,error=? WHERE conversation_id=? AND kind=? AND epoch=?')
          .run(requested.at(-1) ?? null, items.length < requested.length ? 'archive_item_unavailable' : null, job.conversationId, job.kind, job.epoch);
        changed(job.conversationId);
      });
    },
    archiveUpdates(conversationId) {
      parse(uuid, conversationId);
      if (!hasArchiveUpdates) return null;
      return storage(() => {
        const row = db.prepare('SELECT cursor,complete,last_success_at FROM workbench_archive_updates WHERE conversation_id=?').get(conversationId);
        return row ? { cursor: row.cursor === null ? null : String(row.cursor), complete: row.complete === 1,
          lastSuccessAt: row.last_success_at === null ? null : Number(row.last_success_at) } : null;
      });
    },
    commitArchiveUpdates(job, expectedCursor, value, values) {
      parse(uuid, job.conversationId); parse(boundedText(65_536).nullable(), expectedCursor);
      const page = parse(z.object({ itemIds: z.array(identifier).max(16), cursor: boundedText(65_536).min(1), hasMore: z.boolean() }).strict(), value);
      const items = parse(z.array(nativeItemSchema).max(16), values);
      if (job.kind !== 'latest' || new Set(page.itemIds).size !== page.itemIds.length || new Set(items.map(item => item.id)).size !== items.length ||
        items.length !== page.itemIds.length || items.some(item => !page.itemIds.includes(item.id))) throw new StoreError('archive_update_identity_changed', 502);
      if (page.hasMore && page.cursor === expectedCursor) throw new StoreError('history_no_progress', 502);
      return mutate(changed => {
        if (!hasArchiveUpdates) throw new StoreError('archive_updates_unavailable', 503);
        const row = db.prepare('SELECT epoch,binding_id FROM workbench_archive_jobs WHERE conversation_id=? AND kind=?').get(job.conversationId, job.kind);
        const checkpoint = db.prepare('SELECT * FROM workbench_archive_updates WHERE conversation_id=?').get(job.conversationId);
        if (!row || Number(row.epoch) !== job.epoch || row.binding_id !== job.bindingId || checkpoint?.binding_id !== job.bindingId || checkpoint.cursor !== expectedCursor ||
          requireConversation(job.conversationId).binding?.id !== job.bindingId) return false;
        // Changes never invent an ordering position. A newly appended item must
        // first enter through chronological history; retry the same feed cursor
        // after that path catches up instead of silently skipping unknown IDs.
        if (items.some(item => !store.hasHistoryItem(job.conversationId, item.id))) throw new StoreError('archive_update_waiting_for_history', 409);
        for (const item of items) {
          const previous = store.getItem(job.conversationId, item.id);
          if (previous?.sourceRevision && item.sourceRevision && previous.sourceRevision.generation !== item.sourceRevision.generation)
            db.prepare("UPDATE workbench_archive_jobs SET coverage_error='archive_source_gap' WHERE conversation_id=? AND kind='latest'").run(job.conversationId);
        }
        // Feed order is append/revision order, not chronological item order.
        // All IDs were checked above; update one existing position at a time
        // inside this same outer transaction instead of reordering the page.
        for (const item of items) store.mergeHistory(job.conversationId, [item]);
        db.prepare('UPDATE workbench_archive_updates SET cursor=?,complete=?,last_success_at=? WHERE conversation_id=?').run(page.cursor, page.hasMore ? 0 : 1, now(), job.conversationId);
        db.prepare("UPDATE workbench_archive_jobs SET next_at=?,working=?,error=NULL,failures=0 WHERE conversation_id=? AND kind='latest'")
          .run(now() + (page.hasMore ? 1 : 15_000), page.hasMore ? 1 : 0, job.conversationId);
        changed(job.conversationId); return true;
      });
    },
    resetArchiveUpdates(job, expectedCursor) {
      parse(uuid, job.conversationId); parse(boundedText(65_536).nullable(), expectedCursor);
      mutate(changed => {
        if (!hasArchiveUpdates || job.kind !== 'latest') return;
        const row = db.prepare("SELECT epoch,binding_id FROM workbench_archive_jobs WHERE conversation_id=? AND kind='latest'").get(job.conversationId);
        if (!row || Number(row.epoch) !== job.epoch || row.binding_id !== job.bindingId) return;
        const result = db.prepare('UPDATE workbench_archive_updates SET cursor=NULL,complete=0 WHERE conversation_id=? AND binding_id=? AND cursor IS ?')
          .run(job.conversationId, job.bindingId, expectedCursor);
        if (!Number(result.changes)) return;
        db.prepare("UPDATE workbench_archive_jobs SET coverage_error='archive_continuity_unverified',next_at=? WHERE conversation_id=? AND kind='latest'").run(now() + 1000, job.conversationId);
        changed(job.conversationId);
      });
    },
    dueArchiveJobs(limit = 8) {
      parse(z.number().int().min(1).max(64), limit);
      return storage(() => db.prepare('SELECT * FROM workbench_archive_jobs WHERE complete=0 AND next_at<=? ORDER BY next_at,conversation_id,kind LIMIT ?').all(now(), limit).map(archiveJobFromRow));
    },
    claimArchiveJob(conversationId, kind, force = false) {
      parse(uuid, conversationId); parse(z.enum(['latest', 'backfill']), kind);
      return transaction(db, () => {
        const row = db.prepare('SELECT * FROM workbench_archive_jobs WHERE conversation_id=? AND kind=?').get(conversationId, kind);
        if (!row || row.complete === 1 || (!force && Number(row.next_at) > now())) return null;
        if (row.cursor === null) {
          const active = activeHistoryOrder(db, conversationId);
          const head = db.prepare(active === 0 ? 'SELECT id FROM workbench_items WHERE conversation_id=? ORDER BY position DESC LIMIT 1' : 'SELECT id FROM workbench_items WHERE conversation_id=? AND alternate_position IS NOT NULL ORDER BY alternate_position DESC LIMIT 1').get(conversationId);
          db.prepare('UPDATE workbench_archive_jobs SET target_id=?,target_seen=0 WHERE conversation_id=? AND kind=?').run(head ? String(head.id) : null, conversationId, kind);
        }
        db.prepare('UPDATE workbench_archive_jobs SET epoch=epoch+1,working=1,next_at=? WHERE conversation_id=? AND kind=?').run(now() + 30_000, conversationId, kind);
        if (kind === 'latest' && hasArchiveUpdates) db.prepare('UPDATE workbench_archive_updates SET complete=0 WHERE conversation_id=?').run(conversationId);
        return archiveJobFromRow(db.prepare('SELECT * FROM workbench_archive_jobs WHERE conversation_id=? AND kind=?').get(conversationId, kind)!);
      });
    },
    commitArchivePage(job, values, olderCursor) {
      parse(uuid, job.conversationId); parse(z.enum(['latest', 'backfill']), job.kind);
      if (olderCursor !== null) parse(boundedText(65_536).min(1), olderCursor);
      const items = parse(z.array(nativeItemSchema).max(100), values);
      try { return mutate(changed => {
        const row = db.prepare('SELECT * FROM workbench_archive_jobs WHERE conversation_id=? AND kind=?').get(job.conversationId, job.kind);
        if (!row || Number(row.epoch) !== job.epoch || String(row.binding_id) !== job.bindingId || requireConversation(job.conversationId).binding?.id !== job.bindingId) return false;
        if (olderCursor && (olderCursor === job.cursor || db.prepare('SELECT 1 FROM workbench_archive_scan_cursors WHERE conversation_id=? AND kind=? AND generation=? AND digest=?')
          .get(job.conversationId, job.kind, job.scanGeneration, digest(olderCursor)))) throw new StoreError('history_no_progress', 502);
        const known = items.some(item => store.hasHistoryItem(job.conversationId, item.id) && !db.prepare('SELECT 1 FROM workbench_archive_scan_items WHERE conversation_id=? AND kind=? AND generation=? AND id=?')
          .get(job.conversationId, job.kind, job.scanGeneration, item.id));
        // A historical page may overlap a more recent head read. Its older body
        // is never allowed to replace an already published version.
        let coverageError = job.coverageError;
        const incoming = items.map(item => {
          const previous = store.getItem(job.conversationId, item.id);
          if (previous?.sourceRevision && item.sourceRevision && previous.sourceRevision.generation !== item.sourceRevision.generation) coverageError = 'archive_source_gap';
          if (previous?.sourceRevision) return mergeNativeRevision(previous, item);
          return job.cursor !== null || job.kind === 'backfill' ? previous ?? item : item;
        });
        store.mergeHistory(job.conversationId, incoming, job.anchorId ?? undefined);
        const targetSeen = !job.targetId || job.targetSeen || items.some(item => item.id === job.targetId);
        const done = !olderCursor || (job.kind === 'latest' && known && targetSeen);
        const nextCursor = done ? null : olderCursor;
        const nextAnchor = nextCursor ? items[0]?.id ?? job.anchorId : null;
        if (done) {
          db.prepare('INSERT INTO workbench_archive_gc VALUES(?,?,?) ON CONFLICT(conversation_id,kind) DO UPDATE SET through_generation=MAX(through_generation,excluded.through_generation)').run(job.conversationId, job.kind, job.scanGeneration);
        } else {
          for (const item of items) db.prepare('INSERT OR IGNORE INTO workbench_archive_scan_items VALUES(?,?,?,?)').run(job.conversationId, job.kind, job.scanGeneration, item.id);
          db.prepare('INSERT INTO workbench_archive_scan_cursors VALUES(?,?,?,?)').run(job.conversationId, job.kind, job.scanGeneration, digest(olderCursor));
        }
        db.prepare(`UPDATE workbench_archive_jobs SET cursor=?,anchor_id=?,pages=pages+1,complete=?,next_at=?,last_success_at=?,error=NULL,failures=0,scan_generation=?,target_seen=?,coverage_error=?,working=?
          WHERE conversation_id=? AND kind=? AND epoch=?`).run(nextCursor, nextAnchor, Number(done && job.kind === 'backfill'),
          now() + (done && job.kind === 'latest' ? 15_000 : 1), now(), job.scanGeneration + Number(done), Number(targetSeen),
          !olderCursor && !targetSeen ? 'archive_source_gap' : coverageError, Number(!done), job.conversationId, job.kind, job.epoch);
        if (job.kind === 'backfill') store.setHistoryCursor(job.conversationId, { loaded: true, olderCursor: nextCursor, beforeItemId: nextAnchor });
        else if (!requireConversation(job.conversationId).historyLoaded) store.setHistoryCursor(job.conversationId, { loaded: true, olderCursor, beforeItemId: olderCursor ? items[0]?.id ?? null : null });
        changed(job.conversationId);
        return true;
      }); } catch (error) {
        if (error instanceof StoreError && error.code === 'history_index_rebuild_required') requestHistoryRebuild(db, job.conversationId);
        throw error;
      }
    },
    yieldArchiveJob(job) {
      parse(uuid, job.conversationId); parse(z.enum(['latest', 'backfill']), job.kind);
      mutate(changed => {
        const result = db.prepare('UPDATE workbench_archive_jobs SET working=1,next_at=?,error=NULL WHERE conversation_id=? AND kind=? AND epoch=?').run(now() + 1, job.conversationId, job.kind, job.epoch);
        if (Number(result.changes)) changed(job.conversationId);
      });
    },
    failArchiveJob(job, reason) {
      parse(uuid, job.conversationId); parse(z.enum(['latest', 'backfill']), job.kind); parse(boundedText(256), reason);
      mutate(changed => {
        const result = db.prepare('UPDATE workbench_archive_jobs SET error=?,failures=failures+1,next_at=? WHERE conversation_id=? AND kind=? AND epoch=?')
          .run(reason, now() + Math.min(60_000, 1000 * 2 ** Math.min(job.failures, 6)), job.conversationId, job.kind, job.epoch);
        if (Number(result.changes)) changed(job.conversationId);
      });
    },
    restartArchiveJob(job, reason) {
      parse(uuid, job.conversationId); parse(z.enum(['latest', 'backfill']), job.kind); parse(boundedText(256), reason);
      mutate(changed => {
        const result = db.prepare(`UPDATE workbench_archive_jobs SET epoch=epoch+1,scan_generation=scan_generation+1,
          cursor=NULL,anchor_id=NULL,complete=0,target_seen=0,coverage_error='archive_continuity_unverified',error=?,failures=failures+1,next_at=?
          WHERE conversation_id=? AND kind=? AND epoch=?`).run(reason, now() + 1000, job.conversationId, job.kind, job.epoch);
        if (!Number(result.changes)) return;
        db.prepare('INSERT INTO workbench_archive_gc VALUES(?,?,?) ON CONFLICT(conversation_id,kind) DO UPDATE SET through_generation=MAX(through_generation,excluded.through_generation)').run(job.conversationId, job.kind, job.scanGeneration);
        changed(job.conversationId);
      });
    },
    advanceArchiveMaintenance() {
      return transaction(db, () => {
        const job = db.prepare('SELECT * FROM workbench_archive_gc ORDER BY conversation_id,kind LIMIT 1').get();
        if (!job) return false;
        const args = [String(job.conversation_id), String(job.kind), Number(job.through_generation)];
        const items = db.prepare(`DELETE FROM workbench_archive_scan_items WHERE (conversation_id,kind,generation,id) IN
          (SELECT conversation_id,kind,generation,id FROM workbench_archive_scan_items WHERE conversation_id=? AND kind=? AND generation<=? LIMIT 512)`).run(...args);
        const cursors = db.prepare(`DELETE FROM workbench_archive_scan_cursors WHERE (conversation_id,kind,generation,digest) IN
          (SELECT conversation_id,kind,generation,digest FROM workbench_archive_scan_cursors WHERE conversation_id=? AND kind=? AND generation<=? LIMIT 512)`).run(...args);
        if (Number(items.changes) < 512 && Number(cursors.changes) < 512) db.prepare('DELETE FROM workbench_archive_gc WHERE conversation_id=? AND kind=?').run(args[0]!, args[1]!);
        return true;
      });
    },
    readHistory(conversationId, value = {}) {
      parse(uuid, conversationId);
      const input = parse(z.object({ beforeItemId: identifier.optional(), limit: z.number().int().min(1).max(100).default(100) }).strict(), value);
      return transaction(db, () => {
        const conversation = requireConversation(conversationId);
        const active = activeHistoryOrder(db, conversationId);
        const before = input.beforeItemId === undefined ? null : db.prepare(active === 0 ? 'SELECT position FROM workbench_items WHERE conversation_id=? AND id=?' : 'SELECT alternate_position AS position FROM workbench_items WHERE conversation_id=? AND id=?').get(conversationId, input.beforeItemId);
        if (input.beforeItemId !== undefined && !before) throw new StoreError('history_anchor_not_found', 404);
        // Iterate legacy rows one at a time. Only finite previews and immutable
        // full-body references cross the storage worker boundary.
        const rows = before
          ? db.prepare(active === 0 ? 'SELECT * FROM workbench_items WHERE conversation_id=? AND position<? ORDER BY position DESC LIMIT ?' : 'SELECT * FROM workbench_items WHERE conversation_id=? AND alternate_position<? ORDER BY alternate_position DESC LIMIT ?').iterate(conversationId, Number(before.position), input.limit + 1)
          : db.prepare(active === 0 ? 'SELECT * FROM workbench_items WHERE conversation_id=? ORDER BY position DESC LIMIT ?' : 'SELECT * FROM workbench_items WHERE conversation_id=? AND alternate_position IS NOT NULL ORDER BY alternate_position DESC LIMIT ?').iterate(conversationId, input.limit + 1);
        const items: NativeItem[] = []; let bytes = 0; let hasOlder = false;
        for (const row of rows) {
          const item = projectBodyPreview(itemFromRow(row)); bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
          if (!items.length && bytes > 192 * 1024) throw new StoreError('history_preview_budget_exceeded', 503);
          if (items.length >= input.limit || bytes > 192 * 1024) { hasOlder = true; break; }
          items.push(item);
        }
        items.reverse();
        const liveItems: NativeItem[] = []; let liveBytes = 0; let liveItemsLimited = false;
        for (const row of db.prepare('SELECT * FROM workbench_live_items WHERE conversation_id=? ORDER BY updated_at DESC,id DESC LIMIT ?').iterate(conversationId, MAX_LIVE_ITEMS)) {
          const item = projectBodyPreview(itemFromRow(row)); liveBytes += Buffer.byteLength(JSON.stringify(item)) + 1;
          if (liveBytes > 48 * 1024) { liveItemsLimited = true; break; }
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

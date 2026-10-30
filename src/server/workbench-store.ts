import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Binding, Configuration, HarnessId, NativeItem, NativeState, Receipt } from '../harness/types.ts';

export type Readiness = 'preparing' | 'ready' | 'blocked';
export type Conversation = {
  id: string; harnessId: HarnessId; workspaceId: string; cwd: string; title: string;
  configuration: Configuration; binding: Binding | null; readiness: Readiness;
  state: NativeState; error: string | null; createdAt: number;
  historyLoaded: boolean; nativeOlderCursor: string | null; nativeOlderBeforeItemId: string | null;
};
export type CreateConversation = Pick<Conversation, 'id' | 'harnessId' | 'workspaceId' | 'cwd' | 'configuration'> & { title?: string };
export type OperationStatus = 'queued' | 'dispatching' | 'accepted' | 'unknown' | 'rejected';
export type OperationInput = { id: string; conversationId: string } & (
  { type: 'message'; payload: { text: string } } | { type: 'stop'; payload: { runId: string } }
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
  historyLoaded: boolean; nativeOlderCursor: string | null; nativeOlderBeforeItemId: string | null;
};
export type ListOperations = { conversationId?: string; status?: OperationStatus; type?: 'message' | 'stop'; order?: 'asc' | 'desc'; afterId?: string; limit?: number };
export interface WorkbenchStore {
  createConversation(input: CreateConversation): { conversation: Conversation; created: boolean };
  getConversation(id: string): Conversation | null;
  listConversations(options?: { beforeId?: string; limit?: number }): Conversation[];
  saveBinding(id: string, binding: Binding): Conversation;
  setConversationState(id: string, change: { readiness?: Readiness; state?: NativeState; error?: string | null }): Conversation;
  setHistoryCursor(id: string, cursor: { loaded: boolean; olderCursor: string | null; beforeItemId: string | null }): Conversation;
  enqueueOperation(input: OperationInput): { operation: Operation; created: boolean };
  getOperation(id: string): Operation | null;
  listOperations(options?: ListOperations): Operation[];
  claimOperation(id: string): Operation | null;
  settleOperation(id: string, receipt: Receipt): Operation;
  recoverDispatching(): number;
  changes(after: number, limit?: number): { events: WorkbenchChange[]; latest: number; reset: boolean };
  version(): number;
  mergeHistory(conversationId: string, items: NativeItem[], beforeItemId?: string): void;
  saveLiveItem(conversationId: string, item: NativeItem): void;
  getItem(conversationId: string, itemId: string): NativeItem | null;
  hasHistoryItem(conversationId: string, itemId: string): boolean;
  operationRunId(conversationId: string, operationId: string): string | null;
  readHistory(conversationId: string, options?: { beforeItemId?: string; limit?: number }): HistorySnapshot;
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
const nativeStateSchema = z.object({
  status: z.enum(['idle', 'running', 'waiting', 'interrupted', 'failed', 'unknown']),
  runId: identifier.optional(), pendingInputs: z.number().int().min(0).max(1_000_000),
  configurationVerified: z.boolean(), reason: boundedText(4096).optional(),
}).strict();
const itemSchema = z.object({
  id: identifier, kind: z.enum(['user', 'assistant', 'tool', 'notice']), text: boundedText(MAX_TEXT_BYTES),
  status: z.enum(['running', 'completed', 'failed']), runId: identifier.optional(), operationId: identifier.optional(),
}).strict();
const bindingSchema = z.object({
  id: identifier, cwd: boundedText(4096).min(1), configuration: configurationSchema, details: z.record(z.string(), z.unknown()),
}).strict();
const createConversationSchema = z.object({
  id: uuid, harnessId: z.enum(['codex', 'dsh']), workspaceId: identifier, cwd: boundedText(4096).min(1),
  configuration: configurationSchema, title: boundedText(200).min(1).optional(),
}).strict();
const operationInputSchema = z.discriminatedUnion('type', [
  z.object({ id: uuid, conversationId: uuid, type: z.literal('message'), payload: z.object({ text: boundedText(MAX_TEXT_BYTES).min(1) }).strict() }).strict(),
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
    id: row.id, kind: row.kind, text: row.text, status: row.status,
    ...(row.run_id === null ? {} : { runId: row.run_id }), ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
  }, 'corrupt_workbench_data');
}
function conversationFromRow(row: Row): Conversation {
  return {
    id: String(row.id), harnessId: parse(z.enum(['codex', 'dsh']), row.harness_id, 'corrupt_workbench_data'),
    workspaceId: String(row.workspace_id), cwd: String(row.cwd), title: String(row.title),
    configuration: parseJson(configurationSchema, row.configuration_json), binding: row.binding_json === null ? null : parseJson(bindingSchema, row.binding_json),
    readiness: parse(z.enum(['preparing', 'ready', 'blocked']), row.readiness, 'corrupt_workbench_data'),
    state: parseJson(nativeStateSchema, row.state_json), error: row.error === null ? null : String(row.error), createdAt: Number(row.created_at),
    historyLoaded: row.history_loaded === 1, nativeOlderCursor: row.native_older_cursor === null ? null : String(row.native_older_cursor),
    nativeOlderBeforeItemId: row.native_older_before_item_id === null ? null : String(row.native_older_before_item_id),
  };
}
function operationFromRow(row: Row): Operation {
  const payload = parseJson(z.unknown(), row.payload_json);
  const input = parse(operationInputSchema, { id: row.id, conversationId: row.conversation_id, type: row.type, payload }, 'corrupt_workbench_data');
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
  const requireConversation = (id: string): Conversation => {
    const row = conversationRow(id); if (!row) throw new StoreError('conversation_not_found', 404); return conversationFromRow(row);
  };
  const operationRow = (id: string) => db.prepare('SELECT * FROM workbench_operations WHERE id = ?').get(id);
  const requireOperation = (id: string): Operation => {
    const row = operationRow(id); if (!row) throw new StoreError('operation_not_found', 404); return operationFromRow(row);
  };
  const upsertItem = db.prepare(`INSERT INTO workbench_items(conversation_id,id,position,kind,text,status,run_id,operation_id)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id,id) DO UPDATE SET kind=excluded.kind,text=excluded.text,
    status=excluded.status,run_id=excluded.run_id,operation_id=excluded.operation_id
    WHERE workbench_items.kind IS NOT excluded.kind OR workbench_items.text IS NOT excluded.text
      OR workbench_items.status IS NOT excluded.status OR workbench_items.run_id IS NOT excluded.run_id
      OR workbench_items.operation_id IS NOT excluded.operation_id`);
  const deleteLive = db.prepare('DELETE FROM workbench_live_items WHERE conversation_id = ? AND id = ?');
  const store: WorkbenchStore = {
    createConversation(value) {
      const input = parse(createConversationSchema, value);
      const creationDigest = digest([input.harnessId, input.workspaceId, input.cwd, input.configuration.modelId, input.configuration.permissionId]);
      return mutate(changed => {
        const existing = conversationRow(input.id);
        if (existing) {
          if (existing.creation_digest !== creationDigest) throw new StoreError('conversation_id_conflict', 409);
          return { conversation: conversationFromRow(existing), created: false };
        }
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
      const input = parse(z.object({ beforeId: uuid.optional(), limit: z.number().int().min(1).max(1000).default(100) }).strict(), value);
      return storage(() => {
        const before = input.beforeId ? requireConversation(input.beforeId) : null;
        const rows = before
          ? db.prepare('SELECT * FROM workbench_conversations WHERE (created_at,id) < (?,?) ORDER BY created_at DESC,id DESC LIMIT ?').all(before.createdAt, before.id, input.limit)
          : db.prepare('SELECT * FROM workbench_conversations ORDER BY created_at DESC,id DESC LIMIT ?').all(input.limit);
        return rows.map(conversationFromRow);
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
      const contentDigest = digest([input.conversationId, input.type, input.type === 'message' ? input.payload.text : input.payload.runId]);
      return mutate(changed => {
        const existing = operationRow(input.id);
        if (existing) {
          if (existing.digest !== contentDigest) throw new StoreError('operation_id_conflict', 409);
          return { operation: operationFromRow(existing), created: false };
        }
        requireConversation(input.conversationId);
        const count = Number(db.prepare('SELECT COUNT(*) AS count FROM workbench_operations WHERE conversation_id=?').get(input.conversationId)!.count);
        if (count >= 50_000) throw new StoreError('operation_capacity_reached', 409);
        const at = now();
        db.prepare(`INSERT INTO workbench_operations(id,conversation_id,type,payload_json,digest,status,created_at,updated_at)
          VALUES(?,?,?,?,?,'queued',?,?)`).run(input.id, input.conversationId, input.type, JSON.stringify(input.payload), contentDigest, at, at);
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
      const items = parse(z.array(itemSchema).max(1000), value);
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
          const written = upsertItem.run(conversationId, item.id, positions.get(item.id)!, item.kind, item.text, item.status, item.runId ?? null, item.operationId ?? null);
          const removed = deleteLive.run(conversationId, item.id);
          if (Number(written.changes) + Number(removed.changes) > 0) changed(conversationId);
        }
      });
    },
    saveLiveItem(conversationId, value) {
      parse(uuid, conversationId); const item = parse(itemSchema, value);
      return mutate(changed => {
        requireConversation(conversationId);
        const canonical = db.prepare('SELECT position FROM workbench_items WHERE conversation_id=? AND id=?').get(conversationId, item.id);
        if (canonical) {
          const written = upsertItem.run(conversationId, item.id, Number(canonical.position), item.kind, item.text, item.status, item.runId ?? null, item.operationId ?? null);
          const removed = deleteLive.run(conversationId, item.id);
          if (Number(written.changes) + Number(removed.changes) > 0) changed(conversationId, item.id);
          return;
        }
        const existing = db.prepare('SELECT id FROM workbench_live_items WHERE conversation_id=? AND id=?').get(conversationId, item.id);
        if (!existing && Number(db.prepare('SELECT COUNT(*) AS count FROM workbench_live_items WHERE conversation_id=?').get(conversationId)!.count) >= MAX_LIVE_ITEMS)
          throw new StoreError('live_history_capacity_reached', 409);
        const written = db.prepare(`INSERT INTO workbench_live_items(conversation_id,id,kind,text,status,run_id,operation_id,updated_at) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(conversation_id,id) DO UPDATE SET kind=excluded.kind,text=excluded.text,status=excluded.status,
          run_id=excluded.run_id,operation_id=excluded.operation_id,updated_at=excluded.updated_at
          WHERE workbench_live_items.kind IS NOT excluded.kind OR workbench_live_items.text IS NOT excluded.text
            OR workbench_live_items.status IS NOT excluded.status OR workbench_live_items.run_id IS NOT excluded.run_id
            OR workbench_live_items.operation_id IS NOT excluded.operation_id`)
          .run(conversationId, item.id, item.kind, item.text, item.status, item.runId ?? null, item.operationId ?? null, now());
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
        const row = db.prepare(`SELECT id,kind,text,status,run_id,operation_id FROM workbench_live_items WHERE conversation_id=? AND id=?
          UNION ALL SELECT id,kind,text,status,run_id,operation_id FROM workbench_items WHERE conversation_id=? AND id=? LIMIT 1`)
          .get(conversationId, itemId, conversationId, itemId);
        return row ? itemFromRow(row) : null;
      });
    },
    readHistory(conversationId, value = {}) {
      parse(uuid, conversationId);
      const input = parse(z.object({ beforeItemId: identifier.optional(), limit: z.number().int().min(1).max(100).default(100) }).strict(), value);
      return transaction(db, () => {
        const conversation = requireConversation(conversationId);
        const before = input.beforeItemId === undefined ? null : db.prepare('SELECT position FROM workbench_items WHERE conversation_id=? AND id=?').get(conversationId, input.beforeItemId);
        if (input.beforeItemId !== undefined && !before) throw new StoreError('history_anchor_not_found', 404);
        const rows = before
          ? db.prepare('SELECT * FROM workbench_items WHERE conversation_id=? AND position<? ORDER BY position DESC LIMIT ?').all(conversationId, Number(before.position), input.limit + 1)
          : db.prepare('SELECT * FROM workbench_items WHERE conversation_id=? ORDER BY position DESC LIMIT ?').all(conversationId, input.limit + 1);
        const hasOlder = rows.length > input.limit;
        const items = rows.slice(0, input.limit).reverse().map(itemFromRow);
        const liveItems = db.prepare('SELECT * FROM workbench_live_items WHERE conversation_id=? ORDER BY updated_at,id LIMIT ?').all(conversationId, MAX_LIVE_ITEMS).map(itemFromRow);
        return { revision: version(), items, liveItems, olderBeforeItemId: hasOlder ? items[0]!.id : null, historyLoaded: conversation.historyLoaded,
          nativeOlderCursor: conversation.nativeOlderCursor, nativeOlderBeforeItemId: conversation.nativeOlderBeforeItemId };
      }, 'read');
    },
  };
  return store;
}

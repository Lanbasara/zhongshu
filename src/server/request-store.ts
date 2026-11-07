import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { requestAnswerSchema, requestIdSchema } from '../shared/workbench.ts';
import type { RequestAnswer, RequestAnswerView } from '../shared/workbench.ts';
import type { Receipt } from '../harness/types.ts';

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const status = z.enum(['queued', 'dispatching', 'accepted', 'unknown', 'rejected']);
const row = z.object({ id: z.uuid(), conversation_id: z.uuid(), request_id: requestIdSchema, status, reason: z.string().max(4096).nullable(),
  summary: z.string().max(2000), answer_json: z.string().nullable(), updated_at: time });
export type RequestAnswerRecord = { id: string; conversationId: string; requestId: string; status: z.infer<typeof status>; reason: string | null; summary: string; answer: RequestAnswer | null; updatedAt: number };
const fromRow = (value: unknown): RequestAnswerRecord => {
  const parsed = row.parse(value);
  return { id: parsed.id, conversationId: parsed.conversation_id, requestId: parsed.request_id, status: parsed.status, reason: parsed.reason, summary: parsed.summary,
    answer: parsed.answer_json === null ? null : requestAnswerSchema.parse(JSON.parse(parsed.answer_json)), updatedAt: parsed.updated_at };
};
export const answerView = (record: RequestAnswerRecord): RequestAnswerView =>
  ({ id: record.id, status: record.status, reason: record.reason, updatedAt: record.updatedAt, ...(record.summary ? { summary: record.summary } : {}) });

export class RequestStoreError extends Error {
  readonly code: string; readonly statusCode: number;
  constructor(code: string, statusCode: number) { super(code); this.name = 'RequestStoreError'; this.code = code; this.statusCode = statusCode; }
}
const columns = 'id,conversation_id,request_id,status,reason,summary,answer_json,updated_at';

/**
 * Answers to native requests (ADR 0016). The request lives in the native Harness; this store keeps only
 * the answer's identity, its delivery status and a short summary. The submitted answer is cleared as soon
 * as delivery settles, and an unknown delivery is never resent.
 */
export function createRequestStore(db: DatabaseSync, notify: (event: { sequence: number; conversationId: string }) => void, now = Date.now) {
  const emit = (id: string) => {
    const result = db.prepare('INSERT INTO workbench_changes(conversation_id,created_at) VALUES(?,?)').run(id, now());
    return { sequence: Number(result.lastInsertRowid), conversationId: id };
  };
  const publish = (event: { sequence: number; conversationId: string } | undefined) => {
    if (!event) return;
    try { notify(event); } catch { /* The durable change cursor replays committed changes. */ }
  };
  const get = (id: string): RequestAnswerRecord | null => {
    z.uuid().parse(id);
    const value = db.prepare(`SELECT ${columns} FROM workbench_request_answers WHERE id=?`).get(id);
    return value ? fromRow(value) : null;
  };
  return {
    get,
    /** The latest answer submitted for one request, in any status. */
    latest(conversationId: string, requestId: string): RequestAnswerRecord | null {
      const value = db.prepare(`SELECT ${columns} FROM workbench_request_answers WHERE conversation_id=? AND request_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(z.uuid().parse(conversationId), requestIdSchema.parse(requestId));
      return value ? fromRow(value) : null;
    },
    /** Same identity and target is the same answer; a different target is a conflict. */
    enqueue(input: { id: string; conversationId: string; requestId: string; answer: RequestAnswer; summary: string }): { answer: RequestAnswerRecord; created: boolean } {
      z.uuid().parse(input.id); z.uuid().parse(input.conversationId); requestIdSchema.parse(input.requestId);
      const answer = requestAnswerSchema.parse(input.answer); const summary = z.string().max(2000).parse(input.summary);
      const existing = get(input.id);
      if (existing) {
        if (existing.conversationId !== input.conversationId || existing.requestId !== input.requestId) throw new RequestStoreError('operation_id_conflict', 409);
        return { answer: existing, created: false };
      }
      const at = now();
      const event = transaction(db, () => {
        db.prepare("INSERT INTO workbench_request_answers(id,conversation_id,request_id,status,summary,answer_json,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,?)")
          .run(input.id, input.conversationId, input.requestId, summary, JSON.stringify(answer), at, at);
        return emit(input.conversationId);
      });
      publish(event);
      return { answer: get(input.id)!, created: true };
    },
    claim(id: string): RequestAnswerRecord | null {
      const result = db.prepare("UPDATE workbench_request_answers SET status='dispatching',updated_at=? WHERE id=? AND status='queued'").run(now(), z.uuid().parse(id));
      return result.changes ? get(id) : null;
    },
    settle(id: string, receipt: Receipt): RequestAnswerRecord {
      const current = get(id);
      if (!current) throw new RequestStoreError('operation_not_found', 404);
      if (current.status === 'accepted' || current.status === 'rejected') return current;
      const reason = receipt.outcome === 'accepted' ? null : z.string().max(4096).parse(receipt.reason);
      const event = transaction(db, () => {
        db.prepare('UPDATE workbench_request_answers SET status=?,reason=?,answer_json=NULL,updated_at=? WHERE id=?').run(receipt.outcome, reason, now(), id);
        return emit(current.conversationId);
      });
      publish(event);
      return get(id)!;
    },
    /** Answers whose delivery is not settled keep the conversation under observation. */
    busy(conversationId: string): boolean {
      return !!db.prepare("SELECT 1 FROM workbench_request_answers WHERE conversation_id=? AND status IN ('queued','dispatching','unknown') LIMIT 1").get(z.uuid().parse(conversationId));
    },
    unsettled(conversationId: string): RequestAnswerRecord[] {
      return db.prepare(`SELECT ${columns} FROM workbench_request_answers WHERE conversation_id=? AND status IN ('queued','dispatching','unknown') ORDER BY created_at LIMIT 64`).all(z.uuid().parse(conversationId)).map(fromRow);
    },
    /**
     * A process stopped while dispatching cannot know whether the native side received the answer. A queued
     * answer never left this process: it is refused so the person answers again (the request may have changed).
     */
    recoverDispatching(): number {
      const at = now();
      db.prepare("UPDATE workbench_request_answers SET status='rejected',reason='answer_not_sent',answer_json=NULL,updated_at=? WHERE status='queued'").run(at);
      return Number(db.prepare("UPDATE workbench_request_answers SET status='unknown',reason='native_receipt_unknown',answer_json=NULL,updated_at=? WHERE status='dispatching'").run(at).changes);
    },
  };
}
export type RequestStore = ReturnType<typeof createRequestStore>;

import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { subagentIdSchema, subagentLimit, subagentStatusSchema, teamSchema } from '../shared/workbench.ts';
import type { SubagentList, SubagentSummary, SubagentView } from '../shared/workbench.ts';
import type { Receipt, SubagentSnapshot } from '../harness/types.ts';

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = (bytes: number) => z.string().max(bytes).refine(value => Buffer.byteLength(value) <= bytes);
const storedAgent = z.object({
  id: subagentIdSchema, parentId: subagentIdSchema, name: text(400).min(1), task: text(4000).optional(), role: text(400).optional(),
  model: text(800).optional(), status: subagentStatusSchema, external: z.literal(true).optional(),
  startedAt: time.optional(), endedAt: time.optional(), revision: time,
}).strict();
const storedSnapshot = z.object({
  version: z.literal(1), rootId: subagentIdSchema, verified: z.boolean(), verifiedAt: time, revision: time,
  agents: z.array(storedAgent).max(subagentLimit), team: teamSchema.optional(), resultsPending: z.boolean(),
  /** Agents whose last verified status was running. Recovery restores observation while it is positive. */
  active: z.number().int().min(0).max(subagentLimit),
}).strict();
export type StoredSubagents = z.infer<typeof storedSnapshot>;
const stopStatus = z.enum(['queued', 'dispatching', 'accepted', 'unknown', 'rejected']);
const stopRow = z.object({ id: z.uuid(), conversation_id: z.uuid(), agent_id: subagentIdSchema, status: stopStatus, reason: z.string().nullable(), updated_at: time });
export type SubagentStop = { id: string; conversationId: string; agentId: string; status: z.infer<typeof stopStatus>; reason: string | null; updatedAt: number };
const fromRow = (row: unknown): SubagentStop => {
  const value = stopRow.parse(row);
  return { id: value.id, conversationId: value.conversation_id, agentId: value.agent_id, status: value.status, reason: value.reason, updatedAt: value.updated_at };
};
const reasonSchema = text(4096);

/** Summary for conversation rows; unverified active agents are reported as unverified, never running. */
export function summarizeSubagents(json: unknown): SubagentSummary | undefined {
  if (json == null) return;
  const parsed = storedSnapshot.safeParse(JSON.parse(String(json)));
  if (!parsed.success || !parsed.data.agents.length) return;
  const current = parsed.data;
  const running = current.agents.filter(agent => agent.status === 'running').length;
  const unknown = current.agents.filter(agent => agent.status === 'unknown').length;
  return { total: current.agents.length, running: current.verified ? running : 0,
    unverified: current.verified ? unknown : running + unknown, resultsPending: current.verified && current.resultsPending, revision: current.revision };
}

export class SubagentStoreError extends Error {
  readonly code: string; readonly statusCode: number;
  constructor(code: string, statusCode: number) { super(code); this.name = 'SubagentStoreError'; this.code = code; this.statusCode = statusCode; }
}

/**
 * Local index of native sub-agents. It never stores a sub-agent's transcript; native
 * Harnesses own bodies and execution. Stop requests keep stable identities for
 * reconciliation and are never resent by this store.
 */
export function createSubagentStore(db: DatabaseSync, notify: (event: { sequence: number; conversationId: string; scope: 'state' }) => void, now = Date.now) {
  const emit = (id: string) => {
    // Requests and sub-agents change what the conversation waits on, never its history (ADR 0020).
    const result = db.prepare("INSERT INTO workbench_changes(conversation_id,scope,created_at) VALUES(?,'state',?)").run(id, now());
    return { sequence: Number(result.lastInsertRowid), conversationId: id, scope: 'state' as const };
  };
  const publish = (event: { sequence: number; conversationId: string; scope: 'state' } | undefined) => {
    if (!event) return;
    try { notify(event); } catch { /* The durable change cursor replays committed changes. */ }
  };
  const read = (conversationId: string): StoredSubagents | null => {
    const row = db.prepare('SELECT subagents_json FROM workbench_conversations WHERE id=?').get(conversationId);
    if (!row) throw new SubagentStoreError('conversation_not_found', 404);
    if (row.subagents_json == null) return null;
    const parsed = storedSnapshot.safeParse(JSON.parse(String(row.subagents_json)));
    if (!parsed.success) throw new SubagentStoreError('corrupt_workbench_data', 500);
    return parsed.data;
  };
  const write = (conversationId: string, value: StoredSubagents) =>
    db.prepare('UPDATE workbench_conversations SET subagents_json=? WHERE id=?').run(JSON.stringify(storedSnapshot.parse(value)), conversationId);
  const content = (value: StoredSubagents | null) => value && JSON.stringify({ ...value, verifiedAt: 0 });
  const update = (conversationId: string, change: (current: StoredSubagents | null) => StoredSubagents | null) => {
    z.uuid().parse(conversationId);
    const event = transaction(db, () => {
      const current = read(conversationId);
      const next = change(current);
      if (!next) return;
      const changed = content(current) !== content(next);
      write(conversationId, changed ? { ...next, revision: (current?.revision ?? 0) + 1 } : next);
      return changed ? emit(conversationId) : undefined;
    });
    publish(event);
  };
  const latestStops = (conversationId: string): Map<string, SubagentStop> => {
    const rows = db.prepare(`SELECT s.id,s.conversation_id,s.agent_id,s.status,s.reason,s.updated_at FROM workbench_subagent_stops s
      WHERE s.conversation_id=? AND s.created_at=(SELECT MAX(l.created_at) FROM workbench_subagent_stops l WHERE l.conversation_id=s.conversation_id AND l.agent_id=s.agent_id)
      ORDER BY s.created_at DESC LIMIT ?`).all(conversationId, subagentLimit);
    const stops = new Map<string, SubagentStop>();
    for (const row of rows) { const stop = fromRow(row); if (!stops.has(stop.agentId)) stops.set(stop.agentId, stop); }
    return stops;
  };
  const getStop = (id: string): SubagentStop | null => {
    z.uuid().parse(id);
    const row = db.prepare('SELECT id,conversation_id,agent_id,status,reason,updated_at FROM workbench_subagent_stops WHERE id=?').get(id);
    return row ? fromRow(row) : null;
  };
  const touchStop = (stop: SubagentStop) => publish(transaction(db, () => emit(stop.conversationId)));

  return {
    get: read,
    /** Replace the index with a verified native snapshot, keeping per-agent revisions stable. */
    save(conversationId: string, rootId: string, snapshot: SubagentSnapshot) {
      subagentIdSchema.parse(rootId);
      if (snapshot.agents.length > subagentLimit) throw new SubagentStoreError('subagent_limit', 502);
      update(conversationId, current => {
        if (!current && !snapshot.agents.length && !snapshot.team) return null;
        const previous = new Map((current?.rootId === rootId ? current.agents : []).map(agent => [agent.id, agent]));
        const agents = snapshot.agents.map(agent => {
          const value = { id: agent.id, parentId: agent.parentId, name: agent.name, status: agent.status,
            ...(agent.task ? { task: agent.task } : {}), ...(agent.role ? { role: agent.role } : {}), ...(agent.model ? { model: agent.model } : {}),
            ...(agent.external ? { external: true as const } : {}), ...(agent.startedAt === undefined ? {} : { startedAt: agent.startedAt }),
            ...(agent.endedAt === undefined ? {} : { endedAt: agent.endedAt }) };
          const old = previous.get(agent.id);
          const same = old && JSON.stringify({ ...old, revision: 0 }) === JSON.stringify({ ...value, revision: 0 });
          return { ...value, revision: same ? old.revision : (old?.revision ?? 0) + 1 };
        });
        return { version: 1, rootId, verified: true, verifiedAt: now(), revision: current?.revision ?? 0, agents,
          ...(snapshot.team ? { team: snapshot.team } : {}), resultsPending: !!snapshot.resultsPending,
          active: agents.filter(agent => agent.status === 'running').length };
      });
    },
    /** Observation was lost: keep last-known facts but revoke verification everywhere. */
    markUnverified(conversationId: string) {
      update(conversationId, current => current && current.verified ? { ...current, verified: false } : null);
    },
    /** Native activity changed one agent's transcript; readers refetch only that agent. */
    touch(conversationId: string, agentIds: readonly string[]) {
      update(conversationId, current => {
        if (!current) return null;
        const touched = new Set(agentIds);
        if (!current.agents.some(agent => touched.has(agent.id))) return null;
        return { ...current, agents: current.agents.map(agent => touched.has(agent.id) ? { ...agent, revision: agent.revision + 1 } : agent) };
      });
    },
    /**
     * Codex keeps finished children's results only while the parent stays loaded; an unloaded parent loses them.
     * Pending results therefore hold observation, but they do not block archive or deletion.
     */
    holdsObservation(conversationId: string): boolean {
      const current = read(conversationId);
      return !!current && current.verified && current.resultsPending;
    },
    /** Running or unverified agents and unsettled stops keep the conversation busy. */
    busy(conversationId: string): boolean {
      const current = read(conversationId);
      if (current?.agents.some(agent => agent.status === 'running' || agent.status === 'unknown')) return true;
      return !!db.prepare("SELECT 1 FROM workbench_subagent_stops WHERE conversation_id=? AND status IN ('queued','dispatching','unknown') LIMIT 1").get(conversationId);
    },
    view(conversationId: string): SubagentList {
      const current = read(conversationId);
      const stops = latestStops(conversationId);
      const names = new Map(current?.agents.map(agent => [agent.id, agent.name]));
      const agents: SubagentView[] = (current?.agents ?? []).map(agent => {
        const stop = stops.get(agent.id);
        const unverified = !current!.verified && agent.status === 'running';
        return {
          id: agent.id, name: agent.name, status: unverified ? 'unknown' : agent.status, revision: agent.revision,
          ...(unverified ? { lastStatus: agent.status } : {}),
          ...(agent.task ? { task: agent.task } : {}), ...(agent.role ? { role: agent.role } : {}), ...(agent.model ? { model: agent.model } : {}),
          ...(agent.parentId !== current!.rootId && names.has(agent.parentId) ? { spawnedBy: names.get(agent.parentId)! } : {}),
          ...(agent.external ? { external: true as const } : {}),
          ...(agent.startedAt === undefined ? {} : { startedAt: agent.startedAt }), ...(agent.endedAt === undefined ? {} : { endedAt: agent.endedAt }),
          ...(current!.verifiedAt ? { verifiedAt: current!.verifiedAt } : {}),
          ...(stop ? { stop: { id: stop.id, status: stop.status, reason: stop.reason, updatedAt: stop.updatedAt } } : {}),
        };
      });
      return { agents, ...(current?.team ? { team: current.team } : {}), stale: !!current && !current.verified,
        ...(current?.verifiedAt ? { verifiedAt: current.verifiedAt } : {}), revision: current?.revision ?? 0 };
    },
    getStop,
    /** Same identity and target is the same request; a different target is a conflict. */
    enqueueStop(input: { id: string; conversationId: string; agentId: string }): { stop: SubagentStop; created: boolean } {
      z.uuid().parse(input.id); z.uuid().parse(input.conversationId); subagentIdSchema.parse(input.agentId);
      const existing = getStop(input.id);
      if (existing) {
        if (existing.conversationId !== input.conversationId || existing.agentId !== input.agentId) throw new SubagentStoreError('operation_id_conflict', 409);
        return { stop: existing, created: false };
      }
      const at = now();
      const event = transaction(db, () => {
        db.prepare("INSERT INTO workbench_subagent_stops(id,conversation_id,agent_id,status,created_at,updated_at) VALUES(?,?,?,'queued',?,?)")
          .run(input.id, input.conversationId, input.agentId, at, at);
        return emit(input.conversationId);
      });
      publish(event);
      return { stop: getStop(input.id)!, created: true };
    },
    claimStop(id: string): SubagentStop | null {
      z.uuid().parse(id);
      const result = db.prepare("UPDATE workbench_subagent_stops SET status='dispatching',updated_at=? WHERE id=? AND status='queued'").run(now(), id);
      return result.changes ? getStop(id) : null;
    },
    settleStop(id: string, receipt: Receipt): SubagentStop {
      z.uuid().parse(id);
      const status = receipt.outcome;
      const reason = receipt.outcome === 'accepted' ? null : reasonSchema.parse(receipt.reason);
      const current = getStop(id);
      if (!current) throw new SubagentStoreError('operation_not_found', 404);
      if (current.status === 'accepted' || current.status === 'rejected') return current;
      db.prepare('UPDATE workbench_subagent_stops SET status=?,reason=?,updated_at=? WHERE id=?').run(status, reason, now(), id);
      const stop = getStop(id)!;
      touchStop(stop);
      return stop;
    },
    pendingStops(conversationId: string): SubagentStop[] {
      return db.prepare(`SELECT id,conversation_id,agent_id,status,reason,updated_at FROM workbench_subagent_stops
        WHERE conversation_id=? AND status IN ('queued','dispatching','unknown') ORDER BY created_at LIMIT ?`).all(conversationId, subagentLimit).map(fromRow);
    },
    /** A process stopped while dispatching cannot know whether the native call ran. */
    recoverDispatching(): number {
      return Number(db.prepare("UPDATE workbench_subagent_stops SET status='unknown',reason='native_receipt_unknown',updated_at=? WHERE status='dispatching'").run(now()).changes);
    },
  };
}
export type SubagentStore = ReturnType<typeof createSubagentStore>;

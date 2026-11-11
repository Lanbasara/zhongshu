// Codex has no scheduler RPC. Persist occurrences here and deliver through the workbench's recoverable message path.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CronExpressionParser } from 'cron-parser';
import { HarnessError, type AutomationDelivery, type AutomationTargetInput, type AutomationTimingInput, type HarnessAdapter, type HarnessAutomations, type NativeAutomation } from '../harness/types.ts';
import { fromNative, latestOccurrence, upcoming, validZone } from '../sichen/time.ts';
import type { Workbench } from './workbench.ts';
import { StoreError } from './workbench-store.ts';

type TaskRow = {
  id: string; title: string; prompt: string; timing_json: string; target_json: string; reused_conversation_id: string | null;
  status: NativeAutomation['status']; scheduled_at: number; created_at: number; updated_at: number;
};
type RunRow = {
  id: string; task_id: string; conversation_id: string; scheduled_at: number; prompt: string;
  delivered_at: number | null; run_id: string | null; session_id: string | null; settled: number; problem: string | null;
};
const iso = (at: number) => new Date(at).toISOString();
const targetOf = (row: TaskRow) => JSON.parse(row.target_json) as AutomationTargetInput;
const timingOf = (row: TaskRow) => JSON.parse(row.timing_json) as AutomationTimingInput;
const BATCH = 12;
export const isCodexAutomation = (id: string) => /^codex-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);

function calendar(timing: AutomationTimingInput) {
  if (timing.kind === 'at' || timing.kind === 'every') throw new HarnessError('invalid_time');
  const when = fromNative(timing, 'UTC');
  if (!when) throw new HarnessError('invalid_time');
  return when;
}
function cron(timing: Extract<AutomationTimingInput, { kind: 'cron' }>, at: number) {
  // Match the documented five-field Vixie syntax. Avoid random and extended calendar operators.
  if (!validZone(timing.timeZone) || !/^[\da-z*,/\s-]+$/i.test(timing.expression) || timing.expression.trim().split(/\s+/).length !== 5)
    throw new HarnessError('invalid_time');
  try { return CronExpressionParser.parse(timing.expression, { tz: timing.timeZone, currentDate: at }); }
  catch { throw new HarnessError('invalid_time'); }
}
function next(timing: AutomationTimingInput, after: number, anchor: number): number | undefined {
  if (timing.kind === 'at') {
    const at = Date.parse(timing.at);
    return at > after ? at : undefined;
  }
  if (timing.kind === 'every') {
    const step = timing.seconds * 1000;
    return anchor + Math.max(1, Math.floor((after - anchor) / step) + 1) * step;
  }
  if (timing.kind === 'cron') {
    try { return cron(timing, after).next().getTime(); }
    catch { throw new HarnessError('invalid_time'); }
  }
  return upcoming(calendar(timing), after, 1)[0];
}
function lastDue(timing: AutomationTimingInput, at: number, floor: number): number {
  if (timing.kind === 'at') return floor;
  if (timing.kind === 'every') return floor + Math.floor((at - floor) / (timing.seconds * 1000)) * timing.seconds * 1000;
  if (timing.kind === 'cron') {
    try { return Math.max(floor, cron(timing, Math.floor(at / 60_000) * 60_000 + 60_000).prev().getTime()); }
    catch { return floor; }
  }
  return latestOccurrence(calendar(timing), at, floor);
}

export function createCodexAutomations(db: DatabaseSync, workbench: Workbench, adapter: HarnessAdapter, log: (event: Record<string, unknown>) => void, now = Date.now) {
  const listeners = new Set<() => void>();
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const changed = () => { for (const listener of listeners) listener(); };
  const taskRow = (id: string) => db.prepare('SELECT * FROM codex_automations WHERE id=?').get(id) as TaskRow | undefined;
  const pending = (id: string) => db.prepare('SELECT * FROM codex_automation_runs WHERE task_id=? AND settled=0').get(id) as RunRow | undefined;
  const exists = (run: RunRow) => !!db.prepare('SELECT 1 FROM codex_automation_runs WHERE id=?').get(run.id);
  const delivery = (row: RunRow): AutomationDelivery => ({
    scheduledAt: iso(row.scheduled_at), deliveredAt: iso(row.delivered_at!), messageId: row.id, sessionId: row.session_id!,
    prompt: row.prompt, ...(row.run_id ? { runId: row.run_id } : {}),
  });
  function view(row: TaskRow): NativeAutomation {
    const latest = db.prepare('SELECT * FROM codex_automation_runs WHERE task_id=? ORDER BY scheduled_at DESC,id DESC LIMIT 1').get(row.id) as RunRow | undefined;
    const active = pending(row.id);
    const last = latest?.delivered_at ? latest : db.prepare('SELECT * FROM codex_automation_runs WHERE task_id=? AND delivered_at IS NOT NULL ORDER BY delivered_at DESC,id DESC LIMIT 1').get(row.id) as RunRow | undefined;
    const storedTarget = targetOf(row);
    const reused = row.reused_conversation_id ? workbench.store.getConversation(row.reused_conversation_id)?.binding?.id : undefined;
    const target = storedTarget.kind === 'new_once' && reused ? { kind: 'session' as const, sessionId: reused } : storedTarget;
    const timing = timingOf(row);
    return {
      id: row.id, title: row.title, prompt: row.prompt, status: row.status,
      target, timing: timing.kind === 'at' ? { kind: 'once', at: timing.at } : timing,
      scheduledAt: iso(row.scheduled_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      involved: [], executing: !!active, ...(last ? { lastDelivery: delivery(last) } : {}),
      ...((active?.problem ?? latest?.problem) ? { problem: (active?.problem ?? latest?.problem)! } : {}),
    };
  }
  function validateTarget(target: AutomationTargetInput | undefined): AutomationTargetInput {
    if (target?.kind === 'session') {
      const conversation = workbench.store.conversationForNative('codex', target.sessionId);
      if (conversation && !conversation.archived && workbench.workspaces.some(workspace => workspace.id === conversation.workspaceId && workspace.directory === conversation.cwd)) return target;
    } else if (target?.cwd && !target.preset && workbench.workspaces.some(workspace => workspace.directory === target.cwd)) {
      return target;
    }
    throw new HarnessError('automation_target_unavailable');
  }
  function insertRun(row: TaskRow, at: number) {
    const target = targetOf(row);
    const id = randomUUID();
    const conversationId = target.kind === 'session' ? workbench.store.conversationForNative('codex', target.sessionId)?.id ?? ''
      : target.kind === 'new_once' ? row.reused_conversation_id ?? randomUUID() : randomUUID();
    db.prepare('INSERT INTO codex_automation_runs(id,task_id,conversation_id,scheduled_at,prompt) VALUES(?,?,?,?,?)')
      .run(id, row.id, conversationId, at, row.prompt);
    if (target.kind === 'new_once' && !row.reused_conversation_id)
      db.prepare('UPDATE codex_automations SET reused_conversation_id=? WHERE id=?').run(conversationId, row.id);
  }
  function claimDue() {
    const at = now();
    const due = db.prepare(`SELECT * FROM codex_automations a WHERE status='active' AND scheduled_at<=?
      AND NOT EXISTS (SELECT 1 FROM codex_automation_runs r WHERE r.task_id=a.id AND r.settled=0)
      ORDER BY scheduled_at,id LIMIT ?`).all(at, BATCH) as TaskRow[];
    if (!due.length) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of due) {
        const timing = timingOf(row);
        const occurrence = lastDue(timing, at, row.scheduled_at);
        const following = next(timing, at, occurrence);
        insertRun(row, occurrence);
        db.prepare('UPDATE codex_automations SET scheduled_at=?,status=? WHERE id=?')
          .run(following ?? occurrence, following === undefined ? 'ended' : 'active', row.id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    changed();
  }
  function problem(run: RunRow, reason: string, settled = false) {
    if (run.problem === reason && run.settled === Number(settled)) return;
    db.prepare('UPDATE codex_automation_runs SET problem=?,settled=? WHERE id=?').run(reason, Number(settled), run.id);
    changed();
  }
  async function deliver(run: RunRow) {
    const row = taskRow(run.task_id);
    if (!row || !run.conversation_id) return problem(run, 'automation_target_unavailable', true);
    const target = targetOf(row);
    let conversation = workbench.store.getConversation(run.conversation_id);
    if (!conversation) {
      if (target.kind === 'session') return problem(run, 'automation_target_unavailable', true);
      const workspace = workbench.workspaces.find(entry => entry.directory === target.cwd);
      if (!workspace) return problem(run, 'workspace_not_found', true);
      const catalog = (await workbench.catalogs()).find(entry => entry.id === 'codex');
      if (closed || !exists(run)) return;
      const model = catalog?.models.find(entry => entry.id === catalog.defaultModelId);
      if (!model || !catalog?.permissions.some(entry => entry.id === ':workspace')) return problem(run, 'automation_codex_defaults_unavailable');
      conversation = await workbench.create({ id: run.conversation_id, harnessId: 'codex', workspaceId: workspace.id, title: row.title,
        automationId: row.id, configuration: { modelId: model.id, permissionId: ':workspace', ...(model.defaultReasoningEffort ? { reasoningEffort: model.defaultReasoningEffort } : {}) } });
      if (closed || !exists(run)) return;
    }
    if (conversation.archived || !workbench.workspaces.some(workspace => workspace.id === conversation.workspaceId && workspace.directory === conversation.cwd))
      return problem(run, 'automation_target_unavailable', true);
    if (!conversation.binding || conversation.readiness === 'preparing') return;
    const operation = workbench.store.getOperation(run.id);
    if (!operation) {
      const text = `[SCHEDULE REMINDER]\nThis is a scheduled message from the user. When finished, record the conclusion with the Zhongshu record_result tool.\nschedule_id_json: ${JSON.stringify(row.id)}\noccurrence_at: ${iso(run.scheduled_at)}\nreminder_prompt_json: ${JSON.stringify(run.prompt)}`;
      await workbench.enqueue({ id: run.id, conversationId: conversation.id, type: 'message', payload: { text } });
      return;
    }
    if (operation.status === 'rejected') return problem(run, operation.reason ?? 'automation_delivery_rejected', true);
    if (operation.status === 'unknown') return problem(run, 'automation_delivery_unknown');
    if (!operation.runId || operation.status !== 'accepted') return;
    if (!run.delivered_at) {
      db.prepare('UPDATE codex_automation_runs SET delivered_at=?,run_id=?,session_id=?,problem=NULL WHERE id=?')
        .run(operation.updatedAt, operation.runId, conversation.binding.id, run.id);
      changed();
    }
    const state = conversation.state.terminalRunId === operation.runId ? conversation.state : await adapter.state(conversation.binding, operation.runId);
    if (closed || !exists(run)) return;
    if (state.terminalRunId !== operation.runId || !state.terminalStatus) return;
    const failure = state.terminalStatus === 'completed' ? null : 'automation_run_' + state.terminalStatus;
    db.prepare('UPDATE codex_automation_runs SET settled=1,problem=? WHERE id=?').run(failure, run.id);
    db.prepare(`DELETE FROM codex_automation_runs WHERE task_id=? AND settled=1 AND id NOT IN
      (SELECT id FROM codex_automation_runs WHERE task_id=? ORDER BY scheduled_at DESC,id DESC LIMIT 200)`).run(row.id, row.id);
    changed();
  }
  function tick() {
    if (closed || running) return;
    running = (async () => {
      claimDue();
      const rows = db.prepare('SELECT * FROM codex_automation_runs WHERE settled=0 ORDER BY scheduled_at,id').all() as RunRow[];
      // A busy target must not starve later tasks. Limit concurrent native reads and rotate through the pending set.
      for (let index = 0; index < rows.length && !closed; index += BATCH) {
        await Promise.all(rows.slice(index, index + BATCH).map(async run => {
          try { await deliver(run); }
          catch (error) {
            if (closed || !exists(run)) return;
            if (error instanceof StoreError && ['operation_needs_reconciliation', 'workspace_save_in_progress'].includes(error.code)) return;
            const reason = error instanceof StoreError ? error.code : 'automation_delivery_unavailable';
            problem(run, reason, ['workspace_not_found', 'conversation_archived', 'conversation_deleted'].includes(reason));
          }
        }));
      }
    })().catch(() => log({ event: 'codex_automation_tick_failed' })).finally(() => { running = undefined; });
  }
  const operations: HarnessAutomations = {
    async list() { return (db.prepare('SELECT * FROM codex_automations ORDER BY scheduled_at,id').all() as TaskRow[]).map(view); },
    async view(id) { const row = taskRow(id); return row && view(row); },
    async history(id, limit, before) {
      if (!taskRow(id)) return undefined;
      const cursor = before ? db.prepare('SELECT delivered_at FROM codex_automation_runs WHERE task_id=? AND id=?').get(id, before) : undefined;
      if (before && !cursor) throw new HarnessError('automation_history_cursor_invalid');
      const at = Number(cursor?.delivered_at ?? Number.MAX_SAFE_INTEGER);
      const rows = db.prepare(`SELECT * FROM codex_automation_runs WHERE task_id=? AND delivered_at IS NOT NULL
        AND (delivered_at < ? OR (delivered_at = ? AND id < ?)) ORDER BY delivered_at DESC,id DESC LIMIT ?`)
        .all(id, at, at, before ?? '', limit + 1) as RunRow[];
      const page = rows.slice(0, limit);
      return { records: page.map(delivery), earlierUnavailable: false, ...(rows.length > limit ? { before: page.at(-1)!.id } : {}) };
    },
    async create(input) {
      const target = validateTarget(input.target);
      const at = now();
      const scheduled = next(input.timing, at, at);
      if (scheduled === undefined) throw new HarnessError('invalid_time');
      if (Number(db.prepare('SELECT COUNT(*) AS count FROM codex_automations').get()!.count) >= 5000) throw new HarnessError('automation_capacity_reached');
      const id = 'codex-' + randomUUID();
      db.prepare(`INSERT INTO codex_automations(id,title,prompt,timing_json,target_json,status,scheduled_at,created_at,updated_at)
        VALUES(?,?,?,?,?,'active',?,?,?)`).run(id, input.title, input.prompt, JSON.stringify(input.timing), JSON.stringify(target), scheduled, at, at);
      changed();
      return view(taskRow(id)!);
    },
    async update(id, patch, expectedUpdatedAt) {
      const row = taskRow(id);
      if (!row) return 'notFound';
      if (expectedUpdatedAt && iso(row.updated_at) !== expectedUpdatedAt) return 'conflict';
      if (row.status === 'ended') return 'ended';
      const timing = patch.timing ?? timingOf(row);
      const at = now();
      const scheduled = patch.timing || (patch.active && row.status === 'paused') ? next(timing, at, at) : row.scheduled_at;
      if (scheduled === undefined) throw new HarnessError('invalid_time');
      const status = patch.active === undefined ? row.status : patch.active ? 'active' : 'paused';
      db.prepare('UPDATE codex_automations SET title=?,prompt=?,timing_json=?,status=?,scheduled_at=?,updated_at=? WHERE id=?')
        .run(patch.title ?? row.title, patch.prompt ?? row.prompt, JSON.stringify(timing), status, scheduled, Math.max(at, row.updated_at + 1), id);
      changed();
      return view(taskRow(id)!);
    },
    async remove(id, expectedUpdatedAt) {
      const row = taskRow(id);
      if (!row) return 'notFound';
      if (expectedUpdatedAt && iso(row.updated_at) !== expectedUpdatedAt) return 'conflict';
      db.prepare('DELETE FROM codex_automations WHERE id=?').run(id);
      workbench.store.releaseAutomation(id);
      changed();
      return 'deleted';
    },
    async run(id) {
      const row = taskRow(id);
      if (!row) return 'notFound';
      if (pending(id)) return 'pending';
      insertRun(row, now());
      changed();
      tick();
      return view(taskRow(id)!);
    },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async inspect(sessionId) {
      const conversation = workbench.store.conversationForNative('codex', sessionId);
      return conversation ? { cwd: conversation.cwd, configuration: conversation.configuration } : undefined;
    },
  };
  return {
    operations,
    start() { tick(); timer = setInterval(tick, 1000).unref(); },
    async close() { closed = true; if (timer) clearInterval(timer); await running; },
  };
}

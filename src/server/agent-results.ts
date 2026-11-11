/**
 * Run conclusions written back to the task card (ADR 0021, 2026-11-09). After a run an automation delivered, the agent
 * calls `record_result` with one line. Its tool record in the transcript ties the line to the conversation, and the
 * delivery it belongs to is the one in that conversation just before it. It is never pushed; notifying the user stays
 * `notify_user`. The line is the agent's own words: stored for the card, never logged.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NativeItem } from '../harness/types.ts';
import { RESULT_TOOL, type NotifyOutcome } from './agent-tools.ts';

const KEEP = 2000;
const BURST = { count: 60, windowMs: 10 * 60_000 };
/** Native tool names Harnesses give an MCP tool of server `zhongshu` (DSH, Codex and Claude Code share this form). */
const toolNames = new Set([`mcp__zhongshu__${RESULT_TOOL}`, `zhongshu.${RESULT_TOOL}`, `zhongshu/${RESULT_TOOL}`]);
const numbered = /结论编号 ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

export function createAgentResults(db: DatabaseSync, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const recent: number[] = [];
  return {
    /** Called by the tool endpoint. */
    record(summary: string): NotifyOutcome {
      const at = now();
      while (recent.length && recent[0]! < at - BURST.windowMs) recent.shift();
      if (recent.length >= BURST.count) return { refused: '结论写得太频繁，已暂停记录。请把结论写在回复里。' };
      recent.push(at);
      const id = randomUUID();
      db.prepare('INSERT INTO agent_results(id,summary,created_at) VALUES(?,?,?)').run(id, summary, at);
      db.prepare('DELETE FROM agent_results WHERE id IN (SELECT id FROM agent_results ORDER BY created_at DESC LIMIT -1 OFFSET ?)').run(KEEP);
      return { id };
    },
    /** Called with items Zhongshu observed in a conversation; a result tool record places its line there, once. */
    observed(conversationId: string, items: Iterable<NativeItem>): void {
      for (const item of items) {
        if (item.kind !== 'tool' || !item.tool || !toolNames.has(item.tool.name)) continue;
        const id = numbered.exec(item.tool.output ?? '')?.[1];
        if (id) db.prepare('UPDATE agent_results SET conversation_id=?, item_id=?, run_id=? WHERE id=? AND conversation_id IS NULL').run(conversationId, item.id, item.runId ?? null, id);
      }
    },
    /** The latest line written in a conversation within [from, until): the conclusion of the run delivered at `from`. */
    within(conversationId: string, from: number, until = Number.MAX_SAFE_INTEGER): string | undefined {
      const value = db.prepare('SELECT summary FROM agent_results WHERE conversation_id=? AND created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT 1')
        .get(conversationId, from, until) as { summary: string } | undefined;
      return value?.summary;
    },
    forRun(conversationId: string, runId: string): string | undefined {
      const value = db.prepare('SELECT summary FROM agent_results WHERE conversation_id=? AND run_id=? ORDER BY created_at DESC LIMIT 1')
        .get(conversationId, runId) as { summary: string } | undefined;
      return value?.summary;
    },
  };
}
export type AgentResults = ReturnType<typeof createAgentResults>;

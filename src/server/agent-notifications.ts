/**
 * Agent notifications (ADR 0021). An agent calls `notify_user`; the tool record appears in that conversation's
 * transcript, which ties the notification to its conversation and turn. Only then is it pushed with a direct link.
 * When no observed conversation shows the record in time, it is still pushed, opening the schedule page instead.
 * The summary is the agent's own words for the user: stored here for the list, never logged.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { NativeItem } from '../harness/types.ts';
import type { PushEvent } from './push.ts';
import { NOTIFY_TOOL, type NotifyOutcome } from './agent-tools.ts';

const PLACE_WAIT = 20_000;
const KEEP = 500;
const BURST = { count: 30, windowMs: 10 * 60_000 };
const uuid = z.uuid();
/** Native tool names Harnesses give an MCP tool of server `zhongshu` (DSH, Codex and Claude Code share this form). */
const toolNames = new Set([`mcp__zhongshu__${NOTIFY_TOOL}`, `zhongshu.${NOTIFY_TOOL}`, `zhongshu/${NOTIFY_TOOL}`]);
const numbered = /通知编号 ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

export type AgentNotification = { id: string; summary: string; file: string | null; createdAt: number; state: 'pending' | 'placed' | 'unplaced'; conversationId: string | null; itemId: string | null };
const row = z.object({ id: z.string(), summary: z.string(), file: z.string().nullable(), created_at: z.number(), state: z.enum(['pending', 'placed', 'unplaced']), conversation_id: z.string().nullable(), item_id: z.string().nullable() });
const view = (value: unknown): AgentNotification => {
  const r = row.parse(value);
  return { id: r.id, summary: r.summary, file: r.file, createdAt: r.created_at, state: r.state, conversationId: r.conversation_id, itemId: r.item_id };
};

export function createAgentNotifications(db: DatabaseSync, options: {
  push(event: PushEvent): void;
  /** The conversation's title for the notification heading; undefined when the conversation is unknown. */
  title(conversationId: string): string | undefined;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const timers = new Map<string, NodeJS.Timeout>();
  const recent: number[] = [];
  let closed = false;

  function settle(id: string, state: 'placed' | 'unplaced', conversationId?: string, itemId?: string): boolean {
    const changed = db.prepare("UPDATE agent_notifications SET state=?, conversation_id=?, item_id=?, sent_at=? WHERE id=? AND state='pending'")
      .run(state, conversationId ?? null, itemId ?? null, now(), id).changes === 1;
    const timer = timers.get(id); if (timer) { clearTimeout(timer); timers.delete(id); }
    return changed;
  }
  function get(id: string): AgentNotification | undefined {
    if (!uuid.safeParse(id).success) return undefined;
    const value = db.prepare('SELECT * FROM agent_notifications WHERE id=?').get(id);
    return value ? view(value) : undefined;
  }
  function unplaced(id: string): void {
    if (closed || !settle(id, 'unplaced')) return;
    const notification = get(id);
    if (notification) options.push({ kind: 'agent', body: notification.summary, notice: id });
  }

  return {
    /** Called by the tool endpoint. Refuses bursts so a looping agent cannot flood the phone. */
    notify(summary: string, file: string | undefined): NotifyOutcome {
      if (closed) return { refused: '中书正在关闭，通知未发送。' };
      const at = now();
      while (recent.length && recent[0]! < at - BURST.windowMs) recent.shift();
      if (recent.length >= BURST.count) return { refused: '通知太频繁，已暂停发送。请把结果写在回复里。' };
      recent.push(at);
      const id = randomUUID();
      db.prepare("INSERT INTO agent_notifications(id,summary,file,created_at,state) VALUES(?,?,?,?,'pending')").run(id, summary, file ?? null, at);
      db.prepare('DELETE FROM agent_notifications WHERE id IN (SELECT id FROM agent_notifications ORDER BY created_at DESC LIMIT -1 OFFSET ?)').run(KEEP);
      const timer = setTimeout(() => unplaced(id), PLACE_WAIT); timer.unref(); timers.set(id, timer);
      return { id };
    },
    /** Called with items Zhongshu observed in a conversation; a notify tool record places its notification there. */
    observed(conversationId: string, items: Iterable<NativeItem>): void {
      if (closed) return;
      for (const item of items) {
        if (item.kind !== 'tool' || !item.tool || !toolNames.has(item.tool.name)) continue;
        const id = numbered.exec(item.tool.output ?? '')?.[1];
        if (!id) continue;
        // Found only after its push already went to the schedule: record where it belongs for the lists, without a second push.
        db.prepare("UPDATE agent_notifications SET state='placed', conversation_id=?, item_id=? WHERE id=? AND state='unplaced' AND conversation_id IS NULL").run(conversationId, item.id, id);
        if (!settle(id, 'placed', conversationId, item.id)) continue;
        const notification = get(id);
        if (notification) options.push({ kind: 'agent', conversationId, title: options.title(conversationId), body: notification.summary, notice: id });
      }
    },
    get,
    list(limit = 50): AgentNotification[] {
      return db.prepare('SELECT * FROM agent_notifications ORDER BY created_at DESC LIMIT ?').all(Math.min(200, Math.max(1, limit))).map(view);
    },
    /** After a restart, pending ones lost their wait; recent ones still go out, old ones are only listed. */
    start(): void {
      const pending = db.prepare("SELECT id, created_at FROM agent_notifications WHERE state='pending'").all() as { id: string; created_at: number }[];
      for (const entry of pending) {
        if (now() - entry.created_at < 10 * 60_000) { const timer = setTimeout(() => unplaced(entry.id), PLACE_WAIT); timer.unref(); timers.set(entry.id, timer); }
        else db.prepare("UPDATE agent_notifications SET state='unplaced' WHERE id=? AND state='pending'").run(entry.id);
      }
    },
    close(): void { closed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); },
  };
}
export type AgentNotifications = ReturnType<typeof createAgentNotifications>;

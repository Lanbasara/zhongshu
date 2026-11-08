import type { Conversation, WorkbenchChange } from './workbench-store.ts';
import type { PushEvent } from './push.ts';

type Source = {
  conversation(id: string): Conversation | null;
  /** Unseen results, excluding conversations an open, visible page is reading and runs the user stopped. */
  unread(conversations: readonly Conversation[]): Set<string>;
  /** An open, visible page somewhere is reading this conversation. */
  isReading(id: string): boolean;
  /** Conversations that may be mid-run when the process starts. */
  active(): Conversation[];
};

/**
 * Turns conversation state changes into push events (ADR 0018):
 * - a run this process saw ends with a result nobody has seen yet: completed, failed or interrupted (user stops excluded);
 * - a conversation starts waiting for an answer or approval while nobody is reading it.
 * Mid-run conversations and a bounded set of recently settled results are remembered, not the catalogue.
 */
export function createPushTriggers(source: Source, notify: (event: PushEvent) => void) {
  const active = new Map<string, { status: 'running' | 'waiting' | 'unknown' }>();
  /** Last settled result seen per conversation, bounded; forgetting one only skips a notification for an unseen fast run. */
  const results = new Map<string, string>();
  const pending = new Set<string>();
  let scheduled: NodeJS.Immediate | undefined;
  let closed = false;

  try {
    for (const conversation of source.active()) {
      const { status } = conversation.state;
      if (status === 'running' || status === 'waiting' || (status === 'unknown' && conversation.state.runId)) active.set(conversation.id, { status });
    }
  } catch { /* An unreadable start only misses results of runs already in flight. */ }

  function evaluate(id: string): void {
    const conversation = source.conversation(id);
    const previous = active.get(id);
    if (!conversation || conversation.archived) { active.delete(id); return; }
    const { status } = conversation.state;
    const event = { conversationId: id, harnessId: conversation.harnessId, title: conversation.title };
    if (status === 'running') { active.set(id, { status }); return; }
    if (status === 'waiting') {
      if (previous?.status !== 'waiting' && !source.isReading(id)) notify({ kind: 'waiting', ...event });
      active.set(id, { status }); return;
    }
    // Observation was lost; the run may still be going, so keep remembering it.
    if (status === 'unknown') { if (previous) active.set(id, { status }); return; }
    // A settled result. It is new when it follows a run seen here, or replaces the result last seen here
    // (a run can start and end between two observations). Repeats of the same result never notify twice.
    // ADR 0021: a later run nobody here started (an automation delivery) is the newest result. Its completion is not
    // pushed: the agent decides with notify_user whether the user should look. Failures still are.
    const latest = conversation.state.latest;
    const terminal = latest?.status ?? conversation.state.terminalStatus;
    const key = terminal ? `${terminal}:${latest?.runId ?? conversation.state.terminalRunId ?? ''}` : '';
    const known = results.has(id); const before = results.get(id);
    results.delete(id); results.set(id, key);
    if (results.size > 4096) results.delete(results.keys().next().value!);
    const followedRun = active.delete(id);
    if (!terminal || key === before || (!followedRun && !known)) return;
    if (latest && terminal === 'completed') return;
    if (source.unread([conversation]).has(id)) notify({ kind: terminal, ...event });
  }
  function flush(): void {
    scheduled = undefined;
    const ids = [...pending]; pending.clear();
    for (const id of ids) {
      if (closed) return;
      try { evaluate(id); } catch { /* One unreadable conversation never blocks the others. */ }
    }
  }
  return {
    /** Store change hook. Live item deltas never change state, so they are skipped without a read. */
    changed(change: WorkbenchChange): void {
      if (closed || change.itemId) return;
      pending.add(change.conversationId);
      scheduled ??= setImmediate(flush);
    },
    close(): void { closed = true; if (scheduled) clearImmediate(scheduled); pending.clear(); active.clear(); results.clear(); },
  };
}

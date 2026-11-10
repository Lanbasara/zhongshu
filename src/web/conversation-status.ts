import type { Conversation } from '../shared/workbench.ts';
import type { ProcessRunState } from './patterns/process.tsx';
import type { StatusKind } from './ui/controls.tsx';

const labels: Record<Conversation['state']['status'], string> = { idle: '就绪', running: '运行中', waiting: '等待处理', interrupted: '已中断', failed: '执行失败', unknown: '待核实' };

/** The one place that turns a conversation's state into the status shown in lists, headers and search. */
export function conversationStatus(conversation: Conversation): { status: StatusKind; label: string } {
  if (conversation.readiness === 'preparing') return { status: 'running', label: '正在准备' };
  if (conversation.readiness === 'blocked') return { status: 'unknown', label: '准备未完成' };
  return runStatus(conversation.state.status, !!conversation.unread);
}
/** A native run state and whether its result is unread, as lists show it; also used for an automation's latest run. */
export function runStatus(status: Conversation['state']['status'], unread: boolean): { status: StatusKind; label: string } {
  if (status === 'idle') return unread ? { status: 'unread', label: '已完成，还没看' } : { status: 'idle', label: labels.idle };
  return { status, label: unread ? `${labels[status]}，还没看` : labels[status] };
}
export const stateLabel = (conversation: Conversation) => conversationStatus(conversation).label.replace('，还没看', '');
export const harnessLabel = (id: Conversation['harnessId']) => id === 'codex' ? 'Codex' : 'DSH';

/**
 * The native turn's own state for one run, as far as the workbench can verify it: the current run, the
 * last verified terminal run, or a run a native automation delivered (`latest`). A historical turn with no
 * verified terminal state returns undefined, so its process block reports only the step facts it has.
 */
export function nativeRunState(state: Conversation['state'], runId: string): ProcessRunState | undefined {
  if (state.runId === runId) {
    if (state.status === 'running' || state.status === 'waiting') return 'running';
    if (state.terminalRunId === runId && state.terminalStatus) return state.terminalStatus;
    return state.status === 'idle' ? 'completed' : state.status;
  }
  if (state.terminalRunId === runId && state.terminalStatus) return state.terminalStatus;
  if (state.latest?.runId === runId) return state.latest.status;
  return undefined;
}

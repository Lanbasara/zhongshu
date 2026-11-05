import type { Conversation, WorkbenchSnapshot } from '../shared/workbench.ts';

const labels = { idle: '就绪', running: '运行中', waiting: '等待处理', interrupted: '已停止', failed: '执行失败', unknown: '状态待确认' };

/** Display only. Admission and reconciliation continue to use the original state. */
export function conversationFeedback(snapshot: WorkbenchSnapshot | undefined) {
  const conversation = snapshot?.conversation;
  const unresolved = snapshot?.operationState?.unresolved ?? snapshot?.operations.some(op => ['queued', 'dispatching', 'unknown'].includes(op.status)) ?? false;
  const latest = snapshot?.operationState ? snapshot.operationState.latestAcceptedMessage : snapshot?.operations.find(op => op.type === 'message' && op.status === 'accepted');
  const settled = !latest || (latest.runId !== null && (latest.runId === conversation?.state.runId || latest.runId === conversation?.state.terminalRunId));
  const uncertain = conversation?.state.status === 'unknown' || !!snapshot?.operations.some(op => op.status === 'unknown');
  const pending = unresolved || !settled;
  return { unresolved, settled, uncertain, pending,
    label: !conversation ? '' : conversation.readiness !== 'ready' ? conversationStateLabel(conversation)
      : uncertain ? '状态待确认' : pending && !['running', 'waiting'].includes(conversation.state.status) ? '等待执行确认' : conversationStateLabel(conversation),
  };
}

export function conversationStateLabel(conversation: Conversation) {
  return conversation.readiness === 'preparing' ? '正在准备' : conversation.readiness === 'blocked' ? '准备未完成' : labels[conversation.state.status];
}

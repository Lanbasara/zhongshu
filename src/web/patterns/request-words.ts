import type { ApprovalDecision, PendingRequest, RequestAnswer } from './requests.tsx';

/** The words for a native decision. The server's answer summary uses the same words (kept equal by a test). */
export const decisionLabel = (decision: ApprovalDecision, action: NonNullable<PendingRequest['approval']>['action']): string => ({
  accept: action === 'command' ? '允许运行' : action === 'fileChange' ? '允许修改' : '允许',
  acceptForSession: '本对话都允许',
  decline: '拒绝',
  cancel: '拒绝并停止本轮',
})[decision];
/** What the person chose, in the words the card uses. */
export function answerSummary(request: Pick<PendingRequest, 'approval'>, answer: RequestAnswer): string {
  if (answer.kind === 'approval') return decisionLabel(answer.decision, request.approval?.action ?? 'other');
  if (answer.kind === 'form') return answer.action === 'accept' ? '已提交' : answer.action === 'decline' ? '已拒绝' : '已取消';
  const text = answer.answers.map(value => [...value.selected, ...(value.custom?.trim() ? [value.custom.trim()] : [])].join('、') || '跳过').join('；');
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

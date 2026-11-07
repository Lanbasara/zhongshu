import type { ApprovalDecision, PendingRequest, RequestAnswer } from './workbench.ts';

type Action = NonNullable<PendingRequest['approval']>['action'];
/** The words for a native approval decision; the server records the same words as the answer summary. */
export const decisionLabel = (decision: ApprovalDecision, action: Action): string => ({
  accept: action === 'command' ? '允许运行' : action === 'fileChange' ? '允许修改' : '允许',
  acceptForSession: '本对话都允许',
  decline: '拒绝',
  cancel: '拒绝并停止本轮',
})[decision];

/** Short, human summary of a submitted answer, shown on every device until the request is resolved. */
export function answerSummary(request: Pick<PendingRequest, 'approval' | 'questions'>, answer: RequestAnswer): string {
  const review = request.questions?.[0]?.review;
  if (review && answer.kind === 'question') {
    const [value] = answer.answers;
    if (value?.selected[0] === review.approve) return '批准并执行';
    const feedback = value?.custom?.trim();
    return feedback ? `继续规划：${feedback.length > 190 ? `${feedback.slice(0, 189)}…` : feedback}` : '继续规划';
  }
  if (answer.kind === 'approval') return decisionLabel(answer.decision, request.approval?.action ?? 'other');
  if (answer.kind === 'form') return answer.action === 'accept' ? '已提交' : answer.action === 'decline' ? '已拒绝' : '已取消';
  const text = answer.answers.map(value => [...value.selected, ...(value.custom?.trim() ? [value.custom.trim()] : [])].join('、') || '跳过').join('；');
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** Whether an answer has the shape of the request it answers; adapters still validate native details. */
export function answerFits(request: Pick<PendingRequest, 'kind' | 'approval' | 'questions'>, answer: RequestAnswer): boolean {
  if (request.kind !== answer.kind) return false;
  if (answer.kind === 'approval') return !!request.approval?.decisions.includes(answer.decision);
  if (answer.kind === 'question') {
    const questions = request.questions ?? [];
    return answer.answers.length === questions.length && questions.every(question => answer.answers.some(value => value.id === question.id));
  }
  return true;
}

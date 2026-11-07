import { useEffect, useRef, useState } from 'react';
import { requestAnswerResponseSchema, type Conversation, type PendingRequest, type RequestAnswer } from '../shared/workbench.ts';
import { RequestStack, answerSummary } from './patterns/requests.tsx';
import { request, RequestError } from './workbench-client.ts';

/** Placeholder identity for an answer whose POST has not returned; never sent anywhere. */
const pendingAnswer = '00000000-0000-4000-8000-000000000000';
const answerFailures: Record<string, string> = {
  request_not_open: '这个请求已经处理过或已失效，没有提交新的回答。',
  request_not_found: '这个请求已不存在：Agent 可能已不再等待。',
  request_answer_pending: '已有一个回答正在提交，等它有结果后再操作。',
  answer_invalid: '这个回答不符合请求的要求，请重新选择。',
  request_answer_unavailable: '当前对话无法回答原生请求。',
};

/**
 * The questions and approvals of one conversation (ADR 0016). Server views are authoritative: this layer
 * only submits an answer with a fresh identity, asks for reconciliation, and hides resolved cards locally.
 */
export function ConversationRequests({ conversation, requests, csrf, report, onNotice, onReload, onOpenAgent }: {
  conversation: Conversation; requests: PendingRequest[]; csrf: string;
  report(reason: unknown): void; onNotice(text: string): void; onReload(): void; onOpenAgent(agentId: string): void;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  // An answer whose POST has not returned yet is shown as being submitted, never as answered.
  const [submitting, setSubmitting] = useState<Map<string, string>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  const conversationId = useRef(conversation.id);
  useEffect(() => { conversationId.current = conversation.id; setDismissed(new Set()); setSubmitting(new Map()); }, [conversation.id]);
  const hasDeadline = requests.some(item => item.status === 'open' && item.deadline !== undefined);
  useEffect(() => {
    if (!hasDeadline) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [hasDeadline]);

  const shown = requests.filter(item => !dismissed.has(item.id)).map(item => {
    const summary = submitting.get(item.id);
    return summary !== undefined && item.status === 'open' && !['queued', 'dispatching', 'unknown'].includes(item.answer?.status ?? '')
      ? { ...item, answer: { id: pendingAnswer, status: 'queued' as const, reason: null, updatedAt: now, summary } } : item;
  });
  if (!shown.length) return null;

  async function answer(requestId: string, value: RequestAnswer) {
    const target = requests.find(item => item.id === requestId);
    if (!target) return;
    const owner = conversation.id;
    setSubmitting(current => new Map(current).set(requestId, answerSummary(target, value)));
    try {
      await request(`/conversations/${owner}/requests/${encodeURIComponent(requestId)}/answer`, requestAnswerResponseSchema, { csrf, body: { id: crypto.randomUUID(), answer: value } });
    } catch (reason) {
      if (conversationId.current !== owner) return;
      if (reason instanceof RequestError && answerFailures[reason.code]) onNotice(answerFailures[reason.code]!); else report(reason);
    } finally {
      if (conversationId.current === owner) { setSubmitting(current => { const next = new Map(current); next.delete(requestId); return next; }); onReload(); }
    }
  }
  async function reconcile(requestId: string) {
    const answerId = requests.find(item => item.id === requestId)?.answer?.id;
    if (!answerId) return;
    try {
      const result = await request(`/conversations/${conversation.id}/request-answers/${answerId}/reconcile`, requestAnswerResponseSchema, { csrf, body: {} });
      if (result.answer.status === 'unknown') onNotice('仍无法确认这个回答是否送达；没有重复发送。');
    } catch (reason) { report(reason); }
    finally { onReload(); }
  }
  return <RequestStack requests={shown} now={now} onAnswer={(id, value) => void answer(id, value)} onReconcile={id => void reconcile(id)}
    onDismiss={id => setDismissed(current => new Set(current).add(id))} onOpenAgent={onOpenAgent}/>;
}

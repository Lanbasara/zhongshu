import { useEffect, useRef, useState } from 'react';
import { conversationResponseSchema, operationResponseSchema, type Conversation, type WorkbenchSnapshot } from '../shared/workbench.ts';
import { PlanNotice, PlanReadyCard, PlanToggle } from './patterns/plan.tsx';
import { request, RequestError } from './workbench-client.ts';

const planFailures: Record<string, string> = {
  plan_change_while_running: '本轮运行中不能切换 Plan，结束后再试。',
  plan_unavailable: '这段对话的 Agent 配置不提供 Plan 模式。',
  plan_rejected: '原生没有接受 Plan 的切换。',
};
/** The message that starts carrying out a proposed plan, as the official Codex client does after switching to the default mode. */
const implementText = '按上面的计划开始执行。';

/**
 * Plan mode for one conversation (ADR 0016). The server owns the state: Codex keeps Zhongshu's choice and applies it
 * per turn, DSH reports its native state. This layer only asks for a change and shows what the server reports.
 */
export function usePlan({ conversation, csrf, report, onNotice, onChanged }: {
  conversation?: Conversation; csrf: string; report(reason: unknown): void; onNotice(text: string): void; onChanged(): void;
}) {
  const [changing, setChanging] = useState(false);
  const owner = useRef(conversation?.id);
  useEffect(() => { owner.current = conversation?.id; setChanging(false); }, [conversation?.id]);
  async function change(active: boolean): Promise<boolean> {
    if (!conversation || changing) return false;
    const id = conversation.id; setChanging(true);
    try { await request(`/conversations/${id}/plan`, conversationResponseSchema, { csrf, body: { active } }); return true; }
    catch (reason) {
      if (owner.current === id) { if (reason instanceof RequestError && planFailures[reason.code]) onNotice(planFailures[reason.code]!); else report(reason); }
      return false;
    } finally { if (owner.current === id) { setChanging(false); onChanged(); } }
  }
  return { plan: conversation?.plan, changing, change };
}

export function PlanToolbarToggle({ plan, changing, busy, onChange }: { plan?: Conversation['plan']; changing: boolean; busy: boolean; onChange(active: boolean): void }) {
  if (!plan) return null;
  return <PlanToggle active={plan.active} pending={changing || plan.pending} disabled={busy || changing} onToggle={() => onChange(!plan.active)}/>;
}

/** The Plan notice and, for per-turn Harnesses, the offer to carry out a proposed plan. */
export function PlanArea({ conversation, planReady, csrf, report, onChange, onChanged }: {
  conversation: Conversation; planReady?: WorkbenchSnapshot['planReady']; csrf: string; report(reason: unknown): void;
  onChange(active: boolean): Promise<boolean>; onChanged(): void;
}) {
  const [dismissed, setDismissed] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!conversation.plan?.active) return null;
  async function implement() {
    if (busy) return;
    setBusy(true);
    try {
      // Leave Plan first: the next turn then runs in the default mode, as the official client does.
      if (!await onChange(false)) return;
      await request(`/conversations/${conversation.id}/operations`, operationResponseSchema, { csrf, body: { id: crypto.randomUUID(), type: 'message', payload: { text: implementText } } });
    } catch (reason) { report(reason); }
    finally { setBusy(false); onChanged(); }
  }
  const offer = planReady && planReady.runId !== dismissed;
  return <>
    <PlanNotice harness={conversation.harnessId === 'codex' ? 'Codex' : 'DSH'}/>
    {offer && <PlanReadyCard busy={busy} onImplement={() => void implement()} onKeepPlanning={() => setDismissed(planReady.runId)}/>}
  </>;
}

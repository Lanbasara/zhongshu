import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NativeRequest } from '../types.ts';
import type { RequestAnswer } from '../../shared/workbench.ts';
import { clip } from '../codex/requests.ts';

/**
 * DSH forwards approvals and structured questions to answering clients (ADR 0016). Sub-agents never
 * reach this path: their approvals are pinned to `never` and their questions fail natively.
 */
export const requestKey = (eventId: string) => `ds_${createHash('sha256').update(eventId).digest('base64url').slice(0, 40)}`;

const approvalRequest = z.object({ toolName: z.string().min(1).max(200), callId: z.string().max(400).nullish(), reason: z.string().max(64 * 1024).nullish(),
  displayReason: z.record(z.string().max(16), z.string().max(64 * 1024)).nullish() }).passthrough();
const questionRequest = z.object({
  questions: z.array(z.object({ id: z.string().min(1).max(240), question: z.string().max(64 * 1024), header: z.string().max(400).nullish(), detail: z.string().max(256 * 1024).nullish(),
    options: z.array(z.object({ label: z.string().min(1).max(400), description: z.string().max(4000).nullish() }).passthrough()).max(16).nullish(),
    multiSelect: z.boolean().nullish(),
    // A plan submitted for approval (dsh-plan-mode `exit_plan_mode`): `approve` names the affirmative option.
    intent: z.object({ kind: z.string().max(60), approve: z.string().max(400).nullish() }).passthrough().nullish() }).passthrough()).min(1).max(8),
}).passthrough();

export type Parsed = {
  request: NativeRequest;
  /** Tool call this approval concerns; its arguments are read from the session to show the command. */
  callId?: string;
  outcome(answer: RequestAnswer): { kind: 'result'; value: unknown } | undefined;
};

const fileTools = /(?:^|[_-])(?:write|edit|patch|apply|create|delete|move|rename)(?:$|[_-])/i;

export function parseInteraction(event: string, eventId: string, raw: unknown, now = Date.now()): Parsed | undefined {
  const id = requestKey(eventId);
  if (event === 'approval/request') {
    const parsed = approvalRequest.safeParse(raw); if (!parsed.success) return;
    const value = parsed.data;
    const reason = value.displayReason?.zh ?? value.displayReason?.['zh-CN'] ?? value.reason ?? undefined;
    const action = value.toolName === 'bash' || /shell|exec|command/i.test(value.toolName) ? 'command' as const : fileTools.test(value.toolName) ? 'fileChange' as const : 'other' as const;
    return {
      request: { id, kind: 'approval', createdAt: now, approval: { action, decisions: ['accept', 'decline'], ...(reason ? { reason: clip(reason, 8000) } : {}) } },
      ...(value.callId ? { callId: value.callId } : {}),
      outcome: answer => answer.kind !== 'approval' ? undefined
        : answer.decision === 'accept' ? { kind: 'result', value: 'allowed-once' } : answer.decision === 'decline' ? { kind: 'result', value: 'rejected' } : undefined,
    };
  }
  if (event === 'user-questions/request') {
    const parsed = questionRequest.safeParse(raw); if (!parsed.success) return;
    const questions = parsed.data.questions;
    if (new Set(questions.map(question => question.id)).size !== questions.length) return;
    return {
      request: { id, kind: 'question', createdAt: now, questions: questions.map(question => {
        const options = (question.options ?? []).map(option => ({ label: option.label, ...(option.description ? { description: clip(option.description, 4000) } : {}) }));
        const approve = question.intent?.kind === 'plan-review' ? question.intent.approve ?? undefined : undefined;
        const keep = approve ? options.find(option => option.label !== approve)?.label : undefined;
        const review = approve && keep && options.some(option => option.label === approve) && question.detail ? { approve, keep, plan: clip(question.detail, 64 * 1024) } : undefined;
        return { id: question.id, text: clip(review || !question.detail ? question.question : `${question.question}\n\n${question.detail}`, 16_000),
          ...(question.header ? { header: clip(question.header, 400) } : {}), multiple: !!question.multiSelect, custom: true, options, ...(review ? { review } : {}) };
      }) },
      outcome: answer => {
        if (answer.kind !== 'question' || answer.answers.length !== questions.length) return;
        const answers = [];
        for (const question of questions) {
          const given = answer.answers.find(value => value.id === question.id);
          if (!given) return;
          const labels = new Set((question.options ?? []).map(option => option.label));
          if (given.selected.some(label => !labels.has(label)) || (!question.multiSelect && given.selected.length > 1)) return;
          // Single choice: typed text replaces the selection, as the native UI sends it. A plan review keeps its
          // option: "Keep planning" with feedback; approval is exactly the approve label without feedback.
          const custom = given.custom?.trim();
          const review = question.intent?.kind === 'plan-review' && !!question.intent.approve;
          if (review && given.selected.length !== 1) return;
          if (review && given.selected[0] === question.intent!.approve && custom) return;
          answers.push({ id: question.id, selected: !question.multiSelect && custom && !review ? [] : given.selected, ...(custom ? { custom } : {}) });
        }
        return { kind: 'result', value: { answers } };
      },
    };
  }
  return undefined;
}

/** The command (or other arguments) of the tool call an approval concerns, from a session record. */
export function toolCommand(data: Record<string, unknown>): string | undefined {
  const input = data.input ?? data.arguments;
  const value = typeof input === 'string' ? (() => { try { return JSON.parse(input) as unknown; } catch { return input; } })() : input;
  if (value && typeof value === 'object' && typeof (value as { command?: unknown }).command === 'string') return clip((value as { command: string }).command, 32_000);
  if (typeof value === 'string') return clip(value, 32_000);
  return value === undefined ? undefined : clip(JSON.stringify(value), 32_000);
}

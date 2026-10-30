import { z } from 'zod';
import { HarnessError } from '../types.ts';
import type { Binding, NativeItem, NativeState } from '../types.ts';

export const identifier = z.string().min(1).max(240);
export const modelSchema = z.object({ provider: identifier, model: identifier, reasoningEffort: identifier.optional() });
export type Model = z.infer<typeof modelSchema>;
export const eventSchema = z.object({ type: z.string().max(120), seq: z.number().int().nonnegative(), time: z.number(), data: z.record(z.string(), z.unknown()) });
export type Event = z.infer<typeof eventSchema>;
export const recordSchema = z.object({ type: z.literal('event'), event: eventSchema });
export const outlineSchema = z.array(z.object({ turn: z.number().int().positive(), seq: z.number().int().nonnegative() })).max(50_000)
  .refine(entries => entries.every((entry, index) => index === 0 || (entry.turn > entries[index - 1]!.turn && entry.seq > entries[index - 1]!.seq)));
export type TurnOutline = z.infer<typeof outlineSchema>;
export const projectionsSchema = z.object({ asOfSeq: z.number().int().nonnegative(), values: z.object({
  permissions: z.object({ currentValue: identifier }).optional(),
  modelSelection: z.object({ next: modelSchema.nullable(), lastUsed: modelSchema.nullable() }).optional(),
  turnOutline: outlineSchema.optional(),
  inbox: z.object({ 'next-turn': z.array(z.unknown()).max(1000), 'next-step': z.array(z.unknown()).max(1000) }).optional(),
  userQuestions: z.object({ active: z.array(z.unknown()).max(1000) }).optional(),
}) });
export const snapshotSchema = z.object({ type: z.literal('snapshot'), header: z.object({ id: identifier, cwd: z.string().max(4096).optional() }), cursor: z.number().int().nonnegative(), records: z.array(recordSchema).max(20000), hasMore: z.boolean(), projections: projectionsSchema, assistantStream: z.object({ revision: z.number().int(), activeAttempt: z.object({ attemptId: identifier, turn: z.number().int(), step: z.number().int(), nextIndex: z.number().int().nonnegative(), stream: z.array(z.unknown()).max(20000) }).optional() }).optional() });
export type Snapshot = z.infer<typeof snapshotSchema>;
export const pageSchema = z.object({ records: z.array(recordSchema).max(20000), hasMore: z.boolean() });
// rc.4 approval-policy changes inject this non-waking context into next-step.
// It is consumed with the next user prompt, so it must not block that prompt.
// Other shapes and every next-turn entry remain blocking; never delete inbox data.
const passiveApprovalContext = z.object({
  id: identifier, role: z.literal('user'),
  source: z.object({ kind: z.literal('user-approval') }).strict(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string().max(1024 * 1024) }).strict()).min(1).max(32),
}).strict();
export function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function modelId(model: Model): string { return Buffer.from(JSON.stringify(modelSchema.parse(model))).toString('base64url'); }
export function decodeModel(id: string): Model {
  try { if (!/^[A-Za-z0-9_-]{1,2048}$/.test(id)) throw new Error(); return modelSchema.parse(JSON.parse(Buffer.from(id, 'base64url').toString('utf8'))); }
  catch { throw new HarnessError('DSH_MODEL_INVALID'); }
}
export function sameModel(left: Model | null | undefined, right: Model): boolean { return left?.provider === right.provider && left?.model === right.model && left?.reasoningEffort === right.reasoningEffort; }
export const runId = (session: string, turn: number) => `dsh:${session}:turn:${turn}`;
export const assistantId = (session: string, turn: number, step: number) => `dsh:${session}:assistant:${turn}:${step}`;
const terminalReasons = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']);
/** Locate only an exact run in this session's authoritative outline at this cut. */
export function targetTurnRange(session: string, snapshot: Snapshot, targetRunId?: string): { turn: number; start: number; before: number } | undefined {
  if (!targetRunId || targetRunId.length > 300 || snapshot.header.id !== session || snapshot.projections.asOfSeq !== snapshot.cursor) return;
  const prefix = `dsh:${session}:turn:`;
  if (!targetRunId.startsWith(prefix)) return;
  const turn = Number(targetRunId.slice(prefix.length));
  if (!Number.isSafeInteger(turn) || turn <= 0 || runId(session, turn) !== targetRunId) return;
  const outline = snapshot.projections.values.turnOutline;
  const index = outline?.findIndex(entry => entry.turn === turn) ?? -1;
  if (!outline || index < 0) return;
  const start = outline[index]!.seq; const before = outline[index + 1]?.seq ?? snapshot.cursor + 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(before) || start > snapshot.cursor || before > snapshot.cursor + 1) return;
  return { turn, start, before };
}
/** A later turn alone is insufficient: require the target's own durable closer. */
export function terminalRunFrom(session: string, snapshot: Snapshot, targetRunId?: string, records = snapshot.records): string | undefined {
  const range = targetTurnRange(session, snapshot, targetRunId);
  if (!range) return;
  return records.some(({ event }) => event.type === 'turn/end' && event.data.turn === range.turn
    && event.seq > range.start && event.seq < range.before && event.seq <= snapshot.cursor
    && terminalReasons.has(String(object(event.data.reason).kind))) ? targetRunId : undefined;
}
export function turnAt(outline: TurnOutline, seq: number): number | undefined {
  let low = 0; let high = outline.length - 1; let turn: number | undefined;
  while (low <= high) { const middle = Math.floor((low + high) / 2); const entry = outline[middle]!;
    if (entry.seq <= seq) { turn = entry.turn; low = middle + 1; } else high = middle - 1;
  }
  return turn;
}
/** turnBoundary is a host-internal projection, absent from the Web Host wire contract. */
export function boundaryFrom(snapshot: Snapshot): { openTurnStartSeq: number | null; lastTurn: number } | undefined {
  if (snapshot.projections.asOfSeq !== snapshot.cursor) return;
  const values = snapshot.projections.values; const outline = values.turnOutline;
  if (!outline) return;
  const latest = outline.at(-1);
  if (!latest) {
    const execution = values.modelSelection?.lastUsed != null || snapshot.assistantStream?.activeAttempt !== undefined
      || snapshot.records.some(({ event }) => /^(turn|step|assistant|tool)\//.test(event.type));
    return execution ? undefined : { openTurnStartSeq: null, lastTurn: 0 };
  }
  if (latest.seq > snapshot.cursor) return;
  if (snapshot.records.some(({ event }) => event.type === 'turn/end' && event.data.turn === latest.turn && event.seq > latest.seq))
    return { openTurnStartSeq: null, lastTurn: latest.turn };
  const events = snapshot.records.map(record => record.event).filter(event => event.seq >= latest.seq).sort((a, b) => a.seq - b.seq);
  // Absence of turn/end is evidence only when the entire latest turn through the cut is present.
  if (events[0]?.seq === latest.seq && events[0].type === 'turn/start' && events[0].data.turn === latest.turn
    && events.at(-1)?.seq === snapshot.cursor && events.every((event, index) => index === 0 || event.seq === events[index - 1]!.seq + 1))
    return { openTurnStartSeq: latest.seq, lastTurn: latest.turn };
}
export function textContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const value of content) { const block = object(value); if (block.type === 'text' && typeof block.text === 'string') text += block.text; if (text.length > 1024 * 1024) throw new HarnessError('DSH_ITEM_TOO_LARGE'); }
  return text;
}
export function stateFrom(binding: Binding, snapshot: Snapshot): NativeState {
  if (snapshot.header.id !== binding.id || snapshot.header.cwd !== binding.cwd) throw new HarnessError('DSH_BINDING_MISMATCH');
  const values = snapshot.projections.values; const selected = decodeModel(binding.configuration.modelId);
  const configurationVerified = sameModel(values.modelSelection?.next, selected) && (!values.modelSelection?.lastUsed || sameModel(values.modelSelection.lastUsed, selected)) && values.permissions?.currentValue === binding.configuration.permissionId;
  const pendingInputs = (values.inbox?.['next-turn'].length ?? 0)
    + (values.inbox?.['next-step'].filter(input => !passiveApprovalContext.safeParse(input).success).length ?? 0);
  const boundary = boundaryFrom(snapshot);
  const latestRun = boundary && boundary.lastTurn > 0 ? runId(binding.id, boundary.lastTurn) : undefined;
  if (!configurationVerified) return { status: boundary?.openTurnStartSeq != null ? 'running' : 'unknown', runId: latestRun, pendingInputs, configurationVerified: false, reason: '原生模型或权限与对话配置不一致，已停止派发；正在执行的工作仍可停止。' };
  if (!boundary || !values.inbox) return { status: 'unknown', pendingInputs, configurationVerified, reason: '原生状态不完整，需要重新核对。' };
  const running = boundary.openTurnStartSeq !== null;
  const approvals = new Set<string>(); const questions = new Set<string>();
  let lastEnd: string | undefined;
  for (const { event } of snapshot.records) {
    const data = event.data;
    if (event.type === 'approval/asked' && typeof data.id === 'string') approvals.add(data.id);
    if (event.type === 'approval/decided' && typeof data.id === 'string') approvals.delete(data.id);
    if (event.type === 'tool/call' && data.name === 'ask_user_question' && typeof data.callId === 'string') questions.add(data.callId);
    if (event.type === 'tool/result') { const id = object(data.message).toolCallId; if (typeof id === 'string') questions.delete(id); }
    if (event.type === 'turn/end' && data.turn === boundary.lastTurn) lastEnd = String(object(data.reason).kind);
  }
  if (values.userQuestions?.active.length || (running && (approvals.size || questions.size))) return { status: 'waiting', runId: latestRun, pendingInputs, configurationVerified, reason: 'DSH 正等待原生交互；此版本不转发审批或回答，请在原生界面处理或停止。' };
  if (running) return { status: 'running', runId: latestRun, pendingInputs, configurationVerified };
  if (lastEnd === 'interrupted' || lastEnd === 'aborted') return { status: 'interrupted', runId: latestRun, pendingInputs, configurationVerified, reason: lastEnd === 'aborted' ? '本轮已停止；原生排队输入可能仍保留。' : 'DSH 进程中断了本轮；工具副作用需要单独核对。' };
  if (lastEnd && lastEnd !== 'completed') return { status: 'failed', runId: latestRun, pendingInputs, configurationVerified, reason: '原生本轮未正常完成。' };
  return { status: 'idle', runId: latestRun, pendingInputs, configurationVerified };
}

export function itemFrom(session: string, event: Event, live = false, inferredTurn?: number): NativeItem | undefined {
  const data = event.data; const turn = typeof data.turn === 'number' ? data.turn : inferredTurn;
  const base = { id: `dsh:${session}:event:${event.seq}`, status: 'completed' as const, runId: turn === undefined ? undefined : runId(session, turn) };
  if (event.type === 'user/message' && typeof object(data.source).rpcId === 'string') return { ...base, kind: 'user', text: textContent(data.content), operationId: String(object(data.source).rpcId) };
  if (event.type === 'assistant/message' && turn !== undefined && typeof data.step === 'number') {
    const text = textContent(object(data.message).content); if (!text) return;
    return { ...base, id: assistantId(session, turn, data.step), kind: 'assistant', text, status: data.interrupted === true ? 'failed' : 'completed' };
  }
  if (event.type === 'tool/call' && live && typeof data.callId === 'string') return { ...base, id: `dsh:${session}:tool:${data.callId}`, kind: 'tool', text: typeof data.name === 'string' ? data.name.slice(0, 120) : '工具执行', status: 'running' };
  if (event.type === 'tool/result') {
    const message = object(data.message); if (typeof message.toolCallId !== 'string') return;
    return { ...base, id: `dsh:${session}:tool:${message.toolCallId}`, kind: 'tool', text: message.isError ? '工具执行失败或结果未知' : '工具已完成', status: message.isError ? 'failed' : 'completed' };
  }
  if (event.type === 'approval/asked') return { ...base, kind: 'notice', text: 'DSH 请求审批；此版本不自动批准，请在原生界面处理。' };
  if (event.type === 'approval/decided' && data.outcome === 'unavailable') return { ...base, kind: 'notice', text: 'DSH 没有可用的审批处理入口；本次请求未获授权。', status: 'failed' };
  if (event.type === 'turn/end' && object(data.reason).kind !== 'completed') return { ...base, kind: 'notice', text: object(data.reason).kind === 'interrupted' ? 'DSH 进程在本轮完成前退出，工具结果需核对。' : '原生本轮已停止或未正常完成。', status: 'failed' };
}
export function historyItems(session: string, events: Event[], activeTurn?: number, outline: TurnOutline = []): NativeItem[] {
  const items = new Map<string, NativeItem>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) { const turn = turnAt(outline, event.seq); const item = itemFrom(session, event, activeTurn !== undefined && (event.data.turn ?? turn) === activeTurn, turn); if (item) items.set(item.id, item); }
  return [...items.values()];
}

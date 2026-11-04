import { z } from 'zod';
import { HarnessError } from '../types.ts';
import type { Binding, NativeState } from '../types.ts';
import { decodeModel, identifier, modelSchema, runId, sameModel } from './native.ts';
import type { Connection } from './connection.ts';
import type { BoundedDshReader } from './bounded-reader.ts';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reason = z.enum(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']);
export const boundedStateSchema = z.object({ protocol: z.literal(1), nativeVersion: z.literal('0.2.1-rc.4'), epoch: z.string().uuid(), sessionId: identifier, cwd: z.string().max(4096), cursor: z.number().int().min(-1),
  boundary: z.object({ openTurnStartSeq: count.nullable(), lastTurn: count }), pendingInputs: count.max(1000), waiting: z.boolean(), latestEnd: reason.optional(),
  values: z.object({ modelSelection: z.object({ next: modelSchema.nullable(), lastUsed: modelSchema.nullable() }), permissions: z.object({ currentValue: identifier }), tokenUsage: z.unknown().optional(), contextPressure: z.unknown().optional() }),
  terminal: z.object({ turn: count.min(1), seq: count, reason }).optional(), accepted: z.object({ id: identifier, turn: count.min(1).optional() }).optional(),
});
export type BoundedState = z.infer<typeof boundedStateSchema>;
export const boundedFrameSchema = z.object({ type: z.literal('bounded-state'), state: boundedStateSchema, invalidate: z.boolean(), preview: z.object({ turn: count.min(1), step: count, text: z.string().max(8192) }).optional() });
const terminalStatus = (value: string): 'completed' | 'interrupted' | 'failed' => value === 'completed' ? 'completed' : ['aborted', 'interrupted'].includes(value) ? 'interrupted' : 'failed';
const closedStatus = (value: string): 'idle' | 'interrupted' | 'failed' => value === 'completed' ? 'idle' : ['aborted', 'interrupted'].includes(value) ? 'interrupted' : 'failed';
export function targetTurn(binding: Binding, target?: string): number | undefined {
  if (!target) return;
  const prefix = `dsh:${binding.id}:turn:`;
  if (!target.startsWith(prefix)) return;
  const turn = Number(target.slice(prefix.length)); return Number.isSafeInteger(turn) && turn > 0 && runId(binding.id, turn) === target ? turn : undefined;
}
export function boundedStateFrom(binding: Binding, state: BoundedState, target?: string): NativeState {
  if (state.sessionId !== binding.id || state.cwd !== binding.cwd || (state.boundary.openTurnStartSeq !== null && state.boundary.openTurnStartSeq > state.cursor)) throw new HarnessError('DSH_BINDING_MISMATCH');
  const selected = decodeModel(binding.configuration.modelId), models = state.values.modelSelection;
  const configurationVerified = sameModel(models.next, selected) && (!models.lastUsed || sameModel(models.lastUsed, selected)) && state.values.permissions.currentValue === binding.configuration.permissionId;
  const running = state.boundary.openTurnStartSeq !== null;
  const result: NativeState = { status: running ? state.waiting ? 'waiting' : 'running' : state.latestEnd ? closedStatus(state.latestEnd) : state.boundary.lastTurn === 0 ? 'idle' : 'unknown',
    pendingInputs: state.pendingInputs, configurationVerified, ...(state.boundary.lastTurn > 0 ? { runId: runId(binding.id, state.boundary.lastTurn) } : {}) };
  if (!configurationVerified) { result.status = running ? 'running' : 'unknown'; result.reason = '原生模型或权限与对话配置不一致，已停止派发；正在执行的工作仍可停止。'; }
  if (result.status === 'unknown') result.reason ??= '原生终态证据尚未完整，需要重新核对。';
  if (result.status === 'waiting') result.reason = 'DSH 正等待原生交互；请在原生界面处理或停止。';
  if (target && state.terminal && state.terminal.turn === targetTurn(binding, target) && state.terminal.seq <= state.cursor) { result.terminalRunId = target; result.terminalStatus = terminalStatus(state.terminal.reason); }
  return result;
}
export async function readBoundedState(connection: Connection, reader: BoundedDshReader | undefined, binding: Binding, target?: string): Promise<BoundedState> {
  const turn = targetTurn(binding, target), request = { sessionId: binding.id, cwd: binding.cwd, ...(turn ? { targetTurn: turn } : {}) };
  const state = boundedStateSchema.parse(await connection.call('zhongshuBounded/state', { request }));
  boundedStateFrom(binding, state, target);
  if (!turn || state.terminal || !reader) return state;
  // The ring is only a hot cache. Each retry advances the physical index; an
  // exact indexed closer is then checked in the current live native Session.
  const scan = await reader.scan({ sessionId: binding.id, cwd: binding.cwd });
  if (scan.throughSeq < 0) return state;
  const candidate = await reader.terminal({ sessionId: binding.id, cwd: binding.cwd, sourceGeneration: scan.sourceGeneration, throughSeq: Math.min(scan.throughSeq, state.cursor), turn });
  if (!candidate) return state;
  const verified = boundedStateSchema.parse(await connection.call('zhongshuBounded/state', { request: { ...request, terminalSeq: candidate.seq } }));
  boundedStateFrom(binding, verified, target); return verified;
}

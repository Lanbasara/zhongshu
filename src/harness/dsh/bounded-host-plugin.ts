/**
 * Dedicated DSH rc.4 Host plugin. Deploy this compiled module with a Cordis
 * patch disabling session-turn-outline. This module imports the operator's
 * native packages, never a second copy of Cordis, and never changes native files.
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const name = 'zhongshu-bounded-host';
export const inject = ['sessionController', 'sessionProjections', 'sessions', 'typert', 'remoteAccess'];
export const nativeVersion = '0.2.1-rc.4';
type Json = Record<string, unknown>;
type Event = { seq: number; type: string; data: Json };
type Session = { id: string; seq: number; header: Json; eventAt(seq: number): Event | undefined };
type HostContext = {
  sessionController: { resolveAgent(id: string): Promise<{ agent?: unknown; error?: unknown }> };
  sessions: { get(id: string): Session | undefined };
  sessionProjections: { register(definition: unknown): () => void; stateOf(session: Session, key: string): unknown; snapshot(session: Session, keys: string[]): { asOfSeq: number; values: Json } };
  on(name: string, listener: (...args: unknown[]) => void, options?: { global: boolean }): () => void;
};
type Terminal = { turn: number; seq: number; reason: string };
export type BoundedFold = { turn: number; approvals: string[]; overflow: boolean; terminals: Terminal[]; accepted: { id: string; turn: number }[] };
const obj = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const integer = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 240;
const reasons = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']);
function fail(): never { throw new Error('zhongshu_bounded_host_unavailable'); }
export const initialFold = (): BoundedFold => ({ turn: 0, approvals: [], overflow: false, terminals: [], accepted: [] });
/** Fixed-size host-only fold; it never stores messages, outlines, or past tools. */
export function foldBounded(state: BoundedFold, event: Event): BoundedFold {
  const d = event.data;
  if (event.type === 'turn/start' && integer(d.turn, 1)) return { ...state, turn: d.turn, approvals: [], overflow: false };
  if (event.type === 'approval/asked' && id(d.id)) {
    if (state.approvals.includes(d.id)) return state;
    return state.approvals.length >= 128 ? { ...state, overflow: true } : { ...state, approvals: [...state.approvals, d.id] };
  }
  if (event.type === 'approval/decided' && id(d.id)) return { ...state, approvals: state.approvals.filter(value => value !== d.id) };
  if (event.type === 'user/message' && id(obj(d.source).rpcId)) return { ...state, accepted: [...state.accepted.slice(-63), { id: obj(d.source).rpcId as string, turn: state.turn }] };
  if (event.type === 'turn/end' && integer(d.turn, 1) && reasons.has(String(obj(d.reason).kind)))
    return { ...state, approvals: [], overflow: false, terminals: [...state.terminals.slice(-63), { turn: d.turn, seq: event.seq, reason: String(obj(d.reason).kind) }] };
  return state;
}
function passive(value: unknown): boolean {
  const v = obj(value), source = obj(v.source);
  return Object.keys(v).length === 4 && id(v.id) && v.role === 'user' && Object.keys(source).length === 1 && source.kind === 'user-approval'
    && Array.isArray(v.content) && v.content.length > 0 && v.content.length <= 32
    && v.content.every(block => { const b = obj(block); return Object.keys(b).length === 2 && b.type === 'text' && typeof b.text === 'string' && b.text.length <= 1024 * 1024; });
}
function readState(ctx: HostContext, session: Session, epoch: string, request: Json): Json {
  const p = ctx.sessionProjections;
  // An accidentally retained outline defeats the algorithmic contract. Fail closed.
  if (p.stateOf(session, 'turnOutline') !== undefined) fail();
  const boundary = obj(p.stateOf(session, 'turnBoundary')), inbox = obj(p.stateOf(session, 'inbox'));
  const fold = p.stateOf(session, 'zhongshuBounded') as BoundedFold | undefined;
  const questions = obj(obj(p.stateOf(session, 'userQuestions')).questions).active;
  if (!integer(boundary.lastTurn) || !(boundary.openTurnStartSeq === null || integer(boundary.openTurnStartSeq)) || !fold
    || !Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step']) || !Array.isArray(questions)) fail();
  const nextTurn = inbox['next-turn'] as unknown[], nextStep = inbox['next-step'] as unknown[];
  if (nextTurn.length + nextStep.length > 1000 || questions.length > 1000 || fold.overflow) fail();
  const snapshot = p.snapshot(session, ['modelSelection', 'permissions', 'tokenUsage', 'contextPressure']);
  if (snapshot.asOfSeq !== session.seq - 1) fail();
  let terminal = integer(request.targetTurn, 1) ? fold.terminals.find(t => t.turn === request.targetTurn) : undefined;
  if (!terminal && integer(request.terminalSeq) && integer(request.targetTurn, 1)) {
    // rc.4 compatibility seam: public but deprecated eventAt is an exact O(1)
    // immutable lookup. QueryEngine's replacement copies the entire live log.
    // Never use this seam without the package-version and behavior gates below.
    const event = session.eventAt(request.terminalSeq);
    if (event?.seq === request.terminalSeq && event.type === 'turn/end' && event.data.turn === request.targetTurn && reasons.has(String(obj(event.data.reason).kind)))
      terminal = { turn: request.targetTurn, seq: event.seq, reason: String(obj(event.data.reason).kind) };
  }
  const latest = fold.terminals.at(-1);
  const operationId = request.operationId;
  const pendingOperation = id(operationId) && [...nextTurn, ...nextStep].some(v => obj(obj(v).source).rpcId === operationId);
  const accepted = id(operationId) ? fold.accepted.find(v => v.id === operationId) : undefined;
  const response = { protocol: 1, nativeVersion, epoch, sessionId: session.id, cwd: session.header.cwd, cursor: snapshot.asOfSeq,
    boundary: { openTurnStartSeq: boundary.openTurnStartSeq, lastTurn: boundary.lastTurn }, pendingInputs: nextTurn.length + nextStep.filter(v => !passive(v)).length,
    waiting: questions.length > 0 || (boundary.openTurnStartSeq !== null && fold.approvals.length > 0),
    latestEnd: latest && latest.turn === boundary.lastTurn ? latest.reason : undefined, values: snapshot.values,
    ...(terminal ? { terminal } : {}), ...(pendingOperation || accepted ? { accepted: { id: operationId, ...(accepted?.turn ? { turn: accepted.turn } : {}) } } : {}) };
  if (Buffer.byteLength(JSON.stringify(response)) > 16 * 1024) fail();
  return response;
}
type MethodDecorator = (method: unknown, context: { kind: 'method'; name: string; private: false; static: false; addInitializer(fn: (this: unknown) => void): void }) => void;
type NativeProtocol = { TypertRemoteService: new(ctx: HostContext, key: string) => { ctx: HostContext }; Remote(options: Json): MethodDecorator };
async function verifyRuntimeModule(require: ReturnType<typeof createRequire>, packageName: string): Promise<void> {
  const entry = require.resolve(packageName);
  const metadata = JSON.parse(await readFile(join(dirname(dirname(entry)), 'package.json'), 'utf8')) as Json;
  if (metadata.name !== packageName || metadata.version !== nativeVersion) fail();
}
/** Public Cordis plugin entry. runtimeRoot is a deployment-owned installation. */
export async function apply(ctx: HostContext, config: { runtimeRoot: string }): Promise<void> {
  if (!config || typeof config.runtimeRoot !== 'string' || !isAbsolute(config.runtimeRoot) || config.runtimeRoot.length > 4096) fail();
  const require = createRequire(join(config.runtimeRoot, 'package.json'));
  for (const packageName of ['@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-api-session-controller']) await verifyRuntimeModule(require, packageName);
  // Node 24's synchronous ESM loading preserves the Host's one Cordis identity.
  // The fixed entry names are intentionally visible to the product boundary gate.
  const protocol = require('@deepseek-ai/dsh-typert-protocol') as NativeProtocol;
  const { z } = require('zod') as typeof import('zod');
  const terminal = z.object({ turn: z.number().int().positive(), seq: z.number().int().nonnegative(), reason: z.enum([...reasons] as [string, ...string[]]) });
  ctx.sessionProjections.register({ key: 'zhongshuBounded', stateVersion: 1, init: initialFold, apply: foldBounded,
    stateSchema: z.object({ turn: z.number().int().nonnegative(), approvals: z.array(z.string().min(1).max(240)).max(128), overflow: z.boolean(), terminals: z.array(terminal).max(64), accepted: z.array(z.object({ id: z.string().min(1).max(240), turn: z.number().int().nonnegative() })).max(64) }).strict() });
  const requestSchema = z.object({ sessionId: z.string().min(1).max(240), cwd: z.string().min(1).max(4096), targetTurn: z.number().int().positive().optional(), terminalSeq: z.number().int().nonnegative().optional(), operationId: z.string().min(1).max(240).optional() }).strict();
  const epoch = randomUUID(); const initializers: ((this: unknown) => void)[] = [];
  let followers = 0;
  async function resolve(context: HostContext, request: unknown): Promise<{ session: Session; request: Json }> {
    const parsed = requestSchema.parse(request);
    const found = await context.sessionController.resolveAgent(parsed.sessionId);
    const session = context.sessions.get(parsed.sessionId);
    if (!found.agent || found.error || !session || session.id !== parsed.sessionId || session.header.cwd !== parsed.cwd || typeof session.eventAt !== 'function') fail();
    return { session, request: parsed };
  }
  class BoundedHost extends protocol.TypertRemoteService {
    constructor() { super(ctx, 'zhongshuBounded'); for (const initialize of initializers) initialize.call(this); }
    async state(request: unknown) { const resolved = await resolve(this.ctx, request); return readState(this.ctx, resolved.session, epoch, resolved.request); }
    async *follow(request: unknown, signal: AbortSignal) {
      if (followers >= 32) fail(); followers++;
      let removeEvent: (() => void) | undefined, removeStream: (() => void) | undefined, removeDisposed: (() => void) | undefined;
      let dirty = true, invalidated = true, disposed = false;
      let preview: { turn: number; step: number; text: string } | undefined, previewDirty = false;
      let wake: (() => void) | undefined;
      const notify = () => { wake?.(); wake = undefined; };
      signal.addEventListener('abort', notify);
      try {
        const resolved = await resolve(this.ctx, request), session = resolved.session;
        removeEvent = this.ctx.on('session/event', (...args) => { if (args[0] !== session) return; dirty = true; invalidated = true; const event = args[1] as Event; if (event.type === 'assistant/message') { preview = undefined; previewDirty = false; } notify(); }, { global: true });
        removeDisposed = this.ctx.on('session/disposed', (...args) => { if (args[0] === session) { disposed = true; notify(); } }, { global: true });
        removeStream = this.ctx.on('agent/assistant-stream', (...args) => {
          const value = obj(args[0]), agent = obj(value.agent); if (agent.session !== session) return;
          const frame = obj(value.frame);
          if (frame.type === 'start' && integer(frame.turn, 1) && integer(frame.step)) preview = { turn: frame.turn, step: frame.step, text: '' };
          const chunk = obj(frame.chunk);
          if (frame.type === 'chunk' && preview && chunk.type === 'text-delta' && typeof chunk.text === 'string') { preview.text += chunk.text.slice(0, Math.max(0, 8192 - preview.text.length)); previewDirty = true; notify(); }
          if (frame.type === 'end') { preview = undefined; previewDirty = false; dirty = true; invalidated = true; notify(); }
        }, { global: true });
        while (!signal.aborted) {
          if (disposed || this.ctx.sessions.get(session.id) !== session) fail();
          if (dirty || invalidated || previewDirty) {
            const frame = { type: 'bounded-state', state: readState(this.ctx, session, epoch, resolved.request), invalidate: invalidated,
              ...(previewDirty && preview?.text ? { preview: { ...preview } } : {}) };
            dirty = false; invalidated = false; previewDirty = false; yield frame;
            await delay(100, undefined, { signal });
          } else await new Promise<void>(resolveWait => { wake = resolveWait; if (signal.aborted) notify(); });
        }
      } finally { followers--; removeEvent?.(); removeStream?.(); removeDisposed?.(); signal.removeEventListener('abort', notify); }
    }
  }
  for (const method of ['state', 'follow'] as const) protocol.Remote({ ...(method === 'follow' ? { mode: 'stream' } : {}), resources: { session: (request: unknown) => requestSchema.parse(request).sessionId } })(BoundedHost.prototype[method], { kind: 'method', name: method, private: false, static: false, addInitializer: fn => initializers.push(fn) });
  new BoundedHost();
}

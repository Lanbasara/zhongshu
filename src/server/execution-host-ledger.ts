import { Worker } from 'node:worker_threads';
import { deserialize } from 'node:v8';
import { z } from 'zod';
import { encodeStorageValue } from './storage-client.ts';
import type { ExecutionGroupState, ExecutionEpoch } from './execution-controller.ts';
import type { ContainerProof } from './execution-host-docker.ts';
import type { StorageCapacity } from './storage-capacity.ts';
import { ExecutionHostError } from './execution-host-docker.ts';

export const hostIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const hostSha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const hostEpochSchema = z.object({ generation: hostIdentifier, epoch: z.number().int().nonnegative().safe() }).strict();
export const hostGroupSchema = hostEpochSchema.extend({ groupId: hostIdentifier, frozenSetId: hostSha256.optional() }).strict();
export const hostControlSchema = z.object({ action: z.enum(['fence', 'quiesce', 'resume']), requestId: hostIdentifier, expected: hostEpochSchema, frozenSetId: hostSha256.optional() }).strict();
export type HostControl = z.infer<typeof hostControlSchema>;
export type HostRecord = { configurationDigest: string; state: ExecutionGroupState; containerId: string | null; initialized: boolean; intent: HostControl | null; capacity: StorageCapacity };
export type HostPermission = { requestId: string; admissionId: string; contentDigest: string; wireDigest: string;
  purpose: 'execute' | 'stop'; groups: z.infer<typeof hostGroupSchema>[] };
export const hostPermissionSchema = z.object({ requestId: hostIdentifier, admissionId: hostIdentifier, contentDigest: hostSha256, wireDigest: hostSha256,
  purpose: z.enum(['execute', 'stop']), groups: z.array(hostGroupSchema).min(1).max(32).refine(values => new Set(values.map(value => value.groupId)).size === values.length),
}).strict();
export type HostForward = { created: boolean; status: 'forwarding' | 'settled'; result?: unknown; binding?: unknown };
export interface ExecutionHostLedger {
  ready: Promise<void>;
  load(): Promise<HostRecord>;
  attachContainer(proof: ContainerProof): Promise<void>;
  initialize(proof: ContainerProof): Promise<ExecutionGroupState>;
  beginControl(input: HostControl): Promise<{ status: 'pending' } | { status: 'complete'; state: ExecutionGroupState }>;
  completeControl(requestId: string, proof: ContainerProof): Promise<ExecutionGroupState>;
  confirm(expected: ExecutionEpoch, proof: ContainerProof): Promise<ExecutionGroupState>;
  claimForward(permission: HostPermission): Promise<HostForward>;
  readForward(requestId: string, wireDigest: string): Promise<HostForward | null>;
  readCreatedBinding(conversationId: string): Promise<unknown | null>;
  recordBinding(requestId: string, binding: unknown): Promise<void>;
  settleForward(requestId: string, result: unknown): Promise<void>;
  close(): Promise<void>;
}
export const hostLedgerMethods = ['load', 'attachContainer', 'initialize', 'beginControl', 'completeControl', 'confirm', 'claimForward', 'readForward', 'readCreatedBinding', 'recordBinding', 'settleForward'] as const;
export const hostLedgerOptionsSchema = z.object({ directory: z.string().min(1).max(4096), groupId: hostIdentifier, configurationDigest: hostSha256,
  capacity: z.object({ quotaBytes: z.number().int().min(1024 ** 2).max(Number.MAX_SAFE_INTEGER).default(2 * 1024 ** 3),
    reserveBytes: z.number().int().nonnegative().safe().default(64 * 1024 ** 2), minimumFreeBytes: z.number().int().nonnegative().safe().default(512 * 1024 ** 2),
  }).strict().default({ quotaBytes: 2 * 1024 ** 3, reserveBytes: 64 * 1024 ** 2, minimumFreeBytes: 512 * 1024 ** 2 }),
  requestTimeoutMs: z.number().int().min(100).max(120_000).default(30_000), maxPending: z.number().int().min(1).max(256).default(64),
}).strict();

/** A distinct controller journal survives application database rollback. Every
 * command is a complete worker-owned transaction; no process I/O runs in SQL.
 * Crashes retain forwarding/intent records. Nothing is retried by this client.
 */
export function createExecutionHostLedger(input: z.input<typeof hostLedgerOptionsSchema>): ExecutionHostLedger {
  const options = hostLedgerOptionsSchema.parse(input);
  const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './execution-host-ledger-worker.ts' : './execution-host-ledger-worker.js', import.meta.url), {
    workerData: options, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 },
  });
  let sequence = 0; let closing = false; let failure: Error | undefined; let finishReady!: () => void; let failReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { finishReady = resolve; failReady = reject; }); void ready.catch(() => {});
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const startTimer = setTimeout(() => fail(new ExecutionHostError('execution_ledger_startup_timeout', 503)), options.requestTimeoutMs);
  let stopped: Promise<number> | undefined;
  function fail(error: Error) { if (failure) return; failure = error; clearTimeout(startTimer); failReady(error); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); stopped = worker.terminate(); }
  worker.on('error', () => fail(new ExecutionHostError('execution_ledger_unavailable', 503)));
  worker.on('exit', () => { if (!closing) fail(new ExecutionHostError('execution_ledger_unavailable', 503)); });
  worker.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message)) { fail(new ExecutionHostError('execution_ledger_invalid_response', 502)); return; }
    if (message.type === 'ready') { clearTimeout(startTimer); finishReady(); return; }
    if (message.type === 'fatal') { fail(new ExecutionHostError('execution_ledger_unavailable', 503)); return; }
    const parsed = z.object({ type: z.literal('result'), id: z.number().int().positive().safe(), data: z.instanceof(Uint8Array) }).strict().safeParse(message);
    if (!parsed.success || parsed.data.data.byteLength > 128 * 1024) { fail(new ExecutionHostError('execution_ledger_invalid_response', 502)); return; }
    const item = pending.get(parsed.data.id); if (!item) { fail(new ExecutionHostError('execution_ledger_invalid_response', 502)); return; }
    pending.delete(parsed.data.id); clearTimeout(item.timer);
    try { const reply = z.object({ result: z.unknown().optional(), error: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).optional() }).strict().parse(deserialize(parsed.data.data));
      if (reply.error) item.reject(new ExecutionHostError(reply.error)); else item.resolve(reply.result);
    } catch { item.reject(new ExecutionHostError('execution_ledger_result_unknown', 503)); }
  });
  async function call(method: typeof hostLedgerMethods[number], args: unknown[]) {
    if (closing || failure) throw failure ?? new ExecutionHostError('execution_ledger_closed', 503);
    if (pending.size >= options.maxPending) throw new ExecutionHostError('execution_ledger_busy', 429);
    const data = encodeStorageValue({ method, args }, 96 * 1024); const id = ++sequence;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => fail(new ExecutionHostError('execution_ledger_result_unknown', 503)), options.requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      void ready.then(() => { if (!failure) worker.postMessage({ type: 'request', id, data }); }, reject);
    });
  }
  let closed: Promise<void> | undefined;
  return { ...Object.fromEntries(hostLedgerMethods.map(method => [method, (...args: unknown[]) => call(method, args)])), ready,
    close() { return closed ??= (async () => { closing = true; await ready.catch(() => {}); while (pending.size && !failure) await new Promise(resolve => setTimeout(resolve, 5));
      if (stopped) await stopped; else { worker.postMessage({ type: 'close' }); await new Promise<void>(resolve => worker.once('exit', () => resolve())); } })(); },
  } as ExecutionHostLedger;
}

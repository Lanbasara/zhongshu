import { isAbsolute } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { StoreError, type WorkbenchStore, type WorkbenchChange } from './workbench-store.ts';
import type { AuthStore, AsyncAuthStore } from './auth-store.ts';
import type { PluginStore, AsyncPluginStore } from './plugin-store.ts';
import type { WorkspaceStore, AsyncWorkspaceStore } from './workspace-store.ts';
import type { ExecutionStore, AsyncExecutionStore } from './execution-store.ts';

type AsyncMethods<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never };
export type AsyncWorkbenchStore = AsyncMethods<Omit<WorkbenchStore, 'resources'>> & { resources: AsyncMethods<WorkbenchStore['resources']> };
export type StorageOutcome = 'not_started' | 'rejected' | 'unknown' | 'committed';
export class StorageClientError extends StoreError {
  readonly outcome: StorageOutcome;
  constructor(code: string, outcome: StorageOutcome, statusCode = 503) {
    super(code, statusCode); this.name = 'StorageClientError'; this.outcome = outcome;
  }
}

// This exhaustive allowlist is the RPC contract. Adding a repository method
// requires explicitly classifying it; arbitrary property/SQL access is absent.
export const storageMethods = {
  createConversation: 'write', getConversation: 'read', listConversations: 'read', searchConversations: 'read', renameConversation: 'write',
  setArchived: 'unsupported', setArchivedChecked: 'write', saveBinding: 'write', setConversationState: 'write', setUsage: 'write', setHistoryCursor: 'write',
  enqueueOperation: 'write', getOperation: 'read', listOperations: 'read', claimOperation: 'write', settleOperation: 'write',
  recoverDispatching: 'write', readQueue: 'read', queuedConversations: 'read', queueAdmissionExists: 'read', changeQueue: 'write',
  readQueueSummary: 'read', readQueueEntry: 'read', readTurnFilesPage: 'read',
  operationState: 'read',
  readOperationViews: 'read',
  claimQueue: 'write', pauseQueue: 'write', changes: 'read', version: 'read', mergeHistory: 'write', saveLiveItem: 'write',
  getItem: 'read', hasHistoryItem: 'read', operationRunId: 'read', readHistory: 'read', readTurnFiles: 'read', readBody: 'read',
  archiveJobs: 'read', dueArchiveJobs: 'read', claimArchiveJob: 'write', commitArchivePage: 'write', failArchiveJob: 'write',
  restartArchiveJob: 'write', advanceArchiveMaintenance: 'write',
  pendingArchiveItems: 'read', refreshArchiveItems: 'write',
  archiveUpdates: 'read', commitArchiveUpdates: 'write', resetArchiveUpdates: 'write',
  yieldArchiveJob: 'write',
  beginBodyStage: 'write', stageBodyChunk: 'write', validateBodyStage: 'write', finishBodyStage: 'write',
  capacity: 'read', advanceHistoryIndex: 'write', advanceStorageMaintenance: 'write',
} as const satisfies Record<Exclude<keyof WorkbenchStore, 'resources'>, 'read' | 'write' | 'unsupported'>;
export const storageResourceMethods = { get: 'read', owned: 'read', put: 'write', pin: 'write', remove: 'write', maintenance: 'write' } as const satisfies Record<keyof WorkbenchStore['resources'], 'read' | 'write'>;
export const storagePluginMethods = { find: 'read', current: 'read', recoverApplying: 'write', claim: 'write', settle: 'write', findSource: 'read', currentSource: 'read', claimSource: 'write', settleSource: 'write', recoverSources: 'write' } as const satisfies Record<keyof PluginStore, 'read' | 'write'>;
export const storageWorkspaceMethods = { get: 'read', page: 'read', matches: 'read', checkCapacity: 'read', registerLegacy: 'write', register: 'write', rename: 'write', pin: 'write', remove: 'write', restore: 'write' } as const satisfies Record<keyof WorkspaceStore, 'read' | 'write'>;
export const storageAuthMethods = { administrator: 'read', initialized: 'read', reserveAttempt: 'write', initialize: 'write', reset: 'write', mintSession: 'write', authenticateHash: 'read', logoutHash: 'write' } as const satisfies Record<keyof AuthStore, 'read' | 'write'>;
export const storageExecutionMethods = { load: 'read', save: 'write', registerGroup: 'write', registerScope: 'write', cancelScopeRegistration: 'write', registerConflicts: 'write', conflictGroups: 'read', workspaceGroups: 'read',
  registerHostGroup: 'write', hostAdmission: 'read', bindHostPluginRequest: 'write', settleHostPlugin: 'write',
  baselineStatus: 'read', beginBaseline: 'write', seedLegacyAdmissions: 'write', bindingsPage: 'read', registerBaselineObservation: 'write', commitBaselineBatch: 'write',
  bindNativeRequest: 'write', bindAssociatedRequest: 'write', bindObservationRequest: 'write', registerObservation: 'write', permissionForStop: 'write', registerNative: 'write', permissionForNative: 'read', attachNativeBinding: 'write',
  freezeAdmissions: 'write', pendingPage: 'read', unresolvedPage: 'read', beginResume: 'write', hasUnsettledSaves: 'read', completeResume: 'write',
  acquireSave: 'write', settleSave: 'write', pendingSaves: 'read', admission: 'read', confirmTerminal: 'write',
} as const satisfies Record<keyof ExecutionStore, 'read' | 'write'>;
export const storageCommandMethods = { auth: storageAuthMethods, store: storageMethods, resources: storageResourceMethods, plugins: storagePluginMethods, workspaces: storageWorkspaceMethods, execution: storageExecutionMethods };

const limitsSchema = z.object({
  maxPending: z.number().int().min(1).max(1024).default(64),
  maxQueuedBytes: z.number().int().min(256).max(128 * 1024 * 1024).default(16 * 1024 * 1024),
  maxRequestBytes: z.number().int().min(256).max(16 * 1024 * 1024).default(8 * 1024 * 1024),
  maxResultBytes: z.number().int().min(512).max(16 * 1024 * 1024).default(8 * 1024 * 1024),
  requestTimeoutMs: z.number().int().min(10).max(120_000).default(30_000),
  startupTimeoutMs: z.number().int().min(10).max(120_000).default(15_000),
  workerMemoryMb: z.number().int().min(32).max(2048).default(256),
}).strict();
export const storageConfigurationSchema = limitsSchema.extend({ dataDirectory: z.string().min(1).max(4096).refine(isAbsolute),
  capacity: z.object({ quotaBytes: z.number().int().positive().safe(), reserveBytes: z.number().int().nonnegative().safe(), minimumFreeBytes: z.number().int().nonnegative().safe(), transientBytes: z.number().int().min(65536).safe().optional() }).strict().optional(),
}).strict();
export type StorageClientOptions = z.input<typeof storageConfigurationSchema> & {
  onChange?: (event: WorkbenchChange) => void;
  onReset?: () => void;
  /** Fatal owner failure only, never queue pressure or a rejected transaction. */
  onFailure?: (code: string) => void;
};
export type StorageClient = {
  store: AsyncWorkbenchStore;
  auth: AsyncAuthStore;
  plugins: AsyncPluginStore;
  workspaces: AsyncWorkspaceStore;
  execution: AsyncExecutionStore;
  ready: Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
  diagnostics(): { phase: 'starting' | 'ready' | 'closing' | 'closed' | 'failed'; pending: number; pendingBytes: number; inFlight: boolean;
    failureCode?: string; workerErrorCode?: 'ERR_WORKER_OUT_OF_MEMORY' | 'ERR_WORKER_UNSUPPORTED_OPERATION' | 'unclassified'; exitCode?: number;
    memory?: { heapUsed: number; heapTotal: number; external: number; arrayBuffers: number; processRss: number; processMaxRss: number; completed: number } };
};
export const storageCommandSchema = z.object({
  scope: z.enum(['store', 'resources', 'plugins', 'workspaces', 'auth', 'execution']), method: z.string().min(1).max(100), args: z.array(z.unknown()).max(8),
}).strict();
export const storageReplySchema = z.object({
  changes: z.array(z.object({ sequence: z.number().int().positive().safe(), conversationId: z.string().min(1).max(1024), itemId: z.string().max(1024).optional() }).strict()).max(128),
  reset: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/), statusCode: z.number().int().min(400).max(599),
    outcome: z.enum(['not_started', 'rejected', 'unknown', 'committed']) }).strict().optional(),
}).strict();

// Preflight avoids allocating an unbounded serialization before checking size.
// Only JSON-shaped values plus binary images cross this private thread boundary;
// callbacks, getters, cycles, custom prototypes and excessive depth are rejected.
export function encodeStorageValue(value: unknown, maxBytes: number): Buffer {
  let budget = maxBytes;
  let nodes = 0;
  const ancestors = new Set<object>();
  const spend = (bytes: number) => { budget -= bytes; if (budget < 0) throw new StorageClientError('storage_payload_too_large', 'not_started', 413); };
  const text = (value: string) => { if (value.length > budget) spend(value.length); else spend(Buffer.byteLength(value) + 4); };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 64) throw new StorageClientError('storage_payload_too_complex', 'not_started', 413);
    spend(8);
    if (item === undefined || item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { text(item); return; }
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (item instanceof Uint8Array) { spend(item.byteLength); return; }
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new StorageClientError('storage_input_not_serializable', 'not_started', 400);
    const array = Array.isArray(item);
    if (array ? item.length > 100_000 : ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw new StorageClientError('storage_input_not_serializable', 'not_started', 400);
    ancestors.add(item);
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!('value' in descriptor)) throw new StorageClientError('storage_input_not_serializable', 'not_started', 400);
      text(key); visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  const encoded = serialize(value);
  if (encoded.byteLength > maxBytes) throw new StorageClientError('storage_payload_too_large', 'not_started', 413);
  return encoded;
}

/** One owned worker connection, one in-flight transaction/RPC, bounded waiting.
 * No mutation is retried. `unknown` or `committed` errors require durable readback.
 * The current callback-based setArchived cannot cross threads and is rejected.
 * Auth, plugin receipts and workspace metadata share the same writer connection.
 */
export function createStorageClient(input: StorageClientOptions): StorageClient {
  const { onChange, onReset, onFailure, ...configuration } = input;
  const options = storageConfigurationSchema.parse(configuration);
  const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './storage-worker.ts' : './storage-worker.js', import.meta.url), {
    workerData: options, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: options.workerMemoryMb },
  });
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  let started = false;
  let accepting = true;
  let closed = false;
  let failure: StorageClientError | undefined;
  let workerErrorCode: 'ERR_WORKER_OUT_OF_MEMORY' | 'ERR_WORKER_UNSUPPORTED_OPERATION' | 'unclassified' | undefined;
  let exitCode: number | undefined;
  const memorySchema = z.object({ heapUsed: z.number().nonnegative().safe(), heapTotal: z.number().nonnegative().safe(), external: z.number().nonnegative().safe(), arrayBuffers: z.number().nonnegative().safe(), processRss: z.number().nonnegative().safe(), processMaxRss: z.number().nonnegative().safe(), completed: z.number().int().nonnegative().safe() }).strict();
  let memory: z.infer<typeof memorySchema> | undefined;
  let stop: Promise<number> | undefined;
  let closePromise: Promise<void> | undefined;
  let closeResolve: (() => void) | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let pendingBytes = 0;
  type Pending = { id: number; payload: Buffer; bytes: number; write: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };
  const queue: Pending[] = [];
  let current: Pending | undefined;
  let drainWait: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | undefined;
  const startupTimer = setTimeout(() => fail('storage_startup_timeout'), options.startupTimeoutMs);

  function fail(code: string): void {
    if (failure || closed) return;
    failure = new StorageClientError(code, 'unknown');
    accepting = false;
    clearTimeout(startupTimer);
    clearTimeout(closeTimer);
    readyReject(new StorageClientError(code, 'not_started'));
    if (current) { clearTimeout(current.timer); current.reject(new StorageClientError(code, 'unknown')); current = undefined; }
    for (const item of queue.splice(0)) item.reject(new StorageClientError(code, 'not_started'));
    pendingBytes = 0;
    drainWait?.reject(failure); drainWait = undefined;
    closeResolve?.();
    stop ??= worker.terminate();
    void stop.catch(() => {});
    // The process owner may exit for its supervisor to recover the same data.
    // Never replace a worker here or retry a command whose outcome is unknown.
    try { onFailure?.(code); } catch { /* failure remains latched */ }
  }
  function pump(): void {
    if (!started || failure || current) return;
    current = queue.shift();
    if (!current) { drainWait?.resolve(); drainWait = undefined; return; }
    current.timer = setTimeout(() => fail('storage_request_timeout'), options.requestTimeoutMs);
    try { worker.postMessage({ type: 'request', id: current.id, payload: current.payload }); }
    catch { fail('storage_transport_failed'); }
  }
  function request(scope: keyof typeof storageCommandMethods, method: string, args: unknown[]): Promise<unknown> {
    if (!accepting || failure) return Promise.reject(new StorageClientError('storage_unavailable', 'not_started'));
    const methods: Record<string, 'read' | 'write' | 'unsupported'> = storageCommandMethods[scope];
    if (!Object.hasOwn(methods, method) || methods[method as keyof typeof methods] === 'unsupported')
      return Promise.reject(new StorageClientError('storage_method_unsupported', 'not_started', 400));
    if (queue.length + Number(Boolean(current)) >= options.maxPending)
      return Promise.reject(new StorageClientError('storage_queue_full', 'not_started', 503));
    let payload: Buffer;
    try { payload = encodeStorageValue({ scope, method, args }, options.maxRequestBytes); }
    catch (error) { return Promise.reject(error); }
    if (payload.byteLength + pendingBytes > options.maxQueuedBytes)
      return Promise.reject(new StorageClientError('storage_queue_full', 'not_started', 503));
    pendingBytes += payload.byteLength;
    return new Promise((resolve, reject) => {
      queue.push({ id: ++sequence, payload, bytes: payload.byteLength, write: methods[method as keyof typeof methods] === 'write', resolve, reject });
      pump();
    });
  }
  worker.on('message', (message: unknown) => {
    if (failure || closed) return;
    if (!message || typeof message !== 'object' || !('type' in message)) { fail('storage_protocol_failed'); return; }
    if (message.type === 'telemetry' && 'memory' in message) {
      const parsed = memorySchema.safeParse(message.memory);
      if (!parsed.success) { fail('storage_protocol_failed'); return; }
      memory = parsed.data; return;
    }
    if (message.type === 'ready' && !started) {
      started = true; clearTimeout(startupTimer); readyResolve(); pump(); return;
    }
    if (message.type === 'fatal') { fail('storage_startup_failed'); return; }
    if (message.type === 'closed' && closeResolve && !current && !queue.length) {
      closed = true; clearTimeout(closeTimer); closeResolve(); return;
    }
    if (message.type !== 'result' || !('id' in message) || message.id !== current?.id || !('payload' in message) ||
      !(message.payload instanceof Uint8Array) || message.payload.byteLength > options.maxResultBytes) { fail('storage_protocol_failed'); return; }
    let reply: z.infer<typeof storageReplySchema>;
    try { reply = storageReplySchema.parse(deserialize(message.payload)); }
    catch { fail('storage_protocol_failed'); return; }
    const completed = current!;
    clearTimeout(completed.timer); current = undefined; pendingBytes -= completed.bytes;
    // These are committed change hints; throwing consumers cannot turn a commit
    // into an apparent failure. A durable changes cursor remains authoritative.
    try { if (reply.reset) onReset?.(); else for (const event of reply.changes) onChange?.(event); } catch { /* caller can reconcile changes */ }
    if (reply.error) completed.reject(new StorageClientError(reply.error.code, reply.error.outcome, reply.error.statusCode));
    else completed.resolve(reply.result);
    pump();
  });
  worker.on('error', error => {
    const code = (error as NodeJS.ErrnoException).code;
    workerErrorCode = code === 'ERR_WORKER_OUT_OF_MEMORY' || code === 'ERR_WORKER_UNSUPPORTED_OPERATION' ? code : 'unclassified';
    fail('storage_worker_failed');
  });
  worker.on('exit', code => { exitCode = code; if (!closed) fail('storage_worker_exited'); });

  function drain(): Promise<void> {
    return ready.then(() => {
      if (failure) throw failure;
      if (!current && !queue.length) return;
      if (!drainWait) {
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        drainWait = { promise, resolve, reject };
      }
      return drainWait.promise;
    });
  }
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    accepting = false;
    closePromise = (async () => {
      try { await drain(); }
      catch { await stop?.catch(() => {}); return; }
      await new Promise<void>(resolve => {
        closeResolve = resolve;
        closeTimer = setTimeout(() => fail('storage_close_timeout'), options.requestTimeoutMs);
        try { worker.postMessage({ type: 'close' }); }
        catch { fail('storage_transport_failed'); }
      });
      if (failure) await stop?.catch(() => {});
    })();
    return closePromise;
  }
  const methods = Object.fromEntries(Object.keys(storageMethods).map(method => [method, (...args: unknown[]) => request('store', method, args)]));
  const resources = Object.fromEntries(Object.keys(storageResourceMethods).map(method => [method, (...args: unknown[]) => request('resources', method, args)]));
  const auth = Object.fromEntries(Object.keys(storageAuthMethods).map(method => [method, (...args: unknown[]) => request('auth', method, args)])) as AsyncAuthStore;
  const plugins = Object.fromEntries(Object.keys(storagePluginMethods).map(method => [method, (...args: unknown[]) => request('plugins', method, args)])) as AsyncPluginStore;
  const workspaces = Object.fromEntries(Object.keys(storageWorkspaceMethods).map(method => [method, (...args: unknown[]) => request('workspaces', method, args)])) as AsyncWorkspaceStore;
  const execution = Object.fromEntries(Object.keys(storageExecutionMethods).map(method => [method, (...args: unknown[]) => request('execution', method, args)])) as AsyncExecutionStore;
  return {
    store: { ...methods, resources } as AsyncWorkbenchStore, plugins, workspaces, execution, auth, ready, drain, close,
    diagnostics: () => ({ phase: failure ? 'failed' : closed ? 'closed' : !accepting ? 'closing' : started ? 'ready' : 'starting',
      pending: queue.length + Number(Boolean(current)), pendingBytes, inFlight: Boolean(current),
      ...(failure ? { failureCode: failure.code } : {}), ...(workerErrorCode ? { workerErrorCode } : {}), ...(exitCode === undefined ? {} : { exitCode }), ...(memory ? { memory } : {}) }),
  };
}

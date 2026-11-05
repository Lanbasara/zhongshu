import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { acquireExecutionFileLock } from './execution-host-lock.ts';
import { z } from 'zod';
import type { Binding, HarnessId, NativeChange } from '../harness/types.ts';
import type { ExecutionController, ExecutionControllerResult, ExecutionEpoch } from './execution-controller.ts';
import { encodeStorageValue } from './storage-client.ts';
import { ExecutionHostError, type ExecutionHostRuntime } from './execution-host-docker.ts';
import { hostIdentifier, hostPermissionSchema, type ExecutionHostLedger, type HostControl, type HostPermission } from './execution-host-ledger.ts';

export const gatewayRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operation'), operationId: z.uuid() }).strict(),
  z.object({ kind: z.literal('plugin'), operationId: z.uuid() }).strict(),
  z.object({ kind: z.literal('create'), conversationId: z.uuid() }).strict(),
  z.object({ kind: z.literal('wake'), operationId: z.uuid(), requestId: hostIdentifier }).strict(),
  z.object({ kind: z.literal('observe'), requestId: hostIdentifier, conversationId: z.uuid(), method: z.enum(['state', 'reconcile', 'watch', 'skills']),
    targetRunId: z.string().min(1).max(1024).optional(), operationId: z.uuid().optional(),
    context: z.object({ admissionId: hostIdentifier.optional(), baseline: z.object({ groupId: hostIdentifier, through: z.number().int().nonnegative().safe(),
      after: z.object({ sequence: z.number().int().nonnegative().safe(), id: hostIdentifier }).strict().optional() }).strict().optional() }).strict().optional(),
  }).strict(),
]);
export type GatewayRequest = z.infer<typeof gatewayRequestSchema>;
export type NativeInvocation = { requestId: string; harnessId: HarnessId; method: 'create' | 'submit' | 'submitQueued' | 'wakeQueued' | 'stop' | 'state' | 'reconcile' | 'watch' | 'skills'; args: unknown[];
  conversationId: string; workspaceId: string; operationId?: string; observation?: Extract<GatewayRequest, {kind:'observe'}> } |
  { requestId: string; harnessId: HarnessId; method: 'pluginChange' | 'pluginSource'; args: unknown[]; operationId: string; conversationId?: never; workspaceId?: never; observation?: never };
export type GatewayResult = { status: 'settled'; value: unknown } | { status: 'unknown'; binding?: unknown };
export interface ExecutionGatewayAuthority {
  /** Derive the immutable native payload/binding from trusted business storage.
   * Never accept caller-provided text, paths, permissions or a self-signed permit. */
  resolve(request: GatewayRequest): Promise<NativeInvocation>;
  /** Revalidate current groups and bind this exact native request in one command. */
  authorize(invocation: NativeInvocation, wireDigest: string): Promise<HostPermission>;
  /** Persist the original conversation binding and native association before the
   * native create callback can continue configuration or other side effects. */
  onBound(invocation: NativeInvocation, binding: Binding, permission: HostPermission): Promise<void>;
  recoverBinding?(conversationId: string, binding: unknown): Promise<Binding>;
  onResult?(invocation: NativeInvocation, result: unknown, permission: HostPermission): Promise<void>;
  drained(groupId: string, frozenSetId: string): Promise<boolean>;
}
export interface ManagedNativeInvoker {
  ready(): Promise<void>;
  invoke(invocation: NativeInvocation, onBound: (binding: Binding) => Promise<void>, listener?: (change: NativeChange) => void): Promise<unknown>;
  releaseWatch?(requestId: string): void;
}
export function nativeWireDigest(invocation: Pick<NativeInvocation, 'harnessId' | 'method' | 'args'>): string {
  const value = { harnessId: invocation.harnessId, method: invocation.method, args: invocation.args };
  encodeStorageValue(value, 12 * 1024 * 1024);
  function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)]));
    return value;
  }
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}

const heldOwnerships = new WeakSet<ExecutionHostOwnership>();
export type ExecutionHostOwnership = { readonly port: number; assertOwned(): void; close(): Promise<void> };
/** Production also requires a parent-held Linux file lock across namespaces.
 * A fixed loopback port is an additional kernel-owned lifetime lock, released on process
 * death. Its port belongs in the persisted host configuration digest. Unlike a
 * stale PID file or expiring lease, it cannot admit two living controllers. */
export async function acquireExecutionHostOwnership(port: number, lockFile?: string): Promise<ExecutionHostOwnership> {
  z.number().int().min(0).max(65535).parse(port);
  const fileLock = lockFile ? await acquireExecutionFileLock(lockFile) : undefined;
  const server: Server = createServer(socket => socket.destroy()); server.maxConnections = 1;
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.off('error', reject); resolve(); }); }); }
  catch (error) { await fileLock?.close(); throw error; }
  const address = server.address(); if (!address || typeof address === 'string') throw new ExecutionHostError('execution_host_ownership_unavailable');
  const lease: ExecutionHostOwnership = { port: address.port,
    assertOwned() { fileLock?.assertOwned(); if (!heldOwnerships.has(lease) || !server.listening) throw new ExecutionHostError('execution_host_ownership_lost'); },
    async close() { heldOwnerships.delete(lease); if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await fileLock?.close(); },
  };
  heldOwnerships.add(lease); return lease;
}

/** The single native dispatch entrance. Its journal belongs to the controller,
 * independently of workbench backup/restore. A forwarding record is irreversible
 * without native readback: a crash between commit and send remains unknown.
 */
export class ExecutionHost {
  readonly controller: ExecutionController;
  private readonly ledger: ExecutionHostLedger;
  private readonly ownership: ExecutionHostOwnership;
  private requests = 0;
  private payloadSlots = 0;
  private readonly payloadWaiters: (() => void)[] = [];
  private readonly runtime: ExecutionHostRuntime;
  private readonly native: ManagedNativeInvoker;
  private readonly authority: ExecutionGatewayAuthority;
  private readonly active = new Map<string, Promise<GatewayResult>>();
  private readonly observations = new Map<string, Promise<GatewayResult>>();
  private controlTail: Promise<unknown> = Promise.resolve();
  private controls = 0;
  private resolving = 0;
  private closed = false;
  constructor(ledger: ExecutionHostLedger, runtime: ExecutionHostRuntime, native: ManagedNativeInvoker, authority: ExecutionGatewayAuthority, ownership: ExecutionHostOwnership) {
    if (!heldOwnerships.has(ownership)) throw new ExecutionHostError('execution_host_ownership_required');
    ownership.assertOwned(); this.ownership = ownership;
    this.ledger = ledger; this.runtime = runtime; this.native = native; this.authority = authority;
    this.controller = {
      inspect: (requestId, expected) => this.inspect(requestId, expected),
      fence: input => this.change({ ...input, action: 'fence' }),
      quiesce: input => this.change({ ...input, action: 'quiesce' }),
      resume: input => this.change({ ...input, action: 'resume' }),
    };
  }
  /** Explicit operator bootstrap only. Reopening an existing journal NEVER
   * starts a stopped Host or clears a pending control/forwarding result. */
  async bootstrap(): Promise<void> {
    this.ownership.assertOwned(); await this.ledger.ready; const row = await this.ledger.load();
    if (row.initialized) return;
    const prepared = await this.runtime.prepare(); await this.ledger.attachContainer(prepared);
    const running = prepared.running ? prepared : await this.runtime.start();
    await this.nativeReady(); await this.ledger.initialize(running);
  }
  private async nativeReady() {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { await this.native.ready(); return; }
      catch (error) { if (Date.now() >= deadline || this.closed) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  }
  private async inspect(requestId: string, expected?: ExecutionEpoch): Promise<ExecutionControllerResult> {
    try {
      this.ownership.assertOwned(); hostIdentifier.parse(requestId); if (this.closed) throw new ExecutionHostError('execution_host_closed');
      const row = await this.ledger.load(); const state = row.state;
      if (expected && (state.generation !== expected.generation || state.epoch !== expected.epoch)) return { status: 'unknown', reason: 'epoch_mismatch' };
      const proof = await this.runtime.inspect();
      return { status: 'known', state: await this.ledger.confirm({ generation: state.generation, epoch: state.epoch }, proof) };
    } catch { return { status: 'unknown', reason: 'controller_unknown' }; }
  }
  private async change(input: HostControl): Promise<ExecutionControllerResult> {
    if (this.closed || this.controls >= 16) return { status: 'unknown', reason: 'controller_unknown' };
    this.controls++;
    const task = this.controlTail.catch(() => {}).then(async (): Promise<ExecutionControllerResult> => {
      try {
        this.ownership.assertOwned();
        const begun = await this.ledger.beginControl(input);
        if (begun.status === 'complete') return { status: 'known', state: begun.state };
        const row = await this.ledger.load();
        if (input.action === 'quiesce' && (this.active.size || this.resolving || !await this.authority.drained(row.state.groupId, input.frozenSetId!)))
          return { status: 'unknown', reason: 'controller_unknown' };
        const proof = input.action === 'quiesce' ? await this.runtime.quiesce() : input.action === 'resume' ? await this.runtime.start() : await this.runtime.inspect();
        if (input.action === 'resume') await this.nativeReady();
        return { status: 'known', state: await this.ledger.completeControl(input.requestId, proof) };
      } catch { return { status: 'unknown', reason: 'controller_unknown' }; }
    });
    this.controlTail = task;
    try { return await task; } finally { this.controls--; }
  }
  async dispatch(input: GatewayRequest, listener?: (change: NativeChange) => void): Promise<GatewayResult> {
    this.ownership.assertOwned();
    if (this.closed || this.requests >= 32) throw new ExecutionHostError('execution_gateway_busy', 429);
    const request = gatewayRequestSchema.parse(input);
    this.requests++;
    const large = input.kind === 'operation';
    // Queue opaque IDs before loading immutable image bytes. Four supported
    // 2 MiB images need ~11 MiB on the native wire; only two materialized
    // operation payloads can coexist, regardless of the caller count.
    if (large) {
      if (this.payloadSlots >= 2) await new Promise<void>(resolve => this.payloadWaiters.push(resolve));
      else this.payloadSlots++;
    }
    try {
      if (request.kind !== 'observe') return await this.forward(request, listener);
      // Even direct gateway callers must not overlap activation of one binding.
      // Otherwise a later idle result could settle the shared admission while an
      // earlier observation is still entering native work. The global request
      // limit above also bounds these queues; each request keeps its own journal.
      const task = (this.observations.get(request.conversationId) ?? Promise.resolve()).catch(() => {}).then(() => this.forward(request, listener));
      this.observations.set(request.conversationId, task);
      try { return await task; }
      finally { if (this.observations.get(request.conversationId) === task) this.observations.delete(request.conversationId); }
    }
    finally {
      if (large) { const next = this.payloadWaiters.shift(); if (next) next(); else this.payloadSlots--; }
      this.requests--;
    }
  }
  private async forward(input: GatewayRequest, listener?: (change: NativeChange) => void): Promise<GatewayResult> {
    if (this.closed || this.active.size + this.resolving >= 32) throw new ExecutionHostError('execution_gateway_busy', 429);
    const request = gatewayRequestSchema.parse(input); this.resolving++;
    let invocation: NativeInvocation;
    try { invocation = await this.authority.resolve(request); } finally { this.resolving--; }
    const expectedId = request.kind === 'operation' ? request.operationId : request.kind === 'plugin' ? 'plugin:' + request.operationId : request.kind === 'create' ? 'create:' + request.conversationId : request.requestId;
    if (invocation.requestId !== expectedId || (request.kind === 'create') !== (invocation.method === 'create') ||
      request.kind === 'wake' && (invocation.method !== 'wakeQueued' || invocation.operationId !== request.operationId) ||
      request.kind === 'operation' && invocation.operationId !== request.operationId ||
      request.kind === 'plugin' && (invocation.operationId !== request.operationId || !['pluginChange', 'pluginSource'].includes(invocation.method)) ||
      request.kind === 'observe' && (invocation.method !== request.method || invocation.conversationId !== request.conversationId)) throw new ExecutionHostError('execution_invocation_identity_changed');
    const wireDigest = nativeWireDigest(invocation);
    const present = await this.ledger.readForward(invocation.requestId, wireDigest);
    if (present) return present.status === 'settled' ? { status: 'settled', value: present.result } : { status: 'unknown', ...(present.binding ? { binding: present.binding } : {}) };
    // Concurrent duplicates share no native send. The durable claim below remains
    // the deciding boundary across gateway restarts and independent callers.
    const running = this.active.get(invocation.requestId); if (running) return { status: 'unknown' };
    const task = (async (): Promise<GatewayResult> => {
      const permission = hostPermissionSchema.parse(await this.authority.authorize(invocation, wireDigest));
      if (permission.requestId !== invocation.requestId || permission.wireDigest !== wireDigest ||
        (permission.purpose === 'stop') !== (invocation.method === 'stop')) throw new ExecutionHostError('execution_permission_identity_changed');
      const claimed = await this.ledger.claimForward(permission);
      if (!claimed.created) return claimed.status === 'settled' ? { status: 'settled', value: claimed.result } : { status: 'unknown', ...(claimed.binding ? { binding: claimed.binding } : {}) };
      try {
        const value = await this.native.invoke(invocation, async binding => {
          if (invocation.method !== 'create') throw new ExecutionHostError('execution_unexpected_binding');
          await this.ledger.recordBinding(invocation.requestId, binding);
          await this.authority.onBound(invocation, binding, permission);
        }, listener);
        await this.ledger.settleForward(invocation.requestId, value);
        await this.authority.onResult?.(invocation, value, permission);
        return { status: 'settled', value };
      } catch {
        const known = await this.ledger.readForward(invocation.requestId, wireDigest).catch(() => null);
        return { status: 'unknown', ...(known?.binding ? { binding: known.binding } : {}) };
      }
    })();
    this.active.set(invocation.requestId, task);
    try { return await task; } finally { if (this.active.get(invocation.requestId) === task) this.active.delete(invocation.requestId); }
  }
  async recoverCreation(conversationId: string): Promise<Binding | null> {
    this.ownership.assertOwned(); z.uuid().parse(conversationId);
    if (this.closed || !this.authority.recoverBinding) throw new ExecutionHostError('execution_creation_recovery_unavailable');
    const binding = await this.ledger.readCreatedBinding(conversationId);
    return binding ? await this.authority.recoverBinding(conversationId, binding) : null;
  }
  async capacity() { this.ownership.assertOwned(); return (await this.ledger.load()).capacity; }
  releaseWatch(requestId: string) { this.native.releaseWatch?.(requestId); }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([this.controlTail, ...this.active.values(), ...this.observations.values()]);
    await this.ledger.close(); await this.ownership.close();
  }
}

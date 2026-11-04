import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Binding, HarnessAdapter, HistoryChanges, HistoryPage, NativeBodyChunk, NativeItem, Receipt } from '../harness/types.ts';
import { HarnessError } from '../harness/types.ts';
import { stateSchema } from '../shared/workbench.ts';
import type { Conversation } from './workbench-store.ts';
import type { ManagedAdapterContext } from './workbench.ts';
import { ExecutionHost, type GatewayRequest } from './execution-host.ts';
import { ManagedHarnessRpc, type ManagedNativeMethod } from './managed-harness-rpc.ts';
import { baselineObservationId } from './managed-harness-authority.ts';

const receipt = z.discriminatedUnion('outcome', [z.object({ outcome: z.literal('accepted'), runId: z.string().max(1024).optional() }),
  z.object({ outcome: z.literal('rejected'), reason: z.string().max(4096) }), z.object({ outcome: z.literal('unknown'), reason: z.string().max(4096) })]);
const uncertain = (): Receipt => ({ outcome: 'unknown', reason: 'managed_native_result_unknown' });
const noActivation = async (): Promise<never> => { throw new HarnessError('managed_native_activation_requires_permission'); };

/** A connection-wide read projection has no execution methods that can bypass
 * the per-conversation gateway. state/watch/reconcile are activation entrances. */
export async function managedHarnessReadAdapter(client: ManagedHarnessRpc, stoppedHarness?: 'codex' | 'dsh'): Promise<HarnessAdapter> {
  const capabilities = await client.capabilities().catch(error => {
    if (!stoppedHarness) throw error;
    return { id: stoppedHarness, methods: [] as ManagedNativeMethod[], earlyInput: stoppedHarness === 'codex' ? 'current' as const : 'soon' as const };
  });
  return {
    id: capabilities.id, historyReadOnly: true, ...(capabilities.earlyInput ? { earlyInput: capabilities.earlyInput } : {}),
    catalog: async () => await client.read('catalog', []) as Awaited<ReturnType<HarnessAdapter['catalog']>>,
    create: noActivation, state: noActivation, submit: noActivation, reconcile: noActivation, stop: noActivation, watch: noActivation,
    history: async (binding, cursor, limit) => await client.read('history', [binding, cursor, limit]) as HistoryPage,
    ...(capabilities.methods.includes('historyChanges') ? { historyChanges: async (binding: Binding, cursor?: string, limit?: number) => await client.read('historyChanges', [binding, cursor, limit]) as HistoryChanges } : {}),
    ...(capabilities.methods.includes('readItems') ? { readItems: async (binding: Binding, itemIds: string[]) => await client.read('readItems', [binding, itemIds]) as NativeItem[] } : {}),
    ...(capabilities.methods.includes('readBodyChunk') ? { readBodyChunk: async (binding: Binding, token: string, offset: number, maxBytes: number) => await client.read('readBodyChunk', [binding, token, offset, maxBytes]) as NativeBodyChunk } : {}),
    ...(capabilities.methods.includes('releaseBodySource') ? { releaseBodySource: async (binding: Binding, token: string) => { await client.read('releaseBodySource', [binding, token]); } } : {}),
    ...(capabilities.methods.includes('readImage') ? { readImage: async (binding: Binding, path: string) => await client.read('readImage', [binding, path]) as string } : {}),
    async close() { await client.close(); },
  };
}

export async function createManagedHarnessAdapter(host: ExecutionHost, client: ManagedHarnessRpc, conversation: Conversation, context: ManagedAdapterContext = {}): Promise<HarnessAdapter> {
  const capabilities = await client.capabilities();
  if (capabilities.id !== conversation.harnessId) throw new HarnessError('managed_native_harness_changed');
  function sameBinding(binding: Binding) {
    const expected = conversation.binding;
    if (!expected || binding.id !== expected.id || binding.cwd !== expected.cwd || binding.configuration.modelId !== expected.configuration.modelId || binding.configuration.permissionId !== expected.configuration.permissionId)
      throw new HarnessError('managed_native_binding_changed');
  }
  function observation(method: 'state' | 'reconcile' | 'watch' | 'skills', extra: { targetRunId?: string; operationId?: string } = {}): Extract<GatewayRequest, { kind: 'observe' }> {
    const requestId = context.baseline ? baselineObservationId(context.baseline.groupId, context.baseline.through, conversation.id, conversation.binding!.id) : 'observe:' + randomUUID();
    return { kind: 'observe', requestId, conversationId: conversation.id, method, ...extra,
      ...(context.baseline || context.admissionId ? { context: { ...(context.baseline ? { baseline: context.baseline } : {}), ...(context.admissionId ? { admissionId: context.admissionId } : {}) } } : {}) };
  }
  async function observe(method: 'state' | 'reconcile' | 'skills', extra?: { targetRunId?: string; operationId?: string }) {
    const result = await host.dispatch(observation(method, extra));
    if (result.status !== 'settled') throw new HarnessError('managed_native_observation_unknown');
    return result.value;
  }
  async function read(method: ManagedNativeMethod, binding: Binding, args: unknown[] = []) { sameBinding(binding); return await client.read(method, [binding, ...args]); }
  return {
    id: capabilities.id, ...(capabilities.earlyInput ? { earlyInput: capabilities.earlyInput } : {}),
    catalog: async () => await client.read('catalog', []) as Awaited<ReturnType<HarnessAdapter['catalog']>>,
    async create(_input, onBound) {
      const result = await host.dispatch({ kind: 'create', conversationId: conversation.id });
      if (result.status === 'unknown') {
        if (result.binding) await onBound(result.binding as Binding);
        throw new HarnessError('native_creation_result_unknown');
      }
      const binding = result.value as Binding;
      await onBound(binding); return binding;
    },
    async state(binding, targetRunId) { sameBinding(binding); return stateSchema.parse(await observe('state', { ...(targetRunId ? { targetRunId } : {}) })); },
    async reconcile(binding, operationId) { sameBinding(binding); return receipt.parse(await observe('reconcile', { operationId })); },
    async submit(binding, operation) { sameBinding(binding); const result = await host.dispatch({ kind: 'operation', operationId: operation.id }); return result.status === 'settled' ? receipt.parse(result.value) : uncertain(); },
    ...(capabilities.methods.includes('submitQueued') ? { submitQueued: async (binding: Binding, operation: Parameters<NonNullable<HarnessAdapter['submitQueued']>>[1]) => {
      sameBinding(binding); const result = await host.dispatch({ kind: 'operation', operationId: operation.id }); return result.status === 'settled' ? receipt.parse(result.value) : uncertain();
    } } : {}),
    ...(capabilities.methods.includes('wakeQueued') ? { wakeQueued: async (binding: Binding, operationId: string) => {
      sameBinding(binding);
      if (!context.wakeRequestId) throw new HarnessError('managed_native_wake_intent_required');
      const result = await host.dispatch({ kind: 'wake', operationId, requestId: context.wakeRequestId });
      if (result.status !== 'settled') throw new HarnessError('managed_native_wake_unknown');
    } } : {}),
    async stop(binding, _runId) { sameBinding(binding); if (!context.operationId) throw new HarnessError('managed_native_stop_intent_required');
      const result = await host.dispatch({ kind: 'operation', operationId: context.operationId }); return result.status === 'settled' ? receipt.parse(result.value) : uncertain(); },
    async watch(binding, listener) { sameBinding(binding); const request = observation('watch'); const result = await host.dispatch(request, listener);
      if (result.status !== 'settled') throw new HarnessError('managed_native_watch_unknown'); return () => host.releaseWatch(request.requestId); },
    ...(capabilities.methods.includes('skills') ? { skills: async (binding: Binding) => { sameBinding(binding); return await observe('skills') as Awaited<ReturnType<NonNullable<HarnessAdapter['skills']>>>; } } : {}),
    history: async (binding, cursor, limit) => await read('history', binding, [cursor, limit]) as HistoryPage,
    ...(capabilities.methods.includes('historyChanges') ? { historyChanges: async (binding: Binding, cursor?: string, limit?: number) => await read('historyChanges', binding, [cursor, limit]) as HistoryChanges } : {}),
    ...(capabilities.methods.includes('readItems') ? { readItems: async (binding: Binding, itemIds: string[]) => await read('readItems', binding, [itemIds]) as NativeItem[] } : {}),
    ...(capabilities.methods.includes('readBodyChunk') ? { readBodyChunk: async (binding: Binding, token: string, offset: number, maxBytes: number) => await read('readBodyChunk', binding, [token, offset, maxBytes]) as NativeBodyChunk } : {}),
    ...(capabilities.methods.includes('releaseBodySource') ? { releaseBodySource: async (binding: Binding, token: string) => { await read('releaseBodySource', binding, [token]); } } : {}),
    ...(capabilities.methods.includes('readImage') ? { readImage: async (binding: Binding, path: string) => await read('readImage', binding, [path]) as string } : {}),
    async close() {},
  };
}

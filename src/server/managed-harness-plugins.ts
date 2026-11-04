import { z } from 'zod';
import { pluginEntry, pluginSource, pluginStatus, type PluginCommand, type PluginHarness } from '../shared/plugins.ts';
import { PluginSourceError, type PluginBackend } from './plugin-backend.ts';
import type { AsyncPluginStore } from './plugin-store.ts';
import type { AsyncExecutionStore } from './execution-store.ts';
import type { ExecutionHost } from './execution-host.ts';
import type { ManagedHarnessRpc, ManagedNativeMethod } from './managed-harness-rpc.ts';

const inventory = z.object({ entries: z.array(pluginEntry).max(1000), sources: z.array(pluginSource).max(40) }).strict();
const sourceResult = z.object({ status: z.enum(['applied','failed']), error: z.enum(['invalid_plugin_source','plugin_source_conflict','plugin_source_in_use']).optional() }).strict();
/** Opaque operation IDs cross the gateway; commands are rebuilt by its trusted
 * authority. Recovery is observation only and never invokes change again. */
export function managedHarnessPlugins(input: { harnessId: PluginHarness; host: ExecutionHost; client: ManagedHarnessRpc; store: AsyncPluginStore; execution: AsyncExecutionStore }): PluginBackend {
  const { host, client, store, execution, harnessId } = input;
  async function read(method: ManagedNativeMethod, args: unknown[]) {
    const capability = await client.capabilities();
    if (capability.id !== harnessId || !capability.methods.includes('pluginChange') || !capability.methods.includes(method))
      throw new Error('managed_plugins_native_configuration_required');
    return await client.read(method, args);
  }
  async function recover(command: PluginCommand) {
    const admission = await execution.hostAdmission(command.id);
    if (!admission || admission.harnessId !== harnessId || admission.kind !== 'plugin') throw new Error('execution_host_operation_unavailable');
    const result = pluginStatus.exclude(['applying']).parse(await read('pluginRecover', [admission.command]));
    if (result !== 'unknown') await store.settle(command.id, result); return result;
  }
  return {
    catalog: async () => inventory.parse(await read('pluginCatalog', [])),
    list: async () => inventory.parse(await read('pluginCatalog', [])).entries,
    sources: async () => z.array(pluginSource).max(40).parse(await read('pluginSources', [])),
    detail: async id => pluginEntry.nullable().parse(await read('pluginDetail', [id])),
    change: async command => {
      const result = await host.dispatch({ kind: 'plugin', operationId: command.id });
      return result.status === 'unknown' ? 'unknown' : pluginStatus.exclude(['applying']).parse(result.value);
    },
    recover,
    updateSource: async (_command, requestId) => {
      if (!requestId) throw new Error('execution_host_operation_required');
      const result = await host.dispatch({ kind: 'plugin', operationId: requestId });
      if (result.status !== 'settled') throw new Error('execution_host_result_unknown');
      const value = sourceResult.parse(result.value);
      if (value.status === 'failed') throw new PluginSourceError(value.error ?? 'invalid_plugin_source');
    },
    recoverSource: async (_command, requestId) => {
      const admission = await execution.hostAdmission(requestId);
      if (!admission || admission.harnessId !== harnessId || admission.kind !== 'source') throw new Error('execution_host_operation_unavailable');
      const status = z.enum(['applied','failed','unknown']).parse(await read('pluginRecoverSource', [admission.command, requestId]));
      if (status !== 'unknown') await store.settleSource(requestId, status); return status;
    },
  };
}

import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import type { HarnessAdapter, HarnessId } from '../harness/types.ts';
import { workspaceIdSchema } from '../shared/workbench.ts';
import { dockerHostConfigurationSchema, createDockerExecutionHost, hostDigest } from './execution-host-docker.ts';
import { createExecutionHostLedger, hostLedgerOptionsSchema } from './execution-host-ledger.ts';
import { acquireExecutionHostOwnership, ExecutionHost } from './execution-host.ts';
import { ManagedHarnessRpc } from './managed-harness-rpc.ts';
import { createManagedHarnessAdapter, managedHarnessReadAdapter } from './managed-harness-adapter.ts';
import { createManagedHarnessAuthority } from './managed-harness-authority.ts';
import { readOperatorFile } from './managed-harness-server.ts';
import { ManagedWorkspaceExecution } from './execution-workspaces.ts';
import type { StorageClient } from './storage-client.ts';
import type { WorkspaceRegistry } from './workspace-registry.ts';
import type { ManagedWorkbenchOptions } from './workbench.ts';
import { serveExecutionGateway } from './managed-harness-gateway.ts';
import { managedHarnessPlugins } from './managed-harness-plugins.ts';
import type { PluginBackend } from './plugin-backend.ts';
import { pluginCommand, pluginSourceCommand } from '../shared/plugins.ts';

const path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'));
export const managedHostConfigurationSchema = z.object({
  groupId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/), harnessId: z.enum(['codex', 'dsh']),
  workspaceIds: z.array(workspaceIdSchema).max(16).default([]), workspaceRootIds: z.array(workspaceIdSchema).max(16).default([]),
  ledgerDirectory: path, ledgerCapacity: hostLedgerOptionsSchema.shape.capacity, docker: dockerHostConfigurationSchema,
  pluginManagement: z.boolean().default(false),
  native: z.object({ socketPath: path, tokenFile: path }).strict(),
  gateway: z.object({ socketPath: path, tokenFile: path }).strict(),
}).strict().refine(value => value.workspaceIds.length + value.workspaceRootIds.length > 0);
export type ManagedHostConfiguration = z.infer<typeof managedHostConfigurationSchema>;
const contains = (parent: string, child: string) => { const part = relative(parent, child); return part !== '..' && !part.startsWith('../') && !isAbsolute(part); };

export async function startManagedHarnesses(input: { configurations: ManagedHostConfiguration[]; storage: StorageClient; registry: WorkspaceRegistry; adapters: Map<HarnessId, HarnessAdapter>; plugins?: Partial<Record<HarnessId, PluginBackend>>; dataDirectory: string; workspaceWriterDirectory?: string }): Promise<ManagedWorkbenchOptions & { close(): Promise<void> }> {
  if (input.configurations.length && !input.workspaceWriterDirectory) throw new Error('managed_workspace_writer_directory_required');
  if (!input.configurations.length) return { async close() {} };
  const opened: { host: ExecutionHost; client: ManagedHarnessRpc; server: Awaited<ReturnType<typeof serveExecutionGateway>>; config: ManagedHostConfiguration }[] = [];
  const close = async () => { for (const entry of opened.splice(0).reverse()) { await entry.server.close(); await entry.host.close(); await entry.client.close(); } };
  try {
    for (const config of input.configurations) {
      await mkdir(config.ledgerDirectory, { recursive: true, mode: 0o700 });
      const canonical = await realpath(config.ledgerDirectory); const info = await lstat(canonical);
      if (canonical !== config.ledgerDirectory || !info.isDirectory() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid() || contains(input.dataDirectory, canonical) || contains(canonical, input.dataDirectory)) throw new Error('execution_ledger_requires_private_independent_directory');
      if (config.docker.mounts.some(mount => [input.dataDirectory, canonical, input.workspaceWriterDirectory!].some(path => contains(mount.source, path) || contains(path, mount.source)))) throw new Error('execution_private_mount_overlap');
      const token = (await readOperatorFile(config.native.tokenFile, 128)).trim();
      const gatewayToken = (await readOperatorFile(config.gateway.tokenFile, 128)).trim();
      if (gatewayToken === token) throw new Error('execution_gateway_requires_separate_credential');
      const owner = await acquireExecutionHostOwnership(config.docker.ownershipPort, join(canonical, 'owner.lock'));
      const ledger = createExecutionHostLedger({ directory: canonical, groupId: config.groupId, configurationDigest: hostDigest({ docker: config.docker, workspaceWriterDirectory: input.workspaceWriterDirectory }), capacity: config.ledgerCapacity });
      const client = new ManagedHarnessRpc({ socketPath: config.native.socketPath, token });
      let host: ExecutionHost | undefined;
      try {
        await ledger.ready;
        const generation = (await ledger.load()).state.generation;
        const runtime = createDockerExecutionHost(config.docker, config.groupId, generation, [input.dataDirectory, canonical, input.workspaceWriterDirectory!], input.workspaceWriterDirectory);
        host = new ExecutionHost(ledger, runtime, client, createManagedHarnessAuthority({ groupId: config.groupId, harnessId: config.harnessId, store: input.storage.store, execution: input.storage.execution, registry: input.registry }), owner);
        await host.bootstrap();
        const server = await serveExecutionGateway(host, { socketPath: config.gateway.socketPath, token: gatewayToken });
        opened.push({ host, client, server, config });
        input.adapters.set(config.harnessId, await managedHarnessReadAdapter(client, config.harnessId));
        if (config.pluginManagement) {
          if (!input.plugins) throw new Error('managed_plugins_store_required');
          // An existing Host may be stopped or unavailable. Plugin discovery
          // happens on use and fails closed; it must not prevent archive access
          // or restart the Host merely to make the application boot.
          input.plugins[config.harnessId] = managedHarnessPlugins({ harnessId: config.harnessId, host, client, store: input.storage.plugins, execution: input.storage.execution });
        }
      } catch (error) { if (host) await host.close(); else { await ledger.close(); await owner.close(); } await client.close(); throw error; }
    }
    const execution = new ManagedWorkspaceExecution({ port: input.storage.execution, workspaces: input.storage.workspaces,
      groups: opened.map(entry => ({ groupId: entry.config.groupId, harnessId: entry.config.harnessId, conflicts: opened.filter(other => other !== entry &&
        entry.config.docker.mounts.some(left => left.kind === 'workspace' && !left.readOnly && other.config.docker.mounts.some(right => right.kind === 'workspace' && !right.readOnly && (contains(left.source, right.source) || contains(right.source, left.source)))))
        .map(other => other.config.groupId), workspaceIds: entry.config.workspaceIds, workspaceRootIds: entry.config.workspaceRootIds, controller: entry.host.controller })) });
    return { execution, async resolveHostPending(pending) {
      const admission = await input.storage.execution.hostAdmission(pending.operationId);
      const backend = input.plugins?.[pending.harnessId];
      if (!admission || !backend) return 'unknown';
      try {
        const result = admission.kind === 'plugin' ? await backend.recover(pluginCommand.parse(admission.command)) :
          await backend.recoverSource?.(pluginSourceCommand.parse(admission.command), pending.operationId) ?? 'unknown';
        return result === 'applied' || result === 'failed' ? 'settled' : result === 'unknown' ? 'unknown' : 'pending';
      } catch { return 'unknown'; }
    }, async recoverCreation(conversation) {
      const entry = opened.find(value => value.config.harnessId === conversation.harnessId);
      return entry ? await entry.host.recoverCreation(conversation.id) : null;
    }, async managedAdapter(conversation, raw, context) {
      const entry = opened.find(value => value.config.harnessId === conversation.harnessId);
      if (!entry) return raw;
      if (!(await input.storage.execution.workspaceGroups(conversation.workspaceId)).includes(entry.config.groupId)) throw new Error('execution_workspace_unmanaged');
      return await createManagedHarnessAdapter(entry.host, entry.client, conversation, context);
    }, close };
  } catch (error) { await close(); throw error; }
}

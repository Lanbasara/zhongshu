import { lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { createCodexAdapter } from '../harness/codex/index.ts';
import type { MaintenanceController } from './workspace-maintenance.ts';
import { managedHostConfigurationSchema, type ManagedHostConfiguration } from './managed-harness-config.ts';
import { createDshAdapter } from '../harness/dsh/index.ts';
import type { HarnessAdapter, HarnessId } from '../harness/types.ts';
import { workspaceIdSchema, workspaceLabelSchema } from '../shared/workbench.ts';
import { codexPluginClient } from './codex-plugin-client.ts';
import type { PluginBackend } from './plugin-backend.ts';
import { dshPlugins, dshPluginSources } from './dsh-plugins.ts';

const absolutePath = z.string().min(1).max(4096).refine(isAbsolute);
const configuration = z.object({
  workspaces: z.array(z.object({ id: workspaceIdSchema, label: z.string().min(1).max(100), directory: absolutePath, managedWrites: z.boolean().optional() }).strict()).max(16).default([]),
  workspaceRoots: z.array(z.object({ id: workspaceIdSchema, label: workspaceLabelSchema, directory: absolutePath }).strict()).max(16).default([]),
  workspaceWriterDirectory: absolutePath.optional(),
  managedHosts: z.array(managedHostConfigurationSchema).max(2).default([]),
  codex: z.object({ socketPath: absolutePath, pluginManagerSocketPath: absolutePath.optional(), boundedHistory: z.object({ nativeRoot: absolutePath, cacheRoot: absolutePath, maxCacheBytes: z.number().int().min(1024 ** 2).max(16 * 1024 ** 3).optional() }).strict().optional() }).strict().optional(),
  dsh: z.object({ launchFile: absolutePath, maintenanceExecutable: absolutePath.optional(), pluginSources: dshPluginSources.optional(), boundedHistory: z.object({ nativeRoot: absolutePath, cacheRoot: absolutePath, maxCacheBytes: z.number().int().min(1024 ** 2).max(16 * 1024 ** 3).optional() }).strict().optional(), boundedState: z.literal(true).optional() }).strict().optional(),
}).strict();
export type Workspace = { id: string; label: string; directory: string; managedWrites?: boolean; maintenance?: MaintenanceController };
export type WorkspaceRoot = Pick<Workspace, 'id' | 'label' | 'directory'>;
export const contains = (parent: string, child: string) => { const path = relative(parent, child); return path !== '..' && !path.startsWith('../') && !isAbsolute(path); };

/** Operator-owned configuration is never accepted from a browser request. */
export async function loadHarnesses(file: string | undefined, dataDirectory: string): Promise<{ workspaces: Workspace[]; workspaceRoots: WorkspaceRoot[]; adapters: Map<HarnessId, HarnessAdapter>; plugins: Partial<Record<HarnessId, PluginBackend>>; managedHosts: ManagedHostConfiguration[]; workspaceWriterDirectory?: string }> {
  if (!file) return { workspaces: [], workspaceRoots: [], adapters: new Map(), plugins: {}, managedHosts: [] };
  if (!isAbsolute(file)) throw new Error('harness_config_requires_absolute_path');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 || (info.mode & 0o022) || (process.getuid && info.uid !== process.getuid())) throw new Error('unsafe_harness_config');
  const config = configuration.parse(JSON.parse(await readFile(file, 'utf8')));
  if (config.dsh?.maintenanceExecutable) throw new Error('legacy_maintenance_requires_managed_host_migration');
  if (new Set(config.managedHosts.map(host => host.groupId)).size !== config.managedHosts.length ||
    new Set(config.managedHosts.map(host => host.harnessId)).size !== config.managedHosts.length ||
    new Set(config.managedHosts.map(host => host.docker.ownershipPort)).size !== config.managedHosts.length ||
    new Set(config.managedHosts.map(host => host.gateway.socketPath)).size !== config.managedHosts.length ||
    config.managedHosts.some(host => config[host.harnessId])) throw new Error('duplicate_managed_harness_configuration');
  const configuredDirectories = await Promise.all([...config.workspaces, ...config.workspaceRoots].map(async row => { try { return await realpath(row.directory); } catch { return resolve(row.directory); } }));
  for (const host of config.managedHosts) {
    if (host.docker.mounts.some(mount => !mount.readOnly && mount.kind !== 'workspace' && configuredDirectories.some(directory => contains(mount.source, directory) || contains(directory, mount.source)))) throw new Error('execution_nonworkspace_mount_overlaps_workspace');
    if (host.workspaceIds.some(id => !config.workspaces.some(row => row.id === id)) || host.workspaceRootIds.some(id => !config.workspaceRoots.some(row => row.id === id))) throw new Error('execution_workspace_scope_missing');
    const scope = [...config.workspaces.filter(row => host.workspaceIds.includes(row.id)), ...config.workspaceRoots.filter(row => host.workspaceRootIds.includes(row.id))];
    const paths = await Promise.all(scope.map(row => realpath(row.directory)));
    const mounts = host.docker.mounts.filter(mount => mount.kind === 'workspace');
    if (paths.some(path => !mounts.some(mount => mount.source === path && mount.target === path)) || mounts.some(mount => !paths.includes(mount.source))) throw new Error('execution_workspace_mount_scope_mismatch');
  }
  const privateRoot = await realpath(dataDirectory);
  if (config.managedHosts.some(host => host.docker.mounts.some(mount => contains(mount.source, privateRoot) || contains(privateRoot, mount.source)))) throw new Error('execution_private_mount_overlap');
  let workspaceWriterDirectory: string | undefined;
  if (config.managedHosts.length) {
    if (!config.workspaceWriterDirectory) throw new Error('managed_workspace_writer_directory_required');
    await mkdir(config.workspaceWriterDirectory, { recursive: true, mode: 0o700 });
    workspaceWriterDirectory = await realpath(config.workspaceWriterDirectory);
    const info = await lstat(config.workspaceWriterDirectory);
    const forbidden = [privateRoot, ...configuredDirectories, ...config.managedHosts.flatMap(host => host.docker.mounts.filter(mount => !mount.readOnly).map(mount => mount.source))];
    if (workspaceWriterDirectory !== config.workspaceWriterDirectory || !info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid() || forbidden.some(path => contains(path, workspaceWriterDirectory!) || contains(workspaceWriterDirectory!, path))) throw new Error('unsafe_workspace_writer_directory');
  }
  const workspaceRoots: WorkspaceRoot[] = [];
  for (const input of config.workspaceRoots) {
    const directory = await realpath(resolve(input.directory));
    if (!(await stat(directory)).isDirectory() || contains(directory, privateRoot) || contains(privateRoot, directory) ||
      workspaceRoots.some(root => root.id === input.id || contains(root.directory, directory) || contains(directory, root.directory))) throw new Error('unsafe_workspace_root');
    workspaceRoots.push({ ...input, directory });
  }
  const workspaces: Workspace[] = [];
  for (const input of config.workspaces) {
    const path = resolve(input.directory);
    let directory = path;
    try {
      directory = await realpath(path);
      if (!(await stat(directory)).isDirectory()) throw new Error('unsafe_workspace_configuration');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || config.dsh?.maintenanceExecutable) throw error;
      // Existing registrations and saved history stay available while a folder is missing.
    }
    if (contains(directory, privateRoot) || contains(privateRoot, directory) || workspaces.some(item => item.id === input.id))
      throw new Error('unsafe_workspace_configuration');
    workspaces.push({ ...input, directory, managedWrites: config.managedHosts.some(host => host.workspaceIds.includes(input.id)) });
  }
  const adapters = new Map<HarnessId, HarnessAdapter>();
  const plugins: Partial<Record<HarnessId, PluginBackend>> = {};
  if (config.codex) {
    adapters.set('codex', createCodexAdapter(config.codex));
    if (config.codex.pluginManagerSocketPath) plugins.codex = codexPluginClient(config.codex.pluginManagerSocketPath, config.codex.socketPath);
  }
  if (config.dsh) {
    adapters.set('dsh', createDshAdapter(config.dsh));
    if (config.dsh.pluginSources) plugins.dsh = dshPlugins(config.dsh.launchFile, config.dsh.pluginSources);
  }
  return { workspaces, workspaceRoots, adapters, plugins, managedHosts: config.managedHosts, workspaceWriterDirectory };
}

import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { createCodexAdapter } from '../harness/codex/index.ts';
import { maintenanceController, type MaintenanceController } from './workspace-maintenance.ts';
import { createDshAdapter } from '../harness/dsh/index.ts';
import type { HarnessAdapter, HarnessId } from '../harness/types.ts';
import { workspaceIdSchema, workspaceLabelSchema } from '../shared/workbench.ts';

const absolutePath = z.string().min(1).max(4096).refine(isAbsolute);
const configuration = z.object({
  workspaces: z.array(z.object({ id: workspaceIdSchema, label: z.string().min(1).max(100), directory: absolutePath, managedWrites: z.boolean().optional() }).strict()).max(16).default([]),
  workspaceRoots: z.array(z.object({ id: workspaceIdSchema, label: workspaceLabelSchema, directory: absolutePath }).strict()).max(16).default([]),
  codex: z.object({ socketPath: absolutePath }).strict().optional(),
  dsh: z.object({ launchFile: absolutePath, maintenanceExecutable: absolutePath.optional() }).strict().optional(),
}).strict();
export type Workspace = { id: string; label: string; directory: string; managedWrites?: boolean; maintenance?: MaintenanceController };
export type WorkspaceRoot = Pick<Workspace, 'id' | 'label' | 'directory'>;
export const contains = (parent: string, child: string) => { const path = relative(parent, child); return path !== '..' && !path.startsWith('../') && !isAbsolute(path); };

/** Operator-owned configuration is never accepted from a browser request. */
export async function loadHarnesses(file: string | undefined, dataDirectory: string): Promise<{ workspaces: Workspace[]; workspaceRoots: WorkspaceRoot[]; adapters: Map<HarnessId, HarnessAdapter> }> {
  if (!file) return { workspaces: [], workspaceRoots: [], adapters: new Map() };
  if (!isAbsolute(file)) throw new Error('harness_config_requires_absolute_path');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 || (info.mode & 0o022) || (process.getuid && info.uid !== process.getuid())) throw new Error('unsafe_harness_config');
  const config = configuration.parse(JSON.parse(await readFile(file, 'utf8')));
  if (config.dsh?.maintenanceExecutable && (config.codex || config.workspaceRoots.length || config.workspaces.length !== 1 || !config.workspaces[0]?.managedWrites))
    throw new Error('maintenance_requires_dedicated_dsh_workspace');
  if (config.dsh && !config.dsh.maintenanceExecutable && config.workspaces.some(workspace => workspace.managedWrites))
    throw new Error('dsh_managed_writes_requires_maintenance');
  const privateRoot = await realpath(dataDirectory);
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
    workspaces.push({ ...input, directory, ...(config.dsh?.maintenanceExecutable ? { maintenance: maintenanceController(config.dsh.maintenanceExecutable) } : {}) });
  }
  const adapters = new Map<HarnessId, HarnessAdapter>();
  if (config.codex) adapters.set('codex', createCodexAdapter(config.codex));
  if (config.dsh) adapters.set('dsh', createDshAdapter(config.dsh));
  return { workspaces, workspaceRoots, adapters };
}

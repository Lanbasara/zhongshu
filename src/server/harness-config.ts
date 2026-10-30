import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { createCodexAdapter } from '../harness/codex/index.ts';
import { createDshAdapter } from '../harness/dsh/index.ts';
import type { HarnessAdapter, HarnessId } from '../harness/types.ts';

const absolutePath = z.string().min(1).max(4096).refine(isAbsolute);
const configuration = z.object({
  workspaces: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), label: z.string().min(1).max(100), directory: absolutePath }).strict()).min(1).max(16),
  codex: z.object({ socketPath: absolutePath }).strict().optional(),
  dsh: z.object({ launchFile: absolutePath }).strict().optional(),
}).strict();
export type Workspace = { id: string; label: string; directory: string };
const contains = (parent: string, child: string) => { const path = relative(parent, child); return !path || (!path.startsWith('..') && !isAbsolute(path)); };

/** Operator-owned configuration is never accepted from a browser request. */
export async function loadHarnesses(file: string | undefined, dataDirectory: string): Promise<{ workspaces: Workspace[]; adapters: Map<HarnessId, HarnessAdapter> }> {
  if (!file) return { workspaces: [], adapters: new Map() };
  if (!isAbsolute(file)) throw new Error('harness_config_requires_absolute_path');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 || (info.mode & 0o022) || (process.getuid && info.uid !== process.getuid())) throw new Error('unsafe_harness_config');
  const config = configuration.parse(JSON.parse(await readFile(file, 'utf8')));
  const privateRoot = await realpath(dataDirectory);
  const workspaces: Workspace[] = [];
  for (const input of config.workspaces) {
    const directory = await realpath(resolve(input.directory));
    if (!(await stat(directory)).isDirectory() || contains(directory, privateRoot) || contains(privateRoot, directory) || workspaces.some(item => item.id === input.id)) throw new Error('unsafe_workspace_configuration');
    workspaces.push({ ...input, directory });
  }
  const adapters = new Map<HarnessId, HarnessAdapter>();
  if (config.codex) adapters.set('codex', createCodexAdapter(config.codex));
  if (config.dsh) adapters.set('dsh', createDshAdapter(config.dsh));
  return { workspaces, adapters };
}

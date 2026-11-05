import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';
import { loadHarnesses } from './harness-config.ts';
import { startManagedHarnesses } from './managed-harness-config.ts';
import { createStorageClient, type StorageClient } from './storage-client.ts';
import { DirectoryIndex } from './directory-index.ts';
import { WorkspaceFileWriter } from './workspace-writer.ts';
import { Workbench } from './workbench.ts';
import { createWorkbenchHttp } from './workbench-http.ts';
import { WorkspaceRegistry } from './workspace-registry.ts';
import { createPluginManagement } from './plugins.ts';

const metadataSchema = z.object({ name: z.literal('zhongshu'), version: z.string().max(64), revision: z.string().regex(/^(development|[a-f0-9]{40})$/) });

async function main() {
  const config = loadConfig();
  let metadata;
  try { metadata = metadataSchema.parse(JSON.parse(await readFile(new URL('../version.json', import.meta.url), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('invalid_build_metadata'); }
  let workbench: Workbench | undefined;
  let transport: ReturnType<typeof createWorkbenchHttp> | undefined;
  let plugins: ReturnType<typeof createPluginManagement> | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let storage: StorageClient | undefined;
  let directories: DirectoryIndex | undefined;
  let managed: Awaited<ReturnType<typeof startManagedHarnesses>> | undefined;
  let stop: (() => Promise<void>) | undefined;
  try {
    storage = createStorageClient({ dataDirectory: config.dataDirectory, capacity: config.storageCapacity, onChange: change => transport?.changed(change), onReset: () => transport?.invalidate(),
      onFailure: () => {
        process.exitCode = 1;
        console.error(JSON.stringify({ event: 'storage_owner_failed' }));
        // Startup failures already unwind through catch. Once serving, close
        // the whole owner so an external bounded restart can recover the journal.
        if (stop) void stop();
      } });
    await storage.ready;
    const harnesses = await loadHarnesses(process.env.ZHONGSHU_HARNESS_CONFIG, config.dataDirectory);
    plugins = createPluginManagement(storage.plugins, harnesses.plugins);
    await plugins.ready;
    directories = new DirectoryIndex(join(config.dataDirectory, 'directory-index'));
    const registry = new WorkspaceRegistry(storage.workspaces, harnesses.workspaces, harnesses.workspaceRoots);
    await registry.ready;
    managed = await startManagedHarnesses({ configurations: harnesses.managedHosts, storage, registry, adapters: harnesses.adapters, plugins: harnesses.plugins, dataDirectory: config.dataDirectory, workspaceWriterDirectory: harnesses.workspaceWriterDirectory });
    workbench = new Workbench(storage.store, harnesses.workspaces, harnesses.adapters, registry, directories, { ...managed, ...(harnesses.workspaceWriterDirectory ? { writer: new WorkspaceFileWriter({ dataDirectory: harnesses.workspaceWriterDirectory, capacity: config.workspaceWriterCapacity }) } : {}) });
    transport = createWorkbenchHttp(workbench);
    app = await buildApp({ authStore: storage.auth, origin: config.origin, metadata, assetsDirectory: import.meta.url.endsWith('.ts') ? undefined : fileURLToPath(new URL('../public/', import.meta.url)), logger: true,
      readiness: () => storage!.diagnostics().phase === 'ready',
      privateRoutes: async (scope, context) => {
        await transport!.routes(scope, context);
        await scope.register(plugins!.routes, { prefix: '/workbench' });
      }, onLogout: transport.logout });
    let closing = false;
    stop = async () => {
      if (closing) return;
      closing = true;
      const timeout = setTimeout(() => process.exit(1), 10_000).unref();
      try { transport!.close(); await plugins!.close(); await workbench!.close(); await managed!.close(); await app!.close(); await storage!.close(); await directories!.close(); clearTimeout(timeout); }
      catch { process.exitCode = 1; }
    };
    process.once('SIGINT', () => { void stop!(); });
    process.once('SIGTERM', () => { void stop!(); });
    await workbench.start();
    await app.listen({ port: config.port, host: config.host });
  } catch (error) { transport?.close(); await plugins?.close(); await workbench?.close(); await managed?.close(); await app?.close(); await storage?.close(); await directories?.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(JSON.stringify({ event: 'startup_failed' })); process.exitCode = 1; });
}

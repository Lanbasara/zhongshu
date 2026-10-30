import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig } from './config.ts';
import { openDatabase } from './database.ts';
import { buildApp } from './app.ts';
import { productMigrations } from './migrations.ts';
import { loadHarnesses } from './harness-config.ts';
import { createWorkbenchStore, type WorkbenchChange } from './workbench-store.ts';
import { Workbench } from './workbench.ts';
import { createWorkbenchHttp } from './workbench-http.ts';

const metadataSchema = z.object({ name: z.literal('zhongshu'), version: z.string().max(64), revision: z.string().regex(/^(development|[a-f0-9]{40})$/) });

async function main() {
  const config = loadConfig();
  let metadata;
  try { metadata = metadataSchema.parse(JSON.parse(await readFile(new URL('../version.json', import.meta.url), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('invalid_build_metadata'); }
  const db = openDatabase(config.dataDirectory, productMigrations);
  let workbench: Workbench | undefined;
  let transport: ReturnType<typeof createWorkbenchHttp> | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const harnesses = await loadHarnesses(process.env.ZHONGSHU_HARNESS_CONFIG, config.dataDirectory);
    const store = createWorkbenchStore(db, { onChange: (change: WorkbenchChange) => transport?.changed(change) });
    workbench = new Workbench(store, harnesses.workspaces, harnesses.adapters);
    transport = createWorkbenchHttp(workbench);
    app = await buildApp({ db, origin: config.origin, metadata, assetsDirectory: import.meta.url.endsWith('.ts') ? undefined : fileURLToPath(new URL('../public/', import.meta.url)), logger: true,
      privateRoutes: transport.routes, onLogout: transport.logout });
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      const timeout = setTimeout(() => process.exit(1), 10_000).unref();
      try { transport!.close(); await workbench!.close(); await app!.close(); db.close(); clearTimeout(timeout); }
      catch { process.exitCode = 1; }
    };
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
    await workbench.start();
    await app.listen({ port: config.port, host: config.host });
  } catch (error) { transport?.close(); await workbench?.close(); await app?.close(); db.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(JSON.stringify({ event: 'startup_failed' })); process.exitCode = 1; });
}

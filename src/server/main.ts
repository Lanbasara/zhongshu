import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig } from './config.ts';
import { openDatabase } from './database.ts';
import { buildApp } from './app.ts';
import { productMigrations } from './migrations.ts';

const metadataSchema = z.object({ name: z.literal('zhongshu'), version: z.string().max(64), revision: z.string().regex(/^(development|[a-f0-9]{40})$/) });

async function main() {
  const config = loadConfig();
  let metadata;
  try { metadata = metadataSchema.parse(JSON.parse(await readFile(new URL('../version.json', import.meta.url), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('invalid_build_metadata'); }
  const db = openDatabase(config.dataDirectory, productMigrations);
  try {
    const app = await buildApp({ db, origin: config.origin, metadata, assetsDirectory: import.meta.url.endsWith('.ts') ? undefined : fileURLToPath(new URL('../public/', import.meta.url)), logger: true });
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      const timeout = setTimeout(() => process.exit(1), 10_000).unref();
      try { await app.close(); db.close(); clearTimeout(timeout); }
      catch { process.exitCode = 1; }
    };
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
    await app.listen({ port: config.port, host: config.host });
  } catch (error) { db.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(JSON.stringify({ event: 'startup_failed' })); process.exitCode = 1; });
}

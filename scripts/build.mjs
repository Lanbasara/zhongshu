import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const revision = process.env.REVISION ?? 'development';
if (revision !== 'development' && !/^[a-f0-9]{40}$/.test(revision)) {
  throw new Error('REVISION must be a full Git commit SHA');
}
const dist = new URL('dist/', root);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const args of [['scripts/design-tokens.mjs', '--check'], ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.server.json'], ['node_modules/vite/bin/vite.js', 'build']]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Build failed');
}
await writeFile(new URL('version.json', dist), `${JSON.stringify({ name: pkg.name, version: pkg.version, revision })}\n`);
// 司辰 (ADR 0022) ships as its own directory: dependency-free modules, a runnable bin and its version, mounted beside any Harness.
const sichen = new URL('sichen/', dist);
await writeFile(new URL('package.json', sichen), `${JSON.stringify({ name: 'sichen', private: true, type: 'module' })}\n`);
await writeFile(new URL('version.json', sichen), `${JSON.stringify({ version: pkg.version, revision })}\n`);
await mkdir(new URL('bin/', sichen), { recursive: true });
await writeFile(new URL('bin/sichen', sichen), "#!/usr/bin/env node\nimport { main } from '../cli.js';\nawait main(process.argv.slice(2));\n", { mode: 0o755 });
// 司门 (ADR 0023) ships the same way: the `chrome-devtools` command for the Harness and the host that runs beside the browser.
const simen = new URL('simen/', dist);
await writeFile(new URL('package.json', simen), `${JSON.stringify({ name: 'simen', private: true, type: 'module' })}\n`);
await writeFile(new URL('version.json', simen), `${JSON.stringify({ version: pkg.version, revision })}\n`);
await mkdir(new URL('bin/', simen), { recursive: true });
await writeFile(new URL('bin/chrome-devtools', simen), "#!/usr/bin/env node\nimport { main } from '../cli.js';\nprocess.exitCode = await main(process.argv.slice(2));\n", { mode: 0o755 });
await writeFile(new URL('bin/simen-host', simen), "#!/usr/bin/env node\nimport { main } from '../runtime.js';\nawait main();\n", { mode: 0o755 });
const boundary = spawnSync(process.execPath, ['scripts/check-release.mjs', '--seal'], { cwd: root, stdio: 'inherit' });
if (boundary.error || boundary.status !== 0) throw new Error('Release boundary failed');
console.log(`Built ${pkg.name} ${pkg.version} (${revision})`);

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
const boundary = spawnSync(process.execPath, ['scripts/check-release.mjs', '--seal'], { cwd: root, stdio: 'inherit' });
if (boundary.error || boundary.status !== 0) throw new Error('Release boundary failed');
console.log(`Built ${pkg.name} ${pkg.version} (${revision})`);

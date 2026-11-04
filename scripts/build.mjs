import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';

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
// Compression is derived only from the already checked bundler inventory.
// Seal verifies each encoding against its original; it is not another source
// or an unchecked public-asset directory.
const webInventory = JSON.parse(await readFile(new URL('web-inventory.json', dist), 'utf8'));
for (const [name, expected] of Object.entries(webInventory)) {
  if (!/^public\/assets\/[^/]+\.(js|css)$/.test(name)) continue;
  const bytes = await readFile(new URL(name, dist));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Web output changed before compression');
  if (bytes.length < 1024) continue;
  for (const [suffix, compressed] of [['gz', gzipSync(bytes, { level: 6 })], ['br', brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })]]) {
    await writeFile(new URL(name + '.' + suffix, dist), compressed);
    webInventory[name + '.' + suffix] = createHash('sha256').update(compressed).digest('hex');
  }
}
await writeFile(new URL('web-inventory.json', dist), JSON.stringify(webInventory));
const boundary = spawnSync(process.execPath, ['scripts/check-release.mjs', '--seal'], { cwd: root, stdio: 'inherit' });
if (boundary.error || boundary.status !== 0) throw new Error('Release boundary failed');
console.log(`Built ${pkg.name} ${pkg.version} (${revision})`);

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const revision = process.env.REVISION ?? 'development';
if (revision !== 'development' && !/^[a-f0-9]{40}$/.test(revision)) {
  throw new Error('REVISION must be a full Git commit SHA');
}
const dist = new URL('dist/', root);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(new URL('src/public/', root), new URL('public/', dist), { recursive: true });
await cp(new URL('src/server.mjs', root), new URL('server.mjs', dist));
await writeFile(new URL('version.json', dist), `${JSON.stringify({ name: pkg.name, version: pkg.version, revision })}\n`);
console.log(`Built ${pkg.name} ${pkg.version} (${revision})`);

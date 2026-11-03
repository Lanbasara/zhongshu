import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
const dist = resolve(root, 'dist');
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Release boundary: symlink in artifact');
    return entry.isDirectory() ? walk(path) : [path];
  });
}
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
if (process.argv.includes('--seal')) {
  const web = JSON.parse(readFileSync(resolve(dist, 'web-inventory.json'), 'utf8'));
  const sourceFiles = ['server', 'harness', 'shared'].flatMap(name => walk(resolve(root, 'src', name))).filter(path => path.endsWith('.ts') && !path.endsWith('.d.ts'));
  const allowed = new Set(['version.json', 'web-inventory.json', ...Object.keys(web), ...sourceFiles.map(path => relative(resolve(root, 'src'), path).replace(/\.ts$/, '.js'))]);
  const inventory = {};
  for (const file of walk(dist)) {
    const name = relative(dist, file);
    if (!allowed.has(name)) throw new Error(`Release boundary: unexpected output ${name}`);
    if (name.startsWith('public/') && web[name] !== digest(file)) throw new Error(`Release boundary: web output changed ${name}`);
    inventory[name] = digest(file);
  }
  for (const name of allowed) if (!existsSync(resolve(dist, name))) throw new Error(`Release boundary: missing output ${name}`);
  writeFileSync(resolve(dist, 'release-inventory.json'), JSON.stringify(inventory, null, 2));
} else {
  const inventory = JSON.parse(readFileSync(resolve(dist, 'release-inventory.json'), 'utf8'));
  const actual = walk(dist).filter(path => relative(dist, path) !== 'release-inventory.json');
  if (actual.length !== Object.keys(inventory).length) throw new Error('Release boundary: file inventory differs');
  for (const file of actual) if (inventory[relative(dist, file)] !== digest(file)) throw new Error(`Release boundary: changed artifact ${relative(dist, file)}`);
  for (const path of ['design', '.storybook', 'storybook-static', 'node_modules/storybook', 'node_modules/@storybook']) {
    if (existsSync(resolve(root, path)) && (process.argv.includes('--image') || path.startsWith('node_modules/') && process.argv.includes('--runtime'))) throw new Error(`Release boundary: development content in image: ${path}`);
  }
}
console.log('Release boundary verified.');

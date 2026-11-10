import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';
import type { Plugin } from 'vite';

const normalize = (path: string) => path.split(sep).join('/').split('?')[0]!;
export const developmentOnly = (path: string) => /(^|\/)(design|\.storybook|storybook-static|test|tests)(\/|$)|\.stories\.[cm]?[jt]sx?$|\/node_modules\/(?:@storybook\/|storybook\/)/.test(normalize(path));
export function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Build boundary: symlink is not allowed: ${entry.name}`);
    return entry.isDirectory() ? files(path) : [path];
  });
}
// ADR 0024: the server workbench is layered from tools (0) to the front desk (5). A module imports only lower
// layers; same-layer imports are the listed peers. Every module has a layer, and none grows past the line budget.
const WORKBENCH_FRONT = 'src/server/workbench.ts';
const workbenchLayers: Record<string, number> = {
  tasks: 0, pages: 0,
  bindings: 1,
  gate: 2, ledger: 2, history: 2, live: 2,
  observation: 3, participant: 3,
  creation: 4, execution: 4, queue: 4, readers: 4, transcript: 4, subagents: 4, requests: 4, workspaces: 4, lifecycle: 4,
};
const workbenchPeers = new Set(['observation>participant', 'lifecycle>subagents', 'lifecycle>readers', 'queue>execution']);
const WORKBENCH_MODULE_LINES = 500;
const workbenchModule = (path: string) => /^src\/server\/workbench\/([^/]+)\.ts$/.exec(path)?.[1];
function workbenchLayer(path: string): number | undefined {
  if (path === WORKBENCH_FRONT) return 5;
  if (!path.startsWith('src/server/workbench/')) return undefined;
  const layer = workbenchLayers[workbenchModule(path) ?? ''];
  if (layer === undefined) throw new Error(`Workbench boundary: ${path} has no layer in ADR 0024`);
  return layer;
}
function checkWorkbenchImport(name: string, target: string) {
  const to = workbenchLayer(target);
  if (to === undefined) return;
  const from = workbenchLayer(name);
  if (from === undefined) {
    if (target !== WORKBENCH_FRONT) throw new Error(`Workbench boundary: ${name} imports ${target}; use the Workbench front desk`);
    return;
  }
  if (to > from || (to === from && !workbenchPeers.has(`${workbenchModule(name)}>${workbenchModule(target)}`)))
    throw new Error(`Workbench boundary: ${name} (layer ${from}) imports ${target} (layer ${to})`);
}
export function checkSources(root: string) {
  for (const file of files(resolve(root, 'src')).filter(path => /\.[jt]sx?$/.test(path))) {
    const name = normalize(relative(root, file));
    if (developmentOnly(name)) throw new Error(`Build boundary: development source in product: ${name}`);
    const text = readFileSync(file, 'utf8');
    if (workbenchLayer(name) !== undefined) {
      const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      if (lines > WORKBENCH_MODULE_LINES) throw new Error(`Workbench boundary: ${name} has ${lines} lines (budget ${WORKBENCH_MODULE_LINES})`);
    }
    const ast = parse(text, { sourceType: 'module', sourceFilename: name, plugins: file.endsWith('tsx') ? ['typescript', 'jsx'] : ['typescript'] });
    const presentation = /^src\/web\/(ui|patterns)\//.test(name);
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const node = value as Record<string, unknown>;
      const callee = node.callee as Record<string, unknown> | undefined;
      let specifier: unknown;
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(String(node.type))) specifier = node.source;
      if (node.type === 'TSImportType') specifier = node.source;
      if (node.type === 'CallExpression' && callee?.type === 'Identifier' && callee.name === 'require') specifier = (node.arguments as unknown[])[0];
      if (specifier) {
        const source = specifier as Record<string, unknown>;
        if (source.type !== 'StringLiteral') throw new Error(`Build boundary: nonliteral module dependency in ${name}`);
        const dependency = String(source.value);
        const target = dependency.startsWith('.') ? normalize(relative(root, resolve(file, '..', dependency))) : `node_modules/${dependency}/`;
        if (developmentOnly(target)) throw new Error(`Build boundary: ${name} imports development code: ${dependency}`);
        if (dependency.startsWith('.') && !target.startsWith('src/')) throw new Error(`Build boundary: dependency outside product source: ${name}`);
        if (dependency.startsWith('.')) checkWorkbenchImport(name, target);
        if (presentation && dependency.startsWith('.') && !/^src\/web\/(ui|patterns)\//.test(target)) throw new Error(`UI boundary: ${name} imports a feature: ${dependency}`);
        if (presentation && !dependency.startsWith('.') && !['react','react-dom','radix-ui','lucide-react','motion/react'].includes(dependency)) throw new Error(`UI boundary: unreviewed external dependency: ${dependency}`);
        if (name.startsWith('src/web/ui/') && target.startsWith('src/web/patterns/')) throw new Error(`UI boundary: foundation imports a product pattern: ${name}`);
      }
      if (presentation && ['CallExpression','NewExpression'].includes(String(node.type)) && callee?.type === 'Identifier' && ['fetch','WebSocket','EventSource'].includes(String(callee.name))) throw new Error(`UI boundary: transport in ${name}`);
      for (const [key, child] of Object.entries(node)) if (!['loc','comments','tokens'].includes(key)) visit(child);
    };
    visit(ast);
  }
}
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export function checkPublic(root: string) {
  const allowed = JSON.parse(readFileSync(resolve(root, 'scripts/product-assets.json'), 'utf8')) as Record<string, string>;
  const directory = resolve(root, 'src/web/public');
  const actual = files(directory);
  if (actual.length !== Object.keys(allowed).length) throw new Error('Build boundary: public asset inventory changed');
  for (const file of actual) {
    const name = normalize(relative(directory, file));
    if (allowed[name] !== sha(readFileSync(file))) throw new Error(`Build boundary: unreviewed public asset: ${name}`);
  }
}
export function productBoundary(root: string): Plugin {
  return {
    name: 'zhongshu-product-boundary', apply: 'build', enforce: 'post',
    buildStart() { checkSources(root); checkPublic(root); },
    generateBundle(_options, bundle) {
      for (const id of this.getModuleIds()) {
        if (developmentOnly(id)) this.error(`Build boundary: development module entered product graph: ${id}`);
      }
      for (const name of Object.keys(bundle)) {
        if (developmentOnly(name) || !/^(index\.html|assets\/[^/]+\.(js|css))$/.test(name)) this.error(`Build boundary: unexpected web output: ${name}`);
      }
    },
    writeBundle(_options, bundle) {
      const entries: Record<string, string> = {};
      for (const name of Object.keys(bundle)) entries[`public/${name}`] = sha(readFileSync(resolve(root, 'dist/public', name)));
      const publicFiles = files(resolve(root, 'src/web/public'));
      for (const path of publicFiles) entries[`public/${normalize(relative(resolve(root, 'src/web/public'), path))}`] = sha(readFileSync(path));
      writeFileSync(resolve(root, 'dist/web-inventory.json'), JSON.stringify(entries));
    },
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { checkSources, checkPublic } from '../scripts/design-boundaries.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zh-ui-boundary-'));
  for (const path of ['src/web/ui','src/web/patterns','src/web/public','src/server','src/shared','src/harness','scripts','dist/public']) mkdirSync(join(root,path), { recursive:true });
  return root;
}
test('UI dependency boundary rejects feature imports, including dynamic and type imports', () => {
  const root = fixture();
  try {
    const path = join(root,'src/web/ui/control.tsx');
    writeFileSync(path, "import { useState } from 'react'; export const x = <button/>;");
    assert.doesNotThrow(() => checkSources(root));
    for (const source of ["import type { Draft } from '../workbench-client.ts';", "const read = () => import('../workbench-client.ts');", "type X = import('../workbench-client.ts').Draft;", "fetch('/api/private/example');", "new EventSource('/api');"]) {
      writeFileSync(path,source);
      assert.throws(() => checkSources(root), /UI boundary/);
    }
  } finally { rmSync(root,{ recursive:true,force:true }); }
});
test('product source cannot import development assets even when tree-shaken', () => {
  const root = fixture();
  try {
    for (const source of ["import '../../../design/stories/example.ts';", "export { x } from '../../../design/reference/index.js';", "const x = () => import('./x.stories.tsx');", "import x from 'storybook/test';", "const x = (path: string) => import(path);"]) {
      writeFileSync(join(root,'src/web/main.ts'),source);
      assert.throws(() => checkSources(root), /Build boundary/);
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
test('workbench layers: imports go downward, peers only as ADR 0024 lists, every module has a layer and a line budget', () => {
  const root = fixture();
  const write = (name: string, source: string) => writeFileSync(join(root, 'src/server/workbench', name), source);
  try {
    mkdirSync(join(root, 'src/server/workbench'), { recursive: true });
    write('gate.ts', 'export const gate = 1;');
    write('queue.ts', "import { gate } from './gate.ts'; export const queue = gate;");
    write('execution.ts', 'export const execution = 1;');
    writeFileSync(join(root, 'src/server/workbench.ts'), "import { queue } from './workbench/queue.ts'; export const front = queue;");
    writeFileSync(join(root, 'src/server/app.ts'), "import { front } from './workbench.ts'; export const app = front;");
    assert.doesNotThrow(() => checkSources(root));
    for (const [file, source] of [
      ['gate.ts', "import { queue } from './queue.ts'; export const gate = queue;"],
      ['gate.ts', "import { front } from '../workbench.ts'; export const gate = front;"],
      ['execution.ts', "import type { Queue } from './queue.ts'; export const execution = 1;"],
      ['execution.ts', "type Q = import('./queue.ts').Queue; export const execution = 1;"],
    ] as const) {
      const original = readFileSync(join(root, 'src/server/workbench', file), 'utf8');
      write(file, source);
      assert.throws(() => checkSources(root), /Workbench boundary/);
      write(file, original);
    }
    write('queue.ts', "import { execution } from './execution.ts'; export const queue = execution;");
    assert.doesNotThrow(() => checkSources(root));
    write('extra.ts', 'export const extra = 1;');
    assert.throws(() => checkSources(root), /no layer/);
    rmSync(join(root, 'src/server/workbench/extra.ts'));
    writeFileSync(join(root, 'src/server/app.ts'), "import { gate } from './workbench/gate.ts'; export const app = gate;");
    assert.throws(() => checkSources(root), /front desk/);
    writeFileSync(join(root, 'src/server/app.ts'), 'export const app = 1;');
    write('ledger.ts', '// line\n'.repeat(500));
    assert.doesNotThrow(() => checkSources(root));
    write('ledger.ts', '// line\n'.repeat(501));
    assert.throws(() => checkSources(root), /501 lines/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('the product source keeps its boundaries', () => {
  assert.doesNotThrow(() => checkSources(resolve('.')));
});
test('public inventory detects a copied or renamed prototype', () => {
  const root=fixture();
  try {
    const asset='<svg xmlns="http://www.w3.org/2000/svg"/>';
    writeFileSync(join(root,'src/web/public/icon.svg'),asset);
    writeFileSync(join(root,'scripts/product-assets.json'),JSON.stringify({'icon.svg':createHash('sha256').update(asset).digest('hex')}));
    assert.doesNotThrow(() => checkPublic(root));
    writeFileSync(join(root,'src/web/public/prototype.html'),'<html>demo</html>');
    assert.throws(() => checkPublic(root),/inventory/);
    rmSync(join(root,'src/web/public/prototype.html'));
    writeFileSync(join(root,'src/web/public/icon.svg'),'<html>renamed demo</html>');
    assert.throws(() => checkPublic(root),/unreviewed public asset/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
test('release seal rejects injected files and verification detects post-build modifications', () => {
  const root=fixture();
  const checker=resolve('scripts/check-release.mjs');
  const run=(...args:string[])=>spawnSync(process.execPath,[checker,...args],{cwd:root,encoding:'utf8'});
  try {
    const html='<html>product</html>';
    writeFileSync(join(root,'dist/public/index.html'),html);
    writeFileSync(join(root,'dist/web-inventory.json'),JSON.stringify({'public/index.html':createHash('sha256').update(html).digest('hex')}));
    writeFileSync(join(root,'dist/version.json'),'{}');
    assert.equal(run('--seal').status,0);
    assert.equal(run().status,0);
    writeFileSync(join(root,'dist/public/storybook.html'),'<html>demo</html>');
    assert.notEqual(run().status,0);
    assert.notEqual(run('--seal').status,0);
    rmSync(join(root,'dist/public/storybook.html'));
    writeFileSync(join(root,'dist/public/index.html'),'<html>changed</html>');
    assert.notEqual(run().status,0);
    writeFileSync(join(root,'dist/public/index.html'),html);
    mkdirSync(join(root,'node_modules/storybook'),{recursive:true});
    assert.notEqual(run('--image').status,0);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

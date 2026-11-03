import { readFile, writeFile } from 'node:fs/promises';
import { themeCss } from '../src/web/ui/tokens.ts';
const target = new URL('../src/web/ui/theme.css', import.meta.url);
const expected = themeCss();
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== expected) throw new Error('Design tokens drifted. Run npm run tokens.');
} else await writeFile(target, expected);

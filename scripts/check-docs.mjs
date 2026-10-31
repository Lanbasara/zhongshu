#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = join(root, 'docs');
const errors = [];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

function rel(path) {
  return relative(root, path).split(sep).join('/');
}

function linksIn(file) {
  const text = readFileSync(file, 'utf8');
  const links = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(text))) {
    let raw = match[1].trim();
    if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1);
    const target = raw.split(/\s+/)[0];
    if (!target || target.startsWith('#') || /^(https?:|mailto:|tel:)/i.test(target)) continue;
    const path = target.split('#')[0];
    if (!path) continue;
    links.push(resolve(dirname(file), decodeURIComponent(path)));
  }
  return links;
}

const docsFiles = walk(docsRoot);
const checkFiles = [
  join(root, 'AGENTS.md'),
  join(root, 'README.md'),
  join(root, 'CONTEXT.md'),
  ...docsFiles,
].filter(existsSync);

let linkCount = 0;
for (const file of checkFiles) {
  for (const target of linksIn(file)) {
    linkCount += 1;
    if (!existsSync(target)) {
      errors.push(`${rel(file)}: 链接目标不存在: ${rel(target)}`);
    }
  }
}

// Every document under docs/ must be reachable from an entry or an index.
const seeds = [
  join(root, 'AGENTS.md'),
  join(root, 'README.md'),
  join(docsRoot, 'README.md'),
].filter(existsSync);
const visited = new Set();
const queue = [...seeds];
while (queue.length > 0) {
  const file = queue.shift();
  if (visited.has(file) || !existsSync(file)) continue;
  visited.add(file);
  for (const target of linksIn(file)) {
    if (!existsSync(target)) continue;
    if (statSync(target).isDirectory()) {
      for (const nested of docsFiles) {
        if (nested.startsWith(`${target}${sep}`)) queue.push(nested);
      }
    } else if (target.endsWith('.md')) {
      queue.push(target);
    }
  }
}
for (const file of docsFiles) {
  if (!visited.has(resolve(file))) {
    errors.push(`${rel(file)}: 未被任何索引或文档链接到`);
  }
}

// Feature maps use a fixed, machine-checkable shape.
const featureDir = join(docsRoot, 'features');
if (existsSync(featureDir)) {
  const required = [
    'Sub-features',
    'How to get to it (user POV)',
    'Driving it with Harness',
    'Gotchas',
  ];
  const allowed = new Set([...required, 'Implementation and regression']);
  for (const name of readdirSync(featureDir)) {
    if (!name.endsWith('.md') || name === 'README.md') continue;
    const file = join(featureDir, name);
    const headings = [...readFileSync(file, 'utf8').matchAll(/^##\s+(.+)$/gm)]
      .map(match => match[1].trim());
    let cursor = 0;
    for (const heading of required) {
      const index = headings.indexOf(heading, cursor);
      if (index === -1) errors.push(`${rel(file)}: 缺少或顺序错误: ## ${heading}`);
      else cursor = index + 1;
    }
    for (const heading of headings) {
      if (!allowed.has(heading)) errors.push(`${rel(file)}: 未允许的 H2: ## ${heading}`);
    }
  }
}

// Specs carry a small front matter so the ledger can be checked.
const specDir = join(docsRoot, 'spec');
if (existsSync(specDir)) {
  for (const name of readdirSync(specDir)) {
    if (!name.endsWith('.md') || name === 'README.md') continue;
    const file = join(specDir, name);
    const text = readFileSync(file, 'utf8');
    const block = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!block) {
      errors.push(`${rel(file)}: 缺少 front matter`);
      continue;
    }
    const fields = {};
    for (const line of block[1].split('\n')) {
      const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (pair) fields[pair[1]] = pair[2].trim();
    }
    for (const key of ['status', 'exit', 'evidence']) {
      if (!fields[key]) errors.push(`${rel(file)}: front matter 缺少 ${key}`);
    }
    if (fields.status && !['draft', 'active', 'blocked', 'done'].includes(fields.status)) {
      errors.push(`${rel(file)}: status 非法: ${fields.status}`);
    }
  }
}

// ADR numbering is sequential; ADRs are superseded, not deleted.
const adrDir = join(docsRoot, 'adr');
if (existsSync(adrDir)) {
  const numbers = readdirSync(adrDir)
    .filter(name => /^\d{4}-.+\.md$/.test(name))
    .map(name => Number(name.slice(0, 4)))
    .sort((a, b) => a - b);
  for (let index = 0; index < numbers.length; index += 1) {
    if (numbers[index] !== index + 1) {
      errors.push(`docs/adr: 编号不连续，期望 ${String(index + 1).padStart(4, '0')}，实际 ${String(numbers[index]).padStart(4, '0')}`);
      break;
    }
  }
}

// Architecture-code references should not rot.
const architecture = join(docsRoot, 'architecture.md');
if (existsSync(architecture)) {
  const text = readFileSync(architecture, 'utf8');
  for (const match of text.matchAll(/`((?:src|test|scripts|docs)\/[^`]+)`/g)) {
    const path = match[1].replace(/[.,;:)]+$/, '');
    if (/[<>*]/.test(path) || path.startsWith('planned:')) continue;
    if (!existsSync(join(root, path))) {
      errors.push(`docs/architecture.md: 路径不存在: ${path}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`文档检查失败（${errors.length} 项）：`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`文档检查通过：${docsFiles.length} 个文档，${linkCount} 个相对链接。`);

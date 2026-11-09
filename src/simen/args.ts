/**
 * Reads an official `chrome-devtools` command line just enough for 司门's rules (ADR 0023): which tool it calls, which
 * page it targets, and which arguments are file paths. The official command table (`config/cli-options.js` of the
 * pinned chrome-devtools-mcp package) says which arguments are positional and which are flags, so this follows the same
 * rules as the official command line: required arguments by position, optional ones as `--name value`.
 */
import { isAbsolute, resolve } from 'node:path';

export type ArgSpec = { name?: string; type?: string; positional?: boolean };
export type CommandTable = Record<string, { args: Record<string, ArgSpec> }>;
export type Parsed = {
  /** The tool name, or undefined for `--help`, `--version` or an empty line. */
  command?: string;
  pageId?: number;
  /** The same command line with relative file paths made absolute against the caller's directory. */
  argv: string[];
  /** Flags 司门 does not allow, such as the official `--sessionId` that would start a second daemon. */
  forbidden: string[];
};

/** Flags of the official command line itself, not of a tool. */
const GLOBAL_VALUE_FLAGS = new Set(['outputFormat', 'sessionId']);
const GLOBAL_BARE_FLAGS = new Set(['help', 'version', 'h']);
const FORBIDDEN_FLAGS = new Set(['sessionId']);
const isPathArg = (name: string) => /path/i.test(name);
const camel = (name: string) => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

export function parseCommand(argv: string[], table: CommandTable, cwd: string): Parsed {
  const out = [...argv];
  const forbidden: string[] = [];
  const first = argv[0];
  if (first === undefined || first.startsWith('-')) {
    for (const token of argv) if (token.startsWith('--') && FORBIDDEN_FLAGS.has(camel(token.slice(2).split('=')[0]!))) forbidden.push(token.split('=')[0]!);
    return { argv: out, forbidden };
  }
  const spec = table[first]?.args ?? {};
  const positionalNames = Object.entries(spec).filter(([, arg]) => arg.positional).map(([name]) => name);
  const absolute = (value: string) => (value === '' || isAbsolute(value) ? value : resolve(cwd, value));
  let positionalIndex = 0;
  let pageId: number | undefined;
  const take = (name: string, value: string, index: number) => {
    if (name === 'pageId') { const number = Number(value); if (Number.isInteger(number)) pageId = number; }
    if (isPathArg(name)) out[index] = absolute(value);
  };
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === '--') {
      for (let rest = index + 1; rest < argv.length; rest++) { const name = positionalNames[positionalIndex]; if (name && spec[name]?.type !== 'array') positionalIndex++; if (name) take(name, argv[rest]!, rest); }
      break;
    }
    if (token.startsWith('--')) {
      const [rawName, inline] = splitOnce(token.slice(2));
      const name = camel(rawName);
      if (FORBIDDEN_FLAGS.has(name)) forbidden.push(`--${rawName}`);
      if (GLOBAL_BARE_FLAGS.has(name)) continue;
      if (inline !== undefined) {
        if (isPathArg(name)) out[index] = `--${rawName}=${absolute(inline)}`;
        else take(name, inline, -1);
        continue;
      }
      const type = spec[name]?.type;
      const next = argv[index + 1];
      if (type === 'boolean') { if (next === 'true' || next === 'false') index++; continue; }
      if (next === undefined) continue;
      if (spec[name] || GLOBAL_VALUE_FLAGS.has(name) || !next.startsWith('--')) { index++; take(name, next, index); }
      continue;
    }
    if (token.startsWith('-') && token.length === 2) continue;
    // An array argument, such as upload_file's paths, takes every remaining positional value.
    const name = positionalNames[positionalIndex];
    if (name && spec[name]?.type !== 'array') positionalIndex++;
    if (name) take(name, token, index);
  }
  return { command: first, ...(pageId !== undefined ? { pageId } : {}), argv: out, forbidden };
}

function splitOnce(value: string): [string, string | undefined] {
  const at = value.indexOf('=');
  return at < 0 ? [value, undefined] : [value.slice(0, at), value.slice(at + 1)];
}

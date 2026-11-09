/**
 * The real browser and the real official command line for 司门's host (ADR 0023), and the host's entry point. Only Node
 * built-ins are used: this file runs from the mounted dist/simen directory inside the browser container.
 *
 * The browser keeps one persistent profile. Before each start the host clears a lock a killed browser may have left
 * (it names the old container's hostname and makes Chromium refuse the profile) and turns on "continue where you left
 * off", which keeps session cookies across restarts. The official daemon finds the browser through its config file, so
 * even when it starts by itself it connects to this browser and never launches its own.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { CommandTable } from './args.ts';
import { createHost, type Browser, type Official, type Run } from './host.ts';
import { DEFAULT_RULES, Windows } from './windows.ts';

const OUTPUT_LIMIT = 16 * 1024 * 1024;
const RUN_TIMEOUT_MS = 150_000;

export type BrowserSettings = { executable: string; profile: string; port: number; cacheBytes: number };

export function chromiumBrowser(settings: BrowserSettings, log: (event: Record<string, unknown>) => void): Browser {
  let child: ChildProcess | undefined;
  let version: string | undefined;
  let stopping = false;
  const listeners: (() => void)[] = [];
  const endpoint = `http://127.0.0.1:${settings.port}/json/version`;
  function prepareProfile() {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) rmSync(join(settings.profile, name), { force: true });
    const directory = join(settings.profile, 'Default');
    const file = join(directory, 'Preferences');
    mkdirSync(directory, { recursive: true });
    let value: Record<string, unknown> = {};
    try { value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { /* first start or unreadable: Chromium rewrites it */ }
    const session = (value.session && typeof value.session === 'object' ? value.session : {}) as Record<string, unknown>;
    if (session.restore_on_startup !== 1) { value.session = { ...session, restore_on_startup: 1 }; writeFileSync(file, JSON.stringify(value)); }
  }
  return {
    running: () => child !== undefined && child.exitCode === null,
    version: () => version,
    onExit(listener) { listeners.push(listener); },
    async start() {
      prepareProfile();
      stopping = false;
      const proc = spawn(settings.executable, ['--headless=new', `--remote-debugging-port=${settings.port}`, '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${settings.profile}`, '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-gpu',
        '--lang=zh-CN', '--window-size=1280,900', `--disk-cache-size=${settings.cacheBytes}`, 'about:blank'], { stdio: 'ignore' });
      child = proc;
      proc.once('exit', code => {
        if (child === proc) child = undefined;
        if (!stopping) { log({ simen: 'browser_exit', code }); for (const listener of listeners) listener(); }
      });
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          const response = await fetch(endpoint, { signal: AbortSignal.timeout(1000) });
          if (response.ok) { version = String(((await response.json()) as { Browser?: string }).Browser ?? ''); return; }
        } catch { /* not listening yet */ }
        if (proc.exitCode !== null) throw new Error(`浏览器启动失败（退出码 ${proc.exitCode}）`);
        if (Date.now() > deadline) { proc.kill('SIGKILL'); throw new Error('浏览器 20 秒内没有启动'); }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    },
    async stop() {
      const proc = child;
      if (!proc || proc.exitCode !== null) return;
      stopping = true;
      const exited = new Promise(resolve => proc.once('exit', resolve));
      proc.kill('SIGTERM');
      const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/**
 * `directory` is the pinned chrome-devtools-mcp package. `commandTable` is its command table exported as JSON when the
 * browser image is built, so the host reads data, not code, to learn which arguments are pages and paths.
 */
export type OfficialSettings = { directory: string; commandTable: string; browserPort: number; runtimeDir: string; configDir: string; home: string };

/** The pinned chrome-devtools-mcp package: its command line, its command table and its daemon's socket. */
export function officialCommandLine(settings: OfficialSettings): Official {
  const bin = join(settings.directory, 'build/src/bin/chrome-devtools.js');
  const commands = JSON.parse(readFileSync(settings.commandTable, 'utf8')) as CommandTable;
  if (!commands || typeof commands !== 'object' || !commands.new_page || !commands.close_page) throw new Error('SIMEN_COMMAND_TABLE 不是官方命令表');
  const version = (JSON.parse(readFileSync(join(settings.directory, 'package.json'), 'utf8')) as { version: string }).version;
  const configFile = join(settings.configDir, 'cd4a', 'config.json');
  mkdirSync(join(settings.configDir, 'cd4a'), { recursive: true });
  mkdirSync(settings.runtimeDir, { recursive: true });
  mkdirSync(settings.home, { recursive: true });
  writeFileSync(configFile, `${JSON.stringify({ browserUrl: `http://127.0.0.1:${settings.browserPort}`, usageStatistics: false, performanceCrux: false })}\n`);
  const socket = join(settings.runtimeDir, 'chrome-devtools-mcp', 'server.sock');
  const environment = (tmpdir: string) => ({
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: settings.home, TZ: process.env.TZ ?? 'UTC', LANG: 'C.UTF-8',
    XDG_RUNTIME_DIR: settings.runtimeDir, XDG_CONFIG_HOME: settings.configDir, TMPDIR: tmpdir, CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
  });
  function run(argv: string[], options: { cwd: string; tmpdir: string }): Promise<Run> {
    return new Promise(resolve => {
      const child = spawn(process.execPath, [bin, ...argv], { cwd: options.cwd, env: environment(options.tmpdir), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk; });
      child.stderr.on('data', chunk => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
      child.on('error', error => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: `${stderr}${String(error)}\n` }); });
      child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    });
  }
  /** One command to the official daemon over its socket, framed like puppeteer's PipeTransport. */
  function invoke(tool: string, args: Record<string, unknown>): Promise<{ structuredContent?: unknown }> {
    return new Promise((resolve, reject) => {
      const connection = createConnection({ path: socket });
      let buffer = '';
      const timer = setTimeout(() => { connection.destroy(); reject(new Error('timeout')); }, 30_000);
      connection.on('data', chunk => {
        buffer += chunk;
        const at = buffer.indexOf('\0');
        if (at < 0) return;
        clearTimeout(timer); connection.end();
        try {
          const reply = JSON.parse(buffer.slice(0, at)) as { success: boolean; result?: string; error?: string };
          if (!reply.success) return reject(new Error(reply.error ?? 'failed'));
          resolve(JSON.parse(reply.result ?? '{}') as { structuredContent?: unknown });
        } catch (error) { reject(error); }
      });
      connection.on('error', error => { clearTimeout(timer); reject(error); });
      connection.write(`${JSON.stringify({ method: 'invoke_tool', tool, args })}\0`);
    });
  }
  async function ensureDaemon(tmpdir: string) {
    if (existsSync(socket)) return;
    // Any command starts the daemon from the config file, connected to this browser.
    await run(['list_pages'], { cwd: settings.home, tmpdir });
  }
  return {
    version, table: commands, run,
    async pages() {
      await ensureDaemon(settings.home);
      const result = await invoke('list_pages', {});
      const pages = (result.structuredContent as { pages?: { id: number; url: string }[] } | undefined)?.pages;
      if (!Array.isArray(pages)) throw new Error('list_pages 没有返回页面清单');
      return pages.map(page => ({ id: page.id, url: page.url }));
    },
    async close(pageId) { await ensureDaemon(settings.home); await invoke('close_page', { pageId }); },
    async blank(pageId) { await ensureDaemon(settings.home); await invoke('navigate_page', { pageId, type: 'url', url: 'about:blank' }); },
    async stop() { if (existsSync(socket)) await run(['stop'], { cwd: settings.home, tmpdir: settings.home }); },
  };
}

/** Memory charged to this container, from its cgroup. */
export function containerMemory(): number | undefined {
  try { return Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim()); } catch { return undefined; }
}

/** Starts the host from environment settings. Exits the process on a configuration error. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
  const number = (name: string, fallback: number) => { const value = Number(env[name] ?? fallback); if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 无效`); return value; };
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error(`缺少 ${name}`); return value; };
  const tokenFile = required('SIMEN_TOKEN_FILE');
  const token = readFileSync(tokenFile, 'utf8').trim();
  if (!/^[A-Za-z0-9._~+/=-]{24,512}$/.test(token)) throw new Error('SIMEN_TOKEN_FILE 里的令牌格式不对');
  const browserPort = number('SIMEN_BROWSER_PORT', 9222);
  const state = env.SIMEN_STATE_DIR ?? '/run/simen';
  const versionFile = join(import.meta.dirname, 'version.json');
  const build = existsSync(versionFile) ? JSON.parse(readFileSync(versionFile, 'utf8')) as { version: string; revision?: string } : { version: 'development' };
  const official = officialCommandLine({ directory: required('SIMEN_OFFICIAL_DIR'), commandTable: required('SIMEN_COMMAND_TABLE'), browserPort, runtimeDir: join(state, 'runtime'), configDir: join(state, 'config'), home: join(state, 'home') });
  const browser = chromiumBrowser({ executable: env.SIMEN_CHROMIUM ?? '/usr/bin/chromium', profile: required('SIMEN_PROFILE_DIR'), port: browserPort, cacheBytes: number('SIMEN_CACHE_BYTES', 100 * 1024 * 1024) }, log);
  const windows = new Windows({ windows: number('SIMEN_WINDOWS', DEFAULT_RULES.windows), idleMs: number('SIMEN_IDLE_MS', DEFAULT_RULES.idleMs), waitMs: number('SIMEN_WAIT_MS', DEFAULT_RULES.waitMs) });
  const host = createHost({ token, version: build.version, ...(build.revision ? { revision: build.revision } : {}), windows, browser, official, tmpRoot: required('SIMEN_TMP_DIR'), memory: containerMemory, log });
  const port = number('SIMEN_PORT', 3200);
  await host.listen(port, env.SIMEN_LISTEN ?? '127.0.0.1');
  setInterval(() => { void host.sweep().catch(error => log({ simen: 'sweep_failed', error: String(error) })); }, 15_000).unref();
  log({ simen: 'host_ready', port, official: official.version, windows: windows.rules.windows });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void (async () => { await official.stop().catch(() => {}); await browser.stop().catch(() => {}); process.exit(0); })(); });
}

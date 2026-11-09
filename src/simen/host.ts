/**
 * 司门's host (ADR 0023): it sits beside the instance's one browser and between agents and the official Chrome DevTools
 * command line. It hands out windows by the rules in windows.ts, starts the browser and the official daemon only when a
 * window is needed, stops both when the last window is gone, and otherwise passes each command to the official command
 * line unchanged. Each conversation gets its own temporary directory, removed when its window is taken back.
 *
 * The browser and the official command line are injected so the rules can be tested without either.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { parseCommand, type CommandTable } from './args.ts';
import { EXIT, LONG_POLL_MS, PROTOCOL_HEADER, SIMEN_PROTOCOL, type HostStatus, type RunRequest, type RunResponse } from './protocol.ts';
import { Windows } from './windows.ts';

export type Browser = {
  running(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  version(): string | undefined;
  /** Called once each time the browser exits on its own. */
  onExit(listener: () => void): void;
};
export type Run = { code: number; stdout: string; stderr: string };
export type Official = {
  version: string;
  table: CommandTable;
  run(argv: string[], options: { cwd: string; tmpdir: string }): Promise<Run>;
  /** Open pages, starting the official daemon if needed. */
  pages(): Promise<{ id: number; url: string }[]>;
  close(pageId: number): Promise<void>;
  /** Shows a blank page in this page. */
  blank(pageId: number): Promise<void>;
  /** Stops the official daemon; it holds memory even after the browser is gone. */
  stop(): Promise<void>;
};
export type HostOptions = {
  token: string; version: string; revision?: string;
  windows: Windows; browser: Browser; official: Official;
  /** Per-conversation temporary directories live here; the same path is visible to the agents. */
  tmpRoot: string;
  now?: () => number;
  memory?: () => number | undefined;
  log?: (event: Record<string, unknown>) => void;
  /** How long one request may wait for a window; tests use 0. */
  longPollMs?: number;
};

/** Commands that manage the official daemon itself; 司门 manages it. */
const MANAGED = new Set(['start', 'stop', 'status']);
const say = (text: string) => `司门：${text}\n`;
const refused = (text: string, code: number = EXIT.refused): RunResponse => ({ kind: 'result', code, stdout: '', stderr: say(text) });
/** A short, log-safe form of a conversation id. */
const short = (session: string) => session.replace(/^session-/, '').slice(0, 8);

export function createHost(options: HostOptions) {
  const { windows, browser, official } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const expected = createHash('sha256').update(options.token).digest();
  /** Why a conversation's window went away, so its next command can say so. */
  const released = new Map<string, { pageId?: number; reason: 'idle' | 'browser' }>();
  const remember = (session: string, value: { pageId?: number; reason: 'idle' | 'browser' }) => { released.delete(session); released.set(session, value); if (released.size > 200) released.delete(released.keys().next().value!); };
  let since: number | undefined;
  let lock: Promise<unknown> = Promise.resolve();
  /** Runs one change of windows, pages or the browser at a time. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = lock.then(work, work); lock = next.catch(() => {}); return next; };

  const tmpOf = (session: string | undefined) => join(options.tmpRoot, session ? session.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96) : '_shared');
  const removeTmp = (session: string | undefined) => { try { rmSync(tmpOf(session), { recursive: true, force: true }); } catch (error) { log({ simen: 'tmp_remove_failed', error: String(error) }); } };

  browser.onExit(() => {
    // The browser went away on its own: every window and page went with it.
    for (const holder of windows.holders()) { windows.release(holder.session); remember(holder.session, { ...(holder.pageId !== undefined ? { pageId: holder.pageId } : {}), reason: 'browser' }); removeTmp(holder.session); }
    removeTmp(undefined);
    since = undefined;
    log({ simen: 'browser_exited' });
    void official.stop().catch(() => {});
  });

  async function ensureBrowser(): Promise<void> {
    if (browser.running()) return;
    await browser.start();
    since = now();
    // "Continue where you left off" keeps session cookies but also reopens the last tabs, which belonged to earlier
    // conversations: close all but the first and blank that one, so no conversation sees another's last page.
    const pages = await official.pages();
    for (const page of pages.slice(1)) await official.close(page.id).catch(() => {});
    if (pages[0] && pages[0].url !== 'about:blank') await official.blank(pages[0].id).catch(error => log({ simen: 'blank_failed', error: String(error) }));
    log({ simen: 'browser_started', version: browser.version() });
  }

  async function shutdownIfEmpty(): Promise<void> {
    if (windows.holders().length > 0 || !browser.running()) return;
    await official.stop().catch(error => log({ simen: 'daemon_stop_failed', error: String(error) }));
    await browser.stop();
    since = undefined;
    removeTmp(undefined);
    log({ simen: 'browser_stopped' });
  }

  async function takeBack(session: string, reason: 'idle'): Promise<void> {
    const holder = windows.release(session);
    if (!holder) return;
    if (holder.pageId !== undefined && browser.running()) await official.close(holder.pageId).catch(() => {});
    remember(session, { ...(holder.pageId !== undefined ? { pageId: holder.pageId } : {}), reason });
    removeTmp(session);
    log({ simen: 'window_reclaimed', session: short(session), reason });
  }

  /** Takes back idle windows and stops the browser when none is left. */
  async function sweep(): Promise<void> {
    await serial(async () => {
      for (const holder of windows.idle(now())) await takeBack(holder.session, 'idle');
      await shutdownIfEmpty();
    });
  }

  async function forward(argv: string[], cwd: string, session: string | undefined): Promise<RunResponse> {
    const tmpdir = tmpOf(session);
    mkdirSync(tmpdir, { recursive: true });
    const result = await official.run(argv, { cwd: existsSync(cwd) ? cwd : tmpdir, tmpdir });
    return { kind: 'result', ...result };
  }

  async function newPage(session: string, argv: string[], cwd: string): Promise<RunResponse> {
    return serial(async () => {
      await ensureBrowser();
      const before = new Set((await official.pages()).map(page => page.id));
      const result = await forward(argv, cwd, session);
      if (result.kind === 'result' && result.code === 0) {
        const opened = (await official.pages()).filter(page => !before.has(page.id)).map(page => page.id);
        windows.setPage(session, opened.length ? Math.max(...opened) : undefined);
        released.delete(session);
        log({ simen: 'window_opened', session: short(session), pageId: opened.at(-1) });
      } else if (windows.holder(session)?.pageId === undefined) {
        windows.release(session);
        removeTmp(session);
        await shutdownIfEmpty();
      }
      return result;
    });
  }

  async function run(request: RunRequest): Promise<RunResponse> {
    const parsed = parseCommand(request.argv, official.table, request.cwd);
    if (parsed.forbidden.length) return refused(`不支持 ${parsed.forbidden.join('、')}：浏览器由司门统一管理，一个实例只有一个。`);
    const session = request.session;
    const command = parsed.command;
    if (!command || !official.table[command]) {
      if (command && MANAGED.has(command)) return refused('浏览器和后台进程由司门管理，不需要 start、stop 或 status。看状态用 chrome-devtools doctor。');
      // Help, version and unknown commands: the official command line explains them itself.
      return forward(parsed.argv, request.cwd, session);
    }
    const holder = session ? windows.holder(session) : undefined;
    if (command === 'new_page') {
      if (!session) return refused('new_page 只能在 DSH 对话里用（需要 DSH_SESSION_ID），司门靠它分配窗口。');
      if (holder?.pageId !== undefined && browser.running()) {
        const alive = (await official.pages()).some(page => page.id === holder.pageId);
        if (alive) return refused(`这段对话已经有窗口了（页面 ${holder.pageId}）。一段对话只占一个窗口，请继续用它，例如 chrome-devtools navigate_page ${holder.pageId} --url <网址>；用完可以 close_page ${holder.pageId}。`);
      }
      const ask = windows.ask(session, now());
      if (!ask.granted) {
        if (windows.waitedTooLong(ask, now())) { windows.leaveQueue(session); return refused(`等了 ${windows.rules.waitMs / 60_000} 分钟，${windows.rules.windows} 个窗口仍然都在用。请稍后再试。`, EXIT.waitedTooLong); }
        return { kind: 'wait', ahead: ask.ahead, waitedMs: now() - ask.waitingSince, limitMs: windows.rules.waitMs };
      }
      return newPage(session, parsed.argv, request.cwd);
    }
    if (!browser.running()) {
      const gone = session ? released.get(session) : undefined;
      if (gone) return refused(gone.reason === 'idle' ? `窗口闲置 ${windows.rules.idleMs / 60_000} 分钟，已经收回。请重新 new_page。` : '浏览器重启过，窗口已经收回。请重新 new_page。');
      return refused('浏览器现在没开（没有窗口在用）。先用 chrome-devtools new_page <网址> 开一个窗口。');
    }
    if (parsed.pageId !== undefined) {
      const owner = windows.ownerOf(parsed.pageId);
      if (owner && owner !== session) return refused(`页面 ${parsed.pageId} 属于另一段对话。${holder?.pageId !== undefined ? `你的窗口是页面 ${holder.pageId}。` : '先用 new_page 开自己的窗口。'}`);
      if (!owner) {
        const gone = session ? released.get(session) : undefined;
        if (gone?.pageId === parsed.pageId) return refused(gone.reason === 'idle' ? `页面 ${parsed.pageId} 闲置 ${windows.rules.idleMs / 60_000} 分钟，已经收回。请重新 new_page。` : `浏览器重启过，页面 ${parsed.pageId} 已经没了。请重新 new_page。`);
        // Pages nobody owns, such as a pop-up a page opened, belong to whoever holds a window.
        if (!holder) return refused(`页面 ${parsed.pageId} 不属于这段对话。先用 new_page 开自己的窗口。`);
      }
    }
    if (session && holder) windows.touch(session, now());
    const result = await forward(parsed.argv, request.cwd, session);
    if (command === 'close_page' && session && holder && parsed.pageId === holder.pageId && result.kind === 'result' && result.code === 0) {
      await serial(async () => { windows.release(session); removeTmp(session); log({ simen: 'window_closed', session: short(session) }); await shutdownIfEmpty(); });
    }
    return result;
  }

  /** Asks for a window for up to the long-poll time, so a waiter keeps its place without busy requests. */
  async function runWithWait(request: RunRequest): Promise<RunResponse> {
    const deadline = now() + (options.longPollMs ?? LONG_POLL_MS);
    for (;;) {
      const response = await run(request);
      if (response.kind !== 'wait' || now() >= deadline) return response;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  function status(): HostStatus {
    const memory = options.memory?.();
    return {
      protocol: SIMEN_PROTOCOL, version: options.version, ...(options.revision ? { revision: options.revision } : {}), official: official.version,
      browser: { running: browser.running(), ...(browser.version() ? { version: browser.version() } : {}), ...(since !== undefined ? { since: new Date(since).toISOString() } : {}) },
      windows: { limit: windows.rules.windows, held: windows.holders().map(holder => ({ session: short(holder.session), ...(holder.pageId !== undefined ? { pageId: holder.pageId } : {}), idleSeconds: Math.round((now() - holder.lastUsed) / 1000) })) },
      waiting: windows.waiting(), idleMinutes: windows.rules.idleMs / 60_000, waitMinutes: windows.rules.waitMs / 60_000,
      ...(memory !== undefined ? { memoryBytes: memory } : {}),
    };
  }

  const authorized = (header: string | undefined) => {
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{24,512})$/.exec(header ?? '');
    return !!match && timingSafeEqual(createHash('sha256').update(match[1]!).digest(), expected);
  };
  const send = (response: ServerResponse, code: number, body: unknown) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Agents are not browsers; a web page on this machine must not reach the host.
    if (request.headers.origin !== undefined) return send(response, 403, { error: 'forbidden' });
    if (!authorized(request.headers.authorization)) return send(response, 401, { error: 'unauthorized' });
    if (request.method === 'GET' && request.url === '/simen/v1/status') return send(response, 200, status());
    if (request.method !== 'POST' || request.url !== '/simen/v1/run') return send(response, 404, { error: 'not_found' });
    if (request.headers[PROTOCOL_HEADER] !== String(SIMEN_PROTOCOL)) return send(response, 409, { error: 'protocol_mismatch', message: '命令行和司门的版本不一致，请更新 chrome-devtools（司门）。' });
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 256 * 1024) return send(response, 413, { error: 'too_large' }); }
    let value: RunRequest;
    try { value = validate(JSON.parse(body)); } catch { return send(response, 400, { error: 'invalid_request' }); }
    try { send(response, 200, await runWithWait(value)); }
    catch (error) { log({ simen: 'run_failed', error: String(error) }); send(response, 200, refused(`浏览器服务出错：${String(error instanceof Error ? error.message : error).slice(0, 300)}`, EXIT.unavailable)); }
  }

  return {
    run: runWithWait, sweep, status,
    listen(port: number, host = '127.0.0.1'): Promise<Server> {
      const server = createServer((request, response) => { void handle(request, response).catch(() => { if (!response.headersSent) send(response, 500, { error: 'internal' }); }); });
      return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server)); });
    },
  };
}

function validate(value: unknown): RunRequest {
  if (!value || typeof value !== 'object') throw new Error('invalid');
  const { session, cwd, argv } = value as Record<string, unknown>;
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > 4096) throw new Error('invalid');
  if (!Array.isArray(argv) || argv.length > 200 || !argv.every(item => typeof item === 'string' && item.length <= 64 * 1024)) throw new Error('invalid');
  if (session !== undefined && (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(session))) throw new Error('invalid');
  return { cwd, argv: argv as string[], ...(session ? { session } : {}) };
}

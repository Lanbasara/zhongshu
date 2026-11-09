import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { main } from '../src/simen/cli.ts';
import { createHost, type Browser, type Official } from '../src/simen/host.ts';
import type { CommandTable } from '../src/simen/args.ts';
import { Windows } from '../src/simen/windows.ts';

const TOKEN = 'simen-test-token-0123456789abcdef';
const MIN = 60_000;
const table: CommandTable = {
  new_page: { args: { url: { type: 'string', positional: true } } },
  navigate_page: { args: { pageId: { type: 'number', positional: true }, url: { type: 'string' } } },
  take_snapshot: { args: { pageId: { type: 'number', positional: true } } },
  take_screenshot: { args: { pageId: { type: 'number', positional: true }, filePath: { type: 'string' } } },
  close_page: { args: { pageId: { type: 'number', positional: true } } },
  list_pages: { args: {} },
};

function fixture(t: TestContext, rules: ConstructorParameters<typeof Windows>[0] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'simen-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = 0;
  let running = false;
  const exits: (() => void)[] = [];
  const events: string[] = [];
  const browser: Browser = {
    running: () => running, version: () => (running ? 'Chrome/156' : undefined),
    async start() { running = true; events.push('browser:start'); },
    async stop() { running = false; events.push('browser:stop'); },
    onExit(listener) { exits.push(listener); },
  };
  let next = 2;
  let pages = [{ id: 1, url: 'about:blank' }];
  const runs: { argv: string[]; cwd: string; tmpdir: string }[] = [];
  const official: Official = {
    version: '1.12.0', table,
    async run(argv, options) {
      runs.push({ argv, ...options });
      if (argv[0] === 'new_page' && argv[1] === 'fail') return { code: 1, stdout: '', stderr: 'Error: navigation failed\n' };
      if (argv[0] === 'new_page') { pages.push({ id: next++, url: argv[1]! }); return { code: 0, stdout: `## Pages\n${pages.map(page => `${page.id}: ${page.url}`).join('\n')}\n`, stderr: '' }; }
      if (argv[0] === 'close_page') { pages = pages.filter(page => page.id !== Number(argv[1])); return { code: 0, stdout: 'closed\n', stderr: '' }; }
      if (argv[0] === 'fail') return { code: 1, stdout: '', stderr: 'Error: boom\n' };
      return { code: 0, stdout: `ran ${argv.join(' ')}\n`, stderr: '' };
    },
    async pages() { return pages.map(page => ({ ...page })); },
    async close(pageId) { pages = pages.filter(page => page.id !== pageId); events.push(`close:${pageId}`); },
    async blank(pageId) { pages = pages.map(page => (page.id === pageId ? { ...page, url: 'about:blank' } : page)); events.push(`blank:${pageId}`); },
    async stop() { events.push('daemon:stop'); },
  };
  const windows = new Windows({ windows: 2, idleMs: 5 * MIN, waitMs: 5 * MIN, ...rules });
  const tmpRoot = join(root, 'tmp');
  const host = createHost({ token: TOKEN, version: '0.1.1', revision: 'a'.repeat(40), windows, browser, official, tmpRoot, now: () => clock, longPollMs: 0 });
  const run = (session: string | undefined, argv: string[], cwd = root) => host.run({ cwd, argv, ...(session ? { session } : {}) });
  return { root, tmpRoot, host, run, runs, events, windows, advance: (ms: number) => { clock += ms; }, crash: () => { running = false; for (const listener of exits) listener(); }, pages: () => pages, running: () => running, restore: (urls: string[]) => { pages = urls.map(url => ({ id: next++, url })); } };
}

const text = (response: Awaited<ReturnType<ReturnType<typeof fixture>['run']>>) => (response.kind === 'result' ? `${response.code}|${response.stdout}${response.stderr}` : `wait:${response.ahead}`);

test('the browser starts on the first window; two conversations get one window each; the third waits', async t => {
  const f = fixture(t);
  assert.match(text(await f.run('session-a', ['list_pages'])), /^2\|.*浏览器现在没开/s, 'nothing starts the browser but new_page');
  assert.match(text(await f.run('session-a', ['new_page', 'https://a.example'])), /^0\|/);
  assert.deepEqual(f.events, ['browser:start']);
  assert.equal(f.windows.holder('session-a')?.pageId, 2);
  assert.match(text(await f.run('session-b', ['new_page', 'https://b.example'])), /^0\|/);
  assert.equal(f.windows.holder('session-b')?.pageId, 3);
  assert.equal(text(await f.run('session-c', ['new_page', 'https://c.example'])), 'wait:0');
  // One window per conversation: a second new_page is refused with the page to keep using.
  assert.match(text(await f.run('session-a', ['new_page', 'https://a2.example'])), /^2\|.*已经有窗口了（页面 2）.*navigate_page 2/s);
  assert.equal(f.pages().length, 3);
});

test('a conversation may use only its own page; pages nobody owns need a window', async t => {
  const f = fixture(t);
  await f.run('session-a', ['new_page', 'https://a.example']);
  await f.run('session-b', ['new_page', 'https://b.example']);
  assert.match(text(await f.run('session-a', ['take_snapshot', '2'])), /^0\|ran take_snapshot 2/);
  assert.match(text(await f.run('session-a', ['take_snapshot', '3'])), /^2\|.*页面 3 属于另一段对话.*你的窗口是页面 2/s);
  // Page 1 is the browser's blank start page: usable by a window holder, not by someone without a window.
  assert.match(text(await f.run('session-a', ['take_snapshot', '1'])), /^0\|/);
  assert.match(text(await f.run('session-x', ['take_snapshot', '1'])), /^2\|.*先用 new_page/s);
  assert.match(text(await f.run('session-x', ['list_pages'])), /^0\|ran list_pages/, 'reading the page list needs no window');
});

test('closing your page frees the window for the next in line; the last window stops the browser and the daemon', async t => {
  const f = fixture(t, { windows: 1 });
  await f.run('session-a', ['new_page', 'https://a.example']);
  assert.equal(text(await f.run('session-b', ['new_page', 'https://b.example'])), 'wait:0');
  assert.match(text(await f.run('session-a', ['close_page', '2'])), /^0\|closed/);
  assert.equal(f.windows.holder('session-a'), undefined);
  assert.deepEqual(f.events.slice(-2), ['daemon:stop', 'browser:stop'], 'nobody held a window, so everything stopped');
  assert.match(text(await f.run('session-b', ['new_page', 'https://b.example'])), /^0\|/);
  assert.equal(f.running(), true);
});

test('a window idle for 5 minutes is taken back with its temporary files; the browser stops when none is left', async t => {
  const f = fixture(t);
  await f.run('session-a', ['new_page', 'https://a.example']);
  await f.run('session-b', ['new_page', 'https://b.example']);
  await f.run('session-a', ['take_screenshot', '2']);
  const tmpA = f.runs.at(-1)!.tmpdir;
  assert.equal(existsSync(tmpA), true);
  f.advance(4 * MIN);
  await f.run('session-b', ['take_snapshot', '3']);
  f.advance(MIN);
  await f.host.sweep();
  assert.equal(f.windows.holder('session-a'), undefined, 'a was idle for 5 minutes');
  assert.equal(f.windows.holder('session-b')?.pageId, 3, 'b was used a minute ago');
  assert.equal(existsSync(tmpA), false);
  assert.ok(f.events.includes('close:2'));
  assert.match(text(await f.run('session-a', ['take_snapshot', '2'])), /^2\|.*闲置 5 分钟，已经收回.*new_page/s);
  f.advance(5 * MIN);
  await f.host.sweep();
  assert.deepEqual(f.events.slice(-2), ['daemon:stop', 'browser:stop']);
  assert.match(text(await f.run('session-b', ['take_snapshot', '3'])), /^2\|.*闲置 5 分钟，已经收回/s);
});

test('waiting is first come, first served and gives up after 5 minutes', async t => {
  const f = fixture(t, { windows: 1 });
  await f.run('session-a', ['new_page', 'https://a.example']);
  assert.equal(text(await f.run('session-b', ['new_page', 'https://b.example'])), 'wait:0');
  assert.equal(text(await f.run('session-c', ['new_page', 'https://c.example'])), 'wait:1');
  for (let at = 20_000; at < 5 * MIN; at += 20_000) { f.advance(20_000); await f.run('session-a', ['take_snapshot', '2']); assert.equal(text(await f.run('session-b', ['new_page', 'https://b.example'])), 'wait:0'); }
  f.advance(20_000);
  assert.match(text(await f.run('session-b', ['new_page', 'https://b.example'])), /^4\|.*等了 5 分钟/s);
  assert.equal(f.windows.waiting(), 0, 'b left the queue; c stopped asking and was dropped');
});

test('relative file paths are resolved against the agent\'s directory; each conversation has its own temporary directory', async t => {
  const f = fixture(t);
  const workspace = join(f.root, 'workspace');
  mkdirSync(workspace);
  await f.run('session-a', ['new_page', 'https://a.example'], workspace);
  await f.run('session-a', ['take_screenshot', '2', '--filePath', 'shots/a.png'], workspace);
  const last = f.runs.at(-1)!;
  assert.deepEqual(last.argv, ['take_screenshot', '2', '--filePath', join(workspace, 'shots/a.png')]);
  assert.equal(last.cwd, workspace);
  assert.equal(last.tmpdir, join(f.tmpRoot, 'session-a'));
  // A directory the browser cannot see falls back to the conversation's temporary directory.
  await f.run('session-a', ['take_snapshot', '2'], '/nonexistent/dir');
  assert.equal(f.runs.at(-1)!.cwd, join(f.tmpRoot, 'session-a'));
});

test('the daemon and the browser are 司门\'s: start, stop, status and --sessionId are refused; new_page needs a conversation', async t => {
  const f = fixture(t);
  for (const command of ['start', 'stop', 'status']) assert.match(text(await f.run('session-a', [command])), /^2\|.*由司门管理/s);
  assert.match(text(await f.run('session-a', ['list_pages', '--sessionId', 'ab12'])), /^2\|.*不支持 --sessionId/s);
  assert.match(text(await f.run(undefined, ['new_page', 'https://a.example'])), /^2\|.*DSH_SESSION_ID/s);
  assert.match(text(await f.run(undefined, ['--help'])), /^0\|ran --help/, 'help goes to the official command line');
});

test('when the browser dies, every window goes with it and the next command says so', async t => {
  const f = fixture(t);
  await f.run('session-a', ['new_page', 'https://a.example']);
  f.crash();
  assert.equal(f.windows.holders().length, 0);
  assert.ok(f.events.includes('daemon:stop'));
  assert.match(text(await f.run('session-a', ['take_snapshot', '2'])), /^2\|.*浏览器重启过/s);
  assert.match(text(await f.run('session-a', ['new_page', 'https://a.example'])), /^0\|/);
});

test('a failed new_page gives the window back', async t => {
  const f = fixture(t, { windows: 1 });
  assert.match(text(await f.run('session-a', ['new_page', 'fail'])), /^1\|.*navigation failed/s);
  assert.equal(f.windows.holders().length, 0, 'the window went back');
  assert.deepEqual(f.events.slice(-2), ['daemon:stop', 'browser:stop'], 'and with no window left, the browser stopped');
  assert.match(text(await f.run('session-b', ['new_page', 'https://b.example'])), /^0\|/, 'the next conversation gets it at once');
});

test('the HTTP host takes only its token and protocol; the command passes output, waits and reports', async t => {
  const f = fixture(t, { windows: 1 });
  const server = await f.host.listen(0);
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const post = (headers: Record<string, string>) => fetch(`${url}/simen/v1/run`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ cwd: '/', argv: ['list_pages'] }) });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: `Bearer ${TOKEN}`, origin: 'https://example.com' })).status, 403);
  const mismatch = await post({ authorization: `Bearer ${TOKEN}`, 'x-simen-protocol': '2' });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json() as { error: string }).error, 'protocol_mismatch');

  const tokenFile = join(f.root, 'token');
  writeFileSync(tokenFile, TOKEN);
  const io = () => { const out: string[] = [], err: string[] = []; return { out, err, io: { out: (value: string) => { out.push(value); }, err: (value: string) => { err.push(value); } } }; };
  const env = (session?: string) => ({ SIMEN_URL: url, SIMEN_TOKEN_FILE: tokenFile, ...(session ? { DSH_SESSION_ID: session } : {}) });
  const a = io();
  assert.equal(await main(['new_page', 'https://a.example'], env('session-a'), a.io), 0);
  assert.match(a.out.join(''), /## Pages/);
  const refused = io();
  assert.equal(await main(['take_snapshot', '9'], env('session-z'), refused.io), 2);
  assert.match(refused.err.join(''), /^司门：页面 9 不属于这段对话/);
  // b waits until a closes its page.
  const b = io();
  const waiting = main(['new_page', 'https://b.example'], env('session-b'), b.io);
  await new Promise(resolve => setTimeout(resolve, 300));
  await main(['close_page', '2'], env('session-a'), io().io);
  assert.equal(await waiting, 0);
  assert.match(b.err.join(''), /两个窗口都在用，正在排队（前面还有 0 个/);
  const doctor = io();
  assert.equal(await main(['doctor'], env('session-b'), doctor.io), 0);
  assert.match(doctor.out.join(''), /浏览器：运行中（Chrome\/156）\n窗口：1\/1；对话 b 页面 3 闲置 \d+ 秒/);
  const missing = io();
  assert.equal(await main(['list_pages'], { SIMEN_URL: url, SIMEN_TOKEN_FILE: join(f.root, 'nope') }, missing.io), 3);
  assert.match(missing.err.join(''), /读不到令牌文件/);
});

test('agents are told about chrome-devtools only where the instance gave them 司门', async t => {
  const { createAgentTools, BROWSER_INSTRUCTIONS, RESULT_INSTRUCTIONS } = await import('../src/server/agent-tools.ts');
  const init = async (browser: boolean) => {
    const tools = createAgentTools({ token: TOKEN, port: 0, version: '0.1.1', notify: () => ({ id: 'n' }), record: () => ({ id: 'r' }), ...(browser ? { browser: true } : {}) });
    t.after(() => tools.close());
    const response = await tools.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) });
    return (response.json() as { result: { instructions: string } }).result.instructions;
  };
  assert.equal(await init(false), RESULT_INSTRUCTIONS);
  assert.equal(await init(true), `${RESULT_INSTRUCTIONS}\n\n${BROWSER_INSTRUCTIONS}`);
  assert.match(BROWSER_INSTRUCTIONS, /chrome-devtools new_page/);
});

test('tabs the profile restores from earlier conversations are closed or blanked when the browser starts', async t => {
  const f = fixture(t);
  f.restore(['https://earlier.example/a', 'https://earlier.example/b']);
  await f.run('session-a', ['new_page', 'https://a.example']);
  assert.deepEqual(f.pages().map(page => page.url), ['about:blank', 'https://a.example']);
  assert.ok(f.events.includes('close:3') && f.events.includes('blank:2'));
});

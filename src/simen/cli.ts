/**
 * The `chrome-devtools` command agents run on an instance with 司门 (ADR 0023). It takes the official Chrome DevTools
 * command line unchanged, adds the conversation (`DSH_SESSION_ID`) and the current directory, and lets 司门's host decide:
 * wait for a window, refuse with a reason, or run it with the official command line. Output and exit code come back as
 * the official command line wrote them. `chrome-devtools doctor` is 司门's own: it shows the browser, windows and queue.
 * Only Node built-ins; the token is read from a file and never printed.
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_TOKEN_FILE, DEFAULT_URL, EXIT, PROTOCOL_HEADER, SIMEN_PROTOCOL, type HostStatus, type RunResponse } from './protocol.ts';

type Io = { out(text: string): void; err(text: string): void };
const realIo: Io = { out: text => { process.stdout.write(text); }, err: text => { process.stderr.write(text); } };
const say = (text: string) => `司门：${text}\n`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = realIo): Promise<number> {
  const url = (env.SIMEN_URL ?? DEFAULT_URL).replace(/\/$/, '');
  const tokenFile = env.SIMEN_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
  let token: string;
  try { token = readFileSync(tokenFile, 'utf8').trim(); }
  catch { io.err(say(`读不到令牌文件 ${tokenFile}。浏览器服务没有配好，请联系实例管理员。`)); return EXIT.unavailable; }
  const session = env.DSH_SESSION_ID && /^[A-Za-z0-9_-]{1,128}$/.test(env.DSH_SESSION_ID) ? env.DSH_SESSION_ID : undefined;
  if (argv[0] === 'doctor') return doctor(url, token, session, io);

  let lastNotice = '';
  let lastNoticeAt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${url}/simen/v1/run`, {
        method: 'POST', signal: AbortSignal.timeout(200_000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', [PROTOCOL_HEADER]: String(SIMEN_PROTOCOL) },
        body: JSON.stringify({ cwd: process.cwd(), argv, ...(session ? { session } : {}) }),
      });
    } catch (error) {
      io.err(say(`连不上浏览器服务（${url}）：${error instanceof Error ? error.message : String(error)}。运行 chrome-devtools doctor 查看。`));
      return EXIT.unavailable;
    }
    if (response.status === 401) { io.err(say('令牌不对，浏览器服务拒绝了请求。')); return EXIT.unavailable; }
    if (response.status === 409) { const body = await response.json().catch(() => ({})) as { message?: string }; io.err(say(body.message ?? '命令行和司门的版本不一致。')); return EXIT.unavailable; }
    if (!response.ok) { io.err(say(`浏览器服务返回 ${response.status}。`)); return EXIT.unavailable; }
    const body = await response.json() as RunResponse;
    if (body.kind === 'result') {
      if (body.stdout) io.out(body.stdout);
      if (body.stderr) io.err(body.stderr);
      return body.code;
    }
    const notice = say(`两个窗口都在用，正在排队（前面还有 ${body.ahead} 个，已等 ${Math.round(body.waitedMs / 1000)} 秒，最多等 ${Math.round(body.limitMs / 60_000)} 分钟）。`);
    const ahead = notice.replace(/已等 \d+ 秒/, '');
    if (ahead !== lastNotice || Date.now() - lastNoticeAt > 30_000) { io.err(notice); lastNotice = ahead; lastNoticeAt = Date.now(); }
  }
}

async function doctor(url: string, token: string, session: string | undefined, io: Io): Promise<number> {
  let status: HostStatus;
  try {
    const response = await fetch(`${url}/simen/v1/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { io.err(say(`浏览器服务返回 ${response.status}${response.status === 401 ? '（令牌不对）' : ''}。`)); return EXIT.unavailable; }
    status = await response.json() as HostStatus;
  } catch (error) {
    io.err(say(`连不上浏览器服务（${url}）：${error instanceof Error ? error.message : String(error)}。`));
    return EXIT.unavailable;
  }
  const lines = [
    `司门 ${status.version}${status.revision ? ` (${status.revision.slice(0, 7)})` : ''}，协议 ${status.protocol}；官方 chrome-devtools ${status.official}`,
    `浏览器：${status.browser.running ? `运行中${status.browser.version ? `（${status.browser.version}）` : ''}` : '没开（用时才开）'}`,
    `窗口：${status.windows.held.length}/${status.windows.limit}${status.windows.held.map(held => `；对话 ${held.session}${held.pageId !== undefined ? ` 页面 ${held.pageId}` : ''} 闲置 ${held.idleSeconds} 秒`).join('')}`,
    `排队：${status.waiting}；闲置 ${status.idleMinutes} 分钟收回，最多等 ${status.waitMinutes} 分钟`,
    ...(status.memoryBytes !== undefined ? [`内存：${Math.round(status.memoryBytes / 1048576)} MB`] : []),
    `本对话：${session ? '在 DSH 对话里，可以开窗口' : '不在 DSH 对话里，不能 new_page'}`,
  ];
  io.out(`${lines.join('\n')}\n`);
  if (status.protocol !== SIMEN_PROTOCOL) { io.err(say(`命令行协议是 ${SIMEN_PROTOCOL}，司门是 ${status.protocol}，需要更新。`)); return EXIT.unavailable; }
  return 0;
}

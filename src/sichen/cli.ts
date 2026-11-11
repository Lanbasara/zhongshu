/**
 * `sichen`: 司辰's command line (ADR 0022). Agents and people write times in plain terms; the rule is checked here first,
 * then by Zhongshu, which hands it to the Harness. Only Node built-ins: it runs wherever Node does, beside any Harness.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { check, parseWeekdays, realClock, realDate, zoned, type Rule, type When } from './time.ts';
import { DEFAULT_TOKEN_FILE, DEFAULT_URL, PROTOCOL_HEADER, SICHEN_PROTOCOL, ZONE_HEADER, type SichenError, type SichenTask, type Target, type TimelineKind } from './protocol.ts';

const HELP = `司辰 sichen：定时任务与日历条目（中书的时间模块）

用法：
  sichen schedule add <名称> (--prompt <文本> | --prompt-file <文件>) <时间> [--to 本对话|新对话|首次新开]
  sichen schedule list [--state 开启|暂停|结束|全部]
  sichen schedule show <编号>
  sichen schedule edit <编号> [--name …] [--prompt … | --prompt-file …] [<时间>] [--until 日期 | --no-until]
  sichen schedule pause|resume|delete|run <编号>
  sichen timeline add <操作|大事|决定|研究> <标题> (--at "日期 钟点" | --date 日期) [--link 工作区内路径] [--detail …] [--id …]
  sichen timeline done|cancel <编号>
  sichen timeline list [--from 日期] [--to 日期]
  sichen doctor
  sichen --version

时间（默认用本机时区，VPS 上是上海时间）：
  --at "2026-11-10 21:40"                     一次
  --every 每天 --time 09:00                    每天
  --every 工作日 --time 14:45                  周一到周五
  --every 周一,周三 --time 10:00               每周这几天（也可写 mon,wed 或 1,3）
  --monthly 15 --time 10:00 [--months 3,6,9,12]  每月几号，可只在某些月
  --cron "0 10 30 3,6,9,12 *"                 高级写法
  --from 2026-11-10  --until 2027-01-31        开始、结束日期（含当天），可选
  --tz Asia/Shanghai                           换时区

结果放哪（--to）：
  本对话（here）    回到正在运行这条命令的对话
  新对话（new）     每次新开一段对话（默认）
  首次新开（new_once） 第一次新开一段，之后都回到那段

加 --json 输出给程序读的格式。出错时退出码非 0，并说明原因。`;

const flags = {
  prompt: { type: 'string' }, 'prompt-file': { type: 'string' }, at: { type: 'string' }, every: { type: 'string' }, time: { type: 'string' },
  monthly: { type: 'string' }, months: { type: 'string' }, cron: { type: 'string' }, from: { type: 'string' }, until: { type: 'string' },
  'no-until': { type: 'boolean' }, tz: { type: 'string' }, to: { type: 'string' }, preset: { type: 'string' }, name: { type: 'string' },
  state: { type: 'string' }, date: { type: 'string' }, link: { type: 'string' }, detail: { type: 'string' }, id: { type: 'string' },
  json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
} as const;
type Values = ReturnType<typeof parseArgs<{ options: typeof flags; allowPositionals: true }>>['values'];

class Stop extends Error {
  readonly code: number; readonly details: string[];
  constructor(message: string, code = 2, details: string[] = []) { super(message); this.code = code; this.details = details; }
}

function ownVersion(): { version: string; revision?: string } {
  try { return JSON.parse(readFileSync(new URL('./version.json', import.meta.url), 'utf8')) as { version: string; revision?: string }; }
  catch { return { version: 'development' }; }
}
const zone = (values: Values) => values.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The plain-terms flags as a rule; undefined when no time flag was given (for edits). */
export function whenFrom(values: Values, required: boolean): When | undefined {
  const timeZone = zone(values);
  const given = [values.at, values.every, values.monthly, values.cron].filter(value => value !== undefined).length;
  if (!given) {
    if (required) throw new Stop('缺少时间：请用 --at、--every、--monthly 或 --cron 之一。');
    if (values.time || values.from || values.months) throw new Stop('--time、--from、--months 要和 --every 或 --monthly 一起用。');
    return undefined;
  }
  if (given > 1) throw new Stop('--at、--every、--monthly、--cron 只能选一个。');
  let rule: Rule;
  if (values.at !== undefined) {
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})$/.exec(values.at.trim());
    if (!match) throw new Stop(`--at 要写成 "YYYY-MM-DD HH:mm"，收到的是“${values.at}”。`);
    rule = { kind: 'once', date: match[1]!, time: match[2]!.padStart(5, '0') };
  } else if (values.cron !== undefined) rule = { kind: 'cron', expression: values.cron };
  else {
    if (!values.time) throw new Stop('--every 和 --monthly 需要 --time，例如 --time 14:45。');
    const time = values.time.padStart(5, '0');
    if (values.every !== undefined) {
      const days = parseWeekdays(values.every);
      if (!days) throw new Stop(`看不懂 --every “${values.every}”。可以写 每天、工作日、周一,周三、mon-fri 或 1,3,5。`);
      rule = days === 'daily' ? { kind: 'daily', time } : { kind: 'weekly', weekdays: days, time };
    } else {
      const day = Number(values.monthly);
      const months = values.months ? values.months.split(/[,，、\s]+/).filter(Boolean).map(Number) : undefined;
      rule = { kind: 'monthly', day, ...(months ? { months } : {}), time };
    }
  }
  return { rule, timeZone, ...(values.from ? { from: values.from } : {}), ...(values.until ? { until: values.until } : {}) };
}
function targetFrom(text: string | undefined): Target {
  const value = (text ?? '新对话').trim().toLowerCase();
  if (['本对话', '这段对话', 'here', 'this'].includes(value)) return 'here';
  if (['新对话', '每次新开', 'new'].includes(value)) return 'new';
  if (['首次新开', 'new_once', 'new-once', 'once'].includes(value)) return 'new_once';
  throw new Stop(`看不懂 --to “${text}”。可以写 本对话、新对话 或 首次新开。`);
}
function kindFrom(text: string | undefined): TimelineKind {
  const map: Record<string, TimelineKind> = { 操作: 'action', 动作: 'action', action: 'action', 大事: 'event', 事件: 'event', event: 'event', 决定: 'decision', decision: 'decision', 研究: 'research', research: 'research' };
  const kind = text ? map[text.trim().toLowerCase()] : undefined;
  if (!kind) throw new Stop(`条目类型要写 操作、大事、决定 或 研究，收到的是“${text ?? ''}”。`);
  return kind;
}
function promptFrom(values: Values, required: boolean): string | undefined {
  if (values.prompt !== undefined && values['prompt-file'] !== undefined) throw new Stop('--prompt 和 --prompt-file 只能选一个。');
  if (values['prompt-file'] !== undefined) {
    try { return readFileSync(values['prompt-file'], 'utf8').trim(); } catch { throw new Stop(`读不到文件 ${values['prompt-file']}。`); }
  }
  if (values.prompt !== undefined) return values.prompt.trim();
  if (required) throw new Stop('缺少交给 Agent 的指令：请用 --prompt 或 --prompt-file。');
  return undefined;
}

/** "11 月 10 日 14:45（明天）" in the command's zone. */
function when(iso: string, timeZone: string, now = Date.now()): string {
  const at = zoned(Date.parse(iso), timeZone); const today = zoned(now, timeZone).date;
  const days = Math.round((Date.parse(at.date) - Date.parse(today)) / 86_400_000);
  const relative = days === 0 ? '今天' : days === 1 ? '明天' : days === -1 ? '昨天' : days > 0 ? `${days} 天后` : `${-days} 天前`;
  const [, m, d] = at.date.split('-').map(Number);
  return `${m} 月 ${d} 日 ${at.time}（${relative}）`;
}
function showTask(task: SichenTask, timeZone: string, heading: string): string {
  const status = { active: '开启', paused: '已暂停', ended: '已结束' }[task.status];
  return [heading, `规则：${task.rule}`, `状态：${status}`, task.next.length ? `接下来：${task.next.map(value => when(value, timeZone)).join('、')}` : '',
    `结果：${task.to}`, task.harness ? `Power：${task.harness === 'codex' ? 'Codex' : 'DSH'}` : '', task.problem ? '投递状态需要处理，请查看任务卡或目标对话。' : '', task.lastRun ? `最近一次：${when(task.lastRun.at, timeZone)}${task.lastRun.late ? '（迟到）' : ''}${task.lastRun.result ? ` —— ${task.lastRun.result}` : ''}` : ''].filter(Boolean).join('\n');
}

async function call(path: string, init: { method?: string; body?: unknown; values: Values }): Promise<Record<string, unknown>> {
  const base = (process.env.SICHEN_URL ?? DEFAULT_URL).replace(/\/+$/, '');
  let token: string;
  const file = process.env.SICHEN_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
  try { token = readFileSync(file, 'utf8').trim(); } catch { throw new Stop(`读不到司辰的令牌文件（${file}）。这台机器可能还没装好司辰，请运行 sichen doctor。`, 3); }
  let response: Response;
  try {
    response = await fetch(base + path, { method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(SICHEN_PROTOCOL), [ZONE_HEADER]: zone(init.values), ...(init.body ? { 'content-type': 'application/json' } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}), signal: AbortSignal.timeout(60_000) });
  } catch { throw new Stop(`连不上中书（${base}）。请运行 sichen doctor。`, 3); }
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status === 401 || response.status === 403) throw new Stop('中书拒绝了令牌，请运行 sichen doctor。', 3);
  if (!response.ok) { const error = value as Partial<SichenError>; throw new Stop(error.message ?? `中书返回 ${response.status}`, 1, error.problems ?? []); }
  return value;
}
function print(values: Values, data: unknown, text: string) { process.stdout.write((values.json ? JSON.stringify(data, null, 2) : text) + '\n'); }

async function schedule(action: string | undefined, args: string[], values: Values): Promise<void> {
  const timeZone = zone(values);
  const id = () => { if (!args[0]) throw new Stop('缺少任务编号。请用 sichen schedule list 查看。'); return encodeURIComponent(args[0]); };
  const checked = (rule: When | undefined) => { if (rule) { const problems = check(rule, Date.now()); if (problems.length) throw new Stop('时间写法有问题，没有建任务：', 2, problems); } return rule; };
  switch (action) {
    case 'add': {
      if (!args[0]) throw new Stop('缺少任务名称：sichen schedule add <名称> …');
      const rule = checked(whenFrom(values, true))!;
      const to = targetFrom(values.to);
      const harness = process.env.CODEX_THREAD_ID || process.env.ZHONGSHU_POWER === 'codex' ? 'codex' : 'dsh';
      const session = harness === 'codex' ? process.env.CODEX_THREAD_ID : process.env.DSH_SESSION_ID;
      if (to === 'here' && !session) throw new Stop('“本对话”需要在 Codex 或 DSH 对话里运行（缺少 CODEX_THREAD_ID 或 DSH_SESSION_ID）。');
      const data = await call('/sichen/v1/schedule/add', { values, body: { name: args[0], prompt: promptFrom(values, true), when: rule, to, ...(harness === 'codex' ? { harness } : {}), ...(to === 'here' ? { session } : {}), cwd: process.cwd(), ...(values.preset ? { preset: values.preset } : {}) } });
      const task = data.task as SichenTask;
      return print(values, data, showTask(task, timeZone, `已建好「${task.name}」（编号 ${task.id}）`));
    }
    case 'list': {
      const state = { 开启: 'active', 暂停: 'paused', 结束: 'ended', 全部: 'all' }[values.state ?? ''] ?? values.state ?? 'active';
      const data = await call(`/sichen/v1/schedule?state=${encodeURIComponent(state)}`, { values });
      const tasks = data.tasks as SichenTask[];
      return print(values, data, tasks.length ? tasks.map(task => `${task.id}  ${task.name}\n  ${task.rule}${task.next[0] ? ` · 下次 ${when(task.next[0], timeZone)}` : ''} · ${task.to}`).join('\n') : '没有符合条件的任务。');
    }
    case 'show': { const data = await call(`/sichen/v1/schedule/${id()}`, { values }); const task = data.task as SichenTask; return print(values, data, showTask(task, timeZone, `「${task.name}」（编号 ${task.id}）\n指令：${task.prompt}`)); }
    case 'edit': {
      if (values.until && values['no-until']) throw new Stop('--until 和 --no-until 只能选一个。');
      const rule = checked(whenFrom(values, false));
      const body = { ...(values.name ? { name: values.name } : {}), ...(promptFrom(values, false) !== undefined ? { prompt: promptFrom(values, false) } : {}), ...(rule ? { when: rule } : {}),
        ...(!rule && values.until ? { until: values.until } : {}), ...(values['no-until'] ? { until: null } : {}) };
      if (!Object.keys(body).length) throw new Stop('没有要改的内容：可以改 --name、--prompt、时间、--until 或 --no-until。');
      const data = await call(`/sichen/v1/schedule/${id()}/edit`, { values, body });
      const task = data.task as SichenTask;
      return print(values, data, showTask(task, timeZone, `已改好「${task.name}」（编号 ${task.id}）`));
    }
    case 'pause': case 'resume': case 'run': {
      const data = await call(`/sichen/v1/schedule/${id()}/${action}`, { values, body: {} });
      const task = data.task as SichenTask;
      return print(values, data, showTask(task, timeZone, `${{ pause: '已暂停', resume: '已恢复', run: '已开始运行' }[action]}「${task.name}」（编号 ${task.id}）`));
    }
    case 'delete': { const data = await call(`/sichen/v1/schedule/${id()}/delete`, { values, body: {} }); return print(values, data, `已删除 ${args[0]}。`); }
    default: throw new Stop(`schedule 没有“${action ?? ''}”这个动作。可用：add list show edit pause resume delete run。`);
  }
}

async function timeline(action: string | undefined, args: string[], values: Values): Promise<void> {
  const label = (entry: Record<string, unknown>) => `${entry.date}${entry.time ? ` ${entry.time}` : ''} ${entry.title}（编号 ${entry.id}${entry.status ? `，${entry.status === 'done' ? '已完成' : '已取消'}` : ''}）`;
  switch (action) {
    case 'add': {
      const kind = kindFrom(args[0]); if (!args[1]) throw new Stop('缺少标题：sichen timeline add <类型> <标题> …');
      let date: string; let time: string | undefined;
      if (values.at) { const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})$/.exec(values.at.trim()); if (!match) throw new Stop(`--at 要写成 "YYYY-MM-DD HH:mm"，收到的是“${values.at}”。`); date = match[1]!; time = match[2]!.padStart(5, '0'); }
      else if (values.date) date = values.date; else throw new Stop('缺少日期：请用 --at "日期 钟点" 或 --date 日期（全天）。');
      if (!realDate(date)) throw new Stop(`日期“${date}”不存在，请写成 YYYY-MM-DD。`);
      if (time && !realClock(time)) throw new Stop(`钟点“${time}”不对，请写成 HH:mm。`);
      const data = await call('/sichen/v1/timeline/add', { values, body: { cwd: process.cwd(), kind, title: args[1], date, ...(time ? { time, tz: zone(values) } : {}),
        ...(values.link ? { link: values.link } : {}), ...(values.detail ? { detail: values.detail } : {}), ...(values.id ? { id: values.id } : {}) } });
      return print(values, data, `已写入「${data.workspace}」的日历：${label(data.entry as Record<string, unknown>)}`);
    }
    case 'done': case 'cancel': {
      if (!args[0]) throw new Stop('缺少条目编号。请用 sichen timeline list 查看。');
      const data = await call(`/sichen/v1/timeline/${encodeURIComponent(args[0])}/${action}`, { values, body: { cwd: process.cwd() } });
      return print(values, data, `已标记：${label(data.entry as Record<string, unknown>)}`);
    }
    case 'list': {
      const query = new URLSearchParams({ cwd: process.cwd(), ...(values.from ? { from: values.from } : {}), ...(values.to ? { to: values.to } : {}) });
      const data = await call(`/sichen/v1/timeline?${query}`, { values });
      const entries = data.entries as Record<string, unknown>[];
      return print(values, data, [`「${data.workspace}」的日历条目：`, ...(entries.length ? entries.map(entry => `  ${label(entry)}`) : ['  （没有）']), ...(data.problems ? [`另有 ${data.problems} 行写错了，被跳过。`] : [])].join('\n'));
    }
    default: throw new Stop(`timeline 没有“${action ?? ''}”这个动作。可用：add done cancel list。`);
  }
}

async function doctor(values: Values): Promise<void> {
  const own = ownVersion(); const lines: string[] = []; let ok = true;
  const file = process.env.SICHEN_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
  lines.push(`命令行：sichen ${own.version}${own.revision && own.revision !== 'development' ? ` (${own.revision.slice(0, 7)})` : ''}，协议 ${SICHEN_PROTOCOL}，时区 ${zone(values)}`);
  try { readFileSync(file, 'utf8'); lines.push(`令牌：可读（${file}）`); } catch { ok = false; lines.push(`令牌：读不到（${file}）`); }
  try {
    const server = await call('/sichen/v1/version', { values }) as { protocol: number; version: string; revision?: string; schedule: boolean; codexSchedule?: boolean };
    lines.push(`中书：${server.version}${server.revision ? ` (${server.revision.slice(0, 7)})` : ''}，协议 ${server.protocol}，${server.schedule ? '已接通 DSH 定时任务' : '未接通 DSH 定时任务'}${server.codexSchedule ? '，已接通 Codex 定时任务' : ''}`);
    if (server.protocol !== SICHEN_PROTOCOL) { ok = false; lines.push('协议不一致：请更新 sichen 或中书，使两边一致。'); }
    if (own.revision && server.revision && own.revision !== server.revision) lines.push('提示：命令行和中书不是同一次构建。');
  } catch (error) { ok = false; lines.push(`中书：${(error as Error).message}`); }
  const harness = process.env.CODEX_THREAD_ID ? 'Codex' : process.env.DSH_SESSION_ID ? 'DSH' : undefined;
  lines.push(harness ? `对话：在 ${harness} 对话里运行，可以用 --to 本对话` : '对话：未识别，不能用 --to 本对话');
  print(values, { ok, lines }, (ok ? '正常\n' : '有问题\n') + lines.join('\n'));
  if (!ok) process.exitCode = 3;
}

export async function main(argv: string[]): Promise<void> {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: flags, allowPositionals: true, strict: true }); }
  catch (error) { process.stderr.write(`参数有误：${(error as Error).message}\n运行 sichen --help 查看用法。\n`); process.exitCode = 2; return; }
  const { values, positionals } = parsed;
  if (values.version) { const own = ownVersion(); process.stdout.write(`sichen ${own.version}${own.revision && own.revision !== 'development' ? ` (${own.revision.slice(0, 7)})` : ''}，协议 ${SICHEN_PROTOCOL}\n`); return; }
  if (values.help || !positionals.length) { process.stdout.write(HELP + '\n'); return; }
  const [group, action, ...rest] = positionals;
  try {
    if (group === 'schedule') await schedule(action, rest, values);
    else if (group === 'timeline') await timeline(action, rest, values);
    else if (group === 'doctor') await doctor(values);
    else throw new Stop(`没有“${group}”这类命令。可用：schedule、timeline、doctor。`);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    process.stderr.write(`${error.message}\n${error.details.map(line => `  - ${line}`).join('\n')}${error.details.length ? '\n' : ''}`);
    process.exitCode = error.code;
  }
}

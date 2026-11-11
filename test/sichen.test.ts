import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AutomationView } from '../src/shared/automations.ts';
import type { AutomationPatch, AutomationTargetInput, AutomationTimingInput } from '../src/harness/types.ts';
import { createAgentTools, RESULT_INSTRUCTIONS, SICHEN_INSTRUCTIONS } from '../src/server/agent-tools.ts';
import { sichenRoutes } from '../src/server/sichen-api.ts';

const TOKEN = 'synthetic-tool-token-0123456789abcdef';
const SH = 'Asia/Shanghai';

/** A Harness stand-in: tasks live in memory and record what 司辰 handed over. */
function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sichen-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const created: { title: string; prompt: string; timing: AutomationTimingInput; target: AutomationTargetInput }[] = [];
  const edits: { id: string; patch: AutomationPatch; expected?: string }[] = [];
  const tasks = new Map<string, AutomationView>();
  const viewOf = (id: string, input: { title: string; prompt: string; timing: AutomationTimingInput; target: AutomationTargetInput }): AutomationView => ({
    id, harnessId: 'dsh', title: input.title, prompt: input.prompt, status: 'active', executing: false, runs: 0, updatedAt: '2026-11-09T05:00:00.000Z',
    timing: input.timing.kind === 'at' ? { kind: 'once', at: input.timing.at } : input.timing.kind === 'rrule' ? { kind: 'rrule', rrule: input.timing.rrule } : input.timing as AutomationView['timing'],
    scheduledAt: input.timing.kind === 'at' ? input.timing.at : '2026-11-10T06:45:00.000Z',
    target: input.target.kind === 'session' ? { kind: 'conversation', conversationId: '11111111-1111-4111-8111-111111111111', conversationTitle: '跟踪' } : { kind: input.target.kind, workspaceId: 'w', workspaceLabel: '工作区' },
  });
  const operations = {
    async list() { return [...tasks.values()]; },
    async get(id: string) { const task = tasks.get(id); if (!task) throw Object.assign(new Error('automation_not_found'), { statusCode: 404 }); return task; },
    async native(id: string) { const task = tasks.get(id)!; return { ...task, timing: task.timing } as never; },
    async create(input: { title: string; prompt: string; timing: AutomationTimingInput; target: AutomationTargetInput }) {
      created.push(input); const task = viewOf(`schedule-${created.length}`, input); tasks.set(task.id, task); return task;
    },
    async edit(id: string, patch: AutomationPatch, expected?: string) {
      edits.push({ id, patch, ...(expected ? { expected } : {}) });
      const task = tasks.get(id); if (!task) return 'notFound' as const;
      const next = { ...task, ...(patch.title ? { title: patch.title } : {}), ...(patch.timing?.kind === 'rrule' ? { timing: { kind: 'rrule' as const, rrule: patch.timing.rrule } } : {}),
        ...(patch.active !== undefined ? { status: patch.active ? 'active' as const : 'paused' as const } : {}) };
      tasks.set(id, next); return next;
    },
    async remove(id: string) { return tasks.delete(id) ? 'deleted' as const : 'notFound' as const; },
    async run(id: string) { return tasks.get(id) ?? 'notFound' as const; },
    available: (harness = 'dsh') => harness === 'dsh',
  };
  const workbench = { workspaces: [{ id: 'w', label: '工作区', directory }], workspaceView: () => ({ workspaces: [{ id: 'w', label: '工作区' }] }) } as never;
  const tools = createAgentTools({ token: TOKEN, port: 0, version: '0.1.1', notify: () => ({ id: 'x' }), record: () => ({ id: 'x' }),
    routes: sichenRoutes({ operations: operations as never, workbench, version: '0.1.1', revision: 'a'.repeat(40) }) });
  t.after(() => tools.close());
  const request = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) => tools.inject({ method, url,
    headers: { authorization: `Bearer ${TOKEN}`, 'x-sichen-protocol': '1', 'x-sichen-zone': SH, ...(payload ? { 'content-type': 'application/json' } : {}), ...headers }, ...(payload ? { payload: JSON.stringify(payload) } : {}) });
  return { directory, created, edits, tasks, tools, request };
}
const scan = { rule: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '14:45' }, timeZone: SH, until: '2099-01-31' };

test('the agent server tells agents about sichen and guards its endpoints with the token and the protocol', async t => {
  const f = fixture(t);
  const init = (await f.tools.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) })).json();
  assert.equal(init.result.instructions, `${RESULT_INSTRUCTIONS}\n\n${SICHEN_INSTRUCTIONS}`);
  assert.match(SICHEN_INSTRUCTIONS, /sichen --help/);
  assert.equal((await f.request('GET', '/sichen/v1/version', undefined, { authorization: 'Bearer wrong-token-0123456789abcdefgh' })).statusCode, 401);
  assert.equal((await f.request('GET', '/sichen/v1/version', undefined, { origin: 'https://example.com' })).statusCode, 403);
  assert.deepEqual((await f.request('GET', '/sichen/v1/version')).json(), { protocol: 1, version: '0.1.1', revision: 'a'.repeat(40), schedule: true });
  const old = await f.request('GET', '/sichen/v1/schedule', undefined, { 'x-sichen-protocol': '0' });
  assert.equal(old.statusCode, 409); assert.equal(old.json().error, 'protocol_mismatch'); assert.match(old.json().message, /版本不一致/);
});

test('a plain-terms task with an end date reaches the Harness as RRULE with UNTIL, back to the calling conversation', async t => {
  const f = fixture(t);
  const made = await f.request('POST', '/sichen/v1/schedule/add', { name: '前置扫描', prompt: '读 reviews.md 的某一节', when: scan, to: 'here', session: 'session-abc', cwd: join(f.directory, 'sub') });
  assert.equal(made.statusCode, 200, made.body);
  const handed = f.created[0]!;
  assert.deepEqual(handed.target, { kind: 'session', sessionId: 'session-abc' });
  assert.equal(handed.timing.kind, 'rrule');
  assert.match((handed.timing as { rrule: string }).rrule, /^DTSTART;TZID=Asia\/Shanghai:\d{8}T144500\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20990131T155959Z$/);
  const task = made.json().task;
  assert.equal(task.rule, '每个工作日 14:45 · 到 2099-01-31', 'a start that has come is not repeated');
  assert.equal(task.until, '2099-01-31'); assert.equal(task.next.length, 3); assert.match(task.to, /回到对话/);
  // A new conversation per run starts in the registered workspace that holds the command's directory.
  const fresh = await f.request('POST', '/sichen/v1/schedule/add', { name: 'x', prompt: 'y', when: { rule: { kind: 'daily', time: '09:00' }, timeZone: SH }, to: 'new', cwd: f.directory });
  assert.equal(fresh.statusCode, 200); assert.deepEqual(f.created[1]!.target, { kind: 'new', cwd: f.directory });
  assert.deepEqual(f.created[1]!.timing, { kind: 'daily', time: '09:00', timeZone: SH });
});

test('wrong times, unknown directories and a missing conversation are refused in plain words, and nothing is created', async t => {
  const f = fixture(t);
  const late = await f.request('POST', '/sichen/v1/schedule/add', { name: 'x', prompt: 'y', when: { rule: { kind: 'once', date: '2020-01-01', time: '09:00' }, timeZone: SH }, to: 'new', cwd: f.directory });
  assert.equal(late.statusCode, 400); assert.equal(late.json().error, 'invalid_time'); assert.match(late.json().problems[0], /已经过去/);
  const outside = await f.request('POST', '/sichen/v1/schedule/add', { name: 'x', prompt: 'y', when: scan, to: 'new', cwd: '/elsewhere' });
  assert.equal(outside.json().error, 'not_in_workspace');
  const noSession = await f.request('POST', '/sichen/v1/schedule/add', { name: 'x', prompt: 'y', when: scan, to: 'here', cwd: f.directory });
  assert.equal(noSession.json().error, 'session_required');
  assert.equal(f.created.length, 0);
});

test('an end date can be added to or removed from an existing rule, keeping its days and time', async t => {
  const f = fixture(t);
  await f.request('POST', '/sichen/v1/schedule/add', { name: '黄金周检', prompt: 'y', when: { rule: { kind: 'weekly', weekdays: [1], time: '10:00' }, timeZone: SH, from: '2099-01-05' }, to: 'new', cwd: f.directory });
  const ended = await f.request('POST', '/sichen/v1/schedule/schedule-1/edit', { until: '2099-03-30' });
  assert.equal(ended.statusCode, 200, ended.body);
  assert.match((f.edits[0]!.patch.timing as { rrule: string }).rrule, /BYDAY=MO;UNTIL=20990330T155959Z$/);
  assert.equal(ended.json().task.until, '2099-03-30');
  const open = await f.request('POST', '/sichen/v1/schedule/schedule-1/edit', { until: null });
  assert.doesNotMatch((f.edits[1]!.patch.timing as { rrule: string }).rrule, /UNTIL/);
  assert.equal(open.json().task.until, undefined);
  assert.equal((await f.request('POST', '/sichen/v1/schedule/schedule-1/pause', {})).json().task.status, 'paused');
});

test('timeline entries are validated, appended to the workspace file and marked done with the same id', async t => {
  const f = fixture(t);
  const added = await f.request('POST', '/sichen/v1/timeline/add', { cwd: f.directory, kind: 'action', title: '券商买 511580 3 手', date: '2099-11-11', time: '10:20', link: '2026-11-06/case-002/case.md' });
  assert.equal(added.statusCode, 200, added.body);
  const entry = added.json().entry;
  assert.match(entry.id, /^action-20991111-[0-9a-f]{6}$/); assert.equal(entry.tz, SH);
  const escaping = await f.request('POST', '/sichen/v1/timeline/add', { cwd: f.directory, kind: 'event', title: 'x', date: '2099-11-11', link: '../secret.md' });
  assert.equal(escaping.json().error, 'timeline_entry_invalid');
  assert.deepEqual(escaping.json().problems, ['链接要写工作区里的相对路径，不能是网址、绝对路径或带 ..'], 'the command line prints a sentence, not a code');
  const done = await f.request('POST', `/sichen/v1/timeline/${entry.id}/done`, { cwd: f.directory });
  assert.equal(done.json().entry.status, 'done');
  const lines = readFileSync(join(f.directory, '.zhongshu/timeline.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2); assert.equal(lines[1].id, entry.id); assert.equal(lines[1].status, 'done');
  const listed = (await f.request('GET', `/sichen/v1/timeline?cwd=${encodeURIComponent(f.directory)}&from=2099-01-01`)).json();
  assert.deepEqual(listed.entries.map((value: { id: string; status?: string }) => [value.id, value.status]), [[entry.id, 'done']]);
});

test('the sichen command talks to Zhongshu end to end, checks times before sending and reads the result back', async t => {
  const f = fixture(t);
  await f.tools.listen();
  const token = join(f.directory, '.token'); writeFileSync(token, TOKEN, { mode: 0o600 });
  // Asynchronous on purpose: the server answering the command runs in this same process.
  const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ status: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--input-type=module', '-e', `import('${new URL('../src/sichen/cli.ts', import.meta.url).href}').then(m => m.main(process.argv.slice(1)))`, ...args], {
      cwd: f.directory, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TZ: SH, SICHEN_URL: `http://127.0.0.1:${f.tools.port()}`, SICHEN_TOKEN_FILE: token, ...env } },
    (error, stdout, stderr) => resolve({ status: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
  const made = await run(['schedule', 'add', '前置扫描', '--every', '工作日', '--time', '14:45', '--until', '2099-01-31', '--to', '本对话', '--prompt', '读 reviews.md'], { DSH_SESSION_ID: 'session-cli' });
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /已建好「前置扫描」（编号 schedule-1）/); assert.match(made.stdout, /到 2099-01-31/); assert.match(made.stdout, /接下来：/);
  assert.deepEqual(f.created[0]!.target, { kind: 'session', sessionId: 'session-cli' });
  const wrong = await run(['schedule', 'add', 'x', '--every', '工作日', '--time', '14:45', '--until', '2099-02-30', '--prompt', 'y']);
  assert.equal(wrong.status, 2); assert.match(wrong.stderr, /结束日期“2099-02-30”不存在/); assert.equal(f.created.length, 1, 'nothing sent');
  const here = await run(['schedule', 'add', 'x', '--at', '2099-01-01 09:00', '--to', '本对话', '--prompt', 'y']);
  assert.equal(here.status, 2); assert.match(here.stderr, /DSH_SESSION_ID/);
  const listed = await run(['schedule', 'list', '--json']);
  assert.equal(JSON.parse(listed.stdout).tasks[0].name, '前置扫描');
  const entry = await run(['timeline', 'add', '操作', '券商买 511580 3 手', '--at', '2099-11-11 10:20']);
  assert.equal(entry.status, 0, entry.stderr); assert.match(entry.stdout, /已写入「工作区」的日历/);
  const doctor = await run(['doctor']);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr); assert.match(doctor.stdout, /^正常/); assert.match(doctor.stdout, /协议 1/);
  const missing = await run(['doctor'], { SICHEN_TOKEN_FILE: join(f.directory, 'none') });
  assert.equal(missing.status, 3); assert.match(missing.stdout, /令牌：读不到/);
});

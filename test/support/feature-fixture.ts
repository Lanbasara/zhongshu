/**
 * Disposable browser-verification fixture. Only HarnessAdapter is replaced.
 * Trust boundary: trusted local CLI, private synthetic state, loopback HTTP with
 * the product's normal authentication. No native credentials or control routes.
 * The fixture database outlives the app so a separate CLI can finish synthetic
 * work while the app is down. This does not prove native Harness execution.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Binding, HarnessAdapter, HarnessId, HarnessInput, NativeItem, NativeState, Receipt } from '../../src/harness/types.ts';
import { HarnessError } from '../../src/harness/types.ts';
import { nativeSkill, resolveSkillInput, skillOptions } from '../../src/harness/skills.ts';
import type { QueueDelivery } from '../../src/shared/workbench.ts';
import { buildApp } from '../../src/server/app.ts';
import { openDatabase } from '../../src/server/database.ts';
import { productMigrations } from '../../src/server/migrations.ts';
import { createWorkbenchStore } from '../../src/server/workbench-store.ts';
import { Workbench } from '../../src/server/workbench.ts';
import { createWorkbenchHttp } from '../../src/server/workbench-http.ts';
import { WorkspaceRegistry } from '../../src/server/workspace-registry.ts';
import { itemSchema, stateSchema, subagentStatusSchema, teamSchema, usageSchema } from '../../src/shared/workbench.ts';

process.umask(0o077);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const cliSchema = z.object({
  command: z.enum(['serve', 'init', 'reset', 'inspect', 'inspect-deletions', 'reject-delete-next', 'complete', 'prove', 'seed', 'disconnect', 'reconnect', 'unknown-receipt', 'reject-next', 'fail-create', 'repair', 'disable-skills', 'usage-full', 'usage-compact', 'usage-total-only',
    'spawn-subagents', 'complete-subagents', 'subagent-team', 'unknown-subagent-stop']),
  root: z.string().min(1).max(4096).refine(isAbsolute),
  port: z.coerce.number().int().min(1024).max(65535).default(4391),
  title: z.string().min(1).max(200).optional(),
  count: z.coerce.number().int().min(1).max(700).default(650),
  chars: z.coerce.number().int().min(32).max(80_000).default(80),
});
const recordSchema = z.object({
  id: z.uuid(), title: z.string().max(200), harnessId: z.enum(['codex', 'dsh']),
  cwd: z.string().max(4096), configuration: z.object({ modelId: z.string(), permissionId: z.string(), reasoningEffort: z.string().optional() }),
  state: stateSchema, items: z.array(itemSchema).max(1000),
  submissions: z.array(z.object({ id: z.string(), text: z.string().max(16_000), runId: z.string() })).max(100),
  rejectedOperationIds: z.array(z.uuid()).max(100).default([]), rejectNext: z.boolean().default(false),
  submitCalls: z.number().int().min(0), stopCalls: z.number().int().min(0),
  offline: z.boolean(), unknownReceipt: z.boolean(), hidden: z.boolean(), revision: z.number().int().min(0),
  skillsDisabled: z.boolean().optional(), usage: usageSchema.optional(),
  rejectDeleteNext: z.boolean().optional(),
  /** Synthetic sub-agents. They prove workbench and browser behaviour only, never native multi-agent semantics. */
  subagents: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,80}$/), parentId: z.string().max(240), name: z.string().max(200), task: z.string().max(2000),
    status: subagentStatusSchema, external: z.literal(true).optional(), startedAt: z.number().int().optional(), endedAt: z.number().int().optional(),
    items: z.array(itemSchema).max(200) })).max(50).default([]),
  team: teamSchema.optional(), resultsPending: z.boolean().default(false),
  subagentStopCalls: z.number().int().min(0).default(0), unknownSubagentStop: z.boolean().default(false),
});
type Native = z.infer<typeof recordSchema>;
const idle = (): NativeState => ({ status: 'idle', pendingInputs: 0, configurationVerified: true });

function privateFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('unsafe_fixture_file');
}

async function main() {
  const args = parseArgs({ options: { root: { type: 'string' }, port: { type: 'string' }, title: { type: 'string' }, count: { type: 'string' }, chars: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true, strict: true });
  if (args.values.help) {
    console.log(`node test/support/feature-fixture.ts <${cliSchema.shape.command.options.join('|')}> --root ABSOLUTE_DIRECTORY [--port 4391] [--title TITLE] [--count 650 --chars 80]`);
    return;
  }
  if (args.positionals.length !== 1) throw new Error('one_command_required');
  const input = cliSchema.parse({ command: args.positionals[0], ...args.values });
  const info = lstatSync(input.root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('root_must_be_owned_private_directory');
  const root = realpathSync(input.root);
  const marker = join(root, 'fixture.json');
  if (!existsSync(marker)) {
    if (input.command !== 'serve' || readdirSync(root).length) throw new Error('first_serve_requires_empty_root');
    writeFileSync(marker, JSON.stringify({ format: 1, repository }), { flag: 'wx', mode: 0o600 });
    mkdirSync(join(root, 'private'), { mode: 0o700 });
    writeFileSync(join(root, 'private/password'), randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  }
  privateFile(marker);
  const identity = z.object({ format: z.literal(1), repository: z.literal(repository) }).strict().parse(JSON.parse(readFileSync(marker, 'utf8')));
  void identity;

  if (input.command === 'init' || input.command === 'reset') {
    const passwordFile = join(root, 'private/password'); privateFile(passwordFile);
    const password = input.command === 'reset' ? randomBytes(32).toString('base64url') : readFileSync(passwordFile, 'utf8');
    const result = spawnSync(process.execPath, [join(repository, 'src/server/admin.ts'), input.command, '--data-dir', join(root, 'data'), '--password-stdin'], { input: password, encoding: 'utf8', timeout: 20_000, env: { ...process.env, ZHONGSHU_HARNESS_CONFIG: '' } });
    if (result.error || result.status !== 0) throw new Error('fixture_admin_failed');
    if (input.command === 'reset') writeFileSync(passwordFile, password, { mode: 0o600 });
    console.log(JSON.stringify({ event: input.command, passwordFile }));
    return;
  }

  const nativePath = join(root, 'native.sqlite');
  if (!existsSync(nativePath)) {
    if (input.command !== 'serve') throw new Error('serve_required_first');
    closeSync(openSync(nativePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
  }
  privateFile(nativePath);
  const native = new DatabaseSync(nativePath);
  native.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, fail_create INTEGER NOT NULL) STRICT; INSERT OR IGNORE INTO settings VALUES (1, 0)');
  native.exec('CREATE TABLE IF NOT EXISTS deletion_calls (id TEXT PRIMARY KEY, harness_id TEXT NOT NULL, calls INTEGER NOT NULL, outcome TEXT NOT NULL) STRICT');
  const all = (): Native[] => native.prepare('SELECT body FROM sessions ORDER BY rowid').all().map(row => recordSchema.parse(JSON.parse(String(row.body))));
  const load = (id: string): Native => {
    const row = native.prepare('SELECT body FROM sessions WHERE id = ?').get(id);
    if (!row) throw new Error('fixture_native_identity_missing');
    return recordSchema.parse(JSON.parse(String(row.body)));
  };
  const save = (value: Native) => native.prepare('INSERT INTO sessions (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(value.id, JSON.stringify(recordSchema.parse(value)));
  function change(id: string, action: (value: Native) => void, notify = true) {
    native.exec('BEGIN IMMEDIATE');
    try { const value = load(id); action(value); if (notify) value.revision++; save(value); native.exec('COMMIT'); }
    catch (error) { native.exec('ROLLBACK'); throw error; }
  }
  function prove(value: Native) {
    const message = value.submissions.at(-1); if (!message) throw new Error('no_fixture_message');
    if (!value.items.some(item => item.operationId === message.id)) value.items.push({ id: 'user:' + message.id, kind: 'user', text: message.text, status: 'completed', runId: message.runId, operationId: message.id });
    value.hidden = false;
  }

  if (input.command !== 'serve') {
    try {
      if (input.command === 'fail-create') { native.prepare('UPDATE settings SET fail_create = 1 WHERE id = 1').run(); }
      else if (input.command === 'inspect-deletions') {
        console.log(JSON.stringify(native.prepare('SELECT id,harness_id AS harnessId,calls,outcome FROM deletion_calls ORDER BY id').all()));
        return;
      } else if (input.command === 'inspect') {
        console.log(JSON.stringify(all().filter(value => !input.title || value.title === input.title).map(value => ({ id: value.id, title: value.title, harnessId: value.harnessId, configuration: value.configuration, state: value.state, submitCalls: value.submitCalls, stopCalls: value.stopCalls, operationIds: value.submissions.map(item => item.id), rejectedOperationIds: value.rejectedOperationIds, nextReceipt: value.rejectNext ? 'rejected' : value.unknownReceipt ? 'unknown' : 'accepted', revision: value.revision, historyCount: value.items.length, offline: value.offline,
          subagents: value.subagents.map(agent => ({ id: agent.id, name: agent.name, status: agent.status })), subagentStopCalls: value.subagentStopCalls, nextSubagentStopReceipt: value.unknownSubagentStop ? 'unknown' : 'accepted' }))));
        return;
      } else {
        const matches = all().filter(value => value.title === input.title);
        if (matches.length !== 1) throw new Error('title_must_select_exactly_one_fixture_session');
        change(matches[0]!.id, value => {
          if (input.command === 'reject-delete-next') value.rejectDeleteNext = true;
          if (input.command === 'disable-skills') value.skillsDisabled = true;
          if (input.command === 'usage-full' || input.command === 'usage-compact') {
            value.usage = { total: 176_222_262, context: { used: input.command === 'usage-full' ? 188_743 : 83_886, capacity: 1_048_576, estimated: true } };
          }
          if (input.command === 'usage-total-only') value.usage = { total: 176_222_262 };
          if (input.command === 'spawn-subagents') {
            const at = Date.now(); const runId = value.state.runId ?? 'fixture-run:subagents';
            const created = Array.from({ length: Math.min(input.count, 8) }, (_, index) => {
              const number = value.subagents.length + index + 1;
              // Ids are unique per conversation so ownership checks can use another conversation's sub-agent.
              return { id: 'fixture-' + value.id.slice(0, 8) + '-agent-' + number, parentId: value.id, name: 'fixture_agent_' + number, task: '合成子任务 ' + number + '：整理资料', status: 'running' as const, startedAt: at,
                items: [{ id: 'agent-' + number + ':reply', kind: 'assistant' as const, text: 'FIXTURE SUBAGENT ' + number + ' 正在整理资料。', status: 'completed' as const, runId: 'agent-run-' + number },
                  { id: 'agent-' + number + ':tool', kind: 'tool' as const, text: '读取资料', status: 'running' as const, runId: 'agent-run-' + number, tool: { name: '运行命令', input: 'rg -n fixture notes.md' } }] };
            });
            value.subagents.push(...created); value.resultsPending = false;
            value.items.push({ id: 'collab:start:' + at, kind: 'notice', text: '派出子 Agent', status: 'completed', runId, collaboration: { action: 'started', agentIds: created.map(agent => agent.id) } });
          }
          if (input.command === 'complete-subagents') {
            const at = Date.now(); const done = value.subagents.filter(agent => agent.status === 'running');
            for (const agent of done) {
              agent.status = 'completed'; agent.endedAt = at;
              agent.items = agent.items.map(item => item.kind === 'tool' ? { ...item, status: 'completed', tool: { ...item.tool!, output: 'notes.md:1: fixture' } } : item);
              agent.items.push({ id: agent.id + ':done', kind: 'assistant', text: 'FIXTURE SUBAGENT DONE ' + agent.name, status: 'completed', runId: agent.items[0]!.runId! });
            }
            if (done.length) value.items.push({ id: 'collab:done:' + at, kind: 'notice', text: '子 Agent 已完成', status: 'completed', runId: value.state.runId ?? 'fixture-run:subagents', collaboration: { action: 'completed', agentIds: done.map(agent => agent.id) } });
            // Codex keeps results in the parent's mailbox when the parent turn already ended.
            value.resultsPending = value.harnessId === 'codex' && done.length > 0 && value.state.status !== 'running';
          }
          if (input.command === 'subagent-team') {
            value.team = { members: [{ id: 'lead', name: 'lead', status: value.state.status === 'running' ? 'running' : 'idle', lead: true },
              ...value.subagents.slice(0, 6).map(agent => ({ id: 'member-' + agent.id, name: agent.name, status: agent.status === 'running' ? 'running' as const : 'idle' as const, agentId: agent.id }))],
              tasks: value.subagents.slice(0, 6).map((agent, index) => ({ id: 'task-' + (index + 1), title: agent.task, description: '合成共享任务：' + agent.task + '，交付 work/' + agent.name + '.md。',
                status: agent.status === 'running' ? 'in_progress' as const : 'completed' as const, owner: agent.name, writeScopes: ['work/' + agent.name + '.md'] })) };
          }
          if (input.command === 'unknown-subagent-stop') value.unknownSubagentStop = true;
          if (input.command === 'disconnect') value.offline = true;
          if (input.command === 'reconnect') value.offline = false;
          if (input.command === 'repair') value.state = idle();
          if (input.command === 'unknown-receipt' || input.command === 'reject-next') {
            value.unknownReceipt = input.command === 'unknown-receipt'; value.rejectNext = input.command === 'reject-next';
          }
          if (input.command === 'prove' || input.command === 'complete') prove(value);
          if (input.command === 'complete') {
            if (value.state.status !== 'running') throw new Error('fixture_must_be_running');
            const runId = value.state.runId!;
            value.items.push({ id: 'assistant:' + runId, kind: 'assistant', text: 'FIXTURE COMPLETED ' + runId, status: 'completed', runId });
            value.state = { ...idle(), runId };
          }
          if (input.command === 'seed') {
            if (value.items.length || value.submissions.length) throw new Error('seed_requires_empty_conversation');
            if (input.count * input.chars > 12 * 1024 * 1024) throw new Error('fixture_seed_byte_budget');
            value.items = Array.from({ length: input.count }, (_, number): NativeItem => ({ id: 'history:' + number.toString().padStart(4, '0'), kind: 'assistant', status: 'completed', text: ('HISTORY ' + number.toString().padStart(4, '0') + ' ').padEnd(input.chars, 'x') }));
          }
        // Arming a future receipt does not change observed native state. An
        // invalidation here would briefly fence the very send being tested.
        }, !['unknown-receipt', 'reject-next', 'reject-delete-next', 'unknown-subagent-stop'].includes(input.command));
      }
      console.log(JSON.stringify({ event: input.command, title: input.title }));
    } finally { native.close(); }
    return;
  }

  const lock = join(root, 'app.lock');
  if (existsSync(lock)) {
    privateFile(lock);
    const pid = z.number().int().positive().parse(JSON.parse(readFileSync(lock, 'utf8')).pid);
    try { process.kill(pid, 0); throw new Error('fixture_app_already_alive'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    unlinkSync(lock);
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  const workspaces = ['a', 'b'].map(id => {
    const directory = join(root, 'workspace-' + id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return { id, label: 'Fixture ' + id.toUpperCase(), directory, managedWrites: true };
  });
  const timers = new Set<NodeJS.Timeout>();
  function adapter(id: HarnessId): HarnessAdapter {
    const checked = (binding: Binding) => { const value = load(binding.id); if (value.offline) throw new Error('fixture_disconnected'); return value; };
    const workspaceSkills = (binding: Pick<Binding, 'id' | 'cwd'>) => binding.cwd !== workspaces[0]!.directory ? []
      : ['zhi-proof', 'zhi-secondary'].map(name => nativeSkill(binding, { name, description: '合成验证技能' })!);
    function skills(binding: Binding) {
      const value = checked(binding);
      return value.skillsDisabled ? [] : workspaceSkills(binding);
    }
    async function submit(binding: Binding, operation: HarnessInput, delivery?: QueueDelivery): Promise<Receipt> {
      checked(binding);
      const resolved = operation.skills?.length ? resolveSkillInput(operation, skills(binding), '/') : { text: operation.text };
      if (!resolved) return { outcome: 'rejected', reason: 'skill_reference_unavailable' };
      let receipt: Receipt = { outcome: 'unknown', reason: 'fixture_receipt_lost' };
      change(binding.id, value => {
        if (value.submissions.some(item => item.id === operation.id) || value.rejectedOperationIds.includes(operation.id)) throw new Error('duplicate_fixture_dispatch');
        value.submitCalls++;
        const active = value.state.status === 'running' ? value.state.runId : undefined;
        const missed = delivery?.mode === 'current' && active !== delivery.target;
        const rejected = value.rejectNext; value.rejectNext = false;
        if (rejected || missed) {
          value.rejectedOperationIds.push(operation.id);
          receipt = { outcome: 'rejected', reason: missed ? 'native_run_changed' : 'Fixture 拒绝了本次输入，未接收执行。' };
          return;
        }
        const runId = delivery && delivery.mode !== 'next' && active ? active : 'fixture-run:' + operation.id;
        value.submissions.push({ id: operation.id, text: resolved.text, runId });
        const unknown = value.unknownReceipt; value.unknownReceipt = false; value.hidden = unknown;
        value.state = { status: 'running', runId, pendingInputs: 0, configurationVerified: true };
        if (!unknown) { prove(value); receipt = delivery ? { outcome: 'accepted' } : { outcome: 'accepted', runId }; }
      });
      return receipt;
    }
    return {
      id, earlyInput: id === 'codex' ? 'current' : 'soon', submit, submitQueued: submit,
      async skills(binding) { return skillOptions(skills(binding)); },
      // Codex can discover skills by cwd before a thread; the pinned DSH RPC requires a session.
      ...(id === 'codex' ? { async draftSkills(cwd: string) {
        return skillOptions(workspaceSkills({ id: 'draft', cwd }).map(skill => ({ ...skill, id: skill.draftId! })));
      } } : {}),
      async catalog() {
        const reasoningEfforts = (id === 'codex' ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : ['off', 'low', 'high', 'max']).map(effort => ({ id: effort, label: effort }));
        return { id, available: true, ...(id === 'codex' ? { defaultModelId: 'fixture-model' } : {}), models: [
          { id: 'fixture-model', label: 'Fixture · 非真实模型', reasoningEfforts, ...(id === 'codex' ? { defaultReasoningEffort: 'medium' } : {}) },
          { id: 'fixture-alternate', label: 'Fixture Alternate · 非真实模型', reasoningEfforts: reasoningEfforts.slice(0, 3), ...(id === 'codex' ? { defaultReasoningEffort: 'low' } : {}) },
        ], permissions: [{ id: 'fixture-write', label: 'Fixture write', description: 'Synthetic boundary; no actual agent execution.' }, { id: 'fixture-read', label: 'Fixture read', description: 'Synthetic configuration selection only.' }] }; },
      ...(id === 'dsh' ? { async prepareDraft(input: { id: string; cwd: string }) {
        const row = native.prepare('SELECT body FROM sessions WHERE id=?').get(input.id);
        if (!row) {
          save({ id: input.id, title: 'Prepared draft', harnessId: id, cwd: input.cwd, configuration: { modelId: 'fixture-model', permissionId: 'fixture-read' }, state: idle(), items: [], submissions: [], rejectedOperationIds: [], rejectNext: false, submitCalls: 0, stopCalls: 0, offline: false, unknownReceipt: false, hidden: false, revision: 0, subagents: [], resultsPending: false, subagentStopCalls: 0, unknownSubagentStop: false });
        }
        const value = load(input.id);
        if (value.cwd !== input.cwd || value.submissions.length) throw new Error('fixture_prepared_not_empty');
        return skillOptions(skills({ id: value.id, cwd: value.cwd, configuration: value.configuration, details: {} }));
      } } : {}),
      async create(input, onBound) {
        if (input.preparedId) { const previous = load(input.preparedId); if (previous.cwd !== input.cwd || previous.harnessId !== id || previous.submissions.length) throw new Error('fixture_prepared_not_empty'); }
        const fail = native.prepare('SELECT fail_create FROM settings WHERE id = 1').get()!.fail_create === 1;
        native.prepare('UPDATE settings SET fail_create = 0 WHERE id = 1').run();
        const value: Native = { id: input.preparedId ?? randomUUID(), title: input.title ?? 'Untitled', harnessId: id, cwd: input.cwd, configuration: input.configuration, state: fail ? { ...idle(), status: 'unknown', configurationVerified: false } : idle(), items: [], submissions: [], rejectedOperationIds: [], rejectNext: false, submitCalls: 0, stopCalls: 0, offline: false, unknownReceipt: false, hidden: false, revision: 0, subagents: [], resultsPending: false, subagentStopCalls: 0, unknownSubagentStop: false };
        save(value);
        const binding: Binding = { id: value.id, cwd: input.cwd, configuration: input.configuration, details: {} };
        onBound(binding);
        if (fail) throw new Error('fixture_configuration_failed_after_binding');
        return binding;
      },
      async state(binding, target) {
        const value = checked(binding);
        return { ...value.state, ...(target && value.items.some(item => item.runId === target && item.kind === 'assistant' && item.status === 'completed') ? { terminalRunId: target, terminalStatus: 'completed' as const } : {}) };
      },
      async history(binding, cursor, limit = 100) {
        const value = checked(binding); const end = cursor === undefined ? value.items.length : z.coerce.number().int().min(0).max(value.items.length).parse(cursor);
        const start = Math.max(0, end - limit);
        return { items: value.items.slice(start, end), olderCursor: start ? String(start) : null, ...(cursor === undefined && value.usage ? { usage: value.usage } : {}) };
      },
      async reconcile(binding, operationId) {
        const value = checked(binding); const message = value.submissions.find(item => item.id === operationId);
        return message && !value.hidden ? { outcome: 'accepted', runId: message.runId } : { outcome: 'unknown', reason: 'fixture_proof_unavailable' };
      },
      async stop(binding, runId) {
        checked(binding);
        change(binding.id, value => { if (value.state.runId !== runId) throw new Error('fixture_wrong_stop_target'); value.stopCalls++; prove(value); value.state = { ...idle(), status: 'interrupted', runId }; });
        return { outcome: 'accepted', runId };
      },
      async delete(binding) {
        z.uuid().parse(binding.id);
        let outcome = 'completed';
        native.exec('BEGIN IMMEDIATE');
        try {
          const row = native.prepare('SELECT body FROM sessions WHERE id=?').get(binding.id);
          if (row) {
            const value = recordSchema.parse(JSON.parse(String(row.body)));
            if (value.harnessId !== id || value.cwd !== binding.cwd) throw new Error('fixture_binding_mismatch');
            if (value.offline) outcome = 'offline';
            else if (value.rejectDeleteNext) { outcome = 'rejected'; value.rejectDeleteNext = false; save(value); }
            else if (['running', 'waiting', 'unknown'].includes(value.state.status) || value.state.pendingInputs) outcome = 'busy';
            else native.prepare('DELETE FROM sessions WHERE id=?').run(binding.id);
          }
          native.prepare('INSERT INTO deletion_calls(id,harness_id,calls,outcome) VALUES(?,?,1,?) ON CONFLICT(id) DO UPDATE SET calls=calls+1,outcome=excluded.outcome').run(binding.id, id, outcome);
          native.exec('COMMIT');
        } catch (error) { native.exec('ROLLBACK'); throw error; }
        if (outcome !== 'completed') throw new Error('fixture_delete_' + outcome);
      },
      async subagents(binding) {
        const value = checked(binding);
        return { agents: value.subagents.map(({ items: _items, ...agent }) => agent), ...(value.team ? { team: value.team } : {}), resultsPending: value.resultsPending };
      },
      async subagentHistory(binding, agentId) {
        const agent = checked(binding).subagents.find(item => item.id === agentId);
        if (!agent) throw new HarnessError('subagent_not_owned');
        return { brief: '主 Agent 交代：' + agent.task + '。完成后交付整理结果。', items: agent.items, olderCursor: null };
      },
      async observeSubagent(binding, agentId) {
        if (!checked(binding).subagents.some(item => item.id === agentId)) throw new HarnessError('subagent_not_owned');
        return () => {};
      },
      async stopSubagent(binding, agentId) {
        checked(binding);
        let receipt: Receipt = { outcome: 'accepted' };
        change(binding.id, value => {
          const agent = value.subagents.find(item => item.id === agentId);
          if (!agent) throw new HarnessError('subagent_not_owned');
          if (agent.status !== 'running') { receipt = { outcome: 'rejected', reason: 'subagent_not_running' }; return; }
          value.subagentStopCalls++;
          // A lost request never reached the native side: the agent keeps running and the receipt is unknown.
          if (value.unknownSubagentStop) { value.unknownSubagentStop = false; receipt = { outcome: 'unknown', reason: 'fixture_receipt_lost' }; return; }
          agent.status = 'interrupted'; agent.endedAt = Date.now();
          agent.items = agent.items.map(item => item.status === 'running' ? { ...item, status: 'failed' } : item);
        });
        return receipt;
      },
      async watch(binding, listener) {
        let revision = load(binding.id).revision;
        const timer = setInterval(() => {
          try { const next = load(binding.id).revision; if (next !== revision) { revision = next; listener({ type: 'invalidate' }); listener({ type: 'subagents' }); } }
          catch { listener({ type: 'invalidate' }); }
        }, 100);
        timers.add(timer);
        return () => { clearInterval(timer); timers.delete(timer); };
      },
      async close() { for (const timer of timers) clearInterval(timer); timers.clear(); },
    };
  }

  const db = openDatabase(join(root, 'data'), productMigrations);
  const directory = join(root, 'workspace-roots');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, 'existing'), { recursive: true, mode: 0o700 });
  const registry = new WorkspaceRegistry(db, workspaces, [{ id: 'fixture-root', label: 'Fixture directories', directory }]);
  let transport: ReturnType<typeof createWorkbenchHttp> | undefined;
  const store = createWorkbenchStore(db, { onChange: event => transport?.changed(event) });
  const workbench = new Workbench(store, workspaces, new Map<HarnessId, HarnessAdapter>([['codex', adapter('codex')], ['dsh', adapter('dsh')]]), registry);
  transport = createWorkbenchHttp(workbench);
  const origin = 'http://127.0.0.1:' + input.port;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10_000).unref();
    try { transport!.close(); await workbench.close(); await app?.close(); db.close(); native.close(); unlinkSync(lock); clearTimeout(timeout); console.log(JSON.stringify({ event: 'stopped', pid: process.pid })); }
    catch { process.exitCode = 1; }
  };
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  try {
    const metadata = z.object({ name: z.literal('zhongshu'), version: z.string(), revision: z.string() }).parse(JSON.parse(readFileSync(join(repository, 'dist/version.json'), 'utf8')));
    app = await buildApp({ db, origin, assetsDirectory: join(repository, 'dist/public'), metadata, privateRoutes: transport.routes, onLogout: transport.logout });
    await workbench.start(); await app.listen({ host: '127.0.0.1', port: input.port });
    console.log(JSON.stringify({ event: 'ready', mode: 'fixture', pid: process.pid, root, origin, revision: metadata.revision }));
  } catch (error) { await stop(); throw error; }
}

main().catch(error => { console.error(JSON.stringify({ event: 'fixture_failed', reason: error instanceof z.ZodError ? 'invalid_arguments_or_fixture_state' : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'fixture_operation_failed' })); process.exitCode = 1; });

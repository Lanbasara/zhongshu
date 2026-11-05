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
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appendFile, stat } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Binding, HarnessAdapter, HarnessId, HarnessInput, NativeItem, NativeState, Receipt } from '../../src/harness/types.ts';
import { nativeSkill, resolveSkillInput, skillOptions } from '../../src/harness/skills.ts';
import type { QueueDelivery } from '../../src/shared/workbench.ts';
import { buildApp } from '../../src/server/app.ts';
import { createStorageClient } from '../../src/server/storage-client.ts';
import { DirectoryIndex } from '../../src/server/directory-index.ts';
import { managedUiFixture } from './managed-ui-fixture.ts';
import { Workbench } from '../../src/server/workbench.ts';
import { createWorkbenchHttp } from '../../src/server/workbench-http.ts';
import { WorkspaceRegistry } from '../../src/server/workspace-registry.ts';
import { itemSchema, stateSchema, usageSchema } from '../../src/shared/workbench.ts';
import type { createPhysicalArchiveFixture } from './native-archive-fixture.ts';

process.umask(0o077);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const cliSchema = z.object({
  command: z.enum(['serve', 'init', 'reset', 'inspect', 'complete', 'prove', 'seed', 'seed-turn-files', 'disconnect', 'reconnect', 'unknown-receipt', 'reject-next', 'fail-create', 'repair', 'disable-skills', 'usage-full', 'usage-compact', 'usage-total-only']),
  root: z.string().min(1).max(4096).refine(isAbsolute),
  port: z.coerce.number().int().min(1024).max(65535).default(4391),
  host: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  build: z.string().refine(isAbsolute).optional(),
  physical: z.boolean().default(false),
  managed: z.boolean().default(false),
  sampleMs: z.coerce.number().int().min(1000).max(60_000).default(30_000),
  title: z.string().min(1).max(200).optional(),
  count: z.coerce.number().int().min(1).max(700).default(650),
  chars: z.coerce.number().int().min(32).max(80_000).default(80),
  pathPadding: z.coerce.number().int().min(0).max(800).default(0),
  separateRuns: z.boolean().default(false),
});
const recordSchema = z.object({
  id: z.uuid(), title: z.string().max(200), harnessId: z.enum(['codex', 'dsh']),
  cwd: z.string().max(4096), configuration: z.object({ modelId: z.string(), permissionId: z.string() }),
  state: stateSchema, items: z.array(itemSchema.extend({ fileEdits: z.array(z.string().max(4096)).max(700).optional() })).max(1000),
  submissions: z.array(z.object({ id: z.string(), text: z.string().max(16_000), runId: z.string() })).max(100),
  rejectedOperationIds: z.array(z.uuid()).max(100).default([]), rejectNext: z.boolean().default(false),
  submitCalls: z.number().int().min(0), stopCalls: z.number().int().min(0),
  offline: z.boolean(), unknownReceipt: z.boolean(), hidden: z.boolean(), revision: z.number().int().min(0),
  skillsDisabled: z.boolean().optional(), usage: usageSchema.optional(),
});
type Native = z.infer<typeof recordSchema>;
const idle = (): NativeState => ({ status: 'idle', pendingInputs: 0, configurationVerified: true });

function privateFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('unsafe_fixture_file');
}

async function main() {
  const args = parseArgs({ options: { root: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, build: { type: 'string' }, physical: { type: 'boolean' }, managed: { type: 'boolean' }, sampleMs: { type: 'string' }, title: { type: 'string' }, count: { type: 'string' }, chars: { type: 'string' }, pathPadding: { type: 'string' }, separateRuns: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: true, strict: true });
  if (args.values.help) {
    console.log(`node test/support/feature-fixture.ts <${cliSchema.shape.command.options.join('|')}> --root ABSOLUTE_DIRECTORY [--port 4391] [--managed] [--title TITLE] [--count 650 --chars 80] [--pathPadding 700 --separateRuns]`);
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
      else if (input.command === 'inspect') {
        console.log(JSON.stringify(all().filter(value => !input.title || value.title === input.title).map(value => ({ id: value.id, title: value.title, harnessId: value.harnessId, configuration: value.configuration, state: value.state, submitCalls: value.submitCalls, stopCalls: value.stopCalls, operationIds: value.submissions.map(item => item.id), rejectedOperationIds: value.rejectedOperationIds, nextReceipt: value.rejectNext ? 'rejected' : value.unknownReceipt ? 'unknown' : 'accepted', revision: value.revision, historyCount: value.items.length, offline: value.offline }))));
        return;
      } else {
        const matches = all().filter(value => value.title === input.title);
        if (matches.length !== 1) throw new Error('title_must_select_exactly_one_fixture_session');
        change(matches[0]!.id, value => {
          if (input.command === 'disable-skills') value.skillsDisabled = true;
          if (input.command === 'usage-full' || input.command === 'usage-compact') {
            value.usage = { total: 176_222_262, context: { used: input.command === 'usage-full' ? 188_743 : 83_886, capacity: 1_048_576, estimated: true } };
          }
          if (input.command === 'usage-total-only') value.usage = { total: 176_222_262 };
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
          if (input.command === 'seed-turn-files') {
            if (value.items.length || value.submissions.length) throw new Error('seed_requires_empty_conversation');
            if (![join(root, 'workspace-a'), join(root, 'workspace-b')].includes(value.cwd)) throw new Error('fixture_workspace_required');
            const base = 'turn-files-' + value.id;
            // Generated padding uses bounded path segments, never caller-supplied paths.
            const padding = Array.from({ length: Math.ceil(input.pathPadding / 180) }, (_, index) => 'p'.repeat(Math.min(180, input.pathPadding - index * 180)));
            const paths = Array.from({ length: input.count }, (_, number) => [base, ...padding, String(number).padStart(4, '0'), 'sample.txt'].join('/'));
            for (const [number, path] of paths.entries()) {
              mkdirSync(dirname(join(value.cwd, path)), { recursive: true, mode: 0o700 });
              writeFileSync(join(value.cwd, path), `SYNTHETIC TURN FILE ${number}\n`, { flag: 'wx', mode: 0o600 });
            }
            const run = (index: number) => 'fixture-files:' + value.id + (input.separateRuns ? ':' + String(index).padStart(4, '0') : '');
            const pageSize = input.separateRuns ? 1 : 100;
            value.items = Array.from({ length: Math.ceil(paths.length / pageSize) }, (_, page) => ({
              id: 'fixture-file-edits-' + page, kind: 'tool' as const, status: 'completed' as const, runId: run(page),
              text: 'Synthetic edit evidence; no native execution.', tool: { name: 'fixture-write' }, fileEdits: paths.slice(page * pageSize, (page + 1) * pageSize),
            }));
            const runId = run(value.items.length - 1);
            value.items.push({ id: 'fixture-file-finish', kind: 'assistant', status: 'completed', runId, text: 'Fixture files ready.' });
            value.state = { ...idle(), runId };
          }
        // Arming a future receipt does not change observed native state. An
        // invalidation here would briefly fence the very send being tested.
        }, !['unknown-receipt', 'reject-next'].includes(input.command));
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
  const createPhysical = input.physical ? (await import('./native-archive-fixture.ts')).createPhysicalArchiveFixture : undefined;
  const physical: Awaited<ReturnType<typeof createPhysicalArchiveFixture>>[] = createPhysical ? await Promise.all((['codex', 'dsh'] as const).map(harness => createPhysical({
    root: join(root, 'physical-' + harness), cwd: workspaces[0]!.directory, harness, bindingId: 'physical-' + harness, count: 20_000,
  }))) : [];
  function adapter(id: HarnessId): HarnessAdapter {
    const checked = (binding: Binding) => { const value = load(binding.id); if (value.offline) throw new Error('fixture_disconnected'); return value; };
    function skills(binding: Binding) {
      const value = checked(binding);
      if (value.skillsDisabled || binding.cwd !== workspaces[0]!.directory) return [];
      return ['zhi-proof', 'zhi-secondary'].map(name => nativeSkill(binding, { name, description: '合成验证技能' })!);
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
    const synthetic: HarnessAdapter = {
      id, historyReadOnly: true, earlyInput: id === 'codex' ? 'current' : 'soon', submit, submitQueued: submit,
      async skills(binding) { return skillOptions(skills(binding)); },
      async catalog() { return { id, available: true, models: [{ id: 'fixture-model', label: 'Fixture · 非真实模型' }], permissions: [{ id: 'fixture-write', label: 'Fixture write', description: 'Synthetic boundary; no actual agent execution.' }, { id: 'fixture-read', label: 'Fixture read', description: 'Synthetic configuration selection only.' }] }; },
      async create(input, onBound) {
        const fail = native.prepare('SELECT fail_create FROM settings WHERE id = 1').get()!.fail_create === 1;
        native.prepare('UPDATE settings SET fail_create = 0 WHERE id = 1').run();
        const value: Native = { id: randomUUID(), title: input.title ?? 'Untitled', harnessId: id, cwd: input.cwd, configuration: input.configuration, state: fail ? { ...idle(), status: 'unknown', configurationVerified: false } : idle(), items: [], submissions: [], rejectedOperationIds: [], rejectNext: false, submitCalls: 0, stopCalls: 0, offline: false, unknownReceipt: false, hidden: false, revision: 0 };
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
      async readItems(binding, ids) { return checked(binding).items.filter(item => ids.includes(item.id)); },
      async historyChanges(binding, cursor, limit = 16) {
        const value = checked(binding); z.number().int().min(1).max(16).parse(limit);
        const prior = cursor ? z.object({ binding: z.literal(binding.id), revision: z.number().int().nonnegative(), after: z.number().int().min(0).max(1000) }).strict()
          .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString())) : undefined;
        // The finite synthetic peer has no append log. Re-scan its bounded item
        // array after each revision; real physical sources use their append feed.
        const after = prior?.revision === value.revision ? prior.after : 0;
        const items = value.items.slice(after, after + limit), next = after + items.length;
        return { itemIds: items.map(item => item.id), cursor: Buffer.from(JSON.stringify({ binding: binding.id, revision: value.revision, after: next })).toString('base64url'), hasMore: next < value.items.length };
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
      async watch(binding, listener) {
        let revision = load(binding.id).revision;
        const timer = setInterval(() => {
          try { const next = load(binding.id).revision; if (next !== revision) { revision = next; listener({ type: 'invalidate' }); } }
          catch { listener({ type: 'invalidate' }); }
        }, 100);
        timers.add(timer);
        return () => { clearInterval(timer); timers.delete(timer); };
      },
      async close() { for (const timer of timers) clearInterval(timer); timers.clear(); },
    };
    const source = physical.find(value => value.binding.id === 'physical-' + id);
    if (!source) return synthetic;
    const owns = (binding: Binding) => binding.id === source.binding.id;
    return { ...synthetic,
      state: (binding, target) => owns(binding) ? Promise.resolve(idle()) : synthetic.state(binding, target),
      watch: (binding, listener) => owns(binding) ? Promise.resolve(() => {}) : synthetic.watch(binding, listener),
      history: (binding, ...args) => owns(binding) ? source.reads.history(binding, ...args) : synthetic.history(binding, ...args),
      historyChanges: (binding, ...args) => owns(binding) ? source.reads.historyChanges!(binding, ...args) : synthetic.historyChanges!(binding, ...args),
      readItems: (binding, ids) => owns(binding) ? source.reads.readItems!(binding, ids) : synthetic.readItems!(binding, ids),
      readBodyChunk: source.reads.readBodyChunk, releaseBodySource: source.reads.releaseBodySource, readImage: source.reads.readImage,
      async close() { await synthetic.close(); await source.close(); },
    };
  }

  let transport: ReturnType<typeof createWorkbenchHttp> | undefined;
  const storage = createStorageClient({ dataDirectory: join(root, 'data'), onChange: event => transport?.changed(event), onReset: () => transport?.invalidate() });
  await storage.ready;
  const directories = new DirectoryIndex(join(root, 'data/directory-index'));
  const directory = join(root, 'workspace-roots');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, 'existing'), { recursive: true, mode: 0o700 });
  const registry = new WorkspaceRegistry(storage.workspaces, workspaces, [{ id: 'fixture-root', label: 'Fixture directories', directory }]);
  await registry.ready;
  const adapters = new Map<HarnessId, HarnessAdapter>([['codex', adapter('codex')], ['dsh', adapter('dsh')]]);
  const managed = input.managed ? managedUiFixture(storage, native, root, adapters, id => all().some(value => value.harnessId === id && ['running', 'waiting'].includes(value.state.status))) : {};
  const workbench = new Workbench(storage.store, workspaces, adapters, registry, directories, managed);
  const physicalIds: { harness: HarnessId; id: string }[] = [];
  for (const source of physical) {
    const harness = source.binding.id === 'physical-codex' ? 'codex' : 'dsh';
    const identityPath = join(root, 'private', harness + '-physical-conversation');
    if (!existsSync(identityPath)) writeFileSync(identityPath, randomUUID(), { flag: 'wx', mode: 0o600 });
    privateFile(identityPath); const id = z.uuid().parse(readFileSync(identityPath, 'utf8'));
    if (!await storage.store.getConversation(id)) {
      await storage.store.createConversation({ id, harnessId: harness, workspaceId: 'a', cwd: source.binding.cwd, configuration: source.binding.configuration, title: 'Physical archive ' + harness });
      await storage.store.saveBinding(id, source.binding);
      await storage.store.setConversationState(id, { readiness: 'ready', state: idle() });
    }
    physicalIds.push({ harness, id });
  }
  transport = createWorkbenchHttp(workbench);
  const origin = 'http://127.0.0.1:' + input.port;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let stopping = false;
  let sampleTask: Promise<void> | undefined;
  const loopDelay = input.physical ? monitorEventLoopDelay({ resolution: 10 }) : undefined;
  loopDelay?.enable(); let previousUtilization = performance.eventLoopUtilization();
  let samples = 0;
  const stop = async () => {
    if (stopping) return; stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10_000).unref();
    try { for (const timer of timers) clearInterval(timer); await sampleTask; loopDelay?.disable(); transport!.close(); await workbench.close(); await app?.close(); await storage.close(); await directories.close(); native.close(); unlinkSync(lock); clearTimeout(timeout); console.log(JSON.stringify({ event: 'stopped', pid: process.pid })); }
    catch { process.exitCode = 1; }
  };
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  try {
    const buildDirectory = input.build ?? join(repository, 'dist');
    const metadata = z.object({ name: z.literal('zhongshu'), version: z.string(), revision: z.string() }).parse(JSON.parse(readFileSync(join(buildDirectory, 'version.json'), 'utf8')));
    app = await buildApp({ authStore: storage.auth, readiness: () => storage.diagnostics().phase === 'ready', origin, assetsDirectory: join(buildDirectory, 'public'), metadata, privateRoutes: transport.routes, onLogout: transport.logout });
    await workbench.start(); await app.listen({ host: input.host, port: input.port });
    if (input.physical) {
      writeFileSync(join(root, 'private/physical-conversations.json'), JSON.stringify(physicalIds), { mode: 0o600 });
      const timer = setInterval(() => {
        if (sampleTask || stopping) return;
        sampleTask = (async () => {
          const utilization = performance.eventLoopUtilization(previousUtilization); previousUtilization = performance.eventLoopUtilization();
          const sizes: Record<string, number> = {};
          for (const name of ['zhongshu.sqlite', 'zhongshu.sqlite-wal', 'zhongshu.sqlite-shm']) sizes[name] = await stat(join(root, 'data', name)).then(value => value.size, () => 0);
          const archives = await Promise.all(physicalIds.map(async value => ({ ...value, jobs: await storage.store.archiveJobs(value.id) })));
          const sample = { time: new Date().toISOString(), uptimeSeconds: process.uptime(), memory: process.memoryUsage(),
            eventLoop: { utilization: utilization.utilization, p95Ms: loopDelay!.percentile(95) / 1e6, maxMs: loopDelay!.max / 1e6 },
            storage: storage.diagnostics(), files: sizes, archives, native: await Promise.all(physical.map(value => value.manifest())) };
          loopDelay!.reset(); await appendFile(join(root, 'private/performance-service.ndjson'), JSON.stringify(sample) + '\n', { mode: 0o600 });
          // Fixed new input every ten samples keeps import active after initial
          // backfill. Only synthetic native files are appended, never product rows.
          if (++samples % 10 === 0) for (const source of physical) await source.appendGap(100);
        })().catch(async () => { await appendFile(join(root, 'private/performance-service.ndjson'), JSON.stringify({ time: new Date().toISOString(), failure: 'performance_sample_failed', storage: storage.diagnostics() }) + '\n', { mode: 0o600 }); }).finally(() => { sampleTask = undefined; });
      }, input.sampleMs); timer.unref(); timers.add(timer);
    }
    console.log(JSON.stringify({ event: 'ready', mode: 'fixture', managed: input.managed, pid: process.pid, root, origin, revision: metadata.revision }));
  } catch (error) { await stop(); throw error; }
}

main().catch(error => { console.error(JSON.stringify({ event: 'fixture_failed', reason: error instanceof z.ZodError ? 'invalid_arguments_or_fixture_state' : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'fixture_operation_failed' })); process.exitCode = 1; });

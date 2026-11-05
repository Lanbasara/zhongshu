/**
 * Reproducible service baselines, not native Harness or browser acceptance.
 * Trust boundary: trusted local CLI, synthetic HarnessAdapter, real Workbench,
 * SQLite and workspace files. Never loads instance config or writes business
 * tables directly. Only newly allocated private temporary roots are removed.
 * Explicit JSON destinations are new files in existing canonical directories.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { arch, availableParallelism, platform, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { Binding, Catalog, Configuration, HarnessAdapter, HistoryPage, NativeChange, NativeItem, NativeState, Receipt } from '../../src/harness/types.ts';
import { openDatabase } from '../../src/server/database.ts';
import { productMigrations } from '../../src/server/migrations.ts';
import { createWorkbenchStore } from '../../src/server/workbench-store.ts';
import { Workbench } from '../../src/server/workbench.ts';
import { DirectoryIndex } from '../../src/server/directory-index.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const scenarioSchema = z.enum(['workspace-edit', 'history-catchup', 'directory']);
export type BaselineScenario = z.infer<typeof scenarioSchema>;
const optionsSchema = z.object({
  scenarios: z.array(scenarioSchema).min(1).max(3).refine(values => new Set(values).size === values.length).default([...scenarioSchema.options]),
  conversations: z.number().int().min(1).max(256).default(40),
  cachedItems: z.number().int().min(1).max(100).default(100),
  offlineItems: z.number().int().min(1).max(5000).default(2001),
  files: z.number().int().min(1).max(2001).default(201),
  observationMs: z.number().int().min(20).max(10_000).default(1000),
  reconciliationAttempts: z.number().int().min(1).max(10).default(3),
}).strict();
type Options = z.infer<typeof optionsSchema>;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Observation = {
  expected: Record<string, Json>;
  actual: Record<string, Json>;
  checks: Record<string, boolean>;
  metrics: Record<string, number>;
};
export type BaselineResult = Observation & {
  scenario: BaselineScenario;
  status: 'satisfied' | 'boundary-observed' | 'scenario-error';
  elapsedMs: number;
  error?: string;
  cleanup: { workbenchesClosed: boolean; databasesClosed: boolean; indexWorkersClosed: boolean; rootsRemoved: boolean; subscriptionsClosed: boolean; errors: string[] };
};

const configuration = { modelId: 'baseline-model', permissionId: 'baseline-write' };
const idle = (): NativeState => ({ status: 'idle', pendingInputs: 0, configurationVerified: true });
const historyId = (index: number) => 'baseline-item-' + index.toString().padStart(6, '0');
const historyText = (index: number) => 'SYNTHETIC HISTORY ' + index.toString().padStart(6, '0');
const fixtureHistory = (count: number): NativeItem[] => Array.from({ length: count }, (_, index) => ({
  id: historyId(index), kind: 'assistant', status: 'completed', text: historyText(index),
}));
const elapsed = (start: number) => Math.round((performance.now() - start) * 1000) / 1000;
function errorCode(error: unknown): string {
  const candidate = error instanceof Error && 'code' in error ? error.code : error instanceof Error ? error.message : '';
  return typeof candidate === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(candidate) ? candidate : 'baseline_operation_failed';
}

/** State survives application restart, like a separately owned native Host. */
class SyntheticHost {
  sessions = new Map<string, NativeItem[]>();
  initialItems: NativeItem[] = [];
  next = 0;
}

class BaselineHarness implements HarnessAdapter {
  // This substitute only removes a listener; no runtime or process is owned by it.
  readonly observationReleaseSafe = true;
  readonly id = 'codex' as const;
  readonly host: SyntheticHost;
  listeners = new Set<(change: NativeChange) => void>();
  stateCalls = 0; historyCalls = 0; historyItems = 0; watchCalls = 0; peakSubscriptions = 0;
  closed = false;
  constructor(host: SyntheticHost) { this.host = host; }
  private items(binding: Binding) {
    if (this.closed) throw new Error('baseline_harness_closed');
    const value = this.host.sessions.get(binding.id);
    if (!value) throw new Error('baseline_binding_missing');
    return value;
  }
  async catalog(): Promise<Catalog> { return { id: this.id, available: true, models: [{ id: configuration.modelId, label: 'Synthetic baseline; not a model' }], permissions: [{ id: configuration.permissionId, label: 'Synthetic write', description: 'No agent execution' }] }; }
  async create(input: { cwd: string; configuration: Configuration }, onBound: (binding: Binding) => void): Promise<Binding> {
    const binding = { id: 'baseline-native-' + ++this.host.next, cwd: input.cwd, configuration: input.configuration, details: {} };
    this.host.sessions.set(binding.id, structuredClone(this.host.initialItems));
    onBound(binding); return binding;
  }
  async state(binding: Binding): Promise<NativeState> { this.items(binding); this.stateCalls++; return idle(); }
  async history(binding: Binding, cursor?: string, limit = 100): Promise<HistoryPage> {
    const items = this.items(binding);
    const end = cursor === undefined ? items.length : z.coerce.number().int().min(0).max(items.length).parse(cursor);
    const size = z.number().int().min(1).max(1000).parse(limit);
    const start = Math.max(0, end - size);
    this.historyCalls++; this.historyItems += end - start;
    return { items: structuredClone(items.slice(start, end)), olderCursor: start ? String(start) : null };
  }
  async submit(): Promise<Receipt> { throw new Error('baseline_unexpected_submission'); }
  async reconcile(): Promise<Receipt> { throw new Error('baseline_unexpected_receipt_reconciliation'); }
  async stop(): Promise<Receipt> { throw new Error('baseline_unexpected_stop'); }
  async watch(binding: Binding, listener: (change: NativeChange) => void) {
    this.items(binding); this.watchCalls++; this.listeners.add(listener);
    this.peakSubscriptions = Math.max(this.peakSubscriptions, this.listeners.size);
    return () => { this.listeners.delete(listener); };
  }
  async close() { this.closed = true; this.listeners.clear(); }
}

type Instance = Awaited<ReturnType<typeof startInstance>>;
async function startInstance(root: string, workspace: string, host: SyntheticHost) {
  const db = openDatabase(join(root, 'data'), productMigrations);
  let directoryIndex: DirectoryIndex | undefined;
  try {
    const store = createWorkbenchStore(db);
    const peer = new BaselineHarness(host);
    directoryIndex = new DirectoryIndex(join(root, 'directory-index'));
    const workbench = new Workbench(store, [{ id: 'baseline', label: 'Synthetic baseline', directory: workspace, managedWrites: true }], new Map([['codex', peer]]), undefined, directoryIndex);
    return { db, store, peer, workbench, directoryIndex, workbenchClosed: false, databaseClosed: false, indexClosed: false };
  } catch (error) { await directoryIndex?.close(); db.close(); throw error; }
}
async function closeInstance(instance: Instance) {
  if (!instance.workbenchClosed) { await instance.workbench.close(); instance.workbenchClosed = true; }
  if (!instance.indexClosed) { await instance.directoryIndex.close(); instance.indexClosed = true; }
  if (!instance.databaseClosed) { instance.db.close(); instance.databaseClosed = true; }
}
async function createReady(instance: Instance) {
  const id = randomUUID();
  await instance.workbench.create({ id, harnessId: 'codex', workspaceId: 'baseline', configuration });
  const deadline = performance.now() + 5000;
  while (instance.store.getConversation(id)?.readiness !== 'ready') {
    if (instance.store.getConversation(id)?.readiness === 'blocked') throw new Error('baseline_preparation_blocked');
    if (performance.now() > deadline) throw new Error('baseline_preparation_timeout');
    await delay(1);
  }
  // Let the tracked prepare task finish before creating the next conversation.
  await delay(0);
  return id;
}

async function readAllCached(instance: Instance, id: string): Promise<NativeItem[]> {
  const pages: NativeItem[][] = []; const seen = new Set<string>();
  let before: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = (await instance.workbench.snapshot(id, before)).history;
    pages.push(result.items);
    if (!result.olderBeforeItemId) return pages.reverse().flat();
    if (seen.has(result.olderBeforeItemId)) throw new Error('baseline_cached_cursor_cycle');
    seen.add(result.olderBeforeItemId); before = result.olderBeforeItemId;
  }
  throw new Error('baseline_cached_page_budget');
}

async function workspaceEdit(instance: Instance, workspace: string, options: Options): Promise<Observation> {
  await writeFile(join(workspace, 'edit.txt'), 'before\n', { mode: 0o600, flag: 'wx' });
  const ids: string[] = [];
  for (let index = 0; index < options.conversations; index++) ids.push(await createReady(instance));
  const deadline = performance.now() + options.observationMs;
  const started = performance.now(); const beforeCalls = instance.peer.stateCalls;
  let polls = 0; let status;
  do {
    status = await instance.workbench.workspaceEditStatus('baseline'); polls++;
    if (status.editable) break;
    await delay(10);
  } while (performance.now() < deadline);
  let saveError: string | null = null;
  const document = await instance.workbench.openWorkspaceFile('baseline', 'edit.txt');
  try { await instance.workbench.saveWorkspaceFile('baseline', 'edit.txt', document.version, 'after\n'); }
  catch (error) { saveError = errorCode(error); }
  const saved = await readFile(join(workspace, 'edit.txt'), 'utf8') === 'after\n';
  const idleCount = ids.filter(id => instance.store.getConversation(id)?.state.status === 'idle').length;
  return {
    expected: { conversations: options.conversations, nativeIdle: options.conversations, editable: true, fileSaved: true },
    actual: { conversations: ids.length, idleCount, editable: status!.editable, reason: status!.reason, fileSaved: saved, saveError, activeSubscriptions: instance.peer.listeners.size },
    checks: { allIdle: idleCount === options.conversations, editable: status!.editable, fileSaved: saved },
    metrics: { editObservationMs: elapsed(started), statusPolls: polls, stateCallsDuringEdit: instance.peer.stateCalls - beforeCalls, watchCalls: instance.peer.watchCalls, peakSubscriptions: instance.peer.peakSubscriptions },
  };
}

async function historyCatchup(root: string, workspace: string, instances: Instance[], host: SyntheticHost, options: Options): Promise<Observation> {
  host.initialItems = fixtureHistory(options.cachedItems);
  const first = await startInstance(root, workspace, host); instances.push(first);
  const id = await createReady(first);
  const cachedBefore = await readAllCached(first, id);
  if (cachedBefore.length !== options.cachedItems) throw new Error('baseline_initial_cache_incomplete');
  const binding = first.store.getConversation(id)!.binding!;
  await closeInstance(first);
  // Only the substitute Host changes during downtime. Product SQLite is closed.
  const expectedCount = options.cachedItems + options.offlineItems;
  host.sessions.set(binding.id, fixtureHistory(expectedCount));
  const second = await startInstance(root, workspace, host); instances.push(second);
  await second.workbench.start();
  const started = performance.now();
  const progress: Json[] = [];
  for (let attempt = 1; attempt <= options.reconciliationAttempts; attempt++) {
    await second.workbench.reconcile(id);
    const snapshot = await second.workbench.snapshot(id);
    progress.push({ attempt, cached: (await readAllCached(second, id)).length, state: snapshot.conversation.state.status, reason: snapshot.conversation.error });
  }
  const actual = await readAllCached(second, id);
  // Oracle comes from the requested fixture specification, not adapter responses
  // or product row counts. Check order, exact text and preservation as well.
  const complete = actual.length === expectedCount && actual.every((item, index) => item.id === historyId(index) && item.text === historyText(index) && item.status === 'completed');
  const preserved = cachedBefore.every(item => actual.some(current => current.id === item.id && current.text === item.text));
  const conversation = (await second.workbench.snapshot(id)).conversation;
  return {
    expected: { cachedBefore: options.cachedItems, offlineItems: options.offlineItems, totalItems: expectedCount, state: 'idle', exactHistory: true },
    actual: { cachedBefore: cachedBefore.length, nativeItems: host.sessions.get(binding.id)!.length, totalItems: actual.length, uniqueItems: new Set(actual.map(item => item.id)).size, state: conversation.state.status, reason: conversation.error, exactHistory: complete, progress },
    checks: { exactHistory: complete, previousHistoryPreserved: preserved, verifiedIdle: conversation.state.status === 'idle' && conversation.state.configurationVerified },
    metrics: { catchupMs: elapsed(started), attempts: options.reconciliationAttempts, historyCalls: second.peer.historyCalls, historyItemsReturned: second.peer.historyItems, stateCalls: second.peer.stateCalls },
  };
}

async function directoryListing(instance: Instance, workspace: string, options: Options): Promise<Observation> {
  const expected = Array.from({ length: options.files }, (_, index) => 'file-' + index.toString().padStart(5, '0') + '.txt');
  // Reverse creation order makes an accidental filesystem-prefix truncation
  // distinguishable from a correctly ordered complete listing.
  for (const name of [...expected].reverse()) await writeFile(join(workspace, name), 'synthetic\n', { flag: 'wx', mode: 0o600 });
  const started = performance.now();
  let page = await instance.workbench.listWorkspaceFiles('baseline', '');
  let listingCalls = 1; let maxPageEntries = 0; let maxPageBytes = 0;
  const deadline = performance.now() + 10_000;
  while (!page.generation && page.refreshing && performance.now() < deadline) {
    await delay(10); page = await instance.workbench.listWorkspaceFiles('baseline', ''); listingCalls++;
  }
  const entries: typeof page.entries = [];
  const cursors = new Set<string>();
  const generation = page.generation;
  for (let number = 0; number < 100; number++) {
    if (page.generation !== generation) throw new Error('baseline_directory_generation_changed');
    maxPageEntries = Math.max(maxPageEntries, page.entries.length);
    maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page)));
    entries.push(...page.entries);
    if (!page.nextCursor) break;
    if (cursors.has(page.nextCursor)) throw new Error('baseline_directory_cursor_cycle');
    cursors.add(page.nextCursor);
    page = await instance.workbench.listWorkspaceFiles('baseline', '', { cursor: page.nextCursor }); listingCalls++;
  }
  const names = entries.map(entry => entry.name);
  const exact = names.length === expected.length && names.every((name, index) => name === expected[index]);
  const returned = new Set(names);
  const missing = expected.filter(name => !returned.has(name));
  return {
    expected: { files: options.files, completeOrderedListing: true },
    actual: { files: names.length, uniqueFiles: returned.size, missingFiles: missing.length, missingSample: missing.slice(0, 10), completeOrderedListing: exact, firstFile: names[0] ?? null, lastFile: names.at(-1) ?? null, status: page.status, complete: page.complete, error: page.error ?? null },
    checks: { completeOrderedListing: exact && page.complete && page.nextCursor === null, fileMetadata: entries.every(entry => entry.supported && !entry.directory && entry.path === entry.name), boundedPages: maxPageEntries <= 100 && maxPageBytes <= 128 * 1024 },
    metrics: { listMs: elapsed(started), listingCalls, maxPageEntries, maxPageBytes },
  };
}

async function runScenario(scenario: BaselineScenario, options: Options): Promise<BaselineResult> {
  const started = performance.now();
  const instances: Instance[] = [];
  let root: string | undefined;
  const result: BaselineResult = { scenario, status: 'scenario-error', expected: {}, actual: {}, checks: {}, metrics: {}, elapsedMs: 0,
    cleanup: { workbenchesClosed: false, databasesClosed: false, indexWorkersClosed: false, rootsRemoved: false, subscriptionsClosed: false, errors: [] } };
  try {
    root = await mkdtemp(join(tmpdir(), 'zhongshu-performance-' + scenario + '-'));
    root = await realpath(root);
    const workspace = join(root, 'workspace'); await mkdir(workspace, { mode: 0o700 });
    const host = new SyntheticHost();
    let observation: Observation;
    if (scenario === 'history-catchup') observation = await historyCatchup(root, workspace, instances, host, options);
    else {
      const instance = await startInstance(root, workspace, host); instances.push(instance);
      observation = scenario === 'workspace-edit' ? await workspaceEdit(instance, workspace, options) : await directoryListing(instance, workspace, options);
    }
    Object.assign(result, observation);
    result.status = Object.values(observation.checks).every(Boolean) ? 'satisfied' : 'boundary-observed';
  } catch (error) { result.error = errorCode(error); }
  finally {
    for (const instance of instances.reverse()) {
      try { await closeInstance(instance); } catch (error) { result.cleanup.errors.push(errorCode(error)); }
    }
    result.cleanup.workbenchesClosed = instances.every(instance => instance.workbenchClosed);
    result.cleanup.databasesClosed = instances.every(instance => instance.databaseClosed);
    result.cleanup.indexWorkersClosed = instances.every(instance => instance.indexClosed);
    result.cleanup.subscriptionsClosed = instances.every(instance => instance.peer.closed && instance.peer.listeners.size === 0);
    if (root) {
      try {
        if (!result.cleanup.workbenchesClosed || !result.cleanup.databasesClosed || !result.cleanup.indexWorkersClosed) throw new Error('baseline_cleanup_open_resources');
        await rm(root, { recursive: true });
        try { await lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') result.cleanup.rootsRemoved = true; else throw error; }
      } catch (error) { result.cleanup.errors.push(errorCode(error)); }
    } else result.cleanup.rootsRemoved = true;
    if (result.cleanup.errors.length) result.status = 'scenario-error';
    result.elapsedMs = elapsed(started);
  }
  return result;
}

function version() {
  const git = (args: string[]) => spawnSync('git', args, { cwd: repository, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  const revision = git(['rev-parse', 'HEAD']); const status = git(['status', '--porcelain']);
  const packageInfo = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')));
  const sourceSha256 = Object.fromEntries(['src/server/workbench.ts', 'src/server/workbench-store.ts', 'src/server/workspace-documents.ts', 'src/server/directory-index.ts', 'src/server/directory-index-worker.ts', 'src/server/database.ts', 'src/server/migrations.ts', 'test/support/performance-baseline.ts', 'package-lock.json']
    .map(path => [path, createHash('sha256').update(readFileSync(join(repository, path))).digest('hex')]));
  return { package: packageInfo.version, revision: revision.status === 0 ? revision.stdout.trim() : null, dirty: status.status === 0 ? !!status.stdout : null, sourceSha256,
    node: process.version, platform: platform(), architecture: arch(), availableParallelism: availableParallelism() };
}

export async function runPerformanceBaseline(input: z.input<typeof optionsSchema> = {}) {
  const options = optionsSchema.parse(input);
  const testedVersion = version();
  const results: BaselineResult[] = [];
  const started = performance.now();
  for (const scenario of options.scenarios) results.push(await runScenario(scenario, options));
  return { format: 1 as const, generatedAt: new Date().toISOString(), version: testedVersion, mode: 'synthetic-harness-real-workbench' as const,
    limitations: ['No HTTP, browser, DOM, native protocol or real model measurement.', 'Bounded reproducibility probe; timings are observations, not an agreed performance SLA.', 'History catch-up performs the configured number of reconciliation attempts; it is not a long-running archival test.'],
    options, elapsedMs: elapsed(started), results };
}

/** Export-only corpus for later browser driving; generating it proves no UI behavior. */
export function createReadingSamples() {
  const block = '## Synthetic section\n\n| Name | Value |\n| --- | --- |\n| Alpha | 123 |\n\n```typescript\nconst answer = 42;\nconsole.log(answer);\n```\n\n![Synthetic pixel](baseline-pixel.png)\n\n';
  const giant = block.repeat(Math.ceil(1024 * 1024 / block.length)).slice(0, 1024 * 1024);
  const samples = [
    { id: 'rich-82', items: Array.from({ length: 82 }, (_, index) => ({ id: 'rich-' + index, kind: 'assistant' as const, status: 'completed' as const, text: block.repeat(16) })) },
    { id: 'giant-1mib', items: [{ id: 'giant-0', kind: 'assistant' as const, status: 'completed' as const, text: giant }] },
  ];
  return { format: 1, mode: 'export-only-not-browser-evidence', images: [{ name: 'baseline-pixel.png', mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==' }],
    samples: samples.map(sample => ({ ...sample, expected: { items: sample.items.length, utf8Bytes: sample.items.reduce((total, item) => total + Buffer.byteLength(item.text), 0), sha256: createHash('sha256').update(JSON.stringify(sample.items)).digest('hex') } })) };
}

export async function writeBaselineJson(destination: string, value: unknown): Promise<void> {
  const requested = z.string().min(1).max(4096).refine(isAbsolute).parse(destination);
  const path = resolve(requested);
  const parent = dirname(path);
  if (await realpath(parent) !== parent) throw new Error('baseline_output_parent_not_canonical');
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== 'string') throw new Error('baseline_output_requires_json');
  const handle = await open(join(parent, basename(path)), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(serialized + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

async function main() {
  const args = parseArgs({ strict: true, options: { scenario: { type: 'string', multiple: true }, output: { type: 'string' }, samples: { type: 'string' }, 'require-satisfied': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (args.values.help) {
    console.log('node test/support/performance-baseline.ts [--scenario workspace-edit|history-catchup|directory] [--output /canonical/new-result.json] [--samples /canonical/new-reading-samples.json] [--require-satisfied]');
    return;
  }
  const report = await runPerformanceBaseline({ scenarios: args.values.scenario?.map(value => scenarioSchema.parse(value)) });
  if (args.values.output) await writeBaselineJson(args.values.output, report);
  if (args.values.samples) await writeBaselineJson(args.values.samples, createReadingSamples());
  console.log(JSON.stringify(report, null, 2));
  if (report.results.some(result => result.status === 'scenario-error') || args.values['require-satisfied'] && report.results.some(result => result.status !== 'satisfied')) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(JSON.stringify({ event: 'performance_baseline_error', code: errorCode(error) })); process.exitCode = 1; });
}

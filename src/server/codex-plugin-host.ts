import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import Fastify from 'fastify';
import { z } from 'zod';
import { CodexRpc } from '../harness/codex/rpc.ts';
import { pluginCommand, pluginSourceCommand, pluginKey, type PluginCommand, type PluginEntry, type PluginSourceCommand } from '../shared/plugins.ts';
import { socketIdentity } from './codex-plugin-client.ts';
import { matchesPluginAction, PluginSourceError, type PluginResult } from './plugin-backend.ts';
import { githubRepository, publicHttps, readGithubJson, readGithubManifest } from './plugin-sources.ts';

const runFile = promisify(execFile);
const absolute = z.string().max(4096).refine(path => isAbsolute(path) && normalize(path) === path && !path.includes('\0'));
const name = z.string().max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const gitUrl = z.string().max(256).regex(/^https:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_/-]+(?:\.git)?$/);
const market = z.object({ name: name.refine(value => !value.toLowerCase().startsWith('openai-')), url: gitUrl, revision: commit }).strict();
const settingsSchema = z.object({
  socket: absolute, nativeSocket: absolute, executable: absolute, gitExecutable: absolute,
  home: absolute, codexHome: absolute, version: z.string().max(64).regex(/^[0-9][a-zA-Z0-9.-]*$/),
  markets: z.array(market).max(8).refine(values => new Set(values.map(value => value.name)).size === values.length),
}).strict();
export type CodexPluginHostSettings = z.infer<typeof settingsSchema>;

const marketSource = z.object({ sourceType: z.literal('git'), source: gitUrl });
const marketList = z.object({ marketplaces: z.array(z.object({ name: z.string(), root: absolute, marketplaceSource: z.unknown().optional() })).max(128) });
const rowSchema = z.object({
  pluginId: z.string(), name: z.string(), marketplaceName: z.string(), version: z.string().max(128).nullable(),
  installed: z.boolean(), enabled: z.boolean(), source: z.unknown().optional(),
  marketplaceSource: z.unknown().optional(), installPolicy: z.string(),
});
const catalogSchema = z.object({ installed: z.array(rowSchema).max(500), available: z.array(rowSchema).max(500) });
const manifestMetadata = z.object({ name, interface: z.object({ displayName: z.string().min(1).max(240).optional() }).optional(), plugins: z.array(z.object({
  name, description: z.string().max(1000).optional(), interface: z.object({ displayName: z.string().min(1).max(240).optional() }).optional(),
  source: z.unknown().optional(),
}).passthrough()).max(500) });
const packageSource = z.object({
  source: z.enum(['url', 'git', 'git-subdir']), url: gitUrl, sha: commit,
  path: z.string().max(240).regex(/^(?:\.\/)?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/).optional(),
});
const gitRef = z.string().max(128).regex(/^(?!.*(?:\.\.|\/\/))[A-Za-z0-9_][A-Za-z0-9_./-]*$/);
const managedMarket = market.extend({ label: z.string().min(1).max(240), ref: gitRef.optional(), pendingRevision: commit.optional() });
type ManagedMarket = z.infer<typeof managedMarket>;
type PackageSource = z.infer<typeof packageSource>;
type Candidate = NonNullable<PluginEntry['update']> & { source: PackageSource; manifest: Map<string, MarketplaceItem> };
const targetSchema = z.string().regex(/^\d+:\d+$/);
const inputSchema = z.object({ target: targetSchema, command: pluginCommand }).strict();
const inside = (root: string, path: string) => {
  const fromRoot = relative(root, path);
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith('../') && !isAbsolute(fromRoot);
};

function samePackage(left: PackageSource, right: PackageSource) {
  return left.source === right.source && left.url === right.url &&
    (left.path ?? '').replace(/^\.\//, '') === (right.path ?? '').replace(/^\.\//, '');
}

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
function newerVersion(candidate: string, installed: string | null): boolean {
  const next = semver.exec(candidate);
  const previous = installed && semver.exec(installed);
  if (!next || !previous) return false;
  for (const part of [1, 2, 3]) {
    const a = BigInt(next[part]!);
    const b = BigInt(previous[part]!);
    if (a !== b) return a > b;
  }
  if (!next[4] || !previous[4]) return !next[4] && !!previous[4];
  const a = next[4].split('.');
  const b = previous[4].split('.');
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) return BigInt(x) > BigInt(y);
    if (xNumber !== yNumber) return !xNumber;
    return x > y;
  }
  return a.length > b.length;
}

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || await realpath(path) !== path || (info.mode & 0o077) ||
    (process.getuid && info.uid !== process.getuid())) throw new Error('plugin_host_directory_unsafe');
}

type MarketplaceItem = z.infer<typeof manifestMetadata>['plugins'][number];
export function preservesInstalledPeers(installed: readonly { name: string; installed: boolean }[],
  current: ReadonlyMap<string, unknown>, next: ReadonlyMap<string, unknown>, selected: string): boolean {
  return installed.every(row => !row.installed || row.name === selected ||
    current.has(row.name) && isDeepStrictEqual(current.get(row.name), next.get(row.name)));
}

async function marketplaceMetadata(root: string): Promise<Map<string, MarketplaceItem>> {
  const file = join(root, '.agents', 'plugins', 'marketplace.json');
  try {
    if (await realpath(file) !== file) return new Map();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) return new Map();
      const manifest = manifestMetadata.safeParse(JSON.parse(await handle.readFile('utf8')));
      return new Map(manifest.data?.plugins.map(item => [item.name, item]));
    } finally { await handle.close(); }
  } catch { return new Map(); }
}

export async function createCodexPluginHost(input: CodexPluginHostSettings) {
  const settings = settingsSchema.parse(input);
  for (const path of [dirname(settings.socket), settings.home, settings.codexHome]) await privateDirectory(path);
  const env = {
    HOME: settings.home, CODEX_HOME: settings.codexHome, PATH: '/usr/bin:/bin:/usr/local/bin',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const exec = async (file: string, args: string[], timeout = 12_000) =>
    (await runFile(file, args, { cwd: settings.codexHome, env, timeout, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 })).stdout;
  const cli = (args: string[], timeout?: number) => exec(settings.executable, [
    '--disable', 'remote_plugin', '-c', 'cli_auth_credentials_store="file"', ...args,
  ], timeout);
  if ((await exec(settings.executable, ['--version'])).trim() !== 'codex-cli ' + settings.version)
    throw new Error('plugin_host_version_mismatch');

  let boundTarget: string | undefined;
  let connectingTarget: Promise<string> | undefined;
  const rpc = new CodexRpc(settings.nativeSocket, {
    notification() {}, serverRequest: () => false, disconnected() { boundTarget = undefined; },
  });
  let busy = false;
  let updates = new Map<string, Candidate>();
  const completions = new Map<string, { command: PluginCommand; status: PluginResult }>();
  async function target(): Promise<string> {
    if (connectingTarget) return connectingTarget;
    const connect = async () => {
      const before = await socketIdentity(settings.nativeSocket);
      if (rpc.connected && boundTarget !== before) throw new Error('plugin_host_target_changed');
      await rpc.connect();
      if (rpc.codexHome !== settings.codexHome || await socketIdentity(settings.nativeSocket) !== before)
        throw new Error('plugin_host_target_mismatch');
      boundTarget = before;
      return before;
    };
    const attempt = connect();
    connectingTarget = attempt;
    try { return await attempt; }
    finally { if (connectingTarget === attempt) connectingTarget = undefined; }
  }

  const registry = join(dirname(settings.socket), 'market-sources.json');
  async function managed() {
    const handle = await open(registry, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!handle) return [];
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 32_768 || (info.mode & 0o077) ||
        (process.getuid && info.uid !== process.getuid())) throw new Error('plugin_source_registry_invalid');
      return z.array(managedMarket).max(8).parse(JSON.parse(await handle.readFile('utf8')));
    } finally { await handle.close(); }
  }
  async function saveManaged(value: Awaited<ReturnType<typeof managed>>) {
    const temporary = registry + '.' + randomUUID();
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, registry);
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  const nativeMarkets = async () => marketList.parse(JSON.parse(await cli(['plugin', 'marketplace', 'list', '--json']))).marketplaces;
  const nativeCatalog = async (name: string) =>
    catalogSchema.parse(JSON.parse(await cli(['plugin', 'list', '--marketplace', name, '--available', '--json'])));
  const sourceRecords = async () => [
    ...settings.markets.map(item => ({ ...item, label: item.name, removable: false })),
    ...(await managed()).map(item => ({ ...item, removable: true })),
  ];
  async function verifyMarket(allowed: z.infer<typeof market>, current: Awaited<ReturnType<typeof nativeMarkets>>[number] | undefined) {
      if (!current || marketSource.safeParse(current.marketplaceSource).data?.source !== allowed.url ||
        !inside(settings.codexHome, current.root) || await realpath(current.root) !== current.root)
        throw new Error('plugin_host_market_mismatch');
      const rev = await exec(settings.gitExecutable, ['-C', current.root, 'rev-parse', 'HEAD']);
      const dirty = await exec(settings.gitExecutable, ['-C', current.root, 'status', '--porcelain', '--untracked-files=all']);
      const unexpected = dirty.split('\n').some(line => line && line !== '?? .codex-marketplace-install.json');
      if (rev.trim() !== allowed.revision || unexpected) throw new Error('plugin_host_market_changed');
      return current;
  }
  async function list(): Promise<PluginEntry[]> {
    const markets = await nativeMarkets();
    const catalogs = await Promise.all((await sourceRecords()).map(async allowed => {
      const current = await verifyMarket(allowed, markets.find(value => value.name === allowed.name)).catch(() => undefined);
      if (!current) return [];

      const metadata = await marketplaceMetadata(current.root);
      const rows = await nativeCatalog(allowed.name);
      return [...rows.installed, ...rows.available].flatMap(row => {
        if (!name.safeParse(row.name).success || row.marketplaceName !== allowed.name ||
          row.pluginId !== row.name + '@' + allowed.name ||
          marketSource.safeParse(row.marketplaceSource).data?.source !== allowed.url || !packageSource.safeParse(row.source).success) return [];
        const details = metadata.get(row.name);
        const packageInfo = packageSource.parse(row.source);
        if (allowed.removable) {
          try { if (githubRepository(packageInfo.url).url !== packageInfo.url) return []; }
          catch { return []; }
        }
        const candidate = allowed.removable ? updates.get(row.pluginId) : undefined;
        const update = candidate && row.installed && row.installPolicy === 'AVAILABLE' &&
          samePackage(candidate.source, packageInfo) && newerVersion(candidate.version, row.version)
          ? { version: candidate.version, revision: candidate.revision, commit: candidate.commit, marketConflict: candidate.marketConflict } : undefined;
        const entry: PluginEntry = {
          id: row.pluginId, name: details?.interface?.displayName ?? row.name,
          description: details?.description ?? '', source: allowed.label, sourceId: allowed.name, version: row.version,
          homepage: publicHttps(packageInfo.url),
          releases: row.version ? [{ version: row.version, installable: false, repository: packageInfo.url, commit: packageInfo.sha, directory: packageInfo.path }] : undefined,
          installed: row.installed, enabled: row.enabled, application: 'unverified',
          update,
          actions: row.installed ? [row.enabled ? 'disable' : 'enable', 'remove',
            ...(row.enabled && update && !update.marketConflict ? ['update'] as const : [])] :
            row.installPolicy === 'AVAILABLE' ? ['install'] : [],
        };
        return [entry];
      });
    }));
    const entries = catalogs.flat();
    if (entries.length > 1000 || new Set(entries.map(row => row.id)).size !== entries.length)
      throw new Error('plugin_host_catalog_invalid');
    return entries;
  }

  async function resolveRevision(url: string, ref: string) {
    const revision = commit.safeParse(ref).data;
    if (revision) return revision;
    const selectors = ref === 'HEAD' || ref.startsWith('refs/') ? [ref] : ['refs/heads/' + ref, 'refs/tags/' + ref];
    const output = await exec(settings.gitExecutable, ['-c', 'http.followRedirects=false', 'ls-remote', '--', url, ...selectors, ...selectors.map(value => value + '^{}')]);
    const refs = new Map(output.trim().split('\n').map(line => line.split('\t')).flatMap(([sha, key]) =>
      key && commit.safeParse(sha).success ? [[key, sha!] as const] : []));
    const matches = selectors.map(value => refs.get(value + '^{}') ?? refs.get(value)).filter(value => value !== undefined);
    if (matches.length !== 1) throw new PluginSourceError('invalid_plugin_source');
    return matches[0]!;
  }

  async function checkUpdates() {
    const [entries, sources, markets] = await Promise.all([list(), managed(), nativeMarkets()]);
    const deadline = AbortSignal.timeout(30_000);
    const next = new Map<string, Candidate>();
    const results = await Promise.allSettled(sources.map(async source => {
      const installed = entries.filter(entry => entry.installed && entry.sourceId === source.name);
      const current = await verifyMarket(source, markets.find(item => item.name === source.name));
      const repository = githubRepository(source.url);
      const revision = await resolveRevision(repository.url, source.ref ?? 'HEAD');
      const manifest = manifestMetadata.parse(await readGithubManifest(repository.path, revision, deadline));
      const proposed = new Map(manifest.plugins.map(item => [item.name, item]));
      if (manifest.name !== source.name || proposed.size !== manifest.plugins.length)
        throw new Error('plugin_update_market_mismatch');
      const previous = await marketplaceMetadata(current.root);
      const native = revision === source.revision ? [] : (await nativeCatalog(source.name)).installed;
      for (let offset = 0; offset < installed.length; offset += 8) {
        deadline.throwIfAborted();
        const releases = await Promise.allSettled(installed.slice(offset, offset + 8).map(async entry => {
          const name = entry.id.slice(0, -(source.name.length + 1));
          const before = packageSource.safeParse(previous.get(name)?.source).data;
          const after = packageSource.safeParse(proposed.get(name)?.source).data;
          if (!before || !after || !samePackage(before, after)) return;
          const packageRepo = githubRepository(after.url);
          if (packageRepo.url !== after.url) return;
          const directory = after.path?.replace(/^\.\//, '');
          const descriptor = z.object({ name: z.string(), version: z.string().max(128) }).parse(await readGithubJson(
            packageRepo.path, after.sha, (directory ? directory + '/' : '') + '.codex-plugin/plugin.json', deadline));
          if (descriptor.name === name && newerVersion(descriptor.version, entry.version)) {
            const marketConflict = preservesInstalledPeers(native, previous, proposed, name) ? undefined : true;
            next.set(entry.id, { version: descriptor.version, revision, commit: after.sha, source: after, manifest: proposed, marketConflict });
          }
        }));
        if (releases.some(release => release.status === 'rejected')) throw new Error('plugin_release_unavailable');
      }
    }));
    updates = next;
    const checked = results.filter(result => result.status === 'fulfilled').length;
    return { checked, unavailable: results.length - checked };
  }

  async function updateSource(command: PluginSourceCommand) {
    const saved = await managed();
    const markets = await nativeMarkets();
    if (command.action === 'remove') {
      const source = saved.find(item => item.name === command.id);
      if (!source) throw new PluginSourceError('invalid_plugin_source');
      const current = markets.find(item => item.name === source.name);
      if (current) {
        await verifyMarket(source, current);
        const catalog = await nativeCatalog(source.name);
        if (catalog.installed.some(item => item.installed)) throw new PluginSourceError('plugin_source_in_use');
        await cli(['plugin', 'marketplace', 'remove', source.name, '--json']);
        if ((await nativeMarkets()).some(item => item.name === source.name)) throw new Error('plugin_source_removal_unconfirmed');
      }
      await saveManaged(saved.filter(item => item.name !== source.name));
      for (const id of updates.keys()) if (id.endsWith('@' + source.name)) updates.delete(id);
      return;
    }
    const repository = githubRepository(command.source);
    const ref = gitRef.safeParse(command.ref ?? 'HEAD').data;
    if (!ref) throw new PluginSourceError('invalid_plugin_source');
    const revision = await resolveRevision(repository.url, ref);
    const manifest = manifestMetadata.safeParse(await readGithubManifest(repository.path, revision));
    if (!manifest.success || manifest.data.name.toLowerCase().startsWith('openai-'))
      throw new PluginSourceError('invalid_plugin_source');
    const source = { name: manifest.data.name, label: manifest.data.interface?.displayName ?? manifest.data.name, url: repository.url, revision, ref };
    const existing = saved.find(item => item.name === source.name);
    if (existing?.url === source.url && existing.revision === source.revision) {
      await verifyMarket(existing, markets.find(item => item.name === source.name));
      return;
    }
    if (existing || settings.markets.some(item => item.name === source.name) || saved.length + settings.markets.length >= 8)
      throw new PluginSourceError('plugin_source_conflict');
    const current = markets.find(item => item.name === source.name);
    if (current) {
      // An earlier request may have registered the exact checkout before losing its reply.
      await verifyMarket(source, current).catch(() => { throw new PluginSourceError('plugin_source_conflict'); });
    } else {
      await cli(['plugin', 'marketplace', 'add', '--ref', source.revision, '--json', source.url], 60_000);
      await verifyMarket(source, (await nativeMarkets()).find(item => item.name === source.name));
    }
    await saveManaged([...saved, source]);
  }

  async function writeConfig(keyPath: string, value: string | boolean, expectedTarget: string) {
    if (await target() !== expectedTarget) throw new Error('plugin_host_target_changed');
    const filePath = join(settings.codexHome, 'config.toml');
    const result = z.object({ filePath: absolute, status: z.string() }).parse(await rpc.requestConnected('config/value/write', {
      keyPath, value, mergeStrategy: 'upsert', filePath,
    }));
    if (result.filePath !== filePath) throw new Error('plugin_host_write_target_mismatch');
  }

  async function settleMarket(source: ManagedMarket, expectedTarget: string) {
    if (!source.pendingRevision) return source;
    const current = (await nativeMarkets()).find(item => item.name === source.name);
    const advanced = await verifyMarket({ ...source, revision: source.pendingRevision }, current).catch(() => undefined);
    if (!advanced) await verifyMarket(source, current);
    const { pendingRevision, ...previous } = source;
    const settled = { ...previous, revision: advanced ? pendingRevision : previous.revision };
    await writeConfig('marketplaces."' + source.name + '".ref', settled.revision, expectedTarget);
    await verifyMarket(settled, (await nativeMarkets()).find(item => item.name === source.name));
    await saveManaged((await managed()).map(item => item.name === source.name ? settled : item));
    return settled;
  }

  async function updatePlugin(row: PluginEntry, candidate: Candidate, source: ManagedMarket, expectedTarget: string) {
    const current = await verifyMarket(source, (await nativeMarkets()).find(item => item.name === source.name));
    const pluginName = row.id.slice(0, -(source.name.length + 1));
    if (source.revision !== candidate.revision) {
      const previous = await marketplaceMetadata(current.root);
      if (!preservesInstalledPeers((await nativeCatalog(source.name)).installed, previous, candidate.manifest, pluginName)) return false;
      const pending = { ...source, pendingRevision: candidate.revision };
      await saveManaged((await managed()).map(item => item.name === source.name ? pending : item));
      try {
        await writeConfig('marketplaces."' + source.name + '".ref', candidate.revision, expectedTarget);
        await cli(['plugin', 'marketplace', 'upgrade', source.name, '--json'], 55_000);
      } finally {
        source = await settleMarket(pending, expectedTarget);
      }
    }
    if (source.revision !== candidate.revision) throw new Error('plugin_update_market_not_applied');
    const market = await verifyMarket(source, (await nativeMarkets()).find(item => item.name === source.name));
    const selected = packageSource.parse((await marketplaceMetadata(market.root)).get(pluginName)?.source);
    if (selected.sha !== candidate.commit || !samePackage(selected, candidate.source) || await target() !== expectedTarget)
      throw new Error('plugin_update_package_changed');
    const result = z.object({ pluginId: pluginKey, version: z.string() }).parse(JSON.parse(
      await cli(['plugin', 'add', row.id, '--json'], 65_000)));
    if (result.pluginId !== row.id || result.version !== candidate.version) throw new Error('plugin_update_result_mismatch');
    return true;
  }

  async function change(command: PluginCommand, expectedTarget: string): Promise<PluginResult> {
    if (busy) return 'unknown';
    const prior = completions.get(command.id);
    if (prior) return prior.command.pluginId === command.pluginId && prior.command.action === command.action &&
      prior.command.version === command.version && prior.command.revision === command.revision ? prior.status : 'failed';
    busy = true;
    let status: PluginResult = 'failed';
    let dispatched = false;
    try {
      const row = (await list()).find(entry => entry.id === command.pluginId);
      if (!row?.actions.includes(command.action) || await target() !== expectedTarget) return 'failed';
      if (command.action === 'update') {
        const candidate = updates.get(row.id);
        const source = (await managed()).find(item => item.name === row.sourceId);
        if (!source || source.pendingRevision || !candidate || row.update?.version !== command.version ||
          row.update?.revision !== command.revision) return 'failed';
        dispatched = true;
        if (!await updatePlugin(row, candidate, source, expectedTarget)) return 'failed';
      } else {
        if (command.version) return 'failed';
        dispatched = true;
        if (command.action === 'install' || command.action === 'remove') {
          await cli(['plugin', command.action === 'install' ? 'add' : 'remove', row.id, '--json'], 90_000);
        } else {
          await writeConfig('plugins."' + row.id + '".enabled', command.action === 'enable', expectedTarget);
        }
      }
      status = await target() === expectedTarget && matchesPluginAction(command, await list()) ? 'applied' : 'unknown';
    } catch {
      status = dispatched ? 'unknown' : 'failed';
    } finally {
      busy = false;
      if (dispatched) {
        completions.set(command.id, { command, status });
        if (completions.size > 128) completions.delete(completions.keys().next().value!);
      }
    }
    return status;
  }

  const app = Fastify({ logger: false, bodyLimit: 4096, requestTimeout: 10_000 });
  app.addHook('onClose', async () => { await rpc.close(); });
  app.setErrorHandler((_error, _request, reply) => { void reply.code(503).send({ error: 'plugin_host_unavailable' }); });
  app.get('/catalog', async () => {
    const expectedTarget = await target();
    const [entries, records, markets] = await Promise.all([list(), sourceRecords(), nativeMarkets()]);
    const sources = await Promise.all(records.map(async source => ({
      id: source.name, name: source.label, url: source.url, removable: source.removable,
      unavailable: !(await verifyMarket(source, markets.find(item => item.name === source.name)).catch(() => undefined)),
    })));
    if (await target() !== expectedTarget) throw new Error('plugin_host_target_changed');
    return { target: expectedTarget, entries, sources };
  });
  app.post('/check-updates', async (request, reply) => {
    const input = z.object({ target: targetSchema }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    const expectedTarget = await target();
    if (input.data.target !== expectedTarget || busy) return reply.code(409).send({ error: 'plugin_host_target_mismatch' });
    busy = true;
    try {
      const updateCheck = await checkUpdates();
      if (await target() !== expectedTarget) {
        updates.clear();
        throw new Error('plugin_host_target_changed');
      }
      return { target: expectedTarget, updateCheck };
    } finally { busy = false; }
  });
  app.post('/sources', async (request, reply) => {
    const input = z.object({ target: targetSchema, command: pluginSourceCommand }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_plugin_source' });
    const expectedTarget = await target();
    if (input.data.target !== expectedTarget || busy) return reply.code(409).send({ error: 'plugin_source_conflict' });
    busy = true;
    try {
      await updateSource(input.data.command);
      if (await target() !== expectedTarget) throw new Error('plugin_host_target_changed');
      return { target: expectedTarget };
    } catch (error) {
      if (error instanceof PluginSourceError)
        return reply.code(error.code === 'invalid_plugin_source' ? 400 : 409).send({ error: error.code });
      throw error;
    } finally { busy = false; }
  });
  app.post('/detail', async (request, reply) => {
    const input = z.object({ target: targetSchema, id: pluginKey }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    const expectedTarget = await target();
    if (input.data.target !== expectedTarget) return reply.code(409).send({ error: 'plugin_host_target_mismatch' });
    const entry = (await list()).find(item => item.id === input.data.id);
    let skills: PluginEntry['skills'];
    if (entry?.installed) {
      const source = (await sourceRecords()).find(item => item.name === entry.sourceId);
      if (source) {
        const current = await verifyMarket(source, (await nativeMarkets()).find(item => item.name === source.name));
        const result = z.object({ plugin: z.object({
          skills: z.array(z.object({ name: z.string().max(200), description: z.string().max(1000) })).max(200),
        }) }).safeParse(await rpc.requestConnected('plugin/read', {
          marketplacePath: join(current.root, '.agents', 'plugins', 'marketplace.json'),
          pluginName: entry.id.slice(0, -(source.name.length + 1)),
        }).catch(() => undefined));
        skills = result.data?.plugin.skills;
      }
    }
    if (await target() !== expectedTarget) throw new Error('plugin_host_target_changed');
    return { target: expectedTarget, entry: entry ? { ...entry, skills } : null };
  });
  app.post('/change', async (request, reply) => {
    const input = inputSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    const expectedTarget = await target();
    if (input.data.target !== expectedTarget) return reply.code(409).send({ error: 'plugin_host_target_mismatch' });
    return { target: expectedTarget, status: await change(input.data.command, expectedTarget) };
  });
  app.post('/recover', async (request, reply) => {
    const input = inputSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    const expectedTarget = await target();
    if (input.data.target !== expectedTarget) return reply.code(409).send({ error: 'plugin_host_target_mismatch' });
    const command = input.data.command;
    if (busy) return { target: expectedTarget, status: 'unknown' };
    if (command.action === 'update') {
      busy = true;
      try {
        const marketName = command.pluginId.split('@')[1];
        const record = (await managed()).find(item => item.name === marketName);
        if (!record || record.pendingRevision && record.pendingRevision !== command.revision)
          return { target: expectedTarget, status: 'unknown' };
        const source = await settleMarket(record, expectedTarget);
        const entry = (await list()).find(item => item.id === command.pluginId);
        if (await target() !== expectedTarget || !entry?.installed) return { target: expectedTarget, status: 'unknown' };
        const status = source.revision === command.revision && entry.version === command.version && entry.enabled ? 'applied' : 'failed';
        return { target: expectedTarget, status };
      } finally { busy = false; }
    }
    const entries = await list();
    const known = completions.get(command.id);
    if (busy || await target() !== expectedTarget) return { target: expectedTarget, status: 'unknown' };
    const status = matchesPluginAction(command, entries) ? 'applied' : known?.status === 'failed' ? 'failed' : 'unknown';
    return { target: expectedTarget, status };
  });
  return app;
}

async function main() {
  const path = absolute.parse(process.env.ZHONGSHU_CODEX_PLUGIN_CONFIG);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let settings: CodexPluginHostSettings;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16_384 || (info.mode & 0o022) ||
      (process.getuid && info.uid !== process.getuid())) throw new Error('plugin_host_config_unsafe');
    settings = settingsSchema.parse(JSON.parse(await handle.readFile('utf8')));
  } finally { await handle.close(); }
  process.umask(0o077);
  const app = await createCodexPluginHost(settings);
  await app.listen({ path: settings.socket });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main().catch(() => {
  process.stderr.write('Codex plugin manager could not start. Check the operator configuration and socket directory.\n');
  process.exitCode = 1;
});

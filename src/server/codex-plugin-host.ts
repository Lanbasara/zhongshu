import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { z } from 'zod';
import { CodexRpc } from '../harness/codex/rpc.ts';
import { pluginCommand, type PluginCommand, type PluginEntry } from '../shared/plugins.ts';
import { socketIdentity } from './codex-plugin-client.ts';
import { matchesPluginAction, type PluginResult } from './plugin-backend.ts';

const runFile = promisify(execFile);
const absolute = z.string().max(4096).refine(path => isAbsolute(path) && normalize(path) === path && !path.includes('\0'));
const name = z.string().max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const gitUrl = z.string().max(256).regex(/^https:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_/-]+(?:\.git)?$/);
const market = z.object({ name: name.refine(value => !value.toLowerCase().startsWith('openai-')), url: gitUrl, revision: commit }).strict();
const settingsSchema = z.object({
  socket: absolute, nativeSocket: absolute, executable: absolute, gitExecutable: absolute,
  home: absolute, codexHome: absolute, version: z.string().max(64).regex(/^[0-9][a-zA-Z0-9.-]*$/),
  markets: z.array(market).min(1).max(8).refine(values => new Set(values.map(value => value.name)).size === values.length),
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
const manifestMetadata = z.object({ plugins: z.array(z.object({
  name, description: z.string().max(1000).optional(), interface: z.object({ displayName: z.string().min(1).max(240).optional() }).optional(),
})).max(500) });
const packageSource = z.object({
  source: z.enum(['url', 'git', 'git-subdir']), url: gitUrl, sha: commit,
  path: z.string().max(240).regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/).optional(),
});
const inputSchema = z.object({ target: z.string().regex(/^\d+:\d+$/), command: pluginCommand }).strict();
const inside = (root: string, path: string) => {
  const fromRoot = relative(root, path);
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith('../') && !isAbsolute(fromRoot);
};

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || await realpath(path) !== path || (info.mode & 0o077) ||
    (process.getuid && info.uid !== process.getuid())) throw new Error('plugin_host_directory_unsafe');
}

type MarketplaceItem = z.infer<typeof manifestMetadata>['plugins'][number];
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
    notification() {}, unsupportedRequest() {}, disconnected() { boundTarget = undefined; },
  });
  let busy = false;
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

  async function list(): Promise<PluginEntry[]> {
    const markets = marketList.parse(JSON.parse(await cli(['plugin', 'marketplace', 'list', '--json']))).marketplaces;
    const catalogs = await Promise.all(settings.markets.map(async allowed => {
      const current = markets.find(value => value.name === allowed.name);
      if (!current || marketSource.safeParse(current.marketplaceSource).data?.source !== allowed.url ||
        !inside(settings.codexHome, current.root) || await realpath(current.root) !== current.root)
        throw new Error('plugin_host_market_mismatch');
      const rev = await exec(settings.gitExecutable, ['-C', current.root, 'rev-parse', 'HEAD']);
      const dirty = await exec(settings.gitExecutable, ['-C', current.root, 'status', '--porcelain', '--untracked-files=all']);
      // Codex writes this untracked receipt into an otherwise clean market checkout.
      const unexpected = dirty.split('\n').some(line => line && line !== '?? .codex-marketplace-install.json');
      if (rev.trim() !== allowed.revision || unexpected) throw new Error('plugin_host_market_changed');
      const metadata = await marketplaceMetadata(current.root);
      const rows = catalogSchema.parse(JSON.parse(await cli(['plugin', 'list', '--marketplace', allowed.name, '--available', '--json'])));
      return [...rows.installed, ...rows.available].flatMap(row => {
        if (!name.safeParse(row.name).success || row.marketplaceName !== allowed.name ||
          row.pluginId !== row.name + '@' + allowed.name ||
          marketSource.safeParse(row.marketplaceSource).data?.source !== allowed.url || !packageSource.safeParse(row.source).success) return [];
        const details = metadata.get(row.name);
        const entry: PluginEntry = {
          id: row.pluginId, name: details?.interface?.displayName ?? row.name,
          description: details?.description ?? '', source: allowed.name, version: row.version,
          installed: row.installed, enabled: row.enabled, application: 'unverified',
          actions: row.installed ? [row.enabled ? 'disable' : 'enable', 'remove'] :
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

  async function change(command: PluginCommand, expectedTarget: string): Promise<PluginResult> {
    if (busy) return 'unknown';
    const prior = completions.get(command.id);
    if (prior) return prior.command.pluginId === command.pluginId && prior.command.action === command.action ? prior.status : 'failed';
    busy = true;
    let status: PluginResult = 'failed';
    let dispatched = false;
    try {
      const row = (await list()).find(entry => entry.id === command.pluginId);
      if (!row?.actions.includes(command.action) || await target() !== expectedTarget) return 'failed';
      dispatched = true;
      if (command.action === 'install' || command.action === 'remove') {
        await cli(['plugin', command.action === 'install' ? 'add' : 'remove', row.id, '--json'], 90_000);
      } else {
        const result = z.object({ filePath: absolute, status: z.string() }).parse(await rpc.requestConnected('config/value/write', {
          keyPath: 'plugins."' + row.id + '".enabled', value: command.action === 'enable', mergeStrategy: 'upsert',
          filePath: join(settings.codexHome, 'config.toml'),
        }));
        if (result.filePath !== join(settings.codexHome, 'config.toml')) throw new Error('plugin_host_write_target_mismatch');
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
    const entries = await list();
    if (await target() !== expectedTarget) throw new Error('plugin_host_target_changed');
    return { target: expectedTarget, entries };
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

import { z } from 'zod';
import { Connection } from '../harness/dsh/connection.ts';
import type { PluginCommand, PluginEntry, PluginSourceCommand } from '../shared/plugins.ts';
import { matchesPluginAction, PluginSourceError, type PluginBackend, type PluginResult } from './plugin-backend.ts';
import { githubIndex, githubRepository, publicHttps } from './plugin-sources.ts';

export const dshPluginSources = z.array(z.object({
  label: z.string().min(1).max(120),
  url: z.url({ protocol: /^https$/ }).max(512).refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && url.href === value;
  }),
}).strict()).max(4).refine(sources => new Set(sources.map(source => source.url)).size === sources.length);

const packageName = z.string().max(200).regex(/^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/);
const gitSpec = z.string().max(512).regex(/^git\+https:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_/-]+(?:\.git)?#[a-f0-9]{40}(?:&path:\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/);
const githubRecorded = /^github:([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)(#[a-f0-9]{40}(?:&path:\/[a-zA-Z0-9_/-]+)?)$/;

function gitIdentity(value: string | undefined): string | undefined {
  const shorthand = value && githubRecorded.exec(value);
  const expanded = shorthand ? 'git+https://github.com/' + shorthand[1] + '.git' + shorthand[2] : value;
  return gitSpec.safeParse(expanded).data;
}
const localized = z.union([z.string().max(1000), z.object({ zh: z.string().max(1000).optional(), en: z.string().max(1000).optional() })]);
const indexSummary = z.array(z.object({ url: z.string(), title: localized.optional(), error: z.string().optional() })).max(40);
const versions = z.object({
  version: z.string().min(1).max(128),
  install: z.object({ spec: z.string().max(2048) }),
  publishTimestamp: z.number().int().min(0).max(4_102_444_800).optional(),
  source: z.object({ url: z.string().max(512).optional(), commit: z.string().regex(/^[a-f0-9]{40}$/).optional(), path: z.string().max(240).optional() }).optional(),
  compatibility: z.object({ compatible: z.boolean() }),
});
const marketPage = z.object({
  url: z.string(), fetchedAt: z.number(), nextOffset: z.number().int().nonnegative().nullable(),
  entries: z.array(z.object({
    name: packageName, title: localized.optional(), description: localized.optional(),
    author: z.string().max(240).optional(), homepage: z.string().max(512).optional(),
    defaultVersion: z.string().max(128).optional(), versions: z.array(versions).max(256),
  })).max(100),
});
const bundleRows = z.array(z.object({
  name: packageName, availability: z.enum(['installation', 'profile', 'missing']),
  installed: z.boolean(), enabled: z.boolean(), removable: z.boolean(),
  version: z.string().max(128).optional(), source: z.string().max(2048).optional(),
  readOnlyReason: z.string().optional(), error: z.object({ code: z.string() }).optional(),
  description: z.string().max(1000).optional(),
  rows: z.array(z.object({ entryId: z.string().optional() })).max(200),
})).max(500);
const changeResult = z.object({
  application: z.enum(['applied', 'restart-required', 'failed', 'overridden', 'cancelled']),
  target: z.string(), bundle: z.string().optional(), version: z.string().optional(),
});
type Candidate = { entry: PluginEntry; spec?: string; releaseSpecs?: Map<string, string>; rowsLoaded: boolean };

function display(value: z.infer<typeof localized> | undefined, fallback: string): string {
  return (typeof value === 'string' ? value : value?.zh ?? value?.en)?.trim() || fallback;
}

export function dshPlugins(launchFile: string, sources: z.infer<typeof dshPluginSources>): PluginBackend {
  const connection = new Connection(launchFile);

  const indexes = async () => indexSummary.parse(await connection.call('pluginMarket/listIndexes'));
  function isPublicIndex(url: string): boolean {
    try { githubIndex(url); return true; } catch { return false; }
  }
  async function markets() {
    return (await indexes()).flatMap(index => {
      const configured = sources.find(source => source.url === index.url);
      if (!configured && !isPublicIndex(index.url)) return [];
      return [{ id: index.url, url: index.url, name: display(index.title, configured?.label ?? new URL(index.url).pathname.split('/')[2] ?? index.url),
        removable: !configured, unavailable: !!index.error }];
    });
  }
  function installSpec(spec: string, managed: boolean): string | undefined {
    const candidate = gitSpec.safeParse(spec).data;
    if (!candidate || !managed) return candidate;
    try {
      const url = candidate.slice(4).split('#')[0]!;
      return githubRepository(url).url === url ? candidate : undefined;
    } catch { return undefined; }
  }

  async function snapshot(requiredSource?: string): Promise<Candidate[]> {
    const native = bundleRows.parse(await connection.call('pluginManager/listBundles'));
    const byName = new Map(native.map(bundle => [bundle.name, bundle]));
    const result = new Map<string, Candidate>();
    const ambiguous = new Set<string>();
    for (const source of await markets()) {
      try {
      let offset = 0;
      let fetchedAt: number | undefined;
      for (let page = 0; page < 4; page++) {
        const reply = marketPage.parse(await connection.call('pluginMarket/search', {
          url: source.url, query: { offset, limit: 50, sort: { kind: 'index' }, ...(fetchedAt !== undefined ? { fetchedAt } : {}) },
        }));
        if (reply.url !== source.url || fetchedAt !== undefined && fetchedAt !== reply.fetchedAt)
          throw new Error('plugin_index_changed');
        for (const item of reply.entries) {
          const previous = result.get(item.name);
          if (previous) {
            ambiguous.add(item.name);
            previous.entry.actions = [];
          }
          const installed = byName.get(item.name);
          const available = item.versions.find(version => version.version === item.defaultVersion && version.compatibility.compatible);
          const releaseSpecs = new Map(item.versions.flatMap(version => {
            const allowed = version.compatibility.compatible && installSpec(version.install.spec, source.removable);
            return allowed ? [[version.version, allowed] as const] : [];
          }));
          const spec = (available && releaseSpecs.get(available.version)) ?? releaseSpecs.values().next().value;
          const installedSource = gitIdentity(installed?.source);
          const matchingInstall = installedSource && item.versions.some(version =>
            gitIdentity(version.install.spec) === installedSource && version.version === installed?.version);
          const rowsLoaded = !!installed?.rows.length && installed.rows.every(row => !!row.entryId);
          const selected = !!installed?.enabled;
          const present = !!installed?.installed || installed?.availability === 'installation';
          const actions: PluginEntry['actions'] = [];
          if (!present && !installed && releaseSpecs.size) actions.push('install');
          if (present && installed && matchingInstall && !installed.readOnlyReason) {
            if (selected || !installed.error) actions.push(selected ? 'disable' : 'enable');
            if (installed.removable) actions.push('remove');
            if (selected && [...releaseSpecs.keys()].some(version => version !== installed.version)) actions.push('install');
          }
          if (previous && !matchingInstall) continue;
          result.set(item.name, {
            spec, releaseSpecs, rowsLoaded,
            entry: {
              id: item.name, name: display(item.title, item.name).slice(0, 240), description: display(item.description, ''),
              source: matchingInstall || !present ? source.name : 'DSH Web profile',
              sourceId: source.id,
              author: item.author, homepage: publicHttps(item.homepage),
              releases: item.versions.map(version => ({
                version: version.version, installable: releaseSpecs.has(version.version), publishedAt: version.publishTimestamp,
                repository: publicHttps(version.source?.url), commit: version.source?.commit, directory: version.source?.path,
              })),
              version: installed?.version ?? available?.version ?? null,
              installed: present, enabled: selected,
              application: installed?.error ? 'failed' : selected && rowsLoaded ? 'applied' : 'unverified',
              actions: ambiguous.has(item.name) && !matchingInstall ? [] : actions,
            },
          });
        }
        if (reply.nextOffset === null) break;
        if (reply.nextOffset <= offset || page === 3) throw new Error('plugin_index_limit');
        offset = reply.nextOffset;
        fetchedAt = reply.fetchedAt;
      }
      } catch (error) {
        if (source.id === requiredSource) throw error;
        // An unavailable market does not hide the other sources.
      }
    }
    for (const bundle of native) {
      if (result.has(bundle.name) || !bundle.installed && !bundle.enabled) continue;
      const rowsLoaded = bundle.rows.length > 0 && bundle.rows.every(row => !!row.entryId);
      result.set(bundle.name, { rowsLoaded, entry: {
        id: bundle.name, name: bundle.name, description: bundle.description ?? '', source: 'DSH Web profile',
        version: bundle.version ?? null, installed: true, enabled: bundle.enabled, system: bundle.availability === 'profile',
        application: bundle.error ? 'failed' : bundle.enabled && rowsLoaded ? 'applied' : 'unverified', actions: [],
      } });
    }
    if (result.size > 1000) throw new Error('plugin_catalog_limit');
    return [...result.values()];
  }

  function observed(command: PluginCommand, entries: Candidate[]): boolean {
    if (!matchesPluginAction(command, entries.map(item => item.entry))) return false;
    const result = entries.find(item => item.entry.id === command.pluginId);
    if (command.action === 'remove' || command.action === 'disable') return !result?.rowsLoaded;
    return result?.entry.application === 'applied';
  }

  async function checkResult(command: PluginCommand, raw: unknown): Promise<PluginResult> {
    const result = changeResult.parse(raw);
    if (result.application === 'failed' || result.application === 'overridden' || result.application === 'cancelled') return 'failed';
    if ((result.bundle ?? result.target) !== command.pluginId) return 'unknown';
    if (result.application === 'restart-required') return 'restart-required';
    return observed(command, await snapshot()) ? 'applied' : 'unknown';
  }

  async function updateSource(command: PluginSourceCommand) {
    const previous = await indexes();
    const urls = previous.map(source => source.url);
    if (command.action === 'remove') {
      if (!isPublicIndex(command.id) || sources.some(source => source.url === command.id))
        throw new PluginSourceError('invalid_plugin_source');
      if (!urls.includes(command.id)) return;
      if ((await snapshot(command.id)).some(row => row.entry.sourceId === command.id && row.entry.installed))
        throw new PluginSourceError('plugin_source_in_use');
      await connection.call('pluginMarket/setIndexes', { urls: urls.filter(url => url !== command.id) }, 30_000);
      return;
    }
    if (command.ref) throw new PluginSourceError('invalid_plugin_source');
    const url = githubIndex(command.source);
    if (urls.includes(url)) return;
    if (urls.length >= 8) throw new PluginSourceError('plugin_source_conflict');
    await connection.call('pluginMarket/setIndexes', { urls: [...urls, url] }, 30_000);
    try {
      marketPage.parse(await connection.call('pluginMarket/search', { url, query: { offset: 0, limit: 1, sort: { kind: 'index' }, refresh: true } }, 30_000));
    } catch {
      // Keep independently edited native sources when reversing a failed addition.
      const current = (await indexes()).map(index => index.url);
      if (current.join('\n') === [...urls, url].join('\n'))
        await connection.call('pluginMarket/setIndexes', { urls }, 30_000);
      throw new PluginSourceError('invalid_plugin_source');
    }
  }

  return {
    sources: markets,
    updateSource,
    recoverSource: async command => {
      const url = command.action === 'add' ? githubIndex(command.source) : command.id;
      const found = (await indexes()).some(source => source.url === url);
      if (command.action === 'remove') return found ? 'unknown' : 'applied';
      if (!found || command.ref) return 'unknown';
      marketPage.parse(await connection.call('pluginMarket/search', { url, query: { offset: 0, limit: 1, sort: { kind: 'index' } } }, 30_000));
      return 'applied';
    },
    list: async () => (await snapshot()).map(item => item.entry),
    change: async command => {
      const target = (await snapshot()).find(item => item.entry.id === command.pluginId);
      if (!target?.entry.actions.includes(command.action)) return 'failed';
      let raw;
      if (command.action === 'install') {
        if (target.entry.installed && (!target.entry.enabled || !command.version || command.version === target.entry.version)) return 'failed';
        const spec = command.version ? target.releaseSpecs?.get(command.version) : target.spec;
        if (!spec) return 'failed';
        raw = await connection.call('pluginManager/installBundle', {
          spec, options: { requestId: command.id, saveExact: true, enabled: true },
        }, 120_000);
      } else if (command.action === 'remove') {
        raw = await connection.call('pluginManager/removeBundle', { name: command.pluginId }, 60_000);
      } else {
        raw = await connection.call('pluginManager/setBundleEnabled', { name: command.pluginId, enabled: command.action === 'enable' }, 60_000);
      }
      return await checkResult(command, raw);
    },
    recover: async command => {
      if (command.action === 'install') {
        const pending = await connection.call('pluginManager/waitForInstall', { requestId: command.id }, 20_000);
        if (pending !== null) return await checkResult(command, pending);
      }
      return observed(command, await snapshot()) ? 'applied' : 'unknown';
    },
    close: () => connection.close(),
  };
}

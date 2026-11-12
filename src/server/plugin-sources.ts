import { PluginSourceError } from './plugin-backend.ts';

const repoPart = '[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}';
const repoPath = new RegExp('^(' + repoPart + ')/(' + repoPart + ')$');
const indexPath = new RegExp('^/' + repoPart + '/' + repoPart + '/[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}(?:/[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})+\\.json$');

export function githubRepository(input: string): { url: string; path: string } {
  const value = input.startsWith('https://github.com/') ? input.slice('https://github.com/'.length) : input;
  const path = value.replace(/\.git$/, '');
  if (!repoPath.test(path)) throw new PluginSourceError('invalid_plugin_source');
  return { url: 'https://github.com/' + path + '.git', path };
}

export function githubIndex(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new PluginSourceError('invalid_plugin_source'); }
  if (url.origin !== 'https://raw.githubusercontent.com' || url.href !== input || url.username ||
    url.password || url.search || url.hash || !indexPath.test(url.pathname))
    throw new PluginSourceError('invalid_plugin_source');
  return url.href;
}

export async function readGithubManifest(repository: string, commit: string, signal?: AbortSignal): Promise<unknown> {
  return await readGithubJson(repository, commit, '.agents/plugins/marketplace.json', signal);
}

export async function readGithubJson(repository: string, commit: string, path: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch('https://raw.githubusercontent.com/' + repository + '/' + commit + '/' + path, {
    redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (response.status === 404) throw new PluginSourceError('invalid_plugin_source');
  if (!response.ok || !response.body) throw new Error('plugin_manifest_unavailable');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new PluginSourceError('invalid_plugin_source');
      }
      parts.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown; }
    catch { throw new PluginSourceError('invalid_plugin_source'); }
  } finally { reader.releaseLock(); }
}

export function publicHttps(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 512 ? url.href : undefined;
  } catch { return undefined; }
}

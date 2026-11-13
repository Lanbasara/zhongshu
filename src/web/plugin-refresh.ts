import { pluginView, type PluginHarness, type PluginView } from '../shared/plugins.ts';
import { RequestError, request } from './workbench-client.ts';

export type PluginRefreshResult = {
  view: PluginView;
  /** True only when the user-added Codex markets were actually checked on this action. */
  checked: boolean;
  /** Why a Codex check did not run; the returned view is still the native state. */
  failure?: unknown;
};

/**
 * Re-read the plugin view for a person's refresh.
 *
 * Codex update candidates only exist after a market check, and a page read never reaches the
 * network, so the refresh action itself checks the user-added markets and returns the checked
 * view. A check that cannot run (a native operation is still settling, or the manager is
 * unavailable) degrades to a plain state read instead of failing the refresh. DSH has no
 * update check; its refresh stays a native-state read.
 */
export async function refreshPluginView(harness: PluginHarness, csrf: string, signal?: AbortSignal): Promise<PluginRefreshResult> {
  const read = () => request('/plugins/' + harness, pluginView, { signal, timeoutMs: 45_000 });
  if (harness !== 'codex') return { view: await read(), checked: false };
  try {
    return { view: await request('/plugins/codex/check-updates', pluginView, { csrf, body: {}, signal, timeoutMs: 100_000 }), checked: true };
  } catch (failure) {
    if (failure instanceof RequestError && failure.status === 401) throw failure;
    return { view: await read(), checked: false, failure };
  }
}

/**
 * The notice for a check that did not run. A settling operation or an offline manager is already
 * visible in the refreshed view, so only an unexpected failure is reported in words.
 */
export function pluginCheckNotice(failure: unknown): string | undefined {
  if (failure === undefined) return undefined;
  if (failure instanceof RequestError && [409, 503].includes(failure.status)) return undefined;
  return '暂时无法检查更新；已重新读取插件状态。';
}

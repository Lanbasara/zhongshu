import { useEffect, useEffectEvent, useState } from 'react';
import { z } from 'zod';
import { RequestError } from './workbench-client.ts';

export const directoryMetadataSchema = z.object({
  nextCursor: z.string().max(4096).nullable(), generation: z.string().max(200).nullable(), latestGeneration: z.string().max(200).nullable(),
  status: z.enum(['scanning', 'ready', 'stale', 'error']), complete: z.boolean(), refreshing: z.boolean(),
  scanned: z.number().int().nonnegative(), discovered: z.number().int().nonnegative(), sourceChanged: z.boolean(), snapshot: z.literal(false), error: z.string().max(100).optional(),
});
export const directoryFilesSchema = directoryMetadataSchema.extend({
  files: z.array(z.object({ name: z.string().max(1024), path: z.string().max(1024), directory: z.boolean(), supported: z.boolean() })).max(100),
});
export type DirectoryMetadata = z.infer<typeof directoryMetadataSchema>;
type Navigation = { key: string; cursor?: string; previous: (string | null)[]; number: number; revision: number; refresh: boolean };
const beginning = (key: string): Navigation => ({ key, previous: [], number: 1, revision: 0, refresh: false });
const directoryErrors: Record<string, string> = {
  directory_cursor_expired: '文件清单已更新，已回到第一页。',
  directory_cursor_invalid: '无法继续这一页，请刷新文件清单。',
  directory_index_busy: '正在处理其他目录，请稍后重试。',
  directory_scan_queue_full: '正在扫描其他目录，请稍后重试。',
  directory_index_capacity: '目录缓存空间不足，原清单仍保留。请释放空间后重试。',
  directory_scan_interrupted: '上次扫描已中断，请刷新文件清单。',
  directory_scan_cancelled: '扫描已停止，可以重新刷新。',
  directory_identity_changed: '目录已经变化，请重新打开。',
  workspace_directory_changed: '目录已经变化，请重新打开。',
  file_reference_unavailable: '目录不可用，可能已移动或删除。',
  file_reference_forbidden: '这个目录不在可浏览的范围内。',
};
export function directoryError(reason: unknown): string {
  if (typeof reason === 'string') return directoryErrors[reason] ?? '暂时无法读取目录，请重试。';
  return reason instanceof RequestError ? directoryErrors[reason.code] ?? (reason.status === 401 ? '登录已失效，请重新登录。' : '暂时无法读取目录，请重试。') : '暂时无法读取目录，请重试。';
}
export function directoryProgress(page: DirectoryMetadata | undefined): string {
  if (!page) return '正在读取目录…';
  if (page.error) return directoryError(page.error);
  if (page.refreshing || page.status === 'scanning') return `正在扫描目录，已检查 ${page.scanned} 项，发现 ${page.discovered} 项…`;
  if (page.sourceChanged || page.generation !== page.latestGeneration) return '目录有变化，刷新后可查看最新清单。';
  return '';
}

/** Keep one page of rows and at most 32 previous cursors, never an accumulated list. */
export function useDirectoryPage<T extends DirectoryMetadata>(key: string, load: (input: { cursor?: string; refresh: boolean; signal: AbortSignal }) => Promise<T>,
  enabled = true, onError?: (reason: unknown) => void) {
  const [navigation, setNavigation] = useState<Navigation>(() => beginning(key));
  const current = navigation.key === key ? navigation : beginning(key);
  const [state, setState] = useState<{ key: string; cursor?: string; data?: T; pending: boolean; error: string; notice: string }>({ key, pending: false, error: '', notice: '' });
  const loadPage = useEffectEvent(load);
  const reportError = useEffectEvent((reason: unknown) => onError?.(reason));
  const visible = state.key === key && state.cursor === current.cursor;
  const data = visible ? state.data : undefined;
  const pending = enabled && (!visible || state.pending);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fetching = false; let first = true; let polling = true;
    const cursor = current.cursor;
    const wantsRefresh = current.refresh;
    setState(previous => ({ key, cursor, pending: true, data: previous.key === key && previous.cursor === cursor ? previous.data : undefined,
      error: '', notice: previous.key === key ? previous.notice : '' }));
    async function fetchPage() {
      if (fetching || controller.signal.aborted || document.hidden) return;
      fetching = true;
      try {
        const page = await loadPage({ cursor, refresh: first && wantsRefresh, signal: controller.signal });
        first = false;
        if (controller.signal.aborted) return;
        polling = page.status === 'scanning' || page.refreshing;
        setState(previous => ({ key, cursor, data: page, pending: false, error: '', notice: previous.key === key ? previous.notice : '' }));
      } catch (reason) {
        if (controller.signal.aborted) return;
        polling = false;
        if (cursor && reason instanceof RequestError && reason.code === 'directory_cursor_expired') {
          setState({ key, pending: true, error: '', notice: directoryError(reason) });
          setNavigation(previous => ({ ...beginning(key), revision: previous.revision + 1 }));
        } else {
          setState(previous => ({ ...previous, key, cursor, pending: false, error: directoryError(reason) }));
          reportError(reason);
        }
      } finally {
        fetching = false;
        if (polling && !controller.signal.aborted && !document.hidden) timer = setTimeout(() => void fetchPage(), 500);
      }
    }
    function visibility() {
      if (document.hidden) clearTimeout(timer);
      else if (polling) void fetchPage();
    }
    void fetchPage();
    document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [key, enabled, current.cursor, current.revision]);

  return {
    data, pending, error: visible ? state.error : '', notice: visible ? state.notice : '', number: current.number,
    canPrevious: current.previous.length > 0 && !pending,
    canNext: !!data?.nextCursor && !pending,
    previous() {
      if (!current.previous.length || pending) return;
      setNavigation({ ...current, cursor: current.previous.at(-1) ?? undefined, previous: current.previous.slice(0, -1), number: current.number - 1, refresh: false });
    },
    next() {
      if (!data?.nextCursor || pending) return;
      setNavigation({ ...current, cursor: data.nextCursor, previous: [...current.previous, current.cursor ?? null].slice(-32), number: current.number + 1, refresh: false });
    },
    first() { setNavigation({ ...beginning(key), revision: current.revision + 1 }); },
    refresh() { setState(previous => ({ ...previous, notice: '' })); setNavigation({ ...beginning(key), revision: current.revision + 1, refresh: true }); },
  };
}

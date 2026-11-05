import { useEffect, useRef } from 'react';
import { useCursorWindow } from './cursor-window.tsx';
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
const directoryErrors: Record<string, string> = {
  directory_cursor_expired: '文件清单已更新，正在载入最新目录。',
  directory_cursor_invalid: '目录已变化，请重新读取文件清单。',
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

/** Keep a small continuous window per directory; going back reuses its cache. */
export function useDirectoryPage<T extends DirectoryMetadata>(key: string, load: (input: { cursor?: string; refresh: boolean; signal: AbortSignal }) => Promise<T>,
  enabled = true, onError?: (reason: unknown) => void) {
  const refreshRequested = useRef(false);
  const feed = useCursorWindow<T>({ key, enabled,
    load: async (cursor, signal) => {
      const refresh = refreshRequested.current; refreshRequested.current = false;
      const value = await load({ cursor, refresh, signal });
      return { value, next: value.nextCursor };
    }, onError,
  });
  useEffect(() => {
    if (feed.error instanceof RequestError && feed.error.code === 'directory_cursor_expired') feed.reset();
  }, [feed.error]);
  const last = feed.data;
  useEffect(() => {
    if (!enabled || !last || last.status !== 'scanning' && !last.refreshing) return;
    const timer = setTimeout(() => { if (!document.hidden) feed.refresh(); }, 500);
    const visible = () => { if (!document.hidden) feed.refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [key, enabled, last, feed.pending]);
  const data = last && { ...last,
    ...('files' in last ? { files: [...new Map(feed.pages.flatMap(page => (page as T & { files: { path: string }[] }).files).map(file => [file.path, file])).values()] } : {}),
    ...('names' in last ? { names: [...new Set(feed.pages.flatMap(page => (page as T & { names: string[] }).names))] } : {}),
  } as T | undefined;
  return { ...feed, data, error: feed.error ? directoryError(feed.error) : '', notice: '',
    refreshAvailable: !!last?.sourceChanged || !!last?.error,
    refresh() { refreshRequested.current = true; feed.reset(); },
  };
}

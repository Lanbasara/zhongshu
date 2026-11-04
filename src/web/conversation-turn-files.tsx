import { useEffect, useState } from 'react';
import { turnFilePageSchema, type TurnFilePage, type TurnFileSummary } from '../shared/workbench.ts';
import { TurnFiles } from './patterns/turn-files.tsx';
import { Button } from './ui/controls.tsx';
import { request } from './workbench-client.ts';

/** Only a mounted transcript row reads paths. Paging replaces the page so file
 * DOM and browser memory do not grow as the reader traverses a long list. */
export function ConversationTurnFiles({ conversation, summary, activePath, unavailable, workspaceUnavailable, onOpen }: {
  conversation: string; summary: TurnFileSummary; activePath?: string; unavailable?: ReadonlySet<string>; workspaceUnavailable?: boolean;
  onOpen(path: string, trigger: HTMLButtonElement): void;
}) {
  const [cursor, setCursor] = useState<string>(); const [previous, setPrevious] = useState<(string | undefined)[]>([]);
  const [page, setPage] = useState<TurnFilePage>(); const [error, setError] = useState(false); const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setPage(undefined); setError(false);
    const query = new URLSearchParams({ run: summary.runId }); if (cursor) query.set('after', cursor);
    void request(`/conversations/${conversation}/turn-files?${query}`, turnFilePageSchema, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setPage(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [conversation, summary.runId, summary.count, cursor, retry]);
  if (error) return <p role="alert">无法读取本轮文件。<Button variant="quiet" onClick={() => setRetry(value => value + 1)}>重试</Button></p>;
  if (!page) return <p className="quiet" role="status">正在读取本轮文件…</p>;
  return <>
    <TurnFiles files={page.paths.map(path => ({ path, unavailable: workspaceUnavailable || unavailable?.has(JSON.stringify([summary.runId, path])) }))}
      limited={page.limited || !!page.afterPath || !!cursor} activePath={activePath} onOpen={onOpen}/>
    {(previous.length > 0 || page.afterPath) && <nav aria-label="本轮文件分页">
      <Button variant="quiet" disabled={!previous.length} onClick={() => { setCursor(previous.at(-1)); setPrevious(value => value.slice(0, -1)); }}>上一页文件</Button>
      <span className="quiet">第 {previous.length + 1} 页 · 共记录 {page.count} 个</span>
      <Button variant="quiet" disabled={!page.afterPath} onClick={() => { setPrevious(value => [...value, cursor]); setCursor(page.afterPath!); }}>下一页文件</Button>
    </nav>}
    {page.limited && <p className="quiet">{(page.count ?? 0) >= 500 ? '本轮记录超过 500 个文件' : '本轮只保留部分文件路径'}，可在工作区目录查找其余文件。</p>}
  </>;
}

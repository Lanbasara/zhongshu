import { useEffect, useRef, useState } from 'react';
import { workspaceLookupSchema, workspacePageSchema, type WorkbenchConfiguration } from '../shared/workbench.ts';
import { RequestError, request } from './workbench-client.ts';
import { progressiveSearch } from './progressive-search.ts';
import { Button } from './ui/controls.tsx';

type Workspace = WorkbenchConfiguration['workspaces'][number];
export function useWorkspacePage(initial: Workspace[] | undefined, initialCursor: string | null | undefined, query = '', removed = false, enabled = true) {
  const [entries, setEntries] = useState(initial ?? []);
  const [cursors, setCursors] = useState<string[]>([]);
  const [next, setNext] = useState(initialCursor ?? null);
  const [scanLimited, setScanLimited] = useState(false); const [scanned, setScanned] = useState(0);
  const pause = useRef(() => {});
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0); const cursor = cursors.at(-1);
  const [term, setTerm] = useState(query);
  useEffect(() => { const timer = setTimeout(() => { setTerm(query.trim()); setCursors([]); }, 180); return () => clearTimeout(timer); }, [query, removed]);
  useEffect(() => {
    if (!enabled) return;
    if (initialCursor === undefined && !term && !cursor && !retry) { setEntries(initial ?? []); setNext(null); setLoading(false); setScanned(0); setScanLimited(false); return; }
    if (query.trim() !== term) return;
    const controller = new AbortController(); setLoading(true); setError(''); setScanned(0);
    let paused = false; pause.current = () => { paused = true; };
    void progressiveSearch({ cursor, signal: controller.signal, continuous: !!term, paused: () => paused,
      fetch: async current => {
        const params = new URLSearchParams({ removed: removed ? '1' : '0', ...(term ? { query: term } : {}), ...(current ? { cursor: current } : {}) });
        const value = await request(`/workspaces?${params}`, workspacePageSchema, { signal: controller.signal });
        return { value, nextCursor: value.nextCursor, scanned: value.scanned ?? value.workspaces.length, found: value.workspaces.length > 0 };
      },
      progress: ({ value }, total) => { setEntries(value.workspaces); setNext(value.nextCursor); setScanLimited(value.scanLimited ?? false); setScanned(total); },
    }).catch(reason => {
      if (controller.signal.aborted) return;
      if (reason instanceof RequestError && reason.code === 'workspace_cursor_expired') { setCursors([]); setRetry(value => value + 1); setError('工作区列表已更新，已回到第一页。'); }
      else setError('工作区列表暂时无法读取。');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [initial, initialCursor, term, query, cursor, removed, retry, enabled]);
  return { entries, loading, error, scanLimited, scanned, searching: !!term, pause: () => pause.current(), page: cursors.length + 1, hasPrevious: cursors.length > 0, hasNext: !!next,
    previous: () => setCursors(value => value.slice(0, -1)), next: () => { if (next) setCursors(value => [...value.slice(-31), next]); },
    first: () => { setCursors([]); setRetry(value => value + 1); }, retry: () => setRetry(value => value + 1) };
}

export function WorkspacePages({ page }: { page: ReturnType<typeof useWorkspacePage> }) {
  return <><div className="directory-pages" aria-label="工作区分页">
    <Button variant="quiet" disabled={!page.hasPrevious || page.loading} onClick={page.previous}>上一页</Button>
    <Button variant="quiet" disabled={!page.hasPrevious || page.loading} onClick={page.first}>第一页</Button>
    <Button variant="quiet" disabled={!page.hasNext || page.loading} onClick={page.next}>{page.scanLimited ? '继续查找' : '下一页'}</Button>
  </div>{page.scanLimited && !page.loading && <p className="quiet" role="status">这批记录已查找完，可继续查找后续工作区。</p>}{page.loading && <p className="quiet" role="status">{page.searching ? `正在查找工作区，已检查 ${page.scanned} 条…` : '正在读取工作区…'} {page.searching && <button type="button" className="text-button" onClick={page.pause}>暂停查找</button>}</p>}{page.error && <p role="status">{page.error} <button type="button" className="text-button" onClick={page.retry}>重试</button></p>}</>;
}

export function WorkspaceSelect({ id, label = '工作区', value, onChange, initial, cursor, disabled }: {
  id?: string; label?: string; value: string; onChange(id: string): void; initial: Workspace[]; cursor?: string | null; disabled?: boolean;
}) {
  const [query, setQuery] = useState(''); const page = useWorkspacePage(initial, cursor, query);
  const [selected, setSelected] = useState<Workspace | null>(null);
  const selection = useRef(value); selection.current = value;
  useEffect(() => {
    const present = initial.find(entry => entry.id === value) ?? page.entries.find(entry => entry.id === value);
    if (present) { setSelected(present); return; }
    if (!value) { setSelected(null); return; }
    const controller = new AbortController();
    void request(`/workspaces/${encodeURIComponent(value)}`, workspaceLookupSchema, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && selection.current === value) setSelected(result.workspace); }).catch(() => {});
    return () => controller.abort();
  }, [value, initial, page.entries]);
  const options = selected && !page.entries.some(entry => entry.id === selected.id) ? [selected, ...page.entries] : page.entries;
  return <div className="workspace-selection"><input type="search" aria-label={`搜索${label}`} placeholder={`搜索${label}`} maxLength={200} value={query} disabled={disabled} onChange={event => setQuery(event.target.value)}/>
    <select id={id} aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{options.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select>
    <WorkspacePages page={page}/>
  </div>;
}

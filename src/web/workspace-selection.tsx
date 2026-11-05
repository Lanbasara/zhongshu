import { useEffect, useRef, useState } from 'react';
import { Popover } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import { workspaceLookupSchema, workspacePageSchema, type WorkbenchConfiguration } from '../shared/workbench.ts';
import { RequestError, request } from './workbench-client.ts';
import { progressiveSearch } from './progressive-search.ts';
import { Button } from './ui/controls.tsx';
import { ScrollContinuation, useCursorWindow } from './cursor-window.tsx';

type Workspace = WorkbenchConfiguration['workspaces'][number];
export function useWorkspacePage(initial: Workspace[] | undefined, initialCursor: string | null | undefined, query = '', removed = false, enabled = true) {
  const [term, setTerm] = useState(query.trim());
  const [scanned, setScanned] = useState(0); const pause = useRef(false);
  const [searchPaused, setSearchPaused] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setTerm(query.trim()), 180); return () => clearTimeout(timer); }, [query]);
  const feed = useCursorWindow({ key: JSON.stringify([removed, term]), enabled: enabled && term === query.trim(),
    revision: JSON.stringify([initial, initialCursor]),
    initial: !term && initial ? { value: { workspaces: initial, nextCursor: initialCursor ?? null }, next: initialCursor ?? null } : undefined,
    load: async (cursor, signal, intent) => {
      if (intent === 'load') { pause.current = false; setSearchPaused(false); }
      const batch = await progressiveSearch({ cursor, signal, continuous: !!term && intent === 'load', paused: () => pause.current,
        fetch: async current => {
          const params = new URLSearchParams({ removed: removed ? '1' : '0', ...(term ? { query: term } : {}), ...(current ? { cursor: current } : {}) });
          const value = await request(`/workspaces?${params}`, workspacePageSchema, { signal });
          return { value, nextCursor: value.nextCursor, scanned: value.scanned ?? value.workspaces.length, found: value.workspaces.length > 0 };
        }, progress: (_batch, total) => setScanned(total),
      });
      return { value: batch.value, next: batch.nextCursor, cursor: batch.startCursor };
    },
  });
  useEffect(() => { if (feed.error instanceof RequestError && feed.error.code === 'workspace_cursor_expired') feed.reset(); }, [feed.error]);
  return { ...feed, entries: [...new Map(feed.pages.flatMap(page => page.workspaces).map(row => [row.id, row])).values()], loading: feed.pending,
    hasPrevious: feed.canPrevious, hasNext: feed.canNext, scanned, searching: !!term, searchPaused, pause: () => { pause.current = true; setSearchPaused(true); },
    retry: feed.refresh, first: feed.reset };
}

export function WorkspacePages({ page }: { page: ReturnType<typeof useWorkspacePage> }) {
  return <div ref={page.marker}>
    <ScrollContinuation available={page.hasNext} pending={page.loading && (!page.entries.length || page.hasNext)} load={page.next} automatic={!page.searchPaused}/>
    {page.loading && page.searching && <p className="quiet" role="status">正在查找工作区，已检查 {page.scanned} 条… <button type="button" className="text-button" onClick={page.pause}>暂停查找</button></p>}
    {!!page.error && <p role="status">工作区列表暂时无法读取。 <button type="button" className="text-button" onClick={page.retry}>重试</button></p>}
  </div>;
}

export function WorkspaceSelect({ id, label = '工作区', value, onChange, initial, cursor, disabled }: {
  id?: string; label?: string; value: string; onChange(id: string): void; initial: Workspace[]; cursor?: string | null; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false); const [query, setQuery] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const page = useWorkspacePage(initial, cursor, query, false, open);
  const [selected, setSelected] = useState<Workspace | null>(null);
  const selection = useRef(value); selection.current = value;
  useEffect(() => {
    const present = initial.find(entry => entry.id === value) ?? page.entries.find(entry => entry.id === value);
    if (present) { setSelected(previous => previous?.id === present.id && previous.label === present.label ? previous : present); return; }
    if (!value) { setSelected(null); return; }
    if (selected?.id === value) return;
    const controller = new AbortController();
    void request(`/workspaces/${encodeURIComponent(value)}`, workspaceLookupSchema, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && selection.current === value) setSelected(result.workspace); }).catch(() => {});
    return () => controller.abort();
  }, [value, initial, page.entries.map(row => row.id + row.label).join('|')]);
  return <div ref={container}><Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><Button id={id} className="workspace-combobox" role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox" disabled={disabled}>
      <span>{selected?.label ?? initial.find(row => row.id === value)?.label ?? '选择工作区'}</span><ChevronDown size={16}/>
    </Button></Popover.Trigger>
    <Popover.Portal container={container.current ?? undefined}><Popover.Content className="workspace-options" sideOffset={4} align="start" collisionPadding={12}>
      <input type="search" aria-label={`搜索${label}`} placeholder="搜索工作区…" maxLength={200} value={query} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); event.currentTarget.parentElement?.querySelector<HTMLElement>('[role=option]')?.focus(); } }}/>
      <div className="workspace-options-scroll" role="listbox" aria-label={`${label}选项`}>
        <ScrollContinuation available={page.hasPrevious} pending={false} load={page.previous} label="显示上方工作区"/>
        {page.entries.map(entry => <button key={entry.id} type="button" role="option" data-scroll-row aria-selected={entry.id === value}
          onClick={() => { onChange(entry.id); setSelected(entry); setOpen(false); }} onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            event.preventDefault(); const options = [...event.currentTarget.parentElement!.querySelectorAll<HTMLElement>('[role=option]')];
            options[(options.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
          }}><span>{entry.label}</span>{entry.id === value && <Check size={15}/>}</button>)}
        {!page.loading && !page.entries.length && !page.error && <p className="quiet">没有匹配的工作区</p>}
        <WorkspacePages page={page}/>
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root></div>;
}

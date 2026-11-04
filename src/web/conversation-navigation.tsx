import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { conversationListSchema, conversationResponseSchema, conversationTitleSchema, type Conversation, type WorkbenchConfiguration } from '../shared/workbench.ts';
import { RequestError, request } from './workbench-client.ts';
import type { WorkspaceAction } from './workspace-management.tsx';
import { progressiveSearch } from './progressive-search.ts';
import { useWorkspacePage, WorkspacePages } from './workspace-selection.tsx';

const widthKey = 'zhongshu:sidebar-width';
const minWidth = 224;
const maxWidth = 440;
const clampWidth = (value: number) => Math.min(maxWidth, Math.max(minWidth, value));

export function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(widthKey));
      if (Number.isFinite(saved) && saved >= minWidth) return clampWidth(saved);
    } catch { /* Storage can be unavailable. */ }
    return 264;
  });
  const update = (value: number) => {
    const next = clampWidth(Math.round(value));
    setWidth(next);
    try { localStorage.setItem(widthKey, String(next)); } catch { /* Keep the current in-memory width. */ }
  };
  const style = { '--sidebar-width': `${width}px` } as CSSProperties;
  const separator = <div className="sidebar-resize" role="separator" tabIndex={0} aria-label="调整侧栏宽度"
    aria-orientation="vertical" aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={width}
    onPointerDown={event => { if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        const sidebar = event.currentTarget.parentElement!;
        update(event.clientX - sidebar.getBoundingClientRect().left);
      }
    }}
    onKeyDown={event => {
      const target = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: minWidth, End: maxWidth }[event.key];
      if (typeof target === 'number') { event.preventDefault(); update(target); }
    }} />;
  return { style, separator };
}

type NavigationProps = {
  workspaces?: WorkbenchConfiguration['workspaces'];
  removedWorkspaces?: WorkbenchConfiguration['removedWorkspaces'];
  workspaceCursor?: string | null;
  removedWorkspaceCursor?: string | null;
  canAddWorkspace?: boolean;
  workspaceAction(action: WorkspaceAction): void;
  selected?: string;
  revision: number;
  csrf: string;
  choose(id: string): void;
  create(workspaceId: string): void;
  changed(): void;
  report(reason: unknown): void;
  stateLabel(conversation: Conversation): string;
};

type Query = { workspaceId?: string; unregistered?: true; title?: string; archived?: boolean };
type RowProps = {
  selected?: string;
  choose(id: string): void;
  manage(conversation: Conversation): void;
  stateLabel(conversation: Conversation): string;
};

function Results({ query, revision, csrf, report, rows, hideEmpty, workspaceLabel, label, visible = true }: {
  query: Query; revision: number; csrf: string; report(reason: unknown): void; rows: RowProps;
  hideEmpty?: boolean; workspaceLabel?: (id: string) => string; label?: string; visible?: boolean;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const beforeId = cursors.at(-1);
  const [results, setResults] = useState<Conversation[]>([]);
  const [resultLabels, setResultLabels] = useState<Map<string, string>>(new Map());
  const [next, setNext] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [scanned, setScanned] = useState(0); const pauseSearch = useRef(() => {});
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const queryKey = JSON.stringify(query);
  const pendingRefresh = useRef<() => void>(() => {});
  const latestReport = useRef(report);
  latestReport.current = report;

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let loading = false;
    let refreshRequested = false; let paused = false; pauseSearch.current = () => { paused = true; };
    const fetchPage = async (foreground = false) => {
      loading = true;
      // Passive revalidation keeps the known page and its controls usable.
      // Only an explicit page/query change owns the loading indicator/lock.
      if (foreground) { setLoadingPage(true); setScanned(0); }
      try {
        await progressiveSearch({ cursor: beforeId, signal: controller.signal, continuous: foreground && !!query.title, paused: () => paused,
          fetch: async current => {
            const result = await request('/conversation-search', conversationListSchema, {
              csrf, signal: controller.signal, body: { ...JSON.parse(queryKey), beforeId: current },
            });
            return { value: result, nextCursor: result.olderBeforeId, scanned: result.scanned ?? result.conversations.length, found: result.conversations.length > 0 };
          },
          progress: ({ value: result }, total) => { setResults(result.conversations); setResultLabels(new Map(result.workspaceLabels?.map(value => [value.id, value.label]))); setNext(result.olderBeforeId); setScanned(total); setLoaded(true); setFailed(false); },
        });
      } catch (reason) {
        if (controller.signal.aborted) return;
        setFailed(true);
        if (reason instanceof RequestError && reason.status === 401) latestReport.current(reason);
      } finally {
        loading = false;
        if (foreground && !controller.signal.aborted) setLoadingPage(false);
        if (refreshRequested && !controller.signal.aborted) {
          refreshRequested = false;
          void fetchPage();
        }
      }
    };
    pendingRefresh.current = () => {
      if (query.title && paused) return;
      if (loading) { if (!query.title) refreshRequested = true; }
      else void fetchPage();
    };
    void fetchPage(true);
    return () => controller.abort();
  }, [beforeId, queryKey, csrf, retry, visible]);

  const seenRevision = useRef(revision);
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    if (visible) pendingRefresh.current();
  }, [revision, visible]);

  return <>
    {visible && loadingPage && !failed && <p className="navigation-empty" role="status">{query.title ? `正在查找，已检查 ${scanned} 条…` : '正在加载…'} {query.title && <button type="button" className="text-button" onClick={() => pauseSearch.current()}>暂停查找</button>}</p>}
    {label && results.length > 0 && <p className="nav-label">{label}</p>}
    {failed && <p className="navigation-empty">读取失败。<button className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {loaded && !loadingPage && !failed && !results.length && !hideEmpty && <p className="navigation-empty">{next ? '这批记录暂无匹配，还可以继续查找。' : '暂无对话'}</p>}
    {visible && results.map(conversation => <div className="conversation-row" key={conversation.id}>
      <button className={`conversation-link ${conversation.id === rows.selected ? 'selected' : ''}`}
        aria-current={conversation.id === rows.selected ? 'page' : undefined} onClick={() => rows.choose(conversation.id)}>
        <strong title={conversation.title}>{conversation.title}</strong>
        <span>{conversation.harnessId === 'codex' ? 'Codex' : 'DSH'}<i title={workspaceLabel ? resultLabels.get(conversation.workspaceId) ?? workspaceLabel(conversation.workspaceId) : undefined}>{workspaceLabel ? resultLabels.get(conversation.workspaceId) ?? workspaceLabel(conversation.workspaceId) : rows.stateLabel(conversation)}</i></span>
      </button>
      <button className="icon-button conversation-options" aria-label={`管理对话：${conversation.title}`} onClick={() => rows.manage(conversation)}>⋯</button>
    </div>)}
    {visible && (next || beforeId) && <div className="conversation-pagination">
      {beforeId && <button className="text-button" disabled={loadingPage} onClick={() => {
        setLoadingPage(true);
        setCursors(current => current.slice(0, -1));
      }}>较新对话</button>}
      {next && <button className="text-button" disabled={loadingPage} onClick={() => {
        setLoadingPage(true);
        setCursors(current => [...current.slice(-31), next]);
      }}>{query.title ? '继续查找' : '更早对话'}</button>}
    </div>}
  </>;
}

export const ConversationNavigation = memo(function ConversationNavigation(props: NavigationProps) {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [archived, setArchived] = useState(false);
  const [collapsed, setCollapsed] = useState<Map<string, boolean>>(new Map());
  const [workspaceSearch, setWorkspaceSearch] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);
  const [removedGroup, setRemovedGroup] = useState<string>();
  const [managing, setManaging] = useState<Conversation>();
  const [notice, setNotice] = useState('');
  useEffect(() => { if (!props.removedWorkspaces?.length) setShowRemoved(false); }, [props.removedWorkspaces?.length]);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 180);
    return () => clearTimeout(timer);
  }, [search]);
  // Keep expanded groups mounted while searching so their pagination survives a return.
  const searchActive = !!search.trim();
  const workspaceLabel = (id: string) => props.workspaces?.find(workspace => workspace.id === id)?.label ??
    props.removedWorkspaces?.find(workspace => workspace.id === id)?.label ?? '未登记工作区';
  const workspaceTerm = workspaceSearch.trim();
  const workspacePage = useWorkspacePage(props.workspaces, props.workspaceCursor, workspaceTerm, false, !showRemoved);
  const removedPage = useWorkspacePage(props.removedWorkspaces, props.removedWorkspaceCursor, '', true, showRemoved);
  const matchingWorkspaces = workspacePage.entries;
  const rows = { ...props, manage: setManaging };
  const resultProps = { revision: props.revision, csrf: props.csrf, report: props.report, rows };
  const scroll = useRef<HTMLElement>(null);
  const normalScroll = useRef(0);
  const alternate = showRemoved || archived || searchActive;
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = alternate ? 0 : normalScroll.current; }, [alternate]);
  const changeView = (callback: () => void) => {
    if (!alternate) normalScroll.current = scroll.current?.scrollTop ?? 0;
    callback();
  };
  return <>
    {props.removedWorkspaces && <div className="workspace-navigation-tools">
      <div className="navigation-tools">
        <input type="search" aria-label="搜索工作区" placeholder="搜索工作区" maxLength={100} value={workspaceSearch}
          onChange={event => { setWorkspaceSearch(event.target.value); setShowRemoved(false); setArchived(false); setSearch(''); }} />
        {props.canAddWorkspace && <button className="icon-button" aria-label="添加工作区" title="添加工作区" onClick={() => props.workspaceAction({ kind: 'add' })}>＋</button>}
      </div>
      {!!props.removedWorkspaces.length && <button className="text-button" aria-pressed={showRemoved} onClick={() =>
        changeView(() => { setShowRemoved(!showRemoved); setArchived(false); setSearch(''); })}>已移除的工作区</button>}
    </div>}
    <div className="conversation-scopes" role="group" aria-label="对话范围">
      <button aria-pressed={!archived && !showRemoved} onClick={() => changeView(() => { setArchived(false); setShowRemoved(false); })}>未归档</button>
      <button aria-pressed={archived} onClick={() => changeView(() => { setArchived(true); setShowRemoved(false); })}>已归档</button>
    </div>
    <div className="navigation-tools">
      <input type="search" aria-label="搜索对话标题" placeholder={archived ? "搜索已归档对话" : "搜索未归档对话"} maxLength={200} value={search}
        onChange={event => changeView(() => { setSearch(event.target.value); setShowRemoved(false); })} />

    </div>
    <div className="navigation-notice" role="status">{notice}</div>
    <nav ref={scroll} aria-label="工作区与对话">
      <div hidden={alternate}>
        {matchingWorkspaces?.map((workspace, index) => {
          const closed = collapsed.get(workspace.id) ?? index >= 16;
          return <section key={workspace.id} className="workspace-group">
            <header>
              <button className="workspace-toggle" aria-expanded={!closed} onClick={() => setCollapsed(current => {
                const next = new Map(current);
                // Preferences are transient: paging across years of workspaces
                // must not retain every group ever toggled in this browser view.
                next.delete(workspace.id);
                next.set(workspace.id, !closed);
                if (next.size > 256) next.delete(next.keys().next().value!);
                return next;
              })}><span aria-hidden="true">{closed ? '›' : '⌄'}</span><strong title={workspace.label}>{workspace.label}</strong>
                {workspace.pinned && <span className="quiet">置顶</span>}</button>
              <button className="icon-button" aria-label={`在 ${workspace.label} 新建对话`} onClick={() => props.create(workspace.id)}>＋</button>
              {props.removedWorkspaces && <button className="icon-button" aria-label={`管理工作区：${workspace.label}`}
                onClick={() => props.workspaceAction({ kind: 'manage', workspace })}>⋯</button>}
            </header>
            <div hidden={closed}><Results {...resultProps} visible={!alternate && !closed} query={{ workspaceId: workspace.id }} /></div>
          </section>;
        })}
        {workspaceTerm && !matchingWorkspaces?.length && <p className="navigation-empty">没有匹配的工作区</p>}
        <WorkspacePages page={workspacePage}/>
        {props.workspaces && !workspaceTerm && <section className="workspace-group">
          <Results {...resultProps} visible={!alternate} query={{ unregistered: true }} hideEmpty label="未登记工作区" />
        </section>}
      </div>
      {showRemoved && removedPage.entries.map(workspace => <section className="workspace-group" key={workspace.id}>
        <header><button className="workspace-toggle" aria-expanded={removedGroup === workspace.id}
          onClick={() => setRemovedGroup(removedGroup === workspace.id ? undefined : workspace.id)}>{workspace.label}</button>
          <button className="text-button" aria-label={`恢复工作区：${workspace.label}`} onClick={() => props.workspaceAction({ kind: 'restore', workspace })}>恢复</button>
        </header>
        {removedGroup === workspace.id && <>
          <Results {...resultProps} query={{ workspaceId: workspace.id }} />
          <Results {...resultProps} query={{ workspaceId: workspace.id, archived: true }} hideEmpty label="已归档对话" />
        </>}
      </section>)}
      {showRemoved && <WorkspacePages page={removedPage}/>}
      {alternate && !showRemoved && <section className="workspace-group">
        <p className="nav-label">{archived ? '已归档对话' : '搜索结果'}</p>
        {searchActive && term !== search.trim() ? <p className="navigation-empty">正在搜索…</p> :
          <Results key={JSON.stringify([archived, term])} {...resultProps} query={{ archived, title: searchActive ? term : undefined }} workspaceLabel={workspaceLabel} />}
      </section>}
    </nav>
    {managing && <ManageDialog conversation={managing} csrf={props.csrf} close={() => setManaging(undefined)} changed={message => { setNotice(message); props.changed(); }} report={props.report} />}
  </>;
});

function ManageDialog({ conversation, csrf, close, changed, report }: {
  conversation: Conversation; csrf: string; close(): void; changed(message: string): void; report(reason: unknown): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(conversation.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  const submit = async (action: 'rename' | 'archive') => {
    setBusy(true);
    setError('');
    try {
      await request(`/conversations/${conversation.id}/manage`, conversationResponseSchema, {
        csrf, body: action === 'rename' ? { action, title: title.trim() } : { action, archived: !conversation.archived },
      });
      changed(action === 'rename' ? '名称已更新' : conversation.archived ? '已恢复到未归档' : '已移入归档');
      close();
    } catch (reason) {
      if (reason instanceof RequestError && reason.status === 401) report(reason);
      setError(reason instanceof RequestError && reason.code === 'conversation_archive_busy' ?
        '这段对话正在运行、等待输入或尚待核实。请在结果明确后归档。' : '暂时无法确认更改。可以重试。');
    } finally { setBusy(false); }
  };
  return <dialog className="create-dialog manage-dialog" aria-labelledby="manage-dialog-title" ref={dialog} onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit('rename'); }}>
      <header><h2 id="manage-dialog-title">管理对话</h2><button type="button" className="icon-button" aria-label="关闭对话管理" disabled={busy} onClick={close}>×</button></header>
      <p className="manage-current">{conversation.title}</p>
      <label htmlFor="managed-title">对话名称</label>
      <input id="managed-title" value={title} maxLength={200} disabled={busy} onChange={event => setTitle(event.target.value)} />
      {error && <p role="alert">{error}</p>}
      <div className="management-actions">
        <button className="primary" disabled={busy || title.trim() === conversation.title || !conversationTitleSchema.safeParse(title.trim()).success}>保存名称</button>
      </div>
      <div className="manage-archive">
        <p>{conversation.archived ? '恢复后，对话会回到未归档列表。' : '归档后仍可在「已归档」查看历史。'}</p>
        <button type="button" disabled={busy} onClick={() => void submit('archive')}>{conversation.archived ? '恢复对话' : '归档对话'}</button>
      </div>
      {busy && <p role="status">正在保存更改…</p>}
    </form>
  </dialog>;
}

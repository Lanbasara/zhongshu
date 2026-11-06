import { z } from 'zod';
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { conversationListSchema, conversationResponseSchema, conversationTitleSchema, type Conversation, type WorkbenchConfiguration } from '../shared/workbench.ts';
import { RequestError, request } from './workbench-client.ts';
import type { WorkspaceAction } from './workspace-management.tsx';

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
  const [results, setResults] = useState<Conversation[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const queryKey = JSON.stringify(query);
  const cache = useRef({ key: queryKey, rows: [] as Conversation[], next: null as string | null, pages: 1 });
  const fetchResults = useRef<(more?: boolean) => void>(() => {});
  const latestReport = useRef(report);
  latestReport.current = report;

  useEffect(() => {
    if (cache.current.key !== queryKey) {
      cache.current = { key: queryKey, rows: [], next: null, pages: 1 };
      setResults([]); setNext(null); setLoaded(false);
    }
    if (!visible) return;
    const controller = new AbortController();
    let loading = false;
    let refreshRequested = false;
    const fetchPage = async (more = false) => {
      if (loading) { if (!more) refreshRequested = true; return; }
      loading = true; setLoadingPage(true);
      try {
        const previous = cache.current;
        let cursor = more ? previous.next : null;
        if (more && !cursor) return;
        let values = more ? [...previous.rows] : [];
        const seen = new Set(values.map(row => row.id));
        let fetched = 0;
        // A change refreshes only the already expanded window. "More" reads just its next page.
        // Rebuild the window from the head to fill deletion gaps and bring moved rows forward.
        const count = more ? 1 : previous.pages;
        do {
          const result = await request('/conversation-search', conversationListSchema, {
            csrf, signal: controller.signal, body: { ...JSON.parse(queryKey), ...(cursor ? { beforeId: cursor } : {}) },
          });
          if (controller.signal.aborted) return;
          for (const row of result.conversations) if (!seen.has(row.id)) { values.push(row); seen.add(row.id); }
          cursor = result.olderBeforeId;
          fetched++;
        } while (cursor && fetched < count);
        cache.current = { key: queryKey, rows: values, next: cursor, pages: more ? previous.pages + fetched : fetched };
        setResults(values); setNext(cursor); setLoaded(true); setFailed(false);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setFailed(true);
        if (reason instanceof RequestError && reason.status === 401) latestReport.current(reason);
      } finally {
        loading = false;
        if (!controller.signal.aborted) setLoadingPage(false);
        if (refreshRequested && !controller.signal.aborted) {
          refreshRequested = false;
          void fetchPage();
        }
      }
    };
    fetchResults.current = more => { void fetchPage(more); };
    void fetchPage();
    return () => { controller.abort(); fetchResults.current = () => {}; };
  }, [queryKey, csrf, visible]);

  const seenRevision = useRef(revision);
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    if (visible) fetchResults.current();
  }, [revision, visible]);

  return <>
    {visible && loadingPage && !failed && <p className="navigation-empty" role="status">正在加载…</p>}
    {label && results.length > 0 && <p className="nav-label">{label}</p>}
    {failed && <p className="navigation-empty">读取失败。<button className="text-button" onClick={() => fetchResults.current()}>重试</button></p>}
    {loaded && !failed && !results.length && !hideEmpty && <p className="navigation-empty">暂无对话</p>}
    {visible && results.map(conversation => <div className="conversation-row" key={conversation.id}>
      <button className={`conversation-link ${conversation.id === rows.selected ? 'selected' : ''}`}
        aria-current={conversation.id === rows.selected ? 'page' : undefined} onClick={() => rows.choose(conversation.id)}>
        <strong title={conversation.title}>{conversation.title}</strong>
        <span>{conversation.harnessId === 'codex' ? 'Codex' : 'DSH'}<i title={workspaceLabel?.(conversation.workspaceId)}>{workspaceLabel?.(conversation.workspaceId) ?? rows.stateLabel(conversation)}</i></span>
      </button>
      <button className="icon-button conversation-options" aria-label={`管理对话：${conversation.title}`} onClick={() => rows.manage(conversation)}>⋯</button>
    </div>)}
    {visible && next && <div className="conversation-pagination">
      <button className="text-button" disabled={loadingPage} onClick={() => fetchResults.current(true)}>显示更多</button>
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
  const workspaceTerm = workspaceSearch.trim().toLocaleLowerCase();
  const matchingWorkspaces = props.workspaces?.filter(workspace => !workspaceTerm ||
    [workspace.label, workspace.directoryName].some(name => name?.toLocaleLowerCase().includes(workspaceTerm)));
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
                next.set(workspace.id, !closed);
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
        {props.workspaces && !workspaceTerm && <section className="workspace-group">
          <Results {...resultProps} visible={!alternate} query={{ unregistered: true }} hideEmpty label="未登记工作区" />
        </section>}
      </div>
      {showRemoved && props.removedWorkspaces?.map(workspace => <section className="workspace-group" key={workspace.id}>
        <header><button className="workspace-toggle" aria-expanded={removedGroup === workspace.id}
          onClick={() => setRemovedGroup(removedGroup === workspace.id ? undefined : workspace.id)}>{workspace.label}</button>
          <button className="text-button" aria-label={`恢复工作区：${workspace.label}`} onClick={() => props.workspaceAction({ kind: 'restore', workspace })}>恢复</button>
        </header>
        {removedGroup === workspace.id && <>
          <Results {...resultProps} query={{ workspaceId: workspace.id }} />
          <Results {...resultProps} query={{ workspaceId: workspace.id, archived: true }} hideEmpty label="已归档对话" />
        </>}
      </section>)}
      {alternate && !showRemoved && <section className="workspace-group">
        <p className="nav-label">{archived ? '已归档对话' : '搜索结果'}</p>
        {searchActive && term !== search.trim() ? <p className="navigation-empty">正在搜索…</p> :
          <Results key={JSON.stringify([archived, term])} {...resultProps} query={{ archived, title: searchActive ? term : undefined }} workspaceLabel={workspaceLabel} />}
      </section>}
    </nav>
    {managing && <ManageDialog conversation={managing} workspaceLabel={workspaceLabel(managing.workspaceId)} csrf={props.csrf} close={() => setManaging(undefined)} changed={message => { setNotice(message); props.changed(); }} report={props.report} />}
  </>;
});

function ManageDialog({ conversation, workspaceLabel, csrf, close, changed, report }: {
  workspaceLabel: string; conversation: Conversation; csrf: string; close(): void; changed(message: string): void; report(reason: unknown): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(conversation.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteAttempted, setDeleteAttempted] = useState(false);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmDelete) cancelDelete.current?.focus(); }, [confirmDelete]);
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
  const remove = async () => {
    if (busy) return;
    setBusy(true); setError(''); setDeleteAttempted(true);
    try {
      await request(`/conversations/${conversation.id}/delete`, z.object({ status: z.literal('completed') }).strict(), {
        csrf, body: { confirm: true },
      });
      changed('对话已删除'); close();
    } catch (reason) {
      if (reason instanceof RequestError && reason.status === 401) report(reason);
      const code = reason instanceof RequestError ? reason.code : '';
      setError(['conversation_delete_busy', 'conversation_busy', 'conversation_preparation_incomplete'].includes(code) ? '对话仍在运行、等待输入或有待核实的工作。请先停止并处理待办，核实后再删除。' :
        ['conversation_delete_unsupported', 'native_delete_unsupported', 'native_deletion_unavailable'].includes(code) ? '当前原生服务尚不支持完整删除。对话未被当作已删除，请配置支持删除的服务后重试。' :
        '删除尚未确认完成。请重试同一段对话的删除；系统会核对并继续清理，不会另建对话。');
      changed('删除尚未确认完成');
    } finally { setBusy(false); }
  };
  return <dialog className="create-dialog manage-dialog" aria-labelledby="manage-dialog-title" ref={dialog} onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={event => { event.preventDefault(); if (!confirmDelete) void submit('rename'); }}>
      <header><h2 id="manage-dialog-title">{confirmDelete ? '删除对话？' : '管理对话'}</h2><button type="button" className="icon-button" aria-label="关闭对话管理" disabled={busy} onClick={close}>×</button></header>
      <p className="manage-current">{conversation.title}</p>
      {confirmDelete ? <>
        <p>{workspaceLabel} · {conversation.harnessId === 'codex' ? 'Codex' : 'DSH'}</p>
        <p>这会永久删除原生对话和中书保存的对话内容，无法恢复。工作区文件和其他对话仍引用的资源会保留。</p>
        {error && <p role="alert">{error}</p>}
        <div className="management-actions">
          <button ref={cancelDelete} type="button" disabled={busy} onClick={() => { setConfirmDelete(false); setError(''); }}>返回</button>
          <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>{deleteAttempted ? '重试删除' : '确认永久删除'}</button>
        </div>
      </> : <>
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
      {conversation.harnessId === 'codex' ? <div className="manage-archive">
        <p>删除会清理原生对话和中书保存的内容，无法恢复。</p>
        <button type="button" className="danger" disabled={busy} onClick={() => { setError(''); setConfirmDelete(true); }}>删除对话</button>
      </div> : <p className="quiet">DSH 对话支持归档与恢复，不提供删除。闲置且没有待处理工作时，中书会释放观察资源。</p>}
      </>}
      {busy && <p role="status">{confirmDelete ? '正在删除并核实清理结果…' : '正在保存更改…'}</p>}
    </form>
  </dialog>;
}

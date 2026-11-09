import { SubagentBackgroundMark } from './patterns/subagents.tsx';
import { Clock } from 'lucide-react';
import { z } from 'zod';
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { conversationListSchema, conversationResponseSchema, conversationTitleSchema, type Conversation, type WorkbenchConfiguration } from '../shared/workbench.ts';
import { RequestError, request } from './workbench-client.ts';
import type { WorkspaceAction } from './workspace-management.tsx';
import { ConversationRow, WorkspaceActions, WorkspaceGroup } from './patterns/sidebar.tsx';
import { conversationStatus, harnessLabel } from './conversation-status.ts';
import type { StatusKind } from './ui/controls.tsx';

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
    return 260;
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
  workspaceAction(action: WorkspaceAction): void;
  selected?: string;
  revision: number;
  csrf: string;
  choose(id: string): void;
  create(workspaceId: string): void;
  manage(conversation: Conversation): void;
  report(reason: unknown): void;
  /** Attention-worthy conversations across all workspaces; summarises closed groups. */
  attention?: Conversation[];
};

type Query = { workspaceId?: string; unregistered?: true; title?: string; archived?: boolean };
type RowProps = {
  selected?: string;
  choose(id: string): void;
  manage(conversation: Conversation): void;
};

/** A conversation an automation run opened (ADR 0021) is an ordinary row, marked with the time the run opened it. */
function rowDetail(conversation: Conversation, workspaceLabel?: (id: string) => string) {
  const where = workspaceLabel ? `${workspaceLabel(conversation.workspaceId)} · ${harnessLabel(conversation.harnessId)}` : undefined;
  if (!conversation.automationId) return where;
  const opened = new Date(conversation.createdAt);
  const when = `${opened.getMonth() + 1}-${opened.getDate()} ${String(opened.getHours()).padStart(2, '0')}:${String(opened.getMinutes()).padStart(2, '0')}`;
  return [where, `自动任务 · ${when}`].filter(Boolean).join(' · ');
}

export function ConversationResults({ query, revision, csrf, report, rows, hideEmpty, workspaceLabel, label, visible = true, empty = '暂无对话' }: {
  query: Query; revision: number; csrf: string; report(reason: unknown): void; rows: RowProps;
  hideEmpty?: boolean; workspaceLabel?: (id: string) => string; label?: string; visible?: boolean; empty?: string;
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
    {visible && loadingPage && !loaded && !failed && <p className="navigation-empty" role="status">正在加载…</p>}
    {label && results.length > 0 && <p className="nav-label">{label}</p>}
    {failed && <p className="navigation-empty">读取失败。<button className="text-button" onClick={() => fetchResults.current()}>重试</button></p>}
    {loaded && !failed && !results.length && !hideEmpty && <p className="navigation-empty">{empty}</p>}
    {visible && results.map(conversation => {
      const { status, label: statusLabel } = conversationStatus(conversation);
      // Delegated work that outlives the main turn matters more than the main agent's idle state.
      const background = conversation.subagents && !['running', 'waiting'].includes(conversation.state.status) && (conversation.subagents.running || conversation.subagents.unverified);
      return <ConversationRow key={conversation.id} title={conversation.title} status={status} statusLabel={statusLabel}
        unread={conversation.unread} selected={conversation.id === rows.selected}
        detail={rowDetail(conversation, workspaceLabel)}
        meta={background ? <SubagentBackgroundMark running={conversation.subagents!.running} unverified={conversation.subagents!.unverified}/>
          : conversation.automationId ? <Clock size={12} aria-label="自动任务"/> : undefined}
        onOpen={() => rows.choose(conversation.id)} onManage={() => rows.manage(conversation)}/>;
    })}
    {visible && next && <div className="conversation-pagination">
      <button className="text-button" disabled={loadingPage} onClick={() => fetchResults.current(true)}>{loadingPage ? '正在加载…' : '显示更多'}</button>
    </div>}
  </>;
}

const summaryOrder: StatusKind[] = ['running', 'waiting', 'failed', 'unknown', 'unread'];
function summarise(conversations: Conversation[] | undefined, workspaceId: string) {
  const counts = new Map<StatusKind, number>();
  for (const conversation of conversations ?? []) {
    if (conversation.workspaceId !== workspaceId || conversation.archived) continue;
    const { status } = conversationStatus(conversation);
    if (summaryOrder.includes(status)) counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return summaryOrder.filter(status => counts.has(status)).map(status => ({ status, count: counts.get(status)! }));
}

const collapsedKey = 'zhongshu:collapsed-workspaces';
function readCollapsed(): Map<string, boolean> {
  try { return new Map(z.array(z.tuple([z.string().max(1024), z.boolean()])).max(512).parse(JSON.parse(localStorage.getItem(collapsedKey) ?? '[]'))); }
  catch { return new Map(); }
}

/** The workspace tree: the primary way to find a conversation (decided 2026-11-07). */
export const ConversationNavigation = memo(function ConversationNavigation(props: NavigationProps) {
  const [collapsed, setCollapsed] = useState<Map<string, boolean>>(readCollapsed);
  const rows = { selected: props.selected, choose: props.choose, manage: props.manage };
  const resultProps = { revision: props.revision, csrf: props.csrf, report: props.report, rows };
  const toggle = (id: string, closed: boolean) => setCollapsed(current => {
    const next = new Map(current); next.set(id, !closed);
    try { localStorage.setItem(collapsedKey, JSON.stringify([...next].slice(-512))); } catch { /* the in-memory state still applies */ }
    return next;
  });
  return <nav className="sidebar-tree" aria-label="工作区与对话">
    {props.workspaces?.map((workspace, index) => {
      const closed = collapsed.get(workspace.id) ?? index >= 16;
      return <WorkspaceGroup key={workspace.id} label={workspace.label} pinned={workspace.pinned} open={!closed} onToggle={() => toggle(workspace.id, closed)}
        summary={closed ? summarise(props.attention, workspace.id) : undefined}
        actions={<WorkspaceActions label={workspace.label} onCreate={() => props.create(workspace.id)} onManage={() => props.workspaceAction({ kind: 'manage', workspace })}/>}>
        <ConversationResults {...resultProps} visible={!closed} query={{ workspaceId: workspace.id }}/>
      </WorkspaceGroup>;
    })}
    {props.workspaces && <section className="workspace-group workspace-unregistered">
      <ConversationResults {...resultProps} query={{ unregistered: true }} hideEmpty label="未登记工作区"/>
    </section>}
    {props.workspaces?.length === 0 && <p className="navigation-empty">还没有工作区。可以在「设置 › 工作区」中添加。</p>}
  </nav>;
});

export function ManageDialog({ conversation, workspaceLabel, csrf, close, changed, report }: {
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
      const code = reason instanceof RequestError ? reason.code : '';
      setError(code === 'conversation_archive_busy' ? '这段对话正在运行、等待输入或尚待核实。请在结果明确后归档。'
        : code === 'subagents_running' ? '仍有子 Agent 在运行或停止结果待核实。归档会让原生服务停止它们；请等它们结束或先停止，再归档。'
        : code === 'subagents_unverified' ? '暂时无法核对子 Agent 状态，请重新连接后再归档。'
        : code === 'workspace_removed' ? '这段对话所在的工作区已移除。先在「设置 › 工作区」恢复工作区，再归档。' : '暂时无法确认更改。可以重试。');
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
      // A refusal means deletion never started; only an unknown outcome is announced as unfinished.
      const refusal = ['conversation_delete_busy', 'conversation_busy', 'conversation_preparation_incomplete'].includes(code) ? '对话仍在运行、等待输入或有待核实的工作。请先停止并处理待办，核实后再删除。' :
        ['subagents_running', 'subagents_unverified'].includes(code) ? '仍有子 Agent 在运行或状态待核实。删除会同时删除它们；请等它们结束或先停止，核实后再删除。' :
        ['conversation_delete_unsupported', 'native_delete_unsupported', 'native_deletion_unavailable'].includes(code) ? '当前原生服务尚不支持完整删除。对话未被当作已删除，请配置支持删除的服务后重试。' : undefined;
      setError(refusal ?? '删除尚未确认完成。请重试同一段对话的删除；系统会核对并继续清理，不会另建对话。');
      if (!refusal) changed('删除尚未确认完成');
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

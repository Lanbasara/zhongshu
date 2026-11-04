import { ArrowLeft, ChevronDown, ChevronRight, FileCode2, FileText, Folder, LoaderCircle, Maximize2, Minimize2, Pencil, Save } from 'lucide-react';
import { lazy, Suspense, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import { z } from 'zod';
import { referenceSchema } from '../shared/content.ts';
import { RequestError, request } from './workbench-client.ts';
import { WorkspaceReport } from './workspace-report.tsx';
import { directoryFilesSchema, directoryProgress, useDirectoryPage } from './directory-client.ts';
import { DirectoryControls } from './directory-controls.tsx';
import { WorkspaceSelect } from './workspace-selection.tsx';
import { workspacePreviewPages } from './workspace-preview.ts';

const WorkspaceTextEditor = lazy(() => import('./workspace-text-editor.tsx'));

const fileSchema = z.object({ kind: z.enum(['markdown', 'text', 'html', 'source']), text: z.string(), version: z.string() });
const statusSchema = z.object({ editable: z.boolean(), reason: z.string().nullable(), canPause: z.boolean().optional(), maintenance: z.enum(['online', 'paused', 'unknown', 'transition']).optional(),
  phase: z.enum(['online', 'draining', 'editable', 'resuming', 'unknown', 'initializing']).optional(), windowId: z.string().optional(), affectedGroups: z.array(z.string()).max(32).optional(), initialized: z.boolean().optional() });
type File = z.infer<typeof fileSchema>;
type OpenFile = { path: string; file: File; position: number };
type FileTarget = { workspaceId: string; path: string };

const errors = new Map([
  ['workspace_not_idle', '工作区正在运行或尚未确认空闲。修改已保留。'],
  ['workspace_writes_unmanaged', '此工作区未启用原地保存。'],
  ['workspace_maintenance_online', '进入编辑时会暂停工作区的 DSH。'],
  ['workspace_maintenance_transition', '正在切换工作区维护状态。'],
  ['workspace_maintenance_unknown', '无法核对 DSH 状态，请恢复 Agent 后重试。'],
  ['workspace_maintenance_busy', '工作区正在保存或切换状态，请稍后重试。'],
  ['workspace_maintenance_unavailable', '未能确认 DSH 已暂停或恢复。请重试恢复。'],
  ['workspace_save_in_progress', '此工作区正在保存文件，请稍后重试。'],
  ['execution_online', '进入编辑会暂停下列运行组的新任务，等待已受理任务完成。'],
  ['execution_draining', '正在等待已受理任务完成；任务不会因编辑而取消。'],
  ['execution_resuming', '正在恢复 Agent，确认完成后才接受新任务。'],
  ['execution_unknown', '运行状态尚待核实，修改已保留。'],
  ['execution_baseline_incomplete', '正在后台核验已有会话和任务，完成后可进入编辑。'],
  ['execution_scope_registration_pending', '正在核对工作区的运行范围，请稍后重试。'],
  ['execution_controller_unknown', '尚未确认运行组门禁，暂时无法保存或派发。'],
  ['execution_reconciliation_unknown', '尚未核实原生任务状态，请保留修改并稍后重试。'],
  ['execution_native_state_unknown', '尚未核实原生会话状态，初始化仍在继续。'],
  ['execution_restore_requires_reconciliation', '恢复的运行记录需要操作者核对，现有存档仍可阅读。'],
  ['execution_save_in_progress', '另一个保存请求仍在处理，请稍后重试。'],
  ['execution_save_unresolved', '保存结果尚待核实，修改已保留；请勿重复提交或恢复 Agent。'],
  ['execution_save_already_resolved', '这次保存请求已处理，请重新打开文件核对结果。'],
  ['execution_pending_unknown', '部分已受理任务仍待核实，暂时不能保存；其他已受理任务仍会继续完成。'],
  ['file_writer_capacity_reached', '保存记录空间不足，文件尚未写入；修改已保留，扩容后可再次保存。'],
  ['file_writer_unavailable', '文件保存服务尚未就绪，修改已保留；请稍后重试。'],
  ['file_version_changed', '远程文件已变化，当前修改已保留。'],
  ['file_reference_unavailable', '文件或目录不可用，可能已被移动或删除。'],
  ['file_reference_forbidden', '这个路径不在可读的工作区文件范围内。'],
  ['file_too_large', '文件超过此阅读器或编辑器的大小限制。'],
  ['file_encoding_unsupported', '此文件不是受支持的 UTF-8 文本。'],
  ['file_type_unsupported', '此类型暂不支持打开。'],
]);

function previewUrl(url: string, key: string) {
  return key === 'href' && /^https:\/\//i.test(url) ? url : '';
}

function MarkdownPreview({ text, paginate }: { text: string; paginate: boolean }) {
  const [page, setPage] = useState(0);
  const pages = useMemo(() => workspacePreviewPages(text, paginate), [text, paginate]);
  const index = Math.min(page, pages.length - 1);
  return <div className="message-text">
    {pages.length > 1 && <nav className="reader-preview-pages" aria-label="Markdown 预览分页">
      <button disabled={!index} onClick={() => setPage(index - 1)}>上一页</button>
      <span aria-live="polite">{index + 1} / {pages.length}</span>
      <button disabled={index === pages.length - 1} onClick={() => setPage(index + 1)}>下一页</button>
    </nav>}
    {pages[index]!.raw ? <><p className="reader-placeholder">此段内容较长，按原文分页显示。</p><pre>{pages[index]!.text}</pre></>
      : <Streamdown mode="static" skipHtml urlTransform={previewUrl}>{pages[index]!.text}</Streamdown>}
  </div>;
}

function message(error: unknown) {
  return (error instanceof RequestError && errors.get(error.code)) || '文件操作未确认，请核对后重试。';
}

function reportTarget(path: string, href: string): string {
  const [relative] = href.split(/[?#]/, 1);
  if (!relative || relative.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(relative)) throw new Error();
  const parts = path.split('/').slice(0, -1);
  for (const encoded of relative.split('/')) {
    const part = decodeURIComponent(encoded);
    if (part.includes('/') || part.includes('\\')) throw new Error();
    if (part === '..') {
      if (!parts.length) throw new Error();
      parts.pop();
    } else if (part !== '.') parts.push(part);
  }
  const target = parts.join('/');
  referenceSchema.parse({ type: 'file', path: target });
  return target;
}

export function WorkspaceReader({ workspaces, workspaceCursor, initialWorkspace, target, onTargetUnavailable, csrf, editStatusSignal, expanded, onExpand, onClose }: {
  workspaces: { id: string; label: string }[];
  workspaceCursor?: string | null;
  initialWorkspace?: string;
  target?: FileTarget;
  onTargetUnavailable?(target: FileTarget): void;
  csrf: string;
  editStatusSignal: string;
  expanded: boolean;
  onExpand(value: boolean): void;
  onClose(): void;
}) {
  const [workspace, setWorkspace] = useState(() => target?.workspaceId ?? initialWorkspace ?? workspaces[0]?.id ?? '');
  const [browsing, setBrowsing] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [directory, setDirectory] = useState('');
  const [opened, setOpened] = useState<OpenFile>();
  const [attemptedPath, setAttemptedPath] = useState<string>();
  const [back, setBack] = useState<OpenFile[]>([]);
  const [preparingEditor, setPreparingEditor] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [readingPreview, setReadingPreview] = useState(false);
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState<z.infer<typeof statusSchema>>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const refreshStatus = useRef<(() => void) | null>(null);
  const pending = useRef<AbortController>(null);
  const saveRequest = useRef<{ workspace: string; path: string; version: string; text: string; id: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const largeMarkdown = useMemo(() => opened?.file.kind === 'markdown' &&
    new TextEncoder().encode(opened.file.text).length > 64 * 1024, [opened?.file.kind, opened?.file.text]);
  const largeDraft = useMemo(() => new TextEncoder().encode(draft).length > 64 * 1024, [draft]);
  const dirty = editing && opened?.file.text !== draft;
  const base = '/workspaces/' + encodeURIComponent(workspace);
  const fromTurn = target !== undefined;
  const directoryPage = useDirectoryPage(base + ':' + directory, ({ cursor, refresh, signal }) => {
    const query = new URLSearchParams({ directory, limit: '100', ...(cursor ? { cursor } : {}), ...(refresh ? { refresh: '1' } : {}) });
    return request(base + '/files?' + query.toString(), directoryFilesSchema, { signal });
  }, !!workspace && browsing);
  const files = directoryPage.data?.files ?? [];
  const listingProgress = directoryProgress(directoryPage.data);

  useLayoutEffect(() => {
    const panel = dialog.current;
    if (!fromTurn || !panel) return;
    const narrow = matchMedia('(max-width:759px)');
    function position() {
      if (!panel) return;
      if (panel.open) panel.close();
      if (narrow.matches) panel.showModal();
      else panel.show();
    }
    position();
    narrow.addEventListener('change', position);
    return () => { narrow.removeEventListener('change', position); panel.close(); };
  }, [fromTurn]);

  useEffect(() => {
    if (!workspace) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let checking = false;
    let observedAt = 0;
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('zhongshu-edit-status:' + workspace) : undefined;
    function publish(value: z.infer<typeof statusSchema>) {
      observedAt = Date.now();
      setStatus(previous => previous?.editable === value.editable && previous.reason === value.reason &&
        previous.maintenance === value.maintenance && previous.canPause === value.canPause && previous.windowId === value.windowId && previous.phase === value.phase ? previous : value);
    }
    if (channel) channel.onmessage = event => {
      const parsed = statusSchema.safeParse(event.data);
      if (!abort.signal.aborted && parsed.success) publish(parsed.data);
    };
    async function fetchStatus() {
      if (document.hidden || abort.signal.aborted) return;
      const value = await request(base + '/edit-status', statusSchema, { signal: abort.signal });
      if (!abort.signal.aborted) {
        publish(value);
        channel?.postMessage(value);
      }
    }
    async function refresh(force = false) {
      if (document.hidden || checking || abort.signal.aborted) return;
      clearTimeout(timer);
      checking = true;
      try {
        if (force || Date.now() - observedAt >= 2750) {
          if (channel && navigator.locks) {
            await navigator.locks.request('zhongshu-edit-status:' + workspace, { ifAvailable: true }, async lock => {
              if (lock && (force || Date.now() - observedAt >= 2750)) await fetchStatus();
            });
          } else await fetchStatus();
        }
      } catch { if (!abort.signal.aborted) setStatus(undefined); }
      finally {
        checking = false;
        if (!abort.signal.aborted && !document.hidden) {
          const elapsed = Date.now() - observedAt;
          timer = setTimeout(() => void refresh(), elapsed < 3000 ? Math.max(250, 3000 - elapsed) : 1000);
        }
      }
    }
    function visibility() {
      if (document.hidden) clearTimeout(timer);
      else void refresh(true);
    }
    document.addEventListener('visibilitychange', visibility);
    refreshStatus.current = () => void refresh(true);
    return () => { refreshStatus.current = null; channel?.close(); document.removeEventListener('visibilitychange', visibility); abort.abort(); clearTimeout(timer); pending.current?.abort(); };
  }, [base, workspace]);
  useEffect(() => { refreshStatus.current?.(); }, [base, editStatusSignal]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  useEffect(() => {
    if (!browsing) return;
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Node) || picker.current?.contains(event.target) || pending.current) return;
      setBrowsing(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (pending.current) return;
      setBrowsing(false);
      trigger.current?.focus();
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [browsing]);

  function mayLeave() {
    return !busy && (!dirty || window.confirm('有未保存的修改。要放弃修改吗？'));
  }

  function resetEditor() {
    setEditing(false);
    setPreview(false);
    setReadingPreview(false);
    setDraft('');
    setError('');
    setNotice('');
  }

  async function open(path: string, origin?: OpenFile, preserveBack = false, requested?: FileTarget) {
    if (requested) {
      const maintenancePending = status?.maintenance === 'paused' || status?.maintenance === 'unknown';
      if (editing || preparingEditor || (requested.workspaceId !== workspace && maintenancePending)) {
        setError('请先结束当前文件的编辑，再打开本轮文件。');
        return;
      }
      if (busy && !pending.current) return;
      pending.current?.abort();
      setAttemptedPath(path);
      setOpened(undefined);
      setBrowsing(false);
      setBack([]);
    } else {
      if (pending.current || !mayLeave()) return;
      setAttemptedPath(undefined);
    }
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setError('');
    try {
      const source = requested ? '/workspaces/' + encodeURIComponent(requested.workspaceId) : base;
      const file = await request(source + '/file?path=' + encodeURIComponent(path), fileSchema, { signal: abort.signal });
      if (abort.signal.aborted) return;
      resetEditor();
      if (requested && requested.workspaceId !== workspace) {
        setWorkspace(requested.workspaceId);
        setStatus(undefined);
        setDirectory('');
      }
      setOpened({ path, file, position: 0 });
      setBrowsing(false);
      if (origin) setBack(previous => [...previous.slice(-31), origin]);
      else if (!preserveBack) setBack([]);
    } catch (reason) {
      if (abort.signal.aborted) return;
      setError(message(reason));
      if (requested && reason instanceof RequestError && ['file_reference_unavailable', 'file_reference_forbidden', 'file_type_unsupported'].includes(reason.code))
        onTargetUnavailable?.(requested);
    }
    finally {
      if (pending.current === abort) pending.current = null;
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  const openTarget = useEffectEvent((file: FileTarget) => {
    closeButton.current?.focus({ preventScroll: true });
    void open(file.path, undefined, false, file);
  });
  useEffect(() => { if (target) openTarget(target); }, [target]);

  async function save() {
    if (!opened || !status?.editable || busy || !dirty) return;
    const resumeAfterSave = !status.phase && status.maintenance === 'paused';
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (!saveRequest.current || saveRequest.current.workspace !== workspace || saveRequest.current.path !== opened.path || saveRequest.current.version !== opened.file.version || saveRequest.current.text !== draft)
        saveRequest.current = { workspace, path: opened.path, version: opened.file.version, text: draft, id: crypto.randomUUID() };
      const file = await request(base + '/file', fileSchema, { csrf, body: { path: opened.path, version: opened.file.version, text: draft, saveId: saveRequest.current.id } });
      saveRequest.current = null;
      setOpened({ ...opened, file });
      setDraft(file.text);
      setNotice('已保存到工作区');
      if (resumeAfterSave) {
        setEditing(false);
        setPreview(false);
        await maintenance('resume');
      }
    } catch (reason) {
      // A confirmed rejection is a finished attempt; a later deliberate save
      // needs a new identity. Transport loss and unresolved effects keep theirs.
      if (reason instanceof RequestError && ['file_writer_capacity_reached', 'file_version_changed', 'file_read_only',
        'file_reference_changed', 'file_reference_unavailable', 'file_write_not_applied', 'file_write_not_started', 'file_write_rejected'].includes(reason.code)) saveRequest.current = null;
      setError(message(reason));
    }
    finally { setBusy(false); }
  }

  async function maintenance(action: 'pause' | 'resume') {
    setBusy(true);
    setError('');
    try {
      const value = await request(base + '/maintenance', statusSchema, { csrf, body: { action }, timeoutMs: 110_000 });
      setStatus(value);
      return value.maintenance === (action === 'pause' ? 'paused' : 'online');
    } catch (reason) {
      setError(message(reason));
      return false;
    } finally { setBusy(false); }
  }

  async function beginEdit() {
    if (!opened || busy || opened.file.kind === 'html' || opened.file.kind === 'source') return;
    if (!status?.editable && !status?.canPause) return;
    setPreparingEditor(true);
    onExpand(true);
    try {
      let file = opened.file;
      if (!status.editable) {
        if (!await maintenance('pause')) { setNotice('已申请编辑窗口。任务完成后可再次点击编辑。'); return; }
        setBusy(true);
        file = await request(base + '/file?path=' + encodeURIComponent(opened.path), fileSchema);
        setOpened({ ...opened, file });
        if (file.version !== opened.file.version) setNotice('暂停前文件已变化，已载入工作区当前版本。');
      }
      setEditing(true);
      setDraft(file.text);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPreparingEditor(false);
      setBusy(false);
    }
  }

  async function leaveEditor(close: boolean) {
    if (close && fromTurn && pending.current && !editing && status?.maintenance !== 'paused' && status?.maintenance !== 'unknown') {
      pending.current.abort();
      onClose();
      return;
    }
    if (!mayLeave()) return;
    if ((!status?.phase || !close) && (status?.maintenance === 'paused' || status?.maintenance === 'unknown') && !await maintenance('resume')) return;
    resetEditor();
    if (close) onClose();
  }

  function navigate(href: string, position: number) {
    if (!opened) return;
    try {
      if (/^https:\/\//i.test(href)) {
        const url = new URL(href);
        if (url.protocol === 'https:' && !url.username && !url.password) window.open(url.href, '_blank', 'noopener,noreferrer');
        return;
      }
      void open(reportTarget(opened.path, href), { ...opened, position });
    } catch { setError('这个链接未指向工作区内可读的文件。'); }
  }

  const Panel = fromTurn ? 'dialog' : 'section';
  const fileLabel = opened?.path ?? attemptedPath;
  return <Panel ref={fromTurn ? dialog : undefined}
    className={`workspace-reader${expanded ? ' is-expanded' : ''}${fromTurn ? ' turn-file-reader' : ''}`} aria-label="工作区文件阅读器"
    onCancel={fromTurn ? event => {
      event.preventDefault();
      if (!browsing) void leaveEditor(true);
    } : undefined}
    onKeyDown={fromTurn ? event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!browsing) void leaveEditor(true);
      }
    } : undefined}>
    <header className="workspace-reader-bar">
      <button ref={closeButton} className="reader-icon" aria-label="返回对话" title="返回对话" onClick={() => void leaveEditor(true)}><ArrowLeft size={17}/></button>
      <div className="workspace-file-picker" ref={picker}>
        <button className="reader-file-trigger" ref={trigger} aria-expanded={browsing} aria-controls="workspace-file-list"
          title={fileLabel} onClick={() => setBrowsing(!browsing)}>
          {fileLabel ? <FileText size={16}/> : <Folder size={16}/>}
          <span>{fileLabel?.split('/').at(-1) ?? '工作区文件'}</span><ChevronDown size={14}/>
        </button>
        {browsing && <div className="workspace-file-popover" id="workspace-file-list">
          <div className="reader-popover-title">
            {workspaces.length > 1 || workspaceCursor !== undefined ? <WorkspaceSelect label="工作区" value={workspace} initial={workspaces} cursor={workspaceCursor} disabled={busy} onChange={id => {
              if (!mayLeave()) return;
              resetEditor(); setOpened(undefined); setAttemptedPath(undefined); setBack([]); setStatus(undefined);
              setDirectory(''); setWorkspace(id);
            }}/>
              : <span>{workspaces[0]?.label}</span>}
            <span>文件</span>
          </div>
          {directory && <button className="reader-file-parent" disabled={busy} onClick={() => {
            setError(''); setDirectory(directory.split('/').slice(0, -1).join('/'));
          }}><ArrowLeft size={14}/><span>{directory}</span></button>}
          <ul aria-busy={directoryPage.pending}>{files.map(entry => <li key={entry.path}><button className="reader-file-row" disabled={busy || directoryPage.pending || !entry.supported}
            aria-current={opened?.path === entry.path ? 'true' : undefined} onClick={() => {
              if (entry.directory) { setError(''); setDirectory(entry.path); }
              else void open(entry.path);
            }}>
            {entry.directory ? <Folder size={16}/> : /\.(?:html?|json|toml|ya?ml|ini)$/i.test(entry.name) ? <FileCode2 size={16}/> : <FileText size={16}/>}
            <span>{entry.name}{directory && <small>{entry.path}</small>}</span>
            {entry.directory && <ChevronRight size={15}/>}
          </button></li>)}</ul>
          {directoryPage.error && <p className="reader-popover-empty" role="alert">{directoryPage.error}</p>}
          {directoryPage.notice && <p className="reader-popover-empty" role="status">{directoryPage.notice}</p>}
          {!directoryPage.error && listingProgress && <p className="reader-popover-empty" role="status">{listingProgress}</p>}
          {!directoryPage.pending && !directoryPage.error && directoryPage.data?.complete && !files.length && <p className="reader-popover-empty">此目录暂无可浏览的文件</p>}
          <DirectoryControls {...directoryPage} label="工作区文件分页" className="reader-popover-title" />
        </div>}
      </div>
      <button className="reader-icon workspace-reader-expand" aria-label={expanded ? '并排阅读' : '展开阅读'}
        title={expanded ? '并排阅读' : '展开阅读'} onClick={() => onExpand(!expanded)}>
        {expanded ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}
      </button>
    </header>
    {back.length > 0 && <div className="workspace-reader-tools"><button className="reader-action" disabled={busy} onClick={() => {
      if (!mayLeave()) return;
      resetEditor();
      setOpened(back.at(-1));
      setBack(back.slice(0, -1));
    }}><ArrowLeft size={14}/>返回报告</button></div>}
    {opened?.file.kind === 'source' && <div className="workspace-reader-tools">源码 · 只读</div>}
    {opened && opened.file.kind !== 'html' && opened.file.kind !== 'source' && <div className="workspace-reader-tools">
      {editing ? <>
        {opened.file.kind === 'markdown' && <button onClick={() => setPreview(!preview)}>{preview ? '原文' : '预览'}</button>}
        <button className="reader-action reader-primary" disabled={!dirty || !status?.editable || busy} onClick={() => void save()}><Save size={14}/>保存</button>
        <button disabled={busy} onClick={() => void leaveEditor(false)}>{status?.phase ? '恢复 Agent 并结束编辑' : '结束编辑'}</button>
        <button disabled={busy} onClick={() => void open(opened.path, undefined, true)}>重新打开</button>
      </> : <button disabled={busy || (!status?.editable && !status?.canPause)} className="reader-action" onClick={() => void beginEdit()}><Pencil size={14}/>编辑</button>}
      {!editing && largeMarkdown && <button onClick={() => setReadingPreview(!readingPreview)}>{readingPreview ? '查看原文' : '预览 Markdown'}</button>}
      {!status?.editable && <span role="status">{status?.reason ? errors.get(status.reason) ?? '运行状态尚待核实，请稍后重试。' : '正在核对工作区状态…'}</span>}
    </div>}
    {!!status?.affectedGroups?.length && <div className="workspace-reader-tools">编辑影响范围：{status.affectedGroups.join('、')}。关闭页面会保留编辑窗口。</div>}
    {!editing && (status?.maintenance === 'paused' || status?.maintenance === 'unknown') &&
      <div className="workspace-reader-tools"><button disabled={busy} onClick={() => void leaveEditor(false)}>恢复 Agent</button></div>}
    {error && <p className="workspace-reader-feedback" role="alert">{error}</p>}
    {notice && <p className="workspace-reader-feedback" role="status">{notice}</p>}
    <div className="workspace-reader-content">
      {preparingEditor ? <p className="reader-editor-pending" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true"/>正在暂停 Agent，确认后可编辑…</p>
        : opened?.file.kind === 'html' ? <WorkspaceReport key={opened.path + ':' + opened.file.version + ':' + back.length}
        title={opened.path} text={opened.file.text} position={opened.position} navigate={navigate}/>
        : editing ? <>
          <Suspense fallback={<p hidden={preview} className="reader-editor-pending" role="status">正在准备编辑器…</p>}>
            <WorkspaceTextEditor hidden={preview} readOnly={!status?.editable || busy} value={draft} onChange={setDraft}/>
          </Suspense>
          {preview && <MarkdownPreview text={draft} paginate={largeDraft}/>}
        </>
        : opened?.file.kind === 'markdown' && (!largeMarkdown || readingPreview) ? <MarkdownPreview text={opened.file.text} paginate={largeMarkdown}/>
        : opened ? <pre>{opened.file.text}</pre> : attemptedPath ? (busy && <p className="reader-placeholder" role="status">正在打开文件…</p>)
        : <p className="reader-placeholder">从顶部「工作区文件」选择要打开的文件。</p>}
    </div>
  </Panel>;
}

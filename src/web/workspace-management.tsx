import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Folder, FolderPlus, RefreshCw, X } from 'lucide-react';
import { z } from 'zod';
import { folderName, workspaceLabelSchema, workspaceManagementSchema, type WorkbenchConfiguration } from '../shared/workbench.ts';
import { RequestError, request } from './workbench-client.ts';
import { directoryMetadataSchema, directoryProgress, useDirectoryPage } from './directory-client.ts';
import { DirectoryControls, DirectoryStart } from './directory-controls.tsx';

export type WorkspaceAction = { kind: 'add' } |
  { kind: 'manage'; workspace: WorkbenchConfiguration['workspaces'][number] } |
  { kind: 'restore'; workspace: { id: string; label: string } };
const responseSchema = z.object({ id: z.string() }).strict();
const errors: Record<string, string> = {
  workspace_remove_busy: '工作区还有正在运行、等待处理或尚待核实的工作。请回到对应对话处理后再移除。',
  workspace_removed: '这个工作区已移除。可从「已移除的工作区」恢复。',
  workspace_directory_changed: '目录已经变化，无法使用原登记。',
  workspace_directory_unavailable: '目录暂时不可用。请核对当前实例上的目录。',
  workspace_identity_unavailable: '当前文件系统无法核实目录身份。',
  workspace_folder_exists: '已有同名文件夹，请从目录列表选择。',
  workspace_path_too_deep: '目录路径过长，请选择较浅的目录。',
  workspace_limit: '工作区数量已达上限。',
};
type Roots = NonNullable<WorkbenchConfiguration['workspaceRoots']>;
type FolderSelection = { rootId: string; path: string[]; name?: string };
const workspaceFoldersSchema = directoryMetadataSchema.extend({ currentDirectory: z.string().min(1).max(4096), names: z.array(folderName).max(100) });

function WorkspaceDirectoryPicker({ roots, csrf, busy, error, clearError, submit, report }: {
  roots: Roots; csrf: string; busy: boolean; error: string;
  clearError(): void; submit(selection: FolderSelection): Promise<void>; report(reason: unknown): void;
}) {
  const [rootId, setRootId] = useState(roots[0]?.id ?? '');
  const [path, setPath] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [folder, setFolder] = useState('');
  const createButton = useRef<HTMLButtonElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);
  const directoryPage = useDirectoryPage(JSON.stringify([rootId, path]), ({ cursor, refresh, signal }) =>
    request('/workspace-directories', workspaceFoldersSchema, { csrf, body: { rootId, path, limit: 100, ...(cursor ? { cursor } : {}), refresh }, signal }),
  !!rootId && !creating, reason => { if (reason instanceof RequestError && reason.status === 401) report(reason); });
  const directory = directoryPage.data;
  const browseError = directoryPage.error;
  const progress = directoryProgress(directory);

  useEffect(() => {
    if (creating) folderInput.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      createButton.current?.focus();
    }
  }, [creating]);

  const visit = (next: string[]) => { setPath(next); clearError(); };
  const rootLabel = roots.find(root => root.id === rootId)?.label ?? '工作区目录';
  const currentFolder = path.at(-1) ?? rootLabel;
  const parentTrail = [rootLabel, ...path.slice(0, -1)].join(' / ');
  const validFolder = folderName.safeParse(folder).success;
  const currentDirectory = directory?.currentDirectory;
  const target = currentDirectory && creating && validFolder ? `${currentDirectory.replace(/\/$/, '')}/${folder}` : currentDirectory;
  const canSubmit = !!directory && (!creating || validFolder);

  return <form className="workspace-picker-form" onSubmit={event => {
    event.preventDefault();
    if (canSubmit && !busy) void submit({ rootId, path, ...(creating ? { name: folder } : {}) });
  }}>
    <div className="workspace-picker-toolbar">
      {!creating && <button type="button" className="workspace-picker-up" aria-label="刷新目录" title="刷新目录" disabled={busy || directoryPage.pending} onClick={directoryPage.refresh}><RefreshCw size={16}/></button>}
      <button type="button" className="workspace-picker-up" aria-label="上一级" disabled={!path.length || creating || busy}
        onClick={() => visit(path.slice(0, -1))}><ChevronLeft size={19} aria-hidden="true" /></button>
      <div className="workspace-picker-location">
        {roots.length > 1 ? <select aria-label="选择目录位置" value={rootId} disabled={creating || busy}
          onChange={event => { setRootId(event.target.value); visit([]); }}>
          {roots.map(root => <option value={root.id} key={root.id}>{root.label}</option>)}
        </select> : path.length > 0 && <span className="workspace-picker-trail" title={parentTrail}>{parentTrail}</span>}
        {(roots.length <= 1 || path.length > 0) && <strong title={currentFolder}>{currentFolder}</strong>}
      </div>
      {!creating && <button type="button" className="workspace-picker-secondary" ref={createButton}
        disabled={!directory || path.length >= 12 || busy}
        onClick={() => { clearError(); setFolder(''); setCreating(true); }}>
        <FolderPlus size={17} aria-hidden="true" />新建文件夹
      </button>}
    </div>
    <div className="workspace-picker-content" aria-busy={directoryPage.pending}>
      {creating && <div className="workspace-picker-new">
        <label htmlFor="workspace-folder">文件夹名称</label>
        <input id="workspace-folder" ref={folderInput} value={folder} maxLength={255} placeholder="输入名称" disabled={busy}
          aria-invalid={!!folder && !validFolder}
          aria-describedby={folder && !validFolder ? 'workspace-folder-invalid' : undefined}
          onChange={event => { setFolder(event.target.value); clearError(); }} />
        {folder && !validFolder && <p id="workspace-folder-invalid" className="workspace-picker-error">请输入有效的文件夹名称。</p>}
      </div>}
      {target && <details className="workspace-picker-path" key={`${currentDirectory}-${creating}`}>
        <summary>{creating ? '查看创建位置' : '查看完整路径'}</summary>
        <code>{target}</code>
      </details>}
      {!creating && <DirectoryStart {...directoryPage}/>}
      {!creating && (browseError ? <div className="workspace-picker-empty" role="status">
        <p>{browseError}</p><button type="button" className="workspace-picker-secondary" onClick={directoryPage.refresh}>重试</button>
      </div> : !directory ? <p className="workspace-picker-empty" role="status">正在读取文件夹…</p> :
        directory.names.length ? <ul className="workspace-picker-list" aria-label="子文件夹">
          {directory.names.map(name => <li key={name} data-scroll-row><button type="button" onClick={() => visit([...path, name])} disabled={path.length >= 12 || busy}>
            <Folder size={18} aria-hidden="true" /><span>{name}</span><ChevronRight size={17} aria-hidden="true" />
          </button></li>)}
        </ul> : directory.complete ? <div className="workspace-picker-empty"><Folder size={24} aria-hidden="true" /><p>{directory.nextCursor ? '正在查找子文件夹…' : '这里没有子文件夹'}</p></div> : null)}
      {!creating && directoryPage.notice && <p className="workspace-picker-empty" role="status">{directoryPage.notice}</p>}
      {!creating && !browseError && directory && progress && <p className="workspace-picker-empty" role="status">{progress}</p>}
      {!creating && <DirectoryControls {...directoryPage} label="子文件夹" className="directory-continuation" buttonClassName="workspace-picker-secondary" />}
    </div>
    <div className="workspace-picker-footer">
      {error && <p className="workspace-picker-error" role="alert">{error}</p>}
      <div className="workspace-picker-actions">
        {creating && <button type="button" className="workspace-picker-secondary" disabled={busy}
          onClick={() => { restoreFocus.current = true; setCreating(false); clearError(); }}>取消新建</button>}
        <button type="submit" className="primary" disabled={!canSubmit || busy}>
          {busy ? '正在添加…' : creating ? '新建并添加' : '添加当前目录'}
        </button>
      </div>
    </div>
  </form>;
}

export function WorkspaceManagement({ action, roots, csrf, close, changed, report }: {
  action: WorkspaceAction; roots: Roots; csrf: string;
  close(): void; changed(): void; report(reason: unknown): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [label, setLabel] = useState(action.kind === 'add' ? '' : action.workspace.label);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const handleError = (reason: unknown) => {
    if (reason instanceof RequestError && reason.status === 401) report(reason);
    return reason instanceof RequestError ? errors[reason.code] ?? '暂时无法完成操作，请重试。' : '暂时无法确认结果，请重试。';
  };
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  useEffect(() => {
    const node = dialog.current;
    const viewport = window.visualViewport;
    if (!node || !viewport || action.kind !== 'add') return;
    const fitVisibleViewport = () => {
      if (viewport.scale !== 1) {
        node.style.removeProperty('--picker-viewport');
        node.style.removeProperty('--picker-bottom');
        return;
      }
      node.style.setProperty('--picker-viewport', `${viewport.height}px`);
      node.style.setProperty('--picker-bottom', `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`);
    };
    fitVisibleViewport();
    viewport.addEventListener('resize', fitVisibleViewport);
    viewport.addEventListener('scroll', fitVisibleViewport);
    return () => {
      viewport.removeEventListener('resize', fitVisibleViewport);
      viewport.removeEventListener('scroll', fitVisibleViewport);
    };
  }, [action.kind]);
  const submit = async (body: z.infer<typeof workspaceManagementSchema> | FolderSelection) => {
    setBusy(true);
    setError('');
    try {
      await request(action.kind === 'add' ? '/workspaces' : `/workspaces/${encodeURIComponent(action.workspace.id)}/manage`, responseSchema,
        { csrf, body, timeoutMs: 30_000 });
      changed();
      close();
    } catch (reason) {
      setError(handleError(reason));
    } finally { setBusy(false); }
  };
  const title = action.kind === 'add' ? '添加工作区' : action.kind === 'restore' ? '恢复工作区' : '管理工作区';
  return <dialog className={`create-dialog manage-dialog${action.kind === 'add' ? ' workspace-picker' : ''}`} aria-labelledby="workspace-dialog-title" ref={dialog}
    onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <header><h2 id="workspace-dialog-title">{title}</h2><button className="icon-button" aria-label="关闭" disabled={busy} onClick={close}><X size={20} aria-hidden="true" /></button></header>
    {action.kind === 'add' ? <WorkspaceDirectoryPicker roots={roots} csrf={csrf} busy={busy} error={error}
      clearError={() => setError('')} submit={submit} report={report} /> : <>
    <fieldset disabled={busy}>
      {action.kind === 'restore' ? <>
        <p>恢复「{action.workspace.label}」的原登记。对话核对原生会话后即可继续。</p>
        <button className="primary" onClick={() => void submit({ action: 'restore' })}>恢复工作区</button>
      </> : <>
        <form onSubmit={event => { event.preventDefault(); if (workspaceLabelSchema.safeParse(label.trim()).success) void submit({ action: 'rename', label: label.trim() }); }}>
          <label htmlFor="workspace-label">显示名</label>
          <input id="workspace-label" value={label} maxLength={100} onChange={event => setLabel(event.target.value)} />
          <div className="management-actions"><button className="primary" disabled={!workspaceLabelSchema.safeParse(label.trim()).success}>保存显示名</button></div>
        </form>
        <div className="management-actions">
          <button className="text-button" onClick={() => void submit({ action: 'pin', pinned: !action.workspace.pinned })}>{action.workspace.pinned ? '取消置顶' : '置顶工作区'}</button>
          <button className="text-button" onClick={() => setConfirmRemove(true)}>从中书移除工作区</button>
        </div>
        {confirmRemove && <div>
          <p>移除后仍可回看已保存的历史和附件。目录、文件和原生会话会保留。恢复工作区后可以继续对话。</p>
          <div className="management-actions"><button className="text-button" onClick={() => setConfirmRemove(false)}>取消</button>
            <button className="primary" onClick={() => void submit({ action: 'remove' })}>确认移除</button></div>
        </div>}
      </>}
    </fieldset>
    {error && <p role="alert">{error}</p>}</>}
  </dialog>;
}

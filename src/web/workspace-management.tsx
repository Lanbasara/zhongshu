import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { folderName, workspaceDirectoryListSchema, workspaceLabelSchema, workspaceManagementSchema, type WorkbenchConfiguration } from '../shared/workbench.ts';
import { RequestError, request } from './workbench-client.ts';

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

export function WorkspaceManagement({ action, roots, csrf, close, changed, report }: {
  action: WorkspaceAction; roots: NonNullable<WorkbenchConfiguration['workspaceRoots']>; csrf: string;
  close(): void; changed(): void; report(reason: unknown): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rootId, setRootId] = useState(roots[0]?.id ?? '');
  const [path, setPath] = useState<string[]>([]);
  const [directory, setDirectory] = useState<z.infer<typeof workspaceDirectoryListSchema>>();
  const [folder, setFolder] = useState('');
  const [label, setLabel] = useState(action.kind === 'add' ? '' : action.workspace.label);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [browseError, setBrowseError] = useState('');
  const [browseRetry, retryBrowse] = useState(0);
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
    if (action.kind !== 'add' || !rootId) return;
    const controller = new AbortController();
    setDirectory(undefined);
    setBrowseError('');
    void request('/workspace-directories', workspaceDirectoryListSchema, { csrf, body: { rootId, path }, signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setDirectory(value); })
      .catch(reason => {
        if (controller.signal.aborted) return;
        if (reason instanceof RequestError && reason.status === 401) report(reason);
        setBrowseError(reason instanceof RequestError ? errors[reason.code] ?? '暂时无法读取目录。' : '暂时无法读取目录。');
      });
    return () => controller.abort();
  }, [action.kind, rootId, path, csrf, report, browseRetry]);

  const submit = async (body: z.infer<typeof workspaceManagementSchema> | { rootId: string; path: string[]; name?: string }) => {
    setBusy(true);
    setError('');
    try {
      await request(action.kind === 'add' ? '/workspaces' : `/workspaces/${encodeURIComponent(action.workspace.id)}/manage`, responseSchema,
        { csrf, body, timeoutMs: 30_000 });
      changed();
      close();
    } catch (reason) {
      setError(handleError(reason));
      if (action.kind === 'add') retryBrowse(value => value + 1);
    } finally { setBusy(false); }
  };
  const visit = (next: string[]) => { setDirectory(undefined); setPath(next); setFolder(''); setError(''); };
  const title = action.kind === 'add' ? '添加工作区' : action.kind === 'restore' ? '恢复工作区' : '管理工作区';
  const validFolder = path.length < 12 && folderName.safeParse(folder).success;
  const targetDirectory = directory && validFolder ? `${directory.currentDirectory.replace(/\/$/, '')}/${folder}` : undefined;
  return <dialog className="create-dialog manage-dialog" aria-labelledby="workspace-dialog-title" ref={dialog}
    onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <header><h2 id="workspace-dialog-title">{title}</h2><button className="icon-button" aria-label="关闭" disabled={busy} onClick={close}>×</button></header>
    <fieldset disabled={busy}>
      {action.kind === 'add' ? <>
        <label htmlFor="workspace-root">当前实例开放的目录</label>
        <select id="workspace-root" value={rootId} onChange={event => { setRootId(event.target.value); visit([]); }}>
          {roots.map(root => <option value={root.id} key={root.id}>{root.label}</option>)}
        </select>
        <div className="workspace-directory-heading">
          {path.length > 0 && <button className="text-button" onClick={() => visit(path.slice(0, -1))}>上一级</button>}
          <span>当前位置</span>
          {directory && <code aria-label="当前目录的完整路径">{directory.currentDirectory}</code>}
        </div>
        <div className="workspace-directory-list" aria-label="子目录">
          {browseError ? <p role="status">{browseError} <button className="text-button" onClick={() => retryBrowse(value => value + 1)}>重试</button></p> :
            !directory ? <p role="status">正在读取目录…</p> : <>
              {directory.names.map(name => <button className="text-button" key={name} onClick={() => visit([...path, name])} disabled={path.length >= 12}>{name} ›</button>)}
              {!directory.names.length && <p className="quiet">暂无可选子目录</p>}
              {directory.limited && <p className="quiet">仅显示部分子目录。</p>}
            </>}
        </div>
        <button className="primary" disabled={!directory} onClick={() => void submit({ rootId, path })}>添加当前目录</button>
        <form onSubmit={event => { event.preventDefault(); if (targetDirectory) void submit({ rootId, path, name: folder }); }}>
          <label htmlFor="workspace-folder">新建空文件夹</label>
          <input id="workspace-folder" value={folder} maxLength={255} onChange={event => setFolder(event.target.value)} />
          {directory && <p className="workspace-creation-location">
            {targetDirectory ? '将创建在' : '将在当前目录下新建'} <code aria-label="新建文件夹的位置">{targetDirectory ?? directory.currentDirectory}</code>
          </p>}
          <button type="submit" className="primary" disabled={!targetDirectory}>新建并添加</button>
        </form>
      </> : action.kind === 'restore' ? <>
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
    {error && <p role="alert">{error}</p>}
  </dialog>;
}

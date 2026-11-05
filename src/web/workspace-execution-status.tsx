import { useEffect, useState } from 'react';
import { z } from 'zod';
import { request } from './workbench-client.ts';
import { Button } from './ui/controls.tsx';

export const workspaceEditStatusSchema = z.object({ editable: z.boolean(), reason: z.string().nullable(), canPause: z.boolean().optional(), canRecover: z.boolean().optional(), maintenance: z.enum(['online', 'paused', 'unknown', 'transition']).optional(),
  phase: z.enum(['online', 'draining', 'editable', 'resuming', 'unknown', 'initializing']).optional(), windowId: z.string().optional(), affectedGroups: z.array(z.string()).max(32).optional(), initialized: z.boolean().optional() });
export type WorkspaceEditStatus = z.infer<typeof workspaceEditStatusSchema>;
export function publishWorkspaceStatus(workspace: string, value: WorkspaceEditStatus) {
  window.dispatchEvent(new CustomEvent('zhongshu-workspace-status', { detail: { workspace, value } }));
}

/** Recovery is reachable from the conversation even after an editor/tab closes. */
export function WorkspaceExecutionStatus({ workspace, csrf, changed, observed }: { workspace: string; csrf: string; changed(): void; observed?(workspace: string, value: WorkspaceEditStatus | undefined): void }) {
  const [status, setStatus] = useState<WorkspaceEditStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { observed?.(workspace, status); }, [workspace, status]);
  useEffect(() => {
    setStatus(undefined); setError('');
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>; let fetching = false;
    const accept = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const value = workspaceEditStatusSchema.safeParse(detail?.value);
      if (detail?.workspace === workspace && value.success) setStatus(value.data);
    };
    async function check() {
      if (fetching || document.hidden || abort.signal.aborted) return;
      fetching = true;
      try { const next = await request('/workspaces/' + encodeURIComponent(workspace) + '/edit-status', workspaceEditStatusSchema, { signal: abort.signal }); if (!abort.signal.aborted) setStatus(next); }
      catch { /* A failed observation does not clear the last known editing window. */ }
      finally { fetching = false; if (!abort.signal.aborted) timer = setTimeout(() => void check(), 5000); }
    }
    const visible = () => { clearTimeout(timer); if (!document.hidden) void check(); };
    window.addEventListener('zhongshu-workspace-status', accept);
    document.addEventListener('visibilitychange', visible);
    void check();
    return () => { abort.abort(); clearTimeout(timer); window.removeEventListener('zhongshu-workspace-status', accept); document.removeEventListener('visibilitychange', visible); };
  }, [workspace]);
  if (!status || status.maintenance === 'online' || !status.windowId && !status.canRecover) return null;
  async function resume() {
    setBusy(true); setError('');
    try {
      const value = await request('/workspaces/' + encodeURIComponent(workspace) + '/maintenance', workspaceEditStatusSchema, { csrf, body: { action: 'resume' }, timeoutMs: 110_000 });
      setStatus(value); publishWorkspaceStatus(workspace, value); changed();
      if (value.maintenance !== 'online') setError('恢复尚未完成，输入与原对话已保留。可以稍后重试。');
    } catch { setError('暂时无法恢复 Agent。编辑和对话记录已保留，请重试。'); }
    finally { setBusy(false); }
  }
  return <div className="state-notice workspace-execution-notice" role="status">
    <span>{status.phase === 'draining' ? '正在等待已受理任务完成，随后进入文件编辑。' : status.phase === 'resuming' || busy ? '正在恢复 Agent，输入已保留…' : status.phase === 'editable' ? 'Agent 已暂停，工作区正在编辑。结束编辑后可继续原对话。' : 'Agent 尚未恢复，原对话和输入已保留。'}</span>
    <Button disabled={busy || status.phase === 'resuming'} onClick={() => void resume()}>{status.windowId ? '结束编辑并恢复 Agent' : '恢复 Agent'}</Button>
    {error && <span role="alert">{error}</span>}
  </div>;
}

import { useState, type ReactNode } from 'react';
import { Archive, FolderOpen, MoreHorizontal, PanelLeft, Pencil, RefreshCw, Search, Settings, SquarePen } from 'lucide-react';
import type { Conversation } from '../../src/shared/workbench.ts';
import { IconButton, Menu, MenuItem, StatusDot, modifierKey, type StatusKind } from '../../src/web/ui/controls.tsx';
import { ConnectionStatus, ConversationRow, SidebarAction, SidebarShell, WorkspaceActions, WorkspaceGroup } from '../../src/web/patterns/sidebar.tsx';
import { SubagentBackgroundMark } from '../../src/web/patterns/subagents.tsx';
import { conversationStatus, harnessLabel, stateLabel } from '../../src/web/conversation-status.ts';
import { conversations as allConversations, workspaces as allWorkspaces } from './fixtures.tsx';

/*
 * Story-only compositions of presentation patterns, arranged the way workbench.tsx arranges them.
 * They hold only local UI state; nothing is fetched, saved or sent.
 */

export type Connection = 'online' | 'connecting' | 'offline';
export const connectionText: Record<Connection, string> = { online: '已连接', connecting: '正在恢复连接', offline: '离线 · 工作在远端继续' };
export type StorageBadge = 'none' | 'warning' | 'full';
export type SidebarPage = 'none' | 'new' | 'archive' | 'settings';

const summaryOrder: StatusKind[] = ['running', 'waiting', 'failed', 'unknown', 'unread'];
function summarise(list: Conversation[]) {
  const counts = new Map<StatusKind, number>();
  for (const conversation of list) {
    const { status } = conversationStatus(conversation);
    if (summaryOrder.includes(status)) counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return summaryOrder.filter(status => counts.has(status)).map(status => ({ status, count: counts.get(status)! }));
}

export function ExampleSidebar({ narrow = false, connection = 'online', storage = 'none', page = 'none', selected, onSelect, onClose, onCollapse,
  onSearch, onAction, empty = false, conversations = allConversations, closedWorkspaces = [] }: {
  narrow?: boolean; connection?: Connection; storage?: StorageBadge; page?: SidebarPage; selected?: string;
  onSelect(id: string): void; onClose?: () => void; onCollapse?: () => void; onSearch?: () => void; onAction?: (text: string) => void;
  empty?: boolean; conversations?: Conversation[]; closedWorkspaces?: string[];
}) {
  const [closed, setClosed] = useState(() => new Set(closedWorkspaces));
  const say = (text: string) => onAction?.(text);
  const status = <ConnectionStatus text={connectionText[connection]} state={connection}/>;
  return <SidebarShell
    status={narrow ? status : <IconButton label="收起导航" shortcut={[modifierKey, '\\']} onClick={() => onCollapse?.()}><PanelLeft size={16}/></IconButton>}
    onClose={narrow ? onClose : undefined}
    actions={<>
      <SidebarAction icon={<SquarePen size={16}/>} label="新对话" current={page === 'new'} onClick={() => say('新对话')}/>
      <SidebarAction icon={<Search size={16}/>} label={narrow ? '搜索对话、工作区和操作' : '搜索与跳转'} ariaLabel="搜索与跳转"
        shortcut={narrow ? undefined : [modifierKey, 'K']} onClick={() => onSearch ? onSearch() : say('搜索与跳转')}/>
    </>}
    footer={<>
      <SidebarAction icon={<FolderOpen size={16}/>} label="工作区文件" disabled={empty} onClick={() => say('工作区文件')}/>
      <SidebarAction icon={<Archive size={16}/>} label="已归档" current={page === 'archive'} onClick={() => say('已归档')}/>
      <SidebarAction icon={<Settings size={16}/>} label="设置" current={page === 'settings'} onClick={() => say('设置')}
        badge={storage !== 'none' && <span className="sidebar-badge" data-state={storage} aria-label={storage === 'full' ? '存储已满' : '存储接近上限'}/>}/>
      {!narrow && <div className="sidebar-status">{status}</div>}
    </>}>
    <nav className="sidebar-tree" aria-label="工作区与对话">
      {!empty && allWorkspaces.map(workspace => {
        const rows = conversations.filter(conversation => conversation.workspaceId === workspace.id);
        const open = !closed.has(workspace.id);
        return <WorkspaceGroup key={workspace.id} label={workspace.label} pinned={'pinned' in workspace && workspace.pinned} open={open}
          onToggle={() => setClosed(current => { const next = new Set(current); if (open) next.add(workspace.id); else next.delete(workspace.id); return next; })}
          summary={open ? undefined : summarise(rows)}
          actions={<WorkspaceActions label={workspace.label} onCreate={() => say(`在 ${workspace.label} 新建对话`)} onManage={() => say(`管理工作区：${workspace.label}`)}/>}>
          {open && rows.map(conversation => {
            const { status: dot, label } = conversationStatus(conversation);
            const background = conversation.subagents && !['running', 'waiting'].includes(conversation.state.status) && (conversation.subagents.running || conversation.subagents.unverified);
            return <ConversationRow key={conversation.id} title={conversation.title} status={dot} statusLabel={label} unread={conversation.unread}
              selected={conversation.id === selected} onOpen={() => onSelect(conversation.id)} onManage={() => say(`管理对话：${conversation.title}`)}
              meta={background ? <SubagentBackgroundMark running={conversation.subagents!.running} unverified={conversation.subagents!.unverified}/> : undefined}/>;
          })}
          {open && !rows.length && <p className="navigation-empty">还没有对话</p>}
        </WorkspaceGroup>;
      })}
      {empty && <p className="navigation-empty">还没有工作区。可以在「设置 › 工作区」中添加。</p>}
    </nav>
  </SidebarShell>;
}

/** The conversation header as workbench.tsx builds it: crumb, title, status pill (desktop) or meta line (phone), actions. */
export function ExampleHeader({ conversation, extraActions, onSearch, onAction }: {
  conversation?: Conversation; extraActions?: ReactNode; onSearch?: () => void; onAction?: (text: string) => void;
}) {
  const say = (text: string) => onAction?.(text);
  const workspace = conversation && allWorkspaces.find(item => item.id === conversation.workspaceId)?.label;
  const status = conversation && conversationStatus(conversation);
  return <>
    {conversation ? <div className="header-title">
      <span className="header-crumb">{workspace}</span><span className="header-separator" aria-hidden="true">/</span>
      <h1 title={conversation.title}>{conversation.title}</h1>
      <span className="header-meta">{status?.status !== 'idle' && <StatusDot status={status!.status}/>}{workspace} · {harnessLabel(conversation.harnessId)}{status?.status !== 'idle' ? ` · ${stateLabel(conversation)}` : ''}</span>
      {status?.status !== 'idle' && <span className="header-status" data-status={status!.status}><StatusDot status={status!.status}/>{stateLabel(conversation)}</span>}
    </div> : <div className="header-title"><h1>中书</h1></div>}
    <div className="header-actions">
      {extraActions}
      <IconButton className="header-search" label="搜索与跳转" onClick={() => onSearch ? onSearch() : say('搜索与跳转')}><Search size={18}/></IconButton>
      <IconButton label="打开工作区文件" tooltip="工作区文件" onClick={() => say('工作区文件')}><FolderOpen size={16}/></IconButton>
      {conversation && <Menu label="对话操作" trigger={<MoreHorizontal size={17}/>} align="end">
        <MenuItem onSelect={() => say('重命名、归档或删除')}><Pencil size={15}/>重命名、归档或删除</MenuItem>
        <MenuItem onSelect={() => say('重新连接并刷新状态')}><RefreshCw size={15}/>重新连接并刷新状态</MenuItem>
      </Menu>}
    </div>
  </>;
}

import { forwardRef, type ReactNode } from 'react';
import { ChevronRight, MoreHorizontal, Pin, Plus } from 'lucide-react';
import { BrandMark, IconButton, Kbd, StatusDot, type StatusKind } from '../ui/controls.tsx';
import './navigation.css';

/** Brand row, primary actions, the scrolling tree and the footer. Presentation only. */
export function SidebarShell({ status, actions, children, footer, onClose, separator }: {
  status?: ReactNode; actions: ReactNode; children: ReactNode; footer: ReactNode; onClose?: () => void; separator?: ReactNode;
}) {
  return <>
    <div className="sidebar-brand"><BrandMark size={20}/><span className="sidebar-name">中书</span><span className="sidebar-grow"/>{status}
      {onClose && <IconButton className="sidebar-close" label="关闭导航" onClick={onClose}><ChevronRight size={18} style={{ transform: 'rotate(180deg)' }}/></IconButton>}</div>
    <div className="sidebar-actions">{actions}</div>
    {children}
    <div className="sidebar-footer">{footer}</div>
    {separator}
  </>;
}

export const SidebarAction = forwardRef<HTMLButtonElement, { icon: ReactNode; label: string; shortcut?: string[]; current?: boolean; onClick(): void; disabled?: boolean; badge?: ReactNode; ariaLabel?: string }>(
  function SidebarAction({ icon, label, shortcut, current, onClick, disabled, badge, ariaLabel }, ref) {
    return <button ref={ref} type="button" className="sidebar-action" aria-current={current ? 'page' : undefined} aria-label={ariaLabel} disabled={disabled} onClick={onClick}>
      {icon}<span className="sidebar-action-label">{label}</span>{badge}{shortcut && <Kbd keys={shortcut}/>}</button>;
  });

export function ConnectionStatus({ text, state }: { text: string; state: 'online' | 'connecting' | 'offline' }) {
  return <span className="connection-status" data-state={state} role="status"><span className="connection-dot"/>{text}</span>;
}

/** A workspace header with its rows; closed groups summarise their attention-worthy rows. */
export function WorkspaceGroup({ label, pinned, open, onToggle, summary, actions, children }: {
  label: string; pinned?: boolean; open: boolean; onToggle(): void; summary?: { status: StatusKind; count: number }[];
  actions?: ReactNode; children: ReactNode;
}) {
  return <section className="workspace-group" data-open={open}>
    <header>
      <button type="button" className="workspace-toggle" aria-expanded={open} onClick={onToggle}>
        <ChevronRight size={12} className="workspace-chevron"/><strong title={label}>{label}</strong>
        {pinned && <Pin size={11} className="workspace-pin" aria-label="已置顶"/>}
        {!open && summary?.length ? <span className="workspace-summary">{summary.map(item => <span key={item.status}><StatusDot status={item.status}/>{item.count > 1 && item.count}</span>)}</span> : null}
      </button>
      {actions && <span className="workspace-actions">{actions}</span>}
    </header>
    <div className="workspace-body"><div>{children}</div></div>
  </section>;
}

export function WorkspaceActions({ label, onCreate, onManage }: { label: string; onCreate(): void; onManage?: () => void }) {
  return <>
    <IconButton label={`在 ${label} 新建对话`} tooltip="在这里新建对话" onClick={onCreate}><Plus size={14}/></IconButton>
    {onManage && <IconButton label={`管理工作区：${label}`} tooltip="管理工作区" onClick={onManage}><MoreHorizontal size={14}/></IconButton>}
  </>;
}

export function ConversationRow({ title, status, statusLabel, unread, selected, detail, meta, onOpen, onManage }: {
  title: string; status: StatusKind; statusLabel: string; unread?: boolean; selected?: boolean; detail?: string; meta?: ReactNode;
  onOpen(): void; onManage?: () => void;
}) {
  return <div className="conversation-row" data-selected={selected || undefined} data-unread={unread || undefined}>
    <button type="button" className="conversation-link" aria-current={selected ? 'page' : undefined} onClick={onOpen} title={title}>
      <StatusDot status={status}/>
      <span className="conversation-text"><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
      <span className="sr-only">{statusLabel}</span>
      {meta && <span className="conversation-meta">{meta}</span>}
    </button>
    {onManage && <button type="button" className="conversation-options" aria-label={`管理对话：${title}`} onClick={onManage}><MoreHorizontal size={15}/></button>}
  </div>;
}

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { PanelLeft } from 'lucide-react';
import { IconButton } from '../ui/controls.tsx';

/** Owns the viewport, columns and navigation focus; no conversation lifecycle. */
export function WorkbenchFrame({ sidebar, header, children, reader, style, navigationOpen, onNavigationChange }: {
  sidebar: ReactNode; header: ReactNode; children: ReactNode; reader?: ReactNode; style?: CSSProperties;
  navigationOpen: boolean; onNavigationChange(open: boolean): void;
}) {
  const [mobile, setMobile] = useState(() => matchMedia('(max-width:759px)').matches);
  const [collapsed, setCollapsed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const query = matchMedia('(max-width:759px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return <div className={`workbench ${reader ? 'with-workspace-reader' : ''} ${collapsed ? 'navigation-collapsed' : ''}`} style={style}>
    {!mobile && <aside className="sidebar" aria-label="对话导航" hidden={collapsed}>{sidebar}</aside>}
    {mobile && <Dialog.Root open={navigationOpen} onOpenChange={onNavigationChange}><Dialog.Portal>
      <Dialog.Overlay className="navigation-overlay"/>
      <Dialog.Content className="sidebar mobile-sidebar" aria-describedby={undefined}
        onEscapeKeyDown={event => {
          // Native modal workflows sit above Radix's drawer in the browser's top layer.
          const modal = (event.target as Element).closest('dialog');
          if (modal?.open) { event.preventDefault(); modal.requestClose(); }
        }}
        onKeyDown={event => {
          // Passive hints must not consume the drawer's Escape; nested interactive layers keep it.
          const layer = (event.target as Element).closest('[role="dialog"],[role="menu"],[role="listbox"],dialog');
          if (event.key === 'Escape' && layer === event.currentTarget) { event.preventDefault(); onNavigationChange(false); }
        }}
        onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
        <Dialog.Title className="sr-only">对话导航</Dialog.Title>{sidebar}
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>}
    <main className="conversation-panel">
      <header className="conversation-header"><IconButton ref={trigger} label={mobile ? '打开对话导航' : collapsed ? '展开导航' : '收起导航'} onClick={() => mobile ? onNavigationChange(true) : setCollapsed(!collapsed)}><PanelLeft size={17}/></IconButton>{header}</header>
      {children}
    </main>
    {reader}
  </div>;
}

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { Menu as MenuIcon, PanelLeft } from 'lucide-react';
import { IconButton, modifierKey } from '../ui/controls.tsx';
import './workbench-frame.css';

export const narrowQuery = '(max-width:759px)';
export function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia(narrowQuery).matches);
  useEffect(() => {
    const query = matchMedia(narrowQuery);
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

/**
 * Owns the viewport: sidebar column (a drawer on phones), the main column with its header, and an on-demand
 * side panel that slides over the main column. No conversation lifecycle lives here.
 */
export function WorkbenchFrame({ sidebar, header, children, panel, panelExpanded, style, navigationOpen, onNavigationChange, collapsed, onCollapsedChange }: {
  sidebar: ReactNode; header: ReactNode; children: ReactNode; panel?: ReactNode; panelExpanded?: boolean; style?: CSSProperties;
  navigationOpen: boolean; onNavigationChange(open: boolean): void; collapsed: boolean; onCollapsedChange(collapsed: boolean): void;
}) {
  const mobile = useNarrow();
  const trigger = useRef<HTMLButtonElement>(null);
  return <div className={`workbench${collapsed && !mobile ? ' navigation-collapsed' : ''}`} style={style}>
    {!mobile && <aside className="sidebar" aria-label="对话导航" hidden={collapsed}>{sidebar}</aside>}
    {mobile && <Dialog.Root open={navigationOpen} onOpenChange={onNavigationChange}><Dialog.Portal>
      <Dialog.Overlay className="navigation-overlay"/>
      <Dialog.Content className="sidebar mobile-sidebar" aria-describedby={undefined}
        onOpenAutoFocus={event => {
          // Focus the drawer itself: auto-focusing its first button would flash a focus ring on touch.
          event.preventDefault(); (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        }}
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
      <header className="conversation-header">
        {mobile ? <IconButton ref={trigger} className="header-lead" label="打开对话导航" onClick={() => onNavigationChange(true)}><MenuIcon size={19}/></IconButton>
          : collapsed && <IconButton ref={trigger} className="header-lead" label="展开导航" shortcut={[modifierKey, '\\']} onClick={() => onCollapsedChange(false)}><PanelLeft size={16}/></IconButton>}
        {header}
      </header>
      {children}
      {panel && <div className={`workbench-panel${panelExpanded ? ' is-expanded' : ''}`}>{panel}</div>}
    </main>
  </div>;
}

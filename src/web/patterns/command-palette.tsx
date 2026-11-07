import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { Search } from 'lucide-react';
import { Kbd, StatusDot, type StatusKind } from '../ui/controls.tsx';
import './overlays.css';

export type PaletteItem = { id: string; group: string; title: string; detail?: string; status?: StatusKind; statusLabel?: string; icon?: ReactNode; shortcut?: string[]; run(): void };

function highlight(text: string, query: string) {
  const at = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}

/** Search and jump. The caller owns the query, results and what each item does. Full screen on phones. */
export function CommandPalette({ open, onOpenChange, query, onQuery, items, status, placeholder = '搜索对话、工作区，或输入操作…' }: {
  open: boolean; onOpenChange(open: boolean): void; query: string; onQuery(query: string): void;
  items: PaletteItem[]; status?: string; placeholder?: string;
}) {
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { setActive(0); }, [query, open]);
  useEffect(() => { if (active >= items.length) setActive(Math.max(0, items.length - 1)); }, [items.length, active]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const choose = (item: PaletteItem | undefined) => { if (!item) return; onOpenChange(false); item.run(); };
  let group = '';
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="palette-overlay"/>
    <Dialog.Content className="palette" aria-describedby={undefined}>
      <Dialog.Title className="sr-only">搜索与跳转</Dialog.Title>
      <div className="palette-input"><Search size={16}/>
        <input autoFocus type="text" role="combobox" aria-expanded aria-controls={listId} aria-label="搜索与跳转" autoComplete="off" spellCheck={false}
          aria-activedescendant={items[active] ? `${listId}-${active}` : undefined} placeholder={placeholder} value={query} maxLength={200}
          onChange={event => onQuery(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); if (!items.length) return;
              setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
            } else if (event.key === 'Enter') { event.preventDefault(); choose(items[active]); }
          }}/>
        <Dialog.Close className="palette-cancel">取消</Dialog.Close>
      </div>
      <div className="palette-list" id={listId} role="listbox" aria-label="结果" ref={list}>
        {items.map((item, index) => {
          const heading = item.group !== group ? (group = item.group) : undefined;
          return <div key={item.id} role="presentation">
            {heading && <div className="palette-group" role="presentation">{heading}</div>}
            <button type="button" id={`${listId}-${index}`} data-index={index} role="option" aria-selected={index === active} tabIndex={-1}
              className="palette-item" onMouseMove={() => { if (active !== index) setActive(index); }} onClick={() => choose(item)}>
              {item.status ? <StatusDot status={item.status} label={item.statusLabel}/> : <span className="palette-icon">{item.icon}</span>}
              <span className="palette-title">{highlight(item.title, query.trim())}</span>
              {item.detail && <span className="palette-detail">{item.detail}</span>}
              {item.shortcut && <Kbd keys={item.shortcut}/>}
            </button>
          </div>;
        })}
        {!items.length && <p className="palette-empty" role="status">{status ?? '没有匹配的结果'}</p>}
        {!!items.length && status && <p className="palette-empty" role="status">{status}</p>}
      </div>
      <div className="palette-footer" aria-hidden="true"><span><Kbd keys={['↑', '↓']}/>选择</span><span><Kbd keys={['↵']}/>打开</span><span><Kbd keys={['Esc']}/>关闭</span></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

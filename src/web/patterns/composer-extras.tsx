import { useCallback, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef } from 'react';
import { Box, Database } from 'lucide-react';
import { Popover } from 'radix-ui';
import './composer-extras.css';

type Span = { start: number; end: number };
type SkillReference = Span & { id: string; label: string };
type SkillOption = { id: string; name: string; label: string; description: string };
type Picker = { load(signal: AbortSignal): Promise<readonly SkillOption[]>; format(label: string): string; limit: number };
type TextareaProps = ComponentPropsWithRef<'textarea'>;

function slashAt(text: string, cursor: number) {
  const match = /(?:^|\s)\/([\p{L}\p{N}_.:-]*)$/u.exec(text.slice(0, cursor));
  if (!match) return null;
  const tail = /^[\p{L}\p{N}_.:-]*/u.exec(text.slice(cursor))?.[0] ?? '';
  const end = cursor + tail.length;
  if (text[end] === '/') return null;
  const query = match[1] ?? '';
  return { start: cursor - query.length - 1, end, query: query.toLowerCase() };
}

function moveSpans(spans: SkillReference[], { start, end }: Span, delta: number): SkillReference[] {
  return spans.flatMap(span => {
    if (span.end <= start) return [span];
    if (span.start >= end) return [{ ...span, start: span.start + delta, end: span.end + delta }];
    return [];
  });
}

// Only keep an identity if the edit leaves its original occurrence intact.
function editedSpans(before: string, after: string, spans: SkillReference[], edit: (Span & { type: string }) | null) {
  if (!spans.length) return spans;
  if (!edit) return before === after ? spans : [];
  let { start, end } = edit;
  const delta = after.length - before.length;
  if (start === end && delta < 0) {
    if (edit.type.endsWith('Backward')) start += delta;
    else if (edit.type.endsWith('Forward')) end -= delta;
  }
  if (start < 0 || end > before.length || end + delta < start ||
    before.slice(0, start) !== after.slice(0, start) || before.slice(end) !== after.slice(end + delta)) return [];
  return moveSpans(spans, { start, end }, delta);
}

type SkillCatalog = { status: 'loading' | 'unavailable' } | { status: 'ready'; options: readonly SkillOption[] };
const loading = { status: 'loading' } as const;
const emptySpans: SkillReference[] = [];

export function SkillEditor({ editor, spans = emptySpans, picker, onEdit }: {
  editor: TextareaProps; spans?: SkillReference[]; picker?: Picker;
  onEdit(text: string, spans: SkillReference[]): void;
}) {
  const value = typeof editor.value === 'string' ? editor.value : '';
  const field = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLButtonElement>(null);
  const pendingCaret = useRef<number>(null);
  const composing = useRef(false);
  const beforeEdit = useRef<(Span & { type: string }) | null>(null);
  const editorRef = editor.ref;
  const attachField = useCallback((node: HTMLTextAreaElement | null) => {
    field.current = node;
    if (typeof editorRef === 'function') editorRef(node);
    else if (editorRef) editorRef.current = node;
    if (!node) return;
    const capture = (event: InputEvent) => {
      beforeEdit.current = { start: node.selectionStart, end: node.selectionEnd, type: event.inputType };
    };
    node.addEventListener('beforeinput', capture);
    return () => {
      node.removeEventListener('beforeinput', capture);
      field.current = null;
      if (typeof editorRef === 'function') editorRef(null);
      else if (editorRef) editorRef.current = null;
    };
  }, [editorRef]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [catalog, setCatalog] = useState<SkillCatalog>(loading);
  const [limitReached, setLimitReached] = useState(false);
  const listId = useId();
  const loadSkills = picker?.load;
  const slash = cursor === null || editor.disabled || !loadSkills ? null : slashAt(value, cursor);
  const open = slash !== null;
  const matches = slash && catalog.status === 'ready' ? catalog.options.filter(skill =>
    [skill.name, skill.label, skill.description].some(text => text.toLowerCase().includes(slash.query))) : [];
  const match = matches[active];
  useLayoutEffect(() => {
    setCatalog(loading);
    if (!open || !loadSkills) return;
    const controller = new AbortController();
    void loadSkills(controller.signal).then(options => {
      if (!controller.signal.aborted) setCatalog({ status: 'ready', options });
    }).catch(() => {
      if (!controller.signal.aborted) setCatalog({ status: 'unavailable' });
    });
    return () => controller.abort();
  }, [loadSkills, open]);

  function select(skill: SkillOption) {
    if (!slash || !field.current || !picker) return;
    const label = picker.format(skill.label);
    const after = value.slice(slash.end);
    const space = /^\s/u.test(after) ? '' : ' ';
    const text = value.slice(0, slash.start) + label + space + after;
    const retained = moveSpans(spans, slash, text.length - value.length);
    if (text.length > (editor.maxLength ?? 16000) || retained.length >= picker.limit) { setLimitReached(true); return; }
    const end = slash.start + label.length;
    const next = [...retained, { id: skill.id, label: skill.label, start: slash.start, end }].sort((a, b) => a.start - b.start);
    pendingCaret.current = end + (space || after.startsWith(' ') ? 1 : 0);
    setCursor(null);
    onEdit(text, next);
  }

  function syncMirror() {
    if (mirror.current && field.current) mirror.current.scrollTop = field.current.scrollTop;
  }

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null || !field.current) return;
    pendingCaret.current = null;
    field.current.focus();
    field.current.setSelectionRange(caret, caret);
  }, [value]);
  useLayoutEffect(syncMirror, [value, spans]);
  useLayoutEffect(() => { selected.current?.scrollIntoView({ block: 'nearest' }); }, [match]);

  function trackCaret(node: HTMLTextAreaElement) {
    if (composing.current) return;
    const next = node.selectionStart === node.selectionEnd ? node.selectionStart : null;
    if (next !== cursor) { setCursor(next); setActive(0); }
  }

  let offset = 0;
  return <Popover.Root open={open} onOpenChange={next => { if (!next) setCursor(null); }}>
    {slash && <Popover.Portal><Popover.Content className="writing-skills" role="presentation" side="top" sideOffset={24} collisionPadding={10}
      onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
      onInteractOutside={event => { if (event.target === field.current) event.preventDefault(); }}>
      <div className="writing-skills-heading" id={`${listId}-heading`}>可用技能</div>
      <div className="writing-skills-list" id={listId} role="listbox" aria-labelledby={`${listId}-heading`}>
        {matches.map((skill, index) => <button key={skill.id} id={`${listId}-${index}`} ref={index === active ? selected : undefined}
          className="writing-skill" type="button" role="option" tabIndex={-1} aria-selected={index === active}
          onMouseDown={event => event.preventDefault()} onClick={() => select(skill)}>
          <Box size={16} aria-hidden="true"/>
          <span><strong>{skill.label}</strong><small>{skill.description}</small></span>
          {index === active && <kbd aria-hidden="true">Tab</kbd>}
        </button>)}
      </div>
      {limitReached ? <div className="writing-skills-empty" role="status">已达输入上限，请缩短草稿或移除一项技能。</div>
        : matches.length ? <div className="writing-skills-hint"><span>↑ ↓ 切换</span><span>Tab 选择</span><span>Esc 关闭</span></div>
        : <div className="writing-skills-empty" role="status">{catalog.status === 'loading' ? '正在读取可用技能…'
          : catalog.status === 'unavailable' ? '暂时无法读取技能，关闭后可重试。' : '没有匹配的技能'}</div>}
    </Popover.Content></Popover.Portal>}
    <Popover.Anchor asChild><div className="writing-editor" data-decorated={spans.length > 0}>
      {spans.length > 0 && <div className="writing-editor-mirror" ref={mirror} aria-hidden="true">
        {spans.map(span => {
          const prefix = value.slice(offset, span.start);
          offset = span.end;
          return <span key={span.start}>{prefix}<mark>{value.slice(span.start, span.end)}</mark></span>;
        })}{value.slice(offset)}{value.endsWith('\n') ? '\u200b' : ''}
      </div>}
      <textarea {...editor} ref={attachField} aria-autocomplete={loadSkills ? 'list' : undefined} aria-controls={slash ? listId : undefined} aria-activedescendant={match ? `${listId}-${active}` : undefined}
        onChange={event => {
          const next = event.currentTarget.value;
          const nextSpans = editedSpans(value, next, spans, beforeEdit.current);
          beforeEdit.current = null;
          setLimitReached(false);
          setActive(0);
          setCursor(composing.current ? null : event.currentTarget.selectionStart);
          onEdit(next, nextSpans);
        }}
        onCompositionStart={() => { composing.current = true; setCursor(null); }}
        onCompositionEnd={event => { composing.current = false; trackCaret(event.currentTarget); }}
        onSelect={event => trackCaret(event.currentTarget)} onScroll={syncMirror} onBlur={() => setCursor(null)}
        onKeyDown={event => {
          if (composing.current || event.nativeEvent.isComposing) return;
          if (slash && event.key === 'Escape') { event.preventDefault(); setCursor(null); return; }
          if (match && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
            if (event.key === 'Tab') { event.preventDefault(); select(match); return; }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((active + step + matches.length) % matches.length);
              return;
            }
          }
          editor.onKeyDown?.(event);
        }}/>
    </div></Popover.Anchor>
  </Popover.Root>;
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat('en');
export function ComposerUsage({ usage }: { usage: { total?: number; context?: { used: number; capacity: number; estimated: boolean } } }) {
  const headingId = useId();
  const { total, context } = usage;
  const progress = context ? Math.min(100, context.used / context.capacity * 100) : 0;
  const percent = Math.round(progress);
  return <div className="writing-usage">
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="writing-usage-trigger">
          {total !== undefined && <span><Database size={13} aria-hidden="true"/>累计 {compact.format(total)} tokens</span>}
          {context && <span className="writing-usage-context">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <circle cx="8" cy="8" r="6" className="writing-ring-track"/>
              <circle cx="8" cy="8" r="6" pathLength="100" strokeDasharray={`${progress} 100`} transform="rotate(-90 8 8)"/>
            </svg>上下文 {percent}%
          </span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="zs-popover writing-usage-popover" aria-labelledby={headingId} side="top" align="end" sideOffset={8} collisionPadding={12}>
          <strong id={headingId}>对话用量</strong>
          <dl>
            <div><dt>累计 Token</dt><dd>{total === undefined ? '暂无数据' : exact.format(total)}</dd></div>
            <div><dt>上下文已用</dt><dd>{context ? `${context.estimated ? '约 ' : ''}${compact.format(context.used)} / ${compact.format(context.capacity)}` : '暂无数据'}</dd></div>
          </dl>
          {context && <div className="writing-usage-track" role="meter" aria-label="上下文占用率" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${progress}%` }}/>
          </div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}

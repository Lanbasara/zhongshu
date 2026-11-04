import { useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowUp, FileText, ImagePlus, ListPlus, LoaderCircle, Plus, ShieldCheck, Square } from 'lucide-react';
import { Information, Menu, MenuItem } from '../ui/controls.tsx';
import { transitions } from '../ui/motion.ts';
import './composer.css';

export type ComposerViewProps = {
  value: string; onChange(value: string): void; onSend(): void; onStop(): void;
  onImages(files: File[]): void; onFiles(): void;
  editDisabled: boolean; imagesDisabled: boolean; filesDisabled: boolean; sendDisabled: boolean;
  sending: boolean; running: boolean; queueing?: boolean; model: string; permission: string; configurationNote: string;
  queue?: ReactNode; materials?: ReactNode; hasMaterials: boolean; error?: string;
  renderEditor?(props: ComponentPropsWithRef<'textarea'>): ReactNode;
  footerDetails?: ReactNode;
};

/** Presentation only: the caller owns submission, upload and persistence decisions. */
export function ComposerView(props: ComposerViewProps) {
  const { value, onChange, onSend, onStop, onImages, onFiles, editDisabled, imagesDisabled, filesDisabled, sendDisabled, sending, running, queueing, model, permission, configurationNote, queue, materials, hasMaterials, error } = props;
  const canSubmit = !sendDisabled && (!running || queueing);
  const sendLabel = queueing ? '加入队列' : '发送消息';
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const reduce = useReducedMotion();
  const hintId = useId();
  const errorId = useId();
  const transition = reduce ? { duration: 0 } : transitions.surface;
  const fit = () => {
    const node = field.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, parseFloat(getComputedStyle(node).maxHeight) || 220)}px`;
  };
  useLayoutEffect(fit, [value]);
  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => { if (width !== node.clientWidth) { width = node.clientWidth; fit(); } });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const editor: ComponentPropsWithRef<'textarea'> = {
    ref: field, 'aria-label': '给 Agent 的消息', 'aria-describedby': `${hintId}${error ? ` ${errorId}` : ''}`,
    rows: 2, value, disabled: editDisabled, maxLength: 16000,
    placeholder: queueing ? '写下下一条消息，加入队列…' : running ? '可以先写下下一步，完成后继续…' : '继续思考，或开始一件新工作…',
    onChange: event => onChange(event.currentTarget.value),
    onPaste: event => {
      const files = [...event.clipboardData.items].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file);
      if (files.length) { event.preventDefault(); if (!imagesDisabled) onImages(files); }
    },
    onKeyDown: event => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault(); if (canSubmit) onSend();
      }
    },
  };
  return <div className="writing-region">
    <div className="writing-dock">
    {queue}
    <form className="writing-surface" data-dragging={dragging && !imagesDisabled} onSubmit={event => { event.preventDefault(); if (canSubmit) onSend(); }}
      onDragEnter={event => { if (!imagesDisabled && event.dataTransfer.types.includes('Files')) { event.preventDefault(); depth.current++; setDragging(true); } }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); }}
      onDrop={event => { event.preventDefault(); depth.current = 0; setDragging(false); if (!imagesDisabled) onImages([...event.dataTransfer.files]); }}>
      <AnimatePresence initial={false}>{hasMaterials && <motion.div className="writing-materials" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={transition}>{materials}</motion.div>}</AnimatePresence>
      {props.renderEditor ? props.renderEditor(editor) : <textarea {...editor}/>}
      {error && <p id={errorId} className="writing-error" role="alert">{error}</p>}
      <div className="writing-toolbar">
        <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { onImages([...event.target.files ?? []]); event.target.value = ''; }}/>
        <Menu label="添加图片或文件引用" trigger={<Plus size={18}/>} disabled={imagesDisabled && filesDisabled}>
          <MenuItem disabled={imagesDisabled} onSelect={() => picker.current?.click()}><ImagePlus size={16}/>添加图片</MenuItem>
          <MenuItem disabled={filesDisabled} onSelect={onFiles}><FileText size={16}/>引用工作区文件</MenuItem>
        </Menu>
        <span className="writing-divider" aria-hidden="true"/>
        <Information label="当前对话配置" summary={<span>{model}</span>}><dl><div><dt>模型</dt><dd>{model}</dd></div><div><dt>权限</dt><dd>{permission}</dd></div></dl><p>{configurationNote}</p></Information>
        <span className="writing-spacer"/>
        {running && <span className="writing-running" role="status"><LoaderCircle size={13} className="spin"/><span>执行中</span></span>}
        {running && <motion.button className="writing-send" type="button" aria-label="停止当前轮" disabled={sending}
          onClick={onStop} whileTap={reduce ? undefined : { scale: .94 }} transition={transitions.state}>
          <Square size={13} fill="currentColor"/>
        </motion.button>}
        {(!running || queueing) && <motion.button className="writing-send" type="submit" aria-label={sendLabel} title={sendLabel} disabled={sendDisabled}
          whileTap={reduce ? undefined : { scale: .94 }} transition={transitions.state}>
          {sending ? <LoaderCircle size={18} className="spin"/> : queueing ? <ListPlus size={19}/> : <ArrowUp size={19}/>}
        </motion.button>}
      </div>
      {dragging && !imagesDisabled && <div className="writing-drop"><ImagePlus size={24}/><span>松开，添加图片</span></div>}
    </form>
    </div>
    <div className="writing-footnote"><span title={configurationNote}><ShieldCheck size={12}/>{permission}</span>{props.footerDetails}<span id={hintId}><kbd>⌘ / Ctrl</kbd><kbd>↵</kbd>{queueing ? '排队' : '发送'}</span></div>
  </div>;
}

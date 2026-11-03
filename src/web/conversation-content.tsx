import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import { code } from '@streamdown/code';
import { cjk } from '@streamdown/cjk';
import { Check, ChevronDown, Copy, FileText, Quote, Terminal, X, ImageIcon } from 'lucide-react';
import type { TurnFileSummary, WorkbenchItem } from '../shared/workbench.ts';
import type { MessageReference, ImageAttachment } from '../shared/content.ts';
import { referenceSchema } from '../shared/content.ts';
import { workspaceImages } from './markdown.ts';
import { TurnFiles } from './patterns/turn-files.tsx';

export const imageUrl = (conversation: string, image: ImageAttachment) => `/api/private/workbench/conversations/${encodeURIComponent(conversation)}/resources/${image.id}`;

function ImageView({ src, alt }: { src: string; alt: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="image-unavailable"><ImageIcon size={18}/>图片暂时无法读取 <button type="button" onClick={() => setFailed(false)}>重试</button></span>;
  return <><button type="button" className="image-preview" aria-label={`放大图片：${alt}`} onClick={() => dialog.current?.showModal()}><img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}/></button><dialog ref={dialog} className="image-lightbox" onClick={e => { if (e.target === dialog.current) dialog.current.close(); }}><button className="lightbox-close" aria-label="关闭图片" onClick={() => dialog.current?.close()}><X size={22}/></button><img src={src} alt={alt} referrerPolicy="no-referrer"/><p>{alt}</p></dialog></>;
}

function safeUrl(url: string) {
  if (url.startsWith('/api/private/workbench/conversations/') && !url.includes('\\')) return url;
  try { const parsed = new URL(url); return ['https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : ''; } catch { return ''; }
}
function imageSource(source: string) {
  try { return referenceSchema.safeParse({ type: 'file', path: decodeURIComponent(source).replace(/^\.\//, '') }).success; } catch { return false; }
}
const markdownComponents = {
  a: ({ href, children }: React.ComponentProps<'a'>) => <a href={safeUrl(href ?? '') || undefined} target="_blank" rel="noopener noreferrer">{children}</a>,
};

export function Message({ item, conversation, onQuote }: { item: WorkbenchItem; conversation: string; onQuote(reference: MessageReference): void }) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const [quoteHint, setQuoteHint] = useState(false);
  // The explicit options also distinguish Streamdown's shared processor cache.
  const remarkPlugins = useMemo(() => [...Object.values(defaultRemarkPlugins), [workspaceImages, { conversation, item: item.id }] as [typeof workspaceImages, { conversation: string; item: string }]], [conversation, item.id]);
  const components = useMemo(() => ({ ...markdownComponents,
    img: ({ src, alt }: { src?: string; alt?: string }) => {
      const url = src && (safeUrl(src) || (imageSource(src) ? `/api/private/workbench/conversations/${conversation}/workspace-image?item=${encodeURIComponent(item.id)}&source=${encodeURIComponent(src)}` : ''));
      return url ? <ImageView src={url} alt={alt || '消息图片'}/> : <span>图片地址不可用</span>;
    },
  }), [conversation, item.id]);
  function quote() {
    const selection = window.getSelection();
    const text = selection?.anchorNode && ref.current?.contains(selection.anchorNode) ? selection.toString() : '';
    if (text.trim()) onQuote({ type: 'quote', itemId: item.id, text: text.slice(0,8000) });
    else { setQuoteHint(true); setTimeout(() => setQuoteHint(false),3000); }
  }
  return <article ref={ref} tabIndex={-1} className={`message message-${item.kind}`} data-message-id={item.id}>
    {item.kind === 'notice' && <div className="message-author">状态</div>}
    <div className="message-text">{item.kind === 'assistant' ? <Streamdown plugins={{ code, cjk }} remarkPlugins={remarkPlugins} components={components} skipHtml urlTransform={(url, key) => safeUrl(url) || (key === 'src' && imageSource(url) ? url : '')} isAnimating={item.status === 'running'}>{item.text || (item.status === 'running' ? '正在生成…' : '')}</Streamdown> : item.text}</div>
    {item.images?.length ? <div className="message-images">{item.images.map(image => <ImageView key={image.id} src={imageUrl(conversation, image)} alt={image.name}/>)}</div> : null}
    {item.references?.length ? <div className="message-references">{item.references.map((reference, index) => <div key={index} className="reference-card">{reference.type === 'file' ? <><FileText size={14}/><span>{reference.path}<small>工作区原文件</small></span></> : <><Quote size={14}/><blockquote>{reference.text}<small>引用消息片段</small></blockquote></>}</div>)}</div> : null}
    {item.text && item.kind !== 'notice' && <div className="message-actions"><button type="button" aria-label="复制消息" onClick={() => { void navigator.clipboard.writeText(item.text).then(() => { setCopied(true); setTimeout(() => setCopied(false),1500); }).catch(() => {}); }}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button><button type="button" aria-label="引用所选文字" onClick={quote}><Quote size={14}/></button></div>}
    {item.status === 'failed' && <small className="quiet">此项未完成</small>}
    {quoteHint && <small className="quiet" role="status">选中这条消息中的文字后，再点引用。</small>}
  </article>;
}

export function ToolGroup({ items }: { items: WorkbenchItem[] }) {
  const running = items.some(i => i.status === 'running');
  const failed = items.filter(i => i.status === 'failed').length;
  const summary = running ? '正在执行' : failed ? `执行结束 · ${failed} 项未完成` : '已完成';
  return <details className={`tool-group ${running ? 'is-running' : ''}`}><summary><span className="activity-dot"/>{summary}<span className="activity-count">{items.length} 项操作</span><ChevronDown size={14}/></summary><div className="tool-timeline">{items.map(item => <details key={item.id} className="tool-message"><summary><Terminal size={14}/><span>{item.tool?.name ?? '工具执行'}</span><small>{item.status === 'running' ? '进行中' : item.status === 'failed' ? '未完成' : '已完成'}</small></summary>{item.tool?.input && <pre className="tool-input">{item.tool.input}</pre>}<pre>{item.tool?.output || item.text || '暂无输出'}</pre></details>)}</div></details>;
}

/** Group tools without reordering text or merging actions from separate native turns. */
export const Transcript = memo(function Transcript({ items, conversation, onQuote, turnFiles, activeRun, activeFile, unavailableFiles, workspaceUnavailable, onOpenFile }: {
  items: WorkbenchItem[]; conversation: string; onQuote(reference: MessageReference): void;
  turnFiles?: ReadonlyMap<string, TurnFileSummary>; activeRun?: string; activeFile?: { runId: string; path: string };
  unavailableFiles?: ReadonlySet<string>; workspaceUnavailable?: boolean;
  onOpenFile?(runId: string, path: string, trigger: HTMLButtonElement): void;
}) {
  const groups: { key: string; tools?: WorkbenchItem[]; message?: WorkbenchItem }[] = [];
  const lastItem = new Map<string, string>();
  for (const item of items) {
    if (item.runId) lastItem.set(item.runId, item.id);
    const previous = groups.at(-1);
    if (item.kind === 'tool') {
      if (previous?.tools && previous.tools.at(-1)?.runId === item.runId) previous.tools.push(item);
      else groups.push({ key: item.id, tools: [item] });
    } else groups.push({ key: item.id, message: item });
  }
  return groups.map(group => {
    const last = group.tools?.at(-1) ?? group.message!;
    const run = last.runId;
    const summary = run && run !== activeRun && lastItem.get(run) === last.id ? turnFiles?.get(run) : undefined;
    return <Fragment key={group.key}>
      {group.tools ? <ToolGroup items={group.tools}/> : <Message item={group.message!} conversation={conversation} onQuote={onQuote}/>}
      {summary && onOpenFile && <TurnFiles key={summary.runId} activePath={activeFile?.runId === summary.runId ? activeFile.path : undefined}
        limited={summary.limited} onOpen={(path, trigger) => onOpenFile(summary.runId, path, trigger)}
        files={summary.paths.map(path => ({ path, unavailable: workspaceUnavailable || unavailableFiles?.has(JSON.stringify([summary.runId, path])) }))}/>}
    </Fragment>;
  });
});

export function FilePicker({ conversation, onSelect, onClose }: { conversation: string; onSelect(ref: MessageReference): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [directory, setDirectory] = useState('');
  const [files, setFiles] = useState<{ name: string; path: string; directory: boolean }[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => { const controller = new AbortController(); setError(''); setFiles([]); void fetch(`/api/private/workbench/conversations/${conversation}/files?directory=${encodeURIComponent(directory)}`, { signal: controller.signal }).then(async r => { if (!r.ok) throw Error(); const value = await r.json(); setFiles(value.files); }).catch(() => { if (!controller.signal.aborted) setError('无法读取这个目录，请重新选择。'); }); return () => controller.abort(); }, [directory, conversation]);
  return <dialog ref={dialog} className="file-picker" onCancel={onClose}><header><h2>引用工作区文件</h2><button aria-label="关闭文件选择" onClick={onClose}><X size={18}/></button></header><p>Agent 读取时使用原文件的实际内容。</p><button className="file-parent" disabled={!directory} onClick={() => setDirectory(directory.split('/').slice(0,-1).join('/'))}>{directory ? '← ' + directory : '工作区'}</button>{error && <p role="alert">{error}</p>}<div className="file-list">{files.map(file => <button key={file.path} onClick={() => { if (file.directory) setDirectory(file.path); else { onSelect({ type: 'file', path: file.path }); onClose(); } }}><FileText size={16}/>{file.name}{file.directory && <span>›</span>}</button>)}</div></dialog>;
}

import { lazy, Suspense, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Copy, FileText, Quote, Terminal, X, ImageIcon } from 'lucide-react';
import type { TurnFileSummary, WorkbenchItem } from '../shared/workbench.ts';
import type { MessageReference, ImageAttachment } from '../shared/content.ts';
import { referenceSchema } from '../shared/content.ts';
import { ConversationTurnFiles } from './conversation-turn-files.tsx';
import { BodyLink } from './body-reader.tsx';
import { directoryFilesSchema, directoryProgress, useDirectoryPage } from './directory-client.ts';
import { DirectoryControls, DirectoryStart } from './directory-controls.tsx';
import { request } from './workbench-client.ts';
const RichMessage = lazy(() => import('./rich-message.tsx'));

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
  const richPreview = !item.previewOnly && item.status !== 'running' && !item.bodies?.text && item.text.length <= 4096 &&
    (item.text.match(/[\n|*_\[\]{}<>`]/g)?.length ?? 0) <= 80;
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
    <div className="message-text">{item.kind === 'assistant' && richPreview ? <Suspense fallback={<pre className="message-raw-preview">{item.text}</pre>}><RichMessage text={item.text} conversation={conversation} item={item.id} components={components} urlTransform={(url, key) => safeUrl(url) || (key === 'src' && imageSource(url) ? url : '')}/></Suspense> : <pre className="message-raw-preview">{item.text || (item.status === 'running' ? '正在生成…' : '')}</pre>}</div>
    {item.bodies?.text && <BodyLink conversation={conversation} item={item.id} field="text" reference={item.bodies.text}/>}
    {item.bodies?.references && <BodyLink conversation={conversation} item={item.id} field="references" reference={item.bodies.references}/>}
    {item.previewOnly && <small className="quiet">实时预览，完整内容正在存档。</small>}
    {item.mediaPending && <small className="quiet">部分图片尚未存档，后台将继续重试。</small>}
    {item.images?.length ? <div className="message-images">{item.images.map(image => <ImageView key={image.id} src={imageUrl(conversation, image)} alt={image.name}/>)}</div> : null}
    {item.references?.length ? <div className="message-references">{item.references.map((reference, index) => <div key={index} className="reference-card">{reference.type === 'file' ? <><FileText size={14}/><span>{reference.path}<small>工作区原文件</small></span></> : <><Quote size={14}/><blockquote>{reference.text}<small>引用消息片段</small></blockquote></>}</div>)}</div> : null}
    {item.text && item.kind !== 'notice' && <div className="message-actions"><button type="button" aria-label={item.previewOnly || item.bodies?.text ? '复制当前预览' : '复制消息'} onClick={() => { void navigator.clipboard.writeText(item.text).then(() => { setCopied(true); setTimeout(() => setCopied(false),1500); }).catch(() => {}); }}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button><button type="button" aria-label="引用所选文字" onClick={quote}><Quote size={14}/></button></div>}
    {item.status === 'failed' && <small className="quiet">此项未完成</small>}
    {quoteHint && <small className="quiet" role="status">选中这条消息中的文字后，再点引用。</small>}
  </article>;
}

export function ToolGroup({ items, conversation }: { items: WorkbenchItem[]; conversation?: string }) {
  const running = items.some(i => i.status === 'running');
  const failed = items.filter(i => i.status === 'failed').length;
  const summary = running ? '正在执行' : failed ? `执行结束 · ${failed} 项未完成` : '已完成';
  return <details className={`tool-group ${running ? 'is-running' : ''}`}><summary><span className="activity-dot"/>{summary}<span className="activity-count">{items.length} 项操作</span><ChevronDown size={14}/></summary><div className="tool-timeline">{items.map(item => <details key={item.id} className="tool-message"><summary><Terminal size={14}/><span>{item.tool?.name ?? '工具执行'}</span><small>{item.status === 'running' ? '进行中' : item.status === 'failed' ? '未完成' : '已完成'}</small></summary>{item.tool?.input && <pre className="tool-input">{item.tool.input}</pre>}<pre>{item.tool?.output || item.text || '暂无输出'}</pre>
    {item.previewOnly && <small className="quiet">实时预览，完整内容正在存档。</small>}
    {item.mediaPending && <small className="quiet">部分图片尚未存档，后台将继续重试。</small>}
    {conversation && (['text', 'input', 'output'] as const).map(field => item.bodies?.[field] && <BodyLink key={field} conversation={conversation} item={item.id} field={field} reference={item.bodies[field]}/>)}</details>)}</div></details>;
}

function TranscriptRow({ id, children }: { id: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const measured = useRef(240);
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    const node = root.current; if (!node) return;
    const scroller = node.closest('.message-scroll');
    const observer = new IntersectionObserver(entries => {
      const entry = entries[0]; if (entry) setVisible(entry.isIntersecting);
    }, { root: scroller, rootMargin: '400px 0px' });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = root.current; if (!node || !visible) return;
    const observer = new ResizeObserver(() => {
      const height = node.getBoundingClientRect().height;
      const scroller = node.closest<HTMLElement>('.message-scroll');
      const wasAtBottom = scroller && scroller.scrollHeight - height + measured.current - scroller.scrollTop - scroller.clientHeight < 80;
      measured.current = height;
      if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(node); return () => observer.disconnect();
  }, [visible]);
  return <div ref={root} className="transcript-row" data-message-id={id} tabIndex={-1} onFocus={() => setVisible(true)}
    style={visible ? undefined : { height: measured.current }} aria-hidden={visible ? undefined : true}>{visible ? children : null}</div>;
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
    return <TranscriptRow key={group.key} id={group.key}>
      {group.tools ? <ToolGroup items={group.tools} conversation={conversation}/> : <Message item={group.message!} conversation={conversation} onQuote={onQuote}/>}
      {summary && onOpenFile && <ConversationTurnFiles key={summary.runId} conversation={conversation} summary={summary}
        activePath={activeFile?.runId === summary.runId ? activeFile.path : undefined} workspaceUnavailable={workspaceUnavailable} unavailable={unavailableFiles}
        onOpen={(path, trigger) => onOpenFile(summary.runId, path, trigger)}/>}
    </TranscriptRow>;
  });
});

export function FilePicker({ conversation, onSelect, onClose }: { conversation: string; onSelect(ref: MessageReference): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [directory, setDirectory] = useState('');
  const page = useDirectoryPage(JSON.stringify([conversation, directory]), ({ cursor, refresh, signal }) => {
    const query = new URLSearchParams({ directory, ...(cursor ? { cursor } : {}), ...(refresh ? { refresh: '1' } : {}) });
    return request(`/conversations/${encodeURIComponent(conversation)}/files?${query}`, directoryFilesSchema, { signal });
  });
  const files = page.data?.files ?? [];
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="file-picker" onCancel={onClose}><header><h2>引用工作区文件</h2><button aria-label="关闭文件选择" onClick={onClose}><X size={18}/></button></header><p>Agent 读取时使用原文件的实际内容。</p><button className="file-parent" disabled={!directory} onClick={() => setDirectory(directory.split('/').slice(0,-1).join('/'))}>{directory ? '← ' + directory : '工作区'}</button>
    {(page.error || page.notice || directoryProgress(page.data)) && <p role="status">{page.error || page.notice || directoryProgress(page.data)}</p>}
    <div className="file-list" aria-busy={page.pending}><DirectoryStart {...page}/>{files.map(file => <button key={file.path} data-scroll-row onClick={() => { if (file.directory) setDirectory(file.path); else { onSelect({ type: 'file', path: file.path }); onClose(); } }}><FileText size={16}/>{file.name}{file.directory && <span>›</span>}</button>)}
      <DirectoryControls label="引用文件" {...page}/>
    </div>
  </dialog>;
}

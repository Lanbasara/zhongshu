import { Fragment, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import { code } from '@streamdown/code';
import { cjk } from '@streamdown/cjk';
import { Check, ClipboardList, Clock, Copy, FileText, Info, Quote, X, ImageIcon } from 'lucide-react';
import type { TurnFileSummary, WorkbenchItem } from '../shared/workbench.ts';
import type { MessageReference, ImageAttachment } from '../shared/content.ts';
import { referenceSchema } from '../shared/content.ts';
import { markedWorkspacePath, workspaceImages, workspaceLinks } from './markdown.ts';
import { TurnFiles } from './patterns/turn-files.tsx';
import { ProcessBlock, type ProcessRunState } from './patterns/process.tsx';
import { AutomationTitles, deliveredReminders } from './automation-delivery.ts';
import './patterns/plan.css';

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
/** Keep safe external links and workspace links; anything else becomes plain text. */
const linkUrl = (url: string) => safeUrl(url) || (markedWorkspacePath(url) !== undefined ? url : '');
const markdownComponents = {
  // Without a place to open it, a workspace link reads as its text.
  a: ({ href, children }: React.ComponentProps<'a'>) => markedWorkspacePath(href ?? '') !== undefined ? <span className="message-file-name">{children}</span>
    : <a href={safeUrl(href ?? '') || undefined} target="_blank" rel="noopener noreferrer">{children}</a>,
};

const plainRemarkPlugins = [...Object.values(defaultRemarkPlugins), workspaceLinks];
/** Agent-written markdown outside the transcript (for example a plan under review): no raw HTML, safe links only, no workspace images. */
export function MarkdownText({ text }: { text: string }) {
  return <div className="message-text"><Streamdown plugins={{ code, cjk }} remarkPlugins={plainRemarkPlugins} components={markdownComponents} skipHtml urlTransform={(url, key) => key === 'href' ? linkUrl(url) : safeUrl(url)}>{text}</Streamdown></div>;
}

export function Message({ item, conversation, onQuote, onOpenLink }: {
  item: WorkbenchItem; conversation: string; onQuote(reference: MessageReference): void;
  /** Open a workspace file the message links to; without it such links read as text. */
  onOpenLink?(path: string, trigger: HTMLButtonElement): void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const [quoteHint, setQuoteHint] = useState(false);
  const titles = useContext(AutomationTitles);
  const reminders = useMemo(() => (item.automation ? deliveredReminders(item.text) : undefined), [item.automation, item.text]);
  // The explicit options also distinguish Streamdown's shared processor cache.
  const remarkPlugins = useMemo(() => [...Object.values(defaultRemarkPlugins), workspaceLinks, [workspaceImages, { conversation, item: item.id }] as [typeof workspaceImages, { conversation: string; item: string }]], [conversation, item.id]);
  const components = useMemo(() => ({ ...markdownComponents,
    a: ({ href, children }: React.ComponentProps<'a'>) => {
      const path = markedWorkspacePath(href ?? '');
      if (path === undefined || !onOpenLink) return markdownComponents.a({ href, children });
      return <button type="button" className="message-file-link" title={`在阅读器中打开 ${path}`} onClick={event => onOpenLink(path, event.currentTarget)}>{children}</button>;
    },
    img: ({ src, alt }: { src?: string; alt?: string }) => {
      const url = src && (safeUrl(src) || (imageSource(src) ? `/api/private/workbench/conversations/${conversation}/workspace-image?item=${encodeURIComponent(item.id)}&source=${encodeURIComponent(src)}` : ''));
      return url ? <ImageView src={url} alt={alt || '消息图片'}/> : <span>图片地址不可用</span>;
    },
  }), [conversation, item.id, onOpenLink]);
  function quote() {
    const selection = window.getSelection();
    const text = selection?.anchorNode && ref.current?.contains(selection.anchorNode) ? selection.toString() : '';
    if (text.trim()) onQuote({ type: 'quote', itemId: item.id, text: text.slice(0,8000) });
    else { setQuoteHint(true); setTimeout(() => setQuoteHint(false),3000); }
  }
  const actions = item.text && item.kind !== 'notice' && <div className="message-actions">
    <button type="button" aria-label="复制消息" title={copied ? '已复制' : '复制'} onClick={() => { void navigator.clipboard.writeText(item.text).then(() => { setCopied(true); setTimeout(() => setCopied(false),1500); }).catch(() => {}); }}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button>
    <button type="button" aria-label="引用所选文字" title="引用所选文字" onClick={quote}><Quote size={14}/></button>
  </div>;
  const body = <div className="message-text">{item.kind === 'assistant' ? <Streamdown plugins={{ code, cjk }} remarkPlugins={remarkPlugins} components={components} skipHtml urlTransform={(url, key) => key === 'href' ? linkUrl(url) : safeUrl(url) || (key === 'src' && imageSource(url) ? url : '')} isAnimating={item.status === 'running'}>{item.text || (item.status === 'running' ? '正在生成…' : '')}</Streamdown> : item.text}</div>;
  if (item.kind === 'assistant' && !item.text && item.status !== 'running' && !item.images?.length && !item.references?.length) return null;
  return <article ref={ref} tabIndex={-1} className={`message message-${item.kind}`} data-message-id={item.id} data-status={item.status}>
    {item.kind === 'notice' && <Info size={14} className="message-notice-icon" aria-hidden="true"/>}
    <div className="message-body">
      {item.kind === 'user' ? <div className={`message-bubble${item.automation ? ' message-automation' : ''}`}>
        {item.automation ? <>
          {reminders ? <>
            {reminders.map((reminder, index) => <Fragment key={index}>
              <div className="message-automation-label"><Clock size={12} aria-hidden="true"/>自动任务投递{titles.get(reminder.scheduleId) ? ` · ${titles.get(reminder.scheduleId)}` : ''}</div>
              <div className="message-text">{reminder.prompt}</div>
            </Fragment>)}
            <details className="message-automation-raw"><summary>原文</summary><pre>{item.text}</pre></details>
          </> : <>
            <div className="message-automation-label"><Clock size={12} aria-hidden="true"/>自动任务投递</div>
            <div className="message-text">{item.text}</div>
          </>}
        </> : <div className="message-text">{item.text}</div>}
        {item.images?.length ? <div className="message-images">{item.images.map(image => <ImageView key={image.id} src={imageUrl(conversation, image)} alt={image.name}/>)}</div> : null}
        {item.references?.length ? <div className="message-references">{item.references.map((reference, index) => <div key={index} className="reference-card">{reference.type === 'file' ? <><FileText size={14}/><span>{reference.path}<small>工作区原文件</small></span></> : <><Quote size={14}/><blockquote>{reference.text}<small>引用消息片段</small></blockquote></>}</div>)}</div> : null}
      </div> : <>
        {item.plan ? <div className="message-plan"><div className="message-plan-head"><ClipboardList size={13} aria-hidden="true"/>计划</div>{body}</div> : body}
        {item.images?.length ? <div className="message-images">{item.images.map(image => <ImageView key={image.id} src={imageUrl(conversation, image)} alt={image.name}/>)}</div> : null}
        {item.references?.length ? <div className="message-references">{item.references.map((reference, index) => <div key={index} className="reference-card">{reference.type === 'file' ? <><FileText size={14}/><span>{reference.path}<small>工作区原文件</small></span></> : <><Quote size={14}/><blockquote>{reference.text}<small>引用消息片段</small></blockquote></>}</div>)}</div> : null}
      </>}
      {item.status === 'failed' && <small className="message-state">此项未完成</small>}
      {item.status === 'unknown' && <small className="message-state">原生状态未提供</small>}
      {quoteHint && <small className="message-state" role="status">选中这条消息中的文字后，再点引用。</small>}
      {item.status !== 'running' && actions}
    </div>
  </article>;
}

/**
 * Tool records of one native turn, shown as the process block. Records with nothing to show take no space.
 * `runState` is the native turn's own terminal/active state when the workbench can verify it; without it the
 * block reports the steps as facts and never concludes that the whole turn failed.
 */
export function ToolGroup({ items, runState, lastOfRun }: { items: WorkbenchItem[]; runState?: ProcessRunState; lastOfRun?: boolean }) {
  const steps = items.filter(item => item.tool?.name || item.tool?.input || item.tool?.output || item.text.trim() || item.status !== 'completed')
    .map(item => ({ id: item.id, name: item.tool?.name || '工具执行', status: item.status,
      ...(item.tool?.input ? { input: item.tool.input } : {}), ...(item.tool?.output || item.text ? { output: item.tool?.output || item.text } : {}),
      ...(item.tool?.exitCode !== undefined ? { exitCode: item.tool.exitCode } : {}) }));
  if (!steps.length) return null;
  return <ProcessBlock steps={steps} {...(runState ? { runState } : {})} lastOfRun={lastOfRun} anchor={items[0]?.id}/>;
}

/** Group tools without reordering text or merging actions from separate native turns. */
export const Transcript = memo(function Transcript({ items, conversation, onQuote, turnFiles, activeRun, activeFile, unavailableFiles, workspaceUnavailable, onOpenFile, onOpenLink, renderCollaboration, runState }: {
  items: WorkbenchItem[]; conversation: string; onQuote(reference: MessageReference): void;
  turnFiles?: ReadonlyMap<string, TurnFileSummary>; activeRun?: string; activeFile?: { runId: string; path: string };
  unavailableFiles?: ReadonlySet<string>; workspaceUnavailable?: boolean;
  onOpenFile?(runId: string, path: string, trigger: HTMLButtonElement): void;
  /** A workspace file linked from a message body. */
  onOpenLink?(path: string, trigger: HTMLButtonElement): void;
  /** Native collaboration records render as compact cards; adjacent records of one action and turn share a card. */
  renderCollaboration?(items: WorkbenchItem[]): ReactNode;
  /** The verified state of a native turn, keyed by runId. Omitted for sub-agent history: there only steps are facts. */
  runState?(runId: string): ProcessRunState | undefined;
}) {
  const groups: { key: string; tools?: WorkbenchItem[]; message?: WorkbenchItem; collaboration?: WorkbenchItem[] }[] = [];
  const lastItem = new Map<string, string>();
  for (const item of items) {
    if (item.runId) lastItem.set(item.runId, item.id);
    const previous = groups.at(-1);
    if (item.collaboration && renderCollaboration) {
      const last = previous?.collaboration?.at(-1);
      if (last && last.runId === item.runId && last.collaboration!.action === item.collaboration.action) previous!.collaboration!.push(item);
      else groups.push({ key: item.id, collaboration: [item] });
    } else if (item.kind === 'tool') {
      if (previous?.tools && previous.tools.at(-1)?.runId === item.runId) previous.tools.push(item);
      else groups.push({ key: item.id, tools: [item] });
    } else groups.push({ key: item.id, message: item });
  }
  // Only the last tool group of a native turn carries the turn's terminal conclusion, so a run says it once.
  const lastToolGroup = new Map<string, string>();
  for (const group of groups) {
    const run = group.tools?.at(-1)?.runId;
    if (run !== undefined) lastToolGroup.set(run, group.key);
  }
  return groups.map(group => {
    const last = group.tools?.at(-1) ?? group.collaboration?.at(-1) ?? group.message!;
    const run = last.runId;
    const summary = run && run !== activeRun && lastItem.get(run) === last.id ? turnFiles?.get(run) : undefined;
    const native = group.tools && run !== undefined ? runState?.(run) : undefined;
    return <Fragment key={group.key}>
      {group.collaboration ? renderCollaboration!(group.collaboration) : group.tools ? <ToolGroup items={group.tools} {...(native ? { runState: native } : {})} lastOfRun={run !== undefined && lastToolGroup.get(run) === group.key}/> : <Message item={group.message!} conversation={conversation} onQuote={onQuote} {...(onOpenLink ? { onOpenLink } : {})}/>}
      {summary && onOpenFile && <TurnFiles key={summary.runId} activePath={activeFile?.runId === summary.runId ? activeFile.path : undefined}
        limited={summary.limited} onOpen={(path, trigger) => onOpenFile(summary.runId, path, trigger)}
        files={summary.paths.map(path => ({ path, unavailable: workspaceUnavailable || unavailableFiles?.has(JSON.stringify([summary.runId, path])) }))}/>}
    </Fragment>;
  });
});

export function FilePicker({ conversation, draftScope, onSelect, onClose }: { conversation?: string; draftScope?: {workspaceId: string; harnessId: string}; onSelect(ref: MessageReference): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [directory, setDirectory] = useState('');
  const [files, setFiles] = useState<{ name: string; path: string; directory: boolean }[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => { const controller = new AbortController(); setError(''); setFiles([]); void fetch(draftScope ? `/api/private/workbench/draft-files?workspaceId=${encodeURIComponent(draftScope.workspaceId)}&harnessId=${encodeURIComponent(draftScope.harnessId)}&directory=${encodeURIComponent(directory)}` : `/api/private/workbench/conversations/${conversation}/files?directory=${encodeURIComponent(directory)}`, { signal: controller.signal }).then(async r => { if (!r.ok) throw Error(); const value = await r.json(); setFiles(value.files); }).catch(() => { if (!controller.signal.aborted) setError('无法读取这个目录，请重新选择。'); }); return () => controller.abort(); }, [directory, conversation, draftScope?.workspaceId, draftScope?.harnessId]);
  return <dialog ref={dialog} className="file-picker" onCancel={onClose}><header><h2>引用工作区文件</h2><button aria-label="关闭文件选择" onClick={onClose}><X size={18}/></button></header><p>Agent 读取时使用原文件的实际内容。</p><button className="file-parent" disabled={!directory} onClick={() => setDirectory(directory.split('/').slice(0,-1).join('/'))}>{directory ? '← ' + directory : '工作区'}</button>{error && <p role="alert">{error}</p>}<div className="file-list">{files.map(file => <button key={file.path} onClick={() => { if (file.directory) setDirectory(file.path); else { onSelect({ type: 'file', path: file.path }); onClose(); } }}><FileText size={16}/>{file.name}{file.directory && <span>›</span>}</button>)}</div></dialog>;
}

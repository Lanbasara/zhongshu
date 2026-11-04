import { useEffect, useRef, useState } from 'react';
import { Copy, Download, X } from 'lucide-react';
import type { BodyReference } from '../shared/content.ts';
import { Button } from './ui/controls.tsx';
import './body-reader.css';

const chunkBytes = 64 * 1024;
type Target = { conversation: string; item: string; field: 'text' | 'input' | 'output' | 'references'; reference: BodyReference };
function bodyUrl(target: Target, offset: number, download = false) {
  const query = new URLSearchParams({ item: target.item, field: target.field, version: target.reference.version,
    bytes: String(target.reference.bytes), offset: String(offset), ...(download ? { download: '1' } : {}) });
  return `/api/private/workbench/conversations/${encodeURIComponent(target.conversation)}/body?${query}`;
}
async function chunk(target: Target, offset: number, signal: AbortSignal) {
  const response = await fetch(bodyUrl(target, offset), { signal, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('body_unavailable');
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength !== Math.min(chunkBytes, target.reference.bytes - offset)) throw new Error('body_incomplete');
  return data;
}

/** Raw text paging avoids constructing Markdown/code/table trees for giant replies. */
export function BodyReader({ target, onClose }: { target: Target; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(0);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyingRequest = useRef<AbortController | null>(null);
  const pages = Math.max(1, Math.ceil(target.reference.bytes / chunkBytes));
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => { node?.close(); copyingRequest.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setText('');
    void (async () => {
      let data = await chunk(target, page * chunkBytes, controller.signal);
      // A UTF-8 character split across two physical chunks belongs to the later
      // reading page. Keep at most the previous chunk's final three bytes.
      if (page && (data[0]! & 0xc0) === 0x80) {
        const previous = await chunk(target, (page - 1) * chunkBytes, controller.signal);
        let start = previous.length - 1;
        while (start > previous.length - 4 && (previous[start]! & 0xc0) === 0x80) start--;
        const joined = new Uint8Array(previous.length - start + data.length);
        joined.set(previous.subarray(start)); joined.set(data, previous.length - start); data = joined;
      }
      const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data, { stream: page + 1 < pages });
      if (!controller.signal.aborted) setText(value);
    })().catch(() => { if (!controller.signal.aborted) setError('正文暂时无法读取，请重试。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [target.conversation, target.item, target.field, target.reference.version, target.reference.bytes, page, pages, retry]);
  function copy() {
    if (copying) { copyingRequest.current?.abort(); return; }
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') { setError('此浏览器不支持全文复制，可使用下载全文保存。'); return; }
    const controller = new AbortController(); copyingRequest.current = controller; setCopying(true); setCopied(false); setError('');
    // Clipboard APIs require the complete representation. Only this explicit
    // gesture materializes it; ordinary reading and download stay bounded.
    const data = (async () => {
      const parts: BlobPart[] = [];
      for (let offset = 0; offset < target.reference.bytes; offset += chunkBytes) {
        const bytes = await chunk(target, offset, controller.signal); parts.push(bytes as Uint8Array<ArrayBuffer>);
      }
      return new Blob(parts, { type: 'text/plain' });
    })();
    void (async () => {
      try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': data })]); setCopied(true); }
      catch { controller.abort(); setError('未能复制全文，可使用下载全文保存。'); }
      finally { if (copyingRequest.current === controller) { copyingRequest.current = null; setCopying(false); } }
    })();
    void data.catch(() => {});
  }
  return <dialog ref={dialog} className="body-reader" onCancel={onClose} aria-labelledby="body-reader-title">
    <header><h2 id="body-reader-title">完整正文</h2><Button variant="quiet" aria-label="关闭完整正文" onClick={onClose}><X size={18}/></Button></header>
    <div className="body-reader-actions"><Button onClick={copy}><Copy size={14}/>{copying ? '取消复制' : copied ? '已复制全文' : '复制全文'}</Button>
      <a className="zs-button zs-button-secondary" href={bodyUrl(target, 0, true)} download="conversation-message.txt"><Download size={14}/>下载全文</a></div>
    <nav aria-label="正文分页"><Button disabled={!page || loading} onClick={() => setPage(page - 1)}>上一页</Button><span aria-live="polite">{page + 1} / {pages}</span><Button disabled={page + 1 >= pages || loading} onClick={() => setPage(page + 1)}>下一页</Button></nav>
    {error && <p role="alert">{error}{!text && <Button variant="quiet" onClick={() => setRetry(value => value + 1)}>重试读取</Button>}</p>}
    {loading ? <p role="status">正在读取正文…</p> : <pre tabIndex={0}>{text}</pre>}
  </dialog>;
}

export function BodyLink({ conversation, item, field, reference }: Target) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return <><Button variant="quiet" className="body-preview-link" onClick={event => { trigger.current = event.currentTarget; setOpen(true); }}>阅读完整{field === 'input' ? '输入' : field === 'output' ? '输出' : field === 'references' ? '引用' : '正文'} · {Math.ceil(reference.bytes / 1024).toLocaleString()} KB</Button>
    {open && <BodyReader target={{ conversation, item, field, reference }} onClose={() => { setOpen(false); queueMicrotask(() => { if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); }); }}/>}</>;
}

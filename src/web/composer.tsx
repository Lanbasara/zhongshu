import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, AtSign, FileText, ImagePlus, LoaderCircle, Quote, RotateCcw, ShieldCheck, Square, X } from 'lucide-react';
import type { Draft } from './workbench-client.ts';
import { imageSchema } from '../shared/content.ts';
import { imageUrl } from './conversation-content.tsx';
import { putUpload, removeUpload, uploadDrafts, type UploadDraft } from './upload-drafts.ts';

type Props = { conversation: string; csrf: string; draft: Draft; onChange(draft: Draft, requireDurable?: boolean): boolean; onSend(): void; onStop(): void; onFiles(): void; ready: boolean; sending: boolean; running: boolean; model: string };
type Upload = UploadDraft & { status: 'uploading' | 'failed' };
export function Composer(props: Props) {
  const { conversation, csrf, draft, onChange, onSend, onStop, onFiles, ready, sending, running, model } = props;
  const current = useRef(draft); current.current = draft;
  const change = (next: Draft, requireDurable = false) => { const saved = onChange(next, requireDurable); if (!saved && requireDurable) return false; current.current = next; return saved; };
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  useEffect(() => { alive.current = true; void uploadDrafts(conversation).then(items => { if (alive.current) setUploads(items.map(item => ({ ...item, status: 'failed' }))); }).catch(() => { if (alive.current) setError('无法恢复待上传图片，请检查浏览器存储。'); }); return () => { alive.current = false; }; }, [conversation]);
  useLayoutEffect(() => { const el = textarea.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight,220) + 'px'; } }, [draft.text]);
  async function upload(item: UploadDraft) {
    setUploads(old => old.map(u => u.id === item.id ? { ...u, status: 'uploading' } : u));
    try {
      const data = await new Promise<string>((resolve,reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]!); r.onerror = () => reject(Error()); r.readAsDataURL(item.file); });
      const response = await fetch(`/api/private/workbench/conversations/${conversation}/resources`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ name: item.file.name.slice(0,120) || '图片', data }), signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw Error('upload_failed');
      const image = imageSchema.parse(await response.json());
      // This component is keyed by conversation: late uploads never enter another draft.
      if (!alive.current) return;
      if (!change({ ...current.current, images: [...(current.current.images ?? []), image] }, true)) throw Error('draft_storage_failed');
      await removeUpload(item.id);
      setUploads(old => old.filter(u => u.id !== item.id));
    } catch { if (alive.current) { setUploads(old => old.map(u => u.id === item.id ? { ...u, status: 'failed' } : u)); setError('图片上传失败，文件已保留；可以重试或移除。'); } }
  }
  async function add(files: File[]) {
    if (draft.pending || sending) return;
    setError('');
    if ((current.current.images?.length ?? 0) + uploads.length + files.length > 4) { setError('每条消息最多添加 4 张图片。'); return; }
    for (const file of files) {
      if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { setError('请选择 2 MiB 以内的 PNG、JPEG 或 WebP 图片。'); continue; }
      const item = { id: crypto.randomUUID(), conversation, file };
      try { await putUpload(item); } catch { setError('无法保留待上传图片，本次没有上传。'); continue; }
      setUploads(old => [...old, { ...item, status: 'uploading' }]);
      await upload(item);
    }
  }
  const hasContent = draft.text.trim() || draft.images?.length || draft.references?.length;
  const disabled = sending || (!ready && !draft.pending) || !hasContent || uploads.length > 0;
  return <form className={`composer ${dragging ? 'is-dragging' : ''}`} onSubmit={e => { e.preventDefault(); if (!disabled) onSend(); }} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); void add([...e.dataTransfer.files]); }}>
    {(draft.images?.length || uploads.length) ? <div className="attachment-tray">{draft.images?.map(image => <div className="attachment-card" key={image.id}><img src={imageUrl(conversation,image)} alt={image.name}/><span>{image.name}<small>已准备好</small></span><button type="button" aria-label={`移除图片：${image.name}`} disabled={!!draft.pending} onClick={() => { change({ ...draft, images: draft.images?.filter(i => i.id !== image.id) }); }}><X size={14}/></button></div>)}{uploads.map(item => <div className="attachment-card upload-card" key={item.id}><ImagePlus size={22}/><span>{item.file.name}<small>{item.status === 'failed' ? '上传失败 · 已保留' : '正在上传…'}</small></span>{item.status === 'failed' ? <><button type="button" aria-label={`重试上传：${item.file.name}`} onClick={() => void upload(item)}><RotateCcw size={14}/></button><button type="button" aria-label={`移除待上传图片：${item.file.name}`} onClick={() => { void removeUpload(item.id).then(() => setUploads(old => old.filter(u => u.id !== item.id))).catch(() => setError('无法移除待上传图片。')); }}><X size={14}/></button></> : <LoaderCircle size={16} className="spin"/>}</div>)}</div> : null}
    {draft.references?.length ? <div className="composer-references">{draft.references.map((r,index) => <div className="reference-card" key={index}>{r.type === 'file' ? <FileText size={15}/> : <Quote size={15}/>}<span>{r.type === 'file' ? r.path : r.text}<small>{r.type === 'file' ? '工作区原文件' : '消息选段'}</small></span><button type="button" aria-label="移除引用" disabled={!!draft.pending} onClick={() => change({ ...draft, references: draft.references?.filter((_,i) => i !== index) })}><X size={14}/></button></div>)}</div> : null}
    <label className="sr-only" htmlFor="message">给 Agent 的消息</label><textarea ref={textarea} id="message" name="message" rows={2} value={draft.text} disabled={!!draft.pending} maxLength={16000} placeholder="说说你想做什么，或粘贴一张图片…" onChange={e => { change({ ...draft, text: e.target.value }); if (e.target.value.endsWith('@') && (draft.references?.length ?? 0) < 8) onFiles(); }} onPaste={e => { const files = [...e.clipboardData.items].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter((f): f is File => !!f); if (files.length) { e.preventDefault(); void add(files); } }} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); if (!disabled) onSend(); } }}/>
    {error && <p className="upload-error" role="alert">{error}</p>}
    <div className="composer-actions"><div className="composer-tools"><input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e => { void add([...e.target.files ?? []]); e.target.value = ''; }}/><button type="button" aria-label="添加图片" title="上传图片，也可粘贴或拖放" disabled={!!draft.pending || sending} onClick={() => picker.current?.click()}><ImagePlus size={19}/></button><button type="button" aria-label="引用工作区文件" title="引用工作区原文件" disabled={!!draft.pending || (draft.references?.length ?? 0) >= 8} onClick={onFiles}><AtSign size={19}/></button><span className="composer-permission"><ShieldCheck size={13}/>配置已固定</span></div><div className="composer-submit"><span className="composer-model" title={model}>{model}</span>{running ? <button className="send-button stop-button" type="button" aria-label="停止当前轮" disabled={sending} onClick={onStop}><Square size={15} fill="currentColor"/></button> : <button className="send-button" type="submit" aria-label="发送消息" disabled={disabled}>{sending ? <LoaderCircle size={18} className="spin"/> : <ArrowUp size={21}/>}</button>}</div></div>
  </form>;
}

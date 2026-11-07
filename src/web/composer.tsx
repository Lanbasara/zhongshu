import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FileText, ImagePlus, LoaderCircle, Quote, RotateCcw, X } from 'lucide-react';
import { request, type Draft } from './workbench-client.ts';
import { imageSchema, skillCatalogSchema, skillLabelText, skillLimit, type SkillReference } from '../shared/content.ts';
import type { ConversationUsage } from '../shared/workbench.ts';
import { imageUrl } from './conversation-content.tsx';
import { putUpload, removeUpload, uploadDrafts, type UploadDraft } from './upload-drafts.ts';

import { ComposerView } from './patterns/composer.tsx';
import { ComposerUsage, SkillEditor } from './patterns/composer-extras.tsx';

type Props = { conversation: string; csrf: string; draft: Draft; onChange(draft: Draft, requireDurable?: boolean): boolean; onSend(): void; onStop(): void; onFiles(): void; ready: boolean; sending: boolean; running: boolean; queueing: boolean; queue?: ReactNode; model: string; reasoningEffort?: string; agentPreset?: string; permission: string; configurationNote: string; skillsEnabled: boolean; usage?: ConversationUsage; toolbarExtras?: ReactNode };
type Upload = UploadDraft & { status: 'uploading' | 'failed' };
export function Composer(props: Props) {
  const { conversation, csrf, draft, onChange, onSend, onStop, onFiles, ready, sending, running, queueing, queue, model, reasoningEffort, permission, configurationNote } = props;
  const current = useRef(draft); current.current = draft;
  const change = (next: Draft, requireDurable = false) => { const saved = onChange(next, requireDurable); if (!saved && requireDurable) return false; current.current = next; return saved; };
  const loadSkills = useCallback(async (signal: AbortSignal) => (await request(`/conversations/${conversation}/skills`, skillCatalogSchema, { signal })).skills, [conversation]);
  function edit(text: string, skills: SkillReference[]) {
    const previous = current.current;
    change({ ...previous, text, skills: skills.length ? skills : undefined });
    if (text.endsWith('@') && !previous.text.endsWith('@') && (previous.references?.length ?? 0) < 8) onFiles();
  }
  const alive = useRef(true);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { alive.current = true; void uploadDrafts(conversation).then(items => { if (alive.current) setUploads(items.map(item => ({ ...item, status: 'failed' }))); }).catch(() => { if (alive.current) setError('无法恢复待上传图片，请检查浏览器存储。'); }); return () => { alive.current = false; }; }, [conversation]);
  async function upload(item: UploadDraft) {
    setUploads(old => old.map(u => u.id === item.id ? { ...u, status: 'uploading' } : u));
    try {
      const data = await new Promise<string>((resolve,reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]!); r.onerror = () => reject(Error()); r.readAsDataURL(item.file); });
      const response = await fetch(`/api/private/workbench/conversations/${conversation}/resources`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ name: item.file.name.slice(0,120) || '图片', data }), signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw Error(response.status === 507 ? 'storage_budget_reached' : 'upload_failed');
      const image = imageSchema.parse(await response.json());
      // This component is keyed by conversation: late uploads never enter another draft.
      if (!alive.current) return;
      if (!change({ ...current.current, images: [...(current.current.images ?? []), image] }, true)) throw Error('draft_storage_failed');
      await removeUpload(item.id);
      setUploads(old => old.filter(u => u.id !== item.id));
    } catch (reason) { if (alive.current) { setUploads(old => old.map(u => u.id === item.id ? { ...u, status: 'failed' } : u)); setError(reason instanceof Error && reason.message === 'storage_budget_reached' ? '存储已达到预算上限，暂时不能上传图片；文件已保留。可以在「设置 › 存储」中清理。' : '图片上传失败，文件已保留；可以重试或移除。'); } }
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
  return <ComposerView value={draft.text} onChange={text => edit(text, [])}
    renderEditor={editor => <SkillEditor editor={editor} spans={draft.skills}
      picker={props.skillsEnabled ? { load: loadSkills, format: skillLabelText, limit: skillLimit } : undefined} onEdit={edit}/>}
    footerDetails={props.usage && <ComposerUsage usage={props.usage}/>} toolbarExtras={props.toolbarExtras}
    onSend={onSend} onStop={onStop} onFiles={onFiles} onImages={files => void add(files)}
    editDisabled={!!draft.pending} imagesDisabled={!!draft.pending || sending} filesDisabled={!!draft.pending || (draft.references?.length ?? 0) >= 8}
    sendDisabled={!!disabled} sending={sending} running={running} queueing={queueing} queue={queue} model={model} reasoningEffort={reasoningEffort} agentPreset={props.agentPreset} permission={permission} configurationNote={configurationNote}
    error={error} hasMaterials={!!(draft.images?.length || uploads.length || draft.references?.length)} materials={<>
    {(draft.images?.length || uploads.length) ? <div className="attachment-tray">{draft.images?.map(image => <div className="attachment-card" key={image.id}><img src={imageUrl(conversation,image)} alt={image.name}/><span>{image.name}<small>已准备好</small></span><button type="button" aria-label={`移除图片：${image.name}`} disabled={!!draft.pending} onClick={() => { change({ ...draft, images: draft.images?.filter(i => i.id !== image.id) }); }}><X size={14}/></button></div>)}{uploads.map(item => <div className="attachment-card upload-card" key={item.id}><ImagePlus size={22}/><span>{item.file.name}<small>{item.status === 'failed' ? '上传失败 · 已保留' : '正在上传…'}</small></span>{item.status === 'failed' ? <><button type="button" aria-label={`重试上传：${item.file.name}`} onClick={() => void upload(item)}><RotateCcw size={14}/></button><button type="button" aria-label={`移除待上传图片：${item.file.name}`} onClick={() => { void removeUpload(item.id).then(() => setUploads(old => old.filter(u => u.id !== item.id))).catch(() => setError('无法移除待上传图片。')); }}><X size={14}/></button></> : <LoaderCircle size={16} className="spin"/>}</div>)}</div> : null}
    {draft.references?.length ? <div className="composer-references">{draft.references.map((r,index) => <div className="reference-card" key={index}>{r.type === 'file' ? <FileText size={15}/> : <Quote size={15}/>}<span>{r.type === 'file' ? r.path : r.text}<small>{r.type === 'file' ? '工作区原文件' : '消息选段'}</small></span><button type="button" aria-label="移除引用" disabled={!!draft.pending} onClick={() => change({ ...draft, references: draft.references?.filter((_,i) => i !== index) })}><X size={14}/></button></div>)}</div> : null}
    </>}/>;
}

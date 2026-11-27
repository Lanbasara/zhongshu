import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FileText, ImagePlus, LoaderCircle, Quote, RotateCcw, X } from 'lucide-react';
import { request, RequestError, type Draft } from './workbench-client.ts';
import { skillCatalogSchema, skillLabelText, skillLimit, type SkillReference } from '../shared/content.ts';
import type { ConversationUsage } from '../shared/workbench.ts';
import { imageUrl } from './conversation-content.tsx';
import { removeUpload, trackImageWrite, uploadDrafts, type UploadDraft } from './upload-drafts.ts';

import { attachmentBytes, compressionLabel, imageUploadProblem, sendImage, stageImages, uploadImage } from './image-uploads.ts';

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
  const preparing = useRef(false);
  const [staging, setStaging] = useState(false);
  const [uploadsReady, setUploadsReady] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    alive.current = true;
    void uploadDrafts(conversation).then(items => {
      if (!alive.current) return;
      setUploads(items.map(item => ({ ...item, status: 'failed' })));
      setUploadsReady(true);
    }).catch(() => { if (alive.current) setError('无法恢复待上传图片，请检查浏览器存储。'); });
    return () => { alive.current = false; };
  }, [conversation]);
  async function upload(item: UploadDraft) {
    setUploads(old => old.map(u => u.id === item.id ? { ...u, status: 'uploading' } : u));
    try {
      const image = await uploadImage(conversation, csrf, item);
      // This component is keyed by conversation: late uploads never enter another draft.
      if (!alive.current) return;
      if (!change({ ...current.current, images: [...(current.current.images ?? []), image] }, true)) throw Error('draft_storage_failed');
      await removeUpload(item.id);
      setUploads(old => old.filter(u => u.id !== item.id));
    } catch (reason) {
      if (!alive.current) return;
      setUploads(old => old.map(u => u.id === item.id ? { ...u, status: 'failed' } : u));
      setError(reason instanceof RequestError && reason.code === 'storage_budget_reached'
        ? '存储已达到预算上限，暂时不能上传图片；文件已保留。可以在「设置 › 存储」中清理。'
        : '图片上传失败，文件已保留；可以重试或移除。');
    }
  }
  async function stage(work: () => Promise<void>) {
    if (preparing.current || !uploadsReady || current.current.pending || sending) return;
    preparing.current = true;
    setStaging(true);
    const finish = trackImageWrite(conversation);
    try { await work(); }
    finally { finish(); preparing.current = false; if (alive.current) setStaging(false); }
  }
  async function add(files: File[]) {
    await stage(async () => {
      const attached = current.current.images ?? [];
      const stagedBytes = uploads.reduce((bytes, item) => bytes + sendImage(item).size, attachmentBytes(attached));
      const { items, error } = await stageImages(conversation, files, attached.length + uploads.length, stagedBytes);
      if (!alive.current) return;
      setError(error);
      setUploads(old => [...old, ...items.map(item => ({ ...item, status: 'failed' as const }))]);
      for (const item of items) {
        if (!alive.current) return;
        if (!item.compressionFailed) await upload(item);
      }
    });
  }
  function retry(item: UploadDraft) {
    void stage(async () => {
      const problem = imageUploadProblem(uploads, attachmentBytes(current.current.images));
      setError(problem);
      if (!problem) await upload(item);
    });
  }
  function discard(item: UploadDraft) {
    void stage(async () => {
      try {
        await removeUpload(item.id);
        if (alive.current) {
          setUploads(old => old.filter(upload => upload.id !== item.id));
          setError('');
        }
      } catch { if (alive.current) setError('无法移除待上传图片。'); }
    });
  }
  const hasContent = draft.text.trim() || draft.images?.length || draft.references?.length;
  const disabled = sending || (!ready && !draft.pending) || !hasContent || !uploadsReady || staging || uploads.length > 0;
  return <ComposerView value={draft.text} onChange={text => edit(text, [])}
    renderEditor={editor => <SkillEditor editor={editor} spans={draft.skills}
      picker={props.skillsEnabled ? { load: loadSkills, format: skillLabelText, limit: skillLimit } : undefined} onEdit={edit}/>}
    footerDetails={props.usage && <ComposerUsage usage={props.usage}/>} toolbarExtras={props.toolbarExtras}
    onSend={onSend} onStop={onStop} onFiles={onFiles} onImages={files => void add(files)}
    editDisabled={!!draft.pending} imagesDisabled={!!draft.pending || sending || staging || !uploadsReady} filesDisabled={!!draft.pending || (draft.references?.length ?? 0) >= 8}
    sendDisabled={!!disabled} sending={sending} running={running} queueing={queueing} queue={queue} model={model} reasoningEffort={reasoningEffort} agentPreset={props.agentPreset} permission={permission} configurationNote={configurationNote}
    error={error || (staging ? '' : imageUploadProblem(uploads, attachmentBytes(draft.images)))} hasMaterials={!!(draft.images?.length || uploads.length || draft.references?.length)} materials={<>
    {(draft.images?.length || uploads.length) ? <div className="attachment-tray">
      {draft.images?.map(image => <div className="attachment-card" key={image.id}>
        <img src={imageUrl(conversation,image)} alt={image.name}/>
        <span>{image.name}<small>{image.originalByteSize && image.byteSize ? compressionLabel(image.originalByteSize, image.byteSize) : '已准备好'}</small></span>
        <button type="button" aria-label={`移除图片：${image.name}`} disabled={!!draft.pending || staging} onClick={() => {
          change({ ...draft, images: draft.images?.filter(i => i.id !== image.id) });
          setError('');
        }}><X size={14}/></button>
      </div>)}
      {uploads.map(item => <div className="attachment-card upload-card" key={item.id}>
        <ImagePlus size={22}/><span>{item.file.name}<small>{item.compressionFailed
          ? '无法压缩到限额内 · 原图已保留'
          : item.status === 'failed' ? '上传失败 · 已保留' : '正在上传…'}</small></span>
        {item.status === 'failed' ? <>
          {!item.compressionFailed && <button type="button" disabled={staging} aria-label={`重试上传：${item.file.name}`} onClick={() => retry(item)}><RotateCcw size={14}/></button>}
          <button type="button" disabled={staging} aria-label={`移除待上传图片：${item.file.name}`} onClick={() => discard(item)}><X size={14}/></button>
        </> : <LoaderCircle size={16} className="spin"/>}
      </div>)}
    </div> : null}
    {draft.references?.length ? <div className="composer-references">{draft.references.map((r,index) => <div className="reference-card" key={index}>{r.type === 'file' ? <FileText size={15}/> : <Quote size={15}/>}<span>{r.type === 'file' ? r.path : r.text}<small>{r.type === 'file' ? '工作区原文件' : '消息选段'}</small></span><button type="button" aria-label="移除引用" disabled={!!draft.pending} onClick={() => change({ ...draft, references: draft.references?.filter((_,i) => i !== index) })}><X size={14}/></button></div>)}</div> : null}
    </>}/>;
}

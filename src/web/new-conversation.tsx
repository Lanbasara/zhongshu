import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Folder, ImagePlus, X, FileText } from 'lucide-react';
import { configurationSchema, conversationSchema, conversationResponseSchema, snapshotSchema, operationResponseSchema, type WorkbenchConfiguration, type Conversation } from '../shared/workbench.ts';
import { imageSchema, skillCatalogSchema, skillLabelText, skillLimit, type SkillReference } from '../shared/content.ts';
import { ComposerView } from './patterns/composer.tsx';
import { SkillEditor } from './patterns/composer-extras.tsx';
import { DraftConfiguration } from './patterns/draft-configuration.tsx';
import { Button } from './ui/controls.tsx';
import { FilePicker } from './conversation-content.tsx';
import { request, RequestError, saveDraft } from './workbench-client.ts';
import { uploadDrafts, putUpload, removeUpload, type UploadDraft } from './upload-drafts.ts';
import { readNewDraft, saveNewDraft, emptyNewDraft, removeNewDraft, type NewDraft } from './new-conversation-state.ts';
import { readPreference, rememberConversation, initialConversationTitle } from './conversation-preferences.ts';
import { normalizeDraftPreference } from './conversation-configuration-label.ts';
import './new-conversation.css';
const draftSkillsSchema=z.discriminatedUnion('supported',[
  skillCatalogSchema.extend({supported:z.literal(true)}).strict(),
  z.object({supported:z.literal(false),skills:z.tuple([]),reason:z.literal('draft_skills_unavailable')}).strict(),
]);
// Remounting a workspace waits for its pending IndexedDB write before restoring.
const imageWrites=new Map<string,Promise<void>>();
function trackImageWrite(id:string){
  let finish!:()=>void;const pending=new Promise<void>(resolve=>{finish=resolve;});
  imageWrites.set(id,pending);
  return()=>{if(imageWrites.get(id)===pending)imageWrites.delete(id);finish();};
}
const defaultsSchema=z.object({conversation:conversationSchema.nullable()}).strict();
const preparationSchema=skillCatalogSchema.extend({preparationId:z.uuid()}).strict();
type Props={ configuration:WorkbenchConfiguration; initialWorkspace?:string; addedWorkspace?:string; csrf:string; onCreated(conversation:Conversation):void; onAddWorkspace():void; onWorkspace(workspace:string):void; report(error:unknown):void };
function StagedImage({item,disabled,onRemove}:{item:UploadDraft;disabled:boolean;onRemove():void}) {
  const [url,setUrl]=useState('');useEffect(()=>{const url=URL.createObjectURL(item.file);setUrl(url);return()=>URL.revokeObjectURL(url);},[item.file]);
  return <div className="attachment-card"><img src={url} alt={item.file.name}/><span>{item.file.name}<small>发送时上传</small></span><button type="button" aria-label={`移除图片：${item.file.name}`} disabled={disabled} onClick={onRemove}><X size={14}/></button></div>;
}
function initialConfig(catalog:WorkbenchConfiguration['harnesses'][number]|undefined) {
  const model=catalog?.models.find(m=>m.id===catalog.defaultModelId);
  return {modelId:model?.id??'',permissionId:'',...(model?.defaultReasoningEffort?{reasoningEffort:model.defaultReasoningEffort}:{})};
}
/** Local draft owns preparation; existing server operations still own execution/reconciliation. */
export function NewConversation(props:Props) {
  const [draft,setDraft]=useState<NewDraft>(()=>readNewDraft(props.initialWorkspace??'')??emptyNewDraft(props.initialWorkspace??''));
  const current=useRef(draft);current.current=draft;
  const [skillsSupported,setSkillsSupported]=useState<boolean|undefined>(undefined);
  const [preparationState,setPreparationState]=useState<'loading'|'ready'|'failed'|undefined>();
  const [preparationRetry,setPreparationRetry]=useState(0);
  const [preparationClaimed,setPreparationClaimed]=useState(false);
  const [initialized,setInitialized]=useState(false);const [uploads,setUploads]=useState<UploadDraft[]>([]);const [imagesReady,setImagesReady]=useState(false);
  const [busy,setBusy]=useState(false);const busyRef=useRef(false);
  const [staging,setStaging]=useState(false);const stagingRef=useRef(false);
  const awaitingWorkspace=useRef<{previous?:string}|undefined>(undefined);const [status,setStatus]=useState('');const [error,setError]=useState('');const [picking,setPicking]=useState(false);
  const alive=useRef(true);const controller=useRef<AbortController|undefined>(undefined);
  const persist=(next:NewDraft,required=false)=>{const ok=saveNewDraft(next);if(!ok)setError('浏览器无法保留草稿，请复制内容后检查浏览器存储。');if(ok||!required){current.current=next;setDraft(next);}return ok;};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
  useEffect(()=>{
    const abort=new AbortController();let cancelled=false;
    void (async()=>{
      const explicit=props.initialWorkspace??'';const existing=readNewDraft(explicit);
      if(existing){if(!cancelled){current.current=existing;setDraft(existing);setInitialized(true);}return;}
      let selected=readPreference(explicit||undefined);
      if(selected && !props.configuration.workspaces.some(w=>w.id===selected!.workspaceId))selected=undefined;
      if(!selected){try{const result=await request('/conversation-defaults'+(explicit?'?workspaceId='+encodeURIComponent(explicit):''),defaultsSchema,{signal:abort.signal});if(result.conversation)selected=result.conversation;}catch(reason){if(!abort.signal.aborted)props.report(reason);}}
      if(selected)selected=normalizeDraftPreference(selected,props.configuration.harnesses);
      const workspace=explicit||selected?.workspaceId||(props.configuration.workspaces.length===1?props.configuration.workspaces[0]!.id:'');
      const saved=readNewDraft(workspace);const next=saved??emptyNewDraft(workspace,selected);
      if(!selected&&!saved){const catalog=props.configuration.harnesses.find(h=>h.available);if(catalog){next.harnessId=catalog.id;next.configuration=initialConfig(catalog);}}
      if(!cancelled){persist(next);setInitialized(true);}
    })();return()=>{cancelled=true;abort.abort();};
  },[]);
  useEffect(()=>{let cancelled=false;setImagesReady(false);void (async()=>{await imageWrites.get(draft.id);return uploadDrafts(draft.id);})().then(items=>{if(!cancelled){setUploads(items);setImagesReady(true);}}).catch(()=>{if(!cancelled)setError('无法恢复图片暂存，请检查浏览器存储后刷新。');});return()=>{cancelled=true;};},[draft.id]);
  useEffect(()=>{
    const id=props.addedWorkspace;
    if(!initialized||!awaitingWorkspace.current||!id||id===awaitingWorkspace.current.previous||current.current.submission||!props.configuration.workspaces.some(w=>w.id===id))return;
    const previous=current.current;
    // Consume only this mounted page's add action; an old parent signal must not
    // move a subsequently opened workspace draft or overwrite its content.
    if(!persist({...previous,workspaceId:id},true))return;
    awaitingWorkspace.current=undefined;
    if(previous.workspaceId!==id)removeNewDraft(previous.workspaceId);
    props.onWorkspace(id);
  },[initialized,props.addedWorkspace,props.configuration.workspaces]);
  const workspace=props.configuration.workspaces.find(w=>w.id===draft.workspaceId);
  const catalog=props.configuration.harnesses.find(h=>h.id===draft.harnessId);
  const model=catalog?.models.find(m=>m.id===draft.configuration.modelId);
  const valid=!!workspace&&!!catalog?.available&&!!model&&catalog.permissions.some(p=>p.id===draft.configuration.permissionId)&&(!model.reasoningEfforts?.length||model.reasoningEfforts.some(e=>e.id===draft.configuration.reasoningEffort));
  const locked=busy||!!draft.submission;
  async function prepareDraft(value:NewDraft,signal:AbortSignal) {
    const result=await request('/draft-preparation',preparationSchema,{csrf:props.csrf,body:{workspaceId:value.workspaceId,harnessId:'dsh',...(value.preparationId?{preparationId:value.preparationId}:{})},signal});
    signal.throwIfAborted();
    const latest=current.current;
    if(!alive.current||latest.id!==value.id||latest.workspaceId!==value.workspaceId||latest.harnessId!=='dsh')throw new DOMException('Draft changed','AbortError');
    if(latest.preparationId&&latest.preparationId!==result.preparationId)throw Error('草稿准备身份已变化，请重新核对。');
    if(!persist({...latest,preparationId:result.preparationId},true))throw Error('无法保留准备编号，本次尚未发送。');
    setPreparationState('ready');setPreparationClaimed(false);setSkillsSupported(true);
    return result;
  }
  const loadSkills=useCallback(async(signal:AbortSignal)=>{
    if(draft.harnessId==='dsh')return (await prepareDraft(current.current,signal)).skills;
    const result=await request(`/draft-skills?workspaceId=${encodeURIComponent(draft.workspaceId)}&harnessId=${draft.harnessId}`,draftSkillsSchema,{signal});
    if(!result.supported)throw Error('当前 Power 首次发送后可选择技能。请先移除技能标记，再发送首条消息。');
    return result.skills;
  },[draft.workspaceId,draft.harnessId]);
  useEffect(()=>{
    const abort=new AbortController();setSkillsSupported(undefined);setPreparationState(undefined);setPreparationClaimed(false);
    if(!initialized||!workspace||!catalog?.available)return()=>abort.abort();
    if(current.current.submission)return()=>abort.abort();
    if(catalog.id==='dsh'){
      setPreparationState('loading');
      void prepareDraft(current.current,abort.signal).catch(reason=>{if(!abort.signal.aborted){setPreparationState('failed');setPreparationClaimed(reason instanceof RequestError&&reason.code==='draft_preparation_claimed');}});
      return()=>abort.abort();
    }
    void request(`/draft-skills?workspaceId=${encodeURIComponent(workspace.id)}&harnessId=${catalog.id}`,draftSkillsSchema,{signal:abort.signal})
      .then(result=>{if(!abort.signal.aborted)setSkillsSupported(result.supported);})
      .catch(reason=>{if(!abort.signal.aborted){setSkillsSupported(undefined);setError('暂时无法读取技能能力，请稍后重试。');props.report(reason);}});
    return()=>abort.abort();
  },[initialized,workspace?.id,catalog?.id,catalog?.available,preparationRetry]);
  const edit=(text:string,skills:SkillReference[])=>{if(!locked)persist({...current.current,text,skills:skills.length?skills:undefined});};
  async function addImages(files:File[]) {
    if(busyRef.current||stagingRef.current||current.current.submission||!imagesReady||!initialized)return;
    if(uploads.length+files.length>4){setError('每条消息最多添加 4 张图片。');return;}
    const owner=current.current;
    if(!persist(owner,true))return;
    stagingRef.current=true;setStaging(true);const finishWrite=trackImageWrite(owner.id);
    const added:UploadDraft[]=[];
    try {
      for(const file of files){
        if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>2*1024*1024){setError('请选择 2 MiB 以内的 PNG、JPEG 或 WebP 图片。');continue;}
        const item={id:crypto.randomUUID(),conversation:owner.id,file};
        try{await putUpload(item);added.push(item);}catch{if(alive.current)setError('无法暂存图片，本次未添加。');}
      }
      // Writes belong to the captured draft even if navigation unmounted it.
      // Its next mount recovers them from IndexedDB; never inject them into a
      // different draft or allow first-send to snapshot a partially staged set.
      if(alive.current&&current.current.id===owner.id)setUploads(old=>[...old,...added]);
    } finally {finishWrite();stagingRef.current=false;if(alive.current)setStaging(false);}
  }
  async function removeImage(id:string){
    if(busyRef.current||stagingRef.current||current.current.submission)return;
    const owner=current.current.id;stagingRef.current=true;setStaging(true);const finishWrite=trackImageWrite(owner);
    try{await removeUpload(id);if(alive.current&&current.current.id===owner)setUploads(old=>old.filter(i=>i.id!==id));}
    catch{if(alive.current)setError('无法移除图片，请重试。');}
    finally{finishWrite();stagingRef.current=false;if(alive.current)setStaging(false);}
  }
  async function confirmFirstSend(id:string,operationId:string,signal:AbortSignal) {
    setStatus('正在核对首条消息的接收结果…');
    const deadline=Date.now()+20000;
    do {
      const snapshot=await request(`/conversations/${id}/reconcile`,snapshotSchema,{csrf:props.csrf,body:{},signal});
      const operation=snapshot.operations.find(item=>item.id===operationId);
      if(operation?.status==='accepted'){await complete(snapshot.conversation);return;}
      if(operation?.status==='rejected'){setStatus('首条消息未被接受，原内容已保留。');return;}
      await new Promise(resolve=>setTimeout(resolve,1000));signal.throwIfAborted();
    } while(Date.now()<deadline);
    setStatus('发送结果仍待核对，原内容和发送编号已保留。');
  }
  async function send() {
    if(busyRef.current||stagingRef.current||!initialized||!imagesReady)return;
    let value=current.current;
    if(!value.submission&&(!valid||(!value.text.trim()&&!uploads.length&&!value.references?.length)))return;
    busyRef.current=true;setBusy(true);setError('');const abort=new AbortController();controller.current=abort;
    try {
      if(!value.submission){
        if(value.harnessId==='dsh'){
          setStatus('正在核对首发技能与原生准备…');
          await prepareDraft(value,abort.signal);
          value=current.current;
        }
        // Verify selected skills against this exact workspace and Power before freezing.
        if(value.skills?.length){const skills=await loadSkills(abort.signal);if(value.skills.some(s=>!skills.some(item=>item.id===s.id)))throw Error('所选技能在当前 Power 或工作区已不可用，请重新选择。');}
        value={...value,submission:{creation:{id:value.id,workspaceId:value.workspaceId,harnessId:value.harnessId,configuration:configurationSchema.parse(value.configuration),title:initialConversationTitle(value.text),...(value.harnessId==='dsh'&&value.preparationId?{preparationId:value.preparationId}:{})},operationId:crypto.randomUUID(),uploaded:{},dispatchStarted:false}};
        if(!persist(value,true))return;
      }
      const submission=value.submission!;
      setStatus('正在创建并核对对话…');
      await request('/conversations',conversationResponseSchema,{csrf:props.csrf,body:submission.creation,signal:abort.signal});
      let snapshot=await request(`/conversations/${value.id}`,snapshotSchema,{signal:abort.signal});
      const known=snapshot.operations.find(op=>op.id===submission.operationId);
      if(known?.status==='accepted'){await complete(snapshot.conversation);return;}
      if(submission.dispatchStarted){
        // Reuse the exact persisted operation; server deduplication is authoritative.
        if(known && known.status!=='rejected'){await confirmFirstSend(value.id,submission.operationId,abort.signal);return;}
        if(known?.status==='rejected')throw Error('首条消息未被接受，内容已保留。请打开已创建的对话处理。');
      }
      const deadline=Date.now()+30000;
      while(snapshot.conversation.readiness!=='ready'||!snapshot.conversation.state.configurationVerified){
        if(snapshot.conversation.readiness==='blocked')throw Error('对话准备未完成，内容已保留。可重试核对或打开已创建的对话处理。');
        if(Date.now()>deadline)throw Error('原生会话仍在准备，内容已保留，请稍后重试核对。');
        setStatus('正在准备原生会话…');await new Promise(resolve=>setTimeout(resolve,500));abort.signal.throwIfAborted();
        snapshot=await request(`/conversations/${value.id}`,snapshotSchema,{signal:abort.signal});
      }
      const pendingImages=await uploadDrafts(value.id);
      for(const item of pendingImages){if(submission.uploaded[item.id])continue;setStatus('正在上传首条消息的图片…');
        const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]!);reader.onerror=()=>reject(Error('无法读取图片'));reader.readAsDataURL(item.file);});
        const image=await request(`/conversations/${value.id}/resources`,imageSchema,{csrf:props.csrf,body:{name:item.file.name.slice(0,120)||'图片',data},signal:abort.signal});
        value={...value,images:[...(value.images??[]),image],submission:{...value.submission!,uploaded:{...value.submission!.uploaded,[item.id]:image.id}}};
        if(!persist(value,true))return;
      }
      const payload={text:value.text,...(value.images?.length?{images:value.images}:{}),...(value.references?.length?{references:value.references}:{}),...(value.skills?.length?{skills:value.skills}:{})};
      // Store exact first input before dispatch; refreshing cannot turn it into another operation.
      if(!saveDraft(value.id,{...payload,pending:{...payload,id:submission.operationId}}))throw Error('无法保留发送编号，本次尚未发送。');
      value={...value,submission:{...value.submission!,dispatchStarted:true}};if(!persist(value,true))return;
      setStatus('正在发送首条消息…');
      const response=await request(`/conversations/${value.id}/operations`,operationResponseSchema,{csrf:props.csrf,body:{id:submission.operationId,type:'message',payload},signal:abort.signal});
      if(response.operation.status==='accepted')await complete(snapshot.conversation);
      else if(response.operation.status==='rejected')setStatus('首条消息未被接受，原内容已保留。');
      else await confirmFirstSend(value.id,submission.operationId,abort.signal);
    }catch(reason){
      if(!alive.current)return;
      if(reason instanceof RequestError&&reason.code==='draft_preparation_claimed'&&!current.current.submission?.dispatchStarted){
        // The server only returns this rejection before creating this conversation.
        // An unknown response never enters this branch and keeps its frozen identity.
        persist({...current.current,submission:undefined});
        setPreparationState('failed');setPreparationClaimed(true);setSkillsSupported(false);setStatus('');
        setError('原生准备已被使用，本次尚未发送。请重新准备并核验技能。');
      }else if(reason instanceof RequestError&&reason.code==='storage_budget_reached'){setError('存储已达到预算上限，暂时不能新建对话或上传图片。内容已保留；可以在侧栏“存储”中清理后重试。');}
      else if(reason instanceof RequestError){props.report(reason);setError('暂时无法确认结果。原配置和内容已保留，请重试核对。');}
      else if(!(reason instanceof DOMException&&reason.name==='AbortError'))setError(reason instanceof Error?reason.message:'暂时无法确认结果，请重试。');
    }
    finally{busyRef.current=false;if(alive.current)setBusy(false);}
  }
  async function openCreated(){
    if(busyRef.current||stagingRef.current||!current.current.submission)return;
    const value=current.current;
    busyRef.current=true;setBusy(true);setError('');
    const abort=new AbortController();controller.current=abort;
    try {
      const snapshot=await request(`/conversations/${value.id}`,snapshotSchema,{signal:abort.signal});
      if(!alive.current)return;
      if(snapshot.operations.some(item=>item.id===value.submission!.operationId&&item.status==='accepted')){await complete(snapshot.conversation);return;}
      const payload={text:value.text,images:value.images,references:value.references,skills:value.skills};
      const pending=value.submission!.dispatchStarted?{...payload,id:value.submission!.operationId}:undefined;
      if(!saveDraft(value.id,{...payload,...(pending?{pending}:{})})){
        setError('无法保留首条消息，内容仍在此草稿中。请检查浏览器存储后重试。');return;
      }
      await Promise.all(Object.keys(value.submission!.uploaded).map(id=>removeUpload(id)));
      if(!alive.current)return;
      // Existing composer now owns the saved input and remaining staged uploads.
      // Remove only after that handoff is durable; no duplicate new draft remains.
      removeNewDraft(value.workspaceId);
      props.onCreated(snapshot.conversation);
    }catch(reason){if(alive.current&&!abort.signal.aborted)props.report(reason);}
    finally{busyRef.current=false;if(alive.current)setBusy(false);}
  }
  async function complete(conversation:Conversation){
    if(!alive.current)return;
    // Finish staged-file cleanup before mounting the existing composer. Otherwise
    // it can restore already-submitted files as failed uploads during the handoff.
    const owner=current.current;
    const items=await uploadDrafts(owner.id);
    await Promise.all(items.map(item=>removeUpload(item.id)));
    if(!alive.current)return;
    const remembered=rememberConversation(conversation);removeNewDraft(owner.workspaceId);
    if(!remembered)setError('浏览器无法记住配置，本次发送已成功。');
    props.onCreated(conversation);
  }
  function switchPower(harnessId:'codex'|'dsh'){
    if(locked)return;const previous=current.current;const next=previous.powers[harnessId]??initialConfig(props.configuration.harnesses.find(h=>h.id===harnessId));
    persist({...previous,harnessId,configuration:next,powers:{...previous.powers,[previous.harnessId]:previous.configuration}});
    if(previous.skills?.length)setError('已保留文字及技能标记；发送前会核验技能是否适用于当前 Power，不适用时请重新选择。');
  }
  return <section className="new-draft-page"><div className="new-draft-content"><div className="new-draft-intro"><span>A PLACE TO BEGIN</span><h2>从一个想法开始。</h2><p>选择工作现场，然后开始。</p></div>
    <div className="new-draft-workspace"><Folder size={15}/><label className="sr-only" htmlFor="draft-workspace">工作区</label><select id="draft-workspace" value={draft.workspaceId} disabled={locked||staging||!initialized} onChange={e=>{if(stagingRef.current)return;if(!current.current.workspaceId){if(!persist({...current.current,workspaceId:e.target.value},true))return;removeNewDraft('');}else if(!persist(current.current,true))return;props.onWorkspace(e.target.value);}}><option value="">选择工作区</option>{props.configuration.workspaces.map(w=><option key={w.id} value={w.id}>{w.label}</option>)}</select></div>
    {!props.configuration.workspaces.length&&<div className="state-notice"><p>先添加工作区，再开始对话。</p>{props.configuration.workspaceRoots?.length?<Button onClick={()=>{awaitingWorkspace.current={previous:props.addedWorkspace};props.onAddWorkspace();}}>添加工作区</Button>:<p>管理员尚未配置允许添加的目录，请先完成工作区配置。</p>}</div>}
    <ComposerView value={draft.text} onChange={text=>edit(text,[])} renderEditor={editor=><SkillEditor editor={{...editor,placeholder:'你想从哪里开始？'}} spans={draft.skills} picker={workspace&&catalog?.available&&skillsSupported&&!locked?{load:loadSkills,format:skillLabelText,limit:skillLimit}:undefined} onEdit={edit}/>}
      onSend={()=>void send()} onStop={()=>{}} onImages={files=>void addImages(files)} onFiles={()=>setPicking(true)} editDisabled={locked||!initialized} imagesDisabled={locked||staging||!initialized||!imagesReady} filesDisabled={locked||!workspace||(draft.references?.length??0)>=8}
      sendDisabled={busy||staging||!initialized||!imagesReady||(!draft.submission&&(!valid||(!draft.text.trim()&&!uploads.length&&!draft.references?.length)))} sending={busy} running={false} model={model?.label??'选择模型'} permission={catalog?.permissions.find(p=>p.id===draft.configuration.permissionId)?.label??'选择权限'} configurationNote="首次发送后配置固定。"
      configurationControls={<DraftConfiguration catalogs={props.configuration.harnesses} harnessId={draft.harnessId} configuration={draft.configuration} disabled={locked||!initialized} onPowerChange={switchPower} onConfigurationChange={configuration=>persist({...current.current,configuration})}/>}
      hasMaterials={!!uploads.length||!!draft.references?.length} error={error} materials={<>{uploads.length>0&&<div className="attachment-tray">{uploads.map(item=><StagedImage key={item.id} item={item} disabled={locked||staging} onRemove={()=>void removeImage(item.id)}/>)}</div>}{draft.references?.map((r,index)=><div className="reference-card" key={index}><FileText size={14}/><span>{r.type==='file'?r.path:r.text}</span><button type="button" aria-label="移除引用" disabled={locked} onClick={()=>persist({...current.current,references:current.current.references?.filter((_,i)=>i!==index)})}><X size={14}/></button></div>)}</>}/>
    {skillsSupported===false&&<p className="new-draft-status">当前 Power 暂未提供首发技能目录。</p>}
    {!draft.submission&&preparationState==='loading'&&<p className="new-draft-status" role="status">正在准备首发技能…</p>}
    {!draft.submission&&preparationState==='failed'&&<div className="new-draft-status" role="status"><p>{preparationClaimed?'此准备已被另一份草稿用于创建对话。内容已保留，可重新准备并核验技能。':'首发技能准备未完成，内容已保留。可重试核对同一准备。'}</p><Button disabled={busy} onClick={()=>{if(preparationClaimed&&!persist({...current.current,preparationId:undefined},true))return;setPreparationRetry(value=>value+1);}}>{preparationClaimed?'重新准备首发技能':'重试准备首发技能'}</Button></div>}
    <p className="new-draft-status" role="status">{status||(!initialized?'正在读取配置…':draft.submission?'上次创建或发送尚待核对，重试会使用同一编号。':'首次发送时创建对话；配置在对话中保持不变。')}</p>
    {draft.submission&&!busy&&<Button onClick={()=>void send()}>重试核对首条消息</Button>}
    {draft.submission&&!busy&&<Button disabled={staging} onClick={()=>void openCreated()}>查看已创建的对话</Button>}
    {picking&&workspace&&<FilePicker draftScope={{workspaceId:draft.workspaceId,harnessId:draft.harnessId}} onClose={()=>setPicking(false)} onSelect={ref=>persist({...current.current,references:[...(current.current.references??[]),ref]})}/>}
  </div></section>;
}

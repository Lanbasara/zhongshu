import { z } from 'zod';
import { configurationSchema, workspaceIdSchema, createConversationSchema } from '../shared/workbench.ts';
import { inputFields, validSkillSpans } from '../shared/content.ts';
import { clearConversationPreferences } from './conversation-preferences.ts';
const prefix = 'zhongshu:new-draft:v1:';
const draftConfiguration = configurationSchema.extend({modelId:z.string().max(2048),permissionId:z.string().max(2048)});
const selectionSchema = z.object({ harnessId:z.enum(['codex','dsh']), configuration:draftConfiguration });
export const newDraftSchema = z.object({
  id:z.uuid(), workspaceId:workspaceIdSchema.or(z.literal('')), text:z.string().max(16000), ...inputFields,
  harnessId:z.enum(['codex','dsh']), configuration:draftConfiguration,
  powers:z.object({ codex:draftConfiguration.optional(), dsh:draftConfiguration.optional() }),
  submission:z.object({ creation:createConversationSchema, operationId:z.uuid(), uploaded:z.record(z.uuid(),z.uuid()), dispatchStarted:z.boolean() }).optional(),
}).refine(validSkillSpans).refine(draft=>{
  const frozen=draft.submission?.creation;
  return !frozen || (frozen.id===draft.id && frozen.workspaceId===draft.workspaceId && frozen.harnessId===draft.harnessId
    && frozen.configuration.modelId===draft.configuration.modelId && frozen.configuration.permissionId===draft.configuration.permissionId
    && frozen.configuration.reasoningEffort===draft.configuration.reasoningEffort);
}, 'Frozen submission must belong to this draft');
export type NewDraft = z.infer<typeof newDraftSchema>;
export function emptyNewDraft(workspaceId:string, selected?:z.infer<typeof selectionSchema>):NewDraft {
  return {id:crypto.randomUUID(),workspaceId,text:'',harnessId:selected?.harnessId??'codex',configuration:selected?.configuration??{modelId:'',permissionId:''},powers:{}};
}
export function readNewDraft(workspaceId:string):NewDraft|undefined {
  try { const raw=sessionStorage.getItem(prefix+workspaceId); if(!raw || raw.length>262144)return;const draft=newDraftSchema.parse(JSON.parse(raw)); return draft.workspaceId===workspaceId?draft:undefined; } catch{return;}
}
export function saveNewDraft(draft:NewDraft):boolean {
  try { sessionStorage.setItem(prefix+draft.workspaceId,JSON.stringify(draft));return true;}catch{return false;}
}
export function removeNewDraft(workspaceId:string) {try{sessionStorage.removeItem(prefix+workspaceId);}catch{/* The accepted operation remains the source of truth. */}}
export function clearNewDrafts() {clearConversationPreferences();try{for(const key of Object.keys(sessionStorage))if(key.startsWith(prefix))sessionStorage.removeItem(key);}catch{/* Authentication exit drops in-memory state too. */}}

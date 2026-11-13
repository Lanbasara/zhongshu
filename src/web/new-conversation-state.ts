import { z } from 'zod';
import { configurationSchema, workspaceIdSchema, createConversationSchema } from '../shared/workbench.ts';
import { inputFields, validSkillSpans } from '../shared/content.ts';
import { clearConversationPreferences } from './conversation-preferences.ts';

const legacyPrefix = 'zhongshu:new-draft:v1:';
const prefix = 'zhongshu:new-draft:v2:';
const draftIdSchema = z.uuid();
const draftConfiguration = configurationSchema.extend({ modelId: z.string().max(2048), permissionId: z.string().max(2048) });
const selectionSchema = z.object({ harnessId: z.enum(['codex', 'dsh']), configuration: draftConfiguration });
const draftSchema = z.object({
  id: draftIdSchema, workspaceId: workspaceIdSchema.or(z.literal('')), text: z.string().max(16000), ...inputFields,
  harnessId: z.enum(['codex', 'dsh']), configuration: draftConfiguration,
  powers: z.object({ codex: draftConfiguration.optional(), dsh: draftConfiguration.optional() }),
  configurationPending: z.literal(true).optional(),
  referencesWorkspaceId: workspaceIdSchema.optional(),
  preparationId: z.uuid().optional(),
  submission: z.object({ creation: createConversationSchema, operationId: z.uuid(), uploaded: z.record(z.uuid(), z.uuid()), dispatchStarted: z.boolean() }).optional(),
}).refine(validSkillSpans).refine(draft => {
  const frozen = draft.submission?.creation;
  return !frozen || (!draft.configurationPending && frozen.workspaceId === draft.workspaceId && frozen.harnessId === draft.harnessId
    && frozen.configuration.modelId === draft.configuration.modelId && frozen.configuration.permissionId === draft.configuration.permissionId
    && frozen.configuration.reasoningEffort === draft.configuration.reasoningEffort
    && (frozen.configuration.agentPreset === undefined || frozen.configuration.agentPreset === (draft.configuration.agentPreset ?? frozen.configuration.agentPreset))
    && (!frozen.preparationId || frozen.preparationId === draft.preparationId));
}, 'Frozen submission must belong to this draft');

export type NewDraft = z.infer<typeof draftSchema>;

export function emptyNewDraft(workspaceId: string, selected?: z.infer<typeof selectionSchema>): NewDraft {
  return {
    id: crypto.randomUUID(), workspaceId, text: '', harnessId: selected?.harnessId ?? 'codex',
    configuration: selected?.configuration ?? { modelId: '', permissionId: '' }, powers: {},
  };
}

function readStoredDraft(key: string): NewDraft | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw && raw.length <= 262144) return draftSchema.parse(JSON.parse(raw));
  } catch { /* Invalid or unavailable browser storage cannot be restored. */ }
}

export function readNewDraft(id: string): NewDraft | undefined {
  if (!draftIdSchema.safeParse(id).success) return;
  const draft = readStoredDraft(prefix + id);
  if (draft?.id === id) return draft;
  // A full quota can prevent copying a legacy record. Its original slot is still readable.
  return legacyDrafts().find(entry => entry.draft.id === id)?.draft;
}

export function saveNewDraft(draft: NewDraft): boolean {
  try {
    const raw = JSON.stringify(draft);
    if (raw.length > 262144 || !draftSchema.safeParse(draft).success) return false;
    sessionStorage.setItem(prefix + draft.id, raw);
    return true;
  }
  catch { return false; }
}

function legacyDrafts(): { key: string; draft: NewDraft }[] {
  try {
    return Object.keys(sessionStorage).filter(key => key.startsWith(legacyPrefix)).flatMap(key => {
      const draft = readStoredDraft(key);
      if (!draft || draft.workspaceId !== key.slice(legacyPrefix.length) || (draft.submission && draft.submission.creation.id !== draft.id)) return [];
      return [{ key, draft }];
    });
  } catch { return []; }
}

export function listNewDrafts(): NewDraft[] {
  try {
    const drafts = new Map<string, NewDraft>();
    for (const key of Object.keys(sessionStorage)) {
      if (!key.startsWith(prefix)) continue;
      const draft = readStoredDraft(key);
      if (draft && key === prefix + draft.id) drafts.set(draft.id, draft);
    }
    for (const { key, draft } of legacyDrafts()) {
      // Keep the original ID for staged images. A frozen legacy submission keeps both of its IDs.
      if (drafts.has(draft.id) || saveNewDraft(draft)) sessionStorage.removeItem(key);
      if (!drafts.has(draft.id)) drafts.set(draft.id, draft);
    }
    return Array.from(drafts.values()).reverse();
  } catch { return []; }
}

export function removeNewDraft(id: string) {
  try {
    for (const entry of legacyDrafts()) if (entry.draft.id === id) sessionStorage.removeItem(entry.key);
    sessionStorage.removeItem(prefix + id);
  }
  catch { /* The accepted operation remains the source of truth. */ }
}

export function clearNewDrafts() {
  clearConversationPreferences();
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix) || key.startsWith(legacyPrefix)) sessionStorage.removeItem(key);
  } catch { /* Authentication exit drops in-memory state too. */ }
}

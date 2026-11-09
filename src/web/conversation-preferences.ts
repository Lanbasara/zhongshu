import { z } from 'zod';
import { configurationSchema, workspaceIdSchema, type Conversation } from '../shared/workbench.ts';
const key = 'zhongshu:conversation-preferences:v1';
const preference = z.object({ workspaceId: workspaceIdSchema, harnessId: z.enum(['codex','dsh']), configuration: configurationSchema });
const record = z.object({ recent: preference, workspaces: z.record(workspaceIdSchema, preference) });
export type ConversationPreference = z.infer<typeof preference>;
/** Optional UI preference, never authority. Every selection is checked against live capabilities. */
export function readPreference(workspaceId?: string): ConversationPreference | undefined {
  try { const raw = localStorage.getItem(key); if (!raw || raw.length > 262144) return; const saved = record.parse(JSON.parse(raw)); const value=workspaceId ? saved.workspaces[workspaceId] : saved.recent; return !workspaceId || value?.workspaceId===workspaceId ? value : undefined; } catch { return; }
}
export function rememberConversation(conversation: Pick<Conversation,'workspaceId'|'harnessId'|'configuration'>): boolean {
  try {
    const value = preference.parse(conversation);
    let workspaces: Record<string,ConversationPreference> = {};
    const raw = localStorage.getItem(key);
    if (raw && raw.length <= 262144) { try { workspaces = record.safeParse(JSON.parse(raw)).data?.workspaces ?? {}; } catch { /* Replace corrupt optional preferences. */ } }
    delete workspaces[value.workspaceId];
    workspaces[value.workspaceId] = value;
    workspaces = Object.fromEntries(Object.entries(workspaces).slice(-256));
    localStorage.setItem(key, JSON.stringify({recent:value,workspaces})); return true;
  } catch { return false; }
}
export function clearConversationPreferences() { try { localStorage.removeItem(key); } catch { /* Optional preference storage can be disabled. */ } }
export function initialConversationTitle(text: string): string {
  // Cut at 32 characters, then drop a trailing space the cut may leave.
  return Array.from(text.replace(/\s+/gu,' ').trim()).slice(0,32).join('').trimEnd() || '新对话';
}

import type { Conversation, WorkbenchConfiguration } from '../shared/workbench.ts';

// Legacy DSH persisted IDs included effort. Parsing does not establish that
// a model or effort is available; draft migration separately checks the catalog.
function legacyModel(id: string): { provider: string; model: string; reasoningEffort?: string } | undefined {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(id)) return;
  try {
    const binary = atob(id.replace(/-/g, '+').replace(/_/g, '/'));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;
    if (typeof item.provider !== 'string' || typeof item.model !== 'string' || !item.provider || !item.model || item.provider.length > 240 || item.model.length > 240) return;
    if (item.reasoningEffort !== undefined && (typeof item.reasoningEffort !== 'string' || !item.reasoningEffort || item.reasoningEffort.length > 240)) return;
    return { provider:item.provider, model:item.model, ...(typeof item.reasoningEffort === 'string' ? {reasoningEffort:item.reasoningEffort} : {}) };
  } catch { return; }
}
export function conversationConfigurationLabel(conversation: Pick<Conversation, 'harnessId' | 'configuration'> | undefined, catalogs: WorkbenchConfiguration['harnesses'] = []) {
  const catalog = catalogs.find(item => item.id === conversation?.harnessId);
  const selected = conversation?.configuration;
  const legacy = conversation?.harnessId === 'dsh' && selected ? legacyModel(selected.modelId) : undefined;
  const model = catalog?.models.find(item => item.id === selected?.modelId) ?? (legacy ? catalog?.models.find(item => {
    const candidate = legacyModel(item.id);
    return candidate?.provider === legacy.provider && candidate.model === legacy.model;
  }) : undefined);
  const effortId = selected?.reasoningEffort ?? legacy?.reasoningEffort;
  const presetId = selected?.agentPreset;
  return {
    model: model?.label ?? legacy?.model ?? '配置按对话固定',
    reasoningEffort: model?.reasoningEfforts?.find(item => item.id === effortId)?.label ?? effortId,
    // Conversations created before presets have none recorded here; the Host default applied to them.
    ...(presetId ? { agentPreset: catalog?.presets?.find(item => item.id === presetId)?.label ?? presetId } : {}),
  };
}

/** Project a legacy preference into a NEW draft only. Existing sessions remain immutable. */
export function normalizeDraftPreference<T extends Pick<Conversation, 'harnessId' | 'configuration'>>(preference: T, catalogs: WorkbenchConfiguration['harnesses']): T {
  if (preference.harnessId !== 'dsh') return preference;
  const original = preference.configuration;
  const legacy = legacyModel(original.modelId);
  if (!legacy?.reasoningEffort || (original.reasoningEffort !== undefined && original.reasoningEffort !== legacy.reasoningEffort)) return preference;
  const catalog = catalogs.find(item => item.id === 'dsh' && item.available);
  // Only the exact provider/model pair and the original effort may migrate.
  // Missing capabilities remain invalid choices for the user to resolve.
  const matches = catalog?.models.filter(item => {
    const candidate = legacyModel(item.id);
    return candidate?.provider === legacy.provider && candidate.model === legacy.model && candidate.reasoningEffort === undefined
      && item.reasoningEfforts?.some(effort => effort.id === legacy.reasoningEffort);
  });
  if (matches?.length !== 1) return preference;
  return { ...preference, configuration:{ ...original, modelId:matches[0]!.id, reasoningEffort:legacy.reasoningEffort } };
}

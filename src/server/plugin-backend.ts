import type { PluginCommand, PluginEntry, PluginSource, PluginSourceCommand, PluginStatus } from '../shared/plugins.ts';

export type PluginResult = Exclude<PluginStatus, 'applying'>;

export class PluginSourceError extends Error {
  readonly code: 'invalid_plugin_source' | 'plugin_source_conflict' | 'plugin_source_in_use';
  constructor(code: PluginSourceError['code']) { super(code); this.code = code; }
}

export interface PluginBackend {
  list(): Promise<PluginEntry[]>;
  change(command: PluginCommand): Promise<PluginResult>;
  recover(command: PluginCommand): Promise<PluginResult>;
  catalog?(): Promise<{ entries: PluginEntry[]; sources: PluginSource[] }>;
  detail?(id: string): Promise<PluginEntry | null>;
  sources?(): Promise<PluginSource[]>;
  updateSource?(command: PluginSourceCommand, requestId?: string): Promise<void>;
  recoverSource?(command: PluginSourceCommand, requestId: string): Promise<'applied' | 'failed' | 'unknown'>;
  close?(): Promise<void>;
}

export function matchesPluginAction(command: PluginCommand, entries: PluginEntry[]): boolean {
  const entry = entries.find(item => item.id === command.pluginId);
  if (command.action === 'remove') return entry?.installed === false;
  return !!entry?.installed && (!command.version || entry.version === command.version) && (command.action === 'disable' ? !entry.enabled : entry.enabled);
}

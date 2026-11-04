import type { PluginCommand, PluginEntry, PluginStatus } from '../shared/plugins.ts';

export type PluginResult = Exclude<PluginStatus, 'applying'>;

export interface PluginBackend {
  list(): Promise<PluginEntry[]>;
  change(command: PluginCommand): Promise<PluginResult>;
  recover(command: PluginCommand): Promise<PluginResult>;
  close?(): Promise<void>;
}

export function matchesPluginAction(command: PluginCommand, entries: PluginEntry[]): boolean {
  const entry = entries.find(item => item.id === command.pluginId);
  if (command.action === 'remove') return entry?.installed === false;
  return !!entry?.installed && (command.action === 'disable' ? !entry.enabled : entry.enabled);
}

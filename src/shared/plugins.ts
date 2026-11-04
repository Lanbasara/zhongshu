import { z } from 'zod';

export const pluginHarness = z.enum(['codex', 'dsh']);
export type PluginHarness = z.infer<typeof pluginHarness>;
export const pluginAction = z.enum(['install', 'enable', 'disable', 'remove']);
export type PluginAction = z.infer<typeof pluginAction>;
export const pluginKey = z.string().min(1).max(240).regex(/^[A-Za-z0-9@/_.:-]+$/);
export const pluginStatus = z.enum(['applying', 'unknown', 'applied', 'restart-required', 'failed']);
export type PluginStatus = z.infer<typeof pluginStatus>;

export const pluginEntry = z.object({
  id: pluginKey,
  name: z.string().min(1).max(240),
  description: z.string().max(1000),
  source: z.string().min(1).max(240),
  version: z.string().max(128).nullable(),
  installed: z.boolean(),
  enabled: z.boolean(),
  application: z.enum(['unverified', 'applied', 'restart-required', 'failed']),
  actions: z.array(pluginAction).max(4),
}).strict();
export type PluginEntry = z.infer<typeof pluginEntry>;

export const pluginCommand = z.object({
  id: z.uuid(),
  pluginId: pluginKey,
  action: pluginAction,
}).strict();
export type PluginCommand = z.infer<typeof pluginCommand>;

export const pluginOperation = pluginCommand.extend({ status: pluginStatus }).strict();
export type PluginOperation = z.infer<typeof pluginOperation>;
export const pluginView = z.object({
  availability: z.enum(['available', 'unconfigured', 'offline']),
  entries: z.array(pluginEntry).max(1000),
  operation: pluginOperation.nullable(),
}).strict();
export type PluginView = z.infer<typeof pluginView>;

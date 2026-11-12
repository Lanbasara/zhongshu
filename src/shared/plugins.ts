import { z } from 'zod';

export const pluginHarness = z.enum(['codex', 'dsh']);
export type PluginHarness = z.infer<typeof pluginHarness>;
export const pluginAction = z.enum(['install', 'enable', 'disable', 'remove', 'update']);
export type PluginAction = z.infer<typeof pluginAction>;
export const pluginKey = z.string().min(1).max(240).regex(/^[A-Za-z0-9@/_.:-]+$/);
export const pluginStatus = z.enum(['applying', 'unknown', 'applied', 'restart-required', 'failed']);
export type PluginStatus = z.infer<typeof pluginStatus>;

export const pluginSource = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(240),
  url: z.url({ protocol: /^https$/ }).max(512),
  removable: z.boolean(),
  unavailable: z.boolean().optional(),
}).strict();
export type PluginSource = z.infer<typeof pluginSource>;
export const pluginSourceCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), source: z.string().trim().min(1).max(512), ref: z.string().trim().min(1).max(128).optional() }).strict(),
  z.object({ action: z.literal('remove'), id: z.string().min(1).max(512) }).strict(),
]);
export type PluginSourceCommand = z.infer<typeof pluginSourceCommand>;

export const pluginRelease = z.object({
  version: z.string().min(1).max(128),
  installable: z.boolean(),
  publishedAt: z.number().int().min(0).max(4_102_444_800).optional(),
  repository: z.url({ protocol: /^https$/ }).max(512).optional(),
  commit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  directory: z.string().max(240).optional(),
}).strict();

const revision = z.string().regex(/^[a-f0-9]{40}$/);
export const pluginUpdateCheck = z.object({
  checked: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
}).strict();
export type PluginUpdateCheck = z.infer<typeof pluginUpdateCheck>;

export const pluginEntry = z.object({
  id: pluginKey,
  name: z.string().min(1).max(240),
  description: z.string().max(1000),
  source: z.string().min(1).max(240),
  sourceId: z.string().max(512).optional(),
  author: z.string().max(240).optional(),
  homepage: z.url({ protocol: /^https$/ }).max(512).optional(),
  releases: z.array(pluginRelease).max(256).optional(),
  skills: z.array(z.object({ name: z.string().max(200), description: z.string().max(1000) }).strict()).max(200).optional(),
  system: z.boolean().optional(),
  version: z.string().max(128).nullable(),
  installed: z.boolean(),
  enabled: z.boolean(),
  application: z.enum(['unverified', 'applied', 'restart-required', 'failed']),
  actions: z.array(pluginAction).max(5),
  update: z.object({ version: z.string().min(1).max(128), revision, commit: revision, marketConflict: z.literal(true).optional() }).strict().optional(),
}).strict();
export type PluginEntry = z.infer<typeof pluginEntry>;

export const pluginCommand = z.object({
  id: z.uuid(),
  pluginId: pluginKey,
  action: pluginAction,
  version: z.string().min(1).max(128).optional(),
  revision: revision.optional(),
}).strict().refine(command => command.action === 'update'
  ? !!command.version && !!command.revision
  : !command.revision && (!command.version || command.action === 'install'));
export type PluginCommand = z.infer<typeof pluginCommand>;

export const pluginOperation = pluginCommand.safeExtend({ status: pluginStatus }).strict();
export type PluginOperation = z.infer<typeof pluginOperation>;
export const pluginView = z.object({
  availability: z.enum(['available', 'unconfigured', 'offline']),
  entries: z.array(pluginEntry).max(1000),
  sources: z.array(pluginSource).max(40).optional(),
  updateCheck: pluginUpdateCheck.optional(),
  operation: pluginOperation.nullable(),
}).strict();
export type PluginView = z.infer<typeof pluginView>;

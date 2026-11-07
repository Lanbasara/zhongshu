import { z } from 'zod';

/** ADR 0015: what Zhongshu last verified about one Harness account. Local credentials alone are never `valid`. */
export const accountStateSchema = z.enum(['checking', 'valid', 'signed-out', 'rejected', 'unverified', 'disconnected']);
export type AccountStateView = z.infer<typeof accountStateSchema>;
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const accountViewSchema = z.object({
  harnessId: z.enum(['codex', 'dsh']),
  state: accountStateSchema,
  identity: z.string().max(240).optional(),
  plan: z.string().max(60).optional(),
  usage: z.object({ usedPercent: z.number().min(0).max(100), resetsAt: time.optional(), windowMinutes: z.number().int().positive().optional() }).strict().optional(),
  /** Vendor pages for usage and top-up (DSH). */
  links: z.object({ usage: z.url().max(2048).optional(), topUp: z.url().max(2048).optional() }).strict().optional(),
  checkedAt: time.optional(),
  canLogin: z.boolean(),
  /** A login in progress or its failure. User codes and authorization addresses are never part of this view. */
  login: z.discriminatedUnion('status', [
    z.object({ status: z.literal('waiting'), startedAt: time }).strict(),
    z.object({ status: z.literal('failed'), reason: z.string().max(200) }).strict(),
  ]).optional(),
}).strict();
export type AccountView = z.infer<typeof accountViewSchema>;
export const accountsSchema = z.object({ accounts: z.array(accountViewSchema).max(4) }).strict();
/** Returned once, to the page that started the login (ADR 0015). */
export const loginResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('device-code'), account: accountViewSchema, verificationUrl: z.url().max(2048), userCode: z.string().min(4).max(64) }).strict(),
  z.object({ kind: z.literal('paste-back'), account: accountViewSchema, authorizeUrl: z.url().max(4096), callbackPrefix: z.url().max(512) }).strict(),
]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;
/** The address the vendor redirected to after a `paste-back` sign-in; it carries a one-time code and is never stored. */
export const loginCompleteSchema = z.object({ callbackUrl: z.string().min(1).max(4096) }).strict();
/** Signed out, rejected or unreachable: new work in that Harness cannot start. */
export const accountBlocks = (state: AccountStateView) => state === 'signed-out' || state === 'rejected' || state === 'disconnected';

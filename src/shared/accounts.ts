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
  checkedAt: time.optional(),
  canLogin: z.boolean(),
  /** A device-code login in progress or its failure. The user code is never part of this view. */
  login: z.discriminatedUnion('status', [
    z.object({ status: z.literal('waiting'), startedAt: time }).strict(),
    z.object({ status: z.literal('failed'), reason: z.string().max(200) }).strict(),
  ]).optional(),
}).strict();
export type AccountView = z.infer<typeof accountViewSchema>;
export const accountsSchema = z.object({ accounts: z.array(accountViewSchema).max(4) }).strict();
/** Returned once, to the page that started the login. */
export const deviceLoginResponseSchema = z.object({
  account: accountViewSchema,
  verificationUrl: z.url().max(2048),
  userCode: z.string().min(4).max(64),
}).strict();
/** Signed out, rejected or unreachable: new work in that Harness cannot start. */
export const accountBlocks = (state: AccountStateView) => state === 'signed-out' || state === 'rejected' || state === 'disconnected';

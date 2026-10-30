import { z } from 'zod';

export const sessionSchema = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(true), csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.number().int().nonnegative() }),
  z.object({ authenticated: z.literal(false), initialized: z.boolean().optional() }),
]);
export type SessionView = z.infer<typeof sessionSchema>;
export const versionSchema = z.object({ name: z.literal('zhongshu'), version: z.string().max(64), revision: z.string().regex(/^(development|[a-f0-9]{40})$/) });
export const errorSchema = z.object({ error: z.string().max(100) });
export const identitySchema = z.object({ name: z.string().max(80), expiresAt: z.number().int().nonnegative() });

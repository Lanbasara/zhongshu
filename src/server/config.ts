import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { localDefaultPassword } from './auth.ts';
import { parseStorageBudget } from './storage.ts';

const environment = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  ZHONGSHU_ORIGIN: z.url().default('http://127.0.0.1:3000'),
  ZHONGSHU_DATA_DIR: z.string().min(1).optional(),
  ZHONGSHU_ALLOW_HTTP_LOOPBACK: z.enum(['true', 'false']).default('false'),
  ZHONGSHU_ADMIN_PASSWORD: z.string().optional(),
  ZHONGSHU_STORAGE_BUDGET: z.string().max(32).optional(),
});

export function validOrigin(value: string, allowHttpLoopback: boolean): string {
  const origin = new URL(value);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('invalid_public_origin');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(allowHttpLoopback && local && origin.protocol === 'http:')) {
    throw new Error('https_required_except_explicit_loopback_development');
  }
  return origin.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = environment.parse(env);
  const origin = validOrigin(parsed.ZHONGSHU_ORIGIN, parsed.ZHONGSHU_ALLOW_HTTP_LOOPBACK === 'true');
  if (origin.startsWith('http:') && !['localhost', '127.0.0.1', '::1'].includes(parsed.HOST)) {
    throw new Error('cleartext_development_must_bind_loopback');
  }
  // An empty value counts as unset. Local cleartext instances fall back to the published local default.
  const adminPassword = parsed.ZHONGSHU_ADMIN_PASSWORD || (origin.startsWith('http:') ? localDefaultPassword : undefined);
  return {
    ...(adminPassword ? { adminPassword } : {}),
    host: parsed.HOST,
    port: parsed.PORT,
    origin,
    storageBudget: parseStorageBudget(parsed.ZHONGSHU_STORAGE_BUDGET),
    dataDirectory: resolve(parsed.ZHONGSHU_DATA_DIR ?? join(homedir(), '.local/share/zhongshu')),
  };
}

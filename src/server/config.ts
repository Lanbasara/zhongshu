import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { z } from 'zod';

const environment = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  ZHONGSHU_ORIGIN: z.url().default('http://127.0.0.1:3000'),
  ZHONGSHU_DATA_DIR: z.string().min(1).optional(),
  ZHONGSHU_ALLOW_HTTP_LOOPBACK: z.enum(['true', 'false']).default('false'),
  ZHONGSHU_STORAGE_QUOTA_BYTES: z.coerce.number().int().min(1024 ** 2).max(Number.MAX_SAFE_INTEGER).default(32 * 1024 ** 3),
  ZHONGSHU_STORAGE_RESERVE_BYTES: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(256 * 1024 ** 2),
  ZHONGSHU_STORAGE_FREE_BYTES: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(512 * 1024 ** 2),
  ZHONGSHU_STORAGE_TRANSIENT_BYTES: z.coerce.number().int().min(65536).max(Number.MAX_SAFE_INTEGER).default(512 * 1024 ** 2),
  ZHONGSHU_WORKSPACE_WRITER_QUOTA_BYTES: z.coerce.number().int().min(1024 ** 2).max(Number.MAX_SAFE_INTEGER).default(2 * 1024 ** 3),
  ZHONGSHU_WORKSPACE_WRITER_RESERVE_BYTES: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(64 * 1024 ** 2),
  ZHONGSHU_WORKSPACE_WRITER_FREE_BYTES: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(512 * 1024 ** 2),
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
  if (parsed.ZHONGSHU_STORAGE_RESERVE_BYTES >= parsed.ZHONGSHU_STORAGE_QUOTA_BYTES) throw new Error('invalid_storage_capacity');
  if (parsed.ZHONGSHU_WORKSPACE_WRITER_RESERVE_BYTES >= parsed.ZHONGSHU_WORKSPACE_WRITER_QUOTA_BYTES) throw new Error('invalid_workspace_writer_capacity');
  const origin = validOrigin(parsed.ZHONGSHU_ORIGIN, parsed.ZHONGSHU_ALLOW_HTTP_LOOPBACK === 'true');
  if (origin.startsWith('http:') && !['localhost', '127.0.0.1', '::1'].includes(parsed.HOST)) {
    throw new Error('cleartext_development_must_bind_loopback');
  }
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    origin,
    dataDirectory: resolve(parsed.ZHONGSHU_DATA_DIR ?? join(homedir(), '.local/share/zhongshu')),
    storageCapacity: { quotaBytes: parsed.ZHONGSHU_STORAGE_QUOTA_BYTES, reserveBytes: parsed.ZHONGSHU_STORAGE_RESERVE_BYTES, minimumFreeBytes: parsed.ZHONGSHU_STORAGE_FREE_BYTES, transientBytes: parsed.ZHONGSHU_STORAGE_TRANSIENT_BYTES },
    workspaceWriterCapacity: { quotaBytes: parsed.ZHONGSHU_WORKSPACE_WRITER_QUOTA_BYTES, reserveBytes: parsed.ZHONGSHU_WORKSPACE_WRITER_RESERVE_BYTES, minimumFreeBytes: parsed.ZHONGSHU_WORKSPACE_WRITER_FREE_BYTES },
  };
}

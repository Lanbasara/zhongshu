import { request } from 'node:http';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { pluginEntry, pluginSource, pluginStatus, type PluginCommand, type PluginSourceCommand } from '../shared/plugins.ts';
import { PluginSourceError, type PluginBackend } from './plugin-backend.ts';

export async function socketIdentity(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  if (!info.isSocket()) throw new Error('plugin_socket_invalid');
  return info.dev + ':' + info.ino;
}

const inventory = z.object({ target: z.string(), entries: z.array(pluginEntry).max(1000), sources: z.array(pluginSource).max(40).default([]) }).strict();
const details = z.object({ target: z.string(), entry: pluginEntry.nullable() }).strict();
const targetOnly = z.object({ target: z.string() }).strict();
const outcome = z.object({ target: z.string(), status: pluginStatus.exclude(['applying']) }).strict();
const sourceError = z.object({ error: z.enum(['invalid_plugin_source', 'plugin_source_conflict', 'plugin_source_in_use']) });

export function codexPluginClient(socketPath: string, nativeSocket: string): PluginBackend {
  async function call<T extends { target: string }>(path: '/catalog' | '/change' | '/recover' | '/sources' | '/detail' | '/recover-source',
    schema: z.ZodType<T>, input?: { command: PluginCommand | PluginSourceCommand; requestId?: string } | { id: string }): Promise<T> {
    const target = await socketIdentity(nativeSocket);
    await socketIdentity(socketPath);
    const body = input && JSON.stringify({ target, ...input });
    return await new Promise<T>((resolve, reject) => {
      const req = request({ socketPath, path, method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : undefined,
        signal: AbortSignal.timeout(path === '/change' || path === '/sources' ? 150_000 : 35_000),
      }, res => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('error', reject);
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) req.destroy(new Error('plugin_response_too_large'));
          else chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const data: unknown = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode !== 200) {
              const failure = sourceError.safeParse(data);
              if (path === '/sources' && failure.success) throw new PluginSourceError(failure.data.error);
              throw new Error('plugin_manager_unavailable');
            }
            const value = schema.parse(data);
            if (value.target !== target) throw new Error('plugin_target_changed');
            resolve(value);
          } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  return {
    catalog: () => call('/catalog', inventory),
    list: async () => (await call('/catalog', inventory)).entries,
    sources: async () => (await call('/catalog', inventory)).sources,
    detail: async id => (await call('/detail', details, { id })).entry,
    change: async command => (await call('/change', outcome, { command })).status,
    recover: async command => (await call('/recover', outcome, { command })).status,
    recoverSource: async (command, requestId) => { const result = (await call('/recover-source', outcome, { command, requestId })).status; return result === 'applied' || result === 'failed' ? result : 'unknown'; },
    updateSource: async (command, requestId) => { await call('/sources', targetOnly, { command, requestId }); },
  };
}

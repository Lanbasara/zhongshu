import { request } from 'node:http';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { pluginEntry, pluginStatus, type PluginCommand } from '../shared/plugins.ts';
import type { PluginBackend, PluginResult } from './plugin-backend.ts';

export async function socketIdentity(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  if (!info.isSocket()) throw new Error('plugin_socket_invalid');
  return info.dev + ':' + info.ino;
}

const inventory = z.object({ target: z.string(), entries: z.array(pluginEntry).max(1000) }).strict();
const outcome = z.object({ target: z.string(), status: pluginStatus.exclude(['applying']) }).strict();

export function codexPluginClient(socketPath: string, nativeSocket: string): PluginBackend {
  async function call(path: '/catalog' | '/change' | '/recover', input?: PluginCommand): Promise<unknown> {
    const target = await socketIdentity(nativeSocket);
    await socketIdentity(socketPath);
    const body = input && JSON.stringify({ target, command: input });
    return await new Promise<unknown>((resolve, reject) => {
      const req = request({ socketPath, path, method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : undefined,
        signal: AbortSignal.timeout(path === '/change' ? 150_000 : 35_000),
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
            if (res.statusCode !== 200) throw new Error('plugin_manager_unavailable');
            const data: unknown = JSON.parse(Buffer.concat(chunks).toString());
            if (path === '/catalog') {
              const value = inventory.parse(data);
              if (value.target !== target) throw new Error('plugin_target_changed');
              resolve(value.entries);
            } else {
              const value = outcome.parse(data);
              if (value.target !== target) throw new Error('plugin_target_changed');
              resolve(value.status);
            }
          } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  return {
    list: async () => await call('/catalog') as z.infer<typeof inventory>['entries'],
    change: async command => await call('/change', command) as PluginResult,
    recover: async command => await call('/recover', command) as PluginResult,
  };
}

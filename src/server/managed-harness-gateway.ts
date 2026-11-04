import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { ExecutionHost, gatewayRequestSchema } from './execution-host.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const control = z.object({ action: z.enum(['inspect', 'fence', 'quiesce', 'resume', 'capacity']), requestId: id,
  expected: z.object({ generation: id, epoch: z.number().int().nonnegative().safe() }).strict().optional(), frozenSetId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
/** Private operator endpoint for every non-browser client. Requests contain only
 * durable operation/conversation IDs. This endpoint never accepts native argv,
 * bindings, prompts, workspace paths or caller-issued execution permits. */
export async function serveExecutionGateway(host: ExecutionHost, options: { socketPath: string; token: string }) {
  if (!isAbsolute(options.socketPath) || options.socketPath.length > 100 || !/^[A-Za-z0-9_-]{43}$/.test(options.token)) throw new Error('execution_gateway_configuration_invalid');
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  const info = await lstat(dirname(options.socketPath));
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error('execution_gateway_socket_unsafe');
  // The kernel-owned host ownership port is held before this function runs.
  try { const old = await lstat(options.socketPath); if (!old.isSocket() || process.getuid && old.uid !== process.getuid()) throw new Error('execution_gateway_socket_unsafe'); await unlink(options.socketPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let active = 0;
  const server = createServer(async (request, response) => {
    const expected = 'Bearer ' + options.token; const supplied = request.headers.authorization;
    if (request.method !== 'POST' || !['/execute', '/control', '/recover-create'].includes(request.url ?? '') || typeof supplied !== 'string' || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { response.writeHead(403); response.end(); return; }
    if (active >= 16) { response.writeHead(429); response.end(); return; }
    active++;
    try {
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { const data = Buffer.from(chunk); bytes += data.length; if (bytes > 4096) throw new Error('request_limit'); chunks.push(data); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); let result: unknown;
      if (request.url === '/recover-create') result = await host.recoverCreation(z.object({ conversationId: z.uuid() }).strict().parse(value).conversationId);
      else if (request.url === '/execute') {
        const command = gatewayRequestSchema.parse(value);
        if (command.kind === 'observe' && command.method === 'watch') throw new Error('gateway_watch_requires_workbench_stream');
        result = await host.dispatch(command);
      } else {
        const command = control.parse(value);
        if (command.action === 'capacity') result = await host.capacity();
        else if (command.action === 'inspect') result = await host.controller.inspect(command.requestId, command.expected);
        else { if (!command.expected) throw new Error('expected_epoch_required'); result = await host.controller[command.action]({ requestId: command.requestId, expected: command.expected, ...(command.frozenSetId ? { frozenSetId: command.frozenSetId } : {}) }); }
      }
      const body = JSON.stringify(result); if (Buffer.byteLength(body) > 128 * 1024) throw new Error('result_limit');
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(body);
    } catch { if (!response.headersSent) response.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end('{"error":"execution_request_unavailable"}'); }
    finally { active--; }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.socketPath, () => { server.off('error', reject); resolve(); }); });
  await chmod(options.socketPath, 0o600);
  return { async close() { server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await unlink(options.socketPath).catch(() => {}); } };
}

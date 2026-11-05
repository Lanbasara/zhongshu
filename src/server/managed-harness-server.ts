import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, lstat, readFile, unlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createCodexAdapter } from '../harness/codex/index.ts';
import { createDshAdapter } from '../harness/dsh/index.ts';
import { serveManagedHarness } from './managed-harness-rpc.ts';
import { createCodexPluginHost, settingsSchema } from './codex-plugin-host.ts';
import { codexPluginClient } from './codex-plugin-client.ts';
import { dshPlugins, dshPluginSources } from './dsh-plugins.ts';
import type { PluginBackend } from './plugin-backend.ts';

const path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'));
const argument = z.string().max(4096).refine(value => !value.includes('\0'));
const bounded = z.object({ nativeRoot: path, cacheRoot: path, maxCacheBytes: z.number().int().min(1024 ** 2).max(16 * 1024 ** 3).optional() }).strict();
const native = z.discriminatedUnion('id', [
  z.object({ id: z.literal('codex'), socketPath: path, boundedHistory: bounded, plugins: z.object({ configurationFile: path }).strict().optional() }).strict(),
  z.object({ id: z.literal('dsh'), launchFile: path, boundedHistory: bounded, boundedState: z.literal(true), plugins: z.object({ sources: dshPluginSources }).strict().optional() }).strict(),
]);
export const managedNativeConfigurationSchema = z.object({
  socketPath: path, tokenFile: path, native,
  process: z.object({ executable: path, args: z.array(argument).max(64), cwd: path,
    environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), argument).refine(value => Object.keys(value).length <= 64).default({}),
  }).strict(),
}).strict();
export async function readOperatorFile(path: string, maxBytes: number): Promise<string> {
  const info = await lstat(path);
  if (!isAbsolute(path) || !info.isFile() || info.isSymbolicLink() || info.size > maxBytes || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error('managed_operator_file_unsafe');
  const content = await readFile(path, 'utf8'); if (Buffer.byteLength(content) > maxBytes) throw new Error('managed_operator_file_too_large'); return content;
}
/** Unexpected native exit must terminate PID 1 even if an adapter close waits
 * forever for the dead peer. Tests use real child processes and an exit sink. */
export function superviseManagedNativeChild(child: ChildProcess, shutdown: () => Promise<void>, failed: () => void) {
  let expected = false; let notified = false;
  const exit = () => {
    if (expected || notified) return; notified = true;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; failed(); } };
    const timer = setTimeout(finish, 5000);
    void Promise.resolve().then(shutdown).catch(() => {}).finally(() => { clearTimeout(timer); finish(); });
  };
  child.once('error', exit); child.once('exit', exit);
  return () => { expected = true; };
}
/** Container entry point. Only an operator-owned config chooses the executable,
 * argv/environment and native data roots. No shell or browser supplied command.
 * Run as the container's fixed non-root user, with restart policy disabled. */
export async function startManagedNative(file: string, onFailure = () => { process.exitCode = 1; }) {
  const config = managedNativeConfigurationSchema.parse(JSON.parse(await readOperatorFile(file, 32 * 1024)));
  const token = (await readOperatorFile(config.tokenFile, 128)).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('managed_native_token_invalid');
  let child: ChildProcess | undefined;
  let server: Awaited<ReturnType<typeof serveManagedHarness>> | undefined;
  let pluginHost: Awaited<ReturnType<typeof createCodexPluginHost>> | undefined;
  let plugins: PluginBackend | undefined;
  let closing = false;
  let closingTask: Promise<void> | undefined;
  let expectedExit: (() => void) | undefined;
  const adapter = config.native.id === 'codex' ? createCodexAdapter({ ...config.native, managedExecution: true }) : createDshAdapter({ ...config.native, managedExecution: true });
  const close = () => closingTask ??= (async () => {
    closing = true; expectedExit?.(); child?.kill('SIGTERM');
    await Promise.allSettled([server ? server.close() : adapter.close(), plugins?.close?.(), pluginHost?.close()]);
  })();
  try {
    child = spawn(config.process.executable, config.process.args, { cwd: config.process.cwd,
      env: { ...config.process.environment }, shell: false, stdio: 'ignore' });
    let failed = false; child.once('error', () => { failed = true; }); child.once('exit', () => { failed = true; });
    expectedExit = superviseManagedNativeChild(child, close, onFailure);
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (failed) throw new Error('managed_native_start_failed');
      const catalog = await adapter.catalog().catch(() => undefined);
      if (catalog?.available) break;
      if (Date.now() >= deadline) throw new Error('managed_native_start_timeout');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (config.native.id === 'codex' && config.native.plugins) {
      const settings = settingsSchema.parse(JSON.parse(await readOperatorFile(config.native.plugins.configurationFile, 32 * 1024)));
      if (settings.nativeSocket !== config.native.socketPath || settings.codexHome !== config.native.boundedHistory.nativeRoot || settings.version !== '0.166.0-alpha.5.1') throw new Error('managed_plugin_target_mismatch');
      try { const old = await lstat(settings.socket); if (!old.isSocket() || process.getuid && old.uid !== process.getuid()) throw new Error('managed_plugin_socket_unsafe'); await unlink(settings.socket); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      pluginHost = await createCodexPluginHost(settings); await pluginHost.listen({ path: settings.socket }); await chmod(settings.socket, 0o600);
      plugins = codexPluginClient(settings.socket, settings.nativeSocket);
    } else if (config.native.id === 'dsh' && config.native.plugins) plugins = dshPlugins(config.native.launchFile, config.native.plugins.sources);
    server = await serveManagedHarness(adapter, { socketPath: config.socketPath, token }, plugins);
    if (failed || closing) { await server.close(); throw new Error('managed_native_start_failed'); }
    return { close };
  } catch (error) { await close(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) { console.error('managed_native_configuration_required'); process.exitCode = 1; }
  else startManagedNative(file, () => { process.exit(1); }).then(server => {
    const stop = () => { const timer = setTimeout(() => process.exit(0), 5000); void server.close().finally(() => { clearTimeout(timer); process.exit(0); }); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  })
    .catch(() => { console.error('managed_native_start_failed'); process.exitCode = 1; });
}

import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { z } from 'zod';
import { codexSandboxArchitectures, codexSeccompDigest, dockerSecurityOptions, type DockerSandboxPolicy } from './execution-sandbox-policy.ts';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && normalize(value) === value && !value.includes('\0'));
const argument = z.string().max(4096).refine(value => !value.includes('\0'));
export const dockerHostConfigurationSchema = z.object({
  socketPath: path,
  ownershipPort: z.number().int().min(1024).max(65535),
  image: z.string().regex(/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64})$/),
  argv: z.array(argument).min(1).max(64).refine(values => isAbsolute(values[0]!)),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), argument).refine(value => Object.keys(value).length <= 64).default({}),
  mounts: z.array(z.object({ source: path, target: path, readOnly: z.boolean().default(false), volume: z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/), subpath: z.string().max(1024).refine(value => value === '' || !isAbsolute(value) && normalize(value) === value && value !== '..' && !value.startsWith('../') && !value.includes('\0')) }).strict().optional(), kind: z.enum(['workspace', 'data', 'runtime']) }).strict()).min(1).max(32)
    .refine(values => new Set(values.map(value => value.target)).size === values.length)
    .refine(values => values.every(value => value.target !== '/' && !['/proc', '/sys', '/dev'].some(root => value.target === root || value.target.startsWith(root + '/'))))
    .refine(values => values.some(value => value.kind === 'data' && !value.readOnly))
    .refine(values => values.every(value => value.kind !== 'workspace' || value.source === value.target)),
  user: z.string().regex(/^[1-9][0-9]{0,8}:[1-9][0-9]{0,8}$/),
  network: z.enum(['none', 'bridge']).default('none'),
  memoryBytes: z.number().int().min(256 * 1024 ** 2).max(32 * 1024 ** 3).default(2 * 1024 ** 3),
  cpus: z.number().min(0.25).max(32).default(2),
  pids: z.number().int().min(16).max(4096).default(256),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
}).strict();
export type DockerHostConfiguration = z.input<typeof dockerHostConfigurationSchema>;
export type ContainerProof = { id: string; groupId: string; generation: string; configurationDigest: string; running: boolean; pid: number; status: string };
export interface ExecutionHostRuntime {
  prepare(): Promise<ContainerProof>;
  inspect(): Promise<ContainerProof>;
  start(): Promise<ContainerProof>;
  quiesce(): Promise<ContainerProof>;
}
export class ExecutionHostError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode = 409) { super(code); this.name = 'ExecutionHostError'; this.code = code; this.statusCode = statusCode; }
}
export function hostDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function dockerHostDigest(input: DockerHostConfiguration, workspaceWriterDirectory?: string, sandboxPolicy: DockerSandboxPolicy = 'docker-default'): string {
  const config = dockerHostConfigurationSchema.parse(input);
  const identity = workspaceWriterDirectory ? { docker: config, workspaceWriterDirectory } : config;
  return sandboxPolicy === 'codex-bwrap-v1' ? hostDigest({ configuration: identity, sandboxPolicy, seccompDigest: codexSeccompDigest }) : hostDigest(identity);
}

/** Operator-only Docker configuration, never HTTP/browser input. Docker owns the
 * entire process tree. No host PID namespace, Docker socket mount, published
 * native port, privileged process or automatic restart is part of this profile.
 * External service managers must manage the gateway, never this container.
 */
export function createDockerExecutionHost(input: DockerHostConfiguration, groupId: string, generation: string, protectedPaths: string[] = [], workspaceWriterDirectory?: string, sandboxPolicy: DockerSandboxPolicy = 'docker-default'): ExecutionHostRuntime {
  const config = dockerHostConfigurationSchema.parse(input); identifier.parse(groupId); identifier.parse(generation);
  z.enum(['docker-default', 'codex-bwrap-v1']).parse(sandboxPolicy);
  const securityOptions = dockerSecurityOptions(sandboxPolicy);
  const configurationDigest = dockerHostDigest(config, workspaceWriterDirectory, sandboxPolicy);
  const name = 'zhongshu-host-' + hostDigest([groupId, generation]).slice(0, 32);
  const labels = { 'zhongshu.execution.group': groupId, 'zhongshu.execution.generation': generation, 'zhongshu.execution.configuration': configurationDigest };
  let containerId: string | undefined;
  async function call(method: string, endpoint: string, body?: unknown): Promise<{ status: number; value: unknown }> {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (encoded && encoded.length > 256 * 1024) throw new ExecutionHostError('execution_docker_request_too_large', 413);
    return await new Promise((resolve, reject) => {
      let settled = false; const chunks: Buffer[] = []; let bytes = 0;
      const fail = () => { if (!settled) { settled = true; reject(new ExecutionHostError('execution_docker_unavailable', 503)); } };
      const req = request({ socketPath: config.socketPath, method, path: '/v1.47' + endpoint,
        headers: { ...(encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {}) }, timeout: config.timeoutMs,
      }, response => {
        response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256 * 1024) { fail(); response.destroy(); req.destroy(); } else chunks.push(chunk); });
        response.once('error', fail);
        response.once('end', () => {
          if (settled) return; settled = true;
          try { resolve({ status: response.statusCode ?? 500, value: bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined }); }
          catch { reject(new ExecutionHostError('execution_docker_invalid_response', 502)); }
        });
      });
      req.once('error', fail); req.once('timeout', () => { fail(); req.destroy(); }); req.end(encoded);
    });
  }
  const inspectSchema = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/), Name: z.string(),
    AppArmorProfile: z.string(),
    State: z.object({ Running: z.boolean(), Paused: z.boolean(), Restarting: z.boolean(), Dead: z.boolean(), Pid: z.number().int().nonnegative(), Status: z.string().max(30) }),
    Config: z.object({ Labels: z.record(z.string(), z.string()), User: z.string() }),
    HostConfig: z.object({ RestartPolicy: z.object({ Name: z.string() }), Privileged: z.boolean(), PidMode: z.string(),
      NetworkMode: z.string(), PortBindings: z.record(z.string(), z.unknown()).nullable(), AutoRemove: z.boolean(),
      ReadonlyRootfs: z.boolean(), CapAdd: z.array(z.string()).nullable(), CapDrop: z.array(z.string()).nullable(), SecurityOpt: z.array(z.string()).nullable() }),
  });
  function proof(value: unknown): ContainerProof {
    const row = inspectSchema.safeParse(value);
    if (!row.success) throw new ExecutionHostError('execution_container_invalid', 502);
    const container = row.data;
    if ((containerId && container.Id !== containerId) || container.Name !== '/' + name ||
      Object.entries(labels).some(([key, value]) => container.Config.Labels[key] !== value) ||
      (sandboxPolicy === 'codex-bwrap-v1' && container.AppArmorProfile !== '') ||
      container.Config.User !== config.user || !container.HostConfig.ReadonlyRootfs ||
      (container.HostConfig.CapAdd?.length ?? 0) !== 0 || JSON.stringify(container.HostConfig.CapDrop) !== JSON.stringify(['ALL']) ||
      JSON.stringify([...(container.HostConfig.SecurityOpt ?? [])].sort()) !== JSON.stringify([...securityOptions].sort()) ||
      container.HostConfig.RestartPolicy.Name !== 'no' || container.HostConfig.Privileged || container.HostConfig.PidMode ||
      container.HostConfig.AutoRemove || !['none', 'bridge'].includes(container.HostConfig.NetworkMode) ||
      Object.keys(container.HostConfig.PortBindings ?? {}).length || container.State.Paused || container.State.Restarting || container.State.Dead)
      throw new ExecutionHostError('execution_container_identity_changed');
    containerId = container.Id;
    return { id: container.Id, groupId, generation, configurationDigest, running: container.State.Running, pid: container.State.Pid, status: container.State.Status };
  }
  async function exclusiveContainer() {
    const filters = encodeURIComponent(JSON.stringify({ label: ['zhongshu.execution.group=' + groupId] }));
    const result = await call('GET', '/containers/json?all=1&limit=2&filters=' + filters);
    const rows = z.array(z.object({ Id: z.string(), Names: z.array(z.string()) })).max(2).safeParse(result.value);
    if (result.status !== 200 || !rows.success || rows.data.length > 1 || rows.data.some(row => !row.Names.includes('/' + name)))
      throw new ExecutionHostError('execution_group_container_conflict');
  }
  async function inspect(): Promise<ContainerProof> {
    if (sandboxPolicy === 'codex-bwrap-v1') await validateSandboxEnvironment();
    await exclusiveContainer();
    const result = await call('GET', '/containers/' + encodeURIComponent(containerId ?? name) + '/json');
    if (result.status !== 200) throw new ExecutionHostError('execution_container_missing', 503);
    return proof(result.value);
  }
  async function validateSandboxEnvironment() {
    const version = await call('GET', '/version');
    if (version.status !== 200 || !z.object({ Os: z.literal('linux') }).safeParse(version.value).success) throw new ExecutionHostError('execution_linux_docker_required');
    if (sandboxPolicy !== 'codex-bwrap-v1') return;
    if (!z.object({ Arch: z.enum(codexSandboxArchitectures) }).safeParse(version.value).success) throw new ExecutionHostError('execution_codex_sandbox_arch_unsupported');
    const info = await call('GET', '/info');
    const security = z.object({ SecurityOptions: z.array(z.string().max(1024)).max(128) }).safeParse(info.value);
    if (info.status !== 200 || !security.success) throw new ExecutionHostError('execution_docker_security_unknown', 503);
    if (!security.data.SecurityOptions.some(value => /^name=seccomp(?:,|$)/.test(value))) throw new ExecutionHostError('execution_seccomp_required');
    // Docker's default AppArmor policy denies mount even when seccomp permits
    // the native sandbox. Never silently disable an additional host policy.
    if (security.data.SecurityOptions.some(value => /^name=(?:apparmor|selinux)(?:,|$)/.test(value))) throw new ExecutionHostError('execution_codex_lsm_policy_unsupported');
    if (security.data.SecurityOptions.some(value => !/^name=(?:seccomp|rootless|cgroupns|no-new-privileges)(?:,|$)/.test(value))) throw new ExecutionHostError('execution_docker_security_unknown', 503);
  }
  return {
    inspect,
    async prepare() {
      await validateSandboxEnvironment();
      await exclusiveContainer();
      const existing = await call('GET', '/containers/' + name + '/json');
      if (existing.status === 200) return proof(existing.value);
      if (existing.status !== 404) throw new ExecutionHostError('execution_docker_unavailable', 503);
      const protectedTargets = [await realpath(config.socketPath), ...await Promise.all(protectedPaths.map(value => realpath(value)))];
      for (const mount of config.mounts) {
        if (mount.volume) {
          const volume = await call('GET', '/volumes/' + encodeURIComponent(mount.volume.name));
          const value = z.object({ Name: z.string(), Driver: z.literal('local'), Scope: z.literal('local'), Mountpoint: path, Options: z.record(z.string(), z.string()).nullable() }).safeParse(volume.value);
          if (volume.status !== 200 || !value.success || value.data.Name !== mount.volume.name || Object.keys(value.data.Options ?? {}).length || join(value.data.Mountpoint, mount.volume.subpath) !== mount.source) throw new ExecutionHostError('execution_volume_identity_changed');
        }
        const canonical = await realpath(mount.source);
        if (canonical !== mount.source || !(await stat(canonical)).isDirectory() || protectedTargets.some(target => { const rest = relative(canonical, target); return rest !== '..' && !rest.startsWith('../') && !isAbsolute(rest); }) || mount.target === '/var/run/docker.sock' || mount.target === '/run/docker.sock')
          throw new ExecutionHostError('execution_mount_invalid');
      }
      const created = await call('POST', '/containers/create?name=' + name, {
        Image: config.image, Entrypoint: [config.argv[0]], Cmd: config.argv.slice(1), User: config.user,
        Env: Object.entries(config.environment).map(([key, value]) => key + '=' + value), Labels: labels,
        Healthcheck: { Test: ['NONE'] },
        HostConfig: { RestartPolicy: { Name: 'no' }, AutoRemove: false, Privileged: false, ReadonlyRootfs: true, Init: true,
          CapDrop: ['ALL'], SecurityOpt: securityOptions, NetworkMode: config.network, PidsLimit: config.pids,
          Memory: config.memoryBytes, MemorySwap: config.memoryBytes, NanoCpus: Math.floor(config.cpus * 1e9),
          Mounts: config.mounts.map(mount => mount.volume
            ? { Type: 'volume', Source: mount.volume.name, Target: mount.target, ReadOnly: mount.readOnly, VolumeOptions: { NoCopy: true, Subpath: mount.volume.subpath } }
            : { Type: 'bind', Source: mount.source, Target: mount.target, ReadOnly: mount.readOnly, BindOptions: { Propagation: 'rprivate' } }),
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=67108864,mode=1777' }, LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '2' } },
        },
      });
      if (created.status !== 201) throw new ExecutionHostError('execution_container_create_unknown', 503);
      containerId = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(created.value).Id;
      return await inspect();
    },
    async start() {
      await inspect();
      const result = await call('POST', '/containers/' + containerId + '/start');
      if (![204, 304].includes(result.status)) throw new ExecutionHostError('execution_container_start_unknown', 503);
      const state = await inspect();
      if (!state.running || state.pid === 0) throw new ExecutionHostError('execution_container_start_unknown', 503);
      return state;
    },
    async quiesce() {
      await inspect();
      const result = await call('POST', '/containers/' + containerId + '/stop?t=10');
      if (![204, 304].includes(result.status)) throw new ExecutionHostError('execution_container_stop_unknown', 503);
      const state = await inspect();
      if (state.running || state.pid !== 0 || !['created', 'exited'].includes(state.status)) throw new ExecutionHostError('execution_container_stop_unknown', 503);
      return state;
    },
  };
}

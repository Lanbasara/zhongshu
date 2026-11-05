import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { createDockerExecutionHost, dockerHostConfigurationSchema, dockerHostDigest, hostDigest } from '../src/server/execution-host-docker.ts';
import { codexSeccompJson, codexSeccompDigest, type DockerSandboxPolicy } from '../src/server/execution-sandbox-policy.ts';

async function dockerPeer(t: TestContext, policy: DockerSandboxPolicy = 'codex-bwrap-v1') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zh-policy-')));
  const data = join(root, 'data'); await mkdir(data, { mode: 0o700 });
  const socketPath = join(root, 's');
  const createSchema = z.object({ User: z.string(), Labels: z.record(z.string(), z.string()), HostConfig: z.object({
    SecurityOpt: z.array(z.string()), ReadonlyRootfs: z.boolean(), CapDrop: z.array(z.string()),
  }).passthrough() }).passthrough();
  let created: z.infer<typeof createSchema> | undefined, name = '';
  const state = { arch: 'arm64', security: ['name=seccomp,profile=builtin'], creates: 0, requests: [] as string[],
    mutate: (_value: Record<string, unknown>) => {} };
  const server = createServer(async (request, response) => {
    const endpoint = new URL(request.url!, 'http://localhost'); state.requests.push(endpoint.pathname);
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    try {
      if (endpoint.pathname === '/v1.47/version') return send(200, { Os: 'linux', Arch: state.arch });
      if (endpoint.pathname === '/v1.47/info') return send(200, { SecurityOptions: state.security });
      if (endpoint.pathname === '/v1.47/containers/json') return send(200, created ? [{ Id: 'a'.repeat(64), Names: ['/' + name] }] : []);
      if (endpoint.pathname === '/v1.47/containers/create') {
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 256 * 1024) return send(413, {}); chunks.push(chunk); }
        created = createSchema.parse(JSON.parse(Buffer.concat(chunks).toString())); name = endpoint.searchParams.get('name')!; state.creates++;
        return send(201, { Id: 'a'.repeat(64) });
      }
      if (endpoint.pathname.endsWith('/json')) {
        if (!created) return send(404, {});
        const value = { Id: 'a'.repeat(64), Name: '/' + name,
          State: { Running: false, Paused: false, Restarting: false, Dead: false, Pid: 0, Status: 'created' },
          Config: { Labels: created.Labels, User: created.User },
          HostConfig: { ...created.HostConfig, PidMode: '', PortBindings: null, CapAdd: null },
        };
        state.mutate(value); return send(200, value);
      }
      return send(404, {});
    } catch { return send(500, { error: 'synthetic_docker_peer_invalid_request' }); }
  });
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const config = dockerHostConfigurationSchema.parse({ socketPath, ownershipPort: 39111, image: 'sha256:' + 'b'.repeat(64),
    argv: ['/usr/local/bin/node', '/runtime/native.js'], user: '1000:1000', mounts: [{ source: data, target: '/data', kind: 'data' }] });
  return { state, config, payload: () => created!, runtime: createDockerExecutionHost(config, 'synthetic', 'generation', [], undefined, policy) };
}

test('managed Codex sends the fixed deny-by-default native sandbox policy and includes it in durable identity', async t => {
  const f = await dockerPeer(t); const proof = await f.runtime.prepare(); const payload = f.payload();
  assert.equal(proof.configurationDigest, dockerHostDigest(f.config, undefined, 'codex-bwrap-v1'));
  assert.notEqual(proof.configurationDigest, dockerHostDigest(f.config));
  assert.equal(dockerHostDigest(f.config), hostDigest(f.config), 'default DSH identity stays compatible');
  assert.deepEqual(payload.HostConfig.SecurityOpt, ['no-new-privileges:true', 'seccomp=' + codexSeccompJson]);
  assert.equal(payload.HostConfig.ReadonlyRootfs, true); assert.deepEqual(payload.HostConfig.CapDrop, ['ALL']);
  assert.equal(payload.User, '1000:1000'); assert.equal(f.state.creates, 1);
  assert.match(codexSeccompDigest, /^[a-f0-9]{64}$/);
  const profile = JSON.parse(codexSeccompJson);
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  assert.ok(profile.syscalls.some((rule: { names: string[]; action: string; errnoRet?: number }) => rule.names.includes('clone3') && rule.action === 'SCMP_ACT_ERRNO' && rule.errnoRet === 38));
});

test('container proof rejects a changed sandbox, root user, extra capability or writable root even with original identity labels', async t => {
  const f = await dockerPeer(t); await f.runtime.prepare();
  for (const change of [
    { field: 'SecurityOpt', value: ['no-new-privileges:true', 'seccomp=unconfined'] },
    { field: 'ReadonlyRootfs', value: false }, { field: 'CapAdd', value: ['SYS_ADMIN'] }, { field: 'CapDrop', value: [] },
  ]) {
    f.state.mutate = value => { (value.HostConfig as Record<string, unknown>)[change.field] = change.value; };
    await assert.rejects(f.runtime.inspect(), { code: 'execution_container_identity_changed' });
  }
  f.state.mutate = value => { (value.Config as Record<string, unknown>).User = '0:0'; };
  await assert.rejects(f.runtime.inspect(), { code: 'execution_container_identity_changed' });
  f.state.mutate = () => {}; assert.equal((await f.runtime.inspect()).pid, 0);
});

test('unsupported namespace ABI, absent seccomp and unvalidated default LSM policy fail before container creation', async t => {
  const f = await dockerPeer(t);
  f.state.arch = 's390x'; await assert.rejects(f.runtime.prepare(), { code: 'execution_codex_sandbox_arch_unsupported' });
  f.state.arch = 'arm64'; f.state.security = []; await assert.rejects(f.runtime.prepare(), { code: 'execution_seccomp_required' });
  for (const lsm of ['apparmor', 'selinux']) {
    f.state.security = ['name=seccomp,profile=builtin', 'name=' + lsm];
    await assert.rejects(f.runtime.prepare(), { code: 'execution_codex_lsm_policy_unsupported' });
  }
  assert.equal(f.state.creates, 0);
});

test('DSH retains Docker default policy and does not disable or reject its existing host LSM', async t => {
  const f = await dockerPeer(t, 'docker-default'); f.state.security.push('name=apparmor'); f.state.arch = 's390x';
  await f.runtime.prepare(); assert.deepEqual(f.payload().HostConfig.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(f.state.requests.includes('/v1.47/info'), false);
});

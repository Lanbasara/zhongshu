import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

// Run only against a disposable, already-started Compose test project. The host-side
// HTTP requests exercise the internal loopback hop behind TLS termination; production
// HTTPS Origin checks and Secure cookies remain enabled. No browser/TLS claim is made.
// Override the project with ZHONGSHU_CHECK_PROJECT=zhongshu-check-<suffix>.
const projectInput = z.string().regex(/^zhongshu-check(?:-[a-z0-9][a-z0-9_-]{0,40})?$/);
const containerId = z.string().regex(/^[a-f0-9]{12,64}$/);
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sessionBody = z.object({ authenticated: z.boolean(), initialized: z.boolean().optional(), csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(), expiresAt: z.number().int().positive().optional() });
const inspectSchema = z.array(z.object({
  Id: containerId, Image: imageId,
  Config: z.object({ User: z.string(), Env: z.array(z.string()).max(200), Labels: z.record(z.string(), z.string()) }),
  State: z.object({ Running: z.boolean() }),
  Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string(), RW: z.boolean() })).max(32),
  NetworkSettings: z.object({ Ports: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable()) }),
})).length(1);

class CheckFailure extends Error {
  constructor(category) { super(category); this.category = category; }
}
const ensure = (condition, category) => { if (!condition) throw new CheckFailure(category); };
const passed = category => process.stdout.write(`PASS ${category}\n`);
const interruption = new AbortController();
const children = new Set();
function interrupt() { if (interruption.signal.aborted) return; interruption.abort(); for (const child of children) child.kill('SIGTERM'); }
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);

function docker(args, { input, timeout = 30000, cleanup = false } = {}) {
  if (interruption.signal.aborted && !cleanup) return Promise.reject(new CheckFailure('interrupted'));
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] }); children.add(child);
    let output = ''; let count = 0; let failed = false; let done = false; let forced;
    const terminate = () => { failed = true; child.kill('SIGTERM'); forced ??= setTimeout(() => child.kill('SIGKILL'), 1000); };
    const timer = setTimeout(terminate, timeout);
    child.stdout.on('data', bytes => { count += bytes.length; if (count > 512 * 1024) terminate(); else output += bytes.toString(); });
    // Native diagnostics may contain secrets. Consume bounded stderr, never replay it.
    child.stderr.on('data', bytes => { count += bytes.length; if (count > 512 * 1024) terminate(); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const finish = (error, code) => {
      if (done) return; done = true; clearTimeout(timer); if (forced) clearTimeout(forced); children.delete(child);
      if (error || failed || code !== 0) reject(new CheckFailure('docker_command_failed')); else resolve(output.trim());
    };
    child.once('error', error => finish(error)); child.once('close', code => finish(null, code));
  });
}

async function http(base, path, { method = 'GET', cookie, origin, password } = {}) {
  try {
    const response = await fetch(new URL(path, base), {
      method, redirect: 'manual', signal: AbortSignal.any([interruption.signal, AbortSignal.timeout(10000)]),
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...(password ? { 'Content-Type': 'application/json' } : {}) },
      ...(password ? { body: JSON.stringify({ password }) } : {}),
    });
    const reader = response.body?.getReader(); ensure(reader, 'http_body_missing');
    const chunks = []; let length = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 65536) { await reader.cancel(); throw new CheckFailure('http_body_too_large'); } chunks.push(part.value); } }
    finally { reader.releaseLock(); }
    return { status: response.status, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
  } catch (error) { if (error instanceof CheckFailure) throw error; throw new CheckFailure('http_request_failed'); }
}

async function inspected(id) { return inspectSchema.parse(JSON.parse(await docker(['inspect', id])))[0]; }
function loopbackBase(info) {
  const bindings = info.NetworkSettings.Ports['3000/tcp']; ensure(bindings?.length === 1, 'single_test_port_required');
  const binding = bindings[0]; ensure(['127.0.0.1', '::1'].includes(binding.HostIp), 'loopback_port_required');
  const port = z.coerce.number().int().min(1).max(65535).parse(binding.HostPort);
  return `http://${binding.HostIp === '::1' ? '[::1]' : binding.HostIp}:${port}`;
}
async function healthy(base) {
  const until = Date.now() + 60000;
  while (Date.now() < until && !interruption.signal.aborted) {
    try { const result = await http(base, '/api/health'); if (result.status === 200 && result.body.status === 'ok') return; } catch { /* retry this bounded health observation only */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new CheckFailure('container_health_timeout');
}
async function privateIdentity(base, cookie) {
  const result = await http(base, '/api/private/identity', { cookie });
  ensure(result.status === 200, 'private_identity_denied');
  z.object({ name: z.literal('管理员'), expiresAt: z.number().int().positive() }).strict().parse(result.body);
  return result.body;
}
async function login(base, origin, password) {
  const response = await http(base, '/api/login', { method: 'POST', origin, password });
  ensure(response.status === 200, 'password_login_failed');
  const value = sessionBody.parse(response.body); ensure(value.authenticated && value.csrfToken && value.expiresAt, 'login_identity_missing');
  const cookies = response.headers.getSetCookie(); ensure(cookies.length === 1, 'single_session_cookie_required');
  const setCookie = cookies[0];
  ensure(/^__Host-zhongshu=[A-Za-z0-9_-]{43};/.test(setCookie), 'production_session_cookie_required');
  for (const flag of [/;\s*HttpOnly(?:;|$)/i, /;\s*Secure(?:;|$)/i, /;\s*SameSite=Strict(?:;|$)/i, /;\s*Path=\/(?:;|$)/i]) ensure(flag.test(setCookie), 'cookie_security_flags_missing');
  ensure(!/;\s*Domain=/i.test(setCookie), 'host_cookie_must_not_set_domain');
  return { cookie: setCookie.split(';')[0], expiresAt: value.expiresAt };
}

async function run() {
  const project = projectInput.parse(process.env.ZHONGSHU_CHECK_PROJECT ?? 'zhongshu-check');
  const compose = ['compose', '--project-name', project];
  const runId = randomUUID(); const restoreName = `${project}-restore-${runId}`;
  const workDirectory = `/data/container-check-${runId}`;
  const backupFile = `${workDirectory}/backup.sqlite`; const restoredDirectory = `${workDirectory}/restored`;
  const passwordBytes = randomBytes(48); const password = passwordBytes.toString('base64url');
  let appId; let workCreated = false; let restoredCreated = false; let failure;
  try {
    appId = containerId.parse(await docker([...compose, 'ps', '-q', 'app']));
    const original = await inspected(appId);
    ensure(original.Config.Labels['com.docker.compose.project'] === project && original.Config.Labels['com.docker.compose.service'] === 'app' && original.State.Running, 'owned_compose_app_required');
    ensure(/^[1-9][0-9]*(?::[1-9][0-9]*)?$/.test(original.Config.User), 'non_root_container_required');
    const environment = Object.fromEntries(original.Config.Env.map(value => { const equal = value.indexOf('='); return [value.slice(0, equal), value.slice(equal + 1)]; }));
    ensure(environment.NODE_ENV === 'production' && environment.ZHONGSHU_DATA_DIR === '/data' && environment.ZHONGSHU_ALLOW_HTTP_LOOPBACK !== 'true', 'production_container_configuration_required');
    const origin = new URL(environment.ZHONGSHU_ORIGIN);
    ensure(origin.protocol === 'https:' && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'production_https_origin_required');
    const dataMounts = original.Mounts.filter(mount => mount.Destination === '/data');
    ensure(dataMounts.length === 1 && dataMounts[0].Type === 'volume' && dataMounts[0].RW, 'owned_state_volume_required');
    const volume = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,200}$/).parse(dataMounts[0].Name);
    const volumeInfo = z.array(z.object({ Labels: z.record(z.string(), z.string()) })).length(1).parse(JSON.parse(await docker(['volume', 'inspect', volume])))[0];
    ensure(volumeInfo.Labels['com.docker.compose.project'] === project && volumeInfo.Labels['com.docker.compose.volume'] === 'state', 'owned_state_volume_required');
    let base = loopbackBase(original); await healthy(base);
    const initial = await http(base, '/api/session'); const initialBody = sessionBody.parse(initial.body);
    ensure(initial.status === 200 && initialBody.authenticated === false && initialBody.initialized === false, 'fresh_uninitialized_test_volume_required');
    ensure((await http(base, '/api/private/identity')).status === 401, 'anonymous_private_access_not_denied');
    passed('uninitialized_private_boundary');

    await docker(['exec', '-i', appId, 'node', 'dist/server/admin.js', 'init', '--password-stdin'], { input: Buffer.from(password) });
    const first = await login(base, origin.origin, password);
    const identity = await privateIdentity(base, first.cookie); ensure(identity.expiresAt === first.expiresAt, 'identity_session_mismatch');
    passed('production_cli_login_cookie_and_private_identity');

    await docker([...compose, 'up', '-d', '--force-recreate', '--no-deps', '--wait', '--wait-timeout', '60', 'app'], { timeout: 90000 });
    const replacementId = containerId.parse(await docker([...compose, 'ps', '-q', 'app'])); ensure(replacementId !== appId, 'app_was_not_recreated'); appId = replacementId;
    const replacement = await inspected(appId); ensure(replacement.Image === original.Image && replacement.Config.Labels['com.docker.compose.project'] === project, 'recreated_image_or_project_changed');
    base = loopbackBase(replacement); await healthy(base);
    const persisted = await privateIdentity(base, first.cookie); ensure(persisted.expiresAt === first.expiresAt, 'valid_session_did_not_survive_recreation');
    passed('forced_recreation_preserves_existing_session');

    await docker(['exec', appId, 'node', '--input-type=module', '-e', 'import {mkdirSync} from "node:fs"; mkdirSync(process.argv[1], {mode:0o700});', workDirectory]); workCreated = true;
    await Promise.all([docker(['exec', appId, 'node', 'dist/server/admin.js', 'backup', backupFile]), privateIdentity(base, first.cookie)]);
    await docker(['exec', appId, 'node', 'dist/server/admin.js', 'restore', backupFile, '--data-dir', restoredDirectory]);
    passed('online_backup_and_fresh_directory_restore');

    // The second instance uses only this test project's volume and a unique directory.
    restoredCreated = true;
    const restoredId = containerId.parse(await docker(['run', '-d', '--name', restoreName, '--label', `org.zhongshu.container-check=${runId}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:size=16m,mode=1777', '--memory', '256m', '--cpus', '0.5', '--pids-limit', '64', '--user', original.Config.User, '--mount', `type=volume,source=${volume},target=/data`, '--env', `ZHONGSHU_ORIGIN=${origin.origin}`, '--env', `ZHONGSHU_DATA_DIR=${restoredDirectory}`, '--publish', '127.0.0.1::3000', original.Image]));
    const restored = await inspected(restoredId); ensure(restored.Config.Labels['org.zhongshu.container-check'] === runId, 'restore_container_ownership_mismatch');
    const restoredBase = loopbackBase(restored); await healthy(restoredBase);
    ensure((await http(restoredBase, '/api/private/identity', { cookie: first.cookie })).status === 401, 'restored_old_session_not_revoked');
    const restoredStatus = sessionBody.parse((await http(restoredBase, '/api/session')).body); ensure(restoredStatus.initialized === true && restoredStatus.authenticated === false, 'restored_administrator_missing');
    const second = await login(restoredBase, origin.origin, password); ensure(second.cookie !== first.cookie, 'restore_did_not_issue_new_session');
    await privateIdentity(restoredBase, second.cookie);
    ensure((await http(restoredBase, '/api/private/identity', { cookie: first.cookie })).status === 401, 'restored_old_session_resurrected');
    await privateIdentity(base, first.cookie);
    passed('restore_revokes_old_session_and_preserves_password');
  } catch (error) { failure = error instanceof CheckFailure ? error : new CheckFailure('container_contract_validation_failed'); }
  finally {
    passwordBytes.fill(0);
    try {
      if (restoredCreated) {
        const owned = await docker(['ps', '-aq', '--filter', `label=org.zhongshu.container-check=${runId}`], { cleanup: true });
        const ids = owned ? owned.split(/\s+/).map(id => containerId.parse(id)) : [];
        ensure(ids.length <= 1, 'restore_cleanup_ownership_ambiguous');
        for (const id of ids) await docker(['rm', '-f', id], { cleanup: true });
      }
      if (workCreated && appId) await docker(['exec', appId, 'node', '--input-type=module', '-e', 'import {rmSync} from "node:fs"; import {dirname,basename} from "node:path"; const p=process.argv[1]; if(dirname(p)!=="/data" || !/^container-check-[0-9a-f-]{36}$/.test(basename(p))) process.exit(2); rmSync(p,{recursive:true,force:true});', workDirectory], { cleanup: true });
      passed('owned_restore_resources_cleaned');
    } catch { failure ??= new CheckFailure('owned_resource_cleanup_failed'); }
  }
  if (failure) throw failure;
  passed('container_lifecycle');
}

try { await run(); }
catch (error) { process.stderr.write(`FAIL ${error instanceof CheckFailure ? error.category : 'container_check_configuration_invalid'}\n`); process.exitCode = 1; }
finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }

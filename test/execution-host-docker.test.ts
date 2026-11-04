import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createDockerExecutionHost, dockerHostConfigurationSchema, hostDigest } from '../src/server/execution-host-docker.ts';
import { createExecutionHostLedger } from '../src/server/execution-host-ledger.ts';
import { acquireExecutionHostOwnership, ExecutionHost } from '../src/server/execution-host.ts';

const socketPath = process.env.ZHONGSHU_TEST_DOCKER_SOCKET;
const image = process.env.ZHONGSHU_TEST_DOCKER_IMAGE;
// Explicit opt-in uses only a temporary labeled container and synthetic mounts.
// The image must provide /usr/local/bin/node and be pinned by digest; no pull,
// login, real Harness credentials or existing container is part of this test.
test('Docker quiescence stops an independent writer and restart retains the same container/data', {
  skip: !socketPath || !image || !process.getuid?.(), timeout: 30_000,
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zhongshu-docker-host-')));
  const data = join(root, 'native-data'); await mkdir(data, { mode: 0o700 });
  const owner = await acquireExecutionHostOwnership(0);
  const childProgram = "const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync('/data/writes','write\\n'),20)";
  const program = `const fs=require('node:fs');const {spawn}=require('node:child_process');
    if(!fs.existsSync('/data/binding'))fs.writeFileSync('/data/binding','SYNTHETIC_PERSISTENT_BINDING');
    fs.appendFileSync('/data/boots','boot\\n');
    spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{detached:true,stdio:'ignore'}).unref();
    process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
  const config = dockerHostConfigurationSchema.parse({ socketPath, image, ownershipPort: owner.port, argv: ['/usr/local/bin/node', '-e', program],
    mounts: [{ source: data, target: '/data', kind: 'data' }], user: process.getuid!() + ':' + process.getgid!(), network: 'none' });
  const groupId = 'synthetic-' + randomUUID();
  const ledger = createExecutionHostLedger({ directory: join(root, 'ledger'), groupId, configurationDigest: hostDigest(config) }); await ledger.ready;
  const generation = (await ledger.load()).state.generation;
  const runtime = createDockerExecutionHost(config, groupId, generation, [join(root, 'ledger')]);
  let containerId: string | undefined;
  async function docker(method: string, endpoint: string, body?: unknown) {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    return await new Promise<number>((resolve, reject) => {
      const req = request({ socketPath, method, path: '/v1.47' + endpoint, headers: encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}, timeout: 5000 }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode!)); res.once('error', reject);
      }); req.once('error', reject); req.once('timeout', () => req.destroy(new Error('synthetic_docker_timeout'))); req.end(encoded);
    });
  }
  const host = new ExecutionHost(ledger, runtime, { async ready() {}, async invoke() { throw new Error('no synthetic native dispatch needed'); } }, {
    async resolve() { throw new Error('no business operation'); }, async authorize() { throw new Error('no business operation'); }, async onBound() {}, async drained() { return true; },
  }, owner);
  t.after(async () => {
    await host.close();
    if (containerId) { await docker('POST', '/containers/' + containerId + '/update', { RestartPolicy: { Name: 'no' } }).catch(() => {}); await docker('DELETE', '/containers/' + containerId + '?force=1').catch(() => {}); }
    await rm(root, { recursive: true, force: true });
  });
  await host.bootstrap(); containerId = (await runtime.inspect()).id;
  for (let attempt = 0; attempt < 100; attempt++) { if (await readFile(join(data, 'writes'), 'utf8').catch(() => '') !== '') break; await delay(20); }
  const before = await readFile(join(data, 'writes'), 'utf8'); assert.ok(before.length > 0);
  const frozenSetId = hostDigest('synthetic empty pending set');
  assert.equal((await host.controller.fence({ requestId: 'fence', expected: { generation, epoch: 0 }, frozenSetId })).status, 'known');
  assert.equal((await host.controller.quiesce({ requestId: 'quiesce', expected: { generation, epoch: 1 }, frozenSetId })).status, 'known');
  const proof = await runtime.inspect(); assert.equal(proof.running, false); assert.equal(proof.pid, 0);
  const stopped = await readFile(join(data, 'writes'), 'utf8'); await delay(200);
  assert.equal(await readFile(join(data, 'writes'), 'utf8'), stopped, 'a detached TERM-ignoring descendant must not retain write capability');
  assert.equal(await docker('POST', '/containers/' + containerId + '/update', { RestartPolicy: { Name: 'always' } }), 200);
  assert.equal((await host.controller.inspect('tampered-restart-policy')).status, 'unknown');
  assert.equal(await docker('POST', '/containers/' + containerId + '/update', { RestartPolicy: { Name: 'no' } }), 200);
  assert.equal((await host.controller.resume({ requestId: 'resume', expected: { generation, epoch: 2 } })).status, 'known');
  assert.equal((await runtime.inspect()).id, containerId);
  assert.equal(await readFile(join(data, 'binding'), 'utf8'), 'SYNTHETIC_PERSISTENT_BINDING');
  for (let attempt = 0; attempt < 100; attempt++) { if ((await readFile(join(data, 'writes'), 'utf8')).length > stopped.length) break; await delay(20); }
  assert.ok((await readFile(join(data, 'writes'), 'utf8')).length > stopped.length);
});

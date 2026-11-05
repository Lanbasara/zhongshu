import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Node exercises the installed page hook against real HTTP. Real DOM behavior is
// verified separately through E04, not inferred from this small browser surface.
const { installBrowserFaults } = await import(new URL('./support/browser-faults.js', import.meta.url).href);

test('permanent E04 controls reject once, preserve native state and reach real HTTP validation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-e04-test-'));
  const checkout = join(root, 'checkout'); const runtime = join(root, 'runtime');
  mkdirSync(join(checkout, 'test/support'), { recursive: true }); mkdirSync(runtime, { mode: 0o700 });
  const repository = fileURLToPath(new URL('../', import.meta.url));
  // The CLI requires built assets. A tiny static fixture keeps this HTTP test
  // independent of a prior build, while copying the unmodified CLI under test.
  copyFileSync(join(repository, 'test/support/feature-fixture.ts'), join(checkout, 'test/support/feature-fixture.ts'));
  copyFileSync(join(repository, 'test/support/managed-ui-fixture.ts'), join(checkout, 'test/support/managed-ui-fixture.ts'));
  cpSync(join(repository, 'src'), join(checkout, 'src'), { recursive: true });
  symlinkSync(join(repository, 'node_modules'), join(checkout, 'node_modules'), 'dir');
  writeFileSync(join(checkout, 'package.json'), '{"type":"module"}');
  mkdirSync(join(checkout, 'dist/public'), { recursive: true });
  writeFileSync(join(checkout, 'dist/public/index.html'), '<!doctype html><title>E04 HTTP fixture</title>');
  writeFileSync(join(checkout, 'dist/version.json'), JSON.stringify({ name: 'zhongshu', version: '0.1.0', revision: 'development' }));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const script = join(checkout, 'test/support/feature-fixture.ts');
  const child = spawn(process.execPath, [script, 'serve', '--root', runtime, '--port', String(port)], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await exited; } finally { clearTimeout(timeout); }
    }
    rmSync(root, { recursive: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('fixture_ready_timeout')), 10_000);
    let output = '';
    child.once('error', reject); child.once('exit', () => { clearTimeout(timeout); reject(new Error('fixture_exited_before_ready')); });
    child.stdout.on('data', bytes => {
      output += String(bytes);
      if (output.includes('"event":"ready"')) { clearTimeout(timeout); resolve(); }
    });
  });
  const control = (command: string, title?: string) => {
    const result = spawnSync(process.execPath, [script, command, '--root', runtime, ...(title ? ['--title', title] : [])], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stdout); return JSON.parse(result.stdout);
  };
  control('init');
  const origin = `http://127.0.0.1:${port}`;
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: readFileSync(join(runtime, 'private/password'), 'utf8') }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const session = await fetch(origin + '/api/session', { headers: { cookie } }).then(r => r.json());
  const headers = { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken };
  const api = origin + '/api/private/workbench';
  const post = (path: string, body: unknown) => fetch(api + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const snapshot = (id: string) => fetch(api + '/conversations/' + id, { headers: { cookie } }).then(r => r.json());
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (!await check()) { if (Date.now() > deadline) throw new Error('E04_state_timeout'); await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  async function create(harnessId: string) {
    const id = randomUUID(); const title = 'E04-' + id;
    assert.equal((await post('/conversations', { id, title, harnessId, workspaceId: 'a', configuration: { modelId: 'fixture-model', permissionId: 'fixture-write' } })).status, 202);
    await until(async () => (await snapshot(id)).conversation.readiness === 'ready'); return { id, title };
  }
  const message = (id = randomUUID()) => ({ id, type: 'message', payload: { text: 'Synthetic E04 input' } });

  await t.test('reject-next arming is silent, rejection is durable and a new operation recovers on both adapters', async () => {
    for (const harness of ['codex', 'dsh']) {
      const { id, title } = await create(harness); const before = control('inspect', title)[0];
      control('reject-next', title); const armed = control('inspect', title)[0];
      assert.equal(armed.revision, before.revision); assert.equal(armed.nextReceipt, 'rejected');
      assert.deepEqual(armed.state, before.state);
      const rejected = message(); assert.equal((await post(`/conversations/${id}/operations`, rejected)).status, 202);
      await until(async () => (await snapshot(id)).operations.some((op: { id: string; status: string }) => op.id === rejected.id && op.status === 'rejected'));
      const after = control('inspect', title)[0];
      assert.equal(after.submitCalls, 1); assert.deepEqual(after.rejectedOperationIds, [rejected.id]);
      assert.deepEqual(after.operationIds, []); assert.equal(after.historyCount, 0);
      assert.deepEqual(after.state, before.state); assert.equal(after.nextReceipt, 'accepted');
      assert.equal((await post(`/conversations/${id}/operations`, rejected)).status, 202);
      assert.equal(control('inspect', title)[0].submitCalls, 1);
      const edited = message(); edited.payload.text = 'Edited synthetic E04 input';
      await post(`/conversations/${id}/operations`, edited);
      await until(async () => (await snapshot(id)).operations.some((op: { id: string; status: string }) => op.id === edited.id && op.status === 'accepted'));
      const accepted = control('inspect', title)[0];
      assert.equal(accepted.submitCalls, 2); assert.deepEqual(accepted.operationIds, [edited.id]);
      assert.deepEqual(accepted.rejectedOperationIds, [rejected.id]); assert.equal(accepted.historyCount, 1);
      assert.equal(accepted.state.status, 'running');
    }
  });

  await t.test('page request faults cause real 400/413 once and leave ordinary requests and receipts intact', async () => {
    const saved = new Map(['window', 'location', 'Storage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    class SyntheticStorage { setItem() {} }
    const pageWindow: { fetch: typeof fetch; zhVerify?: any } = { fetch: ((url: string, options?: RequestInit) => fetch(new URL(url, origin), options)) as typeof fetch };
    Object.defineProperty(globalThis, 'window', { value: pageWindow, configurable: true });
    Object.defineProperty(globalThis, 'location', { value: new URL(origin), configurable: true });
    Object.defineProperty(globalThis, 'Storage', { value: SyntheticStorage, configurable: true });
    try {
      installBrowserFaults(); const faults = pageWindow.zhVerify;
      assert.throws(() => faults.rejectNextRequest('/api/login', 413));
      assert.throws(() => faults.rejectNextRequest('/api/private/workbench/conversations/' + randomUUID() + '/operations', 500));
      for (const status of [400, 413]) {
        const { id, title } = await create('dsh'); const path = `/api/private/workbench/conversations/${id}/operations`;
        faults.rejectNextRequest(path, status);
        const unaffected = await pageWindow.fetch(api + '/configuration', { headers: { cookie } }); assert.equal(unaffected.status, 200);
        assert.equal(faults.status().armed, true);
        const body = message(); const encoded = JSON.stringify(body);
        const response = await pageWindow.fetch(path, { method: 'POST', headers, body: encoded });
        assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: 'invalid_request' });
        assert.equal(JSON.stringify(body), encoded); assert.equal(faults.status().armed, false);
        assert.deepEqual(faults.status().journal.at(-1), { path, method: 'POST', kind: status === 400 ? 'invalid-request' : 'oversized-request', status, id: body.id });
        assert.equal((await snapshot(id)).operations.length, 0); assert.equal(control('inspect', title)[0].submitCalls, 0);
        const next = message(); const normal = await pageWindow.fetch(path, { method: 'POST', headers, body: JSON.stringify(next) });
        assert.equal(normal.status, 202);
        await until(async () => (await snapshot(id)).operations.some((op: { id: string; status: string }) => op.id === next.id && op.status === 'accepted'));
        assert.deepEqual(control('inspect', title)[0].operationIds, [next.id]);
      }
      const { id } = await create('codex'); const path = '/api/private/workbench/conversations/' + id;
      faults.holdNext(path); const held = pageWindow.fetch(path, { headers: { cookie } });
      await until(async () => faults.status().held === path); faults.release(); assert.equal((await held).status, 200);
      const operationPath = path + '/operations'; faults.dropNext(operationPath);
      await assert.rejects(pageWindow.fetch(operationPath, { method: 'POST', headers, body: JSON.stringify(message()) }), /verification_response_lost/);
      assert.equal((await snapshot(id)).operations.length, 1);
      faults.restore(); assert.equal(pageWindow.zhVerify, undefined);
    } finally {
      pageWindow.zhVerify?.restore();
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    }
  });
});

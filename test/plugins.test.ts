import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PluginCommand, PluginEntry, PluginSourceCommand } from '../src/shared/plugins.ts';
import { buildApp } from '../src/server/app.ts';
import { createAuth } from '../src/server/auth.ts';
import { createStorageClient, StorageClientError } from '../src/server/storage-client.ts';
import type { PluginBackend } from '../src/server/plugin-backend.ts';
import { createPluginManagement } from '../src/server/plugins.ts';

test('private plugin operations fence targets and reconcile a lost receipt without redispatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-plugin-http-'));
  const origin = 'https://plugin.example';
  const password = randomBytes(32).toString('base64url');
  const nativeId = 'sample@approved';
  const record: Record<'codex' | 'dsh', { installed: boolean; sent: string[] }> = {
    codex: { installed: false, sent: [] }, dsh: { installed: false, sent: [] },
  };
  const sourceEdits: Record<'codex' | 'dsh', PluginSourceCommand[]> = { codex: [], dsh: [] };
  let loseReceipt = true;
  function backend(harness: 'codex' | 'dsh'): PluginBackend {
    const state = record[harness];
    return {
      async list() {
        const entry: PluginEntry = {
          id: nativeId, name: 'Sample', description: '', source: harness, version: '1',
          installed: state.installed, enabled: state.installed, application: 'unverified',
          actions: state.installed ? ['remove'] : ['install'],
        };
        return [entry];
      },
      async updateSource(command) { sourceEdits[harness].push(command); },
      async change(command) {
        state.sent.push(command.id);
        state.installed = command.action === 'install';
        if (loseReceipt) throw new Error('receipt lost after native change');
        return 'applied';
      },
      async recover(command) {
        return state.installed === (command.action === 'install') ? 'applied' : 'unknown';
      },
    };
  }
  async function start() {
    const storage = createStorageClient({ dataDirectory: directory });
    await storage.ready;
    const auth = createAuth(storage.auth, { audit: () => {} });
    if (!await auth.initialized()) await auth.initialize(password);
    const manager = createPluginManagement(storage.plugins, { codex: backend('codex'), dsh: backend('dsh') });
    const app = await buildApp({ authStore: storage.auth, origin, privateRoutes: async scope => { await scope.register(manager.routes, { prefix: '/workbench' }); } });
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await app.close(); await manager.close(); await storage.close(); } };
    t.after(close);
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin }, payload: { password } });
    assert.equal(login.statusCode, 200);
    const headers = { origin, cookie: login.headers['set-cookie']!.toString().split(';')[0]!, 'x-csrf-token': login.json().csrfToken as string };
    return { app, close, headers };
  }
  const base = '/api/private/workbench/plugins';
  let f = await start();
  t.after(async () => { await f.close(); await rm(directory, { recursive: true }); });
  const install: PluginCommand = { id: randomUUID(), pluginId: nativeId, action: 'install' };
  const send = (harness: string, payload: object, override?: Record<string, string>) =>
    f.app.inject({ method: 'POST', url: base + '/' + harness + '/operations', headers: { ...f.headers, ...override }, payload });
  const view = (harness: string) => f.app.inject({ method: 'GET', url: base + '/' + harness, headers: f.headers });
  assert.equal((await f.app.inject({ url: base + '/codex' })).statusCode, 401);
  const source = { action: 'add', source: 'https://raw.githubusercontent.com/author/market/main/dsh/index.json' };
  const editSource = (harness: string, headers: Record<string, string>) => f.app.inject({
    method: 'POST', url: base + '/' + harness + '/sources', headers, payload: { requestId: randomUUID(), command: harness === 'codex' ? { action: 'add', source: 'author/market' } : source },
  });
  assert.equal((await editSource('codex', { origin })).statusCode, 401);
  assert.equal((await editSource('codex', { ...f.headers, 'x-csrf-token': '' })).statusCode, 403);
  assert.equal((await editSource('dsh', f.headers)).statusCode, 202);
  assert.deepEqual(sourceEdits, { codex: [], dsh: [source] });
  assert.equal((await send('codex', install, { origin: 'https://other.example' })).statusCode, 403);
  assert.equal((await send('codex', install, { 'x-csrf-token': '' })).statusCode, 403);
  assert.equal((await send('codex', { ...install, workspaceId: 'project' })).statusCode, 400);
  assert.equal((await send('codex', { ...install, pluginId: 'gmail@openai-curated-remote' })).statusCode, 403);
  assert.deepEqual(record.codex.sent, []);
  const [first, duplicate] = await Promise.all([send('codex', install), send('codex', install)]);
  assert.equal(first.statusCode, 202);
  assert.equal(duplicate.statusCode, 202);
  assert.equal((await view('codex')).json().operation.status, 'unknown');
  assert.equal((await view('dsh')).json().entries[0].installed, false);
  assert.deepEqual(record.codex.sent, [install.id]);
  assert.equal((await send('dsh', install)).statusCode, 409);
  const remove: PluginCommand = { ...install, id: randomUUID(), action: 'remove' };
  assert.equal((await send('codex', remove)).statusCode, 409);
  assert.equal((await editSource('codex', f.headers)).statusCode, 409);
  await f.close();
  f = await start();
  assert.equal((await send('codex', install)).json().status, 'unknown');
  const reconcile = await f.app.inject({ method: 'POST', url: base + '/codex/reconcile', headers: f.headers, payload: { id: install.id } });
  assert.equal(reconcile.statusCode, 200);
  assert.equal(reconcile.json().status, 'applied');
  assert.deepEqual(record.codex.sent, [install.id]);
  loseReceipt = false;
  assert.equal((await send('codex', remove)).statusCode, 202);
  assert.equal((await view('codex')).json().entries[0].installed, false);
  assert.deepEqual(record.dsh.sent, []);
});

test('browser market inputs allow public GitHub forms and reject alternate fetch targets', async () => {
  const { githubIndex, githubRepository } = await import('../src/server/plugin-sources.ts');
  assert.equal(githubRepository('author/market').url, 'https://github.com/author/market.git');
  assert.equal(githubRepository('https://github.com/author/market.git').path, 'author/market');
  const index = 'https://raw.githubusercontent.com/author/market/main/dsh/index.json';
  assert.equal(githubIndex(index), index);
  for (const address of [
    'http://127.0.0.1/index.json', 'https://169.254.169.254/index.json',
    'https://raw.githubusercontent.com.evil.example/author/market/main/dsh/index.json',
    'https://raw.githubusercontent.com:8443/author/market/main/dsh/index.json',
    'https://a@raw.githubusercontent.com/author/market/main/dsh/index.json',
    'https://raw.githubusercontent.com/author/market/main/%2e%2e/index.json',
    index + '?token=secret',
  ]) assert.throws(() => githubIndex(address), { message: 'invalid_plugin_source' });
  for (const address of ['file:///tmp/market', '/etc', 'git@github.com:a/b', 'https://github.com/a/../b', 'https://github.com/a/b?x=1'])
    assert.throws(() => githubRepository(address), { message: 'invalid_plugin_source' });
});

test('a lost worker claim receipt never dispatches native work and an admission blocks source edits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-plugin-uncertain-'));
  const storage = createStorageClient({ dataDirectory: directory }); await storage.ready;
  const password = 'synthetic plugin worker receipt password'; const origin = 'https://plugin.example';
  await createAuth(storage.auth, { audit: () => {} }).initialize(password);
  let entered!: () => void; const atClaim = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
  let lost = false; let sent = 0; let sourceEdits = 0; let recoveries = 0;
  const backend: PluginBackend = {
    async list() { return [{ id: 'synthetic@approved', name: 'Synthetic', description: '', source: 'synthetic', version: '1', installed: false, enabled: false, application: 'unverified', actions: ['install'] }]; },
    async change() { sent++; return 'applied'; },
    async updateSource() { sourceEdits++; },
    async recover() { recoveries++; return 'unknown'; },
  };
  const manager = createPluginManagement({ ...storage.plugins, async claim(harness, input) {
    entered(); await released;
    const result = await storage.plugins.claim(harness, input);
    if (!lost) { lost = true; throw new StorageClientError('synthetic_claim_receipt_lost', 'unknown'); }
    return result;
  } }, { dsh: backend });
  const app = await buildApp({ authStore: storage.auth, origin, privateRoutes: async scope => { await scope.register(manager.routes, { prefix: '/workbench' }); } });
  t.after(async () => { release(); await app.close(); await manager.close(); await storage.close(); await rm(directory, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin }, payload: { password } });
  const headers = { origin, cookie: login.headers['set-cookie']!.toString().split(';')[0]!, 'x-csrf-token': login.json().csrfToken };
  const root = '/api/private/workbench/plugins/dsh';
  const command = { id: randomUUID(), pluginId: 'synthetic@approved', action: 'install' };
  const pending = app.inject({ method: 'POST', url: root + '/operations', headers, payload: command }).then(result => result);
  await atClaim;
  const source = await app.inject({ method: 'POST', url: root + '/sources', headers, payload: { requestId: randomUUID(), command: { action: 'add', source: 'https://raw.githubusercontent.com/author/market/main/dsh/index.json' } } });
  assert.equal(source.statusCode, 409); assert.equal(sourceEdits, 0);
  release(); assert.equal((await pending).statusCode, 503); assert.equal(sent, 0);
  const replay = await app.inject({ method: 'POST', url: root + '/operations', headers, payload: command });
  assert.equal(replay.statusCode, 202); assert.equal(sent, 0);
  const recovered = await app.inject({ method: 'POST', url: root + '/reconcile', headers, payload: { id: command.id } });
  assert.equal(recovered.statusCode, 200); assert.equal(recovered.json().status, 'unknown');
  assert.equal(recoveries, 1); assert.equal(sent, 0);
});

test('market source IDs survive an unknown receipt and expose a recovery action without repeating the effect', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-source-once-'));
  const storage = createStorageClient({ dataDirectory: directory }); await storage.ready;
  const origin = 'https://plugin.example'; const password = 'synthetic market source password';
  await createAuth(storage.auth, { audit: () => {} }).initialize(password);
  let changes = 0, recoveries = 0;
  const manager = createPluginManagement(storage.plugins, { codex: {
    async list() { return []; }, async change() { return 'failed'; }, async recover() { return 'unknown'; },
    async updateSource() { changes++; throw new Error('lost after native source effect'); },
    async recoverSource() { recoveries++; return 'applied'; },
  } });
  const app = await buildApp({ authStore: storage.auth, origin, privateRoutes: async scope => { await scope.register(manager.routes, { prefix: '/workbench' }); } });
  t.after(async () => { await app.close(); await manager.close(); await storage.close(); await rm(directory, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin }, payload: { password } });
  const headers = { origin, cookie: login.headers['set-cookie']!.toString().split(';')[0]!, 'x-csrf-token': login.json().csrfToken };
  const root = '/api/private/workbench/plugins/codex'; const payload = { requestId: randomUUID(), command: { action: 'add', source: 'synthetic/market' } };
  const send = (body: object) => app.inject({ method: 'POST', url: root + '/sources', headers, payload: body });
  assert.equal((await send({ ...payload, command: { action: 'add', source: 'http://127.0.0.1/private' } })).statusCode, 400); assert.equal(changes, 0);
  assert.equal((await send(payload)).statusCode, 202);
  const current = await app.inject({ url: root, headers }); assert.equal(current.json().sourceOperation.status, 'unknown');
  assert.equal((await send(payload)).statusCode, 202); assert.equal(changes, 1);
  assert.equal((await send({ ...payload, command: { action: 'add', source: 'different/market' } })).statusCode, 409);
  assert.equal((await send({ ...payload, requestId: randomUUID() })).statusCode, 409);
  const recovered = await app.inject({ method: 'POST', url: root + '/sources/reconcile', headers, payload: { id: payload.requestId } });
  assert.equal(recovered.statusCode, 200); assert.equal(recovered.json().sourceOperation.status, 'applied');
  assert.equal(recoveries, 1); assert.equal(changes, 1);
});

test('plugin capacity stops new changes while preserving old receipts and source reconciliation', async t => {
  const { openDatabase } = await import('../src/server/database.ts');
  const { productMigrations } = await import('../src/server/migrations.ts');
  const { createPluginStore } = await import('../src/server/plugin-store.ts');
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-plugin-capacity-')); const db = openDatabase(directory, productMigrations);
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  let usedBytes = 0; const store = createPluginStore(db, { quotaBytes: 1024 ** 2, reserveBytes: 65536, minimumFreeBytes: 0, sample: () => ({ usedBytes, freeBytes: 1024 ** 3 }) });
  const id = randomUUID(); const source = { action: 'add' as const, source: 'synthetic/market' };
  store.claimSource('codex', id, source); usedBytes = 1024 ** 2;
  store.settleSource(id, 'applied'); assert.equal(store.claimSource('codex', id, source).created, false);
  assert.throws(() => store.claimSource('codex', randomUUID(), source), { code: 'storage_capacity_reached' });
  assert.throws(() => store.claim('codex', { id: randomUUID(), pluginId: 'synthetic@market', action: 'install' }), { code: 'storage_capacity_reached' });
  assert.equal(store.findSource(id)?.status, 'applied');
});

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PluginCommand, PluginEntry, PluginSourceCommand } from '../src/shared/plugins.ts';
import { buildApp } from '../src/server/app.ts';
import { createAuth } from '../src/server/auth.ts';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
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
    const db = openDatabase(directory, productMigrations);
    const auth = createAuth(db, { audit: () => {} });
    if (!auth.initialized()) await auth.initialize(password);
    const manager = createPluginManagement(db, { codex: backend('codex'), dsh: backend('dsh') });
    const app = await buildApp({ db, origin, privateRoutes: async scope => { await scope.register(manager.routes, { prefix: '/workbench' }); } });
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await app.close(); await manager.close(); db.close(); } };
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
  const source = { action: 'add', source: 'author/market' };
  const editSource = (harness: string, headers: Record<string, string>) => f.app.inject({
    method: 'POST', url: base + '/' + harness + '/sources', headers, payload: source,
  });
  assert.equal((await editSource('codex', { origin })).statusCode, 401);
  assert.equal((await editSource('codex', { ...f.headers, 'x-csrf-token': '' })).statusCode, 403);
  assert.equal((await editSource('dsh', f.headers)).statusCode, 200);
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

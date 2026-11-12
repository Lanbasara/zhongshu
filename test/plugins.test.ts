import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PluginCommand, PluginEntry, PluginSourceCommand } from '../src/shared/plugins.ts';
import { buildApp } from '../src/server/app.ts';
import { createAuth } from '../src/server/auth.ts';
import { preservesInstalledPeers } from '../src/server/codex-plugin-host.ts';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import type { PluginBackend } from '../src/server/plugin-backend.ts';
import { createPluginManagement } from '../src/server/plugins.ts';

test('private plugin operations fence targets and reconcile a lost receipt without redispatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-plugin-http-'));
  const origin = 'https://plugin.example';
  const password = randomBytes(32).toString('base64url');
  const nativeId = 'sample@approved';
  const revision = 'a'.repeat(40);
  const release = { version: '2', revision, commit: 'b'.repeat(40) };
  let checked = false;
  let updated = false;
  const record: Record<'codex' | 'dsh', { installed: boolean; sent: string[] }> = {
    codex: { installed: false, sent: [] }, dsh: { installed: false, sent: [] },
  };
  const sourceEdits: Record<'codex' | 'dsh', PluginSourceCommand[]> = { codex: [], dsh: [] };
  let loseReceipt = true;
  function backend(harness: 'codex' | 'dsh'): PluginBackend {
    const state = record[harness];
    return {
      async list() {
        const update = harness === 'codex' && checked && state.installed && !updated ? release : undefined;
        const entry: PluginEntry = {
          id: nativeId, name: 'Sample', description: '', source: harness, version: harness === 'codex' && updated ? '2' : '1',
          installed: state.installed, enabled: state.installed, application: 'unverified',
          actions: update ? ['remove', 'update'] : state.installed ? ['remove'] : ['install'],
          update,
        };
        return [entry];
      },
      async checkUpdates() {
        checked = true;
        return { checked: 1, unavailable: 0 };
      },
      async updateSource(command) { sourceEdits[harness].push(command); },
      async change(command) {
        state.sent.push(command.id);
        if (command.action === 'update') updated = true;
        else state.installed = command.action === 'install';
        if (loseReceipt) throw new Error('receipt lost after native change');
        return 'applied';
      },
      async recover(command) {
        if (command.action === 'update') return updated && command.revision === revision ? 'applied' : 'unknown';
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
  const check = (headers: Record<string, string>) => f.app.inject({
    method: 'POST', url: base + '/codex/check-updates', headers, payload: {},
  });
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
  assert.equal((await check(f.headers)).statusCode, 409);
  await f.close();
  f = await start();
  assert.equal((await send('codex', install)).json().status, 'unknown');
  const reconcile = await f.app.inject({ method: 'POST', url: base + '/codex/reconcile', headers: f.headers, payload: { id: install.id } });
  assert.equal(reconcile.statusCode, 200);
  assert.equal(reconcile.json().status, 'applied');
  assert.deepEqual(record.codex.sent, [install.id]);
  const update: PluginCommand = { id: randomUUID(), pluginId: nativeId, action: 'update', version: release.version, revision };
  assert.equal((await check({ origin })).statusCode, 401);
  assert.equal((await check({ ...f.headers, 'x-csrf-token': '' })).statusCode, 403);
  assert.equal((await send('codex', update)).statusCode, 403);
  assert.deepEqual((await check(f.headers)).json().entries[0].update, release);
  assert.equal((await send('codex', { ...update, revision: 'c'.repeat(40) })).statusCode, 403);
  assert.equal((await send('dsh', update)).statusCode, 403);
  assert.equal((await send('codex', update)).statusCode, 202);
  assert.equal((await view('codex')).json().operation.status, 'unknown');
  await f.close();
  f = await start();
  assert.equal((await send('codex', { ...update, revision: 'c'.repeat(40) })).statusCode, 409);
  const recoveredUpdate = await f.app.inject({ method: 'POST', url: base + '/codex/reconcile', headers: f.headers, payload: { id: update.id } });
  assert.equal(recoveredUpdate.json().status, 'applied');
  assert.equal(recoveredUpdate.json().revision, revision);
  assert.equal((await view('codex')).json().entries[0].version, '2');
  assert.deepEqual(record.codex.sent, [install.id, update.id]);
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

test('a Codex marketplace advance fences other installed plugins, including disabled ones', () => {
  const installed = [{ name: 'selected', installed: true }, { name: 'peer', installed: true, enabled: false }];
  const peer = { name: 'peer', source: { sha: 'a'.repeat(40) }, policy: { installation: 'AVAILABLE' } };
  const previous = new Map([['peer', peer]]);
  assert.equal(preservesInstalledPeers(installed, previous, new Map([['peer', { ...peer }]]), 'selected'), true);
  assert.equal(preservesInstalledPeers(installed, previous, new Map(), 'selected'), false);
  assert.equal(preservesInstalledPeers(installed, previous, new Map([['peer', { ...peer, source: { sha: 'b'.repeat(40) } }]]), 'selected'), false);
  assert.equal(preservesInstalledPeers(installed, previous, new Map([['peer', { ...peer, policy: { installation: 'NOT_AVAILABLE' } }]]), 'selected'), false);
  assert.equal(preservesInstalledPeers([{ name: 'peer', installed: false }], previous, new Map(), 'selected'), true);
});

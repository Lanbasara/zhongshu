import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import { openDatabase } from '../src/server/database.ts';
import { createAuth } from '../src/server/auth.ts';
import { buildApp } from '../src/server/app.ts';
import { validOrigin, loadConfig } from '../src/server/config.ts';

test('HTTP shutdown releases a connection whose request body never finishes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-http-close-'));
  const db = openDatabase(directory);
  const origin = 'https://workbench.example';
  const app = await buildApp({ db, origin });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const socket = connect({ host: '127.0.0.1', port: address.port });
  socket.on('error', () => {});
  t.after(async () => { socket.destroy(); await app.close(); db.close(); await rm(directory, { recursive: true }); });
  await once(socket, 'connect', { signal: AbortSignal.timeout(2000) });
  const received = once(app.server, 'request', { signal: AbortSignal.timeout(2000) });
  socket.write(`POST /api/login HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: 1024\r\n\r\n{`);
  await received;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('http_close_waited_for_incomplete_body')), 1000); });
  try { await Promise.race([app.close(), deadline]); }
  finally { clearTimeout(timer); }
  assert.equal(app.server.listening, false);
});

test('sealed static encodings preserve bytes and only hashed assets receive immutable caching', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zhongshu-assets-'));
  await mkdir(join(root, 'public/assets'), { recursive: true });
  const code = Buffer.from('/* synthetic public bundle */\n'.repeat(1000));
  await writeFile(join(root, 'public/index.html'), '<!doctype html><title>synthetic</title>');
  await writeFile(join(root, 'public/assets/index-fixture123.js'), code);
  await writeFile(join(root, 'public/assets/index-fixture123.js.gz'), gzipSync(code));
  await writeFile(join(root, 'public/assets/index-fixture123.js.br'), brotliCompressSync(code));
  const db = openDatabase(join(root, 'data'));
  const app = await buildApp({ db, origin: 'http://127.0.0.1:4391', assetsDirectory: join(root, 'public') });
  t.after(async () => { await app.close(); db.close(); await rm(root, { recursive: true }); });
  for (const encoding of ['gzip', 'br']) {
    const response = await app.inject({ url: '/assets/index-fixture123.js', headers: { 'accept-encoding': encoding } });
    assert.equal(response.statusCode, 200); assert.equal(response.headers['content-encoding'], encoding);
    assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(String(response.headers.vary), /accept-encoding/i);
    assert.deepEqual(encoding === 'gzip' ? gunzipSync(response.rawPayload) : brotliDecompressSync(response.rawPayload), code);
  }
  assert.equal((await app.inject('/')).headers['cache-control'], 'no-store');
  const session = await app.inject({ url: '/api/session', headers: { 'accept-encoding': 'gzip, br' } });
  assert.equal(session.headers['cache-control'], 'no-store'); assert.equal(session.headers['content-encoding'], undefined);
});

test('private HTTP lifecycle: origin, CSRF, two sessions, logout and reset', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-http-'));
  const db = openDatabase(directory);
  const auth = createAuth(db, { audit: () => {} });
  const password = 'synthetic-test-password-only';
  await auth.initialize(password);
  const origin = 'https://workbench.example';
  const app = await buildApp({ db, origin });
  t.after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true }); });
  const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const post = (url: string, payload: object, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, headers: { origin, ...headers }, payload });
  assert.equal((await get('/api/private/identity')).statusCode, 401);
  assert.equal((await get('/api/private/identity', '__Host-zhongshu=forged')).statusCode, 401);
  assert.deepEqual((await get('/api/health')).json(), { status: 'ok' });
  const publicSession = await get('/api/session');
  assert.deepEqual(publicSession.json(), { authenticated: false, initialized: true });
  assert.equal(publicSession.headers['cache-control'], 'no-store');
  assert.match(String(publicSession.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal((await post('/api/login', { password }, { origin: 'https://attacker.example' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { password } })).statusCode, 403);
  assert.equal((await post('/api/login', { password: 'wrong' })).statusCode, 401);
  const first = await post('/api/login', { password });
  assert.equal(first.statusCode, 200);
  const setCookie = String(first.headers['set-cookie']);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(setCookie.includes(flag), flag);
  const cookie1 = setCookie.split(';')[0]!;
  const second = await post('/api/login', { password });
  const cookie2 = String(second.headers['set-cookie']).split(';')[0]!;
  assert.notEqual(cookie1, cookie2);
  assert.equal((await get('/api/private/identity', cookie1)).statusCode, 200);
  assert.equal((await get('/api/private/identity', cookie2)).statusCode, 200);
  const csrf = first.json().csrfToken as string;
  assert.equal((await post('/api/private/logout', {}, { cookie: cookie1 })).statusCode, 403);
  assert.equal((await post('/api/private/logout', {}, { cookie: cookie1, 'x-csrf-token': '界'.repeat(43) })).statusCode, 403);
  assert.equal((await post('/api/private/logout', {}, { cookie: cookie1, 'x-csrf-token': csrf, origin: 'https://attacker.example' })).statusCode, 403);
  assert.equal((await post('/api/private/logout', {}, { cookie: cookie1, 'x-csrf-token': csrf })).statusCode, 200);
  assert.equal((await get('/api/private/identity', cookie1)).statusCode, 401);
  assert.equal((await get('/api/private/identity', cookie2)).statusCode, 200);
  await auth.reset('replacement-synthetic-password');
  assert.equal((await get('/api/private/identity', cookie2)).statusCode, 401);
});

test('HTTP bounds and no default administrator', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-uninitialized-'));
  const db = openDatabase(directory);
  const app = await buildApp({ db, origin: 'https://workbench.example' });
  t.after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true }); });
  const headers = { origin: 'https://workbench.example', 'content-type': 'application/json' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', headers, payload: { password: 'synthetic-test-password' } })).statusCode, 503);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', headers, payload: { password: 'x'.repeat(70_000) } })).statusCode, 413);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', headers, payload: '{"__proto__":{"admin":true}}' })).statusCode, 400);
  for (const url of ['/.env', '/server/main.js', '/%2e%2e/package.json', '/api/tasks']) assert.equal((await app.inject(url)).statusCode, 404);
});

test('cleartext cookies require an explicit loopback development origin', () => {
  assert.throws(() => validOrigin('http://example.com', true));
  assert.throws(() => validOrigin('http://127.0.0.1:3000', false));
  assert.equal(validOrigin('http://127.0.0.1:3000', true), 'http://127.0.0.1:3000');
  assert.equal(validOrigin('https://workbench.example', false), 'https://workbench.example');
  assert.throws(() => validOrigin('https://user:password@workbench.example', false));
  assert.throws(() => loadConfig({ HOST: '0.0.0.0', ZHONGSHU_ORIGIN: 'http://127.0.0.1:3000', ZHONGSHU_ALLOW_HTTP_LOOPBACK: 'true' }));
});

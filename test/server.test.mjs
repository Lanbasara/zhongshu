import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.mjs';

test('public tracer exposes only health, version and the page assets', async (t) => {
  const metadata = { name: 'zhongshu', version: '0.1.0', revision: 'a'.repeat(40) };
  const server = createApp(metadata);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${origin}/api/health`)).json(), { status: 'ok' });
  const response = await fetch(`${origin}/api/version`);
  assert.deepEqual(await response.json(), metadata);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const route of ['/', '/app.js', '/style.css', '/icon.svg', '/manifest.webmanifest']) {
    assert.equal((await fetch(`${origin}${route}`)).status, 200, route);
  }
  for (const route of ['/.env', '/server.mjs', '/%2e%2e/package.json', '/api/tasks']) {
    assert.equal((await fetch(`${origin}${route}`)).status, 404, route);
  }
  assert.equal((await fetch(`${origin}/api/version`, { method: 'POST', body: 'ignored' })).status, 405);
  assert.equal(await (await fetch(`${origin}/api/version`, { method: 'HEAD' })).text(), '');
});

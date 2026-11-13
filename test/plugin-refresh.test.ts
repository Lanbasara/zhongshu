import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pluginCheckNotice, refreshPluginView } from '../src/web/plugin-refresh.ts';

type Call = { url: string; method: string; csrf: string | null; body?: string };
const view = (extra: Record<string, unknown> = {}) => ({ availability: 'available', entries: [], sources: [], operation: null, ...extra });
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input), method: init?.method ?? 'GET',
      csrf: new Headers(init?.headers ?? {}).get('x-csrf-token'), body: init?.body as string | undefined,
    };
    calls.push(call);
    return await handler(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('a Codex refresh checks the user-added markets and keeps the checked view', async () => {
  const checkedView = view({ updateCheck: { checked: 1, unavailable: 0 } });
  const stub = stubFetch(() => reply(200, checkedView));
  try {
    const result = await refreshPluginView('codex', 'csrf-token');
    assert.equal(result.checked, true);
    assert.equal(result.failure, undefined);
    assert.deepEqual(result.view.updateCheck, { checked: 1, unavailable: 0 });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]!.method, 'POST');
    assert.equal(stub.calls[0]!.url, '/api/private/workbench/plugins/codex/check-updates');
    assert.equal(stub.calls[0]!.csrf, 'csrf-token');
    assert.equal(stub.calls[0]!.body, '{}');
  } finally { stub.restore(); }
});

test('a DSH refresh only re-reads the native state and never checks a market', async () => {
  const stub = stubFetch(() => reply(200, view()));
  try {
    const result = await refreshPluginView('dsh', 'csrf-token');
    assert.equal(result.checked, false);
    assert.equal(result.failure, undefined);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]!.method, 'GET');
    assert.equal(stub.calls[0]!.url, '/api/private/workbench/plugins/dsh');
  } finally { stub.restore(); }
});

for (const status of [409, 503]) {
  test('a Codex check that cannot run (' + status + ') falls back to the native state', async () => {
    const stub = stubFetch(() => stub.calls.length === 1
      ? reply(status, { error: status === 409 ? 'plugin_operation_in_progress' : 'plugin_management_unavailable' })
      : reply(200, view()));
    try {
      const result = await refreshPluginView('codex', 'csrf-token');
      assert.equal(result.checked, false);
      assert.equal((result.failure as { status?: number }).status, status);
      assert.deepEqual(result.view, view());
      assert.deepEqual(stub.calls.map(call => call.method), ['POST', 'GET']);
      assert.equal(pluginCheckNotice(result.failure), undefined);
    } finally { stub.restore(); }
  });
}

test('a Codex check that fails unexpectedly still returns the native state and is reported in words', async () => {
  const stub = stubFetch(() => {
    if (stub.calls.length === 1) throw new TypeError('network down');
    return reply(200, view());
  });
  try {
    const result = await refreshPluginView('codex', 'csrf-token');
    assert.equal(result.checked, false);
    assert.equal(result.failure instanceof TypeError, true);
    assert.deepEqual(result.view, view());
    assert.equal(pluginCheckNotice(result.failure), '暂时无法检查更新；已重新读取插件状态。');
  } finally { stub.restore(); }
});

test('an expired session during a Codex check is reported instead of hidden by a fallback read', async () => {
  const stub = stubFetch(() => reply(401, { error: 'unauthenticated' }));
  try {
    await assert.rejects(refreshPluginView('codex', 'csrf-token'), (error: unknown) =>
      error instanceof Error && (error as { status?: number }).status === 401);
    assert.equal(stub.calls.length, 1);
  } finally { stub.restore(); }
});

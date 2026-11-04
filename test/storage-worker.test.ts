import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deserialize, serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { test, type TestContext } from 'node:test';
import { createStorageClient, encodeStorageValue, StorageClientError, type StorageClientOptions } from '../src/server/storage-client.ts';
import { StoreError, type CreateConversation, type WorkbenchChange } from '../src/server/workbench-store.ts';

function conversation(): CreateConversation {
  return { id: randomUUID(), harnessId: 'codex', workspaceId: 'synthetic', cwd: '/synthetic/workspace', configuration: { modelId: 'model', permissionId: 'workspace' } };
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==', 'base64');
async function fixture(t: TestContext, options: Omit<StorageClientOptions, 'dataDirectory'> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-storage-worker-'));
  const client = createStorageClient({ dataDirectory: directory, ...options });
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.ready;
  return { directory, client, store: client.store };
}

test('worker owns complete repository commands, delivers committed hints, and preserves durable identities', async t => {
  const events: WorkbenchChange[] = [];
  let observer: DatabaseSync | undefined;
  const f = await fixture(t, { onChange(event) {
    assert.equal(observer!.prepare('SELECT COUNT(*) AS n FROM workbench_conversations WHERE id=?').get(event.conversationId)!.n, 1,
      'the separate read connection must see the commit before its change notification');
    events.push(event);
  } });
  observer = new DatabaseSync(join(f.directory, 'zhongshu.sqlite'), { readOnly: true });
  t.after(() => observer?.close());
  const input = conversation();
  assert.equal((await f.store.createConversation(input)).created, true);
  assert.equal((await f.store.createConversation(input)).created, false);
  assert.equal(events.length, 1);
  const binding = { id: 'native-binding', cwd: input.cwd, configuration: input.configuration, details: {} };
  await f.store.saveBinding(input.id, binding);
  await f.store.renameConversation(input.id, 'Worker conversation');
  assert.equal((await f.store.getConversation(input.id))!.title, 'Worker conversation');
  assert.equal((await f.store.listConversations()).length, 1);
  const operation = { id: randomUUID(), conversationId: input.id, type: 'message' as const, payload: { text: 'one durable operation' } };
  assert.equal((await f.store.enqueueOperation(operation)).created, true);
  assert.equal((await f.store.claimOperation(operation.id))!.status, 'dispatching');
  assert.equal(await f.store.claimOperation(operation.id), null);
  await f.store.settleOperation(operation.id, { outcome: 'accepted', runId: 'native-run' });
  await f.store.mergeHistory(input.id, [{ id: 'reply', text: 'durable answer', kind: 'assistant', status: 'completed', runId: 'native-run' }]);
  assert.equal((await f.store.readHistory(input.id)).items[0]!.text, 'durable answer');
  assert.equal((await f.store.listOperations({ conversationId: input.id }))[0]!.runId, 'native-run');
  assert.equal((await f.store.archiveJobs(input.id)).length, 2);
  const beforeFailure = await f.store.version();
  await assert.rejects(f.store.enqueueOperation({ ...operation, payload: { text: 'different content' } }), (error: unknown) =>
    error instanceof StorageClientError && error instanceof StoreError && error.code === 'operation_id_conflict' && error.outcome === 'rejected' && error.statusCode === 409);
  assert.equal(await f.store.version(), beforeFailure);
  await f.client.drain();
  assert.deepEqual(f.client.diagnostics(), { phase: 'ready', pending: 0, pendingBytes: 0, inFlight: false });
  await f.client.close();
  const reopened = createStorageClient({ dataDirectory: f.directory });
  t.after(() => reopened.close());
  await reopened.ready;
  assert.equal((await reopened.store.getOperation(operation.id))!.status, 'accepted');
  assert.equal((await reopened.store.enqueueOperation(operation)).created, false);
});

test('resources cross the worker boundary as binary data with ownership and pin transactions intact', async t => {
  const f = await fixture(t);
  const input = conversation();
  await f.store.createConversation(input);
  const resource = await f.store.resources.put(input.id, 'synthetic.png', png);
  const read = await f.store.resources.get(input.id, resource.id);
  assert.ok(Buffer.isBuffer(read.data));
  assert.deepEqual(read.data, png);
  await assert.rejects(f.store.resources.get(randomUUID(), resource.id), { code: 'image_unavailable', statusCode: 404, outcome: 'rejected' });
  await f.store.resources.pin(input.id, resource.id, 'owner');
  await f.store.resources.remove(input.id, resource.id);
  assert.deepEqual((await f.store.resources.owned(input.id, 'owner'))!.data, png);
  assert.equal(await f.store.resources.owned(input.id, 'other-owner'), undefined);
});

test('failed transactions emit no change and callback-based archive checks never run in either thread', async t => {
  const events: WorkbenchChange[] = [];
  const f = await fixture(t, { onChange: event => { events.push(event); throw new Error('consumer failure must not undo commit'); } });
  const input = conversation();
  await f.store.createConversation(input);
  const before = events.length;
  await assert.rejects(f.store.mergeHistory(input.id, [
    { id: 'valid', text: 'must roll back', kind: 'assistant', status: 'completed' },
    { id: '', text: 'invalid identity', kind: 'assistant', status: 'completed' },
  ]));
  assert.equal(await f.store.getItem(input.id, 'valid'), null);
  assert.equal(events.length, before);
  let checked = false;
  await assert.rejects(f.store.setArchived(input.id, true, () => { checked = true; return true; }), {
    code: 'storage_method_unsupported', outcome: 'not_started',
  });
  assert.equal(checked, false);
  assert.equal((await f.store.getConversation(input.id))!.archived, false);
});

test('queue count and aggregate bytes apply backpressure before unbounded worker messages accumulate', async t => {
  const f = await fixture(t, { maxPending: 2 });
  const first = f.store.version();
  const second = f.store.version();
  await assert.rejects(f.store.version(), { code: 'storage_queue_full', outcome: 'not_started' });
  assert.equal(f.client.diagnostics().pending, 2);
  assert.equal(f.client.diagnostics().inFlight, true);
  await Promise.all([first, second]);
  const bytes = await fixture(t, { maxQueuedBytes: 1800 });
  const input = conversation();
  await bytes.store.createConversation(input);
  const page = [{ id: 'bounded-page', text: 'x'.repeat(1100), kind: 'assistant' as const, status: 'completed' as const }];
  const write = bytes.store.mergeHistory(input.id, page);
  await assert.rejects(bytes.store.mergeHistory(input.id, page), { code: 'storage_queue_full', outcome: 'not_started' });
  assert.ok(bytes.client.diagnostics().pendingBytes <= 1800);
  await write;
  assert.equal((await bytes.store.getItem(input.id, page[0]!.id))!.text.length, 1100);
});

test('request/result budgets reject oversized work and distinguish a committed mutation without its large result', async t => {
  let resets = 0;
  const f = await fixture(t, { maxRequestBytes: 8192, maxResultBytes: 2048, onReset: () => { resets++; } });
  const input = conversation();
  await f.store.createConversation(input);
  await assert.rejects(f.store.mergeHistory(input.id, [{ id: 'oversize', text: 'x'.repeat(10_000), kind: 'assistant', status: 'completed' }]),
    { code: 'storage_payload_too_large', outcome: 'not_started' });
  assert.equal(await f.store.getItem(input.id, 'oversize'), null);
  await f.store.mergeHistory(input.id, Array.from({ length: 4 }, (_, index) => ({ id: `item-${index}`, text: 'x'.repeat(1000), kind: 'assistant', status: 'completed' })));
  await assert.rejects(f.store.readHistory(input.id), { code: 'storage_result_too_large', outcome: 'rejected' });
  assert.equal((await f.store.getItem(input.id, 'item-0'))!.text.length, 1000);
  const operation = { id: randomUUID(), conversationId: input.id, type: 'message' as const, payload: { text: 'committed'.repeat(500) } };
  await assert.rejects(f.store.enqueueOperation(operation), { code: 'storage_result_too_large', outcome: 'committed' });
  assert.equal(resets, 1, 'over-budget committed response explicitly invalidates change consumers');
  await f.client.close();
  const recovered = createStorageClient({ dataDirectory: f.directory });
  t.after(() => recovered.close());
  await recovered.ready;
  const stored = (await recovered.store.getOperation(operation.id))!;
  assert.equal(stored.type, 'message');
  if (stored.type === 'message') assert.equal(stored.payload.text, operation.payload.text);
  assert.equal((await recovered.store.listOperations({ conversationId: input.id })).length, 1);
});

test('a blocked SQLite writer leaves the main loop responsive and times out without retrying uncertain work', async t => {
  const f = await fixture(t, { requestTimeoutMs: 100 });
  const { buildApp } = await import('../src/server/app.ts');
  const app = await buildApp({ authStore: f.client.auth, origin: 'https://synthetic.example', readiness: () => f.client.diagnostics().phase === 'ready' });
  t.after(() => app.close());
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  const blocker = new DatabaseSync(join(f.directory, 'zhongshu.sqlite'));
  t.after(() => blocker.close());
  blocker.exec('BEGIN IMMEDIATE');
  let ticks = 0;
  const heartbeat = setInterval(() => { ticks++; }, 10);
  const input = conversation();
  const attempted = f.store.createConversation(input);
  const queued = f.store.version();
  const outcomes = Promise.all([
    assert.rejects(attempted, { code: 'storage_request_timeout', outcome: 'unknown' }),
    assert.rejects(queued, { code: 'storage_request_timeout', outcome: 'not_started' }),
  ]);
  try {
    await outcomes;
    assert.ok(ticks >= 3, 'SQLite lock waiting must not block the main event loop');
    assert.equal(f.client.diagnostics().phase, 'failed');
    assert.equal(f.client.diagnostics().failureCode, 'storage_request_timeout');
    assert.equal((await app.inject('/api/health')).statusCode, 503, 'a failed worker must stay observable without queueing another RPC');
    await assert.rejects(f.store.version(), { outcome: 'not_started' });
    assert.equal(f.client.diagnostics().failureCode, 'storage_request_timeout', 'later unavailable errors preserve the first cause');
    await assert.rejects(f.client.drain(), { outcome: 'unknown' });
  } finally {
    clearInterval(heartbeat);
    blocker.exec('ROLLBACK');
    await f.client.close();
  }
  assert.ok(Number(blocker.prepare('SELECT COUNT(*) AS n FROM workbench_conversations WHERE id=?').get(input.id)!.n) <= 1);
});

test('close drains accepted requests, rejects new work, and startup failures reject readiness and queued work', async t => {
  const f = await fixture(t);
  const input = conversation();
  const accepted = f.store.createConversation(input);
  const closing = f.client.close();
  await assert.rejects(f.store.version(), { code: 'storage_unavailable', outcome: 'not_started' });
  assert.equal((await accepted).created, true);
  await closing;
  assert.equal(f.client.close(), closing, 'close is idempotent');
  assert.equal(f.client.diagnostics().phase, 'closed');
  const badPath = join(f.directory, 'not-a-directory');
  await writeFile(badPath, 'synthetic');
  const bad = createStorageClient({ dataDirectory: badPath });
  const pending = bad.store.version();
  await Promise.all([assert.rejects(bad.ready, { outcome: 'not_started' }), assert.rejects(pending, { outcome: 'not_started' })]);
  await bad.close();
});

test('serialization preflight rejects callbacks, accessors, cycles and deep graphs without invoking them', () => {
  let invoked = false;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { invoked = true; return 'private'; } });
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  for (const value of [accessor, cycle, () => {}, new Date()])
    assert.throws(() => encodeStorageValue(value, 1024), StorageClientError);
  assert.equal(invoked, false);
  let deep: unknown = null;
  for (let i = 0; i < 70; i++) deep = [deep];
  assert.throws(() => encodeStorageValue(deep, 4096), { code: 'storage_payload_too_complex' });
});

test('the worker independently rejects unknown property access and duplicate request identities', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-storage-wire-'));
  const worker = new Worker(new URL('../src/server/storage-worker.ts', import.meta.url), { workerData: { dataDirectory: directory }, execArgv: [] });
  t.after(async () => { await worker.terminate(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await once(worker, 'message'))[0].type, 'ready');
  const reply = once(worker, 'message');
  worker.postMessage({ type: 'request', id: 1, payload: serialize({ scope: 'store', method: 'constructor', args: [] }) });
  assert.equal(deserialize((await reply)[0].payload).error.code, 'storage_method_unsupported');
  const rejected = once(worker, 'message');
  worker.postMessage({ type: 'request', id: 1, payload: serialize({ scope: 'store', method: 'version', args: [] }) });
  assert.equal((await rejected)[0].type, 'fatal');
});

test('authentication transactions share the worker, reject stale credentials and preserve revocation across restart', async t => {
  const { createAuth } = await import('../src/server/auth.ts');
  const f = await fixture(t);
  const auth = createAuth(f.client.auth, { audit: () => {} });
  assert.equal(await auth.initialized(), false);
  await auth.initialize('synthetic initial worker password');
  const before = await auth.login('synthetic initial worker password', { clientKey: 'synthetic-device' });
  assert.equal(before.ok, true); if (!before.ok) throw new Error('expected_session');
  assert.deepEqual(await auth.authenticate(before.token), before.session);
  const [racing] = await Promise.all([
    auth.login('synthetic initial worker password', { clientKey: 'synthetic-racing' }),
    auth.reset('synthetic replacement worker password'),
  ]);
  assert.equal(await auth.authenticate(before.token), null);
  if (racing.ok) assert.equal(await auth.authenticate(racing.token), null);
  await f.client.close();
  const reopened = createStorageClient({ dataDirectory: f.directory });
  t.after(() => reopened.close()); await reopened.ready;
  const next = createAuth(reopened.auth, { audit: () => {} });
  assert.equal(await next.authenticate(before.token), null);
  const logged = await next.login('synthetic replacement worker password', { clientKey: 'synthetic-device' });
  assert.equal(logged.ok, true); if (!logged.ok) throw new Error('expected_session');
  await next.logout(logged.token); assert.equal(await next.authenticate(logged.token), null);
});

test('workspace pages exceed 256 registrations with stable bounded keysets and invalidate on reordering', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 307; index++) {
    const id = 'workspace-' + index.toString().padStart(4, '0');
    await f.client.workspaces.register({ id, label: index % 2 ? 'same label' : 'Label ' + index.toString().padStart(4, '0'),
      directory: '/synthetic/' + id, identity: 'synthetic-inode-' + index, root_id: 'root', pinned: index % 7 ? 0 : 1, removed: 0 });
  }
  const ids: string[] = []; let cursor: string | undefined;
  do {
    const page = await f.client.workspaces.page({ cursor });
    assert.ok(page.entries.length <= 50); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32 * 1024);
    ids.push(...page.entries.map(row => row.id)); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(ids.length, 307); assert.equal(new Set(ids).size, 307);
  const first = await f.client.workspaces.page(); assert.ok(first.nextCursor);
  await assert.rejects(f.client.workspaces.page({ cursor: first.nextCursor, removed: true }), { code: 'workspace_cursor_expired', statusCode: 409 });
  await f.client.workspaces.rename('workspace-0306', 'Moved to front');
  await assert.rejects(f.client.workspaces.page({ cursor: first.nextCursor }), { code: 'workspace_cursor_expired', statusCode: 409 });
  const filtered = await f.client.workspaces.page({ query: 'Moved to front' });
  assert.deepEqual(filtered.entries.map(row => row.id), ['workspace-0306']);
  assert.equal(filtered.scanned, 256); assert.ok(filtered.nextCursor);
  const remaining = await f.client.workspaces.page({ query: 'Moved to front', cursor: filtered.nextCursor });
  assert.deepEqual(remaining.entries, []); assert.equal(remaining.nextCursor, null);
  await f.client.workspaces.remove('workspace-0306');
  assert.deepEqual((await f.client.workspaces.page({ removed: true })).entries.map(row => row.id), ['workspace-0306']);
  await f.client.workspaces.restore('workspace-0306', 'synthetic-inode-306');
  assert.equal((await f.client.workspaces.get('workspace-0306'))?.removed, 0);
});

test('plugin claims remain indivisible with stable replay and recovery in the same worker', async t => {
  const f = await fixture(t);
  const input = { id: randomUUID(), pluginId: 'synthetic@approved', action: 'install' as const };
  const results = await Promise.all([f.client.plugins.claim('dsh', input), f.client.plugins.claim('dsh', input)]);
  assert.deepEqual(results.map(result => result.created), [true, false]);
  await assert.rejects(f.client.plugins.claim('codex', input), { code: 'operation_id_conflict', statusCode: 409 });
  await assert.rejects(f.client.plugins.claim('dsh', { ...input, id: randomUUID() }), { code: 'plugin_operation_in_progress', statusCode: 409 });
  assert.equal(await f.client.plugins.recoverApplying(), 1);
  assert.equal((await f.client.plugins.current('dsh'))?.status, 'unknown');
  await f.client.plugins.settle(input.id, 'applied');
  await f.client.plugins.settle(input.id, 'unknown');
  assert.equal((await f.client.plugins.find(input.id))?.status, 'applied', 'late uncertain receipt cannot undo a settled result');
});

test('worker diagnostics expose only bounded numeric telemetry without stored content', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 129; index++) await f.store.version();
  const diagnostics = f.client.diagnostics();
  assert.equal(diagnostics.phase, 'ready'); assert.equal(diagnostics.memory?.completed, 128);
  assert.ok(diagnostics.memory!.heapUsed > 0); assert.ok(diagnostics.memory!.processRss > 0);
  assert.ok(Object.values(diagnostics.memory!).every(value => typeof value === 'number' && Number.isSafeInteger(value)));
});

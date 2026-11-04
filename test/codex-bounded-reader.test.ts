import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BoundedCodexReader } from '../src/harness/codex/bounded-reader.ts';
import type { NativeItem } from '../src/harness/types.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zs-codex-bounded-')), nativeRoot = join(root, 'native'), cacheRoot = join(root, 'cache'), cwd = join(root, 'workspace');
  await mkdir(join(nativeRoot, 'sessions', '2026'), { recursive: true }); await mkdir(cwd);
  const binding = { id: 'synthetic-thread', cwd, path: join(nativeRoot, 'sessions', '2026', 'rollout-synthetic.jsonl'), cliVersion: '0.166.0-alpha.5.1' as const };
  const header = { ordinal: 0, type: 'session_meta', payload: { id: binding.id, cwd, cli_version: binding.cliVersion, history_mode: 'paginated' } };
  await writeFile(binding.path, JSON.stringify(header) + '\n', { mode: 0o600 });
  const options = { nativeRoot, cacheRoot };
  let reader = new BoundedCodexReader(options);
  let ordinal = 0;
  const append = async (...rows: unknown[]) => appendFile(binding.path, rows.map(row => JSON.stringify({ ordinal: ++ordinal, ...(row as object) }) + '\n').join(''));
  const item = (value: unknown, turn = 'run-1') => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: binding.id, turn_id: turn, item: value } });
  const close = async () => { await reader.close(); await rm(root, { recursive: true, force: true }); };
  const restart = async () => { await reader.close(); reader = new BoundedCodexReader(options); return reader; };
  const full = async (entry: NativeItem, field: 'text' | 'input' | 'output' = 'text') => {
    const source = entry.bodySources?.[field]; assert(source); const digest = createHash('sha256'); let bytes = 0, offset = 0;
    do { const chunk = await reader.readBodyChunk({ ...binding, configuration: { modelId: 'synthetic', permissionId: ':read-only' }, details: {} }, source.token, offset, 64 * 1024); assert(chunk.data.length <= 64 * 1024); digest.update(chunk.data); bytes += chunk.data.length; if (chunk.nextOffset === null) break; offset = chunk.nextOffset; } while (true);
    assert.equal(bytes, source.bytes); assert.equal(digest.digest('hex'), source.version); return source;
  };
  const release = async (entry: NativeItem) => { for (const source of Object.values(entry.bodySources ?? {})) await reader.releaseBodySource({ ...binding, configuration: { modelId: 'synthetic', permissionId: ':read-only' }, details: {} }, source.token); };
  const latest = async () => { for (let n = 0; n < 100; n++) { try { return await reader.history(binding); } catch (error) { if (!(error instanceof Error) || error.message !== 'codex_bounded_indexing') throw error; } } throw new Error('index did not finish'); };
  return { root, binding, header, options, reader, append, item, close, restart, full, release, latest };
}

test('Codex streams a 32 MiB persisted reply, bounded preview/chunks, exact SHA and worker restart cursor', async () => {
  const f = await fixture(); let ticks = 0; const timer = setInterval(() => ticks++, 5);
  try {
    const text = '中文😀\\\n'.repeat(3 * 1024 ** 2); assert(Buffer.byteLength(text) >= 32 * 1024 ** 2);
    await f.append(f.item({ type: 'UserMessage', id: 'user-1', client_id: 'op-1', content: [{ type: 'text', text: 'prompt' }] }), f.item({ type: 'AgentMessage', id: 'assistant-1', content: [{ type: 'Text', text }] }));
    let page; for (let n = 0; n < 10; n++) { try { page = await f.reader.history(f.binding, undefined, 1); break; } catch (error) { if (!(error instanceof Error) || error.message !== 'codex_bounded_indexing') throw error; } }
    assert(page); assert(page.olderCursor); const assistant = page.items[0]!;
    assert(Buffer.byteLength(assistant.text) <= 8192); const source = await f.full(assistant); assert.equal(source.version, createHash('sha256').update(text).digest('hex')); assert(ticks > 10);
    await f.release(assistant); const reader = await f.restart(); const old = await reader.history(f.binding, page.olderCursor, 1); assert.equal(old.items[0]!.id, 'user-1'); assert.equal(old.items[0]!.operationId, 'op-1'); await f.release(old.items[0]!);
    assert.deepEqual(await reader.reconcile(f.binding, 'op-1'), { outcome: 'accepted', runId: 'run-1' });
    assert(!(await readdir(f.options.cacheRoot)).some(name => name.endsWith('.body')));
  } finally { clearInterval(timer); await f.close(); }
});

test('Codex tool completion remains at its call anchor across 1000 messages and exact old pending lookup', async () => {
  const f = await fixture();
  try {
    await f.append({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'run-1' } }, { type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"synthetic"}' } });
    for (let n = 0; n < 1000; n++) await f.append(f.item({ type: 'AgentMessage', id: `assistant-${n}`, content: [{ type: 'Text', text: String(n) }] }));
    const head = await f.reader.history(f.binding, undefined, 1); assert.equal(head.items[0]!.id, 'assistant-999'); await f.release(head.items[0]!);
    const before = await f.reader.readItems(f.binding, ['call-1']); assert.equal(before[0]!.status, 'running'); await f.release(before[0]!);
    await f.append(f.item({ type: 'CommandExecution', id: 'call-1', command: ['sh', '-c', 'synthetic'], status: 'completed', aggregated_output: 'full result', exit_code: 0 }));
    const updated = await f.reader.readItems(f.binding, ['call-1']); assert.equal(updated[0]!.status, 'completed'); assert.equal(updated[0]!.tool?.output, 'full result'); await f.full(updated[0]!, 'input'); await f.full(updated[0]!, 'output'); await f.release(updated[0]!);
    const ids: string[] = []; let cursor: string | undefined;
    do { const page = await f.reader.history(f.binding, cursor, 100); ids.unshift(...page.items.map(item => item.id)); for (const entry of page.items) await f.release(entry); cursor = page.olderCursor ?? undefined; } while (cursor);
    assert.equal(ids.length, 1001); assert.equal(new Set(ids).size, 1001); assert.equal(ids[0], 'call-1');
    assert(head.olderCursor); const stable = await f.reader.history(f.binding, head.olderCursor, 1); assert.equal(stable.items[0]!.id, 'assistant-998'); await f.release(stable.items[0]!);
  } finally { await f.close(); }
});

test('Codex replacement invalidates cursor but leased old body remains readable; wrong header and torn tail fail closed', async () => {
  const f = await fixture();
  try {
    await f.append(f.item({ type: 'AgentMessage', id: 'one', content: [{ type: 'Text', text: 'one' }] }), f.item({ type: 'AgentMessage', id: 'two', content: [{ type: 'Text', text: 'two'.repeat(2000) }] }));
    const page = await f.reader.history(f.binding, undefined, 1); assert(page.olderCursor);
    await rename(f.binding.path, f.binding.path + '.old'); await writeFile(f.binding.path, JSON.stringify(f.header) + '\n' + JSON.stringify({ ordinal: 1, ...f.item({ type: 'AgentMessage', id: 'new', content: [{ type: 'Text', text: 'new' }] }) }) + '\n');
    await assert.rejects(f.reader.history(f.binding, page.olderCursor), /history_cursor_invalid/); await f.full(page.items[0]!); await f.release(page.items[0]!);
    await appendFile(f.binding.path, '{"type":'); await assert.rejects(f.reader.history(f.binding), /codex_bounded_indexing/);
    await rename(f.binding.path, f.binding.path + '.torn'); await writeFile(f.binding.path, JSON.stringify({ ...f.header, payload: { ...f.header.payload, id: 'other' } }) + '\n');
    await assert.rejects(f.reader.history(f.binding), /history_source_changed/);
  } finally { await f.close(); }
});

test('Codex internal tool output settles a non-UI call and official tools keep their native terminal result', async () => {
  const f = await fixture();
  try {
    await f.append({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'run-1' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'goal', name: 'get_goal', arguments: '{}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'goal', output: '{"goal":null}' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'command', name: 'exec_command', arguments: '{"cmd":"synthetic"}' } },
      f.item({ type: 'CommandExecution', id: 'command', command: ['sh', '-c', 'synthetic'], status: 'completed', aggregated_output: 'exact native output' }),
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'command', output: 'transport wrapper that must not override native output' } });
    const page = await f.reader.history(f.binding); assert.deepEqual(page.items.map(x => x.id), ['goal', 'command']);
    assert.equal(page.items[0]!.status, 'completed'); assert.equal(page.items[0]!.tool?.name, 'get_goal'); assert.equal(page.items[0]!.tool?.input, '{}'); assert.equal(page.items[0]!.tool?.output, '{"goal":null}');
    assert.equal(page.items[1]!.tool?.output, 'exact native output');
    for (const entry of page.items) await f.release(entry);
  } finally { await f.close(); }
});

test('Codex fixed native file/image/plan/MCP shapes preserve edits, images and readable original records', async () => {
  const f = await fixture();
  try {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5FYAAAAASUVORK5CYII=';
    await f.append(f.item({ type: 'FileChange', id: 'file', status: 'completed', changes: { [join(f.binding.cwd, 'old.txt')]: { type: 'update', unified_diff: 'full diff', move_path: join(f.binding.cwd, 'new.txt') } } }),
      f.item({ type: 'ImageGeneration', id: 'image', status: 'completed', result: png }),
      f.item({ type: 'Plan', id: 'plan', text: 'whole plan' }), f.item({ type: 'Reasoning', id: 'reason', summary_text: ['summary', 'next'], raw_content: ['detail'] }),
      f.item({ type: 'McpToolCall', id: 'mcp', tool: 'native_tool', status: 'completed', arguments: { path: 'input' }, result: { content: [{ type: 'text', text: 'output' }] } }),
      f.item({ type: 'UserMessage', id: 'mixed', content: [{ type: 'text', text: 'hello' }, { type: 'image', url: 'data:image/png;base64,' + png }] }));
    const page = await f.reader.history(f.binding); assert.equal(page.items.length, 6);
    assert.deepEqual(page.items[0]!.fileEdits?.sort(), ['new.txt', 'old.txt']); assert.equal(page.items[0]!.tool?.name, '修改文件'); await f.full(page.items[0]!);
    const image = page.items[1]!.imageSources![0]!; assert(image.path?.startsWith('codex-image:')); assert(image.releaseToken);
    const binding = { ...f.binding, configuration: { modelId: 'synthetic', permissionId: ':read-only' }, details: {} };
    assert.equal(await f.reader.readImage(binding, image.path!.slice('codex-image:'.length)), png); await f.reader.releaseBodySource(binding, image.releaseToken);
    assert.equal(page.items[2]!.text, 'whole plan'); assert.equal(page.items[3]!.text, 'summary\nnext'); assert.equal(page.items[4]!.tool?.name, 'native_tool');
    assert.equal(page.items[5]!.text, 'hello\n[非文本输入]'); await f.full(page.items[5]!);
    for (const entry of page.items) await f.release(entry);
    assert(!(await readdir(f.options.cacheRoot)).some(name => name.endsWith('.body')));
  } finally { await f.close(); }
});

test('Codex small complete and empty text avoid staging; failed images retain a valid original-body prefix', async () => {
  const f = await fixture();
  try {
    await f.append(f.item({ type: 'AgentMessage', id: 'small', content: [{ type: 'Text', text: '中文🙂' }, { type: 'Text', text: 'exact' }] }),
      f.item({ type: 'AgentMessage', id: 'empty', content: [{ type: 'Text', text: '' }] }),
      f.item({ type: 'ImageGeneration', id: 'failed-image', status: 'failed', result: '' }));
    const page = await f.reader.history(f.binding);
    assert.equal(page.items[0]!.text, '中文🙂\nexact'); assert.equal(page.items[0]!.bodySources, undefined);
    assert.equal(page.items[1]!.text, ''); assert.equal(page.items[1]!.bodySources, undefined);
    const image = page.items[2]!; assert.equal(image.status, 'failed'); assert.equal(image.text, ''); assert.equal(image.imageSources, undefined);
    await f.full(image); await f.release(image);
    assert(!(await readdir(f.options.cacheRoot)).some(name => name.endsWith('.body')));
  } finally { await f.close(); }
});

test('Codex giant file-change list keeps bounded paths and full original JSON without blocking its archive page', async () => {
  const f = await fixture();
  try {
    const item = { type: 'FileChange', id: 'many-files', status: 'completed', changes: Object.fromEntries(Array.from({ length: 501 }, (_, n) => [join(f.binding.cwd, `file-${n}.txt`), { type: 'add', content: `whole-${n}` }])) };
    await f.append(f.item(item)); const page = await f.reader.history(f.binding); assert.equal(page.items.length, 1);
    const result = page.items[0]!; assert.equal(result.fileEdits?.length, 100); assert.equal(result.fileEditsLimited, true);
    assert.equal((await f.full(result)).version, createHash('sha256').update(JSON.stringify(item)).digest('hex')); await f.release(result);
  } finally { await f.close(); }
});

test('Codex file metadata obeys the UTF-8 page byte budget and cursor pagination retains every tool', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 16; n++) await f.append(f.item({ type: 'FileChange', id: `file-tool-${n}`, status: 'completed', changes: Object.fromEntries(Array.from({ length: 100 }, (_, p) => [join(f.binding.cwd, `${n}-${p}-` + '中'.repeat(300) + '.txt'), { type: 'add', content: `whole-${p}` }])) }));
    const seen = new Set<string>(); let cursor: string | undefined, pages = 0;
    do {
      const page = await f.reader.history(f.binding, cursor, 100); assert(Buffer.byteLength(JSON.stringify(page.items)) < 256 * 1024); pages++;
      for (const item of page.items) { assert(!seen.has(item.id)); seen.add(item.id); assert(item.fileEditsLimited); assert(Buffer.byteLength(JSON.stringify(item.fileEdits)) <= 32 * 1024 + 2); await f.release(item); }
      cursor = page.olderCursor ?? undefined;
    } while (cursor);
    assert.equal(seen.size, 16); assert(pages > 1);
  } finally { await f.close(); }
});

test('Codex ordinal gaps and future format fail closed before publishing a partial archive', async () => {
  const f = await fixture();
  try {
    await f.append({ ordinal: 99, ...f.item({ type: 'AgentMessage', id: 'bad', content: [{ type: 'Text', text: 'must not publish' }] }) });
    await assert.rejects(f.reader.history(f.binding), /codex_bounded_ordinal_gap/);
    await rename(f.binding.path, f.binding.path + '.old');
    await writeFile(f.binding.path, JSON.stringify({ ...f.header, payload: { ...f.header.payload, history_mode: 'future' } }) + '\n');
    await assert.rejects(f.reader.history(f.binding), /codex_bounded_unsupported_format/);
  } finally { await f.close(); }
});

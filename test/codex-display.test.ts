import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapItem, nativeItem } from '../src/harness/codex/protocol.ts';

const parse = (fields: Record<string, unknown>) => nativeItem.parse({ id: 'web-1', type: 'webSearch', ...fields });

test('web operations retain action targets without inventing web result content', () => {
  const search = mapItem(parse({ query: 'fallback', action: { type: 'search', queries: ['first', 'second'], query: 'first' } }), 'turn', '/workspace', false, true);
  assert.equal(search.tool?.name, '网页搜索');
  assert.equal(search.tool?.input, 'first\nsecond');
  assert.equal(search.tool?.output, undefined);
  assert.equal(search.status, 'completed');
  assert.equal(search.id, 'web-1');
  assert.equal(search.runId, 'turn');
  assert.equal(mapItem(parse({ action: { type: 'openPage', url: 'https://example.com/' } }), 'turn', '/workspace').tool?.name, '打开网页');
  const find = mapItem(parse({ action: { type: 'findInPage', url: 'https://example.com/', pattern: 'needle' } }), 'turn', '/workspace');
  assert.equal(find.tool?.name, '页内查找');
  assert.equal(find.tool?.input, 'https://example.com/\nneedle');
  assert.equal(mapItem(parse({ query: 'legacy query', action: null }), 'turn', '/workspace').tool?.input, 'legacy query');
  assert.equal(mapItem(parse({ action: { type: 'futureAction' } }), 'turn', '/workspace').tool?.name, '网页操作');
});

test('web and unknown item lifecycles require positive completion evidence', () => {
  for (const type of ['webSearch', 'futureItem', 'collabToolCall', 'imageView', 'contextCompaction']) {
    const input = parse({ type });
    assert.equal(mapItem(input, 'turn', '/workspace').status, 'unknown');
    assert.equal(mapItem(input, 'turn', '/workspace', true).status, 'running');
    assert.equal(mapItem(input, 'turn', '/workspace', false, true).status, 'completed');
    assert.equal(mapItem({ ...input, status: 'failed' }, 'turn', '/workspace', false, true).status, 'failed');
    assert.equal(mapItem({ ...input, success: false }, 'turn', '/workspace', true).status, 'failed');
    assert.equal(mapItem({ ...input, status: 'futureStatus' }, 'turn', '/workspace').status, 'unknown');
    if (type === 'contextCompaction') {
      assert.equal(mapItem(input, 'turn', '/workspace').text, '上下文压缩（结果未确认）');
      assert.equal(mapItem(input, 'turn', '/workspace', false, true).text, '上下文已压缩');
    } else if (type !== 'webSearch') assert.match(mapItem(input, 'turn', '/workspace').text, /详情尚未适配展示/);
  }
});

test('web metadata stays bounded and is rendered as plain input data', () => {
  assert.equal(nativeItem.safeParse({ id: 'x', type: 'webSearch', action: { type: 'search', queries: Array(201).fill('x') } }).success, false);
  const input = mapItem(parse({ query: '<script>not executable</script>' }), 'turn', '/workspace');
  assert.equal(input.tool?.input, '<script>not executable</script>');
  assert.equal(mapItem(parse({ query: 'a'.repeat(40000) }), 'turn', '/workspace').tool?.input?.length, 32000);
});

test('native text_result shapes render titles, urls and snippets for search, open and find', () => {
  for (const action of [{ type: 'search', query: 'official documentation', queries: null }, { type: 'openPage', url: 'https://example.com/docs' }, { type: 'findInPage', url: null, pattern: 'Example' }]) {
    const item = mapItem(parse({ action, results: [{ type: 'text_result', domain: 'example.com', ref_id: 'turn1view0', title: 'Example documentation', url: 'https://example.com/docs', snippet: 'Total lines: 72', thumbnail_url: 'https://example.com/image.png' }] }), 'turn', '/workspace', false, true);
    assert.equal(item.tool?.output, 'Example documentation\nhttps://example.com/docs\nTotal lines: 72');
    assert.doesNotMatch(item.text, /未提供/);
    assert.doesNotMatch(item.tool!.output!, /thumbnail|turn1view0/);
  }
});

test('missing and future web results remain distinct, bounded plain text', () => {
  for (const results of [undefined, null, [], [{ type: 'text_result', title: null, snippet: null, url: null }]]) {
    const item = mapItem(parse({ results }), 'turn', '/workspace');
    assert.equal(item.text, '原生记录未提供可展示的结果内容。');
    assert.equal(item.tool?.output, undefined);
  }
  const future = mapItem(parse({ results: [{ type: 'future_result', body: '<img src=x onerror=alert(1)>' }, { type: 'text_result', snippet: '<script>plain text</script>' }] }), 'turn', '/workspace');
  assert.equal(future.tool?.output, '此结果类型尚未适配展示：future_result\n\n<script>plain text</script>');
  assert.equal(nativeItem.safeParse({ id: 'x', type: 'webSearch', results: [{ type: 'text_result', snippet: 'x'.repeat(128001) }] }).success, false);
  assert.equal(nativeItem.safeParse({ id: 'x', type: 'webSearch', results: Array(201).fill({ type: 'text_result' }) }).success, false);
  const long = mapItem(parse({ results: [{ type: 'text_result', snippet: 'x'.repeat(128000) }, { type: 'text_result', title: 'Second result' }] }), 'turn', '/workspace');
  assert.ok(long.tool!.output!.length <= 128000);
  assert.match(long.tool!.output!, /仅显示前部内容/);
});

test('reasoning without a readable summary reads as thinking instead of a blank status row', () => {
  const reasoning = (summary?: string[]) => mapItem(nativeItem.parse({ id: 'r', type: 'reasoning', ...(summary ? { summary } : {}) }), 'turn', '/workspace').text;
  assert.deepEqual([reasoning([]), reasoning(), reasoning(['', '']), reasoning(['Checked the gate'])], ['思考', '思考', '思考', 'Checked the gate']);
});

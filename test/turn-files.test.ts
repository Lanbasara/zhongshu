import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapItem, nativeItem } from '../src/harness/codex/protocol.ts';
import { historyItems, type Event } from '../src/harness/dsh/native.ts';

test('Codex records confirmed patch paths, including a move, inside the bound workspace', () => {
  const cwd = '/work/repo';
  const item = nativeItem.parse({ id: 'patch', type: 'fileChange', status: 'completed', changes: [
    { path: cwd + '/old.ts', kind: { type: 'update', move_path: cwd + '/new.ts' } },
    { path: cwd + '/new.ts' },
    { path: cwd + '/.git/config' },
    { path: cwd + '/../other.txt' },
    { path: cwd + '/%2e%2e/outside.txt' },
    { path: cwd + '-other/unrelated.txt' },
  ] });
  assert.deepEqual(mapItem(item, 'turn', cwd).fileEdits, ['old.ts', 'new.ts']);
  assert.equal(mapItem(item, 'turn', cwd, true).fileEdits, undefined);
  assert.equal(mapItem({ ...item, status: 'failed' }, 'turn', cwd).fileEdits, undefined);
  assert.equal(mapItem({ ...item, status: undefined }, 'turn', cwd).fileEdits, undefined);
});

test('DSH only attributes resolved mutation results to their matching file call and turn', () => {
  const event = (type: string, seq: number, data: Event['data']): Event => ({ type, seq, time: seq, data });
  const result = (id: string, path: string, error = false) => ({
    turn: 1, message: { toolCallId: id, isError: error }, meta: { path, diffs: [{}] },
  });
  const items = historyItems('session', [
    event('tool/call', 1, { turn: 1, callId: 'edit', name: 'edit', arguments: '{"file_path":"other.ts"}' }),
    event('tool/result', 2, result('edit', '/work/repo/sub/sample.tsx')),
    event('tool/call', 3, { turn: 1, callId: 'read', name: 'read' }),
    event('tool/result', 4, result('read', '/work/repo/read.md')),
    event('tool/call', 5, { turn: 1, callId: 'failed', name: 'write' }),
    event('tool/result', 6, result('failed', '/work/repo/failed.md', true)),
    event('tool/result', 7, result('unpaired', '/work/repo/unpaired.md')),
    event('tool/call', 8, { turn: 1, callId: 'other-turn', name: 'write' }),
    event('tool/result', 9, { ...result('other-turn', '/work/repo/other.md'), turn: 2 }),
  ], undefined, [], '/work/repo');
  assert.deepEqual(items.flatMap(item => item.fileEdits ?? []), ['sub/sample.tsx']);
});

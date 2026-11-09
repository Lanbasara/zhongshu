import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommand, type CommandTable } from '../src/simen/args.ts';

// Shapes copied from the official chrome-devtools-mcp 1.12 command table.
const table: CommandTable = {
  click: { args: { pageId: { type: 'number', positional: true }, uid: { type: 'string', positional: true }, dblClick: { type: 'boolean' }, includeSnapshot: { type: 'boolean' } } },
  new_page: { args: { url: { type: 'string', positional: true }, background: { type: 'boolean' }, isolatedContext: { type: 'string' } } },
  evaluate_script: { args: { function: { type: 'string', positional: true }, pageId: { type: 'number' }, filePath: { type: 'string' }, sourcePath: { type: 'string' } } },
  take_screenshot: { args: { pageId: { type: 'number', positional: true }, filePath: { type: 'string' }, fullPage: { type: 'boolean' } } },
  upload_file: { args: { pageId: { type: 'number', positional: true }, uid: { type: 'string', positional: true }, filePaths: { type: 'array', positional: true } } },
  take_heapsnapshot: { args: { pageId: { type: 'number', positional: true }, filePath: { type: 'string', positional: true } } },
  list_pages: { args: {} },
};

test('the page comes from its position or from --pageId, the way the official command line reads it', () => {
  assert.equal(parseCommand(['click', '2', '1_3', '--dblClick', 'true'], table, '/w').pageId, 2);
  assert.equal(parseCommand(['click', '--includeSnapshot', 'true', '4', '1_3'], table, '/w').pageId, 4);
  assert.equal(parseCommand(['evaluate_script', '() => document.title', '--pageId', '3'], table, '/w').pageId, 3);
  assert.equal(parseCommand(['evaluate_script', '() => 1', '--page-id=5'], table, '/w').pageId, 5);
  assert.equal(parseCommand(['new_page', 'https://example.com', '--background', 'true'], table, '/w').pageId, undefined);
  assert.equal(parseCommand(['list_pages', '--output-format', 'json'], table, '/w').command, 'list_pages');
});

test('relative file paths become absolute against the caller\'s directory; absolute ones stay', () => {
  assert.deepEqual(parseCommand(['take_screenshot', '2', '--filePath', 'shots/a.png'], table, '/workspace/hs').argv, ['take_screenshot', '2', '--filePath', '/workspace/hs/shots/a.png']);
  assert.deepEqual(parseCommand(['take_screenshot', '2', '--filePath=b.png'], table, '/workspace/hs').argv, ['take_screenshot', '2', '--filePath=/workspace/hs/b.png']);
  assert.deepEqual(parseCommand(['take_screenshot', '2', '--filePath', '/tmp/c.png'], table, '/w').argv, ['take_screenshot', '2', '--filePath', '/tmp/c.png']);
  assert.deepEqual(parseCommand(['upload_file', '2', '1_4', 'a.txt', 'b/c.txt'], table, '/w').argv, ['upload_file', '2', '1_4', '/w/a.txt', '/w/b/c.txt']);
  assert.deepEqual(parseCommand(['take_heapsnapshot', '2', 'heap.json'], table, '/w').argv, ['take_heapsnapshot', '2', '/w/heap.json']);
  // A script body is not a path.
  assert.deepEqual(parseCommand(['evaluate_script', 'x => x', '--pageId', '1'], table, '/w').argv, ['evaluate_script', 'x => x', '--pageId', '1']);
});

test('help and version have no tool; a second daemon through --sessionId is refused', () => {
  assert.equal(parseCommand(['--help'], table, '/w').command, undefined);
  assert.equal(parseCommand([], table, '/w').command, undefined);
  assert.deepEqual(parseCommand(['click', '1', '1_2', '--sessionId', 'abc'], table, '/w').forbidden, ['--sessionId']);
  assert.deepEqual(parseCommand(['--session-id=abc', 'list_pages'], table, '/w').forbidden, ['--session-id']);
});

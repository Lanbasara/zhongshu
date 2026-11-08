import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyLiveFrame, applyPatch, LIVE_ITEMS_KEPT } from '../src/web/live-items.ts';
import type { LiveEvent, WorkbenchItem } from '../src/shared/workbench.ts';

const conversationId = '00000000-0000-4000-8000-000000000000';
function frame(sequence: number, id: string, text: LiveEvent extends infer E ? E extends { text: infer T } ? T : never : never, extra: Partial<WorkbenchItem> = {}, output?: LiveEvent extends infer E ? E extends { output?: infer O } ? O : never : never): LiveEvent {
  return { type: 'live', sequence, conversationId, item: { id, kind: 'assistant', status: 'running', ...extra } as never, text, ...(output ? { output } : {}) };
}

test('body patches append, skip what the page already holds, and report a missing base', () => {
  assert.equal(applyPatch(undefined, { value: 'whole' }), 'whole');
  assert.equal(applyPatch('Hello', { at: 5, append: ', world' }), 'Hello, world');
  assert.equal(applyPatch('Hello, world', { at: 5, append: ', wo' }), 'Hello, world', 'an older frame changes nothing');
  assert.equal(applyPatch('Hello, wo', { at: 5, append: ', world' }), 'Hello, world', 'a frame overlapping a newer snapshot completes it');
  assert.equal(applyPatch('Hello', { at: 9, append: 'x' }), undefined, 'a missed frame is a gap');
  assert.equal(applyPatch(undefined, { at: 0, append: 'x' }), undefined, 'an unknown item is a gap');
});

test('live frames update items in place, append new ones, patch tool output and bound the list (ADR 0019)', () => {
  let items = applyLiveFrame([], frame(1, 'a', { value: 'A' })) as WorkbenchItem[];
  items = applyLiveFrame(items, frame(2, 'b', { value: 'B' }, { kind: 'tool', tool: { name: 'shell' } }, { value: 'line 1\n' })) as WorkbenchItem[];
  items = applyLiveFrame(items, frame(3, 'a', { at: 1, append: 'BC' }, { status: 'completed' })) as WorkbenchItem[];
  items = applyLiveFrame(items, frame(4, 'b', { at: 1, append: '' }, { kind: 'tool', tool: { name: 'shell', exitCode: 0 } }, { at: 7, append: 'line 2\n' })) as WorkbenchItem[];
  assert.deepEqual(items.map(item => item.id), ['a', 'b'], 'an updated item keeps its place');
  assert.equal(items[0]!.text, 'ABC'); assert.equal(items[0]!.status, 'completed');
  assert.deepEqual(items[1]!.tool, { name: 'shell', exitCode: 0, output: 'line 1\nline 2\n' });
  assert.equal(applyLiveFrame(items, frame(5, 'missing', { at: 3, append: 'x' })), 'gap');
  assert.equal(applyLiveFrame(items, frame(5, 'b', { at: 1, append: '' }, { kind: 'tool', tool: { name: 'shell' } }, { at: 99, append: 'x' })), 'gap');
  assert.equal(applyLiveFrame(items, { type: 'live', sequence: 6, conversationId, itemId: 'a', omitted: true }), 'gap');
  let many: WorkbenchItem[] = [];
  for (let index = 0; index <= LIVE_ITEMS_KEPT; index++) many = applyLiveFrame(many, frame(index + 1, `item-${index}`, { value: String(index) })) as WorkbenchItem[];
  assert.equal(many.length, LIVE_ITEMS_KEPT); assert.equal(many[0]!.id, 'item-1');
});

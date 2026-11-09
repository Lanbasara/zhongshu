import assert from 'node:assert/strict';
import test from 'node:test';
import { Windows } from '../src/simen/windows.ts';

const MIN = 60_000;

test('two windows, one per conversation; the third waits and gets the first window freed', () => {
  const windows = new Windows();
  assert.equal(windows.ask('a', 0).granted, true);
  assert.equal(windows.ask('b', 1).granted, true);
  const third = windows.ask('c', 2);
  assert.deepEqual(third, { granted: false, ahead: 0, waitingSince: 2 });
  // Asking again keeps the window instead of taking a second one.
  assert.equal(windows.ask('a', 3).granted, true);
  assert.equal(windows.holders().length, 2);
  windows.release('a');
  assert.equal(windows.ask('c', 4).granted, true);
  assert.deepEqual(windows.holders().map(holder => holder.session).sort(), ['b', 'c']);
});

test('waiters are served first come, first served; a later asker cannot jump a waiter', () => {
  const windows = new Windows({ windows: 1 });
  windows.ask('a', 0);
  assert.equal((windows.ask('b', 1) as { ahead: number }).ahead, 0);
  assert.equal((windows.ask('c', 2) as { ahead: number }).ahead, 1);
  windows.release('a');
  // c asks before b comes back, but b is ahead in the queue.
  assert.equal(windows.ask('c', 3).granted, false);
  assert.equal(windows.ask('b', 4).granted, true);
  windows.release('b');
  assert.equal(windows.ask('c', 5).granted, true);
});

test('a waiter that stops asking loses its place; the wait limit counts from the first ask', () => {
  const windows = new Windows({ windows: 1, staleWaiterMs: 30_000, waitMs: 5 * MIN });
  windows.ask('a', 0);
  windows.ask('b', 0);
  windows.ask('c', 0);
  // b keeps polling, c went quiet.
  for (let at = 10_000; at <= 40_000; at += 10_000) windows.ask('b', at);
  assert.equal((windows.ask('d', 45_000) as { ahead: number }).ahead, 1, 'c was dropped, d is behind b');
  for (let at = 50_000; at < 5 * MIN; at += 10_000) { windows.ask('b', at); windows.ask('d', at); }
  const late = windows.ask('b', 5 * MIN);
  assert.equal(windows.waitedTooLong(late, 5 * MIN), true);
  windows.leaveQueue('b');
  assert.equal((windows.ask('d', 5 * MIN) as { ahead: number }).ahead, 0);
});

test('idle windows are found after the idle time; using a window keeps it', () => {
  const windows = new Windows({ idleMs: 5 * MIN });
  windows.ask('a', 0);
  windows.ask('b', 0);
  windows.touch('b', 4 * MIN);
  assert.deepEqual(windows.idle(5 * MIN).map(holder => holder.session), ['a']);
  assert.deepEqual(windows.idle(9 * MIN).map(holder => holder.session), ['a', 'b']);
});

test('pages belong to the conversation that opened them', () => {
  const windows = new Windows();
  windows.ask('a', 0);
  windows.setPage('a', 3);
  assert.equal(windows.ownerOf(3), 'a');
  assert.equal(windows.ownerOf(4), undefined);
  assert.equal(windows.release('a')?.pageId, 3);
  assert.equal(windows.ownerOf(3), undefined);
});

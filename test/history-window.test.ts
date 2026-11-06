import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendNewer, joinLatest, pageItems, preparePage, prependOlder, touchesWindow, WINDOW_ITEMS, type Page } from '../src/web/history-window.ts';
import type { WorkbenchItem } from '../src/shared/workbench.ts';

const item = (n: number, text = `item ${n}`): WorkbenchItem => ({ id: `item-${n}`, kind: 'assistant', text, status: 'completed' });
/** A synthetic native list of `total` items paged newest-first, 50 per page, cursors are positions. */
function nativePage(total: number, cursor: string | null): Page {
  const end = cursor === null ? total : Number(cursor); const start = Math.max(0, end - 50);
  return preparePage(cursor, Array.from({ length: end - start }, (_, index) => item(start + index)), start ? String(start) : null);
}
const ids = (pages: Page[]) => pageItems(pages).map(value => Number(value.id.slice(5)));
const contiguous = (values: number[]) => values.every((value, index) => index === 0 || value === values[index - 1]! + 1);

test('scrolling up through a very long conversation keeps a bounded, contiguous window and every page can be read back', () => {
  const total = 100_000;
  let pages = [nativePage(total, null)]; let newer: (string | null)[] = []; let peak = 0;
  // Scroll to the very first message.
  while (pages[0]!.olderCursor) {
    const result = prependOlder(pages, nativePage(total, pages[0]!.olderCursor));
    pages = result.pages; newer = [...newer, ...result.dropped];
    const window = ids(pages); peak = Math.max(peak, window.length);
    assert.ok(contiguous(window));
  }
  assert.equal(ids(pages)[0], 0);
  assert.ok(peak <= WINDOW_ITEMS, 'the window never grows past its item bound');
  assert.equal(newer[0], null, 'the latest page leaves first and returns last');
  // Scroll all the way back down.
  while (newer.length) {
    const cursor = newer.at(-1)!; newer = newer.slice(0, -1);
    pages = appendNewer(pages, nativePage(total, cursor));
    assert.ok(contiguous(ids(pages)));
  }
  assert.equal(ids(pages).at(-1), total - 1);
});

test('a fresh latest page joins the window, splitting off what scrolled out, and a gap is reported instead of hidden', () => {
  const older = nativePage(200, '150');
  let pages = [older, nativePage(200, null)];
  // 20 new items: the newest page now starts 20 items later; the 20 that scrolled out stay as their own page.
  const fresh = nativePage(220, null);
  const joined = joinLatest(pages, fresh)!;
  assert.deepEqual(ids(joined), Array.from({ length: 120 }, (_, index) => 100 + index));
  assert.equal(joined.length, 3); assert.equal(joined[1]!.cursor, fresh.olderCursor, 'the split page is re-readable through the fresh page');
  assert.deepEqual(nativePage(220, joined[1]!.cursor).items.slice(-20).map(value => value.id), joined[1]!.items.map(value => value.id));
  pages = joined;
  // Far more output than one page: the window cannot be joined without reading what lies between.
  assert.equal(joinLatest(pages, nativePage(1000, null)), undefined);
  // A window that has already left the latest page is never joined to it.
  assert.equal(joinLatest([older], fresh), undefined);
});

test('newer copies win where pages overlap, and turn files attach to each run once', () => {
  const stale = preparePage('c', [item(1), { ...item(2), status: 'running' }], null);
  const fresh = preparePage(null, [{ ...item(2), text: 'done' }, item(3)], 'c');
  assert.deepEqual(pageItems([stale, fresh]).map(value => [value.id, value.text]), [['item-1', 'item 1'], ['item-2', 'done'], ['item-3', 'item 3']]);
  const runs = preparePage(null, [{ ...item(1), runId: 'a' }, { ...item(2), runId: 'a' }, { ...item(3), runId: 'b' }], null, [
    { runId: 'a', paths: ['x.ts'], limited: false }, { runId: 'b', paths: ['y.ts'], limited: false }]);
  assert.deepEqual(runs.items.map(value => value.turnFiles?.runId ?? null), [null, 'a', 'b']);
});

test('a single oversized page is kept whole rather than trimmed into a hole', () => {
  const big = preparePage('x', Array.from({ length: 600 }, (_, index) => item(index)), '0');
  const result = prependOlder([nativePage(1000, null)], big);
  assert.equal(result.pages.length, 1); assert.equal(result.pages[0]!.items.length, 600);
  assert.deepEqual(result.dropped, [null]);
});

test('the latest page read back at the newer end joins when adjacent or overlapping, and not across new output', () => {
  const total = 1000;
  const window = [nativePage(total, '900'), nativePage(total, '950')];
  assert.equal(touchesWindow(window, nativePage(total, null)), true, 'adjacent: its older cursor reads the window newest page');
  assert.equal(touchesWindow(window, preparePage(null, Array.from({ length: 50 }, (_, index) => item(940 + index)), '940')), true, 'overlapping pages join');
  assert.equal(touchesWindow(window, nativePage(total + 20, null)), false, 'twenty new items leave a gap after the window');
  assert.equal(touchesWindow(window, nativePage(total + 400, null)), false, 'a gap of new output starts a new window');
});

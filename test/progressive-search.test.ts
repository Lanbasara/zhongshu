import assert from 'node:assert/strict';
import { test } from 'node:test';
import { progressiveSearch } from '../src/web/progressive-search.ts';

test('500 empty scan batches advance without clicks, yield between requests, and retain one final page', async () => {
  const controller = new AbortController(); let requests = 0; let active = 0; let yielded = false; let published: string[] = []; let scanned = 0;
  setTimeout(() => { yielded = true; }, 0);
  await progressiveSearch({ signal: controller.signal, continuous: true, paused: () => false,
    fetch: async cursor => {
      assert.equal(active++, 0); const index = Number(cursor ?? 0); assert.equal(index, requests++); active--;
      if (index > 0) assert.equal(yielded, true);
      return { value: index === 500 ? ['only-result-page'] : [], scanned: 200, nextCursor: index === 500 ? null : String(index + 1), found: index === 500 };
    }, progress: (batch, total) => { published = batch.value; scanned = total; },
  });
  assert.equal(requests, 501); assert.equal(scanned, 100200); assert.deepEqual(published, ['only-result-page']);
});

test('pause preserves the acknowledged continuation; resuming starts after it without replaying earlier scans', async () => {
  const controller = new AbortController(); const visited: number[] = []; let pause = false;
  const fetch = async (cursor?: string) => { const index = Number(cursor ?? 0); visited.push(index); return { value: [], scanned: 200, nextCursor: index === 4 ? null : String(index + 1), found: false }; };
  const stopped = await progressiveSearch({ signal: controller.signal, continuous: true, paused: () => pause, fetch,
    progress: (_, scanned) => { if (scanned === 400) pause = true; } });
  assert.equal(stopped.nextCursor, '2'); assert.deepEqual(visited, [0, 1]);
  await progressiveSearch({ cursor: stopped.nextCursor!, signal: controller.signal, continuous: true, paused: () => false, fetch, progress: () => {} });
  assert.deepEqual(visited, [0, 1, 2, 3, 4]);
});

test('a changed query aborts during a late transport response and never publishes old results', async () => {
  const controller = new AbortController(); let finish!: () => void; let started!: () => void; let publications = 0;
  const pending = new Promise<void>(resolve => { finish = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
  const run = progressiveSearch({ signal: controller.signal, continuous: true, paused: () => false,
    fetch: async () => { started(); await pending; return { value: ['stale'], scanned: 200, nextCursor: 'next', found: true }; },
    progress: () => { publications++; },
  });
  await entered; controller.abort(); finish(); await assert.rejects(run, { name: 'AbortError' }); assert.equal(publications, 0);
});

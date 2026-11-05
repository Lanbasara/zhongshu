import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type CursorChunk<T> = { value: T; next: string | null; cursor?: string };
type WindowPage<T> = CursorChunk<T> & { index: number; cursor?: string };
type Entry<T> = { pages: WindowPage<T>[]; anchors: Map<number, string | undefined>; checked: number; revision: unknown };
/** Only response windows are cached. Sparse bookmarks permit backward traversal
 * after eviction without retaining every visited response or cursor forever. */
export class CursorWindowCache<T> {
  private entries = new Map<string, Entry<T>>();
  get(key: string): Entry<T> {
    const value = this.entries.get(key) ?? { pages: [], anchors: new Map([[0, undefined]]), checked: 0, revision: undefined };
    this.entries.delete(key); this.entries.set(key, value);
    while (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
  trim() {
    let bytes = 0;
    for (const [key, value] of [...this.entries].reverse()) {
      bytes += (key.length + JSON.stringify(value.pages).length + JSON.stringify([...value.anchors]).length) * 2;
      if (bytes > 4 * 1024 * 1024 && this.entries.size > 1) this.entries.delete(key);
    }
  }
}
function bookmark<T>(entry: Entry<T>, index: number, cursor: string | undefined) {
  entry.anchors.set(index, cursor);
  if (entry.anchors.size <= 128) return;
  const indexes = [...entry.anchors.keys()].sort((a, b) => a - b);
  let remove = indexes[1]!, gap = Infinity;
  for (let i = 1; i < indexes.length - 33; i++) {
    const span = indexes[i + 1]! - indexes[i - 1]!;
    if (span < gap) { gap = span; remove = indexes[i]!; }
  }
  entry.anchors.delete(remove);
}
function scrollRoot(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement)
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  return null;
}

export function useCursorWindow<T>({ key, load, enabled = true, initial, cache: supplied, revision, staleMs = 30_000, onError }: {
  key: string; load(cursor: string | undefined, signal: AbortSignal, intent: 'load' | 'refresh'): Promise<CursorChunk<T>>; enabled?: boolean;
  initial?: CursorChunk<T>; cache?: CursorWindowCache<T>; revision?: unknown; staleMs?: number; onError?(error: unknown): void;
}) {
  const localCache = useRef(new CursorWindowCache<T>());
  const cache = supplied ?? localCache.current;
  const entry = cache.get(key);
  if (!entry.pages.length && initial) { entry.pages = [{ ...initial, index: 0 }]; entry.checked = Date.now(); entry.revision = revision; }
  const [, render] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const active = useRef<{ key: string; abort: AbortController } | undefined>(undefined);
  const latest = useRef({ load, onError, revision }); latest.current = { load, onError, revision };
  const anchor = useRef<{ root: HTMLElement; node: HTMLElement; top: number } | undefined>(undefined);
  const marker = useRef<HTMLDivElement>(null);
  function rememberPosition() {
    const root = marker.current && scrollRoot(marker.current); if (!root) return;
    const edge = root.getBoundingClientRect().top;
    const node = [...root.querySelectorAll<HTMLElement>('[data-scroll-row]')].find(node => node.getBoundingClientRect().bottom > edge + 1);
    if (node) anchor.current = { root, node, top: node.getBoundingClientRect().top };
  }
  useLayoutEffect(() => {
    const saved = anchor.current; anchor.current = undefined;
    if (saved?.node.isConnected) saved.root.scrollTop += saved.node.getBoundingClientRect().top - saved.top;
  });
  async function fetchIndex(index: number, signal: AbortSignal, intent: 'load' | 'refresh' = 'load'): Promise<WindowPage<T>> {
    const read = latest.current.load;
    const starts = [...entry.anchors.keys()].filter(value => value <= index);
    let at = Math.max(...starts), cursor = entry.anchors.get(at);
    for (;;) {
      const result = await read(cursor, signal, intent); signal.throwIfAborted();
      if (result.next) bookmark(entry, at + 1, result.next);
      if (at === index || !result.next) {
        const start = result.cursor ?? cursor; bookmark(entry, at, start);
        return { ...result, index: at, cursor: start };
      }
      cursor = result.next; at++;
      await new Promise(resolve => setTimeout(resolve, 0)); signal.throwIfAborted();
    }
  }
  async function fetchPage(direction: 'next' | 'previous' | 'refresh' | 'reset') {
    if (!enabled || active.current) return;
    const abort = new AbortController(); const observedRevision = latest.current.revision;
    active.current = { key, abort }; setPending(true); setError(undefined);
    const first = entry.pages[0], last = entry.pages.at(-1);
    try {
      let pages: WindowPage<T>[];
      if (direction === 'reset') {
        entry.anchors = new Map([[0, undefined]]); pages = [await fetchIndex(0, abort.signal)];
      } else if (direction === 'refresh') {
        pages = [];
        for (const old of entry.pages.length ? entry.pages : [{ index: 0 }]) pages.push(await fetchIndex(old.index, abort.signal, entry.pages.length ? 'refresh' : 'load'));
      } else {
        const index = direction === 'next' ? (last?.index ?? -1) + 1 : Math.max(0, (first?.index ?? 0) - 1);
        const page = await fetchIndex(index, abort.signal);
        pages = [...entry.pages.filter(old => old.index !== page.index), page].sort((a, b) => a.index - b.index);
        if (pages.length > 3) pages = direction === 'next' ? pages.slice(-3) : pages.slice(0, 3);
      }
      abort.signal.throwIfAborted(); rememberPosition(); entry.pages = pages; entry.checked = Date.now(); entry.revision = observedRevision;
      cache.trim(); render(value => value + 1);
    } catch (reason) { if (!abort.signal.aborted) { setError(reason); latest.current.onError?.(reason); } }
    finally { if (active.current?.abort === abort) { active.current = undefined; setPending(false); } }
  }
  useEffect(() => {
    setPending(false); setError(undefined);
    if (enabled && (!entry.pages.length || Date.now() - entry.checked > staleMs)) void fetchPage('refresh');
    return () => { active.current?.abort.abort(); active.current = undefined; };
  }, [key, enabled]);
  useEffect(() => {
    if (!enabled || entry.revision === revision) return;
    const timer = setTimeout(() => void fetchPage('refresh'), 250);
    return () => clearTimeout(timer);
  }, [key, enabled, revision, pending]);
  return { pages: entry.pages.map(page => page.value), data: entry.pages.at(-1)?.value, pending, error, marker,
    canPrevious: (entry.pages[0]?.index ?? 0) > 0, canNext: !!entry.pages.at(-1)?.next,
    next: () => void fetchPage('next'), previous: () => void fetchPage('previous'), refresh: () => void fetchPage('refresh'),
    reset() { void fetchPage('reset'); },
  };
}

/** Offscreen workspace groups keep their measured space, not their row DOM or
 * live requests. The feed cache owns data across unmounts. */
export function WindowRegion({ children }: { children: ReactNode }) {
  const node = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false); const height = useRef(48);
  useEffect(() => {
    if (!node.current) return;
    const observer = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), { root: scrollRoot(node.current), rootMargin: '240px' });
    observer.observe(node.current); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!near || !node.current) return;
    const measure = () => { const measured = node.current?.getBoundingClientRect().height; if (measured) height.current = measured; };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node.current); return () => observer.disconnect();
  }, [near]);
  return <div ref={node} style={near ? undefined : { height: height.current }}>{near ? children : null}</div>;
}

export function ScrollContinuation({ available, pending, load, automatic = true, label = '加载更多', className = '' }: {
  available: boolean; pending: boolean; load(): void; automatic?: boolean; label?: string; className?: string;
}) {
  const marker = useRef<HTMLDivElement>(null); const action = useRef(load); action.current = load;
  useEffect(() => {
    const node = marker.current;
    if (!node || !available || pending || !automatic) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) action.current(); }, { root: scrollRoot(node), rootMargin: '24px' });
    observer.observe(node); return () => observer.disconnect();
  }, [available, pending, automatic]);
  if (!available && !pending) return null;
  return <div ref={marker} className={`scroll-continuation ${className}`}>
    {pending ? <span role="status">正在加载…</span> : <button type="button" className="text-button" onClick={load}>{label}</button>}
  </div>;
}

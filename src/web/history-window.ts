import type { TurnFileSummary, WorkbenchItem } from '../shared/workbench.ts';

/**
 * The browser keeps a bounded window of native history pages (ADR 0014). Each page remembers the cursor that
 * reads it again, so pages can leave the window at either end and return later without a local copy.
 */
export type PageItem = WorkbenchItem & { turnFiles?: TurnFileSummary };
/** `cursor` re-reads this page: null is the native latest page. `olderCursor` reads the page before it. */
export type Page = { cursor: string | null; items: PageItem[]; olderCursor: string | null };

export const WINDOW_ITEMS = 500;
export const WINDOW_BYTES = 8 * 1024 * 1024;

/** Retained UTF-16 text plus a fixed DOM cost per entry. */
export const itemWeight = (item: PageItem) => item.text.length * 2 + 2048 +
  (item.turnFiles?.paths.reduce((bytes, path) => bytes + path.length * 2 + 16, 0) ?? 0);

/** Pages are whole: trimming inside one would leave a hole behind its older cursor. */
export function exceeds(pages: Page[]): boolean {
  let count = 0; let bytes = 0;
  for (const page of pages) for (const item of page.items) { count++; bytes += itemWeight(item); }
  return count > WINDOW_ITEMS || bytes > WINDOW_BYTES;
}

/** Attach each run's edited-file summary to that run's last item in the page. */
export function preparePage(cursor: string | null, items: WorkbenchItem[], olderCursor: string | null, turnFiles: TurnFileSummary[] = []): Page {
  const summaries = new Map(turnFiles.map(summary => [summary.runId, summary]));
  const prepared: PageItem[] = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    const summary = item.runId ? summaries.get(item.runId) : undefined;
    if (summary) summaries.delete(summary.runId);
    prepared.push(summary ? { ...item, turnFiles: summary } : item);
  }
  return { cursor, items: prepared.reverse(), olderCursor };
}

/** Chronological items of the window. Newer copies win where neighbouring native pages overlap. */
export function pageItems(pages: Page[]): PageItem[] {
  const seen = new Set<string>(); const output: PageItem[] = [];
  for (let page = pages.length - 1; page >= 0; page--) {
    const items = pages[page]!.items;
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      if (!seen.has(item.id)) { seen.add(item.id); output.push(item); }
    }
  }
  return output.reverse();
}

/** Drop whole pages from the older end; the new first page's older cursor still reaches them. */
export function trimOldest(pages: Page[]): Page[] {
  const next = [...pages];
  while (next.length > 1 && exceeds(next)) next.shift();
  return next;
}

/** Add an older page. Pages leaving the newer end return their cursors, nearest last, for reading back later. */
export function prependOlder(pages: Page[], page: Page): { pages: Page[]; dropped: (string | null)[] } {
  const next = [page, ...pages]; const dropped: (string | null)[] = [];
  while (next.length > 1 && exceeds(next)) dropped.push(next.pop()!.cursor);
  return { pages: next, dropped };
}

/** Add a page read back at the newer end. */
export function appendNewer(pages: Page[], page: Page): Page[] {
  return trimOldest([...pages, page]);
}

/** Join a fresh latest page to a window that ends at the latest page; undefined when they do not touch. */
export function joinLatest(pages: Page[], latest: Page): Page[] | undefined {
  const last = pages.at(-1);
  if (!last || last.cursor !== null) return undefined;
  const rest = pages.slice(0, -1);
  if (!latest.items.length || !last.items.length) return [...rest, latest];
  const start = last.items.findIndex(item => item.id === latest.items[0]!.id);
  if (start === 0) return [...rest, latest];
  // Keep the part that scrolled out of the newest native page as its own page, re-readable through the latest page's older cursor.
  if (start > 0) return [...rest, { cursor: latest.olderCursor, items: last.items.slice(0, start), olderCursor: last.olderCursor }, latest];
  if (latest.items.some(item => item.id === last.items[0]!.id)) return [...rest, latest];
  return undefined;
}

/** Whether a page read back at the newer end continues the window: adjacent through its older cursor, or overlapping. */
export function touchesWindow(pages: Page[], page: Page): boolean {
  const last = pages.at(-1);
  if (!last || !page.items.length || !last.items.length) return true;
  if (last.cursor !== null && page.olderCursor === last.cursor) return true;
  const known = new Set(last.items.map(item => item.id));
  return page.items.some(item => known.has(item.id));
}

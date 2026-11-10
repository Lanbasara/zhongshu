// Layer 0 (ADR 0024): rules for native history pages, cursors and the public item view. No state.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HarnessError, type HarnessAdapter, type HistoryPage, type NativeItem } from '../../harness/types.ts';
import { itemSchema, type BodyPatch, type WorkbenchItem } from '../../shared/workbench.ts';
import { StoreError, type Conversation } from '../workbench-store.ts';

/** Target items per native history page; adapters translate it into their own page unit. */
export const HISTORY_PAGE_SIZE = 50;
/** Hard bounds on what one native page may contribute to a response. */
const HISTORY_PAGE_ITEMS = 400;
/** Serialized bytes, so escaping cannot push a whole page past the response budget. */
const HISTORY_PAGE_BYTES = 6 * 1024 * 1024;
const NATIVE_CURSOR_LENGTH = 4096;
/** Native pages may hold only non-display events; skip at most this many to reach visible content. */
const EMPTY_PAGE_SKIP = 20;
const cursorEnvelope = z.object({ c: z.uuid(), n: z.string().min(1).max(NATIVE_CURSOR_LENGTH) }).strict();
const UNDISPLAYABLE = '这条原生内容超出显示限制，未能展示。';

/** Strip adapter-only fields and keep the public item contract strict. */
export function viewItem(item: NativeItem): WorkbenchItem {
  const { fileEdits: _edits, imageSources: _sources, ...rest } = item;
  const parsed = itemSchema.safeParse(rest);
  if (parsed.success) return parsed.data;
  return { id: item.id, kind: 'notice', text: UNDISPLAYABLE, status: 'unknown', ...(item.runId ? { runId: item.runId } : {}) };
}
const tailMark = (items: NativeItem[], cursor: string | null) =>
  items.map(item => `${item.id}\u0000${item.status}\u0000${item.text.length}`).join('\u0001') + '\u0002' + (cursor ?? '');
/** Durable, fixed-size mark of a native latest page (ADR 0019); equal pages give equal marks across reads and restarts. */
export const pageMark = (items: NativeItem[], cursor: string | null) =>
  'page:' + createHash('sha256').update(tailMark(items, cursor)).digest('base64url');
/** A growing body as a patch against what was last sent: appended text when it only grew, the whole value otherwise. */
export function bodyPatch(previous: string | undefined, next: string): BodyPatch {
  return previous !== undefined && next.length >= previous.length && next.startsWith(previous)
    ? { at: previous.length, append: next.slice(previous.length) } : { value: next };
}
export const liveMark = (item: NativeItem) =>
  `${item.status}\u0000${item.text.length}\u0000${item.text.slice(-32)}\u0000${item.tool?.exitCode ?? ''}\u0000` +
  `${item.tool?.output?.length ?? ''}\u0000${item.fileEdits?.length ?? ''}`;
/** Serialized size of the displayable part of a native page; transient image sources are excluded. */
function pageBytes(page: HistoryPage): number {
  let bytes = 0;
  for (const item of page.items) { const { imageSources: _sources, fileEdits: _edits, ...view } = item; bytes += Buffer.byteLength(JSON.stringify(view)); }
  return bytes;
}
export function historyErrorCode(error: unknown): string {
  if (error instanceof StoreError) return error.code;
  if (error instanceof HarnessError && /cursor/i.test(error.code)) return 'history_cursor_invalid';
  return 'native_history_unavailable';
}

/** A server-issued cursor that only this conversation can use. */
export function wrapCursor(id: string, native: string | null): string | null {
  if (native === null) return null;
  if (typeof native !== 'string' || !native || native.length > NATIVE_CURSOR_LENGTH) throw new StoreError('native_history_page_limit', 502);
  return Buffer.from(JSON.stringify({ c: id, n: native })).toString('base64url');
}
export function unwrapCursor(id: string, cursor: string): string {
  try {
    const value = cursorEnvelope.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (value.c === id) return value.n;
  } catch { /* rejected below */ }
  throw new StoreError('history_cursor_invalid', 400);
}

/** One native page with visible content (or the beginning). An advancing cursor over hidden events is progress. */
export async function readPage(conversation: Conversation, adapter: HarnessAdapter, cursor: string | undefined): Promise<HistoryPage> {
  const seen = new Set<string>();
  for (let skipped = 0; ; skipped++) {
    // A page too large to serialize is asked for again with fewer items from the same cursor.
    let limit = HISTORY_PAGE_SIZE; let page: HistoryPage;
    for (;;) {
      page = await adapter.history(conversation.binding!, cursor, limit);
      // A single oversized item is still returned; its view is replaced by an explicit notice when it cannot display.
      checkPage(page, true);
      if (pageBytes(page) <= HISTORY_PAGE_BYTES || limit === 1) break;
      limit = Math.ceil(limit / 2);
    }
    if (page.items.length || !page.olderCursor || skipped >= EMPTY_PAGE_SKIP) return page;
    if (seen.has(page.olderCursor)) throw new StoreError('history_no_progress', 502);
    seen.add(page.olderCursor); cursor = page.olderCursor;
  }
}
function checkPage(page: HistoryPage, shrinkable = false): void {
  if (!page || !Array.isArray(page.items) || page.items.length > HISTORY_PAGE_ITEMS ||
    (page.olderCursor !== null && (typeof page.olderCursor !== 'string' || !page.olderCursor || page.olderCursor.length > NATIVE_CURSOR_LENGTH)))
    throw new StoreError('native_history_page_limit', 502);
  if (!shrinkable && pageBytes(page) > HISTORY_PAGE_BYTES) throw new StoreError('native_history_page_limit', 502);
}

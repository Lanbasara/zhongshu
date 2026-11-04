import { parseMarkdownIntoBlocks } from 'streamdown';

export type WorkspacePreviewPage = { text: string; raw: boolean };
const pageCharacters = 16 * 1024;

/** Keep Markdown blocks together when they fit. A single pathological table,
 * paragraph or code block uses bounded raw pages rather than one giant DOM. */
export function workspacePreviewPages(text: string, paginate: boolean): WorkspacePreviewPage[] {
  if (!paginate) return [{ text, raw: false }];
  const pages: WorkspacePreviewPage[] = [];
  let pending: string[] = [], characters = 0;
  function flush() {
    if (pending.length) pages.push({ text: pending.join(''), raw: false });
    pending = []; characters = 0;
  }
  for (const block of parseMarkdownIntoBlocks(text)) {
    if (block.length > pageCharacters) {
      flush();
      for (let from = 0; from < block.length;) {
        let to = Math.min(block.length, from + pageCharacters);
        if (to < block.length && /[\uD800-\uDBFF]/.test(block[to - 1]!)) to--;
        pages.push({ text: block.slice(from, to), raw: true }); from = to;
      }
    } else {
      if (pending.length && (pending.length >= 48 || characters + block.length > pageCharacters)) flush();
      pending.push(block); characters += block.length;
    }
  }
  flush();
  return pages.length ? pages : [{ text: '', raw: false }];
}

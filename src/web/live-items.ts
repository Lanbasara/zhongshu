import type { BodyPatch, LiveEvent, WorkbenchItem } from '../shared/workbench.ts';

/** In-flight items a page keeps, matching the snapshot's own bound. */
export const LIVE_ITEMS_KEPT = 100;

/**
 * Applies a body patch to what this page holds. `undefined` means the page lacks the text the patch was cut
 * against and must re-read the snapshot; a patch it already has is a no-op.
 */
export function applyPatch(current: string | undefined, patch: BodyPatch): string | undefined {
  if ('value' in patch) return patch.value;
  if (current === undefined || patch.at > current.length) return undefined;
  if (patch.at + patch.append.length <= current.length) return current;
  return current.slice(0, patch.at) + patch.append;
}

/**
 * Applies one live frame to the page's in-flight items (ADR 0019). An updated item keeps its place, a new one is
 * appended. Returns `'gap'` when the frame cannot be applied and the page needs a fresh snapshot.
 */
export function applyLiveFrame(items: readonly WorkbenchItem[], frame: LiveEvent): WorkbenchItem[] | 'gap' {
  if (!('item' in frame)) return 'gap';
  const index = items.findIndex(item => item.id === frame.item.id);
  const current = index < 0 ? undefined : items[index];
  const text = applyPatch(current?.text, frame.text);
  if (text === undefined) return 'gap';
  const { tool: frameTool, ...rest } = frame.item;
  let tool: WorkbenchItem['tool'] = frameTool;
  if (frame.output) {
    const output = applyPatch(current?.tool?.output, frame.output);
    if (output === undefined) return 'gap';
    tool = { name: '', ...frameTool, output };
  }
  const next: WorkbenchItem = { ...rest, text, ...(tool ? { tool } : {}) };
  if (index < 0) return [...items, next].slice(-LIVE_ITEMS_KEPT);
  const updated = [...items]; updated[index] = next;
  return updated;
}

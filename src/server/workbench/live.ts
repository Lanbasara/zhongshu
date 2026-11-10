// Layer 2 (ADR 0024): the live stream (ADR 0019). Frames are never stored; they are numbered per process so a page
// notices a missed frame, and each carries only what a body appended since the last frame.
import { randomBytes } from 'node:crypto';
import type { NativeItem } from '../../harness/types.ts';
import type { LiveCursor, LiveEvent } from '../../shared/workbench.ts';
import { bodyPatch, viewItem } from './pages.ts';

/** Bodies last sent per live item of one conversation. */
export type SentBodies = Map<string, { text: string; output?: string }>;

export class LiveStream {
  private readonly epoch = randomBytes(12).toString('base64url');
  private sequence = 0;
  private readonly listeners = new Set<(frames: LiveEvent[]) => void>();

  /** Subscribe to live frames; returns the unsubscribe function. */
  onLive(listener: (frames: LiveEvent[]) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  cursor(): LiveCursor { return { epoch: this.epoch, sequence: this.sequence }; }
  publish(id: string, sent: SentBodies, changed: NativeItem[]): void {
    const frames: LiveEvent[] = [];
    for (const native of changed) {
      const { text, ...view } = viewItem(native);
      const { output, ...tool } = view.tool ?? { name: '' };
      const previous = sent.get(native.id);
      sent.set(native.id, { text, ...(output === undefined ? {} : { output }) });
      frames.push({ type: 'live', sequence: ++this.sequence, conversationId: id, item: { ...view, ...(view.tool ? { tool } : {}) },
        text: bodyPatch(previous?.text, text), ...(output === undefined ? {} : { output: bodyPatch(previous?.output, output) }) });
    }
    for (const listener of this.listeners) { try { listener(frames); } catch { /* a page that misses frames re-reads the snapshot */ } }
  }
}

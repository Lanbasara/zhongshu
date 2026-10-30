import { HarnessError } from '../types.ts';
import type { NativeItem } from '../types.ts';
import { assistantId, object, runId } from './native.ts';
import type { Snapshot } from './native.ts';

/** One bounded, process-local attempt. Durable assistant items use the same turn/step ID. */
export class LiveAssistant {
  private session: string;
  private attempt: { id: string; turn: number; step: number; next: number; revision: number } | undefined;
  private blocks = new Map<number, string>();
  constructor(session: string) { this.session = session; }
  private append(index: number, text: string, replace = false): void {
    if (!Number.isSafeInteger(index) || index < 0 || index > 127 || text.length > 1024 * 1024) throw new HarnessError('DSH_STREAM_INVALID');
    this.blocks.set(index, replace ? text : (this.blocks.get(index) ?? '') + text);
    if ([...this.blocks.values()].reduce((sum, value) => sum + value.length, 0) > 1024 * 1024) throw new HarnessError('DSH_ITEM_TOO_LARGE');
  }
  private chunk(value: unknown): void {
    const chunk = object(value);
    if (chunk.type === 'text-delta' && typeof chunk.index === 'number' && typeof chunk.text === 'string') this.append(chunk.index, chunk.text);
    if (chunk.type === 'block-end') { const block = object(chunk.block); if (block.type === 'text' && typeof block.text === 'string' && typeof chunk.index === 'number') this.append(chunk.index, block.text, true); }
  }
  restore(snapshot: Snapshot): NativeItem | undefined {
    this.blocks.clear(); this.attempt = undefined;
    const active = snapshot.assistantStream?.activeAttempt;
    if (!active) return;
    this.attempt = { id: active.attemptId, turn: active.turn, step: active.step, next: active.nextIndex, revision: snapshot.assistantStream?.revision ?? 0 };
    for (const value of active.stream) {
      const record = object(value);
      if (record.type === 'text-chunks' && Array.isArray(record.texts) && typeof record.index === 'number') for (const text of record.texts) { if (typeof text !== 'string') throw new HarnessError('DSH_STREAM_INVALID'); this.append(record.index, text); }
      if (record.type === 'chunk') this.chunk(record.chunk);
    }
    return this.item();
  }
  accept(value: unknown): { item?: NativeItem; invalidate?: boolean; resubscribe?: boolean } {
    const frame = object(value);
    if (frame.type === 'start') {
      if (typeof frame.attemptId !== 'string' || typeof frame.turn !== 'number' || typeof frame.step !== 'number' || typeof frame.revision !== 'number') throw new HarnessError('DSH_STREAM_INVALID');
      if (this.attempt && frame.revision <= this.attempt.revision) return {};
      this.blocks.clear(); this.attempt = { id: frame.attemptId, turn: frame.turn, step: frame.step, revision: frame.revision, next: 0 }; return {};
    }
    const current = this.attempt;
    if (!current || frame.attemptId !== current.id) return { invalidate: true, resubscribe: true };
    if (frame.type === 'chunk') {
      if (typeof frame.index !== 'number' || typeof frame.revision !== 'number') throw new HarnessError('DSH_STREAM_INVALID');
      if (frame.index < current.next) return {};
      if (frame.index !== current.next || frame.revision <= current.revision) { this.attempt = undefined; this.blocks.clear(); return { invalidate: true, resubscribe: true }; }
      current.next++; current.revision = frame.revision; this.chunk(frame.chunk); return { item: this.item() };
    }
    if (frame.type === 'end') { this.attempt = undefined; this.blocks.clear(); return { invalidate: true }; }
    return { invalidate: true, resubscribe: true };
  }
  private item(): NativeItem | undefined {
    if (!this.attempt) return;
    const text = [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('');
    if (!text) return;
    return { id: assistantId(this.session, this.attempt.turn, this.attempt.step), runId: runId(this.session, this.attempt.turn), kind: 'assistant', text, status: 'running' };
  }
}

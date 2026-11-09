// Layer 2 (ADR 0024): how native items are presented, and a bounded memory of items recently served.
import type { NativeItem } from '../../harness/types.ts';
import { decodeImage } from '../resources.ts';
import { NATIVE_IMAGE_OWNER } from '../storage.ts';
import type { Conversation, WorkbenchStore } from '../workbench-store.ts';
import type { Bindings } from './bindings.ts';

/** Recently served native items, kept in memory to verify quotes and workspace images. */
const SERVED_ITEMS_BYTES = 32 * 1024 * 1024;

export class History {
  private readonly store: WorkbenchStore;
  private readonly bindings: Bindings;
  private readonly servedItems = new Map<string, { item: NativeItem; bytes: number }>();
  private servedBytes = 0;

  constructor(store: WorkbenchStore, bindings: Bindings) { this.store = store; this.bindings = bindings; }

  /** Materialize native items for display, index their edited paths and remember them. */
  async present(conversation: Conversation, items: NativeItem[]): Promise<NativeItem[]> {
    const presented = await this.materialize(conversation, items);
    try { this.store.recordTurnFiles(conversation.id, presented); } catch { /* the edited-path index is a hint, never a reading failure */ }
    this.remember(conversation.id, presented);
    return presented;
  }
  private async materialize(conversation: Conversation, items: NativeItem[]): Promise<NativeItem[]> {
    // Native image reads do not touch the workspace, so history stays readable after a workspace is removed.
    const adapter = this.bindings.historyAdapter(conversation);
    const output: NativeItem[] = [];
    for (const raw of items) {
      const { imageSources, ...item } = raw;
      if (imageSources?.length && conversation.binding && item.status === 'completed') {
        const images = [];
        for (const [index, source] of imageSources.slice(0,4).entries()) {
          try {
            // Native image copies are regenerable and may be evicted under the storage budget.
            const owner = `${NATIVE_IMAGE_OWNER}${item.id}:${index}`;
            const old = this.store.resources.owned(conversation.id, owner);
            if (old) { images.push({ id: old.id, name: old.name, mediaType: old.mediaType }); continue; }
            const encoded = source.data ?? (source.path && adapter?.readImage ? await adapter.readImage(conversation.binding, source.path) : undefined);
            if (!encoded) throw new Error('image_unavailable');
            const image = this.store.resources.put(conversation.id, 'Agent 图片 ' + (index + 1), decodeImage(encoded.replace(/^data:image\/[a-z]+;base64,/, '')), 'copy');
            this.store.resources.pin(conversation.id, image.id, owner); images.push(image);
          } catch { item.text = (item.text || '图片') + '\n图片暂时无法读取，请重新查询原生结果。'; }
        }
        if (images.length) item.images = images;
      }
      if (item.operationId && item.kind === 'user') {
        const operation = this.store.getOperation(item.operationId);
        if (operation?.type === 'message' && operation.conversationId === conversation.id) {
          item.text = operation.payload.text;
          item.images = operation.payload.images;
          item.references = operation.payload.references;
        }
      }
      output.push(item);
    }
    return output;
  }
  remember(id: string, items: NativeItem[]): void {
    for (const value of items) {
      const { imageSources: _sources, ...item } = value;
      const key = `${id}\u0000${item.id}`; const bytes = Buffer.byteLength(item.text) + 512;
      const old = this.servedItems.get(key); if (old) { this.servedItems.delete(key); this.servedBytes -= old.bytes; }
      if (bytes > SERVED_ITEMS_BYTES / 4) continue;
      this.servedItems.set(key, { item, bytes }); this.servedBytes += bytes;
    }
    for (const [key, entry] of this.servedItems) { if (this.servedBytes <= SERVED_ITEMS_BYTES) break; this.servedItems.delete(key); this.servedBytes -= entry.bytes; }
  }
  forget(id: string): void {
    for (const [key, entry] of this.servedItems) if (key.startsWith(`${id}\u0000`)) { this.servedItems.delete(key); this.servedBytes -= entry.bytes; }
  }
  served(id: string, itemId: string): NativeItem | undefined { return this.servedItems.get(`${id}\u0000${itemId}`)?.item; }
}

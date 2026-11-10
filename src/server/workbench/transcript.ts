// Layer 4 (ADR 0024): reading a conversation beyond its first screen: older native pages, workspace images that a
// message embeds, and the workspace files the conversation can reference. Nothing here is persisted except image copies.
import { createHash } from 'node:crypto';
import type { HistoryPage } from '../../harness/types.ts';
import { referenceSchema } from '../../shared/content.ts';
import { decodeImage, workspaceFiles, workspacePath } from '../resources.ts';
import { StoreError, type WorkbenchStore } from '../workbench-store.ts';
import type { Bindings } from './bindings.ts';
import type { Gate } from './gate.ts';
import type { History } from './history.ts';
import type { Observation } from './observation.ts';
import { historyErrorCode, readPage, unwrapCursor, viewItem, wrapCursor } from './pages.ts';
import type { Tasks } from './tasks.ts';

type Deps = { store: WorkbenchStore; tasks: Tasks; bindings: Bindings; gate: Gate; history: History; observation: Observation };

export class Transcript {
  private readonly store: WorkbenchStore;
  private readonly tasks: Tasks;
  private readonly bindings: Bindings;
  private readonly gate: Gate;
  private readonly history: History;
  private readonly observation: Observation;

  constructor(deps: Deps) {
    this.store = deps.store; this.tasks = deps.tasks; this.bindings = deps.bindings;
    this.gate = deps.gate; this.history = deps.history; this.observation = deps.observation;
  }

  /** One older native page, addressed by a cursor the server issued for this conversation. Nothing is persisted. */
  async olderPage(id: string, cursor: string) {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    const conversation = this.bindings.conversation(id); const adapter = this.bindings.historyAdapter(conversation);
    if (!adapter) throw new StoreError('conversation_not_ready', 409);
    const native = unwrapCursor(id, cursor);
    return this.tasks.task(async () => {
      let page: HistoryPage;
      try { page = await readPage(conversation, adapter, native); }
      catch (error) { const code = historyErrorCode(error); throw new StoreError(code, code === 'history_cursor_invalid' ? 409 : 502); }
      this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
      const items = (await this.history.present(conversation, page.items)).map(viewItem);
      const runIds = [...new Set(items.flatMap(item => item.runId ? [item.runId] : []))];
      return { items, olderCursor: wrapCursor(id, page.olderCursor), turnFiles: this.store.readTurnFiles(id, runIds.reverse()) };
    });
  }
  async workspaceImage(id: string, itemId: string, source: string) {
    const conversation = this.bindings.conversation(id);
    const owner = 'markdown:' + createHash('sha256').update(itemId + '\0' + source).digest('hex');
    // A saved first-readable snapshot was verified against its message when it was created.
    const cached = this.store.resources.owned(id, owner); if (cached) return cached;
    const item = await this.observation.locateItem(id, itemId);
    if (!item || !item.text.includes(source)) throw new StoreError('image_unavailable', 404);
    const reference = referenceSchema.parse({ type: 'file', path: decodeURIComponent(source).replace(/^\.\//, '') });
    if (reference.type !== 'file') throw new StoreError('invalid_request', 400);
    const adapter = this.bindings.adapter(conversation);
    if (!conversation.binding || !adapter.readImage) throw new StoreError('image_unavailable', 404);
    const path = await workspacePath(conversation.cwd, reference.path);
    // Read in the native Host, never turn Markdown into a host-user filesystem proxy.
    const data = decodeImage(await adapter.readImage(conversation.binding, path));
    this.bindings.assertWorkspaceAvailable(conversation.workspaceId);
    const image = this.store.resources.put(id, reference.path.split('/').at(-1)!.slice(0,120), data, 'copy');
    this.store.resources.pin(id, image.id, owner);
    return this.store.resources.get(id, image.id);
  }
  async files(id: string, directory = '') {
    const conversation = this.bindings.conversation(id); this.bindings.adapter(conversation);
    const result = await workspaceFiles(conversation.cwd, directory);
    this.bindings.assertWorkspaceAvailable(conversation.workspaceId);
    return result;
  }
}

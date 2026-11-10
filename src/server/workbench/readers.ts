// Layer 4 (ADR 0024): which open pages are reading a conversation, and what is unread elsewhere.
// Reading leases belong to authenticated browser pages, never to native execution.
import { attentionLimit } from '../../shared/workbench.ts';
import { StoreError, type Conversation, type WorkbenchStore } from '../workbench-store.ts';
import type { Bindings } from './bindings.ts';
import type { Gate } from './gate.ts';
import type { Observation } from './observation.ts';
import type { Participant } from './participant.ts';
import type { Tasks } from './tasks.ts';

type Deps = { store: WorkbenchStore; tasks: Tasks; bindings: Bindings; gate: Gate; observation: Observation; ensureSweep: () => void };

export class Readers implements Participant {
  private readonly store: WorkbenchStore;
  private readonly tasks: Tasks;
  private readonly bindings: Bindings;
  private readonly gate: Gate;
  private readonly observation: Observation;
  private readonly ensureSweep: () => void;
  /** Lease expiry per reader, per conversation. */
  private readonly readers = new Map<string, Map<string, number>>();

  constructor(deps: Deps) {
    this.store = deps.store; this.tasks = deps.tasks; this.bindings = deps.bindings;
    this.gate = deps.gate; this.observation = deps.observation; this.ensureSweep = deps.ensureSweep;
  }

  // Participant.
  reading(id: string): boolean { return this.readers.has(id); }

  async read(id: string, readerId: string): Promise<void> {
    this.tasks.assertOpen(); this.gate.assertNotDeleting(id);
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(readerId)) throw new StoreError('invalid_reader', 400);
    const conversation = this.bindings.conversation(id);
    // An open, visible page sees the current result for every device, configured or not.
    this.store.markSeen(id);
    if (!this.bindings.configured(conversation)) return;
    let readers = this.readers.get(id);
    if (!readers) {
      if (this.readers.size >= 16) throw new StoreError('reader_limit', 429);
      readers = new Map(); this.readers.set(id, readers);
    }
    if (!readers.has(readerId) && readers.size >= 32) throw new StoreError('reader_limit', 429);
    const first = readers.size === 0;
    readers.set(readerId, Date.now() + 45_000);
    this.ensureSweep();
    if ((first || !this.observation.slot(id)?.stop) && conversation.binding && !this.gate.executionBlocked(conversation.cwd)) {
      await this.observation.observe(id); await this.observation.sync(id);
    }
  }
  release(id: string, readerId: string): void {
    const readers = this.readers.get(id);
    // Only a page that held a lease saw the conversation; renewals from a hidden page also arrive here.
    const held = readers?.delete(readerId) ?? false;
    if (!readers?.size) this.readers.delete(id);
    if (held) this.markSeen(id);
    this.observation.release(id);
  }
  /** Remove every lease of a conversation that is being deleted. */
  drop(id: string): void { this.readers.delete(id); }
  /** Expire leases; called by the periodic sweep. */
  sweep(): void {
    for (const [id, readers] of this.readers) {
      let expired = false;
      for (const [reader, expiry] of readers) if (expiry <= Date.now()) { readers.delete(reader); expired = true; }
      // The lease covered the conversation until now; what arrived meanwhile was never shown as unread.
      if (expired) this.markSeen(id);
      if (!readers.size) { this.readers.delete(id); this.observation.release(id); }
    }
  }
  /** Unseen results, except where an open, visible page is reading the conversation right now. */
  unread(conversations: readonly Conversation[]): Set<string> {
    const unseen = this.store.unseen(conversations.map(conversation => conversation.id));
    for (const id of unseen) if (this.active(id)) unseen.delete(id);
    return unseen;
  }
  attention(): { unread: number; conversations: { conversation: Conversation; unread: boolean }[] } {
    const reading = [...this.readers.keys()].filter(id => this.active(id));
    const result = this.store.attention(reading, attentionLimit);
    return { unread: result.unseen, conversations: result.conversations.map(({ conversation, unseen }) => ({ conversation, unread: unseen })) };
  }
  /** An open, visible page somewhere is reading this conversation right now. */
  active(id: string): boolean {
    const now = Date.now();
    return [...(this.readers.get(id)?.values() ?? [])].some(expiry => expiry > now);
  }
  /** The seen marker is a hint renewed by every lease heartbeat; a failed write must not break lease bookkeeping. */
  private markSeen(id: string): void {
    try { this.store.markSeen(id); } catch { /* the next heartbeat, release or expiry writes it again */ }
  }
}

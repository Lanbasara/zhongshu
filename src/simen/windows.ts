/**
 * 司门's window rules (ADR 0023), kept pure so they can be tested without a browser: an instance has a fixed number of
 * windows; a conversation holds at most one; the rest wait first come, first served; a window unused for the idle time
 * is taken back. Times are milliseconds since the epoch, passed in by the caller.
 */
export type WindowRules = { windows: number; idleMs: number; waitMs: number; /** A waiter that stops asking is dropped after this. */ staleWaiterMs: number };
export const DEFAULT_RULES: WindowRules = { windows: 2, idleMs: 5 * 60_000, waitMs: 5 * 60_000, staleWaiterMs: 30_000 };

export type Holder = { session: string; since: number; lastUsed: number; pageId?: number };
export type Ask = { granted: true; holder: Holder } | { granted: false; ahead: number; waitingSince: number };

export class Windows {
  readonly #rules: WindowRules;
  readonly #holders = new Map<string, Holder>();
  /** Waiting conversations in arrival order, with when they first asked and when they last asked. */
  readonly #queue: { session: string; first: number; last: number }[] = [];

  constructor(rules: Partial<WindowRules> = {}) { this.#rules = { ...DEFAULT_RULES, ...rules }; }

  get rules(): WindowRules { return this.#rules; }
  holders(): Holder[] { return [...this.#holders.values()].map(holder => ({ ...holder })); }
  waiting(): number { return this.#queue.length; }
  holder(session: string): Holder | undefined { const holder = this.#holders.get(session); return holder && { ...holder }; }
  /** The conversation whose window shows this page, if any. */
  ownerOf(pageId: number): string | undefined {
    for (const holder of this.#holders.values()) if (holder.pageId === pageId) return holder.session;
    return undefined;
  }

  /**
   * A conversation asks for a window. It keeps the one it has; otherwise it gets a free one when nobody who asked
   * earlier is still waiting. A conversation that keeps asking keeps its place; one that stops asking is dropped.
   */
  ask(session: string, now: number): Ask {
    const held = this.#holders.get(session);
    if (held) { held.lastUsed = now; return { granted: true, holder: { ...held } }; }
    this.#dropStaleWaiters(now);
    let place = this.#queue.findIndex(entry => entry.session === session);
    if (place < 0) { this.#queue.push({ session, first: now, last: now }); place = this.#queue.length - 1; }
    const entry = this.#queue[place]!;
    entry.last = now;
    if (place === 0 && this.#holders.size < this.#rules.windows) {
      this.#queue.shift();
      const holder: Holder = { session, since: now, lastUsed: now };
      this.#holders.set(session, holder);
      return { granted: true, holder: { ...holder } };
    }
    return { granted: false, ahead: place, waitingSince: entry.first };
  }

  /** Stops waiting, for example when the command gave up after the wait limit. */
  leaveQueue(session: string): void {
    const place = this.#queue.findIndex(entry => entry.session === session);
    if (place >= 0) this.#queue.splice(place, 1);
  }

  /** Whether a waiter has waited longer than the rules allow since it first asked. */
  waitedTooLong(ask: Ask, now: number): boolean { return !ask.granted && now - ask.waitingSince >= this.#rules.waitMs; }

  setPage(session: string, pageId: number | undefined): void {
    const holder = this.#holders.get(session);
    if (holder) holder.pageId = pageId;
  }

  touch(session: string, now: number): void {
    const holder = this.#holders.get(session);
    if (holder) holder.lastUsed = now;
  }

  release(session: string): Holder | undefined {
    const holder = this.#holders.get(session);
    this.#holders.delete(session);
    return holder;
  }

  /** Windows unused for the idle time; the caller closes their pages and then releases them. */
  idle(now: number): Holder[] {
    return [...this.#holders.values()].filter(holder => now - holder.lastUsed >= this.#rules.idleMs).map(holder => ({ ...holder }));
  }

  #dropStaleWaiters(now: number): void {
    for (let index = this.#queue.length - 1; index >= 0; index--) if (now - this.#queue[index]!.last >= this.#rules.staleWaiterMs) this.#queue.splice(index, 1);
  }
}

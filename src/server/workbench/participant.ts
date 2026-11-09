// Layer 3 (ADR 0024): the contract between the observation kernel and the desks. The kernel rings these bells and
// collects these votes; it never imports a desk. Every member is optional and called in registration order.
import type { NativeChange, NativeItem, NativeState } from '../../harness/types.ts';
import type { Conversation } from '../workbench-store.ts';

export interface Participant {
  // Bells: facts the kernel announces.
  /** A runtime was opened for this conversation. */
  created?(id: string): void;
  /** A native hint the kernel does not interpret itself (sub-agents, requests). */
  hint?(id: string, change: NativeChange): void;
  /** Native items in memory changed (the latest page or the live stream). */
  noticed?(id: string): void;
  /** One sync pass saved the native state it read; `items` is the latest page now in memory. */
  verified?(id: string, state: NativeState, items: readonly NativeItem[], conversation: Conversation): void;
  /** A sync finished with nothing left dirty. */
  settled?(id: string): void;
  /** Observation can no longer vouch for what it showed. */
  lost?(id: string): void;
  /** Recovery re-established observation. */
  restored?(id: string): void;
  /** The runtime is being closed (also called when none is open). */
  disposed?(id: string): void;

  // Votes: whether the conversation's runtime must stay.
  /** The conversation still owes execution facts, so it must stay observed. */
  responsible?(id: string, conversation: Conversation): boolean;
  /** An open page is reading this conversation. */
  reading?(id: string): boolean;
  /** Another reason to keep the runtime; unlike reading, it does not by itself prevent eviction. */
  retains?(id: string): boolean;
}

/** The two calls the kernel makes upward; the front desk wires them. */
export type Ports = { recover(id: string): Promise<void>; prepare(conversation: Conversation): Promise<void> };

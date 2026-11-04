/** Product-facing semantics. Native protocol types stay inside each adapter. */
import type { BodyReferences, ImageAttachment, InputContent, SkillOption } from '../shared/content.ts';
import type { ConversationUsage, QueueDelivery } from '../shared/workbench.ts';
export type HarnessId = 'codex' | 'dsh';
export type Configuration = { modelId: string; permissionId: string };
export type Catalog = {
  id: HarnessId;
  available: boolean;
  reason?: string;
  models: { id: string; label: string }[];
  permissions: { id: string; label: string; description: string }[];
};
export type Binding = {
  id: string;
  cwd: string;
  configuration: Configuration;
  /** Adapter-owned, JSON-serializable configuration; never credentials. */
  details: Record<string, unknown>;
};
/** Transient importer-owned immutable bodies; never persist or expose these tokens. */
export type NativeBodySource = { token: string; version: string; bytes: number };
export type NativeBodyChunk = { version: string; bytes: number; offset: number; data: Uint8Array; nextOffset: number | null };
export type NativeItem = {
  /** An incomplete live projection; never publish its prefix as an immutable complete body. */
  previewOnly?: true;
  /** Native media still needs materialization; the immutable text body remains authoritative. */
  mediaPending?: true;
  sourceRevision?: { generation: string; sequence: number };
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  /** Server-published immutable bodies for fields shown as bounded previews. */
  bodies?: BodyReferences;
  bodySources?: Partial<Record<'text' | 'input' | 'output', NativeBodySource>>;
  status: 'running' | 'completed' | 'failed';
  runId?: string;
  operationId?: string;
  images?: ImageAttachment[];
  references?: InputContent['references'];
  tool?: { name: string; exitCode?: number; input?: string; output?: string };
  /** Confirmed edit targets, relative to this binding's workspace. */
  fileEdits?: string[];
  fileEditsLimited?: true;
  /** Transient native image sources: materialized before persistence or HTTP. */
  imageSources?: { data?: string; path?: string; mediaType?: string; releaseToken?: string }[];
};
export type NativeState = {
  status: 'idle' | 'running' | 'waiting' | 'interrupted' | 'failed' | 'unknown';
  runId?: string;
  /** Exact requested run whose terminal result was verified in native history during this read. Not tool-process termination. */
  terminalRunId?: string;
  terminalStatus?: 'completed' | 'interrupted' | 'failed';
  /** Queued work that blocks a new user prompt; excludes verified passive native context. */
  pendingInputs: number;
  configurationVerified: boolean;
  reason?: string;
};
export type HistoryPage = {
  /** Chronological within each page. Default is the latest page. */
  items: NativeItem[];
  olderCursor: string | null;
  usage?: ConversationUsage;
};
/** A bounded change feed independent of the item's chronological position.
 * The opaque checkpoint pins a native generation and a stable append cutoff.
 * A completed page can be polled again to capture the next cutoff.
 */
export type HistoryChanges = { itemIds: string[]; cursor: string; hasMore: boolean };
export type Receipt =
  | { outcome: 'accepted'; runId?: string }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown'; reason: string };
export type HarnessInput = InputContent & { id: string; imageData?: { mediaType: string; data: string }[] };
export type NativeChange =
  | { type: 'item'; item: NativeItem }
  | { type: 'state'; state: NativeState }
  | { type: 'usage'; usage: ConversationUsage }
  /** A confirmed loss of observation; retain last-known facts but revoke verification immediately. */
  | { type: 'unavailable'; reason: string }
  | { type: 'invalidate' };

export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly earlyInput?: 'current' | 'soon';
  /** History/body reads cannot activate or resume native execution. */
  readonly historyReadOnly?: true;
  catalog(): Promise<Catalog>;
  skills?(binding: Binding): Promise<SkillOption[]>;
  /** Persist the identity immediately, before later model/permission setup can fail. */
  create(input: { cwd: string; configuration: Configuration; title?: string }, onBound: (binding: Binding) => void | Promise<void>): Promise<Binding>;
  /** A target may precede the current/latest run (for example a later native notification turn). Never infer its terminal result from that ordering. */
  state(binding: Binding, targetRunId?: string): Promise<NativeState>;
  history(binding: Binding, olderCursor?: string, limit?: number): Promise<HistoryPage>;
  historyChanges?(binding: Binding, cursor?: string, limit?: number): Promise<HistoryChanges>;
  /** operationId is retained in the native message for reconciliation. Never auto-resend. */
  submit(binding: Binding, operation: HarnessInput): Promise<Receipt>;
  submitQueued?(binding: Binding, operation: HarnessInput, delivery: QueueDelivery): Promise<Receipt>;
  /** Wake a previously admitted item parked by a native interruption. This never submits input. */
  wakeQueued?(binding: Binding, operationId: string): Promise<void>;
  readImage?(binding: Binding, path: string): Promise<string>;
  readBodyChunk?(binding: Binding, token: string, offset: number, maxBytes: number): Promise<NativeBodyChunk>;
  readItems?(binding: Binding, itemIds: string[]): Promise<NativeItem[]>;
  releaseBodySource?(binding: Binding, token: string): Promise<void>;
  reconcile(binding: Binding, operationId: string): Promise<Receipt>;
  stop(binding: Binding, runId: string): Promise<Receipt>;
  /** Changes are hints/live items; history and state are re-read on reconnect. */
  watch(binding: Binding, listener: (change: NativeChange) => void): Promise<() => void>;
  /** Close app-owned connections only; native hosts and their work have independent lifetimes. */
  close(): Promise<void>;
}

export class HarnessError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'HarnessError'; this.code = code; }
}

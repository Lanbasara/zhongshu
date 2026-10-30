/** Product-facing semantics. Native protocol types stay inside each adapter. */
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
export type NativeItem = {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  status: 'running' | 'completed' | 'failed';
  runId?: string;
  operationId?: string;
};
export type NativeState = {
  status: 'idle' | 'running' | 'waiting' | 'interrupted' | 'failed' | 'unknown';
  runId?: string;
  /** Exact requested run whose terminal result was verified in native history during this read. Not tool-process termination. */
  terminalRunId?: string;
  pendingInputs: number;
  configurationVerified: boolean;
  reason?: string;
};
export type HistoryPage = {
  /** Chronological within each page. Default is the latest page. */
  items: NativeItem[];
  olderCursor: string | null;
};
export type Receipt =
  | { outcome: 'accepted'; runId?: string }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown'; reason: string };
export type NativeChange =
  | { type: 'item'; item: NativeItem }
  | { type: 'state'; state: NativeState }
  | { type: 'invalidate' };

export interface HarnessAdapter {
  readonly id: HarnessId;
  catalog(): Promise<Catalog>;
  /** Persist the identity immediately, before later model/permission setup can fail. */
  create(input: { cwd: string; configuration: Configuration; title?: string }, onBound: (binding: Binding) => void): Promise<Binding>;
  /** A target may precede the current/latest run (for example a later native notification turn). Never infer its terminal result from that ordering. */
  state(binding: Binding, targetRunId?: string): Promise<NativeState>;
  history(binding: Binding, olderCursor?: string, limit?: number): Promise<HistoryPage>;
  /** operationId is retained in the native message for reconciliation. Never auto-resend. */
  submit(binding: Binding, operation: { id: string; text: string }): Promise<Receipt>;
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

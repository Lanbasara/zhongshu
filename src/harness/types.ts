/** Product-facing semantics. Native protocol types stay inside each adapter. */
import type { ImageAttachment, InputContent, SkillOption } from '../shared/content.ts';
import type { Collaboration, ConversationUsage, PendingRequest, QueueDelivery, RequestAnswer, SubagentStatus, TeamView } from '../shared/workbench.ts';
export type HarnessId = 'codex' | 'dsh';
export type Configuration = { modelId: string; permissionId: string; reasoningEffort?: string };
export type Catalog = {
  id: HarnessId;
  available: boolean;
  reason?: string;
  models: { id: string; label: string; reasoningEfforts?: { id: string; label: string }[]; defaultReasoningEffort?: string }[];
  defaultModelId?: string;
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
  status: 'running' | 'completed' | 'failed' | 'unknown';
  runId?: string;
  operationId?: string;
  images?: ImageAttachment[];
  references?: InputContent['references'];
  tool?: { name: string; exitCode?: number; input?: string; output?: string };
  /** Confirmed edit targets, relative to this binding's workspace. */
  fileEdits?: string[];
  /** Transient native image sources: materialized before persistence or HTTP. */
  imageSources?: { data?: string; path?: string; mediaType?: string }[];
  /** A native collaboration record naming sub-agents of this conversation. */
  collaboration?: Collaboration;
};
/** One native sub-agent in the conversation's spawn tree, as verified by this read. */
export type NativeSubagent = {
  id: string;
  /** Native identity of the agent that spawned it; the conversation's own binding id for direct children. */
  parentId: string;
  name: string;
  task?: string;
  role?: string;
  model?: string;
  status: SubagentStatus;
  /** Runs outside the Harness transcript (for example DSH external backends); only a final result exists. */
  external?: boolean;
  startedAt?: number;
  endedAt?: number;
};
export type SubagentSnapshot = {
  agents: NativeSubagent[];
  team?: TeamView;
  /** Children finished after the main agent's latest turn ended and no later main turn has started. */
  resultsPending?: boolean;
};
export type SubagentHistory = {
  /** The spawning agent's first instruction. It is delegated input, never the user's message. */
  brief?: string;
  items: NativeItem[];
  olderCursor: string | null;
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
export type Receipt =
  | { outcome: 'accepted'; runId?: string }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown'; reason: string };
/**
 * A question, approval or form a native agent is waiting on, as the adapter currently sees it. The native
 * Harness owns it; its content stays in memory and is never persisted. `agentId` names the asking
 * sub-agent; it is absent when the conversation's main agent asked.
 */
export type NativeRequest = Omit<PendingRequest, 'status' | 'answer' | 'agent'> & { agentId?: string };
export type HarnessInput = InputContent & { id: string; imageData?: { mediaType: string; data: string }[] };
export type NativeChange =
  | { type: 'item'; item: NativeItem }
  | { type: 'state'; state: NativeState }
  | { type: 'usage'; usage: ConversationUsage }
  /** A hint that the native sub-agent tree changed. `agentId` names the sub-agent concerned; `transcript`
   * means only its transcript grew, so its status need not be re-read. */
  | { type: 'subagents'; agentId?: string; transcript?: boolean }
  /** A confirmed loss of observation; retain last-known facts but revoke verification immediately. */
  | { type: 'unavailable'; reason: string }
  /** The set of open native requests changed; re-read them. */
  | { type: 'requests' }
  | { type: 'invalidate' };

export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly earlyInput?: 'current' | 'soon';
  catalog(): Promise<Catalog>;
  /** Project legacy configuration into the current catalog shape without mutating its stored identity. */
  normalizeConfiguration?(configuration: Configuration): Configuration;
  skills?(binding: Binding): Promise<SkillOption[]>;
  /** Read native workspace capabilities without creating a conversation. */
  draftSkills?(cwd: string): Promise<SkillOption[]>;
  /** Prepare or recover a caller-named empty native session without submitting work. */
  prepareDraft?(input: { id: string; cwd: string }): Promise<SkillOption[]>;
  /** Persist the identity immediately, before later model/permission setup can fail. */
  create(input: { cwd: string; configuration: Configuration; title?: string; preparedId?: string }, onBound: (binding: Binding) => void): Promise<Binding>;
  /** A target may precede the current/latest run (for example a later native notification turn). Never infer its terminal result from that ordering. */
  state(binding: Binding, targetRunId?: string): Promise<NativeState>;
  history(binding: Binding, olderCursor?: string, limit?: number): Promise<HistoryPage>;
  /** operationId is retained in the native message for reconciliation. Never auto-resend. */
  submit(binding: Binding, operation: HarnessInput): Promise<Receipt>;
  submitQueued?(binding: Binding, operation: HarnessInput, delivery: QueueDelivery): Promise<Receipt>;
  /** Wake a previously admitted item parked by a native interruption. This never submits input. */
  wakeQueued?(binding: Binding, operationId: string): Promise<void>;
  readImage?(binding: Binding, path: string): Promise<string>;
  reconcile(binding: Binding, operationId: string): Promise<Receipt>;
  stop(binding: Binding, runId: string): Promise<Receipt>;
  /** Caller fences new work and releases observation first. Resolves only after native
   * deletion is confirmed (including a verified already-absent identity). Rejections,
   * partial cleanup and unknown transport outcomes must remain retryable operations. */
  delete?(binding: Binding): Promise<void>;
  /** Read the verified sub-agent tree of this conversation. Never spawns or activates agents. */
  subagents?(binding: Binding): Promise<SubagentSnapshot>;
  /** Read one sub-agent's transcript after verifying it belongs to this binding's spawn tree. */
  subagentHistory?(binding: Binding, agentId: string, olderCursor?: string, limit?: number): Promise<SubagentHistory>;
  /** Keep live activity of one owned sub-agent flowing as `subagents` hints on this binding's watch. */
  observeSubagent?(binding: Binding, agentId: string): Promise<() => void>;
  /** Interrupt only the named owned sub-agent's current work. Never resend after an unknown receipt. */
  stopSubagent?(binding: Binding, agentId: string): Promise<Receipt>;
  /** Open requests of this conversation, including its sub-agents'. Reading never answers or cancels them. */
  requests?(binding: Binding): Promise<NativeRequest[]>;
  /**
   * Deliver one answer. `accepted` means the native side resolved the request with it; `rejected` that the
   * request is not open (or the answer is invalid) and nothing was delivered. Never resend after `unknown`.
   */
  answer?(binding: Binding, requestId: string, answer: RequestAnswer): Promise<Receipt>;
  /** Changes are hints/live items; history and state are re-read on reconnect. */
  watch(binding: Binding, listener: (change: NativeChange) => void): Promise<() => void>;
  /** Close app-owned connections only; native hosts and their work have independent lifetimes. */
  close(): Promise<void>;
}

export class HarnessError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'HarnessError'; this.code = code; }
}

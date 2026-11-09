/** Product-facing semantics. Native protocol types stay inside each adapter. */
import type { ImageAttachment, InputContent, SkillOption } from '../shared/content.ts';
import type { Collaboration, ConversationUsage, PendingRequest, QueueDelivery, RequestAnswer, SubagentStatus, TeamView } from '../shared/workbench.ts';
export type HarnessId = 'codex' | 'dsh';
/** `agentPreset` is the DSH Agent preset chosen at creation (ADR 0017); absent for Codex and for older conversations. */
export type Configuration = { modelId: string; permissionId: string; reasoningEffort?: string; agentPreset?: string };
export type Catalog = {
  id: HarnessId;
  available: boolean;
  reason?: string;
  models: { id: string; label: string; reasoningEfforts?: { id: string; label: string }[]; defaultReasoningEffort?: string }[];
  defaultModelId?: string;
  permissions: { id: string; label: string; description: string }[];
  /** DSH Agent presets offered for new conversations (ADR 0017); unavailable ones stay listed and unselectable. */
  presets?: { id: string; label: string; description: string; available: boolean }[];
  defaultPresetId?: string;
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
  /** A plan proposed in Plan mode. */
  plan?: true;
  /** A message an automation delivered (ADR 0021); `messageId` matches the delivery receipt when the Harness reports one. */
  automation?: { messageId?: string };
};
/** When a native automation fires (ADR 0021). Instants are UTC RFC 3339; clock rules carry an IANA zone. */
export type AutomationTiming =
  | { kind: 'once'; at: string }
  | { kind: 'every'; seconds: number }
  | { kind: 'daily'; time: string; timeZone: string }
  | { kind: 'weekly'; time: string; timeZone: string; weekdays: number[] }
  | { kind: 'cron'; expression: string; timeZone: string }
  | { kind: 'rrule'; rrule: string };
/** Where each delivery goes: one existing session, one session created at the first delivery, or a new session every time. */
export type AutomationTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new_once'; sessionId?: string; cwd?: string; preset?: string }
  | { kind: 'new'; cwd?: string; preset?: string };
export type AutomationDelivery = { scheduledAt: string; deliveredAt: string; messageId: string; sessionId: string; prompt?: string };
/** One native automation as the Harness stores it; Zhongshu keeps no copy (ADR 0021). */
export type NativeAutomation = {
  id: string; title: string; prompt: string; timing: AutomationTiming;
  /** Next occurrence while active; the final one once ended. */
  scheduledAt: string;
  status: 'active' | 'paused' | 'ended';
  target: AutomationTarget;
  /** Sessions the Harness tells about later changes: creators, editors and session targets. */
  involved: string[];
  createdAt?: string;
  /** Revision for optimistic edits; an edit with an older value is refused as a conflict. */
  updatedAt?: string;
  /** A delivery is queued or running in its reused session. */
  executing: boolean;
  lastDelivery?: AutomationDelivery;
};
export type AutomationTimingInput =
  | { kind: 'at'; at: string }
  | { kind: 'every'; seconds: number }
  | { kind: 'daily'; time: string; timeZone: string }
  | { kind: 'weekly'; time: string; timeZone: string; weekdays: number[] }
  | { kind: 'cron'; expression: string; timeZone: string }
  /** RFC 5545: one DTSTART line and one RRULE line; how 司辰 hands over starts, ends and month rules (ADR 0022). */
  | { kind: 'rrule'; rrule: string };
export type AutomationTargetInput = { kind: 'session'; sessionId: string } | { kind: 'new_once' | 'new'; cwd?: string; preset?: string };
export type AutomationPatch = { title?: string; prompt?: string; timing?: AutomationTimingInput; target?: AutomationTargetInput; active?: boolean };
export type AutomationEdit = NativeAutomation | 'conflict' | 'notFound' | 'ended';
/** Native automations of one Harness. Every call reads or writes the Harness; nothing is cached here. */
export interface HarnessAutomations {
  list(): Promise<NativeAutomation[]>;
  view(id: string): Promise<NativeAutomation | undefined>;
  history(id: string, limit: number, before?: string): Promise<{ records: AutomationDelivery[]; before?: string; earlierUnavailable: boolean } | undefined>;
  create(input: { title: string; prompt: string; timing: AutomationTimingInput; target?: AutomationTargetInput }): Promise<NativeAutomation>;
  update(id: string, patch: AutomationPatch, expectedUpdatedAt?: string): Promise<AutomationEdit>;
  remove(id: string, expectedUpdatedAt?: string): Promise<'deleted' | 'conflict' | 'notFound'>;
  /** Deliver now without moving the planned occurrence. */
  run(id: string): Promise<NativeAutomation | 'pending' | 'notFound'>;
  /** A hint that the set of automations or a delivery changed; re-list to learn what. */
  onChange(listener: () => void): () => void;
  /** Read a session the Harness created for an automation, so Zhongshu can adopt it. */
  inspect(sessionId: string): Promise<{ cwd: string; configuration: Configuration } | undefined>;
}
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
  /** Native Plan mode, when the Harness keeps it as session state. */
  plan?: { active: boolean; pending: boolean };
  /** Set by Workbench, never by an adapter: the verified result of a later run Zhongshu did not start (ADR 0021). */
  latest?: { runId: string; status: 'completed' | 'interrupted' | 'failed' };
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
export type HarnessInput = InputContent & { id: string; imageData?: { mediaType: string; data: string }[]; /** Run this turn in Plan mode (per-turn Harnesses). */ plan?: boolean };
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

/**
 * A Harness account as Zhongshu last verified it (ADR 0015). Never carries credentials.
 * `valid` means the vendor accepted the credential just now; local presence alone is never `valid`.
 */
export type NativeAccount = {
  state: 'valid' | 'signed-out' | 'rejected' | 'unverified';
  /** Display-safe identity, already masked. */
  identity?: string;
  plan?: string;
  usage?: { usedPercent: number; resetsAt?: number; windowMinutes?: number };
  /** Vendor pages for usage and top-up (DSH), HTTPS only. */
  links?: { usage?: string; topUp?: string };
};
/**
 * A native login, returned once to the page that asked and never stored (ADR 0015).
 * - `device-code` (Codex): the user enters a code on the vendor's page; native notifies completion.
 * - `paste-back` (DSH): the vendor redirects to a loopback callback the user's browser cannot reach; the user pastes that
 *   address back and Zhongshu delivers only its code and state to the Host's own callback.
 */
export type LoginStart =
  | { kind: 'device-code'; loginId: string; verificationUrl: string; userCode: string }
  | { kind: 'paste-back'; loginId: string; authorizeUrl: string; callbackPrefix: string; expiresAt?: number };
export type LoginCompletion = 'succeeded' | 'failed' | 'expired' | 'invalid';
export type AccountEvent = { type: 'changed' } | { type: 'login'; loginId: string; success: boolean; reason?: string };

export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly earlyInput?: 'current' | 'soon';
  /**
   * How Plan mode works natively (ADR 0016): `per-turn` takes the mode with every new turn (Codex); `native` keeps
   * it as session state changed by `setPlan` and reported in `NativeState.plan` (DSH).
   */
  readonly planMode?: 'per-turn' | 'native';
  /** Turn native Plan mode on or off (`native` Harnesses). Repeating the same request is harmless. */
  setPlan?(binding: Binding, active: boolean): Promise<Receipt>;
  catalog(): Promise<Catalog>;
  /** Verify the account with the vendor. Rejects when the Host cannot be reached. */
  account?(): Promise<NativeAccount>;
  /** Start a native login; a new start supersedes or reuses an older one. */
  startLogin?(): Promise<LoginStart>;
  /** Finish a `paste-back` login with the address the vendor redirected to. */
  completeLogin?(loginId: string, callbackUrl: string): Promise<LoginCompletion>;
  cancelLogin?(loginId: string): Promise<'canceled' | 'notFound'>;
  /** Native account notifications: login completion and account changes. */
  onAccountEvent?(listener: (event: AccountEvent) => void): () => void;
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
  /** Native automations (ADR 0021); absent when the Harness has none Zhongshu can use. */
  readonly automations?: HarnessAutomations;
  /** Changes are hints/live items; history and state are re-read on reconnect. */
  watch(binding: Binding, listener: (change: NativeChange) => void): Promise<() => void>;
  /** Close app-owned connections only; native hosts and their work have independent lifetimes. */
  close(): Promise<void>;
}

export class HarnessError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'HarnessError'; this.code = code; }
}

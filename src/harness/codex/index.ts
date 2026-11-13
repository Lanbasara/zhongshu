import { basename, isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { HarnessError } from '../types.ts';
import type { AccountEvent, Binding, Catalog, Configuration, HarnessAdapter, LoginStart, HarnessInput, NativeAccount, HistoryPage, NativeChange, NativeItem, NativeRequest, NativeState, NativeSubagent, Receipt, SubagentHistory, SubagentSnapshot } from '../types.ts';
import { CodexRpc, RpcError, type ServerRequest } from './rpc.ts';
import { answerableMethods, parseServerRequest, type Parsed } from './requests.ts';
import { inputFields } from '../../shared/content.ts';
import { revisionSchema, skillRequiresNextTurn, subagentIdSchema, subagentLimit } from '../../shared/workbench.ts';
import type { QueueDelivery, RequestAnswer } from '../../shared/workbench.ts';
import { configuredThread, cursor, itemsPage, mapItem, nativeId, nativeItem, record, threadStatus, turn } from './protocol.ts';
import { nativeSkill, resolveSkillInput, skillOptions, type NativeSkill } from '../skills.ts';

const configuration = z.object({ modelId: nativeId, permissionId: nativeId, reasoningEffort: z.string().min(1).max(240).optional() });
const workspace = z.string().min(1).max(4096).refine(path => isAbsolute(path) && normalize(path) === path && !path.includes('\0'));
const titleSchema = z.string().min(1).max(200).refine(value => Buffer.byteLength(value) <= 200);
const bindingSchema = z.object({ id: nativeId, cwd: workspace, configuration, details: z.object({ version: z.literal(1), approvalPolicy: z.enum(['never', 'on-request']), title: titleSchema.optional() }) });
/** ADR 0016: full access never asks; every other permission asks when the agent needs more. Fixed at creation. */
const approvalPolicyFor = (permissionId: string) => permissionId === ':danger-full-access' ? 'never' as const : 'on-request' as const;
const operationSchema = z.object({ id: nativeId, text: z.string().max(256_000), skills: inputFields.skills, imageData: z.array(z.object({ mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']), data: z.string().max(3 * 1024 * 1024) })).max(4).optional() }).refine(v => v.text.trim() || v.imageData?.length);
const nativeSkillRow = z.object({
  name: z.string().min(1).max(120).regex(/^[\p{L}\p{N}_.:-]+$/u), description: z.string().max(16_000), enabled: z.literal(true),
  path: workspace.refine(path => basename(path) === 'SKILL.md'), interface: z.object({ displayName: z.string().nullish() }).nullish(),
});
const skillsResponse = z.object({ data: z.array(z.object({ cwd: workspace, skills: z.array(z.unknown()).max(2000) })).max(32) });
const tokenUsage = z.object({ total: z.object({ totalTokens: revisionSchema }), last: z.object({ totalTokens: revisionSchema }),
  modelContextWindow: revisionSchema.min(1).nullish() });
const queuedMessage = z.object({ id: nativeId, clientUserMessageId: nativeId });
const seconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER / 1000);
const spawnSource = z.object({ subAgent: z.object({ thread_spawn: z.object({ parent_thread_id: nativeId, agent_path: z.string().max(4096).nullish(),
  agent_nickname: z.string().max(400).nullish(), agent_role: z.string().max(400).nullish() }).passthrough() }).passthrough() }).passthrough();
/** A spawned descendant as returned by thread/list and thread/read; unrelated fields are ignored. */
const childThread = z.object({
  id: nativeId, parentThreadId: nativeId.nullish(), agentNickname: z.string().max(400).nullish(), agentRole: z.string().max(400).nullish(),
  preview: z.string().max(1024 * 1024).nullish(), createdAt: seconds.nullish(), updatedAt: seconds.nullish(), status: threadStatus.nullish(),
  model: z.string().max(400).nullish(), reasoningEffort: z.string().max(240).nullish(), source: z.unknown().optional(),
});
const threadPage = z.object({ data: z.array(childThread).max(100), nextCursor: cursor.nullable() });
const timedTurn = turn.extend({ startedAt: seconds.nullish(), completedAt: seconds.nullish() });
const firstLine = (value: string, bytes: number) => { const line = value.trim().split('\n')[0] ?? ''; return Buffer.byteLength(line) <= bytes ? line : line.slice(0, Math.floor(bytes / 3)) + '…'; };
const queuePage = z.object({ data: z.array(queuedMessage).max(100) });
const userInput = (operation: z.infer<typeof operationSchema>) => [
  ...(operation.text ? [{ type: 'text', text: operation.text, text_elements: [] }] : []),
  ...(operation.imageData ?? []).map(image => ({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` })),
];
const unknownState = (reason: string): NativeState => ({ status: 'unknown', pendingInputs: 0, configurationVerified: false, reason });
function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new HarnessError('codex_invalid_data');
  return result.data;
}
function reason(error: unknown): string {
  if (error instanceof RpcError && error.nativeCode === -32601) return 'codex_native_result_unknown';
  return error instanceof HarnessError ? error.code : 'codex_unavailable';
}
function matches(binding: Binding, native: z.infer<typeof configuredThread>, workspaceToolsProfile?: string): boolean {
  return native.thread.id === binding.id && native.cwd === binding.cwd && native.model === binding.configuration.modelId
    && (native.activePermissionProfile?.id === binding.configuration.permissionId
      || (binding.configuration.permissionId === ':workspace' && !!workspaceToolsProfile && native.activePermissionProfile?.id === workspaceToolsProfile))
    && native.approvalPolicy === binding.details.approvalPolicy
    && (binding.configuration.reasoningEffort === undefined || native.reasoningEffort === binding.configuration.reasoningEffort);
}

type Watch = { binding: Binding; listeners: Set<(change: NativeChange) => void>; verified: boolean };
type Live = { threadId: string; item: NativeItem; overflow: boolean };
/** One open App Server request. Its id is valid only on the connection that received it; a resume replays it. */
type Pending = { key: string; threadId: string; turnId?: string; root?: string; rpc: Pick<ServerRequest, 'id' | 'connection'>; parsed: Parsed; answering: boolean; waiters: Set<(resolved: boolean) => void> };
const permissionLabels: Record<string, string> = { ':read-only': '只读', ':workspace': '工作区读写', ':danger-full-access': '完全访问' };

/**
 * Server callers own authentication, binding ownership, and the workspace allowlist.
 * This boundary validates native IPC, fixes conversation configuration, never logs content,
 * never reads credentials, and never starts/stops the independently managed App Server.
 */
const accountRead = z.object({
  account: z.object({ type: z.string().max(100), email: z.string().max(320).nullable().optional(), planType: z.string().max(100).nullable().optional() }).nullable(),
  requiresOpenaiAuth: z.boolean().default(true),
});
const rateLimitsRead = z.object({ rateLimits: z.object({ primary: z.object({ usedPercent: z.number().finite(), windowDurationMins: z.number().int().positive().nullable().optional(),
  resetsAt: z.number().int().positive().nullable().optional() }).nullable().optional() }) });
const loginIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9-]+$/);
const deviceLogin = z.object({ type: z.literal('chatgptDeviceCode'), loginId: loginIdSchema,
  verificationUrl: z.url().max(2048).refine(value => value.startsWith('https://')), userCode: z.string().min(4).max(64).regex(/^[A-Za-z0-9-]+$/) });
/** "h***@example.com": enough to recognise the account in the admin page. */
function maskEmail(email: string | null | undefined): string | undefined {
  const match = email ? /^([^@\s]+)@([^@\s]+)$/.exec(email) : null;
  return match ? `${match[1]!.slice(0, 1)}***@${match[2]}` : undefined;
}
const planNames: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
const planLabel = (plan: string | null | undefined) => plan && plan !== 'unknown' ? planNames[plan] ?? plan : undefined;

class CodexAdapter implements HarnessAdapter {
  readonly id = 'codex' as const;
  readonly earlyInput = 'current' as const;
  readonly planMode = 'per-turn' as const;
  private rpc: CodexRpc;
  private watches = new Map<string, Watch>();
  private live = new Map<string, Live>();
  private liveBytes = 0;
  private loading = new Map<string, { binding: Binding; promise: Promise<boolean> }>();
  private readers = new Map<string, number>();
  private releasing = new Map<string, Promise<void>>();
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private closed = false;
  /** Child thread -> conversation root it belongs to; filled from verified reads and native collaboration records. */
  private childRoots = new Map<string, string>();
  /** Threads already checked and not part of any observed conversation. */
  private foreignThreads = new Set<string>();
  private discovering = new Set<string>();
  /** Children resumed after a reconnect. They are never unsubscribed: releasing a v1 child could shut it down natively. */
  private attachedChildren = new Set<string>();
  /** Roots whose running children were attached on the current connection, so replayed child requests arrive. */
  private attachedRoots = new Set<string>();
  private requestsByKey = new Map<string, Pending>();
  /** Recent file-change targets by item, to show which files an approval concerns. */
  private fileEdits = new Map<string, string[]>();
  private accountListeners = new Set<(event: AccountEvent) => void>();
  /** Whether this process last saw a stored ChatGPT account, and whether it was lost (could no longer be renewed). */
  private hadAccount: boolean | undefined;
  private accountLost = false;
  private readonly workspaceToolsProfile: string | undefined;

  constructor(socketPath: string, workspaceToolsProfile?: string) {
    this.workspaceToolsProfile = workspaceToolsProfile;
    this.rpc = new CodexRpc(socketPath, {
      notification: (method, params) => this.notification(method, params),
      serverRequest: request => this.serverRequest(request),
      disconnected: () => {
        this.live.clear(); this.liveBytes = 0; this.attachedChildren.clear(); this.attachedRoots.clear();
        // Unanswered requests stay open natively and are replayed when the thread is resumed again.
        const roots = this.clearRequests();
        for (const [id, watch] of this.watches) { watch.verified = false; this.emit(id, { type: 'unavailable', reason: 'codex_disconnected' }); if (roots.has(id)) this.emit(id, { type: 'requests' }); }
        this.scheduleReconnect();
      },
    });
  }

  private clearRequests(): Set<string> {
    const roots = new Set<string>();
    for (const entry of this.requestsByKey.values()) { if (entry.root) roots.add(entry.root); for (const resolve of entry.waiters) resolve(false); }
    this.requestsByKey.clear();
    return roots;
  }
  private rootOf(threadId: string): string | undefined {
    if (this.watches.has(threadId)) return threadId;
    const root = this.childRoots.get(threadId);
    return root && this.watches.has(root) ? root : undefined;
  }
  private serverRequest(request: ServerRequest): boolean {
    if (!answerableMethods.has(request.method) || this.closed) return false;
    const parsed = parseServerRequest(request.method, request.id, request.params, itemId => this.fileEdits.get(itemId));
    if (!parsed) return false;
    if ('unsupported' in parsed) {
      // An MCP request this client cannot present faithfully is declined, and the conversation is told why.
      void this.rpc.respond(request, { action: 'decline', content: null, _meta: null }).catch(() => {});
      const root = this.rootOf(parsed.threadId);
      if (root) this.emit(root, { type: 'item', item: { id: `request-declined-${String(request.id)}-${request.connection}`, kind: 'notice', text: parsed.notice, status: 'failed' } });
      return true;
    }
    if (!this.requestsByKey.has(parsed.request.id) && this.requestsByKey.size >= 256) return false;
    const params = record.safeParse(request.params);
    const turnId = params.success && typeof params.data.turnId === 'string' ? params.data.turnId : undefined;
    const previous = this.requestsByKey.get(parsed.request.id);
    const entry: Pending = { key: parsed.request.id, threadId: parsed.threadId, ...(turnId ? { turnId } : {}), root: this.rootOf(parsed.threadId),
      rpc: { id: request.id, connection: request.connection }, parsed, answering: previous?.answering ?? false, waiters: previous?.waiters ?? new Set() };
    this.requestsByKey.set(entry.key, entry);
    if (entry.root) this.emit(entry.root, { type: 'requests' });
    else void this.routeRequest(entry);
    return true;
  }
  /** A request from a thread not yet known to belong to an observed conversation: walk native parent links. */
  private async routeRequest(entry: Pending): Promise<void> {
    try {
      let current = entry.threadId;
      for (let hop = 0; hop < 8; hop++) {
        const thread = parse(z.object({ thread: childThread }), await this.rpc.request('thread/read', { threadId: current, includeTurns: false })).thread;
        const parent = thread.parentThreadId ?? spawnSource.safeParse(thread.source).data?.subAgent.thread_spawn.parent_thread_id;
        if (!parent) return;
        const root = this.watches.has(parent) ? parent : this.childRoots.get(parent);
        if (root) {
          this.rememberChild(entry.threadId, root);
          if (this.requestsByKey.get(entry.key) === entry && this.watches.has(root)) { entry.root = root; this.emit(root, { type: 'requests' }); }
          return;
        }
        current = parent;
      }
    } catch { /* The next resume replays the request and routing is attempted again. */ }
  }
  private resolveRequest(threadId: string, rpcId: unknown): void {
    for (const [key, entry] of this.requestsByKey) {
      if (entry.threadId !== threadId || entry.rpc.id !== rpcId) continue;
      this.requestsByKey.delete(key);
      for (const resolve of entry.waiters) resolve(true);
      if (entry.root) { this.emit(entry.root, { type: 'requests' }); this.emit(entry.root, { type: 'invalidate' }); }
    }
  }
  /** Requests of an ended turn can no longer be answered; the App Server resolves them itself. */
  private dropTurnRequests(threadId: string, turnId: string | undefined): void {
    const roots = new Set<string>();
    for (const [key, entry] of this.requestsByKey) {
      if (entry.threadId !== threadId || (turnId && entry.turnId && entry.turnId !== turnId) || entry.answering) continue;
      this.requestsByKey.delete(key); if (entry.root) roots.add(entry.root);
      for (const resolve of entry.waiters) resolve(false);
    }
    for (const root of roots) this.emit(root, { type: 'requests' });
  }
  /** After a reconnect, resume running children so their unanswered requests are replayed to this connection. */
  private async attachActiveChildren(rootId: string): Promise<void> {
    if (this.attachedRoots.has(rootId) || !this.rpc.connected) return;
    this.attachedRoots.add(rootId);
    try {
      const page = parse(threadPage, await this.rpc.request('thread/list', { ancestorThreadId: rootId, archived: false, limit: 100, sortKey: 'created_at', sortDirection: 'desc' }));
      for (const thread of page.data) {
        if (thread.id === rootId || thread.status?.type !== 'active' || this.attachedChildren.has(thread.id) || !subagentIdSchema.safeParse(thread.id).success) continue;
        this.rememberChild(thread.id, rootId);
        await this.rpc.request('thread/resume', { threadId: thread.id, excludeTurns: true });
        this.attachedChildren.add(thread.id);
      }
    } catch { this.attachedRoots.delete(rootId); }
  }

  async requests(input: Binding): Promise<NativeRequest[]> {
    const binding = parse(bindingSchema, input);
    return [...this.requestsByKey.values()].filter(entry => entry.root === binding.id)
      .map(entry => ({ ...entry.parsed.request, ...(entry.threadId !== binding.id ? { agentId: entry.threadId } : {}) }))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async answer(input: Binding, key: string, answer: RequestAnswer): Promise<Receipt> {
    const binding = parse(bindingSchema, input);
    const entry = this.requestsByKey.get(key);
    if (!entry || entry.root !== binding.id || entry.rpc.connection !== this.rpc.connection) return { outcome: 'rejected', reason: 'request_not_open' };
    if (entry.answering) return { outcome: 'rejected', reason: 'request_answer_pending' };
    const result = entry.parsed.result(answer);
    if (result === undefined) return { outcome: 'rejected', reason: 'answer_invalid' };
    entry.answering = true;
    let timer: NodeJS.Timeout | undefined;
    const resolved = new Promise<boolean>(resolve => { entry.waiters.add(resolve); timer = setTimeout(() => resolve(false), 15_000); timer.unref(); });
    try { await this.rpc.respond(entry.rpc, result); }
    catch { clearTimeout(timer); entry.answering = false; return { outcome: 'unknown', reason: 'codex_answer_unconfirmed' }; }
    const confirmed = await resolved; clearTimeout(timer);
    if (!confirmed) entry.answering = false;
    // Resolution is the App Server's own confirmation; without it the answer may or may not have landed.
    return confirmed ? { outcome: 'accepted' } : { outcome: 'unknown', reason: 'codex_answer_unconfirmed' };
  }

  private nativePermission(id: string): string {
    return id === ':workspace' && this.workspaceToolsProfile ? this.workspaceToolsProfile : id;
  }

  private workspaceToolConfig(id: string): { features: { network_proxy: true } } | undefined {
    if (id === ':workspace' && this.workspaceToolsProfile) return { features: { network_proxy: true } };
    return undefined;
  }

  /**
   * A resumed thread reports no effort until its first turn. Every turn names the conversation's
   * effort explicitly (turn/start), so only that gap is accepted; every other field must still match.
   */
  private async effortUnsetBeforeFirstTurn(binding: Binding, loaded: z.infer<typeof configuredThread>): Promise<boolean> {
    if (loaded.reasoningEffort != null || binding.configuration.reasoningEffort === undefined) return false;
    if (!matches(binding, { ...loaded, reasoningEffort: binding.configuration.reasoningEffort }, this.workspaceToolsProfile)) return false;
    const turns = parse(z.object({ data: z.array(turn).max(100), nextCursor: cursor.nullable() }), await this.rpc.request('thread/turns/list', { threadId: binding.id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }));
    return turns.data.length === 0;
  }

  private async load(binding: Binding): Promise<boolean> {
    const existing = this.loading.get(binding.id);
    if (existing) {
      if (existing.binding.cwd !== binding.cwd || JSON.stringify(existing.binding.configuration) !== JSON.stringify(binding.configuration)) throw new HarnessError('codex_binding_conflict');
      return existing.promise;
    }
    if (this.loading.size >= 64) throw new HarnessError('codex_load_limit');
    const promise = (async () => {
      await this.releasing.get(binding.id);
      const config = this.workspaceToolConfig(binding.configuration.permissionId);
      const params = { threadId: binding.id, excludeTurns: true, ...(config ? { config } : {}) };
      let response: unknown;
      try { response = await this.rpc.request('thread/resume', params); }
      catch (error) {
        const title = titleSchema.safeParse(binding.details.title);
        if (!(error instanceof RpcError) || error.nativeKind !== 'missing_rollout' || !title.success) throw error;
        // Complete an interrupted naming step using the saved user title and existing identity only.
        await this.rpc.request('thread/name/set', { threadId: binding.id, name: title.data });
        response = await this.rpc.request('thread/resume', params);
      }
      const loaded = parse(configuredThread, response);
      const verified = matches(binding, loaded, this.workspaceToolsProfile) || await this.effortUnsetBeforeFirstTurn(binding, loaded);
      const watch = this.watches.get(binding.id);
      if (watch) watch.verified = verified;
      return verified;
    })();
    this.loading.set(binding.id, { binding, promise });
    try { return await promise; } finally { if (this.loading.get(binding.id)?.promise === promise) this.loading.delete(binding.id); }
  }

  private retain(threadId: string): void {
    if ((!this.readers.has(threadId) && this.readers.size >= 64) || (this.readers.get(threadId) ?? 0) >= 64) throw new HarnessError('codex_read_limit');
    this.readers.set(threadId, (this.readers.get(threadId) ?? 0) + 1);
  }

  private async release(threadId: string): Promise<void> {
    const count = this.readers.get(threadId) ?? 0;
    if (count > 1) this.readers.set(threadId, count - 1);
    else this.readers.delete(threadId);
    await this.releaseUnused(threadId);
  }

  private async releaseUnused(threadId: string): Promise<void> {
    if (!this.watches.has(threadId) && !this.readers.has(threadId) && !this.loading.has(threadId) && !this.closed && this.rpc.connected) {
      const existing = this.releasing.get(threadId); if (existing) return existing;
      const pending = this.rpc.request('thread/unsubscribe', { threadId }).then(() => {}, () => { /* Observation cleanup never cancels or repeats native work. */ });
      this.releasing.set(threadId, pending);
      try { await pending; } finally { if (this.releasing.get(threadId) === pending) this.releasing.delete(threadId); }
    }
  }

  /**
   * ADR 0015: the stored account is only a claim; the rate-limit read asks the vendor. A 401/403 that survives one
   * native refresh means the credential is rejected or cannot be renewed; any other failure means it cannot be checked now.
   */
  async account(): Promise<NativeAccount> {
    let read: z.infer<typeof accountRead>;
    try { read = await this.readAccount(); }
    catch (error) { if (error instanceof RpcError && error.nativeKind === 'unauthorized') return { state: 'rejected' }; throw error; }
    if (!read.requiresOpenaiAuth) return { state: 'valid', identity: '无需 OpenAI 登录的模型服务' };
    if (!read.account) {
      if (this.accountLost) return { state: 'rejected' };
      // A stored credential Codex could not renew reads as no account; the auth status still names its method.
      const stored = await this.rpc.request('getAuthStatus', { includeToken: false, refreshToken: false }).then(
        value => z.object({ authMethod: z.string().max(100).nullable().optional() }).safeParse(value).data?.authMethod, () => undefined);
      return { state: stored ? 'rejected' : 'signed-out' };
    }
    if (read.account.type !== 'chatgpt') return { state: 'unverified', identity: read.account.type === 'apiKey' ? 'API Key' : read.account.type };
    const identity = maskEmail(read.account.email); const plan = planLabel(read.account.planType);
    const known = { ...(identity ? { identity } : {}), ...(plan ? { plan } : {}) };
    const readLimits = async () => parse(rateLimitsRead, await this.rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true }));
    try {
      let limits;
      try { limits = await readLimits(); }
      catch (error) {
        // An expired access token can still be renewable: ask Codex to refresh once, then ask the vendor again.
        if (!(error instanceof RpcError && error.nativeKind === 'unauthorized')) throw error;
        await this.rpc.request('account/read', { refreshToken: true });
        limits = await readLimits();
      }
      const primary = limits.rateLimits.primary;
      return { state: 'valid', ...known, ...(primary ? { usage: { usedPercent: Math.min(100, Math.max(0, primary.usedPercent)),
        ...(primary.resetsAt ? { resetsAt: primary.resetsAt * 1000 } : {}), ...(primary.windowDurationMins ? { windowMinutes: primary.windowDurationMins } : {}) } } : {}) };
    } catch (error) {
      if (error instanceof RpcError && error.nativeKind === 'unauthorized') return { state: 'rejected', ...known };
      if (error instanceof RpcError && error.nativeCode === -32600) return { state: 'signed-out' };
      if (error instanceof RpcError && ['codex_disconnected', 'codex_unavailable', 'codex_adapter_closed'].includes(error.code)) throw error;
      return { state: 'unverified', ...known };
    }
  }
  /**
   * Every account read goes through here. Codex reports an unrenewable credential once as an error and afterwards
   * as no account at all, so whichever caller sees the error records it for the others.
   */
  private async readAccount(): Promise<z.infer<typeof accountRead>> {
    try {
      const read = parse(accountRead, await this.rpc.request('account/read', { refreshToken: false }));
      if (read.account) this.accountLost = false; else if (this.hadAccount) this.accountLost = true;
      this.hadAccount = !!read.account;
      return read;
    } catch (error) {
      if (error instanceof RpcError && error.nativeKind === 'unauthorized') { this.accountLost = true; this.hadAccount = false; }
      throw error;
    }
  }
  async startLogin(): Promise<LoginStart> {
    const started = parse(deviceLogin, await this.rpc.request('account/login/start', { type: 'chatgptDeviceCode' }));
    return { kind: 'device-code', loginId: started.loginId, verificationUrl: started.verificationUrl, userCode: started.userCode };
  }
  async cancelLogin(loginId: string): Promise<'canceled' | 'notFound'> {
    return parse(z.object({ status: z.enum(['canceled', 'notFound']) }), await this.rpc.request('account/login/cancel', { loginId: parse(loginIdSchema, loginId) })).status;
  }
  onAccountEvent(listener: (event: AccountEvent) => void): () => void {
    this.accountListeners.add(listener);
    return () => { this.accountListeners.delete(listener); };
  }
  private accountEvent(method: string, raw: unknown): void {
    let event: AccountEvent | undefined;
    if (method === 'account/updated') event = { type: 'changed' };
    else {
      const completed = z.object({ loginId: loginIdSchema, success: z.boolean(), error: z.string().nullable().optional() }).safeParse(raw);
      if (completed.success) event = { type: 'login', loginId: completed.data.loginId, success: completed.data.success,
        ...(completed.data.error ? { reason: completed.data.error.slice(0, 200) } : {}) };
    }
    if (event) for (const listener of this.accountListeners) { try { listener(event); } catch { /* listeners never break routing */ } }
  }

  async catalog(): Promise<Catalog> {
    try {
      const account = await this.readAccount();
      if (!account.account) return { id: this.id, available: false, reason: 'codex_login_required', models: [], permissions: [] };
      const models: Catalog['models'] = []; const permissions: Catalog['permissions'] = [];
      let next: string | undefined; let defaultModelId: string | undefined;
      for (let page = 0; page < 10; page++) {
        const response = parse(z.object({ data: z.array(z.object({ model: nativeId, displayName: z.string().max(500), hidden: z.boolean(), isDefault: z.boolean().optional(), defaultReasoningEffort: z.string().min(1).max(240).optional(), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().min(1).max(240), description: z.string().max(500) })).max(32).optional() })).max(200), nextCursor: cursor.nullable() }), await this.rpc.request('model/list', { limit: 100, ...(next ? { cursor: next } : {}) }));
        for (const model of response.data.filter(model => !model.hidden)) {
          const efforts = model.supportedReasoningEfforts?.map(value => ({ id: value.reasoningEffort, label: value.reasoningEffort }));
          models.push({ id: model.model, label: model.displayName, ...(efforts?.length ? { reasoningEfforts: efforts } : {}), ...(efforts?.some(value => value.id === model.defaultReasoningEffort) ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}) });
          if (model.isDefault) defaultModelId = model.model;
        }
        next = response.nextCursor ?? undefined;
        if (!next) break;
      }
      if (next) throw new HarnessError('codex_catalog_limit');
      for (let page = 0; page < 10; page++) {
        const response = parse(z.object({ data: z.array(z.object({ id: nativeId, description: z.string().max(10_000).nullable(), allowed: z.boolean() })).max(200), nextCursor: cursor.nullable() }), await this.rpc.request('permissionProfile/list', { limit: 100, ...(next ? { cursor: next } : {}) }));
        const allowed = response.data.filter(profile => profile.allowed && (!this.workspaceToolsProfile || profile.id !== ':workspace'));
        permissions.push(...allowed.map(profile => {
          const id = profile.id === this.workspaceToolsProfile ? ':workspace' : profile.id;
          return { id, label: permissionLabels[id] ?? id, description: `${profile.description ?? '实际权限由所选原生配置决定。'}\n${profile.id === ':danger-full-access' ? '不会请求审批。' : '需要越界时会请求你批准。'}` };
        }));
        next = response.nextCursor ?? undefined;
        if (!next) break;
      }
      if (next) throw new HarnessError('codex_catalog_limit');
      return { id: this.id, available: models.length > 0 && permissions.length > 0, models, permissions, ...(defaultModelId ? { defaultModelId } : {}) };
    } catch (error) { return { id: this.id, available: false, reason: reason(error), models: [], permissions: [] }; }
  }

  async create(input: { cwd: string; configuration: Configuration; title?: string }, onBound: (binding: Binding) => void): Promise<Binding> {
    const selected = parse(z.object({ cwd: workspace, configuration, title: titleSchema.optional() }), input);
    if (selected.configuration.reasoningEffort !== undefined) {
      const model = (await this.catalog()).models.find(value => value.id === selected.configuration.modelId);
      if (!model?.reasoningEfforts?.some(value => value.id === selected.configuration.reasoningEffort)) throw new HarnessError('codex_reasoning_effort_unavailable');
    }
    const approvalPolicy = approvalPolicyFor(selected.configuration.permissionId);
    const config = { ...this.workspaceToolConfig(selected.configuration.permissionId),
      ...(selected.configuration.reasoningEffort ? { model_reasoning_effort: selected.configuration.reasoningEffort } : {}) };
    const response = await this.rpc.request('thread/start', { ...(Object.keys(config).length ? { config } : {}),
      cwd: selected.cwd, model: selected.configuration.modelId, permissions: this.nativePermission(selected.configuration.permissionId),
      approvalPolicy, historyMode: 'paginated', ephemeral: false });
    // Persist only identity and requested configuration before examining the remaining native response.
    const identity = parse(z.object({ thread: z.object({ id: nativeId }) }), response);
    const binding: Binding = { id: identity.thread.id, cwd: selected.cwd, configuration: selected.configuration, details: { version: 1, approvalPolicy, ...(selected.title ? { title: selected.title } : {}) } };
    let retained = false;
    try {
      try { onBound(binding); } catch { throw new HarnessError('codex_binding_persistence_failed'); }
      this.retain(binding.id); retained = true;
      const started = parse(configuredThread, response);
      if (!matches(binding, started, this.workspaceToolsProfile)) throw new HarnessError('codex_configuration_mismatch');
      // Naming the user's new conversation also materializes its native rollout before the first turn.
      if (selected.title) await this.rpc.request('thread/name/set', { threadId: binding.id, name: selected.title });
      if (selected.configuration.permissionId === ':workspace' && this.workspaceToolsProfile) {
        // Resuming with the managed networking override can reload an empty thread with host defaults.
        // Persist the verified selection before releasing this new thread; later reads still detect drift.
        if (started.activePermissionProfile?.id !== this.workspaceToolsProfile) throw new HarnessError('codex_configuration_mismatch');
        const effort = selected.configuration.reasoningEffort;
        parse(z.object({}).strict(), await this.rpc.request('thread/settings/update', {
          threadId: binding.id, model: selected.configuration.modelId, permissions: this.workspaceToolsProfile,
          approvalPolicy, ...(effort !== undefined ? { effort } : {}),
        }));
      }
      return binding;
    } finally { if (retained) await this.release(binding.id); else await this.releaseUnused(binding.id); }
  }

  private async terminalRun(binding: Binding, targetRunId: string): Promise<NativeState['terminalStatus']> {
    const target = parse(nativeId, targetRunId); let next: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const turns = parse(z.object({ data: z.array(turn).max(100), nextCursor: cursor.nullable() }), await this.rpc.request('thread/turns/list', {
        threadId: binding.id, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded', ...(next ? { cursor: next } : {}),
      }));
      const found = turns.data.find(value => value.id === target);
      if (found) return found.status === 'inProgress' ? undefined : found.status;
      if (!turns.nextCursor) return undefined;
      if (cursors.has(turns.nextCursor)) throw new HarnessError('codex_history_no_progress');
      cursors.add(turns.nextCursor); next = turns.nextCursor;
    }
    return undefined;
  }

  async state(input: Binding, targetRunId?: string): Promise<NativeState> {
    const binding = parse(bindingSchema, input);
    this.retain(binding.id);
    try {
      const verified = await this.load(binding);
      const terminalStatus = targetRunId ? await this.terminalRun(binding, targetRunId) : undefined;
      // Read the current run, queue and status after the target lookup. A later
      // native notification turn must not reuse an idle snapshot from before it.
      const turns = parse(z.object({ data: z.array(turn).max(100), nextCursor: cursor.nullable() }), await this.rpc.request('thread/turns/list', { threadId: binding.id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }));
      const latest = turns.data[0];
      let pendingInputs = 0; let next: string | undefined;
      for (let page = 0; page < 10; page++) {
        const queue = parse(z.object({ data: z.array(z.unknown()).max(100), nextCursor: cursor.nullable() }), await this.rpc.request('thread/queue/list', { threadId: binding.id, limit: 100, ...(next ? { cursor: next } : {}) }));
        pendingInputs += queue.data.length; next = queue.nextCursor ?? undefined;
        if (!next) break;
      }
      if (next) return { status: 'unknown', pendingInputs, configurationVerified: verified, reason: 'codex_queue_limit' };
      const native = parse(z.object({ thread: z.object({ id: nativeId, status: threadStatus }) }), await this.rpc.request('thread/read', { threadId: binding.id, includeTurns: false }));
      if (native.thread.id !== binding.id) throw new HarnessError('codex_native_identity_mismatch');
      const status = native.thread.status;
      const common = { pendingInputs, configurationVerified: verified, ...(latest ? { runId: latest.id } : {}), ...(terminalStatus ? { terminalRunId: targetRunId, terminalStatus } : {}) };
      if (!verified) return { ...common, status: 'unknown', reason: 'codex_configuration_mismatch' };
      if (status.type === 'active') return { ...common, status: status.activeFlags?.length ? 'waiting' : 'running' };
      if (status.type === 'systemError') return { ...common, status: 'failed', reason: 'codex_native_failure' };
      if (status.type !== 'idle' || latest?.status === 'inProgress') return { ...common, status: 'unknown', reason: 'codex_state_unconfirmed' };
      if (latest?.status === 'interrupted') return { ...common, status: 'interrupted', runId: latest.id };
      if (latest?.status === 'failed') return { ...common, status: 'failed', runId: latest.id };
      return { ...common, status: 'idle' };
    } catch (error) { return unknownState(reason(error)); }
    finally { await this.release(binding.id); }
  }

  async history(input: Binding, olderCursor?: string, limit = 50): Promise<HistoryPage> {
    const binding = parse(bindingSchema, input);
    const size = parse(z.number().int().min(1).max(100), limit);
    const after = olderCursor === undefined ? undefined : parse(cursor, olderCursor);
    // Paginated threads keep an indexed history that is readable without resuming (App Server docs:
    // thread/items/list). Reading history therefore never loads or subscribes the thread.
    const entries: z.infer<typeof itemsPage>['data'] = [];
    let next = after; let bytes = 0; let perCall = 2;
    const seen = new Set<string>();
    do {
      let page: z.infer<typeof itemsPage>;
      try {
        page = parse(itemsPage, await this.rpc.request('thread/items/list', { threadId: binding.id, limit: Math.min(size - entries.length, perCall), sortDirection: 'desc', ...(next ? { cursor: next } : {}) }));
      } catch (error) {
        if (error instanceof RpcError && error.nativeCode === -32601) throw new HarnessError('codex_history_unsupported');
        if (error instanceof RpcError && error.nativeCode === -32602 && next) throw new HarnessError('codex_history_cursor_invalid');
        throw error;
      }
      entries.push(...page.data);
      const pageBytes = page.data.reduce((n, entry) => n + Buffer.byteLength(JSON.stringify(entry.item)), 0);
      bytes += pageBytes;
      // Items carry inline image bytes. Grow the request while items stay small; shrink it for large ones.
      const average = page.data.length ? pageBytes / page.data.length : 0;
      perCall = average > 256 * 1024 ? 1 : average > 32 * 1024 ? 2 : Math.min(25, perCall * 2);
      next = page.nextCursor ?? undefined;
      if (next && seen.has(next)) throw new HarnessError('codex_history_no_progress');
      if (next) seen.add(next);
    } while (next && entries.length < size && bytes < 8 * 1024 * 1024);
    return { items: entries.reverse().map(entry => mapItem(entry.item, entry.turnId, binding.cwd, entry.completedAtMs === null && entry.item.type !== 'userMessage', typeof entry.completedAtMs === 'number')), olderCursor: next ?? null };
  }

  async readImage(_binding: Binding, path: string): Promise<string> {
    const response = z.object({ dataBase64: z.string().max(8 * 1024 * 1024) }).parse(await this.rpc.request('fs/readFile', { path }));
    return response.dataBase64;
  }
  private async skillCatalog(binding: Pick<Binding, 'id' | 'cwd'>): Promise<NativeSkill[]> {
    const result = parse(skillsResponse, await this.rpc.request('skills/list', { cwds: [binding.cwd], forceReload: true }));
    const rows = result.data.find(entry => entry.cwd === binding.cwd)?.skills;
    if (!rows) throw new HarnessError('codex_skill_catalog_unavailable');
    const skills = new Map<string, NativeSkill>();
    for (const raw of rows) {
      const row = nativeSkillRow.safeParse(raw);
      if (!row.success) continue;
      const skill = nativeSkill(binding, { ...row.data, label: row.data.interface?.displayName?.trim() || row.data.name });
      if (skill) skills.set(skill.id, skill);
      if (skills.size === 500) break;
    }
    return [...skills.values()];
  }
  async draftSkills(cwd: string) {
    const rows = await this.skillCatalog({ id: 'draft', cwd: parse(workspace, cwd) });
    return skillOptions(rows.map(skill => ({ ...skill, id: skill.draftId! })));
  }
  async skills(binding: Binding) {
    return skillOptions(await this.skillCatalog(parse(bindingSchema, binding)));
  }
  private async input(binding: Binding, operation: z.infer<typeof operationSchema>) {
    if (!operation.skills?.length) return userInput(operation);
    const resolved = resolveSkillInput(operation, await this.skillCatalog(binding), '$');
    if (!resolved) return;
    return [...userInput({ ...operation, text: resolved.text }), ...resolved.skills.map(skill => ({ type: 'skill', name: skill.name, path: skill.path }))];
  }
  async submit(input: Binding, rawOperation: HarnessInput): Promise<Receipt> {
    const binding = parse(bindingSchema, input); const operation = parse(operationSchema, rawOperation);
    this.retain(binding.id);
    try {
      const current = await this.state(binding);
      if (!current.configurationVerified) return { outcome: 'rejected', reason: current.reason ?? 'codex_configuration_unverified' };
      if (!['idle', 'interrupted', 'failed'].includes(current.status) || current.pendingInputs > 0) return { outcome: 'rejected', reason: 'codex_conversation_busy' };
      const nativeInput = await this.input(binding, operation).catch(() => undefined);
      if (!nativeInput) return { outcome: 'rejected', reason: 'skill_reference_unavailable' };
      // Every send pins the saved selection as well as checking the live native configuration. The mode is a
      // thread setting natively, so every turn names it explicitly; it carries the conversation's model and effort.
      const collaborationMode = { mode: rawOperation.plan === true ? 'plan' : 'default', settings: { model: binding.configuration.modelId, reasoning_effort: binding.configuration.reasoningEffort ?? null, developer_instructions: null } };
      const result = parse(z.object({ turn }), await this.rpc.request('turn/start', { threadId: binding.id, clientUserMessageId: operation.id, ...(binding.configuration.reasoningEffort ? { effort: binding.configuration.reasoningEffort } : {}), model: binding.configuration.modelId, permissions: this.nativePermission(binding.configuration.permissionId), approvalPolicy: binding.details.approvalPolicy, collaborationMode, input: nativeInput }));
      return { outcome: 'accepted', runId: result.turn.id };
    } catch (error) {
      if (error instanceof RpcError && error.nativeCode === -32602) return { outcome: 'rejected', reason: 'codex_native_rejected' };
      return { outcome: 'unknown', reason: reason(error) };
    } finally { await this.release(binding.id); }
  }

  async submitQueued(rawBinding: Binding, rawOperation: HarnessInput, delivery: QueueDelivery): Promise<Receipt> {
    if (delivery.mode === 'soon') return { outcome: 'rejected', reason: 'queue_mode_unavailable' };
    const binding = parse(bindingSchema, rawBinding);
    const operation = parse(operationSchema, rawOperation);
    if (skillRequiresNextTurn(delivery.mode, operation)) return { outcome: 'rejected', reason: 'queue_skill_requires_next_turn' };
    this.retain(binding.id);
    try {
      const current = await this.state(binding);
      if (!current.configurationVerified) return { outcome: 'rejected', reason: 'codex_configuration_unverified' };
      const nativeInput = await this.input(binding, operation).catch(() => undefined);
      if (!nativeInput) return { outcome: 'rejected', reason: 'skill_reference_unavailable' };
      const params = { threadId: binding.id, clientUserMessageId: operation.id, input: nativeInput };
      if (delivery.mode === 'current') {
        const target = parse(nativeId, delivery.target);
        if (current.runId !== target || !['running', 'waiting'].includes(current.status))
          return { outcome: 'rejected', reason: 'native_run_changed' };
        const response = parse(z.object({ turnId: nativeId }), await this.rpc.request('turn/steer', { ...params, expectedTurnId: target }));
        return response.turnId === target ? { outcome: 'accepted' } : { outcome: 'unknown', reason: 'codex_queue_turn_mismatch' };
      }
      if (current.status === 'unknown')
        return { outcome: 'rejected', reason: 'codex_conversation_busy' };
      if (binding.configuration.permissionId === ':workspace' && this.workspaceToolsProfile)
        await this.rpc.request('thread/settings/update', { threadId: binding.id, permissions: this.workspaceToolsProfile });
      const response = parse(z.object({ queuedSubmission: queuedMessage }), await this.rpc.request('thread/queue/add', params));
      if (response.queuedSubmission.clientUserMessageId !== operation.id) return { outcome: 'unknown', reason: 'codex_queue_identity_mismatch' };
      if (current.status === 'interrupted' && current.pendingInputs === 0) {
        // This native queue is parked after an interrupt. Resume the exact item
        // after its admission. A start failure cannot revoke that admission.
        try { await this.rpc.request('thread/queue/start', { threadId: binding.id, queuedSubmissionId: response.queuedSubmission.id }); }
        catch { return { outcome: 'accepted' }; }
      }
      return { outcome: 'accepted' };
    } catch (error) {
      if (error instanceof RpcError && [-32600, -32602].includes(error.nativeCode ?? 0))
        return { outcome: 'rejected', reason: delivery.mode === 'current' ? 'native_run_changed' : 'codex_native_rejected' };
      return { outcome: 'unknown', reason: reason(error) };
    } finally { await this.release(binding.id); }
  }

  async wakeQueued(input: Binding, rawOperationId: string): Promise<void> {
    const binding = parse(bindingSchema, input);
    const operationId = parse(nativeId, rawOperationId);
    this.retain(binding.id);
    try {
      const state = await this.state(binding);
      if (!state.configurationVerified || state.status !== 'interrupted' || state.pendingInputs !== 1) return;
      const queue = parse(queuePage, await this.rpc.request('thread/queue/list', { threadId: binding.id, limit: 100 }));
      if (queue.data.length === 1 && queue.data[0]!.clientUserMessageId === operationId)
        await this.rpc.request('thread/queue/start', { threadId: binding.id, queuedSubmissionId: queue.data[0]!.id });
    } finally { await this.release(binding.id); }
  }

  async reconcile(input: Binding, rawOperationId: string): Promise<Receipt> {
    const binding = parse(bindingSchema, input); const operationId = parse(nativeId, rawOperationId);
    this.retain(binding.id);
    try {
      await this.load(binding);
      // The item can still be queued, or move from the queue into history while we read it.
      const queued = parse(z.object({ data: z.array(z.object({ clientUserMessageId: nativeId.optional() })).max(100) }),
        await this.rpc.request('thread/queue/list', { threadId: binding.id, limit: 100 }));
      const queuedMatch = queued.data.some(item => item.clientUserMessageId === operationId);
      let next: string | undefined; let match: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = parse(itemsPage, await this.rpc.request('thread/items/list', { threadId: binding.id, limit: 100, sortDirection: 'desc', ...(next ? { cursor: next } : {}) }));
        for (const entry of result.data) if (entry.item.type === 'userMessage' && entry.item.clientId === operationId) {
          if (match) return { outcome: 'unknown', reason: 'codex_operation_ambiguous' };
          match = entry.turnId;
        }
        next = result.nextCursor ?? undefined;
        if (!next) return match ? { outcome: 'accepted', runId: match } : queuedMatch ? { outcome: 'accepted' } : { outcome: 'unknown', reason: 'codex_receipt_not_found' };
      }
      return { outcome: 'unknown', reason: 'codex_reconciliation_limit' };
    } catch (error) { return { outcome: 'unknown', reason: reason(error) }; }
    finally { await this.release(binding.id); }
  }

  async stop(input: Binding, rawRunId: string): Promise<Receipt> {
    const binding = parse(bindingSchema, input); const runId = parse(nativeId, rawRunId);
    this.retain(binding.id);
    try {
      // Stopping is allowed even when external changes made the saved configuration drift.
      await this.load(binding);
      const current = parse(z.object({ data: z.array(turn).max(100) }), await this.rpc.request('thread/turns/list', { threadId: binding.id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }));
      if (current.data[0]?.id !== runId || current.data[0].status !== 'inProgress') return { outcome: 'rejected', reason: 'codex_run_not_active' };
      await this.rpc.request('turn/interrupt', { threadId: binding.id, turnId: runId });
      // Accepted means cancellation was requested; state/history must confirm the terminal result.
      return { outcome: 'accepted', runId };
    } catch (error) { return { outcome: 'unknown', reason: reason(error) }; }
    finally { await this.release(binding.id); }
  }

  async delete(input: Binding): Promise<void> {
    const binding = parse(bindingSchema, input);
    if (this.closed) throw new HarnessError('codex_adapter_closed');
    // Never resume a deleted identity to reconcile a lost deletion response. The
    // native deletion endpoint also checks external writers and fork references.
    if (this.watches.has(binding.id) || this.readers.has(binding.id) || this.loading.has(binding.id))
      throw new HarnessError('codex_delete_observation_active');
    await this.releasing.get(binding.id);
    if (this.watches.has(binding.id) || this.readers.has(binding.id) || this.loading.has(binding.id))
      throw new HarnessError('codex_delete_observation_active');
    try {
      parse(z.object({}).strict(), await this.rpc.request('thread/delete', { threadId: binding.id }));
    } catch (error) {
      if (error instanceof RpcError && error.nativeKind === 'deleted_thread_absent') return;
      if (error instanceof RpcError && error.nativeCode === -32601) throw new HarnessError('codex_delete_unsupported');
      throw new HarnessError(error instanceof HarnessError ? error.code : 'codex_delete_unknown');
    }
  }

  private rememberChild(childId: string, rootId: string): void {
    if (!subagentIdSchema.safeParse(childId).success) return;
    if (!this.childRoots.has(childId) && this.childRoots.size >= 4096) { const oldest = this.childRoots.keys().next().value; if (oldest) this.childRoots.delete(oldest); }
    this.childRoots.set(childId, rootId); this.foreignThreads.delete(childId);
  }
  /** Walk native parent links. Ownership is proven only by reaching the conversation's own thread. */
  private async ownedBy(binding: Binding, agentId: string): Promise<z.infer<typeof childThread>> {
    if (!subagentIdSchema.safeParse(agentId).success || agentId === binding.id) throw new HarnessError('subagent_not_owned');
    let current = agentId; let found: z.infer<typeof childThread> | undefined;
    for (let hop = 0; hop < 8; hop++) {
      const thread = parse(z.object({ thread: childThread }), await this.rpc.request('thread/read', { threadId: current, includeTurns: false })).thread;
      if (thread.id !== current) throw new HarnessError('codex_native_identity_mismatch');
      found ??= thread;
      const parent = thread.parentThreadId ?? spawnSource.safeParse(thread.source).data?.subAgent.thread_spawn.parent_thread_id;
      if (!parent) break;
      if (parent === binding.id) { this.rememberChild(agentId, binding.id); return found; }
      current = parent;
    }
    throw new HarnessError('subagent_not_owned');
  }
  private async lastTurn(threadId: string): Promise<z.infer<typeof timedTurn> | undefined> {
    const page = parse(z.object({ data: z.array(timedTurn).max(100) }), await this.rpc.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }));
    return page.data[0];
  }
  async subagents(input: Binding): Promise<SubagentSnapshot> {
    const binding = parse(bindingSchema, input);
    this.retain(binding.id);
    try {
      await this.load(binding);
      // Archive cascades over the spawn tree but unarchive does not, so read both partitions.
      const threads: z.infer<typeof childThread>[] = []; const ids = new Set<string>();
      for (const archived of [false, true]) {
        let next: string | undefined; const seen = new Set<string>();
        for (let page = 0; page < 3 && threads.length < subagentLimit; page++) {
          const result = parse(threadPage, await this.rpc.request('thread/list', { ancestorThreadId: binding.id, archived, limit: 100, sortKey: 'created_at', sortDirection: 'asc', ...(next ? { cursor: next } : {}) }));
          for (const thread of result.data) if (thread.id !== binding.id && !ids.has(thread.id) && subagentIdSchema.safeParse(thread.id).success) { ids.add(thread.id); threads.push(thread); }
          next = result.nextCursor ?? undefined;
          if (!next || seen.has(next)) break; seen.add(next);
        }
      }
      threads.sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
      const agents: NativeSubagent[] = [];
      let lookups = 0;
      for (const thread of threads.slice(0, subagentLimit)) {
        this.rememberChild(thread.id, binding.id);
        const source = spawnSource.safeParse(thread.source).data?.subAgent.thread_spawn;
        const path = source?.agent_path ?? undefined;
        const name = thread.agentNickname?.trim() || source?.agent_nickname?.trim() || path?.split('/').filter(Boolean).at(-1) || '子 Agent';
        let status: NativeSubagent['status'] = 'unknown'; let endedAt: number | undefined;
        if (thread.status?.type === 'active') status = 'running';
        else if (thread.status?.type === 'systemError') status = 'failed';
        else if (lookups++ < 64) {
          // Idle or unloaded threads keep their last turn's outcome; reading it does not load or resume the child.
          const latest = await this.lastTurn(thread.id);
          status = !latest ? 'idle' : latest.status === 'inProgress' ? 'unknown' : latest.status;
          if (latest?.completedAt) endedAt = latest.completedAt * 1000;
        }
        const task = thread.preview?.trim() ? firstLine(thread.preview, 2000) : path?.split('/').filter(Boolean).at(-1);
        agents.push({ id: thread.id, parentId: thread.parentThreadId ?? source?.parent_thread_id ?? binding.id, name: firstLine(name, 400), status,
          ...(task ? { task } : {}), ...((thread.agentRole ?? source?.agent_role) ? { role: firstLine((thread.agentRole ?? source?.agent_role)!, 400) } : {}),
          ...(thread.model ? { model: thread.reasoningEffort ? `${thread.model} · ${thread.reasoningEffort}` : thread.model } : {}),
          ...(thread.createdAt ? { startedAt: thread.createdAt * 1000 } : {}), ...(endedAt ? { endedAt } : {}) });
      }
      // Codex delivers a child's result to the parent at the parent's next turn. Report only that observable timing.
      let resultsPending = false;
      if (agents.length && !agents.some(agent => agent.status === 'running')) {
        const root = await this.lastTurn(binding.id);
        const rootEnded = root && root.status !== 'inProgress' && root.completedAt ? root.completedAt * 1000 : undefined;
        resultsPending = !!rootEnded && agents.some(agent => agent.parentId === binding.id && agent.endedAt !== undefined && agent.endedAt > rootEnded);
      }
      return { agents, resultsPending };
    } finally { await this.release(binding.id); }
  }
  async subagentHistory(input: Binding, agentId: string, olderCursor?: string, limit = 50): Promise<SubagentHistory> {
    const binding = parse(bindingSchema, input);
    const size = parse(z.number().int().min(1).max(100), limit);
    const after = olderCursor === undefined ? undefined : parse(cursor, olderCursor);
    this.retain(binding.id);
    try {
      await this.load(binding);
      await this.ownedBy(binding, agentId);
      let brief: string | undefined; let briefId: string | undefined;
      if (!after) {
        const first = parse(itemsPage, await this.rpc.request('thread/items/list', { threadId: agentId, limit: 1, sortDirection: 'asc' })).data[0];
        if (first?.item.type === 'userMessage') { brief = mapItem(first.item, first.turnId, binding.cwd).text; briefId = first.item.id; }
      }
      const entries: z.infer<typeof itemsPage>['data'] = []; let next = after; let bytes = 0; const seen = new Set<string>();
      do {
        const page = parse(itemsPage, await this.rpc.request('thread/items/list', { threadId: agentId, limit: Math.min(size - entries.length, 10), sortDirection: 'desc', ...(next ? { cursor: next } : {}) }));
        entries.push(...page.data);
        bytes += page.data.reduce((n, entry) => n + Buffer.byteLength(JSON.stringify(entry.item)), 0);
        next = page.nextCursor ?? undefined;
        if (next && seen.has(next)) throw new HarnessError('codex_history_no_progress');
        if (next) seen.add(next);
      } while (next && entries.length < size && bytes < 8 * 1024 * 1024);
      const items = entries.reverse().filter(entry => entry.item.id !== briefId).map(entry => {
        const item = mapItem(entry.item, entry.turnId, binding.cwd, entry.completedAtMs === null && entry.item.type !== 'userMessage', typeof entry.completedAtMs === 'number');
        // Inside a child every user message comes from the agent that delegated to it, never from the person.
        return item.kind === 'user' ? { id: item.id, kind: 'notice' as const, text: `来自主 Agent：${item.text}`, status: 'completed' as const, ...(item.runId ? { runId: item.runId } : {}) } : item;
      });
      return { ...(brief ? { brief } : {}), items, olderCursor: next ?? null };
    } finally { await this.release(binding.id); }
  }
  async observeSubagent(input: Binding, agentId: string): Promise<() => void> {
    const binding = parse(bindingSchema, input);
    const thread = await this.ownedBy(binding, agentId);
    // Connections initialized before the spawn are attached automatically. After a reconnect, attach a loaded child
    // again; an unloaded child is not resumed because its transcript is readable without changing native state.
    if (!this.attachedChildren.has(agentId) && thread.status && thread.status.type !== 'notLoaded' && this.watches.has(binding.id)) {
      await this.rpc.request('thread/resume', { threadId: agentId, excludeTurns: true });
      this.attachedChildren.add(agentId);
    }
    return () => {};
  }
  async stopSubagent(input: Binding, agentId: string): Promise<Receipt> {
    const binding = parse(bindingSchema, input);
    this.retain(binding.id);
    try {
      await this.load(binding);
      await this.ownedBy(binding, agentId);
      const latest = await this.lastTurn(agentId);
      if (latest?.status !== 'inProgress') return { outcome: 'rejected', reason: 'subagent_not_running' };
      await this.rpc.request('turn/interrupt', { threadId: agentId, turnId: latest.id });
      // Accepted means interruption was requested; a later read confirms the child's terminal state.
      return { outcome: 'accepted' };
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'subagent_not_owned') return { outcome: 'rejected', reason: 'subagent_not_owned' };
      return { outcome: 'unknown', reason: reason(error) };
    } finally { await this.release(binding.id); }
  }
  /** A notification for a thread that is not observed directly: route it to the conversation that owns it. */
  private childNotification(method: string, threadId: string): void {
    const root = this.childRoots.get(threadId);
    const transcript = method.startsWith('item/');
    if (root) { if (this.watches.has(root)) this.emit(root, { type: 'subagents', agentId: threadId, ...(transcript ? { transcript: true } : {}) }); return; }
    if (transcript || this.foreignThreads.has(threadId) || this.discovering.has(threadId) || !this.watches.size || this.discovering.size >= 16) return;
    this.discovering.add(threadId);
    void (async () => {
      try {
        let current = threadId;
        for (let hop = 0; hop < 8; hop++) {
          const thread = parse(z.object({ thread: childThread }), await this.rpc.request('thread/read', { threadId: current, includeTurns: false })).thread;
          const parent = thread.parentThreadId ?? spawnSource.safeParse(thread.source).data?.subAgent.thread_spawn.parent_thread_id;
          if (!parent) break;
          if (this.watches.has(parent)) { this.rememberChild(threadId, parent); this.emit(parent, { type: 'subagents', agentId: threadId }); return; }
          const known = this.childRoots.get(parent);
          if (known) { this.rememberChild(threadId, known); if (this.watches.has(known)) this.emit(known, { type: 'subagents', agentId: threadId }); return; }
          current = parent;
        }
        if (this.foreignThreads.size >= 1024) this.foreignThreads.clear();
        this.foreignThreads.add(threadId);
      } catch { /* the next collaboration record or explicit read discovers it */ }
      finally { this.discovering.delete(threadId); }
    })();
  }

  async watch(input: Binding, listener: (change: NativeChange) => void): Promise<() => void> {
    const binding = parse(bindingSchema, input);
    if (this.closed) throw new HarnessError('codex_adapter_closed');
    const total = [...this.watches.values()].reduce((sum, value) => sum + value.listeners.size, 0);
    if (total >= 128 || (!this.watches.has(binding.id) && this.watches.size >= 64)) throw new HarnessError('codex_watch_limit');
    let watch = this.watches.get(binding.id);
    if (watch && (JSON.stringify(watch.binding.configuration) !== JSON.stringify(binding.configuration) || watch.binding.cwd !== binding.cwd)) throw new HarnessError('codex_binding_conflict');
    if (!watch) { watch = { binding, listeners: new Set(), verified: false }; this.watches.set(binding.id, watch); }
    watch.listeners.add(listener);
    try { await this.load(binding); }
    catch (error) { this.removeListener(binding.id, listener); throw new HarnessError(reason(error)); }
    void this.attachActiveChildren(binding.id);
    this.emit(binding.id, { type: 'invalidate' });
    return () => { this.removeListener(binding.id, listener); };
  }

  private removeListener(threadId: string, listener: (change: NativeChange) => void): void {
    const watch = this.watches.get(threadId);
    if (!watch?.listeners.delete(listener) || watch.listeners.size) return;
    this.watches.delete(threadId);
    for (const [key, value] of this.live) if (value.threadId === threadId) this.removeLive(key);
    if (!this.watches.size && this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    void this.releaseUnused(threadId);
  }

  private emit(threadId: string, change: NativeChange): void {
    for (const listener of this.watches.get(threadId)?.listeners ?? []) {
      try { listener(change); } catch { /* One observer cannot break the native connection for other observers. */ }
    }
  }

  private removeLive(key: string): void {
    const previous = this.live.get(key);
    if (previous) this.liveBytes -= Buffer.byteLength(previous.item.text);
    this.live.delete(key);
  }

  private notification(method: string, raw: unknown): void {
    if (method === 'account/updated' || method === 'account/login/completed') { this.accountEvent(method, raw); return; }
    if (!['item/started', 'item/completed', 'item/agentMessage/delta', 'turn/started', 'turn/completed', 'thread/status/changed', 'thread/queue/changed', 'thread/tokenUsage/updated', 'serverRequest/resolved'].includes(method)) return;
    const params = parse(record, raw); const threadId = parse(nativeId, params.threadId);
    if (method === 'serverRequest/resolved') { this.resolveRequest(threadId, params.requestId); return; }
    if (method === 'turn/completed') { const ended = z.object({ id: nativeId }).safeParse(params.turn); this.dropTurnRequests(threadId, ended.success ? ended.data.id : undefined); }
    const watch = this.watches.get(threadId);
    if (!watch) { this.childNotification(method, threadId); return; }
    if (method === 'thread/tokenUsage/updated') {
      const update = tokenUsage.safeParse(params.tokenUsage);
      if (update.success) {
        const { total, last, modelContextWindow } = update.data;
        this.emit(threadId, { type: 'usage', usage: { total: total.totalTokens,
          ...(modelContextWindow ? { context: { used: last.totalTokens, capacity: modelContextWindow, estimated: true } } : {}) } });
      }
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = parse(nativeItem, params.item); const runId = parse(nativeId, params.turnId);
      const normalized = mapItem(item, runId, watch.binding.cwd, method === 'item/started', method === 'item/completed'); const key = JSON.stringify([threadId, item.id]);
      if (method === 'item/started' && normalized.fileEdits?.length) {
        if (this.fileEdits.size >= 256) { const oldest = this.fileEdits.keys().next().value; if (oldest) this.fileEdits.delete(oldest); }
        this.fileEdits.set(item.id, normalized.fileEdits);
      }
      this.removeLive(key);
      if (method === 'item/started' && item.type === 'agentMessage' && Buffer.byteLength(normalized.text) <= 256 * 1024 && this.live.size < 128 && this.liveBytes + Buffer.byteLength(normalized.text) <= 2 * 1024 * 1024) {
        this.live.set(key, { threadId, item: normalized, overflow: false }); this.liveBytes += Buffer.byteLength(normalized.text);
      }
      this.emit(threadId, { type: 'item', item: normalized });
      if (normalized.collaboration) {
        for (const agentId of normalized.collaboration.agentIds) this.rememberChild(agentId, threadId);
        this.emit(threadId, { type: 'subagents' });
      }
      return;
    }
    if (method === 'item/agentMessage/delta') {
      const itemId = parse(nativeId, params.itemId); const delta = parse(z.string().max(256 * 1024), params.delta);
      const key = JSON.stringify([threadId, itemId]); const live = this.live.get(key);
      if (!live || live.overflow) { this.emit(threadId, { type: 'invalidate' }); return; }
      const bytes = Buffer.byteLength(delta);
      if (Buffer.byteLength(live.item.text) + bytes > 256 * 1024 || this.liveBytes + bytes > 2 * 1024 * 1024) {
        live.overflow = true; this.emit(threadId, { type: 'invalidate' }); return;
      }
      live.item = { ...live.item, text: live.item.text + delta }; this.liveBytes += bytes;
      this.emit(threadId, { type: 'item', item: live.item }); return;
    }
    if (method === 'thread/status/changed') parse(threadStatus, params.status);
    this.emit(threadId, { type: 'invalidate' });
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.watches.size || this.reconnectTimer || this.reconnectAttempts >= 6) return;
    const wait = Math.min(500 * 2 ** this.reconnectAttempts++, 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void (async () => {
        try {
          await this.rpc.connect(); this.reconnectAttempts = 0;
          for (const [id, watch] of this.watches) {
            try { await this.load(watch.binding); await this.attachActiveChildren(id); }
            catch (error) { this.emit(id, { type: 'state', state: unknownState(reason(error)) }); }
            finally { await this.releaseUnused(id); }
            this.emit(id, { type: 'invalidate' });
          }
        } catch { this.scheduleReconnect(); }
      })();
    }, wait);
    this.reconnectTimer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.watches.clear(); this.live.clear(); this.liveBytes = 0; this.clearRequests();
    await this.rpc.close();
  }
}

export function createCodexAdapter(options: { socketPath: string; workspaceToolsProfile?: string }): HarnessAdapter {
  const settings = parse(z.object({ socketPath: z.string(), workspaceToolsProfile: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional() }), options);
  return new CodexAdapter(settings.socketPath, settings.workspaceToolsProfile);
}

import { basename, isAbsolute, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HarnessError } from '../types.ts';
import type { Binding, Catalog, Configuration, HarnessAdapter, HarnessInput, HistoryPage, HistoryChanges, NativeChange, NativeItem, NativeState, Receipt } from '../types.ts';
import { CodexRpc, RpcError } from './rpc.ts';
import { inputFields } from '../../shared/content.ts';
import { revisionSchema, skillRequiresNextTurn } from '../../shared/workbench.ts';
import type { QueueDelivery } from '../../shared/workbench.ts';
import { configuredThread, cursor, itemsPage, mapItem, nativeId, nativeItem, record, threadStatus, turn } from './protocol.ts';
import { nativeSkill, resolveSkillInput, skillOptions, type NativeSkill } from '../skills.ts';
import { BoundedCodexReader, boundedCodexOptions, rolloutBinding } from './bounded-reader.ts';
import type { BoundedCodexOptions, RolloutBinding } from './bounded-reader.ts';
import type { CachedQueryPosition } from '../dsh/bounded-cache.ts';

const configuration = z.object({ modelId: nativeId, permissionId: nativeId });
const workspace = z.string().min(1).max(4096).refine(path => isAbsolute(path) && normalize(path) === path && !path.includes('\0'));
const titleSchema = z.string().min(1).max(200).refine(value => Buffer.byteLength(value) <= 200);
const bindingSchema = z.object({ id: nativeId, cwd: workspace, configuration, details: z.object({ version: z.literal(1), approvalPolicy: z.literal('never'), title: titleSchema.optional() }) });
const operationSchema = z.object({ id: nativeId, text: z.string().max(100_000), skills: inputFields.skills, imageData: z.array(z.object({ mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']), data: z.string().max(3 * 1024 * 1024) })).max(4).optional() }).refine(v => v.text.trim() || v.imageData?.length);
const nativeSkillRow = z.object({
  name: z.string().min(1).max(120).regex(/^[\p{L}\p{N}_.:-]+$/u), description: z.string().max(16_000), enabled: z.literal(true),
  path: workspace.refine(path => basename(path) === 'SKILL.md'), interface: z.object({ displayName: z.string().nullish() }).nullish(),
});
const skillsResponse = z.object({ data: z.array(z.object({ cwd: workspace, skills: z.array(z.unknown()).max(2000) })).max(32) });
const tokenUsage = z.object({ total: z.object({ totalTokens: revisionSchema }), last: z.object({ totalTokens: revisionSchema }),
  modelContextWindow: revisionSchema.min(1).nullish() });
const queuedMessage = z.object({ id: nativeId, clientUserMessageId: nativeId });
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
function matches(binding: Binding, native: z.infer<typeof configuredThread>): boolean {
  return native.thread.id === binding.id && native.cwd === binding.cwd && native.model === binding.configuration.modelId
    && native.activePermissionProfile?.id === binding.configuration.permissionId && native.approvalPolicy === 'never';
}

type Watch = { binding: Binding; listeners: Set<(change: NativeChange) => void>; verified: boolean };
type Live = { threadId: string; item: NativeItem; overflow: boolean };
const permissionLabels: Record<string, string> = { ':read-only': '只读', ':workspace': '工作区读写', ':danger-full-access': '完全访问' };

/**
 * Server callers own authentication, binding ownership, and the workspace allowlist.
 * This boundary validates native IPC, fixes conversation configuration, never logs content,
 * never reads credentials, and never starts/stops the independently managed App Server.
 */
class CodexAdapter implements HarnessAdapter {
  readonly id = 'codex' as const;
  readonly earlyInput = 'current' as const;
  readonly historyReadOnly = true as const;
  private rpc: CodexRpc;
  private watches = new Map<string, Watch>();
  private live = new Map<string, Live>();
  private liveBytes = 0;
  private loading = new Map<string, { binding: Binding; promise: Promise<boolean> }>();
  private readers = new Map<string, number>();
  private historyReads = 0;
  private releasing = new Map<string, Promise<void>>();
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private closed = false;
  private bounded?: BoundedCodexReader;
  private managedExecution: boolean;
  private socketPath: string;
  private turnQueries = new Map<string, CachedQueryPosition & { expires: number | null; updated: number }>();

  constructor(socketPath: string, boundedHistory?: BoundedCodexOptions, managedExecution = false) {
    this.managedExecution = managedExecution;
    this.socketPath = socketPath;
    if (boundedHistory) this.bounded = new BoundedCodexReader(boundedHistory);
    this.rpc = new CodexRpc(socketPath, {
      notification: (method, params) => this.notification(method, params),
      unsupportedRequest: (_method, params) => {
        const value = record.safeParse(params);
        const threadId = value.success && typeof value.data.threadId === 'string' ? value.data.threadId : undefined;
        const targets = threadId ? [threadId] : [...this.watches.keys()];
        for (const id of targets) this.emit(id, { type: 'state', state: { status: 'waiting', pendingInputs: 0, configurationVerified: this.watches.get(id)?.verified ?? false, reason: 'codex_interaction_unsupported' } });
      },
      disconnected: () => {
        this.live.clear(); this.liveBytes = 0;
        for (const [id, watch] of this.watches) { watch.verified = false; this.emit(id, { type: 'unavailable', reason: 'codex_disconnected' }); }
        if (!this.managedExecution) this.scheduleReconnect();
      },
    }, boundedHistory ? ['item/started', 'item/completed', 'turn/started', 'turn/completed', 'rawResponseItem/completed', 'rawResponse/completed', 'turn/diff/updated', 'turn/plan/updated', 'item/fileChange/patchUpdated', 'item/fileChange/outputDelta', 'item/commandExecution/outputDelta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta'] : []);
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
      let response: unknown;
      try { response = await this.rpc.request('thread/resume', { threadId: binding.id, excludeTurns: true }); }
      catch (error) {
        const title = titleSchema.safeParse(binding.details.title);
        if (!(error instanceof RpcError) || error.nativeKind !== 'missing_rollout' || !title.success) throw error;
        // Complete an interrupted naming step using the saved user title and existing identity only.
        await this.rpc.request('thread/name/set', { threadId: binding.id, name: title.data });
        response = await this.rpc.request('thread/resume', { threadId: binding.id, excludeTurns: true });
      }
      const loaded = parse(configuredThread, response);
      const verified = matches(binding, loaded);
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

  async catalog(): Promise<Catalog> {
    try {
      const account = parse(z.object({ account: z.object({ type: z.string().max(100) }).nullable(), requiresOpenaiAuth: z.boolean().optional() }), await this.rpc.request('account/read', { refreshToken: false }));
      if (!account.account && account.requiresOpenaiAuth !== false) return { id: this.id, available: false, reason: 'codex_login_required', models: [], permissions: [] };
      const models: Catalog['models'] = []; const permissions: Catalog['permissions'] = [];
      let next: string | undefined;
      for (let page = 0; page < 10; page++) {
        const response = parse(z.object({ data: z.array(z.object({ model: nativeId, displayName: z.string().max(500), hidden: z.boolean() })).max(200), nextCursor: cursor.nullable() }), await this.rpc.request('model/list', { limit: 100, ...(next ? { cursor: next } : {}) }));
        models.push(...response.data.filter(model => !model.hidden).map(model => ({ id: model.model, label: model.displayName })));
        next = response.nextCursor ?? undefined;
        if (!next) break;
      }
      if (next) throw new HarnessError('codex_catalog_limit');
      for (let page = 0; page < 10; page++) {
        const response = parse(z.object({ data: z.array(z.object({ id: nativeId, description: z.string().max(10_000).nullable(), allowed: z.boolean() })).max(200), nextCursor: cursor.nullable() }), await this.rpc.request('permissionProfile/list', { limit: 100, ...(next ? { cursor: next } : {}) }));
        permissions.push(...response.data.filter(profile => profile.allowed).map(profile => ({ id: profile.id, label: permissionLabels[profile.id] ?? profile.id, description: `${profile.description ?? '实际权限由所选原生配置决定。'}\n此切片不支持额外审批请求；配置本身允许的权限仍按原生设置执行。` })));
        next = response.nextCursor ?? undefined;
        if (!next) break;
      }
      if (next) throw new HarnessError('codex_catalog_limit');
      return { id: this.id, available: models.length > 0 && permissions.length > 0, models, permissions };
    } catch (error) { return { id: this.id, available: false, reason: reason(error), models: [], permissions: [] }; }
  }

  async create(input: { cwd: string; configuration: Configuration; title?: string }, onBound: (binding: Binding) => void | Promise<void>): Promise<Binding> {
    const selected = parse(z.object({ cwd: workspace, configuration, title: titleSchema.default('新对话') }), input);
    const response = await this.rpc.request('thread/start', { cwd: selected.cwd, model: selected.configuration.modelId, permissions: selected.configuration.permissionId, approvalPolicy: 'never', historyMode: 'paginated', ephemeral: false });
    // Persist only identity and requested configuration before examining the remaining native response.
    const identity = parse(z.object({ thread: z.object({ id: nativeId }) }), response);
    const binding: Binding = { id: identity.thread.id, cwd: selected.cwd, configuration: selected.configuration, details: { version: 1, approvalPolicy: 'never', title: selected.title } };
    let retained = false;
    try {
      try { await onBound(binding); } catch { throw new HarnessError('codex_binding_persistence_failed'); }
      this.retain(binding.id); retained = true;
      if (!matches(binding, parse(configuredThread, response))) throw new HarnessError('codex_configuration_mismatch');
      // Naming the user's new conversation also materializes its native rollout before the first turn.
      await this.rpc.request('thread/name/set', { threadId: binding.id, name: selected.title });
      // A zero-turn paginated rollout initially has only session_meta. In the
      // pinned native version, cold resume otherwise falls back to default
      // model/approval/permission settings. Submit an owned settings snapshot
      // while this newly created, verified thread is still retained. This is
      // creation finalization only: load() must never overwrite later drift.
      parse(z.object({}), await this.rpc.request('thread/settings/update', {
        threadId: binding.id, cwd: binding.cwd, model: binding.configuration.modelId,
        permissions: binding.configuration.permissionId, approvalPolicy: 'never',
      }));
      // The socket-only adapter has no native filesystem access contract. Its
      // settings acknowledgement is not a crash-durability proof; load() still
      // rejects any configuration drift. Performance deployments explicitly
      // provide the bounded reader and must prove the physical record first.
      if (this.bounded) await this.confirmCreatedConfiguration(binding, this.bounded);
      return binding;
    } finally { if (retained) await this.release(binding.id); else await this.releaseUnused(binding.id); }
  }

  private async confirmCreatedConfiguration(binding: Binding, reader: BoundedCodexReader): Promise<void> {
    const rollout = await this.rollout(binding), deadline = performance.now() + 5000;
    for (let attempt = 0; attempt < 25 && performance.now() < deadline; attempt++) {
      const proof = await reader.creationConfiguration(rollout);
      if (proof) {
        if (!matches(binding, proof)) throw new HarnessError('codex_configuration_mismatch');
        return;
      }
      await delay(100);
    }
    throw new HarnessError('codex_configuration_persistence_unconfirmed');
  }

  private async terminalRun(binding: Binding, targetRunId: string): Promise<NativeState['terminalStatus']> {
    const target = parse(nativeId, targetRunId);
    const key = createHash('sha256').update(JSON.stringify([1, this.socketPath, binding.id, binding.cwd, binding.configuration.modelId, binding.configuration.permissionId, target])).digest('hex');
    const started = Date.now();
    const pageSchema = z.object({ data: z.array(turn).max(100), nextCursor: cursor.nullable() });
    const head = parse(pageSchema, await this.rpc.request('thread/turns/list', {
      threadId: binding.id, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded',
    }));
    const recent = head.data.find(value => value.id === target);
    // A recent-run proof never loads/creates a position or enumerates cache
    // files. This also catches a newly materialized target while an older search
    // has progressed far away.
    if (recent) {
      if (recent.status === 'inProgress') return undefined;
      if (Date.now() < started) return recent.status;
      if (this.bounded) {
        // Cleanup cannot retract a fresh native fact. A failed hint retains the
        // old position and is retried on the next observation; no result is cached.
        await this.bounded.retireTurnQuery(key, started).catch(() => {});
      } else if ((this.turnQueries.get(key)?.updated ?? Infinity) < started) this.turnQueries.delete(key);
      return recent.status;
    }
    let position = await this.turnQuery(key);
    if (!head.nextCursor) { await this.advanceTurnQuery(key, position.revision, null, true); return undefined; }
    if (!position.cursor) position = await this.advanceTurnQuery(key, position.revision, head.nextCursor, false);
    const cursors = new Set<string>(position.cursor ? [position.cursor] : []);
    for (let page = 1; page < 10; page++) {
      let turns: { data: z.infer<typeof turn>[]; nextCursor: string | null };
      try {
        turns = parse(pageSchema, await this.rpc.request('thread/turns/list', {
          threadId: binding.id, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded', ...(position.cursor ? { cursor: position.cursor } : {}),
        }));
      } catch (error) {
        // Native invalidated an opaque cursor. Never treat failure as absence or
        // reuse a remembered terminal status. Transport failures keep the cursor.
        if (position.cursor && error instanceof RpcError && [-32600, -32602].includes(error.nativeCode ?? 0)) {
          await this.advanceTurnQuery(key, position.revision, null, false);
          throw new HarnessError('codex_turn_cursor_reset');
        }
        throw error;
      }
      const found = turns.data.find(value => value.id === target);
      if (found) {
        // Retain the page entrance, not the result. A second proof (including
        // force sync) must read this exact target again from the native service.
        await this.advanceTurnQuery(key, position.revision, position.cursor, found.status !== 'inProgress');
        return found.status === 'inProgress' ? undefined : found.status;
      }
      if (turns.nextCursor && cursors.has(turns.nextCursor)) {
        await this.advanceTurnQuery(key, position.revision, null, false);
        throw new HarnessError('codex_history_no_progress');
      }
      position = await this.advanceTurnQuery(key, position.revision, turns.nextCursor, turns.nextCursor === null);
      if (!turns.nextCursor) return undefined;
      cursors.add(turns.nextCursor);
    }
    return undefined;
  }

  private async turnQuery(key: string): Promise<CachedQueryPosition> {
    if (this.bounded) return this.bounded.turnQuery(key);
    // Legacy/test-only adapters have no operator-provided cache directory. Keep
    // bounded process-local progress without LRU starvation; production uses
    // the worker's persistent quota-accounted positions instead.
    for (const [id, position] of this.turnQueries) if (position.expires !== null && position.expires <= Date.now()) this.turnQueries.delete(id);
    const existing = this.turnQueries.get(key); if (existing) return existing;
    if (this.turnQueries.size >= 4096) throw new HarnessError('codex_turn_query_capacity');
    const position = { revision: randomUUID(), cursor: null, expires: null, updated: Date.now() };
    this.turnQueries.set(key, position); return position;
  }
  private async advanceTurnQuery(key: string, expected: string, cursor: string | null, settled: boolean): Promise<CachedQueryPosition> {
    if (this.bounded) {
      const updated = await this.bounded.advanceTurnQuery(key, expected, cursor, settled);
      if (!updated) throw new HarnessError('codex_turn_query_conflict');
      return updated;
    }
    if (this.turnQueries.get(key)?.revision !== expected) throw new HarnessError('codex_turn_query_conflict');
    const position = { revision: randomUUID(), cursor, expires: settled ? Date.now() + 7 * 24 * 60 * 60_000 : null, updated: Date.now() };
    this.turnQueries.set(key, position); return position;
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
      // Native paginated history can briefly reconstruct a newly started turn
      // as interrupted before its live projection catches up. For the current
      // target, only coherent terminal metadata AND a fresh idle thread prove
      // completion. A genuinely older terminal target may coexist with a newer
      // active run; keep that separate proof intact.
      const coherentTerminal = terminalStatus && (latest?.id !== targetRunId || status.type === 'idle' && latest?.status === terminalStatus);
      const common = { pendingInputs, configurationVerified: verified, ...(latest ? { runId: latest.id } : {}), ...(coherentTerminal ? { terminalRunId: targetRunId, terminalStatus } : {}) };
      if (!verified) return { ...common, status: 'unknown', reason: 'codex_configuration_mismatch' };
      if (status.type === 'active') return { ...common, status: status.activeFlags?.length ? 'waiting' : 'running' };
      if (status.type === 'systemError') return { ...common, status: 'unknown', reason: 'codex_native_failure' };
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
    if (this.historyReads >= 64) throw new HarnessError('codex_read_limit');
    this.historyReads++;
    try {
      if (this.bounded) return await this.bounded.history(await this.rollout(binding), olderCursor, size);
      // Reading stored history does not activate or subscribe to a thread. In
      // particular, notLoaded metadata is neither an idle nor a configuration proof.
      const native = parse(z.object({ thread: z.object({ id: nativeId }) }), await this.rpc.request('thread/read', { threadId: binding.id, includeTurns: false }));
      if (native.thread.id !== binding.id) throw new HarnessError('codex_native_identity_mismatch');
      // Native pages include image bytes. Keep transport reads small while combining
      // ordinary text entries into the existing public history page.
      const entries: z.infer<typeof itemsPage>['data'] = [];
      let next = after; let bytes = 0;
      const seen = new Set<string>();
      do {
        const page = parse(itemsPage, await this.rpc.request('thread/items/list', { threadId: binding.id, limit: Math.min(size - entries.length, 2), sortDirection: 'desc', ...(next ? { cursor: next } : {}) }));
        entries.push(...page.data);
        bytes += page.data.reduce((n, entry) => n + Buffer.byteLength(JSON.stringify(entry.item)), 0);
        next = page.nextCursor ?? undefined;
        if (next && seen.has(next)) throw new HarnessError('codex_history_no_progress');
        if (next) seen.add(next);
      } while (next && entries.length < size && bytes < 8 * 1024 * 1024);
      return { items: entries.reverse().map(entry => mapItem(entry.item, entry.turnId, binding.cwd, entry.completedAtMs === null && entry.item.type !== 'userMessage')), olderCursor: next ?? null };
    } finally { this.historyReads--; }
  }

  private async rollout(binding: Binding): Promise<RolloutBinding> {
    const metadata = parse(z.object({ thread: z.object({ id: nativeId, path: workspace, cliVersion: z.literal('0.166.0-alpha.5.1') }) }), await this.rpc.request('thread/read', { threadId: binding.id, includeTurns: false }));
    if (metadata.thread.id !== binding.id) throw new HarnessError('history_source_changed');
    return rolloutBinding.parse({ ...metadata.thread, cwd: binding.cwd });
  }
  async readItems(input: Binding, ids: string[]): Promise<NativeItem[]> {
    const binding = parse(bindingSchema, input);
    if (!this.bounded) throw new HarnessError('codex_bounded_history_required');
    return this.bounded.readItems(await this.rollout(binding), ids);
  }
  async historyChanges(input: Binding, cursor?: string, limit = 16): Promise<HistoryChanges> {
    const binding = parse(bindingSchema, input);
    if (!this.bounded) throw new HarnessError('codex_bounded_history_required');
    return this.bounded.historyChanges(await this.rollout(binding), cursor, limit);
  }
  async readBodyChunk(binding: Binding, token: string, offset: number, maxBytes: number) {
    if (!this.bounded) throw new HarnessError('codex_bounded_history_required');
    return this.bounded.readBodyChunk(parse(bindingSchema, binding), token, offset, maxBytes);
  }
  async releaseBodySource(binding: Binding, token: string) {
    if (!this.bounded) throw new HarnessError('codex_bounded_history_required');
    return this.bounded.releaseBodySource(parse(bindingSchema, binding), token);
  }

  async readImage(binding: Binding, path: string): Promise<string> {
    if (path.startsWith('codex-image:')) {
      if (!this.bounded) throw new HarnessError('codex_bounded_history_required');
      return this.bounded.readImage(parse(bindingSchema, binding), path.slice('codex-image:'.length));
    }
    const response = z.object({ dataBase64: z.string().max(8 * 1024 * 1024) }).parse(await this.rpc.request('fs/readFile', { path }));
    return response.dataBase64;
  }
  private async skillCatalog(binding: Binding): Promise<NativeSkill[]> {
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
      // Every send pins the saved selection as well as checking the live native configuration.
      const result = parse(z.object({ turn }), await this.rpc.request('turn/start', { threadId: binding.id, clientUserMessageId: operation.id, model: binding.configuration.modelId, permissions: binding.configuration.permissionId, approvalPolicy: 'never', input: nativeInput }));
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
      if (this.bounded) {
        const found = await this.bounded.reconcile(await this.rollout(binding), operationId);
        return found.outcome === 'accepted' ? found : queuedMatch && found.reason === 'codex_receipt_not_found' ? { outcome: 'accepted' } : found;
      }
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
    if (!['item/started', 'item/completed', 'item/agentMessage/delta', 'turn/started', 'turn/completed', 'thread/status/changed', 'thread/queue/changed', 'thread/tokenUsage/updated'].includes(method)) return;
    const params = parse(record, raw); const threadId = parse(nativeId, params.threadId);
    const watch = this.watches.get(threadId);
    if (!watch) return;
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
      const normalized = mapItem(item, runId, watch.binding.cwd, method === 'item/started');
      if (method === 'item/started') normalized.previewOnly = true;
      const key = JSON.stringify([threadId, item.id]);
      this.removeLive(key);
      if (method === 'item/started' && item.type === 'agentMessage' && Buffer.byteLength(normalized.text) <= 256 * 1024 && this.live.size < 128 && this.liveBytes + Buffer.byteLength(normalized.text) <= 2 * 1024 * 1024) {
        this.live.set(key, { threadId, item: normalized, overflow: false }); this.liveBytes += Buffer.byteLength(normalized.text);
      }
      this.emit(threadId, { type: 'item', item: normalized });
      return;
    }
    if (method === 'item/agentMessage/delta') {
      const itemId = parse(nativeId, params.itemId); const delta = parse(z.string().max(256 * 1024), params.delta);
      const key = JSON.stringify([threadId, itemId]); let live = this.live.get(key);
      if (!live && this.bounded && this.live.size < 128 && this.liveBytes < 2 * 1024 * 1024) {
        live = { threadId, item: { id: itemId, runId: parse(nativeId, params.turnId), kind: 'assistant', status: 'running', text: '', previewOnly: true }, overflow: false }; this.live.set(key, live);
      }
      if (!live) { this.emit(threadId, { type: 'invalidate' }); return; }
      if (live.overflow) return;
      const bytes = Buffer.byteLength(delta);
      if (Buffer.byteLength(live.item.text) + bytes > 256 * 1024 || this.liveBytes + bytes > 2 * 1024 * 1024) {
        live.overflow = true; this.emit(threadId, { type: 'invalidate' }); return;
      }
      live.item = { ...live.item, text: live.item.text + delta }; this.liveBytes += bytes;
      this.emit(threadId, { type: 'item', item: live.item }); return;
    }
    if (method === 'thread/status/changed') {
      const status = parse(threadStatus, params.status);
      if (this.bounded && status.type !== 'active') for (const [key, value] of this.live) if (value.threadId === threadId) this.removeLive(key);
    }
    this.emit(threadId, { type: 'invalidate' });
  }

  private scheduleReconnect(): void {
    if (this.managedExecution || this.closed || !this.watches.size || this.reconnectTimer || this.reconnectAttempts >= 6) return;
    const wait = Math.min(500 * 2 ** this.reconnectAttempts++, 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void (async () => {
        try {
          await this.rpc.connect(); this.reconnectAttempts = 0;
          for (const [id, watch] of this.watches) {
            try { await this.load(watch.binding); }
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
    this.watches.clear(); this.live.clear(); this.liveBytes = 0;
    await this.rpc.close();
    await this.bounded?.close();
  }
}

export function createCodexAdapter(options: { socketPath: string; boundedHistory?: BoundedCodexOptions; managedExecution?: boolean }): HarnessAdapter {
  const parsed = parse(z.object({ socketPath: z.string(), boundedHistory: boundedCodexOptions.optional(), managedExecution: z.boolean().optional() }), options);
  return new CodexAdapter(parsed.socketPath, parsed.boundedHistory, parsed.managedExecution);
}

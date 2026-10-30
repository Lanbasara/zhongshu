import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { HarnessError } from '../types.ts';
import type { Binding, Catalog, Configuration, HarnessAdapter, HistoryPage, NativeChange, NativeItem, NativeState, Receipt } from '../types.ts';
import { CodexRpc, RpcError } from './rpc.ts';
import { configuredThread, cursor, itemsPage, mapItem, nativeId, nativeItem, record, threadStatus, turn } from './protocol.ts';

const configuration = z.object({ modelId: nativeId, permissionId: nativeId });
const workspace = z.string().min(1).max(4096).refine(path => isAbsolute(path) && normalize(path) === path && !path.includes('\0'));
const titleSchema = z.string().min(1).max(200).refine(value => Buffer.byteLength(value) <= 200);
const bindingSchema = z.object({ id: nativeId, cwd: workspace, configuration, details: z.object({ version: z.literal(1), approvalPolicy: z.literal('never'), title: titleSchema.optional() }) });
const operationSchema = z.object({ id: nativeId, text: z.string().min(1).max(100_000) });
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

  constructor(socketPath: string) {
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
        for (const [id, watch] of this.watches) { watch.verified = false; this.emit(id, { type: 'invalidate' }); }
        this.scheduleReconnect();
      },
    });
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
      const account = parse(z.object({ account: z.object({ type: z.string().max(100) }).nullable() }), await this.rpc.request('account/read', { refreshToken: false }));
      if (!account.account) return { id: this.id, available: false, reason: 'codex_login_required', models: [], permissions: [] };
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

  async create(input: { cwd: string; configuration: Configuration; title?: string }, onBound: (binding: Binding) => void): Promise<Binding> {
    const selected = parse(z.object({ cwd: workspace, configuration, title: titleSchema.optional() }), input);
    const response = await this.rpc.request('thread/start', { cwd: selected.cwd, model: selected.configuration.modelId, permissions: selected.configuration.permissionId, approvalPolicy: 'never', historyMode: 'paginated', ephemeral: false });
    // Persist only identity and requested configuration before examining the remaining native response.
    const identity = parse(z.object({ thread: z.object({ id: nativeId }) }), response);
    const binding: Binding = { id: identity.thread.id, cwd: selected.cwd, configuration: selected.configuration, details: { version: 1, approvalPolicy: 'never', ...(selected.title ? { title: selected.title } : {}) } };
    let retained = false;
    try {
      try { onBound(binding); } catch { throw new HarnessError('codex_binding_persistence_failed'); }
      this.retain(binding.id); retained = true;
      if (!matches(binding, parse(configuredThread, response))) throw new HarnessError('codex_configuration_mismatch');
      // Naming the user's new conversation also materializes its native rollout before the first turn.
      if (selected.title) await this.rpc.request('thread/name/set', { threadId: binding.id, name: selected.title });
      return binding;
    } finally { if (retained) await this.release(binding.id); else await this.releaseUnused(binding.id); }
  }

  private async terminalRun(binding: Binding, targetRunId: string): Promise<string | undefined> {
    const target = parse(nativeId, targetRunId); let next: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const turns = parse(z.object({ data: z.array(turn).max(100), nextCursor: cursor.nullable() }), await this.rpc.request('thread/turns/list', {
        threadId: binding.id, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded', ...(next ? { cursor: next } : {}),
      }));
      const found = turns.data.find(value => value.id === target);
      if (found) return found.status === 'inProgress' ? undefined : target;
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
      const terminalRunId = targetRunId ? await this.terminalRun(binding, targetRunId) : undefined;
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
      const common = { pendingInputs, configurationVerified: verified, ...(latest ? { runId: latest.id } : {}), ...(terminalRunId ? { terminalRunId } : {}) };
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
    this.retain(binding.id);
    try {
      await this.load(binding);
      const page = parse(itemsPage, await this.rpc.request('thread/items/list', { threadId: binding.id, limit: size, sortDirection: 'desc', ...(after ? { cursor: after } : {}) }));
      return { items: page.data.slice().reverse().map(entry => mapItem(entry.item, entry.turnId, entry.completedAtMs === null && entry.item.type !== 'userMessage')), olderCursor: page.nextCursor };
    } finally { await this.release(binding.id); }
  }

  async submit(input: Binding, rawOperation: { id: string; text: string }): Promise<Receipt> {
    const binding = parse(bindingSchema, input); const operation = parse(operationSchema, rawOperation);
    this.retain(binding.id);
    try {
      const current = await this.state(binding);
      if (!current.configurationVerified) return { outcome: 'rejected', reason: current.reason ?? 'codex_configuration_unverified' };
      if (!['idle', 'interrupted', 'failed'].includes(current.status) || current.pendingInputs > 0) return { outcome: 'rejected', reason: 'codex_conversation_busy' };
      // Every send pins the saved selection as well as checking the live native configuration.
      const result = parse(z.object({ turn }), await this.rpc.request('turn/start', { threadId: binding.id, clientUserMessageId: operation.id, model: binding.configuration.modelId, permissions: binding.configuration.permissionId, approvalPolicy: 'never', input: [{ type: 'text', text: operation.text, text_elements: [] }] }));
      return { outcome: 'accepted', runId: result.turn.id };
    } catch (error) {
      if (error instanceof RpcError && error.nativeCode === -32602) return { outcome: 'rejected', reason: 'codex_native_rejected' };
      return { outcome: 'unknown', reason: reason(error) };
    } finally { await this.release(binding.id); }
  }

  async reconcile(input: Binding, rawOperationId: string): Promise<Receipt> {
    const binding = parse(bindingSchema, input); const operationId = parse(nativeId, rawOperationId);
    this.retain(binding.id);
    try {
      await this.load(binding);
      let next: string | undefined; let match: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = parse(itemsPage, await this.rpc.request('thread/items/list', { threadId: binding.id, limit: 100, sortDirection: 'desc', ...(next ? { cursor: next } : {}) }));
        for (const entry of result.data) if (entry.item.type === 'userMessage' && entry.item.clientId === operationId) {
          if (match) return { outcome: 'unknown', reason: 'codex_operation_ambiguous' };
          match = entry.turnId;
        }
        next = result.nextCursor ?? undefined;
        if (!next) return match ? { outcome: 'accepted', runId: match } : { outcome: 'unknown', reason: 'codex_receipt_not_found' };
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
    if (!['item/started', 'item/completed', 'item/agentMessage/delta', 'turn/started', 'turn/completed', 'thread/status/changed'].includes(method)) return;
    const params = parse(record, raw); const threadId = parse(nativeId, params.threadId);
    const watch = this.watches.get(threadId);
    if (!watch) return;
    if (method === 'item/started' || method === 'item/completed') {
      const item = parse(nativeItem, params.item); const runId = parse(nativeId, params.turnId);
      const normalized = mapItem(item, runId, method === 'item/started'); const key = JSON.stringify([threadId, item.id]);
      this.removeLive(key);
      if (method === 'item/started' && item.type === 'agentMessage' && Buffer.byteLength(normalized.text) <= 256 * 1024 && this.live.size < 128 && this.liveBytes + Buffer.byteLength(normalized.text) <= 2 * 1024 * 1024) {
        this.live.set(key, { threadId, item: normalized, overflow: false }); this.liveBytes += Buffer.byteLength(normalized.text);
      }
      this.emit(threadId, { type: 'item', item: normalized });
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
  }
}

export function createCodexAdapter(options: { socketPath: string }): HarnessAdapter {
  return new CodexAdapter(parse(z.object({ socketPath: z.string() }), options).socketPath);
}

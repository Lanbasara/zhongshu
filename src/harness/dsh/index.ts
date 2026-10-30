import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { HarnessError } from '../types.ts';
import type { Binding, Catalog, Configuration, HarnessAdapter, HistoryPage, NativeChange, NativeState, Receipt } from '../types.ts';
import { Connection, NativeRejection } from './connection.ts';
import { LiveAssistant } from './live.ts';
import { boundaryFrom, decodeModel, eventSchema, historyItems, identifier, itemFrom, modelId, modelSchema, object, pageSchema, snapshotSchema, stateFrom, targetTurnRange, terminalRunFrom, turnAt } from './native.ts';
import type { Snapshot, TurnOutline } from './native.ts';

const modelCatalog = z.object({ groups: z.array(z.object({ id: identifier, name: z.string().max(240), models: z.array(z.object({ id: identifier, name: z.string().max(240), reasoning: z.object({ efforts: z.array(z.object({ id: identifier, name: z.string().max(240) })).max(32) }).optional() })).max(300) })).max(100) });
const permissionCatalog = z.object({ options: z.array(z.object({ value: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), name: z.string().max(240), description: z.string().max(2000).optional() })).max(100) });
const permissionNames: Record<string, string> = { 'read-only': '只读', 'workspace-write': '工作区读写', 'danger-full-access': '完全访问' };
const cursorSchema = z.object({ session: identifier, through: z.number().int().nonnegative(), before: z.number().int().nonnegative() }).strict();
const bindingSchema = z.object({ id: identifier, cwd: z.string().min(1).max(4096), configuration: z.object({ modelId: z.string().max(2048), permissionId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }), details: z.record(z.string(), z.unknown()) });
const unknown = (reason = 'DSH 连接中断，需要重新核对原生状态。'): NativeState => ({ status: 'unknown', pendingInputs: 0, configurationVerified: false, reason });
const nativeError = (error: unknown): HarnessError => error instanceof HarnessError ? error : new HarnessError('DSH_PROTOCOL_INVALID');

export function createDshAdapter(options: { launchFile: string }): HarnessAdapter {
  const connection = new Connection(options.launchFile);
  const subscriptions = new Set<() => void>();
  const lastStates = new Map<string, NativeState>();
  let closed = false;
  const checkBinding = (binding: Binding): Binding => {
    try { const parsed = bindingSchema.parse(binding); decodeModel(parsed.configuration.modelId); if (!isAbsolute(parsed.cwd) || normalize(parsed.cwd) !== parsed.cwd) throw new Error(); return parsed; }
    catch { throw new HarnessError('DSH_BINDING_INVALID'); }
  };
  const request = (binding: Binding, extra: Record<string, unknown> = {}) => ({ request: { address: { kind: 'session', sessionId: binding.id }, ...extra } });
  const remember = (binding: Binding, value: NativeState): NativeState => { lastStates.delete(binding.id); lastStates.set(binding.id, value); if (lastStates.size > 128) { const oldest = lastStates.keys().next().value; if (oldest) lastStates.delete(oldest); } return value; };
  const disconnectedState = (binding: Binding): NativeState => ({ ...unknown(), pendingInputs: lastStates.get(binding.id)?.pendingInputs ?? 0 });

  async function snapshot(binding: Binding, limit = 30): Promise<Snapshot> {
    checkBinding(binding);
    return new Promise<Snapshot>((resolve, reject) => {
      let cancel: (() => void) | undefined; let settled = false;
      const finish = (error?: unknown, value?: Snapshot) => { if (settled) return; settled = true; clearTimeout(timer); cancel?.(); if (error) reject(nativeError(error)); else if (value) resolve(value); };
      const timer = setTimeout(() => finish(new HarnessError('DSH_SNAPSHOT_TIMEOUT')), 15000);
      void connection.follow(request(binding, { maxMessages: limit, assistantStream: true }), {
        item(value) { if (settled) return; try { const parsed = snapshotSchema.parse(value); if (parsed.header.id !== binding.id || parsed.header.cwd !== binding.cwd) throw new HarnessError('DSH_BINDING_MISMATCH'); finish(undefined, parsed); } catch (error) { finish(error); } },
        failed: finish,
      }).then(stop => { cancel = stop; if (settled) stop(); }).catch(finish);
    });
  }

  async function state(binding: Binding, targetRunId?: string): Promise<NativeState> {
    try {
      let current = await snapshot(binding, 5); let bytes = Buffer.byteLength(JSON.stringify(current.records)); let pages = 0;
      // A running turn may start before the latest message window. Read only enough
      // durable events to prove its boundary; an exhausted bound remains unknown.
      for (; !boundaryFrom(current) && current.hasMore && pages < 10; pages++) {
        if (!current.projections.values.turnOutline?.length || !current.records.length) break;
        const before = Math.min(...current.records.map(record => record.event.seq));
        const page = pageSchema.parse(await connection.call('session/page', request(binding, { throughSeq: current.cursor, beforeSeq: before, maxMessages: 100 })));
        if (!page.records.length || page.records.some(record => record.event.seq >= before)) throw new HarnessError('DSH_HISTORY_NO_PROGRESS');
        bytes += Buffer.byteLength(JSON.stringify(page.records));
        if (bytes > 8 * 1024 * 1024 || current.records.length + page.records.length > 20_000) throw new HarnessError('DSH_STATE_HISTORY_LIMIT');
        current.records.unshift(...page.records); current.hasMore = page.hasMore;
      }
      let proofRecords = current.records;
      let terminalRunId = terminalRunFrom(binding.id, current, targetRunId);
      const range = targetTurnRange(binding.id, current, targetRunId);
      // Automatic notification turns may follow the user's accepted turn. Query
      // that exact interval without importing old approvals into current state.
      let before = range?.before;
      while (!terminalRunId && range && before !== undefined && before > range.start && pages < 10) {
        pages++;
        const page = pageSchema.parse(await connection.call('session/page', request(binding, { throughSeq: current.cursor, beforeSeq: before, maxMessages: 100 })));
        if (!page.records.length) break;
        const cut = before;
        if (page.records.some(record => record.event.seq >= cut) || new Set(page.records.map(record => record.event.seq)).size !== page.records.length) throw new HarnessError('DSH_HISTORY_NO_PROGRESS');
        bytes += Buffer.byteLength(JSON.stringify(page.records));
        if (bytes > 8 * 1024 * 1024) throw new HarnessError('DSH_STATE_HISTORY_LIMIT');
        terminalRunId = terminalRunFrom(binding.id, current, targetRunId, page.records);
        if (terminalRunId) proofRecords = page.records;
        before = Math.min(...page.records.map(record => record.event.seq));
        if (!page.hasMore) break;
      }
      if (pages > 0) {
        // Paging can outlive an idle period. Recheck current execution after
        // looking up old evidence, without treating a later turn as that proof.
        const latest = await snapshot(binding, 5);
        if (latest.cursor < current.cursor) throw new HarnessError('DSH_HISTORY_CHANGED');
        current = latest.cursor === current.cursor ? { ...latest, records: current.records, hasMore: current.hasMore } : latest;
        terminalRunId = terminalRunFrom(binding.id, current, targetRunId, proofRecords);
      }
      const result = stateFrom(binding, current);
      return remember(binding, { ...result, ...(terminalRunId ? { terminalRunId } : {}) });
    }
    catch (error) { if (error instanceof HarnessError && error.code === 'DSH_BINDING_INVALID') throw error; return disconnectedState(binding); }
  }

  async function catalog(): Promise<Catalog> {
    try {
      const [models, permissions, account] = await Promise.all([connection.call('session/modelCatalog'), connection.call('permissionPresets/catalog'), connection.call('account/getState')]);
      const signedIn = z.object({ status: z.enum(['signed-out', 'credential-stored']) }).parse(account).status === 'credential-stored';
      const groups = modelCatalog.parse(models).groups.filter(group => group.id !== 'deepseek-account' || signedIn);
      const result: Catalog = { id: 'dsh', available: groups.length > 0, models: [], permissions: permissionCatalog.parse(permissions).options.map(option => ({ id: option.value, label: permissionNames[option.value] ?? option.name,
        description: `使用 DSH 原生 ${option.value} 权限；交互式审批尚不支持，遇到审批需在原生界面处理或停止。${option.description ? ` ${option.description}` : ''}` })) };
      for (const group of groups) for (const model of group.models) {
        if (result.models.length >= 2048) throw new HarnessError('DSH_CATALOG_TOO_LARGE');
        const efforts = model.reasoning?.efforts;
        if (efforts?.length) for (const effort of efforts) result.models.push({ id: modelId({ provider: group.id, model: model.id, reasoningEffort: effort.id }), label: `${group.name} · ${model.name} · ${effort.name}` });
        else result.models.push({ id: modelId({ provider: group.id, model: model.id }), label: `${group.name} · ${model.name}` });
      }
      if (!result.models.length || !result.permissions.length) { result.available = false; result.reason = '请在 DSH 原生界面登录并配置可用模型与权限。'; }
      return result;
    } catch { return { id: 'dsh', available: false, reason: 'DSH Host 不可用或受保护的连接文件无效。', models: [], permissions: [] }; }
  }

  async function create(input: { cwd: string; configuration: Configuration }, onBound: (binding: Binding) => void): Promise<Binding> {
    try {
      const selected = decodeModel(input.configuration.modelId); const available = await catalog();
      if (!available.available || !available.models.some(model => model.id === input.configuration.modelId) || !available.permissions.some(permission => permission.id === input.configuration.permissionId)) throw new HarnessError('DSH_CONFIGURATION_UNAVAILABLE');
      if (!isAbsolute(input.cwd) || normalize(input.cwd) !== input.cwd || input.cwd.length > 4096) throw new HarnessError('DSH_CWD_INVALID');
      const native = z.object({ sessionId: identifier }).parse(await connection.call('session/create', { request: { cwd: input.cwd } }));
      const binding: Binding = { id: native.sessionId, cwd: input.cwd, configuration: { ...input.configuration }, details: { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) } };
      onBound(binding);
      await connection.call('session/selectModel', { request: { sessionId: binding.id, ...selected } });
      const permission = z.object({ result: z.object({ kind: z.literal('success') }) }).parse(await connection.call('commands/execute', { agentId: binding.id, line: `/permission ${input.configuration.permissionId}`, submittedAttachments: [] }));
      if (permission.result.kind !== 'success' || !(await state(binding)).configurationVerified) throw new HarnessError('DSH_CONFIGURATION_NOT_VERIFIED');
      return binding;
    } catch (error) { throw nativeError(error); }
  }

  async function history(binding: Binding, olderCursor?: string, limit = 30): Promise<HistoryPage> {
    try {
      checkBinding(binding); z.number().int().min(1).max(100).parse(limit);
      let records: z.infer<typeof pageSchema>['records']; let hasMore: boolean; let through: number; let activeTurn: number | undefined; let outline: TurnOutline = [];
      if (olderCursor) {
        if (!/^[A-Za-z0-9_-]{1,1024}$/.test(olderCursor)) throw new HarnessError('DSH_CURSOR_INVALID');
        const cursor = cursorSchema.parse(JSON.parse(Buffer.from(olderCursor, 'base64url').toString()));
        if (cursor.session !== binding.id || cursor.before > cursor.through) throw new HarnessError('DSH_CURSOR_INVALID');
        const page = pageSchema.parse(await connection.call('session/page', request(binding, { throughSeq: cursor.through, beforeSeq: cursor.before, maxMessages: limit })));
        records = page.records; hasMore = page.hasMore; through = cursor.through;
        const current = await snapshot(binding, 1); if (current.cursor < through) throw new HarnessError('DSH_HISTORY_CHANGED');
        outline = current.projections.values.turnOutline ?? [];
      } else {
        const current = await snapshot(binding, limit); records = current.records; hasMore = current.hasMore; through = current.cursor;
        outline = current.projections.values.turnOutline ?? [];
        const boundary = boundaryFrom(current); if (boundary?.openTurnStartSeq !== null) activeTurn = boundary?.lastTurn;
      }
      const first = records.length ? Math.min(...records.map(record => record.event.seq)) : undefined;
      if (hasMore && (first === undefined || first === 0)) throw new HarnessError('DSH_HISTORY_NO_PROGRESS');
      if (records.some(record => record.event.seq > through) || new Set(records.map(record => record.event.seq)).size !== records.length) throw new HarnessError('DSH_HISTORY_INVALID');
      return { items: historyItems(binding.id, records.map(record => record.event), activeTurn, outline), olderCursor: hasMore ? Buffer.from(JSON.stringify({ session: binding.id, through, before: first })).toString('base64url') : null };
    } catch (error) { throw nativeError(error); }
  }

  async function submit(binding: Binding, operation: { id: string; text: string }): Promise<Receipt> {
    try { checkBinding(binding); identifier.parse(operation.id); z.string().min(1).max(100000).refine(text => text.trim().length > 0).parse(operation.text); }
    catch { return { outcome: 'rejected', reason: '消息或会话参数无效。' }; }
    const current = await state(binding);
    if (!current.configurationVerified || current.pendingInputs > 0 || !['idle', 'interrupted', 'failed'].includes(current.status)) return { outcome: 'rejected', reason: current.reason ?? '原生对话尚未就绪。' };
    try {
      z.object({ accepted: z.literal(true) }).parse(await connection.call('session/prompt', { request: { sessionId: binding.id, requestId: operation.id, mode: 'queue', content: [{ type: 'text', text: operation.text }] } }));
      return { outcome: 'accepted' };
    } catch (error) { return error instanceof NativeRejection ? { outcome: 'rejected', reason: 'DSH 拒绝了这条输入。' } : { outcome: 'unknown', reason: '无法确认 DSH 是否接收；保留原操作身份核对，未自动重发。' }; }
  }

  async function reconcile(binding: Binding, operationId: string): Promise<Receipt> {
    try {
      checkBinding(binding); identifier.parse(operationId);
      const current = await snapshot(binding, 100);
      const inbox = current.projections.values.inbox;
      if ([...(inbox?.['next-turn'] ?? []), ...(inbox?.['next-step'] ?? [])].some(message => object(object(message).source).rpcId === operationId)) return { outcome: 'accepted' };
      let records = current.records; let hasMore = current.hasMore;
      for (let page = 0; page < 10; page++) {
        const accepted = historyItems(binding.id, records.map(record => record.event), undefined, current.projections.values.turnOutline).find(item => item.operationId === operationId);
        if (accepted) return { outcome: 'accepted', ...(accepted.runId ? { runId: accepted.runId } : {}) };
        if (!hasMore || !records.length) break;
        const before = Math.min(...records.map(record => record.event.seq));
        const previous = pageSchema.parse(await connection.call('session/page', request(binding, { throughSeq: current.cursor, beforeSeq: before, maxMessages: 100 })));
        if (previous.records.some(record => record.event.seq >= before)) throw new HarnessError('DSH_HISTORY_NO_PROGRESS');
        records = previous.records; hasMore = previous.hasMore;
      }
      return { outcome: 'unknown', reason: '在有界原生记录中尚未找到该操作；未自动重发。' };
    } catch { return { outcome: 'unknown', reason: '暂时无法核对原生操作；未自动重发。' }; }
  }

  async function stop(binding: Binding, expectedRun: string): Promise<Receipt> {
    checkBinding(binding);
    const current = await state(binding);
    if (!current.runId || current.runId !== expectedRun || !['running', 'waiting'].includes(current.status)) return { outcome: 'rejected', reason: '原生当前轮次已改变，未发送停止请求。' };
    try {
      // DSH has no expected-turn argument. This precheck is not an atomic native condition.
      z.object({ accepted: z.literal(true) }).parse(await connection.call('session/cancel', { request: { sessionId: binding.id } }));
      return { outcome: 'accepted', runId: expectedRun };
    } catch (error) { return error instanceof NativeRejection ? { outcome: 'rejected', reason: 'DSH 拒绝了停止请求。' } : { outcome: 'unknown', reason: '停止回执未知，需核对原生终态；排队输入不会被自动清空。' }; }
  }

  async function watch(binding: Binding, listener: (change: NativeChange) => void): Promise<() => void> {
    binding = checkBinding(binding);
    if (closed || subscriptions.size >= 24) throw new HarnessError('DSH_WATCH_LIMIT');
    let disposed = false; let generation = 0; let cancel: (() => void) | undefined; let retry: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined; let refreshActive = false; let attempt = 0;
    let textTimer: ReturnType<typeof setTimeout> | undefined; let pendingItem: NativeChange | undefined;
    const emit = (change: NativeChange) => { if (!disposed) { try { listener(change); } catch { dispose(); } } };
    const refresh = () => {
      if (refreshTimer || refreshActive || disposed) return;
      refreshTimer = setTimeout(() => { refreshTimer = undefined; refreshActive = true; const turnGeneration = generation; void state(binding).then(value => { if (turnGeneration === generation) emit({ type: 'state', state: value }); }).catch(() => emit({ type: 'state', state: unknown() })).finally(() => { refreshActive = false; }); }, 100);
    };
    function dispose(): void { if (disposed) return; disposed = true; generation++; cancel?.(); if (retry) clearTimeout(retry); if (refreshTimer) clearTimeout(refreshTimer); if (textTimer) clearTimeout(textTimer); subscriptions.delete(dispose); }
    function reconnect(): void {
      if (disposed || retry) return;
      generation++; cancel?.(); cancel = undefined;
      emit({ type: 'state', state: disconnectedState(binding) }); emit({ type: 'invalidate' });
      retry = setTimeout(() => { retry = undefined; void start(); }, Math.min(5000, 300 * 2 ** Math.min(attempt++, 5)));
      retry.unref();
    }
    async function start(): Promise<void> {
      if (disposed) return;
      const ownGeneration = ++generation; const live = new LiveAssistant(binding.id); let watermark = -1; let outline: TurnOutline = [];
      try {
        const stopFollow = await connection.follow(request(binding, { maxMessages: 30, assistantStream: true }), {
          item(value) {
            if (disposed || ownGeneration !== generation) return;
            try {
              const frame = object(value);
              if (frame.type === 'snapshot') {
                const current = snapshotSchema.parse(value); watermark = current.cursor; attempt = 0;
                emit({ type: 'state', state: remember(binding, stateFrom(binding, current)) }); emit({ type: 'invalidate' });
                outline = current.projections.values.turnOutline ?? [];
                const boundary = boundaryFrom(current);
                for (const item of historyItems(binding.id, current.records.map(record => record.event), boundary?.openTurnStartSeq !== null ? boundary?.lastTurn : undefined, outline)) emit({ type: 'item', item });
                if (!boundary) refresh();
                const item = live.restore(current); if (item) emit({ type: 'item', item });
              } else if (frame.type === 'event') {
                const event = eventSchema.parse(frame.event);
                if (event.seq <= watermark) return;
                if (watermark < 0 || event.seq !== watermark + 1) { reconnect(); return; }
                watermark = event.seq;
                if (event.type === 'turn/start' && typeof event.data.turn === 'number') {
                  if (outline.length >= 50_000) throw new HarnessError('DSH_TURN_LIMIT');
                  outline.push({ turn: event.data.turn, seq: event.seq });
                }
                const item = itemFrom(binding.id, event, true, turnAt(outline, event.seq)); if (item) emit({ type: 'item', item });
                if (event.type === 'assistant/message') { pendingItem = undefined; if (textTimer) clearTimeout(textTimer); textTimer = undefined; }
                if (/^(turn\/|agent\/inbox|approval\/|permission\/|sandbox\/|model\/|tool\/)/.test(event.type)) refresh();
              } else if (frame.type === 'assistant-stream') {
                const change = live.accept(frame.frame);
                if (change.resubscribe) { reconnect(); return; }
                if (change.invalidate) { emit({ type: 'invalidate' }); refresh(); }
                if (change.item) { pendingItem = { type: 'item', item: change.item }; if (!textTimer) textTimer = setTimeout(() => { textTimer = undefined; const next = pendingItem; pendingItem = undefined; if (next && ownGeneration === generation) emit(next); }, 50); }
              } else reconnect();
            } catch { reconnect(); }
          },
          failed() { if (ownGeneration === generation) reconnect(); },
        });
        if (disposed || ownGeneration !== generation) stopFollow(); else cancel = stopFollow;
      } catch { if (ownGeneration === generation) reconnect(); }
    }
    subscriptions.add(dispose); await start(); return dispose;
  }

  return { id: 'dsh', catalog, create, state, history, submit, reconcile, stop, watch, async close() { closed = true; for (const dispose of [...subscriptions]) dispose(); lastStates.clear(); await connection.close(); } };
}

import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { QueueDelivery, TeamView } from '../../shared/workbench.ts';
import { subagentIdSchema, subagentLimit } from '../../shared/workbench.ts';
import { HarnessError } from '../types.ts';
import type { Binding, Catalog, Configuration, HarnessAdapter, HarnessInput, HistoryPage, NativeChange, NativeItem, NativeState, NativeSubagent, Receipt, SubagentHistory, SubagentSnapshot } from '../types.ts';
import { Connection, NativeRejection } from './connection.ts';
import { LiveAssistant } from './live.ts';
import { boundaryFrom, decodeModel, selectedModel, eventSchema, historyItems, identifier, inboxSenders, itemFrom, modelId, modelSchema, object, pageSchema, snapshotSchema, stateFrom, targetTurnRange, terminalStatusFrom, textBlocks, textContent, turnAt, usageFrom } from './native.ts';
import type { Event } from './native.ts';
import type { Snapshot, TurnOutline } from './native.ts';
import { nativeSkill, resolveSkillInput, skillOptions, type NativeSkill } from '../skills.ts';

const modelCatalog = z.object({ default: modelSchema.optional(), groups: z.array(z.object({ id: identifier, name: z.string().max(240), models: z.array(z.object({ id: identifier, name: z.string().max(240), reasoning: z.object({ efforts: z.array(z.object({ id: identifier, name: z.string().max(240) })).max(32), defaultEffort: identifier.optional() }).optional() })).max(300) })).max(100) });
const permissionCatalog = z.object({ options: z.array(z.object({ value: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), name: z.string().max(240), description: z.string().max(2000).optional() })).max(100) });
const permissionNames: Record<string, string> = { 'read-only': '只读', 'workspace-write': '工作区读写', 'danger-full-access': '完全访问' };
const nativeSkillRow = z.object({ name: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/), description: z.string().max(16_000), path: z.string().max(4096).optional() });
const skillsResponse = z.object({ skills: z.array(z.unknown()).max(2000) });
const cursorSchema = z.object({ session: identifier, through: z.number().int().nonnegative(), before: z.number().int().nonnegative() }).strict();
const bindingSchema = z.object({ id: identifier, cwd: z.string().min(1).max(4096), configuration: z.object({ modelId: z.string().max(2048), permissionId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), reasoningEffort: identifier.optional() }), details: z.record(z.string(), z.unknown()) });
const unknown = (reason = 'DSH 连接中断，需要重新核对原生状态。'): NativeState => ({ status: 'unknown', pendingInputs: 0, configurationVerified: false, reason });
const nativeError = (error: unknown): HarnessError => error instanceof HarnessError ? error : new HarnessError('DSH_PROTOCOL_INVALID');
const catalogEntry = z.object({ id: identifier, createdAt: z.number().int().nonnegative().optional(), mode: z.enum(['one-shot', 'external', 'continuable', 'unknown']), label: z.string().max(64 * 1024).optional() }).passthrough();
const timingSchema = z.object({ settledMs: z.number().optional(), active: z.object({ since: z.number(), through: z.number() }).passthrough().optional(), lastTurnCompleted: z.boolean().optional() }).passthrough();
const teamProjection = z.object({
  members: z.array(z.object({ id: identifier, name: z.string().max(400), role: z.enum(['lead', 'teammate']) }).passthrough()).max(64),
  tasks: z.array(z.object({ id: z.string().min(1).max(240), subject: z.string().max(2000), description: z.string().max(16_000),
    status: z.enum(['pending', 'in_progress', 'completed', 'deleted']), writeScopes: z.array(z.string().max(4096)).max(32), ownerName: z.string().max(400).optional() }).passthrough()).max(400),
}).passthrough();
type CatalogRow = { id: string; parentId: string; mode: z.infer<typeof catalogEntry>['mode']; label?: string; createdAt?: number };
const shortLine = (value: string, chars: number) => { const line = value.trim().split('\n')[0] ?? ''; return line.length <= chars ? line : line.slice(0, chars - 1) + '…'; };
const childAddress = (row: CatalogRow) => ({ kind: 'subagent', parentSessionId: row.parentId, childSessionId: row.id, mode: row.mode === 'continuable' || row.mode === 'one-shot' ? row.mode : 'unknown' });

export function createDshAdapter(options: { launchFile: string }): HarnessAdapter {
  const connection = new Connection(options.launchFile);
  const subscriptions = new Set<() => void>();
  /** Conversation watches by native session, so child observation can hint the owning conversation. */
  const rootListeners = new Map<string, Set<(change: NativeChange) => void>>();
  const hint = (rootId: string, change: NativeChange) => { for (const listener of rootListeners.get(rootId) ?? []) { try { listener(change); } catch { /* one observer cannot break others */ } } };
  const lastStates = new Map<string, NativeState>();
  let closed = false;
  const checkBinding = (binding: Binding): Binding => {
    try { const parsed = bindingSchema.parse(binding); selectedModel(parsed.configuration); if (!isAbsolute(parsed.cwd) || normalize(parsed.cwd) !== parsed.cwd) throw new Error(); return parsed; }
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
      let terminalStatus = terminalStatusFrom(binding.id, current, targetRunId);
      const range = targetTurnRange(binding.id, current, targetRunId);
      // Automatic notification turns may follow the user's accepted turn. Query
      // that exact interval without importing old approvals into current state.
      let before = range?.before;
      while (!terminalStatus && range && before !== undefined && before > range.start && pages < 10) {
        pages++;
        const page = pageSchema.parse(await connection.call('session/page', request(binding, { throughSeq: current.cursor, beforeSeq: before, maxMessages: 100 })));
        if (!page.records.length) break;
        const cut = before;
        if (page.records.some(record => record.event.seq >= cut) || new Set(page.records.map(record => record.event.seq)).size !== page.records.length) throw new HarnessError('DSH_HISTORY_NO_PROGRESS');
        bytes += Buffer.byteLength(JSON.stringify(page.records));
        if (bytes > 8 * 1024 * 1024) throw new HarnessError('DSH_STATE_HISTORY_LIMIT');
        terminalStatus = terminalStatusFrom(binding.id, current, targetRunId, page.records);
        if (terminalStatus) proofRecords = page.records;
        before = Math.min(...page.records.map(record => record.event.seq));
        if (!page.hasMore) break;
      }
      if (pages > 0) {
        // Paging can outlive an idle period. Recheck current execution after
        // looking up old evidence, without treating a later turn as that proof.
        const latest = await snapshot(binding, 5);
        if (latest.cursor < current.cursor) throw new HarnessError('DSH_HISTORY_CHANGED');
        current = latest.cursor === current.cursor ? { ...latest, records: current.records, hasMore: current.hasMore } : latest;
        terminalStatus = terminalStatusFrom(binding.id, current, targetRunId, proofRecords);
      }
      const result = stateFrom(binding, current);
      return remember(binding, { ...result, ...(terminalStatus ? { terminalRunId: targetRunId, terminalStatus } : {}) });
    }
    catch (error) { if (error instanceof HarnessError && error.code === 'DSH_BINDING_INVALID') throw error; return disconnectedState(binding); }
  }

  async function catalog(): Promise<Catalog> {
    try {
      const [models, permissions, account] = await Promise.all([connection.call('session/modelCatalog'), connection.call('permissionPresets/catalog'), connection.call('account/getState')]);
      const signedIn = z.object({ status: z.enum(['signed-out', 'credential-stored']) }).parse(account).status === 'credential-stored';
      const nativeCatalog = modelCatalog.parse(models);
      const groups = nativeCatalog.groups.filter(group => group.id !== 'deepseek-account' || signedIn);
      const result: Catalog = { id: 'dsh', available: groups.length > 0, models: [], permissions: permissionCatalog.parse(permissions).options.map(option => ({ id: option.value, label: permissionNames[option.value] ?? option.name,
        description: `使用 DSH 原生 ${option.value} 权限；交互式审批尚不支持，遇到审批需在原生界面处理或停止。${option.description ? ` ${option.description}` : ''}` })) };
      for (const group of groups) for (const model of group.models) {
        if (result.models.length >= 2048) throw new HarnessError('DSH_CATALOG_TOO_LARGE');
        const efforts = model.reasoning?.efforts;
        const isDefault = nativeCatalog.default?.provider === group.id && nativeCatalog.default.model === model.id;
        const defaultEffort = isDefault && nativeCatalog.default?.reasoningEffort !== undefined
          ? nativeCatalog.default.reasoningEffort : model.reasoning?.defaultEffort;
        const id = modelId({ provider: group.id, model: model.id });
        result.models.push({ id, label: `${group.name} · ${model.name}`, ...(efforts?.length ? { reasoningEfforts: efforts.map(effort => ({ id: effort.id, label: effort.name })) } : {}),
          ...(efforts?.some(effort => effort.id === defaultEffort) ? { defaultReasoningEffort: defaultEffort } : {}) });
        if (isDefault) result.defaultModelId = id;
      }
      if (!result.models.length || !result.permissions.length) { result.available = false; result.reason = '请在 DSH 原生界面登录并配置可用模型与权限。'; }
      return result;
    } catch { return { id: 'dsh', available: false, reason: 'DSH Host 不可用或受保护的连接文件无效。', models: [], permissions: [] }; }
  }

  async function assertBlank(binding: Binding): Promise<void> {
    const current = await snapshot(binding, 10);
    const state = stateFrom(binding, current);
    if (!current.projections.values.turnOutline || current.projections.values.turnOutline.length ||
      current.records.some(row => row.event.type === 'user/message' || row.event.type === 'turn/start') ||
      !current.projections.values.inbox || current.projections.values.userQuestions?.active.length ||
      state.pendingInputs || boundaryFrom(current)?.lastTurn !== 0 || boundaryFrom(current)?.openTurnStartSeq !== null) throw new HarnessError('DSH_PREPARED_SESSION_NOT_EMPTY');
  }

  async function prepareDraft(input: { id: string; cwd: string }) {
    z.uuid().parse(input.id);
    if (!isAbsolute(input.cwd) || normalize(input.cwd) !== input.cwd || input.cwd.length > 4096) throw new HarnessError('DSH_CWD_INVALID');
    const rows = z.object({ items: z.array(z.object({ sessionId: identifier, blank: z.boolean(), cwd: z.string().optional() })).max(20000) }).parse(await connection.call('session/list', { _request: {} }));
    const existing = rows.items.find(row => row.sessionId === input.id);
    if (existing && (!existing.blank || existing.cwd !== input.cwd)) throw new HarnessError('DSH_PREPARED_SESSION_NOT_EMPTY');
    if (!existing) {
      const created = z.object({ sessionId: identifier }).parse(await connection.call('session/create', { request: { cwd: input.cwd, sessionId: input.id } }));
      if (created.sessionId !== input.id) throw new HarnessError('DSH_PREPARED_IDENTITY_CHANGED');
    }
    const binding: Binding = { id: input.id, cwd: input.cwd, configuration: { modelId: modelId({ provider: 'prepared', model: 'prepared' }), permissionId: 'read-only' }, details: {} };
    await assertBlank(binding);
    return skillOptions(await skillCatalog(binding));
  }

  async function create(input: { cwd: string; configuration: Configuration; preparedId?: string }, onBound: (binding: Binding) => void): Promise<Binding> {
    try {
      const selected = selectedModel(input.configuration); const available = await catalog();
      const model = available.models.find(model => model.id === modelId({ provider: selected.provider, model: selected.model }));
      if (!model || (model.reasoningEfforts?.length ? !model.reasoningEfforts.some(effort => effort.id === selected.reasoningEffort) : selected.reasoningEffort !== undefined)) throw new HarnessError('DSH_REASONING_EFFORT_UNAVAILABLE');
      if (!available.available || !available.permissions.some(permission => permission.id === input.configuration.permissionId)) throw new HarnessError('DSH_CONFIGURATION_UNAVAILABLE');
      if (!isAbsolute(input.cwd) || normalize(input.cwd) !== input.cwd || input.cwd.length > 4096) throw new HarnessError('DSH_CWD_INVALID');
      const native = input.preparedId ? { sessionId: z.uuid().parse(input.preparedId) } : z.object({ sessionId: identifier }).parse(await connection.call('session/create', { request: { cwd: input.cwd } }));
      const binding: Binding = { id: native.sessionId, cwd: input.cwd, configuration: { ...input.configuration }, details: { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) } };
      if (input.preparedId) await assertBlank(binding);
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
      let usage: HistoryPage['usage'];
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
        usage = usageFrom(current);
        outline = current.projections.values.turnOutline ?? [];
        const boundary = boundaryFrom(current); if (boundary?.openTurnStartSeq !== null) activeTurn = boundary?.lastTurn;
      }
      const first = records.length ? Math.min(...records.map(record => record.event.seq)) : undefined;
      if (hasMore && (first === undefined || first === 0)) throw new HarnessError('DSH_HISTORY_NO_PROGRESS');
      if (records.some(record => record.event.seq > through) || new Set(records.map(record => record.event.seq)).size !== records.length) throw new HarnessError('DSH_HISTORY_INVALID');
      return { items: historyItems(binding.id, records.map(record => record.event), activeTurn, outline, binding.cwd), olderCursor: hasMore ? Buffer.from(JSON.stringify({ session: binding.id, through, before: first })).toString('base64url') : null, ...(usage ? { usage } : {}) };
    } catch (error) { throw nativeError(error); }
  }

  async function readImage(binding: Binding, path: string): Promise<string> {
    checkBinding(binding);
    const value = z.object({ absolutePath: z.string().max(4096), data: z.string().max(8 * 1024 * 1024), eof: z.literal(true) }).parse(await connection.call('workspaceFiles/readBytes', { workspaceFileScopeId: binding.id, path, options: {} }));
    if (value.absolutePath !== path) throw new HarnessError('DSH_IMAGE_PATH_CHANGED');
    return value.data;
  }
  async function skillCatalog(binding: Binding): Promise<NativeSkill[]> {
    const { id } = checkBinding(binding);
    const result = skillsResponse.parse(await connection.call('skills/list', { request: { sessionId: id } }));
    const skills = new Map<string, NativeSkill>();
    for (const raw of result.skills) {
      const row = nativeSkillRow.safeParse(raw);
      if (!row.success) continue;
      const skill = nativeSkill(binding, row.data);
      if (skill) skills.set(skill.id, skill);
      if (skills.size === 500) break;
    }
    return [...skills.values()];
  }

  async function submit(binding: Binding, operation: HarnessInput, delivery?: QueueDelivery): Promise<Receipt> {
    try { checkBinding(binding); identifier.parse(operation.id); z.string().max(100000).parse(operation.text); if (!operation.text.trim() && !operation.imageData?.length) throw new Error('empty_input'); }
    catch { return { outcome: 'rejected', reason: '消息或会话参数无效。' }; }
    const current = await state(binding);
    if (delivery?.mode === 'current') return { outcome: 'rejected', reason: 'queue_mode_unavailable' };
    if (!current.configurationVerified || current.status === 'unknown') return { outcome: 'rejected', reason: current.reason ?? '原生对话尚未就绪。' };
    if (!delivery && (current.pendingInputs > 0 || !['idle', 'interrupted', 'failed'].includes(current.status)))
      return { outcome: 'rejected', reason: current.reason ?? '原生对话尚未就绪。' };
    let text = operation.text;
    if (operation.skills?.length) {
      const skills = await skillCatalog(binding).catch(() => undefined);
      const resolved = skills && resolveSkillInput(operation, skills, '/');
      if (!resolved) return { outcome: 'rejected', reason: 'skill_reference_unavailable' };
      text = resolved.text;
    }
    try {
      z.object({ accepted: z.literal(true) }).parse(await connection.call('session/prompt', { request: { sessionId: binding.id, requestId: operation.id, mode: delivery?.mode === 'soon' ? 'steer' : 'queue', content: [...(text ? [{ type: 'text', text }] : []), ...(operation.imageData ?? []).map(image => ({ type: 'image', mediaType: image.mediaType, data: image.data }))] } }));
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

  /** A passive snapshot through a sub-agent address; following a child never activates it. */
  async function childSnapshot(row: CatalogRow, cwd: string, limit = 10): Promise<Snapshot> {
    return new Promise<Snapshot>((resolve, reject) => {
      let cancel: (() => void) | undefined; let settled = false;
      const finish = (error?: unknown, value?: Snapshot) => { if (settled) return; settled = true; clearTimeout(timer); cancel?.(); if (error) reject(nativeError(error)); else if (value) resolve(value); };
      const timer = setTimeout(() => finish(new HarnessError('DSH_SNAPSHOT_TIMEOUT')), 15000);
      void connection.follow({ request: { address: childAddress(row), maxMessages: limit } }, {
        item(value) { if (settled) return; try { const parsed = snapshotSchema.parse(value); if (parsed.header.id !== row.id || (parsed.header.cwd !== undefined && parsed.header.cwd !== cwd)) throw new HarnessError('DSH_BINDING_MISMATCH'); finish(undefined, parsed); } catch (error) { finish(error); } },
        failed: finish,
      }).then(stop => { cancel = stop; if (settled) stop(); }).catch(finish);
    });
  }
  const catalogRows = (current: Snapshot, parentId: string): CatalogRow[] => (current.projections.values.subagentCatalog ?? []).flatMap(raw => {
    const entry = catalogEntry.safeParse(raw);
    if (!entry.success || !subagentIdSchema.safeParse(entry.data.id).success) return [];
    return [{ id: entry.data.id, parentId, mode: entry.data.mode, ...(entry.data.label ? { label: entry.data.label } : {}), ...(entry.data.createdAt ? { createdAt: entry.data.createdAt } : {}) }];
  });
  function childStatus(current: Snapshot): { status: NativeSubagent['status']; endedAt?: number } {
    const boundary = boundaryFrom(current);
    const timing = timingSchema.safeParse(current.projections.values.subagentTiming).data;
    if (boundary?.openTurnStartSeq != null) return { status: 'running' };
    if (boundary && boundary.lastTurn === 0) return { status: 'idle' };
    const end = boundary && current.records.find(({ event }) => event.type === 'turn/end' && event.data.turn === boundary.lastTurn)?.event;
    if (end) {
      const kind = String(object(end.data.reason).kind);
      return { status: kind === 'completed' ? 'completed' : kind === 'aborted' || kind === 'interrupted' ? 'interrupted' : 'failed', endedAt: end.time };
    }
    if (timing?.active) return { status: 'running' };
    if (timing?.lastTurnCompleted !== undefined) return { status: timing.lastTurnCompleted ? 'completed' : 'interrupted' };
    return { status: 'unknown' };
  }
  /** The spawn tree reachable from this conversation, bounded in depth and reads. */
  async function tree(binding: Binding): Promise<{ parent: Snapshot; rows: CatalogRow[]; children: Map<string, Snapshot> }> {
    const parent = await snapshot(binding, 40);
    const rows = catalogRows(parent, binding.id); const children = new Map<string, Snapshot>();
    for (let index = 0, reads = 0; index < rows.length && rows.length <= subagentLimit; index++) {
      const row = rows[index]!;
      if (row.mode === 'external' || reads++ >= 48) continue;
      const child = await childSnapshot(row, binding.cwd).catch(() => undefined);
      if (!child) continue;
      children.set(row.id, child);
      const depth = (function depthOf(id: string, hops = 0): number { const value = rows.find(item => item.id === id); return !value || value.parentId === binding.id || hops > 4 ? hops : depthOf(value.parentId, hops + 1); })(row.id);
      if (depth < 3) for (const nested of catalogRows(child, row.id)) if (!rows.some(item => item.id === nested.id)) rows.push(nested);
    }
    return { parent, rows: rows.slice(0, subagentLimit), children };
  }
  async function owned(binding: Binding, agentId: string): Promise<CatalogRow> {
    if (!subagentIdSchema.safeParse(agentId).success || agentId === binding.id) throw new HarnessError('subagent_not_owned');
    const parent = await snapshot(binding, 5);
    const direct = catalogRows(parent, binding.id);
    const found = direct.find(row => row.id === agentId);
    if (found) return found;
    for (const row of direct.filter(value => value.mode !== 'external').slice(0, 16)) {
      const child = await childSnapshot(row, binding.cwd, 1).catch(() => undefined);
      const nested = child && catalogRows(child, row.id).find(value => value.id === agentId);
      if (nested) return nested;
    }
    throw new HarnessError('subagent_not_owned');
  }
  async function subagents(binding: Binding): Promise<SubagentSnapshot> {
    checkBinding(binding);
    const { parent, rows, children } = await tree(binding);
    const settled = new Set(parent.records.flatMap(({ event }) => event.type === 'user/message' && object(event.data.source).kind === 'subagent-settled' ? [String(object(event.data.source).senderSessionId)] : []));
    const parentRunning = boundaryFrom(parent)?.openTurnStartSeq != null;
    const team = teamProjection.safeParse(parent.projections.values.agentTeam).data;
    const names = new Map(team?.members.map(member => [member.id, member.name]));
    const agents: NativeSubagent[] = rows.map(row => {
      const child = children.get(row.id);
      const state = row.mode === 'external' ? { status: settled.has(row.id) ? 'completed' as const : parentRunning ? 'running' as const : 'idle' as const }
        : child ? childStatus(child) : { status: 'unknown' as const };
      const used = child?.projections.values.modelSelection?.lastUsed;
      const label = row.label?.trim();
      const name = names.get(row.id) ?? (label ? shortLine(label, 40) : '子 Agent');
      return { id: row.id, parentId: row.parentId, name, status: state.status,
        ...(label && label !== name ? { task: shortLine(label, 2000) } : {}),
        ...(used ? { model: used.reasoningEffort ? `${used.model} · ${used.reasoningEffort}` : used.model } : {}),
        ...(row.mode === 'external' ? { external: true } : {}), ...(row.createdAt ? { startedAt: row.createdAt } : {}),
        ...(state.endedAt ? { endedAt: state.endedAt } : {}) };
    });
    let view: TeamView | undefined;
    if (team) {
      const statusOf = new Map(agents.map(agent => [agent.id, agent.status]));
      view = {
        members: team.members.slice(0, 64).filter(member => subagentIdSchema.safeParse(member.id).success).map(member => member.id === binding.id || member.role === 'lead'
          ? { id: member.id, name: shortLine(member.name, 200) || 'lead', status: parentRunning ? 'running' as const : 'idle' as const, lead: true as const }
          : { id: member.id, name: shortLine(member.name, 200) || '成员', status: statusOf.get(member.id) === 'running' ? 'running' as const : statusOf.has(member.id) && statusOf.get(member.id) !== 'unknown' ? 'idle' as const : 'unknown' as const,
            ...(statusOf.has(member.id) ? { agentId: member.id } : {}) }),
        tasks: team.tasks.filter(task => task.status !== 'deleted').slice(0, 200).map(task => ({ id: task.id, title: task.subject.slice(0, 2000), description: task.description.slice(0, 16_000),
          status: task.status as 'pending' | 'in_progress' | 'completed', ...(task.ownerName ? { owner: task.ownerName.slice(0, 400) } : {}), writeScopes: task.writeScopes.slice(0, 32) })),
      };
    }
    // DSH wakes the parent with each settlement; nothing waits for a later user turn.
    return { agents, ...(view ? { team: view } : {}), resultsPending: false };
  }
  /** Child transcripts: the first delegated message is the brief; later delegated input is attributed to the spawning agent. */
  function childItems(agentId: string, events: Event[], activeTurn: number | undefined, outline: TurnOutline, cwd: string, briefSeq?: number): NativeItem[] {
    const items = historyItems(agentId, events, activeTurn, outline, cwd);
    for (const event of events) {
      if (event.type !== 'user/message' || event.seq === briefSeq || typeof object(event.data.source).rpcId === 'string') continue;
      const source = object(event.data.source);
      // Runtime and time context snapshots are injected by the Host for the model; they are nobody's message.
      if (!['user', 'agent-message', 'subagent-settled'].includes(String(source.kind))) continue;
      const text = source.kind === 'subagent-settled' ? String(source.summary ?? '下级子 Agent 已结束') : `来自主 Agent：${textContent(event.data.content)}`;
      const turn = turnAt(outline, event.seq);
      items.push({ id: `dsh:${agentId}:event:${event.seq}`, kind: 'notice', text: text.slice(0, 1024 * 1024), status: 'completed', ...(turn === undefined ? {} : { runId: `dsh:${agentId}:turn:${turn}` }) });
    }
    const order = new Map(events.map(event => [`dsh:${agentId}:event:${event.seq}`, event.seq]));
    return items.sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  }
  async function subagentHistory(binding: Binding, agentId: string, olderCursor?: string, limit = 50): Promise<SubagentHistory> {
    checkBinding(binding); z.number().int().min(1).max(100).parse(limit);
    const row = await owned(binding, agentId);
    if (row.mode === 'external') return { items: [], olderCursor: null };
    const request = (extra: Record<string, unknown>) => ({ request: { address: childAddress(row), ...extra } });
    let records: z.infer<typeof pageSchema>['records']; let hasMore: boolean; let through: number; let activeTurn: number | undefined; let outline: TurnOutline = [];
    let brief: string | undefined; let briefSeq: number | undefined;
    if (olderCursor) {
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(olderCursor)) throw new HarnessError('DSH_CURSOR_INVALID');
      const cursor = cursorSchema.parse(JSON.parse(Buffer.from(olderCursor, 'base64url').toString()));
      if (cursor.session !== agentId || cursor.before > cursor.through) throw new HarnessError('DSH_CURSOR_INVALID');
      const page = pageSchema.parse(await connection.call('session/page', request({ throughSeq: cursor.through, beforeSeq: cursor.before, maxMessages: limit })));
      records = page.records; hasMore = page.hasMore; through = cursor.through;
      outline = (await childSnapshot(row, binding.cwd, 1)).projections.values.turnOutline ?? [];
    } else {
      const current = await childSnapshot(row, binding.cwd, limit); records = current.records; hasMore = current.hasMore; through = current.cursor;
      outline = current.projections.values.turnOutline ?? [];
      const boundary = boundaryFrom(current); if (boundary?.openTurnStartSeq !== null) activeTurn = boundary?.lastTurn;
      // The delegated instruction is the child's first message, a few events after its header.
      const opening = pageSchema.parse(await connection.call('session/page', request({ throughSeq: current.cursor, beforeSeq: Math.min(current.cursor + 1, 64), maxMessages: 64 })));
      const first = [...opening.records, ...records].map(record => record.event).filter(event => event.type === 'user/message' && object(event.data.source).kind === 'user' && typeof object(event.data.source).rpcId !== 'string').sort((a, b) => a.seq - b.seq)[0];
      // Delegated instructions arrive as separate text parts; keep them apart.
      if (first) { brief = textBlocks(first.data.content).join('\n\n').slice(0, 64 * 1024); briefSeq = first.seq; }
    }
    const first = records.length ? Math.min(...records.map(record => record.event.seq)) : undefined;
    if (hasMore && (first === undefined || first === 0)) throw new HarnessError('DSH_HISTORY_NO_PROGRESS');
    return { ...(brief ? { brief } : {}), items: childItems(agentId, records.map(record => record.event), activeTurn, outline, binding.cwd, briefSeq),
      olderCursor: hasMore ? Buffer.from(JSON.stringify({ session: agentId, through, before: first })).toString('base64url') : null };
  }
  async function observeSubagent(binding: Binding, agentId: string): Promise<() => void> {
    checkBinding(binding);
    const row = await owned(binding, agentId);
    if (row.mode === 'external') return () => {};
    let lastTranscript = 0;
    const stop = await connection.follow({ request: { address: childAddress(row), maxMessages: 1, assistantStream: true } }, {
      item(value) {
        const frame = object(value);
        if (frame.type === 'event') {
          const type = String(object(frame.event).type ?? '');
          if (/^turn\//.test(type)) { hint(binding.id, { type: 'subagents', agentId }); return; }
        }
        if (frame.type === 'event' || frame.type === 'assistant-stream') {
          const now = Date.now(); if (now - lastTranscript < 250) return; lastTranscript = now;
          hint(binding.id, { type: 'subagents', agentId, transcript: true });
        }
      },
      failed() { hint(binding.id, { type: 'subagents', agentId }); },
    });
    return stop;
  }
  async function stopSubagent(binding: Binding, agentId: string): Promise<Receipt> {
    checkBinding(binding);
    let row: CatalogRow;
    try { row = await owned(binding, agentId); }
    catch (error) { return error instanceof HarnessError && error.code === 'subagent_not_owned' ? { outcome: 'rejected', reason: 'subagent_not_owned' } : { outcome: 'unknown', reason: '暂时无法核对子 Agent 归属；未发送停止请求。' }; }
    if (row.mode === 'one-shot' || row.mode === 'unknown') return { outcome: 'rejected', reason: 'subagent_not_stoppable' };
    try {
      z.object({ accepted: z.literal(true) }).parse(await connection.call('subagents/interruptByParent', { childSessionId: row.id, parentSessionId: row.parentId, mode: 'continuable' }));
      return { outcome: 'accepted' };
    } catch (error) { return error instanceof NativeRejection ? { outcome: 'rejected', reason: 'DSH 拒绝了停止请求。' } : { outcome: 'unknown', reason: '停止回执未知，需核对子 Agent 状态；未自动重发。' }; }
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
    function dispose(): void { if (disposed) return; disposed = true; generation++; cancel?.(); if (retry) clearTimeout(retry); if (refreshTimer) clearTimeout(refreshTimer); if (textTimer) clearTimeout(textTimer); subscriptions.delete(dispose);
      const listeners = rootListeners.get(binding.id); listeners?.delete(emit); if (listeners && !listeners.size) rootListeners.delete(binding.id); }
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
                for (const item of historyItems(binding.id, current.records.map(record => record.event), boundary?.openTurnStartSeq !== null ? boundary?.lastTurn : undefined, outline, binding.cwd)) emit({ type: 'item', item });
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
                if (item?.collaboration) emit({ type: 'subagents', ...(item.collaboration.agentIds.length === 1 ? { agentId: item.collaboration.agentIds[0]! } : {}) });
                else if (/^team\//.test(event.type)) emit({ type: 'subagents' });
                else if (event.type === 'agent/inbox/spliced') for (const agentId of inboxSenders(event.data)) emit({ type: 'subagents', agentId });
                if (event.type === 'assistant/message') { pendingItem = undefined; if (textTimer) clearTimeout(textTimer); textTimer = undefined; }
                if (/^(turn\/|agent\/inbox|approval\/|permission\/|sandbox\/|model\/|tool\/|assistant\/(?:message|attempt)$|compaction\/)/.test(event.type)) refresh();
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
    subscriptions.add(dispose);
    let listeners = rootListeners.get(binding.id); if (!listeners) { listeners = new Set(); rootListeners.set(binding.id, listeners); } listeners.add(emit);
    await start(); return dispose;
  }

  return { id: 'dsh', earlyInput: 'soon', catalog,
    normalizeConfiguration(configuration) {
      const selected = selectedModel(configuration);
      return { ...configuration, modelId: modelId({ provider: selected.provider, model: selected.model }),
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) };
    }, prepareDraft, skills: async binding => skillOptions(await skillCatalog(binding)), create, state, history, submit, submitQueued: submit, readImage, reconcile, stop, watch,
    subagents, subagentHistory, observeSubagent, stopSubagent, async close() { closed = true; for (const dispose of [...subscriptions]) dispose(); lastStates.clear(); await connection.close(); } };
}

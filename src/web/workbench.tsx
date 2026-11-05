import { FolderOpen, LogOut, Plus, RefreshCw, X, ChevronRight, Puzzle } from 'lucide-react';
import { BrandMark, Button, IconButton } from './ui/controls.tsx';
import { WorkbenchFrame } from './patterns/workbench-frame.tsx';
import { lazy, Suspense, useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState } from 'react';
import {
  workbenchConfigurationSchema, workspaceLookupSchema, conversationResponseSchema, operationResponseSchema,
  snapshotSchema, changeEventSchema, resetEventSchema, queueViewSchema, queueEntrySchema,
  type WorkbenchConfiguration, type Conversation, type WorkbenchSnapshot, type WorkbenchItem, type QueueCommand, type TurnFileSummary,
} from '../shared/workbench.ts';
import { request, RequestError, readDraft, sameInput, saveDraft, type Draft } from './workbench-client.ts';
import { sessionSchema } from '../shared/http.ts';
import './workbench.css';
import { Transcript, FilePicker } from './conversation-content.tsx';
import { Composer } from './composer.tsx';
import { ConversationNavigation, useSidebarWidth } from './conversation-navigation.tsx';
import type { MessageReference } from '../shared/content.ts';
import { WorkspaceManagement, type WorkspaceAction } from './workspace-management.tsx';
import { InputQueue } from './input-queue.tsx';
import { PluginManagement } from './plugin-management.tsx';
import { WorkspaceSelect } from './workspace-selection.tsx';
import { StorageNotice } from './storage-notice.tsx';
import { WorkspaceExecutionStatus, type WorkspaceEditStatus } from './workspace-execution-status.tsx';
const emptyWorkspaces: WorkbenchConfiguration['workspaces'] = [];
const WorkspaceReader = lazy(() => import('./workspace-reader.tsx').then(module => ({ default: module.WorkspaceReader })));

const states = { idle: '就绪', running: '运行中', waiting: '等待处理', interrupted: '已中断', failed: '执行失败', unknown: '待核实' };
const stateLabel = (c: Conversation) => c.readiness === 'preparing' ? '正在准备' : c.readiness === 'blocked' ? '准备未完成' : states[c.state.status];
const failures: Record<string, string> = {
  conversation_archived: '这段对话已归档，请恢复后继续。',
  workspace_execution_blocked: '工作区暂未开放新任务。请等待执行环境核对，或先恢复 Agent；输入已保留。',
  workspace_save_in_progress: '工作区正在保存文件，保存结束后可以继续发送。',
  workspace_removed: '工作区已移除。恢复后可以继续对话。',
  workspace_remove_busy: '正在核对能否移除工作区，请稍后再试。',
  workspace_directory_changed: '工作区目录已被替换，输入已保留。',
  workspace_directory_unavailable: '工作区目录暂时无法访问，输入已保留。',
  workspace_identity_unavailable: '当前文件系统无法核实工作区目录。',
  conversation_not_ready: '对话尚未就绪，请等待状态核实。', operation_needs_reconciliation: '上一项操作尚未核实，请先查询结果。',
  operation_conflict: '操作编号与内容不一致；已保留输入。', configuration_unavailable: '所选配置暂时不可用，请刷新后重试。',
  operation_id_conflict: '操作编号与原内容不一致，请刷新后重试。',
  queue_entry_changed: '这条排队消息已变化，请查看最新队列。',
  queue_mode_unavailable: '此对话暂时无法使用该发送方式。', queue_full: '队列已满，请先处理已排队的消息。',
  active_conversation_limit: '当前观察的运行中对话较多，请稍后再试。', invalid_request: '输入未被接受，请检查内容与长度。',
  file_reference_unavailable: '引用文件已删除或无法读取，请重新选择；输入已保留。', file_reference_forbidden: '该文件不在可引用的工作区范围内。',
  quote_source_changed: '引用的原消息无法读取，请重新选择。', image_unavailable: '图片暂时无法读取，请重新添加；文字和引用已保留。',
  image_reference_changed: '图片引用已变化，请重新添加。', message_images_too_large: '这一条消息的图片合计超过 4 MiB，请减少图片后再发送。',
  skill_reference_unavailable: '无法核对所选技能。输入已保留，请重新选择技能或移除该引用。',
  queue_skill_requires_next_turn: '带技能的消息将在下一轮派发，已保留在队列中。',
};
const stateReasons: Record<string, string> = {
  workspace_execution_blocked: failures.workspace_execution_blocked!,
  workspace_removed: failures.workspace_removed!,
  workspace_directory_changed: failures.workspace_directory_changed!,
  workspace_directory_unavailable: failures.workspace_directory_unavailable!,
  workspace_identity_unavailable: failures.workspace_identity_unavailable!,
  workspace_restore_pending: '正在核对原生会话，核对后可以继续对话。',
  conversation_configuration_changed: '这段对话的工作区或原生服务配置已变化，需要管理员核对后才能继续。',
  conversation_preparation_incomplete: '原生对话尚未准备完成；已有绑定已保留。',
  native_creation_result_unknown: '应用在创建过程中中断，创建结果仍待核实。',
  native_configuration_unverified: '还无法核实这段对话的模型与权限配置。',
  history_gap_limit: '离线期间产生的历史较多，本次尚未补齐，请再次查询原生结果。',
  native_history_diverged: '原生历史与已保存内容存在差异，需要核对后继续。',
  native_receipt_unknown: '原生接收结果暂时无法确认，本次操作不会自动重发。',
  native_run_changed: '当前运行已经变化，请先刷新状态。',
};
const explain = (value: string) => stateReasons[value] ?? (/^[a-z0-9_]+$/.test(value) ? '暂时无法核对原生状态；已有内容保留，任务不会自动重发。' : value);
type PageItem = WorkbenchItem & { turnFiles?: TurnFileSummary };
type ReaderTarget = { conversationId: string; runId: string; workspaceId: string; path: string };
const mergeItems = (older: PageItem[], newer: PageItem[]): PageItem[] => {
  const incoming = new Map(newer.map(item => [item.id, item]));
  return [...older.filter(item => !incoming.has(item.id)), ...newer];
};
// Bound both the number of DOM entries and retained UTF-16 text, including long replies.
const itemWeight = (item: PageItem) => JSON.stringify(item).length * 2 + 1024;
const fitsWindow = (items: PageItem[]) => items.length <= 500 && items.reduce((bytes, item) => bytes + itemWeight(item), 0) <= 8 * 1024 * 1024;
const boundedPage = (items: WorkbenchItem[], turnFiles: TurnFileSummary[] = []): PageItem[] => {
  const summaries = new Map(turnFiles.map(summary => [summary.runId, summary]));
  const page: PageItem[] = [];
  let bytes = 0; let start = items.length;
  while (start > 0 && items.length - start < 500) {
    const item = items[start - 1]!;
    const summary = item.runId ? summaries.get(item.runId) : undefined;
    const next = summary ? { ...item, turnFiles: summary } : item;
    bytes += itemWeight(next);
    if (bytes > 8 * 1024 * 1024) break;
    if (summary) summaries.delete(summary.runId);
    page.push(next);
    start--;
  }
  return page.reverse();
};

export function WorkbenchView({ csrf, logout, expired, busy, authError }: { csrf: string; logout(): void; expired(): void; busy: boolean; authError: string }) {
  const [configuration, setConfiguration] = useState<WorkbenchConfiguration>();
  const [workspaceAction, setWorkspaceAction] = useState<WorkspaceAction>();
  const [managingPlugins, setManagingPlugins] = useState(false);
  const [listRevision, refreshList] = useState(0);
  const sidebarWidth = useSidebarWidth();
  const [reader, setReader] = useState(false);
  const [workspaceStatus, setWorkspaceStatus] = useState<{ id: string; value?: WorkspaceEditStatus }>();
  const [readerExpanded, setReaderExpanded] = useState(false);
  const [readerTarget, setReaderTarget] = useState<ReaderTarget>();
  const [unavailableFiles, setUnavailableFiles] = useState<ReadonlySet<string>>(new Set());
  const readerOrigin = useRef<{ button: HTMLButtonElement; row: HTMLLIElement | null }>(null);
  const [selected, setSelected] = useState<string | undefined>(() => /^#[0-9a-f-]{36}$/i.test(location.hash) ? location.hash.slice(1) : undefined);
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>();
  const [items, setItems] = useState<PageItem[]>([]);
  const [draft, setDraft] = useState<Draft>({ text: '' });
  const [creating, setCreating] = useState<string | true>();
  const [pickingFile, setPickingFile] = useState(false);
  const [navigation, setNavigation] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [connection, setConnection] = useState('正在连接');
  const [moreOutput, setMoreOutput] = useState(false);
  const [before, setBefore] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [windowed, setWindowed] = useState(false);
  const windowedRef = useRef(windowed); windowedRef.current = windowed;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const draftRef = useRef(draft); draftRef.current = draft;
  const generation = useRef(0);
  const requestSerial = useRef(0);
  const configurationSerial = useRef(0);
  const activeRead = useRef<{ id: string; generation: number; dirty: boolean; latest: boolean; task: Promise<void> } | undefined>(undefined);
  const viewController = useRef<AbortController | undefined>(undefined);
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const sendingRef = useRef(false);
  const alive = useRef(true);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const report = useCallback((reason: unknown) => {
    if (!alive.current || (reason instanceof DOMException && reason.name === 'AbortError')) return;
    if (reason instanceof RequestError && reason.status === 401) { expired(); return; }
    setError(reason instanceof RequestError ? failures[reason.code] ?? '暂时无法确认结果。输入和已有内容仍保留，请重新连接。' : '连接暂时中断。输入和已有内容仍保留，请重试。');
  }, [expired]);
  const refreshConfiguration = () => {
    const serial = ++configurationSerial.current;
    void request('/configuration', workbenchConfigurationSchema).then(value => {
      if (alive.current && serial === configurationSerial.current) setConfiguration(value);
    }).catch(reason => { if (serial === configurationSerial.current) report(reason); });
  };
  const configurationRefresh = useRef(refreshConfiguration); configurationRefresh.current = refreshConfiguration;
  const load = async (id: string, latest = false) => {
    const gen = generation.current;
    const running = activeRead.current;
    if (running && running.id === id && running.generation === gen) { running.dirty = true; running.latest ||= latest; return running.task; }
    const job = { id, generation: gen, dirty: false, latest: false, task: Promise.resolve() };
    activeRead.current = job;
    job.task = (async () => {
    const serial = ++requestSerial.current;
    try {
      const result = await request(`/conversations/${id}`, snapshotSchema, { signal: viewController.current?.signal });
      if (!alive.current || gen !== generation.current || serial !== requestSerial.current || id !== selectedRef.current) return;
      if (snapshotRef.current && result.revision < snapshotRef.current.revision) return;
      const first = !snapshotRef.current || snapshotRef.current.conversation.id !== id;
      const pageItems = boundedPage(result.history.items, result.turnFiles);
      const pageTrimmed = pageItems.length < result.history.items.length;
      const pageBefore = pageTrimmed ? pageItems[0]?.id ?? null : result.history.olderBeforeItemId ?? pageItems[0]?.id ?? null;
      setSnapshot({ ...result, history: { ...result.history, items: pageItems } });
      setItems(previous => {
        if (latest || first) return pageItems;
        if (windowedRef.current) return previous;
        const merged = mergeItems(previous, pageItems);
        const next = fitsWindow(merged) ? merged : pageItems;
        // Pagination belongs to the displayed left edge. Keep an earlier loaded
        // anchor only while those earlier items remain in the current window.
        if (next[0]?.id === pageItems[0]?.id) { setBefore(pageBefore); setHasOlder(pageTrimmed || result.history.hasOlder); }
        return next;
      });
      if (latest || first) { setBefore(pageBefore); setHasOlder(pageTrimmed || result.history.hasOlder); setWindowed(false); }
      const pending = draftRef.current.pending;
      if (pending && !pending.queued) {
        const operation = result.operations.find(op => op.id === pending.id);
        if (operation?.status === 'accepted') {
          setDraft(current => { const { pending: _pending, ...editable } = current; const next = sameInput(editable, pending) ? { text: '' } : editable; saveDraft(id, next); return next; });
          setError('');
        } else if (operation?.status === 'rejected') setError(operation.reason ? failures[operation.reason] ?? operation.reason : '本次发送未被接受，输入已保留。');
      }
    } catch (reason) { if (gen === generation.current) report(reason); }
    })().finally(() => {
      if (activeRead.current === job) activeRead.current = undefined;
      if (job.dirty && alive.current && generation.current === gen && selectedRef.current === id) {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => { refreshTimer.current = undefined; void loadRef.current(id, job.latest); }, 180);
      }
    });
    return job.task;
  };
  const loadRef = useRef(load); loadRef.current = load;
  const scheduleRefresh = (id?: string, refreshNavigation = true) => {
    if (refreshNavigation && !listTimer.current) listTimer.current = setTimeout(() => { listTimer.current = undefined; refreshList(value => value + 1); }, 700);
    if (id && id !== selectedRef.current) return;
    if (!refreshTimer.current) refreshTimer.current = setTimeout(() => { refreshTimer.current = undefined; if (selectedRef.current) void loadRef.current(selectedRef.current); }, 180);
  };
  useEffect(() => {
    alive.current = true;
    configurationRefresh.current();
    return () => { alive.current = false; configurationSerial.current++; generation.current++; viewController.current?.abort(); if (refreshTimer.current) clearTimeout(refreshTimer.current); if (listTimer.current) clearTimeout(listTimer.current); };
  }, []);
  useEffect(() => {
    generation.current++; requestSerial.current++; viewController.current?.abort(); viewController.current = new AbortController();
    setSnapshot(undefined); snapshotRef.current = undefined; setItems([]); setUnavailableFiles(new Set()); setError(''); setMoreOutput(false); setWindowed(false); setBefore(null); setHasOlder(false); atBottom.current = true;
    const next = selected ? readDraft(selected) : { text: '' }; draftRef.current = next; setDraft(next);
    if (selected) void loadRef.current(selected, true);
    return () => viewController.current?.abort();
  }, [selected]);
  useEffect(() => {
    let source: EventSource | undefined; let timer: ReturnType<typeof setTimeout> | undefined; let heartbeat: ReturnType<typeof setInterval> | undefined;
    let stopped = false; let cursor = 0; let delay = 500; let lastMessage = Date.now();
    const reconnect = () => {
      source?.close(); source = undefined; if (timer) clearTimeout(timer);
      if (stopped) return;
      setConnection(navigator.onLine ? '正在恢复连接' : '离线 · 工作在远端继续');
      const jitter = crypto.getRandomValues(new Uint16Array(1))[0]! / 65535 * 200;
      timer = setTimeout(connect, delay + jitter); delay = Math.min(delay * 2, 8000);
    };
    const connect = () => {
      if (stopped) return;
      source?.close(); source = new EventSource(`/api/private/workbench/events?cursor=${cursor}`); lastMessage = Date.now();
      const own = source;
      source.addEventListener('ready', () => { if (source !== own || stopped) return; delay = 500; lastMessage = Date.now(); setConnection('已连接'); scheduleRefresh(); configurationRefresh.current(); });
      source.addEventListener('heartbeat', () => { if (source === own && !stopped) lastMessage = Date.now(); });
      source.addEventListener('change', event => {
        if (source !== own || stopped) return;
        lastMessage = Date.now();
        try {
          const change = changeEventSchema.parse(JSON.parse((event as MessageEvent).data));
          if (change.revision <= cursor) return; cursor = change.revision;
          if (change.item && change.conversationId === selectedRef.current) {
            const item = change.item;
            setSnapshot(current => current ? { ...current, history: { ...current.history, liveItems: [...current.history.liveItems.filter(old => old.id !== item.id), item].slice(-100) } } : current);
          }
          // History snapshots reconcile live and durable identities; this also catches missed terminal events.
          scheduleRefresh(change.conversationId, !change.item);
        } catch { cursor = 0; reconnect(); }
      });
      source.addEventListener('reset', event => { if (source !== own || stopped) return; try { cursor = resetEventSchema.parse(JSON.parse((event as MessageEvent).data)).revision; scheduleRefresh(); } catch { cursor = 0; reconnect(); } });
      source.onerror = () => { if (source !== own || stopped) return; reconnect(); void fetch('/api/session', { cache: 'no-store', signal: AbortSignal.timeout(8000) }).then(async response => { const value = sessionSchema.parse(await response.json()); if (!stopped && value.authenticated === false) expired(); }).catch(() => {}); };
    };
    const restore = () => { if (document.visibilityState === 'visible') { delay = 500; if (timer) clearTimeout(timer); connect(); scheduleRefresh(); } };
    window.addEventListener('online', restore); document.addEventListener('visibilitychange', restore); window.addEventListener('pageshow', restore);
    connect(); heartbeat = setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - lastMessage > 20_000) reconnect(); }, 5000);
    return () => { stopped = true; source?.close(); if (timer) clearTimeout(timer); if (heartbeat) clearInterval(heartbeat); window.removeEventListener('online', restore); document.removeEventListener('visibilitychange', restore); window.removeEventListener('pageshow', restore); };
  }, [csrf]);
  useLayoutEffect(() => {
    const node = scroll.current; if (!node) return;
    if (anchor.current) { node.scrollTop = anchor.current.top + node.scrollHeight - anchor.current.height; anchor.current = null; }
    else if (atBottom.current) { node.scrollTop = node.scrollHeight; setMoreOutput(false); }
    else setMoreOutput(true);
  }, [items, snapshot?.history.liveItems]);
  const choose = useCallback((id: string) => { history.replaceState(null, '', `#${id}`); setSelected(id); setManagingPlugins(false); setNavigation(false); }, []);
  const createInWorkspace = useCallback((id: string) => { setCreating(id); setNavigation(false); }, []);
  const refreshNavigation = useCallback(() => {
    refreshList(value => value + 1);
    if (selectedRef.current) void loadRef.current(selectedRef.current);
  }, []);
  const updateDraft = useCallback((next: Draft, requireDurable = false): boolean => {
    if (!selected) return false;
    const saved = saveDraft(selected, next);
    if (!saved) setError('浏览器无法保留草稿，请先复制输入。');
    // Storage denial must not erase newly typed text. Uploaded files stay in
    // IndexedDB until their metadata can be retained durably in the draft.
    if (saved || !requireDurable) { setDraft(next); draftRef.current = next; }
    return saved;
  }, [selected]);
  const send = async () => {
    if (!selected || sendingRef.current || (!draft.text.trim() && !draft.images?.length && !draft.references?.length && !draft.pending)) return;
    const id = selected; const gen = generation.current;
    const operation: NonNullable<Draft['pending']> = draft.pending ?? {
      id: crypto.randomUUID(), text: draft.text, ...(draft.images?.length ? { images: draft.images } : {}),
      ...(draft.references?.length ? { references: draft.references } : {}), ...(draft.skills?.length ? { skills: draft.skills } : {}), ...(queueing ? { queued: true } : {}),
    };
    const { id: _operationId, queued, ...payload } = operation;
    const body = queued ? { action: 'add', entryId: operation.id, content: payload } : { id: operation.id, type: 'message', payload };
    if (new TextEncoder().encode(JSON.stringify(body)).length > 60 * 1024) { setError('输入编码后较长，请减少内容再发送；本次尚未发送。'); return; }
    const next = { ...draft, pending: operation };
    if (!saveDraft(id, next)) { setError('浏览器无法保留本次发送编号，本次尚未发送。请保留输入后重新打开页面。'); return; }
    setDraft(next); draftRef.current = next;
    sendingRef.current = true; setSending(true); setError('');
    try {
      let result;
      if (queued) await request(`/conversations/${id}/queue`, queueViewSchema, { csrf, body });
      else result = await request(`/conversations/${id}/operations`, operationResponseSchema, { csrf, body });
      if (!alive.current || gen !== generation.current) return;
      if (queued || result?.operation.status === 'accepted') {
        setDraft(current => { const { pending: _pending, ...editable } = current; const clean = sameInput(editable, operation) ? { text: '' } : editable; saveDraft(id, clean); return clean; });
      } else if (result && ['unknown', 'rejected'].includes(result.operation.status)) {
        const reason = result.operation.reason;
        setError(reason ? failures[reason] ?? reason : '操作结果待核实。');
      }
      atBottom.current = true; await load(id);
    } catch (reason) {
      if (gen === generation.current && reason instanceof RequestError && ([400, 413].includes(reason.status) || ['conversation_archived','workspace_save_in_progress','workspace_execution_blocked','workspace_removed','workspace_remove_busy','workspace_directory_changed','workspace_directory_unavailable','workspace_identity_unavailable','operation_needs_reconciliation','file_reference_unavailable','file_reference_forbidden','quote_source_changed','image_reference_changed','image_unavailable','queue_full','queue_mode_unavailable'].includes(reason.code))) {
        setDraft(current => { const { pending: _pending, ...editable } = current; saveDraft(id, editable); return editable; });
      }
      report(reason);
    }
    finally { sendingRef.current = false; if (alive.current) setSending(false); }
  };
  const changeQueue = async (command: QueueCommand): Promise<boolean> => {
    if (!selected || sendingRef.current) return false;
    const id = selected; const gen = generation.current;
    sendingRef.current = true; setSending(true); setError('');
    try {
      await request(`/conversations/${id}/queue`, queueViewSchema, { csrf, body: command });
      return generation.current === gen;
    } catch (reason) {
      if (generation.current === gen) report(reason);
      return false;
    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
      if (generation.current === gen) scheduleRefresh(id);
    }
  };
  const stop = async () => {
    const conversation = snapshot?.conversation; if (!conversation?.state.runId || sendingRef.current) return;
    sendingRef.current = true; setSending(true);
    try { await request(`/conversations/${conversation.id}/operations`, operationResponseSchema, { csrf, body: { id: crypto.randomUUID(), type: 'stop', payload: { runId: conversation.state.runId } } }); scheduleRefresh(conversation.id); }
    catch (reason) { report(reason); }
    finally { sendingRef.current = false; if (alive.current) setSending(false); }
  };
  const reconcile = async () => {
    if (!selected) return;
    try { await request(`/conversations/${selected}/reconcile`, snapshotSchema, { csrf, body: {} }); await load(selected); setError(''); }
    catch (reason) { report(reason); }
  };
  const older = async () => {
    if (!selected || !before || loadingOlder) return;
    const id = selected; const gen = generation.current; setLoadingOlder(true);
    try {
      const result = await request(`/conversations/${id}/older?beforeItemId=${encodeURIComponent(before)}`, snapshotSchema, { signal: viewController.current?.signal });
      if (!alive.current || gen !== generation.current) return;
      const pageItems = boundedPage(result.history.items, result.turnFiles);
      if (!pageItems.length) {
        setHasOlder(result.history.hasOlder);
        setSnapshot(current => current ? { ...current, archive: result.archive } : current);
        return;
      }
      if (scroll.current) anchor.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop };
      atBottom.current = false;
      const trimmed = pageItems.length < result.history.items.length;
      setItems(current => { const merged = mergeItems(pageItems, current); if (!fitsWindow(merged)) { anchor.current = null; setWindowed(true); return pageItems; } return merged; });
      setBefore(trimmed ? pageItems[0]?.id ?? null : result.history.olderBeforeItemId ?? pageItems[0]?.id ?? null); setHasOlder(trimmed || result.history.hasOlder);
    } catch (reason) { report(reason); }
    finally { if (alive.current) setLoadingOlder(false); }
  };
  const conversation = snapshot?.conversation;
  const editingWorkspace = workspaceStatus?.id === conversation?.workspaceId && !!workspaceStatus?.value?.windowId && workspaceStatus.value.maintenance !== 'online';
  const [selectedWorkspace, setSelectedWorkspace] = useState<(WorkbenchConfiguration['workspaces'][number] & { removed: boolean }) | null>(null);
  useEffect(() => {
    const id = conversation?.workspaceId;
    setSelectedWorkspace(null);
    if (!id) return;
    const active = configuration?.workspaces.find(value => value.id === id);
    const removed = configuration?.removedWorkspaces?.find(value => value.id === id);
    if (active || removed) { setSelectedWorkspace({ ...(active ?? removed!), removed: !!removed }); return; }
    const controller = new AbortController();
    void request(`/workspaces/${encodeURIComponent(id)}`, workspaceLookupSchema, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setSelectedWorkspace(value.workspace); }).catch(() => {});
    return () => controller.abort();
  }, [conversation?.workspaceId, configuration]);
  const unresolved = snapshot?.operationState?.unresolved ?? snapshot?.operations.some(op => ['queued', 'dispatching', 'unknown'].includes(op.status));
  const latestMessage = snapshot?.operationState ? snapshot.operationState.latestAcceptedMessage : snapshot?.operations.find(op => op.type === 'message' && op.status === 'accepted');
  const rejectedDraft = draft.pending && snapshot?.operations.find(op => op.id === draft.pending!.id)?.status === 'rejected';
  const previousMessageSettled = !latestMessage || (latestMessage.runId !== null && (latestMessage.runId === conversation?.state.runId || latestMessage.runId === conversation?.state.terminalRunId));
  const removedWorkspace = configuration?.removedWorkspaces?.find(workspace => workspace.id === conversation?.workspaceId) ?? (selectedWorkspace?.removed ? selectedWorkspace : undefined);
  const workspaceRemoved = !!removedWorkspace || conversation?.error === 'workspace_removed';
  const running = !!conversation?.state.runId && ['running', 'waiting'].includes(conversation.state.status);
  const queue = snapshot?.queue;
  const queueing = !!(draft.pending ? draft.pending.queued : queue?.mode && (running || queue.entries.length));
  const usable = !workspaceRemoved && !conversation?.archived && conversation?.readiness === 'ready' && conversation.state.configurationVerified;
  const ready = usable && (queueing || (['idle', 'interrupted', 'failed'].includes(conversation.state.status) && !conversation.state.pendingInputs && !unresolved && previousMessageSettled));
  const lastEarly = snapshot?.operations.find(op => op.delivery && op.delivery.mode !== 'next' && op.status === 'accepted' && op.runId);
  const liveItems = snapshot?.history.liveItems;
  const visible = useMemo(() => {
    const live = windowed ? [] : liveItems?.filter(item => !items.some(saved => saved.id === item.id && saved.status !== 'running')) ?? [];
    return items.map(item => live.find(current => current.id === item.id) ?? item)
      .concat(live.filter(item => !items.some(saved => saved.id === item.id)));
  }, [items, liveItems, windowed]);
  const turnFiles = useMemo(() => {
    const summaries = new Map<string, TurnFileSummary>();
    for (const item of items) if (item.turnFiles) summaries.set(item.turnFiles.runId, item.turnFiles);
    if (!windowed) for (const summary of snapshot?.turnFiles ?? []) summaries.set(summary.runId, summary);
    return summaries;
  }, [items, snapshot?.turnFiles, windowed]);
  function openTurnFile(runId: string, path: string, button: HTMLButtonElement) {
    if (!conversation || workspaceRemoved || conversation.id !== selected) return;
    readerOrigin.current = { button, row: button.closest('li') };
    setReaderTarget({ conversationId: conversation.id, runId, workspaceId: conversation.workspaceId, path });
    setReader(true);
  }
  function closeReader() {
    const origin = readerOrigin.current;
    readerOrigin.current = null;
    setReader(false);
    setReaderExpanded(false);
    setReaderTarget(undefined);
    if (origin) requestAnimationFrame(() => {
      if (origin.button.isConnected) origin.button.focus({ preventScroll: true });
      else origin.row?.focus({ preventScroll: true });
    });
  }
  const quote = useCallback((reference: MessageReference) => {
    if (draft.pending) { setError('请先核对上次发送，或继续编辑后再添加引用。'); return; }
    updateDraft({ ...draft, references: [...(draft.references ?? []), reference].slice(0,8) });
  }, [draft, updateDraft]);
  const permission = configuration?.harnesses.find(h => h.id === conversation?.harnessId)?.permissions.find(p => p.id === conversation?.configuration.permissionId);
  return <><WorkbenchFrame style={sidebarWidth.style} navigationOpen={navigation} onNavigationChange={setNavigation}
    sidebar={<>
      <div className="workbench-brand"><BrandMark/><span>中书</span><IconButton className="mobile-only" label="关闭导航" onClick={() => setNavigation(false)}><X size={17}/></IconButton></div>
      <Button className="new-conversation" onClick={() => { setCreating(true); setNavigation(false); }}><Plus size={16}/>新对话</Button>
      <ConversationNavigation workspaces={configuration?.workspaces} removedWorkspaces={configuration?.removedWorkspaces}
        workspaceCursor={configuration?.workspaceCursor} removedWorkspaceCursor={configuration?.removedWorkspaceCursor}
        canAddWorkspace={!!configuration?.workspaceRoots?.length} workspaceAction={action => { setNavigation(false); setWorkspaceAction(action); }} selected={selected} revision={listRevision} csrf={csrf}
        choose={choose} create={createInWorkspace} stateLabel={stateLabel} report={report}
        changed={refreshNavigation} />
      {sidebarWidth.separator}
      <div className="sidebar-bottom">
        <StorageNotice/>
        <button className="sidebar-files" aria-current={managingPlugins ? 'page' : undefined} onClick={() => { setManagingPlugins(true); setReader(false); setNavigation(false); }}><Puzzle size={16}/><span>插件管理</span><ChevronRight size={13}/></button>
        <button className="sidebar-files" aria-expanded={reader} disabled={!configuration?.workspaces.length} onClick={() => { setReader(true); setNavigation(false); }}><FolderOpen size={16}/><span>工作区文件</span><ChevronRight size={13}/></button>
        <div className="sidebar-account"><span className="network" role="status"><span className="network-dot"/>{connection}</span><IconButton label="退出登录" onClick={logout} disabled={busy}><LogOut size={15}/></IconButton></div>
      </div>
    </>}
    header={managingPlugins ? <><div className="conversation-heading"><p>工作台 / 插件</p></div><Button variant="quiet" onClick={() => setManagingPlugins(false)}>返回工作台</Button></> : <><div className="conversation-heading"><h1>{conversation?.title ?? (selected ? '正在恢复对话…' : '从这里，接着做。')}</h1><p>{conversation ? `${conversation.harnessId === 'codex' ? 'Codex' : 'DSH'} · ${removedWorkspace?.label ?? selectedWorkspace?.label ?? configuration?.workspaces.find(w => w.id === conversation.workspaceId)?.label ?? '工作区'} · ${workspaceRemoved ? '工作区已移除' : stateLabel(conversation)}` : '一段对话，一个可以接续的工作现场'}</p></div><div className="header-actions"><IconButton label="打开工作区文件" disabled={!configuration?.workspaces.length} onClick={() => setReader(true)}><FolderOpen size={17}/></IconButton><IconButton label="重新连接" onClick={() => { scheduleRefresh(); refreshConfiguration(); }}><RefreshCw size={15}/></IconButton></div></>}
    reader={!managingPlugins && reader && configuration && <Suspense fallback={<p role="status">正在打开文件…</p>}><WorkspaceReader workspaces={configuration.workspaces} workspaceCursor={configuration.workspaceCursor} initialWorkspace={conversation?.workspaceId}
      target={readerTarget} onTargetUnavailable={target => {
        if (target === readerTarget && readerTarget.conversationId === selectedRef.current)
          setUnavailableFiles(previous => {
            // These are transient display hints, not file availability facts.
            // History window eviction must not leave an ever-growing error cache.
            const key = JSON.stringify([readerTarget.runId, target.path]);
            const next = new Set(previous); next.delete(key); next.add(key);
            let bytes = [...next].reduce((total, value) => total + value.length * 2, 0);
            for (const oldest of next) {
              if (next.size <= 256 && bytes <= 64 * 1024) break;
              next.delete(oldest); bytes -= oldest.length * 2;
            }
            return next;
          });
      }}
      csrf={csrf} editStatusSignal={JSON.stringify([conversation?.id, conversation?.state.status, conversation?.state.pendingInputs, unresolved])} expanded={readerExpanded} onExpand={setReaderExpanded} onClose={closeReader}/></Suspense>}>

      {managingPlugins ? <PluginManagement csrf={csrf} report={report}/> : !selected ? <section className="empty-workbench"><p className="eyebrow">A PLACE TO CONTINUE</p><h2>把想法，往前推进一步。</h2><p>选择一个工作区和 Agent，开始一件具体的工作。<br />离开页面后，可以回来继续。</p><button onClick={() => setCreating(true)}>开始新对话 ↗</button>{configuration?.workspaces.length === 0 && <p className="quiet">工作区与原生服务尚未由管理员连接。</p>}</section> : <>
        <div className="message-scroll" ref={scroll} onScroll={() => { const node = scroll.current!; atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; if (atBottom.current) setMoreOutput(false); }}>
          <div className="message-column">
            {hasOlder && <button className="load-history" disabled={loadingOlder} onClick={() => void older()}>{loadingOlder ? '正在读取…' : '查看更早的内容'}</button>}
            {windowed && <p className="history-note">正在阅读较早的一页。<button className="text-button" onClick={() => { if (selected) { atBottom.current = true; void load(selected, true); } }}>回到最新内容</button></p>}
            {!snapshot && <p role="status" className="quiet">正在核对远端状态与历史…</p>}
            {snapshot && visible.length === 0 && <p className="quiet conversation-start">{conversation?.readiness === 'ready' ? '对话已准备好。说说你希望完成什么。' : '正在准备原生会话…'}</p>}
            {snapshot?.archive && <p className="history-note" role="status">{[snapshot.archive.latest?.error, snapshot.archive.backfill?.error].some(error => error === 'archive_source_gap' || error === 'archive_continuity_unverified')
              ? '原生历史已变化，旧范围的连续性尚未确认。已保存正文仍可阅读，后台继续补齐当前可获取的内容。'
              : snapshot.archive.latest?.error === 'archive_items_pending' || snapshot.archive.backfill?.error === 'archive_items_pending' ? '后台正在核对尚未完整存档的图文，已保存内容仍可阅读。'
              : snapshot.archive.latest?.error || snapshot.archive.backfill?.error ? '历史存档暂时未能继续，已保存的正文仍可阅读。'
              : snapshot.archive.backfill?.complete && snapshot.archive.latest?.complete ? '截至最近同步，已保存可获取的历史正文。' : '后台正在补齐历史正文，离开页面后仍会继续。'}
              {snapshot.archive.latest?.lastSuccessAt && <span> 最近同步：<time dateTime={new Date(snapshot.archive.latest.lastSuccessAt).toISOString()}>{new Date(snapshot.archive.latest.lastSuccessAt).toLocaleString()}</time></span>}</p>}
            <Transcript items={visible} conversation={selected} onQuote={quote} turnFiles={turnFiles}
              activeRun={running ? conversation?.state.runId : undefined} activeFile={readerTarget?.conversationId === selected ? readerTarget : undefined}
              workspaceUnavailable={workspaceRemoved} unavailableFiles={unavailableFiles} onOpenFile={openTurnFile}/>
          </div>
        </div>
        <div className="composer-region">
          {!reader && conversation && !workspaceRemoved && <WorkspaceExecutionStatus key={conversation.workspaceId} workspace={conversation.workspaceId} csrf={csrf} observed={(id, value) => setWorkspaceStatus({ id, value })} changed={() => { scheduleRefresh(); }}/>}
          {moreOutput && <button className="new-output" onClick={() => { atBottom.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setMoreOutput(false); }}>↓ 有新内容</button>}
          {(conversation?.error || conversation?.state.reason) && !editingWorkspace && <p className="state-notice">{explain(conversation.error ?? conversation.state.reason!)}</p>}
          {conversation?.state.status === 'interrupted' && <p className="state-notice">本轮已中断。此前启动的后台工具可能仍在运行，已经产生的改动不会撤销。</p>}
          {snapshot?.history.liveItemsLimited && <p className="state-notice">部分实时输出较长，将在完成后从历史中读取完整内容。</p>}
          {!!conversation?.state.pendingInputs && <p className="state-notice">原生服务仍保留 {conversation.state.pendingInputs} 项待处理输入。停止当前轮不会清空它们。</p>}
          {!workspaceRemoved && !editingWorkspace && (unresolved || conversation?.state.status === 'unknown' || !previousMessageSettled) && <div className="state-notice">{!previousMessageSettled ? '正在核对上一条消息对应轮次的执行结果。' : '正在核对执行结果。'}<button className="text-button" onClick={() => void reconcile()}>查询原生结果</button></div>}
          {removedWorkspace && <button className="text-button" onClick={() => setWorkspaceAction({ kind: 'restore', workspace: removedWorkspace })}>恢复工作区</button>}
          {conversation?.archived && <p className="state-notice">这段对话已归档。可在侧栏恢复后继续。</p>}
          {lastEarly?.delivery && lastEarly.delivery.mode !== 'next' && <div className="state-notice" role="status">
            <span>{lastEarly.runId === lastEarly.delivery.target ? '提前发送的消息已送达目标轮。' : '提前发送的消息已送达后续轮。'}</span>
            {visible.some(item => item.operationId === lastEarly.id) && <button type="button" className="text-button" onClick={() => {
              const item = visible.find(value => value.operationId === lastEarly.id);
              if (item) scroll.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(item.id)}"]`)?.focus();
            }}>查看消息</button>}
          </div>}
          {!workspaceRemoved && !conversation?.archived && draft.pending && <div className="state-notice">{rejectedDraft ? '上次发送未被接受，原始输入已保留。' : '上次发送尚未确认，原始输入已保留。'}<button className="text-button" disabled={sending} onClick={() => { if (rejectedDraft && selected) { const { pending: _pending, ...next } = draft; setDraft(next); saveDraft(selected, next); } else void send(); }}>{rejectedDraft ? '继续编辑' : '核对同一发送'}</button></div>}
          {!workspaceRemoved && !conversation?.archived && <Composer key={selected} conversation={selected} csrf={csrf} draft={draft} onChange={updateDraft}
            onSend={() => { if (ready || draft.pending) void send(); }} onStop={() => void stop()} onFiles={() => setPickingFile(true)}
            ready={ready} sending={sending} running={running} queueing={queueing}
            skillsEnabled={conversation?.id === selected && !!usable} usage={conversation?.id === selected ? snapshot?.usage : undefined}
            queue={queue && <InputQueue queue={queue} busy={sending}
              onRead={(entryId, version, signal) => request(`/conversations/${selected}/queue/${entryId}?version=${version}`, queueEntrySchema, { signal })}
              target={running && usable && !unresolved ? conversation.state.runId : undefined} canResume={!!usable && !unresolved} onCommand={changeQueue}/>}
            permission={conversation?.state.configurationVerified ? permission?.label ?? '配置按对话固定' : '配置待核实'}
            configurationNote={conversation?.state.configurationVerified ? permission?.description ?? '配置在本对话中保持不变。' : '正在核实当前对话的原生配置，核实后可继续工作。'}
            model={configuration?.harnesses.find(h => h.id === conversation?.harnessId)?.models.find(m => m.id === conversation?.configuration.modelId)?.label ?? '配置按对话固定'}/>}
        </div>
      </>}
      {(error || authError) && <div className="workbench-error" role="alert"><span>{error || authError}</span><button className="text-button" onClick={() => setError('')}>关闭</button></div>}
    </WorkbenchFrame>
    {creating && <CreateConversation configuration={configuration} csrf={csrf} initialWorkspace={typeof creating === 'string' ? creating : undefined} onClose={() => setCreating(undefined)} onCreated={c => { setCreating(undefined); refreshList(value => value + 1); choose(c.id); }} onError={report} />}
    {pickingFile && selected && !workspaceRemoved && <FilePicker conversation={selected} onClose={() => setPickingFile(false)} onSelect={(reference: MessageReference) => { const next = { ...draft, text: draft.text.endsWith('@') ? draft.text.slice(0,-1) : draft.text, references: [...(draft.references ?? []), reference].slice(0,8) }; updateDraft(next); }}/ >}
    {workspaceAction && <WorkspaceManagement action={workspaceAction} roots={configuration?.workspaceRoots ?? []} csrf={csrf}
      close={() => setWorkspaceAction(undefined)} changed={() => { refreshConfiguration(); refreshNavigation(); }} report={report} />}
  </>;
}

function CreateConversation({ configuration, initialWorkspace, csrf, onClose, onCreated, onError }: { configuration?: WorkbenchConfiguration; initialWorkspace?: string; csrf: string; onClose(): void; onCreated(c: Conversation): void; onError(reason: unknown): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [harness, setHarness] = useState<'codex' | 'dsh'>(configuration?.harnesses.find(h => h.available)?.id ?? 'codex');
  const catalog = configuration?.harnesses.find(h => h.id === harness);
  const [workspace, setWorkspace] = useState(initialWorkspace ?? configuration?.workspaces[0]?.id ?? '');
  const [model, setModel] = useState(catalog?.models[0]?.id ?? '');
  const [permission, setPermission] = useState(catalog?.permissions[0]?.id ?? '');
  const [title, setTitle] = useState(''); const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const submission = useRef<unknown>(undefined);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    if (submission.current) return;
    setModel(current => catalog?.models.some(value => value.id === current) ? current : catalog?.models[0]?.id ?? '');
    setPermission(current => catalog?.permissions.some(value => value.id === current) ? current : catalog?.permissions[0]?.id ?? '');
    setWorkspace(current => current || configuration?.workspaces[0]?.id || '');
  }, [catalog, configuration]);
  const create = async () => {
    if (busy) return; setBusy(true); setFailed(false);
    submission.current ??= { id: crypto.randomUUID(), harnessId: harness, workspaceId: workspace, configuration: { modelId: model, permissionId: permission }, ...(title.trim() ? { title: title.trim() } : {}) };
    try { const result = await request('/conversations', conversationResponseSchema, { csrf, body: submission.current }); onCreated(result.conversation); }
    catch (reason) { setFailed(true); onError(reason); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="create-dialog" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}><form onSubmit={e => { e.preventDefault(); void create(); }}><header><h2>开始一段新对话</h2><button type="button" className="icon-button" aria-label="关闭新对话" disabled={busy} onClick={onClose}>×</button></header><p className="quiet">选择工作现场，模型和权限会在这段对话中保持不变。</p>
    <fieldset disabled={busy || !!submission.current}><label htmlFor="conversation-title">对话名称</label><input id="conversation-title" maxLength={60} placeholder="这次想完成什么？" value={title} onChange={e => setTitle(e.target.value)} /><label htmlFor="workspace">工作区</label><WorkspaceSelect id="workspace" value={workspace} onChange={setWorkspace} initial={configuration?.workspaces ?? emptyWorkspaces} cursor={configuration?.workspaceCursor}/><label htmlFor="harness">Agent</label><select id="harness" value={harness} onChange={e => setHarness(e.target.value as 'codex' | 'dsh')}>{configuration?.harnesses.map(h => <option key={h.id} value={h.id} disabled={!h.available}>{h.id === 'codex' ? 'Codex' : 'DSH'}{!h.available ? ' · 未连接' : ''}</option>)}</select><label htmlFor="model">模型</label><select id="model" value={model} onChange={e => setModel(e.target.value)}>{catalog?.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select><label htmlFor="permission">权限</label><select id="permission" value={permission} onChange={e => setPermission(e.target.value)}>{catalog?.permissions.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select><p className="quiet permission-note">{catalog?.permissions.find(p => p.id === permission)?.description ?? catalog?.reason}</p></fieldset>
    {failed && <p role="status" className="state-notice">创建结果尚未确认。重试会核对同一个对话编号。</p>}
    <button className="primary" type="submit" disabled={busy || !workspace || !model || !permission || !catalog?.available}>{busy ? '正在创建…' : failed ? '核对创建结果' : '创建对话 ↗'}</button></form></dialog>;
}

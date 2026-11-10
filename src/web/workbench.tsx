import { z } from 'zod';
import { Archive, CalendarDays, FolderOpen, MoreHorizontal, PanelLeft, Pencil, RefreshCw, Search, Settings, SquarePen } from 'lucide-react';
import { Button, IconButton, Kbd, Menu, MenuItem, StatusDot, modifierKey, type StatusKind } from './ui/controls.tsx';
import { WorkbenchFrame, useNarrow } from './patterns/workbench-frame.tsx';
import { ConnectionStatus, SidebarAction, SidebarShell } from './patterns/sidebar.tsx';
import { Toasts, type ToastView } from './patterns/toasts.tsx';
import { conversationStatus, harnessLabel, stateLabel } from './conversation-status.ts';
import { SettingsView, settingsTabs, type SettingsTab } from './settings-view.tsx';
import { ArchiveView } from './archive-view.tsx';
import { ScheduleView, scheduleTabs, type ScheduleTab } from './schedule-view.tsx';
import { AutomationRunBar, AutomationStrip, useAutomations } from './conversation-automations.tsx';
import { AutomationTitles } from './automation-delivery.ts';
import { agentNotificationSchema } from '../shared/automations.ts';
import { WorkbenchSearch, useAttention, type SearchActions } from './workbench-search.tsx';
import { WorkspaceReader } from './workspace-reader.tsx';
import { useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState } from 'react';
import {
  workbenchConfigurationSchema, conversationResponseSchema, operationResponseSchema,
  snapshotSchema, conversationStateSchema, historyPageSchema, changeEventSchema, resetEventSchema, readyEventSchema, heartbeatEventSchema, liveEventSchema, queueViewSchema,
  type WorkbenchConfiguration, type Conversation, type WorkbenchSnapshot, type WorkbenchItem, type QueueCommand, type TurnFileSummary, type LiveCursor, type LiveEvent,
} from '../shared/workbench.ts';
import { applyLiveFrame } from './live-items.ts';
import { adoptFull, applyState } from './snapshot-merge.ts';
import { request, RequestError, readDraft, sameInput, saveDraft, type Draft } from './workbench-client.ts';
import { sessionSchema } from '../shared/http.ts';
import './workbench.css';
import { Transcript, FilePicker } from './conversation-content.tsx';
import { Composer } from './composer.tsx';
import { conversationConfigurationLabel } from './conversation-configuration-label.ts';
import { ConversationNavigation, ManageDialog, useSidebarWidth } from './conversation-navigation.tsx';
import type { MessageReference } from '../shared/content.ts';
import { WorkspaceManagement, type WorkspaceAction } from './workspace-management.tsx';
import { InputQueue } from './input-queue.tsx';
import { NewConversation } from './new-conversation.tsx';
import { storageState, useStorage } from './storage-status.tsx';
import { appendNewer, joinLatest, pageItems, preparePage, prependOlder, touchesWindow, trimOldest, type Page } from './history-window.ts';
import { rememberConversation } from './conversation-preferences.ts';
import { SubagentActivity, SubagentTrigger } from './patterns/subagents.tsx';
import { SubagentPanelHost, subagentDisplays, useSubagentList } from './subagents.tsx';
import { ConversationRequests } from './requests.tsx';
import { PlanArea, PlanToolbarToggle, usePlan } from './plan.tsx';
import { onNotificationOpen, setBadge } from './push-client.ts';
import { navigation as pageHistory, parseRoute, routeHash, useBackDismiss, type Route } from './navigation.ts';
import { AccountBanner, useAccounts } from './harness-accounts.tsx';

const failures: Record<string, string> = {
  conversation_archived: '这段对话已归档，请恢复后继续。',
  workspace_execution_blocked: '工作区正在维护，请先恢复 Agent。',
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
  subagents_running: '仍有子 Agent 在运行或停止结果待核实。请等它们结束或先停止，再归档或删除。',
  subagents_unverified: '暂时无法核对子 Agent 状态，请重新连接后再试。',
  subagent_not_found: '这个子 Agent 不属于当前对话，或已无法读取。',
  storage_budget_reached: '存储已达到预算上限，暂时不能上传图片或新建对话。阅读和发送文字不受影响；可以在「设置 › 存储」中清理。',
  native_history_unavailable: '原生历史暂时无法读取；已加载的内容仍然保留。',
  history_cursor_invalid: '这段历史的位置已经变化，已回到最新内容。',
  native_history_page_limit: '这一页原生内容过大，暂时无法显示。',
  history_no_progress: '原生历史暂时无法继续读取；已加载的内容仍然保留。',
};
const historyNotes: Record<string, string> = {
  native_history_unavailable: '原生暂时不可用：已加载的内容仍然保留，恢复后可以继续阅读。',
  native_history_page_limit: '最新一页原生内容过大，暂时无法显示。',
  conversation_not_ready: '原生会话尚未就绪，暂时没有可读取的历史。',
};
const stateReasons: Record<string, string> = {
  workspace_removed: failures.workspace_removed!,
  workspace_directory_changed: failures.workspace_directory_changed!,
  workspace_directory_unavailable: failures.workspace_directory_unavailable!,
  workspace_identity_unavailable: failures.workspace_identity_unavailable!,
  workspace_restore_pending: '正在核对原生会话，核对后可以继续对话。',
  conversation_configuration_changed: '这段对话的工作区或原生服务配置已变化，需要管理员核对后才能继续。',
  conversation_preparation_incomplete: '原生对话尚未准备完成；已有绑定已保留。',
  native_creation_result_unknown: '应用在创建过程中中断，创建结果仍待核实。',
  native_configuration_unverified: '还无法核实这段对话的模型与权限配置。',
  native_receipt_unknown: '原生接收结果暂时无法确认，本次操作不会自动重发。',
  native_run_changed: '当前运行已经变化，请先刷新状态。',
};
const explain = (value: string) => stateReasons[value] ?? (/^[a-z0-9_]+$/.test(value) ? '暂时无法核对原生状态；已有内容保留，任务不会自动重发。' : value);
/** A file opened from a turn's file list, or from elsewhere (a timeline entry) with no turn behind it. */
type ReaderTarget = { conversationId: string; runId: string; workspaceId: string; path: string } | { conversationId?: undefined; runId?: undefined; workspaceId: string; path: string };

export function WorkbenchView({ csrf, logout, expired, busy, authError }: { csrf: string; logout(): void; expired(): void; busy: boolean; authError: string }) {
  const [configuration, setConfiguration] = useState<WorkbenchConfiguration>();
  const [workspaceAction, setWorkspaceAction] = useState<WorkspaceAction>();
  /** Instance-level pages replace the conversation column; the selected conversation stays selected underneath. */
  /** Every page has its own address (navigation.ts): a conversation, a draft, the schedule, settings or the archive. */
  const opened = useMemo(() => parseRoute(location.hash), []);
  const entry = opened.kind === 'settings' ? opened : undefined;
  const [view, setView] = useState<'settings' | 'archive' | 'schedule' | undefined>(() => entry ? 'settings' : opened.kind === 'schedule' ? 'schedule' : opened.kind === 'archive' ? 'archive' : undefined);
  /** `#schedule` or `#schedule:<tab>` opens the schedule (ADR 0021). */
  const [scheduleTab, setScheduleTab] = useState<ScheduleTab>(() => scheduleTabs.find(tab => opened.kind === 'schedule' && tab.id === opened.tab)?.id ?? 'calendar');
  /** An agent notification to show in place once its conversation is open (`#<conversation>:notice:<id>`). */
  const [pendingNotice, setPendingNotice] = useState<string | undefined>(() => opened.kind === 'conversation' ? opened.notice : undefined);
  const [createFor, setCreateFor] = useState<string>();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => settingsTabs.find(tab => tab.id === entry?.tab)?.id ?? 'workspaces');
  const [searching, setSearching] = useState(false);
  const [managing, setManaging] = useState<Conversation>();
  const [toasts, setToasts] = useState<ToastView[]>([]);
  const [collapsed, setCollapsedState] = useState(() => { try { return localStorage.getItem('zhongshu:sidebar-collapsed') === '1'; } catch { return false; } });
  const setCollapsed = useCallback((next: boolean | ((current: boolean) => boolean)) => setCollapsedState(current => {
    const value = typeof next === 'function' ? next(current) : next;
    try { localStorage.setItem('zhongshu:sidebar-collapsed', value ? '1' : '0'); } catch { /* in-memory only */ }
    return value;
  }), []);
  const [listRevision, refreshList] = useState(0);
  /** Unread and attention follow summary changes even while the page is hidden, so the tab title stays current. */
  const [attentionRevision, refreshAttention] = useState(0);
  const attentionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sidebarWidth = useSidebarWidth();
  const [reader, setReader] = useState(false);
  /** Open sub-agent panel; `agentId` selects one sub-agent's transcript. Exclusive with the workspace reader. */
  const [subagentPanel, setSubagentPanel] = useState<{ agentId?: string }>();
  const subagentOrigin = useRef<HTMLButtonElement | null>(null);
  const subagentTrigger = useRef<HTMLButtonElement>(null);
  const subagentClose = useRef<HTMLButtonElement>(null);
  const narrow = useNarrow();
  const [readerExpanded, setReaderExpanded] = useState(false);
  const [readerTarget, setReaderTarget] = useState<ReaderTarget>();
  const [unavailableFiles, setUnavailableFiles] = useState<ReadonlySet<string>>(new Set());
  const readerOrigin = useRef<{ button: HTMLButtonElement; row: HTMLLIElement | null }>(null);
  const [selected, setSelected] = useState<string | undefined>(() => opened.kind === 'conversation' ? opened.id : undefined);
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>();
  const [pages, setPages] = useState<Page[]>([]);
  /** Cursors of pages dropped from the newer end, nearest last; empty means the window ends at the latest page. */
  const [newer, setNewer] = useState<(string | null)[]>([]);
  const items = useMemo(() => pageItems(pages), [pages]);
  const [draft, setDraft] = useState<Draft>({ text: '' });
  const [creating, setCreating] = useState<string | true | undefined>(() => opened.kind === 'draft' ? opened.workspaceId || true : undefined);
  const [addedWorkspace,setAddedWorkspace]=useState<string>();
  const [pickingFile, setPickingFile] = useState(false);
  const [navigation, setNavigation] = useState(false);
  const [error, setError] = useState('');
  const [unavailableNotice, setUnavailableNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [connection, setConnection] = useState('正在连接');
  const [moreOutput, setMoreOutput] = useState(false);
  const pagesRef = useRef(pages); pagesRef.current = pages;
  const newerRef = useRef(newer); newerRef.current = newer;
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const windowed = newer.length > 0;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  /**
   * The open conversation's in-flight items, updated synchronously frame by frame (ADR 0019), with the live position
   * its snapshot reflected. React state follows it; consecutive frames must not wait for a render to apply.
   */
  const liveView = useRef<{ id: string; items: WorkbenchItem[]; cursor?: LiveCursor; limited: boolean } | undefined>(undefined);
  /** This page's live stream position: the epoch and last sequence received. */
  const liveStream = useRef<LiveCursor | undefined>(undefined);
  /** Recent live frames of the open conversation, replayed on top of a snapshot that was cut before them. */
  const liveLog = useRef<LiveEvent[]>([]);
  const adoptSnapshot = (result: WorkbenchSnapshot) => {
    const id = result.conversation.id; const limited = result.history.liveItemsLimited; const stream = liveStream.current;
    let items = result.history.liveItems; let gap = false;
    // Snapshot plus replay: frames that arrived while this snapshot was on its way are applied on top of it.
    if (result.live && stream && result.live.epoch === stream.epoch) for (const frame of liveLog.current) {
      if (frame.conversationId !== id || frame.sequence <= result.live.sequence) continue;
      const next = applyLiveFrame(items, frame);
      if (next !== 'gap') { items = next; continue; }
      const itemId = 'item' in frame ? frame.item.id : frame.itemId;
      if (!limited || items.some(item => item.id === itemId)) { gap = true; break; }
    }
    liveView.current = { id, items, cursor: result.live, limited };
    const full = items === result.history.liveItems ? result : { ...result, history: { ...result.history, liveItems: items } };
    // A full read that is older than the last state read keeps that newer state (ADR 0020).
    const floor = stateRevision.current; stateRevision.current = Math.max(floor, result.revision);
    setSnapshot(current => adoptFull(current, full, floor));
    if (gap) scheduleRefresh(id, false);
  };
  /** Revision of the newest conversation state applied, from a full read or a state read. */
  const stateRevision = useRef(0);
  /** What the scheduled refresh reads: only the state (ADR 0020), or the full snapshot. */
  const pendingScope = useRef<'state' | 'full' | undefined>(undefined);
  const draftRef = useRef(draft); draftRef.current = draft;
  const generation = useRef(0);
  const requestSerial = useRef(0);
  const configurationSerial = useRef(0);
  const activeRead = useRef<{ id: string; generation: number; dirty: boolean; latest: boolean; task: Promise<void> } | undefined>(undefined);
  const viewController = useRef<AbortController | undefined>(undefined);
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const anchor = useRef<{ key: string; offset: number } | { height: number; top: number } | null>(null);
  /** Pin the first visible entry, so adding or dropping pages above or below never moves the reader. */
  const keepAnchor = () => {
    const node = scroll.current; if (!node) return;
    const top = node.getBoundingClientRect().top;
    for (const element of node.querySelectorAll<HTMLElement>('[data-message-id],[data-anchor]')) {
      const box = element.getBoundingClientRect();
      if (box.bottom > top) { anchor.current = { key: element.dataset.messageId ?? element.dataset.anchor!, offset: box.top - top }; return; }
    }
    anchor.current = { height: node.scrollHeight, top: node.scrollTop };
  };
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
      const latestPage = preparePage(null, result.history.items, result.history.olderCursor, result.turnFiles);
      adoptSnapshot(result);
      // A failed native read keeps whatever is already loaded (ADR 0014: no local copy to fall back on).
      const failed = !!result.history.error;
      if (latest || first) {
        if (!failed || first || !pagesRef.current.length) { setPages([latestPage]); setNewer([]); }
      } else if (!failed && !newerRef.current.length) {
        const current = pagesRef.current;
        const joined = joinLatest(current, latestPage);
        if (joined) setPages(trimOldest(joined));
        else if (atBottom.current || !current.length) setPages([latestPage]);
        // The reader is in older content and new output no longer touches the window: keep it and offer the way back.
        else setNewer([null]);
      }
      reconcilePending(id, result);
    } catch (reason) {
      if (gen === generation.current) {
        if (reason instanceof RequestError && reason.status === 404) {
          saveDraft(id, { text: '' }); setSnapshot(undefined); liveView.current = undefined; setPages([]); setNewer([]); setDraft({ text: '' }); draftRef.current = { text: '' };
          setSelected(undefined); pageHistory.page('', 'replace');
          setUnavailableNotice('对话已不可用。'); refreshList(value => value + 1);
        } else report(reason);
      }
    }
    })().finally(() => {
      if (activeRead.current === job) activeRead.current = undefined;
      if (job.dirty && alive.current && generation.current === gen && selectedRef.current === id) {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => { refreshTimer.current = undefined; pendingScope.current = undefined; void loadRef.current(id, job.latest); }, 180);
      }
    });
    return job.task;
  };
  const loadRef = useRef(load); loadRef.current = load;
  /** A sent message whose operation settled: clear the draft it came from, or keep it with the reason. */
  const reconcilePending = (id: string, result: { operations: WorkbenchSnapshot['operations']; conversation: Conversation }) => {
    const pending = draftRef.current.pending;
    if (!pending || pending.queued) return;
    const operation = result.operations.find(op => op.id === pending.id);
    if (operation?.status === 'accepted') {
      rememberConversation(result.conversation);
      setDraft(current => { const { pending: _pending, ...editable } = current; const next = sameInput(editable, pending) ? { text: '' } : editable; saveDraft(id, next); return next; });
      setError('');
    } else if (operation?.status === 'rejected') setError(operation.reason ? failures[operation.reason] ?? operation.reason : '本次发送未被接受，输入已保留。');
  };
  /** Re-read only the conversation's state; history and live items stay as they are (ADR 0020). */
  const loadState = async (id: string) => {
    const gen = generation.current;
    try {
      const result = await request(`/conversations/${id}/state`, conversationStateSchema, { signal: viewController.current?.signal });
      if (!alive.current || gen !== generation.current || id !== selectedRef.current || result.revision < stateRevision.current) return;
      stateRevision.current = result.revision;
      setSnapshot(current => current && current.conversation.id === id ? applyState(current, result) : current);
      reconcilePending(id, result);
    } catch (reason) {
      if (gen !== generation.current) return;
      // The full read owns the unavailable-conversation path.
      if (reason instanceof RequestError && reason.status === 404) { void loadRef.current(id); return; }
      report(reason);
    }
  };
  const loadStateRef = useRef(loadState); loadStateRef.current = loadState;
  const scheduleRefresh = (id?: string, refreshNavigation = true, scope: 'state' | 'full' = 'full') => {
    if (refreshNavigation && !attentionTimer.current) attentionTimer.current = setTimeout(() => { attentionTimer.current = undefined; refreshAttention(value => value + 1); }, 700);
    // A hidden page skips list reloads; becoming visible again reconciles everything once.
    if (refreshNavigation && !listTimer.current && document.visibilityState !== 'hidden') listTimer.current = setTimeout(() => { listTimer.current = undefined; refreshList(value => value + 1); }, 700);
    if (id && id !== selectedRef.current) return;
    pendingScope.current = scope === 'full' || pendingScope.current === 'full' ? 'full' : 'state';
    if (!refreshTimer.current) refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined; const target = selectedRef.current; const kind = pendingScope.current; pendingScope.current = undefined;
      if (!target) return;
      if (kind === 'state') void loadStateRef.current(target); else void loadRef.current(target);
    }, 180);
  };
  useEffect(() => { setSubagentPanel(undefined); }, [selected]);
  useEffect(() => {
    alive.current = true;
    configurationRefresh.current();
    return () => { alive.current = false; configurationSerial.current++; generation.current++; viewController.current?.abort(); if (refreshTimer.current) clearTimeout(refreshTimer.current); if (listTimer.current) clearTimeout(listTimer.current); if (attentionTimer.current) clearTimeout(attentionTimer.current); };
  }, []);
  useEffect(() => {
    generation.current++; requestSerial.current++; viewController.current?.abort(); viewController.current = new AbortController();
    setSnapshot(undefined); snapshotRef.current = undefined; liveView.current = undefined; liveLog.current = []; stateRevision.current = 0; pendingScope.current = undefined; setPages([]); setNewer([]); pagesRef.current = []; newerRef.current = []; setUnavailableFiles(new Set()); setError(''); setMoreOutput(false); atBottom.current = true;
    const next = selected ? readDraft(selected) : { text: '' }; draftRef.current = next; setDraft(next);
    if (selected) { setUnavailableNotice(''); void loadRef.current(selected, true); }
    return () => viewController.current?.abort();
  }, [selected]);
  // Reading means the conversation is on screen: Settings and Archive cover it, so they release the lease (unread rule).
  const readingId = view ? undefined : selected;
  useEffect(() => {
    if (!readingId) return;
    const readerId = crypto.randomUUID();
    const renew = () => {
      const active = document.visibilityState === 'visible';
      void request(`/conversations/${readingId}/reading`, z.object({ ok: z.literal(true) }), {
        csrf, body: { readerId, active },
      }).catch(() => { /* The displayed snapshot and connection state retain recovery feedback. */ });
    };
    const release = () => {
      void request(`/conversations/${readingId}/reading`, z.object({ ok: z.literal(true) }), {
        csrf, body: { readerId, active: false },
      }).catch(() => { /* Server lease expiration covers abrupt page loss. */ });
    };
    renew();
    const timer = setInterval(renew, 15_000);
    document.addEventListener('visibilitychange', renew);
    window.addEventListener('pagehide', release);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', renew); window.removeEventListener('pagehide', release); release(); };
  }, [readingId, csrf]);
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
      source.addEventListener('ready', event => {
        if (source !== own || stopped) return;
        try { liveStream.current = readyEventSchema.parse(JSON.parse((event as MessageEvent).data)).live; } catch { liveStream.current = undefined; }
        delay = 500; lastMessage = Date.now(); setConnection('已连接'); scheduleRefresh(); configurationRefresh.current();
      });
      /** A live frame was missed: the open conversation re-reads its snapshot (ADR 0019). */
      const liveGap = () => { if (selectedRef.current) scheduleRefresh(selectedRef.current, false); };
      source.addEventListener('heartbeat', event => {
        if (source !== own || stopped) return;
        lastMessage = Date.now();
        try {
          const live = heartbeatEventSchema.parse(JSON.parse((event as MessageEvent).data)).live; const stream = liveStream.current;
          if (stream && live > stream.sequence) { liveStream.current = { ...stream, sequence: live }; liveGap(); }
        } catch { /* a heartbeat without a live position carries nothing to check */ }
      });
      source.addEventListener('live', event => {
        if (source !== own || stopped) return;
        lastMessage = Date.now();
        let frame: LiveEvent;
        try { frame = liveEventSchema.parse(JSON.parse((event as MessageEvent).data)); } catch { liveGap(); return; }
        const stream = liveStream.current;
        const missed = !stream || frame.sequence !== stream.sequence + 1;
        if (stream && frame.sequence > stream.sequence) liveStream.current = { ...stream, sequence: frame.sequence };
        if (frame.conversationId === selectedRef.current) { liveLog.current.push(frame); if (liveLog.current.length > 512) liveLog.current.shift(); }
        const view = liveView.current;
        const applicable = view && view.id === frame.conversationId && frame.conversationId === selectedRef.current
          // Frames the snapshot already reflects are skipped.
          && !(view.cursor && stream && view.cursor.epoch === stream.epoch && frame.sequence <= view.cursor.sequence);
        if (applicable) {
          const next = applyLiveFrame(view.items, frame);
          if (next !== 'gap') {
            view.items = next;
            setSnapshot(current => current && current.conversation.id === frame.conversationId ? { ...current, history: { ...current.history, liveItems: next } } : current);
          } else {
            const itemId = 'item' in frame ? frame.item.id : frame.itemId;
            // Output too long for the snapshot arrives from history once it completes; re-reading now would not help.
            if (!view.limited || view.items.some(item => item.id === itemId)) { liveGap(); return; }
          }
        }
        if (missed) liveGap();
      });
      source.addEventListener('change', event => {
        if (source !== own || stopped) return;
        lastMessage = Date.now();
        try {
          const change = changeEventSchema.parse(JSON.parse((event as MessageEvent).data));
          if (change.revision <= cursor) return; cursor = change.revision;
          if (change.deleted) {
            saveDraft(change.conversationId, { text: '' });
            if (change.conversationId === selectedRef.current) {
              pageHistory.page('', 'replace');
              setSelected(undefined); setSnapshot(undefined); liveView.current = undefined; setPages([]); setNewer([]); setDraft({ text: '' }); draftRef.current = { text: '' };
              setUnavailableNotice('对话已删除。');
            }
            refreshList(value => value + 1);
            return;
          }
          // A change that may touch history re-reads the full snapshot; a state-only change re-reads just the state (ADR 0020).
          // Only list-visible changes refresh lists.
          scheduleRefresh(change.conversationId, !!change.summary, change.scope === 'state' ? 'state' : 'full');
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
    if (anchor.current) {
      const saved = anchor.current; anchor.current = null;
      if ('key' in saved) {
        const element = node.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(saved.key)}"],[data-anchor="${CSS.escape(saved.key)}"]`);
        if (element) node.scrollTop += element.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset;
      } else node.scrollTop = saved.top + node.scrollHeight - saved.height;
    }
    else if (atBottom.current) { node.scrollTop = node.scrollHeight; setMoreOutput(false); }
    else setMoreOutput(true);
  }, [pages, snapshot?.history.liveItems]);
  const showConversation = useCallback((id: string) => { setSelected(id); setCreating(undefined); setView(undefined); setNavigation(false); }, []);
  const choose = useCallback((id: string) => { pageHistory.page(routeHash({ kind: 'conversation', id }), 'push'); showConversation(id); }, [showConversation]);
  /** A draft that became a conversation takes over the draft's entry, so back does not return to an empty draft. */
  const adoptConversation = useCallback((id: string) => { pageHistory.page(routeHash({ kind: 'conversation', id }), 'replace'); showConversation(id); }, [showConversation]);
  const showDraft = useCallback((id?: string) => { setUnavailableNotice(''); setSelected(undefined); setCreating(id || true); setView(undefined); setReader(false); setNavigation(false); }, []);
  const draftHash = (id?: string) => routeHash(id ? { kind: 'draft', workspaceId: id } : { kind: 'draft' });
  const startDraft = useCallback((id?: string) => { pageHistory.page(draftHash(id), 'push'); showDraft(id); }, [showDraft]);
  /** Choosing another workspace inside a draft corrects the same page. */
  const switchDraftWorkspace = useCallback((id?: string) => { pageHistory.page(draftHash(id), 'replace'); showDraft(id); }, [showDraft]);
  const createInWorkspace = useCallback((id:string)=>startDraft(id),[startDraft]);
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
        if(!queued && snapshotRef.current)rememberConversation(snapshotRef.current.conversation);
        setDraft(current => { const { pending: _pending, ...editable } = current; const clean = sameInput(editable, operation) ? { text: '' } : editable; saveDraft(id, clean); return clean; });
      } else if (result && ['unknown', 'rejected'].includes(result.operation.status)) {
        const reason = result.operation.reason;
        setError(reason ? failures[reason] ?? reason : '操作结果待核实。');
      }
      atBottom.current = true;
      // The sent message arrives on the live stream and with the next history change; only the operation state is read now.
      // A reader in older content still needs the full read that brings the window back to the latest page (ADR 0020).
      if (newerRef.current.length > 0) await load(id, true); else await loadState(id);
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
  const backToLatest = () => { if (!selected) return; atBottom.current = true; void load(selected, true); };
  /** Prepend one older native page; beyond the window limit, pages leave from the newer end with their cursors. */
  const older = async () => {
    const cursor = pagesRef.current[0]?.olderCursor;
    if (!selected || !cursor || loadingOlderRef.current) return;
    const id = selected; const gen = generation.current; loadingOlderRef.current = true; setLoadingOlder(true);
    try {
      const result = await request(`/conversations/${id}/history?cursor=${encodeURIComponent(cursor)}`, historyPageSchema, { signal: viewController.current?.signal });
      if (!alive.current || gen !== generation.current || pagesRef.current[0]?.olderCursor !== cursor) return;
      keepAnchor(); atBottom.current = false;
      const { pages: next, dropped } = prependOlder(pagesRef.current, preparePage(cursor, result.items, result.olderCursor, result.turnFiles));
      if (dropped.length) setNewer(stack => [...stack, ...dropped]);
      setPages(next);
    } catch (reason) {
      if (gen !== generation.current) return;
      if (reason instanceof RequestError && reason.code === 'history_cursor_invalid') { setError(failures.history_cursor_invalid!); backToLatest(); }
      else report(reason);
    } finally { loadingOlderRef.current = false; if (alive.current) setLoadingOlder(false); }
  };
  /** Re-read the nearest page dropped from the newer end; at the latest page the window returns to live output. */
  const loadNewer = async () => {
    const stack = newerRef.current;
    if (!selected || !stack.length || loadingNewerRef.current) return;
    const id = selected; const gen = generation.current; const cursor = stack.at(-1)!;
    loadingNewerRef.current = true; setLoadingNewer(true);
    try {
      let page: Page;
      if (cursor === null) {
        const result = await request(`/conversations/${id}`, snapshotSchema, { signal: viewController.current?.signal });
        if (!alive.current || gen !== generation.current || newerRef.current.at(-1) !== cursor) return;
        if (snapshotRef.current && result.revision < snapshotRef.current.revision) return;
        adoptSnapshot(result);
        page = preparePage(null, result.history.items, result.history.olderCursor, result.turnFiles);
        // The latest page joins when it is adjacent (its older cursor reads the window's newest page) or overlaps it.
        // Output may have moved past the dropped latest page; then the latest page starts a new window.
        if (result.history.error || !touchesWindow(pagesRef.current, page)) { backToLatest(); return; }
      } else {
        const result = await request(`/conversations/${id}/history?cursor=${encodeURIComponent(cursor)}`, historyPageSchema, { signal: viewController.current?.signal });
        if (!alive.current || gen !== generation.current || newerRef.current.at(-1) !== cursor) return;
        page = preparePage(cursor, result.items, result.olderCursor, result.turnFiles);
      }
      keepAnchor();
      setPages(appendNewer(pagesRef.current, page)); setNewer(stack.slice(0, -1));
    } catch (reason) {
      if (gen !== generation.current) return;
      if (reason instanceof RequestError && reason.code === 'history_cursor_invalid') { setError(failures.history_cursor_invalid!); backToLatest(); }
      else report(reason);
    } finally { loadingNewerRef.current = false; if (alive.current) setLoadingNewer(false); }
  };
  const olderRef = useRef(older); olderRef.current = older;
  const newerLoadRef = useRef(loadNewer); newerLoadRef.current = loadNewer;
  const conversation = snapshot?.conversation;
  const openRequests = !!snapshot?.requests?.some(item => item.status === 'open');
  const planning = usePlan({ conversation: snapshot?.conversation, csrf, report, onNotice: setError, onChanged: () => { if (selected) scheduleRefresh(selected); } });
  const unresolved = snapshot?.operations.some(op => ['queued', 'dispatching', 'unknown'].includes(op.status));
  const latestMessage = snapshot?.operations.find(op => op.type === 'message' && op.status === 'accepted');
  const rejectedDraft = draft.pending && snapshot?.operations.find(op => op.id === draft.pending!.id)?.status === 'rejected';
  const previousMessageSettled = !latestMessage || (latestMessage.runId !== null && (latestMessage.runId === conversation?.state.runId || latestMessage.runId === conversation?.state.terminalRunId));
  const removedWorkspace = configuration?.removedWorkspaces?.find(workspace => workspace.id === conversation?.workspaceId);
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
  /** A workspace file a message links to opens beside the conversation, like a file of the turn. */
  function openLinkedFile(path: string, button: HTMLButtonElement) {
    if (!conversation || workspaceRemoved || conversation.id !== selected) return;
    readerOrigin.current = { button, row: null };
    setSubagentPanel(undefined);
    setReaderTarget({ workspaceId: conversation.workspaceId, path });
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
  const subagentList = useSubagentList(conversation, report);
  function openSubagents(agentId?: string, origin?: HTMLButtonElement) {
    subagentOrigin.current = origin ?? subagentTrigger.current;
    setReader(false); setReaderExpanded(false); setSubagentPanel({ ...(agentId ? { agentId } : {}) });
  }
  function closeSubagents() {
    const origin = subagentOrigin.current; subagentOrigin.current = null;
    setSubagentPanel(undefined);
    requestAnimationFrame(() => { (origin?.isConnected ? origin : subagentTrigger.current)?.focus({ preventScroll: true }); });
  }
  const quoteSubagent = (name: string, text: string) => {
    if (draft.pending) { setError('请先核对上次发送，或继续编辑后再添加引用。'); return; }
    const quoted = `> ${name}：${text.replace(/\n/g, '\n> ')}\n`;
    updateDraft({ ...draft, text: draft.text.trim() ? `${draft.text}\n${quoted}` : quoted });
  };
  const collaboration = (records: WorkbenchItem[]) => {
    const ids = [...new Set(records.flatMap(record => record.collaboration?.agentIds ?? []))].slice(0, 32);
    const all = subagentDisplays(subagentList.list?.agents ?? [], Date.now());
    const agents = ids.map(id => all.find(agent => agent.id === id) ?? { id, name: '子 Agent', status: 'unknown' as const });
    return <SubagentActivity action={records[0]!.collaboration!.action} agents={agents}
      onOpen={(id, trigger) => openSubagents(id, trigger)}/>;
  };
  const subagentHost = conversation && subagentPanel && <SubagentPanelHost conversation={conversation} list={subagentList.list}
    {...(subagentPanel.agentId ? { selectedId: subagentPanel.agentId } : {})} narrow={narrow} csrf={csrf} closeRef={subagentClose}
    onSelect={(agentId, origin) => { if (origin) subagentOrigin.current = origin; setSubagentPanel({ ...(agentId ? { agentId } : {}) }); }}
    onClose={closeSubagents} onReload={subagentList.reload} onQuote={quoteSubagent} report={report}/>;
  const configurationLabel = conversationConfigurationLabel(conversation, configuration?.harnesses);
  const permission = configuration?.harnesses.find(h => h.id === conversation?.harnessId)?.permissions.find(p => p.id === conversation?.configuration.permissionId);
  const storage = useStorage();
  const attention = useAttention(listRevision + attentionRevision, report);
  const accounts = useAccounts(report);
  const connectionView = { text: connection, state: connection === '已连接' ? 'online' as const : connection.startsWith('离线') ? 'offline' as const : 'connecting' as const };
  const dismissToast = useCallback((id: string) => setToasts(current => current.filter(toast => toast.id !== id)), []);
  const pushToast = useCallback((toast: Omit<ToastView, 'id'>) => {
    const id = crypto.randomUUID();
    setToasts(current => [...current.slice(-2), { ...toast, id }]);
    setTimeout(() => dismissToast(id), 6000);
  }, [dismissToast]);
  // A result that lands in another conversation is announced once; the open conversation is already being read.
  const attentionSeen = useRef<Map<string, StatusKind>>(undefined);
  useEffect(() => {
    if (!attention) return;
    const next = new Map(attention.conversations.map(item => [item.id, conversationStatus(item).status] as const));
    const previous = attentionSeen.current; attentionSeen.current = next;
    if (!previous) return;
    const verbs: Partial<Record<StatusKind, string>> = { unread: '已完成', failed: '执行失败', unknown: '结果待核实', interrupted: '已中断' };
    for (const item of attention.conversations) {
      const now = next.get(item.id)!; const before = previous.get(item.id);
      if (!item.unread || item.id === readingId || before === now || (before && !['running', 'waiting'].includes(before))) continue;
      const verb = verbs[now]; if (!verb) continue;
      pushToast({ title: `「${item.title}」${verb}`, detail: `${configuration?.workspaces.find(w => w.id === item.workspaceId)?.label ?? '工作区'} · ${harnessLabel(item.harnessId)}`, status: now, action: { label: '查看', run: () => choose(item.id) } });
    }
  }, [attention, choose, pushToast, configuration, readingId]);
  useEffect(() => { const count = attention?.unread ?? 0; document.title = count ? `(${count}) 中书` : '中书'; if (attention) setBadge(count); }, [attention, attention?.unread]);
  useEffect(() => () => { document.title = '中书'; }, []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() === 'k') { event.preventDefault(); setSearching(open => !open); }
      else if (event.key === '\\' && !matchMedia('(max-width:759px)').matches) { event.preventDefault(); setCollapsed(current => !current); }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [setCollapsed]);
  const openFiles = () => { if (!configuration?.workspaces.length) return; setSubagentPanel(undefined); setReader(true); setNavigation(false); };
  const showSettings = (tab?: SettingsTab) => { if (tab) setSettingsTab(tab); setView('settings'); setReader(false); setSubagentPanel(undefined); setNavigation(false); };
  const openSettings = (tab?: SettingsTab) => { pageHistory.page(routeHash({ kind: 'settings', tab: tab ?? settingsTab }), 'push'); showSettings(tab); };
  const changeSettingsTab = (tab: SettingsTab) => { setSettingsTab(tab); pageHistory.page(routeHash({ kind: 'settings', tab }), 'replace'); };
  const openSettingsRef = useRef(openSettings); openSettingsRef.current = openSettings;
  // A notification clicked while this page is open switches it in place (ADR 0018).
  useEffect(() => onNotificationOpen(request => {
    if (request.kind === 'conversation') { choose(request.id); if (request.notice) setPendingNotice(request.notice); }
    else if (request.kind === 'settings') openSettingsRef.current(settingsTabs.find(tab => tab.id === request.tab)?.id);
    else if (request.kind === 'schedule') openScheduleRef.current(scheduleTabs.find(tab => tab.id === request.tab)?.id);
  }), [choose]);
  const showSchedule = (tab?: ScheduleTab) => { if (tab) setScheduleTab(tab); setView('schedule'); setReader(false); setSubagentPanel(undefined); setNavigation(false); };
  const openSchedule = (tab?: ScheduleTab) => { pageHistory.page(routeHash({ kind: 'schedule', tab: tab ?? scheduleTab }), 'push'); showSchedule(tab); };
  const changeScheduleTab = (tab: ScheduleTab) => { setScheduleTab(tab); pageHistory.page(routeHash({ kind: 'schedule', tab }), 'replace'); };
  const openScheduleRef = useRef(openSchedule); openScheduleRef.current = openSchedule;
  /** A workspace file named by a timeline entry: a new draft in that workspace with the file open beside it. */
  const openWorkspaceFile = (workspaceId: string, path: string) => { startDraft(workspaceId); readerOrigin.current = null; setSubagentPanel(undefined); setReaderTarget({ workspaceId, path }); setReader(true); };
  const showArchive = () => { setView('archive'); setReader(false); setSubagentPanel(undefined); setNavigation(false); };
  const openArchive = () => { pageHistory.page(routeHash({ kind: 'archive' }), 'push'); showArchive(); };
  const showHome = () => { setSelected(undefined); setCreating(undefined); setView(undefined); setNavigation(false); };
  /** The page this state shows, to tell a real page change from a step over an overlay entry. */
  const currentRoute: Route = view === 'settings' ? { kind: 'settings', tab: settingsTab } : view === 'schedule' ? { kind: 'schedule', tab: scheduleTab }
    : view === 'archive' ? { kind: 'archive' } : creating ? (typeof creating === 'string' ? { kind: 'draft', workspaceId: creating } : { kind: 'draft' })
    : selected ? { kind: 'conversation', id: selected } : { kind: 'home' };
  const showRoute = (route: Route) => {
    if (route.kind === 'conversation') { showConversation(route.id); if (route.notice) setPendingNotice(route.notice); }
    else if (route.kind === 'draft') showDraft(route.workspaceId);
    else if (route.kind === 'schedule') showSchedule(scheduleTabs.find(tab => tab.id === route.tab)?.id ?? 'calendar');
    else if (route.kind === 'settings') showSettings(settingsTabs.find(tab => tab.id === route.tab)?.id ?? 'workspaces');
    else if (route.kind === 'archive') showArchive();
    else showHome();
  };
  const followHistory = useRef<() => void>(() => {});
  followHistory.current = () => {
    const route = parseRoute(location.hash);
    if (routeHash(route) !== routeHash(currentRoute)) showRoute(route);
    else if (route.kind === 'conversation' && route.notice) setPendingNotice(route.notice);
  };
  // Back, forward and a typed address move between pages; overlays close themselves through useBackDismiss.
  useEffect(() => pageHistory.subscribe(() => followHistory.current()), []);
  useBackDismiss(navigation, () => setNavigation(false), narrow);
  useBackDismiss(searching, () => setSearching(false), narrow);
  useBackDismiss(!view && reader && !!configuration, closeReader, narrow);
  useBackDismiss(!view && !!subagentPanel && !!conversation, closeSubagents, narrow);
  const searchActions: SearchActions = { open: choose, draft: startDraft, files: openFiles, archive: openArchive, settings: openSettings,
    ...(narrow ? {} : { toggleSidebar: () => setCollapsed(current => !current) }) };
  const workspaceName = conversation && (removedWorkspace?.label ?? configuration?.workspaces.find(w => w.id === conversation.workspaceId)?.label ?? '工作区');
  const status = conversation ? conversationStatus(conversation) : undefined;
  const statusText = workspaceRemoved ? '工作区已移除' : conversation ? stateLabel(conversation) : '';
  const searchButton = <IconButton className="header-search" label="搜索与跳转" onClick={() => setSearching(true)}><Search size={18}/></IconButton>;
  // One read serves the run bar and the conversation strip. Run conversations are ordinary sidebar rows (ADR 0021, 2026-11-09).
  const automationData = useAutomations(listRevision, true);
  const automationTitles = useMemo(() => new Map(automationData.automations.map(task => [task.id, task.title])), [automationData.automations]);
  // An agent notification opens its turn (ADR 0021): scroll to the tool record, or the reply after it, and mark it briefly.
  useEffect(() => {
    if (!pendingNotice || !selected || !snapshot || snapshot.conversation.id !== selected) return;
    let alive = true;
    request(`/notifications/${pendingNotice}`, agentNotificationSchema).then(notice => {
      if (!alive) return;
      setPendingNotice(undefined);
      const root = scroll.current;
      if (notice.conversationId !== selected || !notice.itemId || !root) return;
      let target = root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(notice.itemId)}"]`);
      if (!target) {
        const index = items.findIndex(item => item.id === notice.itemId);
        const reply = index >= 0 ? items.slice(index).find(item => item.kind === 'assistant') ?? items.slice(0, index).reverse().find(item => item.kind === 'assistant') : undefined;
        if (reply) target = root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(reply.id)}"]`);
      }
      if (!target) return;
      atBottom.current = false;
      target.scrollIntoView({ block: 'center' });
      target.classList.remove('message-noticed'); void target.offsetWidth; target.classList.add('message-noticed');
    }).catch(() => { if (alive) setPendingNotice(undefined); });
    return () => { alive = false; };
  }, [pendingNotice, selected, snapshot, items]);
  const conversationView = !view && !creating && selected;
  const header = view ? <div className="header-title"><h1>{view === 'settings' ? '设置' : view === 'schedule' ? '日程' : '已归档'}</h1>{view === 'settings' && <span className="header-meta">{settingsTabs.find(tab => tab.id === settingsTab)?.label}</span>}</div>
    : creating ? <div className="header-title"><h1>新对话</h1></div>
    : !selected ? <div className="header-title"><h1>中书</h1></div>
    : <div className="header-title">
      {workspaceName && <span className="header-crumb">{workspaceName}</span>}{workspaceName && <span className="header-separator" aria-hidden="true">/</span>}
      <h1 title={conversation?.title}>{conversation?.title ?? '正在恢复对话…'}</h1>
      {conversation && <span className="header-meta">{status?.status !== 'idle' && <StatusDot status={workspaceRemoved ? 'unknown' : status!.status}/>}{workspaceName} · {harnessLabel(conversation.harnessId)}{status?.status !== 'idle' || workspaceRemoved ? ` · ${statusText}` : ''}</span>}
      {conversation && (status?.status !== 'idle' || workspaceRemoved) && <span className="header-status" data-status={workspaceRemoved ? 'unknown' : status!.status}><StatusDot status={workspaceRemoved ? 'unknown' : status!.status}/>{statusText}</span>}
    </div>;
  const headerActions = <div className="header-actions">
    {conversationView && conversation?.subagents && <SubagentTrigger ref={subagentTrigger} running={conversation.subagents.running} unverified={conversation.subagents.unverified}
      total={conversation.subagents.total} attention={conversation.subagents.resultsPending} expanded={!!subagentPanel}
      onClick={() => subagentPanel ? closeSubagents() : openSubagents()}/>}
    {searchButton}
    {!view && !narrow && <IconButton label="打开工作区文件" tooltip="工作区文件" aria-expanded={reader} disabled={!configuration?.workspaces.length} onClick={openFiles}><FolderOpen size={16}/></IconButton>}
    {conversationView && conversation && <Menu label="对话操作" trigger={<MoreHorizontal size={17}/>} align="end">
      {narrow && <MenuItem disabled={!configuration?.workspaces.length} onSelect={openFiles}><FolderOpen size={15}/>打开工作区文件</MenuItem>}
      <MenuItem onSelect={() => setManaging(conversation)}><Pencil size={15}/>{conversation.archived ? '重命名、恢复或删除' : '重命名、归档或删除'}</MenuItem>
      <MenuItem onSelect={() => { scheduleRefresh(); refreshConfiguration(); }}><RefreshCw size={15}/>重新连接并刷新状态</MenuItem>
    </Menu>}
  </div>;
  const sidebar = <SidebarShell
    status={narrow ? <ConnectionStatus {...connectionView}/> : <IconButton label="收起导航" shortcut={[modifierKey, '\\']} onClick={() => setCollapsed(true)}><PanelLeft size={16}/></IconButton>}
    onClose={narrow ? () => setNavigation(false) : undefined} separator={narrow ? undefined : sidebarWidth.separator}
    actions={<>
      <SidebarAction icon={<SquarePen size={16}/>} label="新对话" current={!!creating && !view} onClick={() => startDraft()}/>
      <SidebarAction icon={<Search size={16}/>} label={narrow ? '搜索对话、工作区和操作' : '搜索与跳转'} ariaLabel="搜索与跳转" shortcut={narrow ? undefined : [modifierKey, 'K']} onClick={() => { setNavigation(false); setSearching(true); }}/>
      <SidebarAction icon={<CalendarDays size={16}/>} label="日程" current={view === 'schedule'} onClick={() => openSchedule()}/>
    </>}
    footer={<>
      <SidebarAction icon={<FolderOpen size={16}/>} label="工作区文件" disabled={!configuration?.workspaces.length} onClick={openFiles}/>
      <SidebarAction icon={<Archive size={16}/>} label="已归档" current={view === 'archive'} onClick={openArchive}/>
      <SidebarAction icon={<Settings size={16}/>} label="设置" current={view === 'settings'} onClick={() => openSettings()}
        badge={storageState(storage.value) && <span className="sidebar-badge" data-state={storageState(storage.value)} aria-label={storage.value?.full ? '存储已满' : '存储接近上限'}/>}/>
      {!narrow && <div className="sidebar-status"><ConnectionStatus {...connectionView}/></div>}
    </>}>
    <ConversationNavigation workspaces={configuration?.workspaces} workspaceAction={setWorkspaceAction} selected={view ? undefined : selected}
      revision={listRevision} csrf={csrf} choose={choose} create={createInWorkspace} manage={setManaging} report={report} attention={attention?.conversations}/>
  </SidebarShell>;
  const panel = view ? undefined : subagentPanel && conversation && !narrow ? subagentHost : reader && configuration ? <WorkspaceReader workspaces={configuration.workspaces} initialWorkspace={conversation?.workspaceId}
      target={readerTarget} onTargetUnavailable={target => {
        if (target === readerTarget && readerTarget.runId !== undefined && readerTarget.conversationId === selectedRef.current)
          setUnavailableFiles(previous => new Set(previous).add(JSON.stringify([readerTarget.runId, target.path])));
      }}
      csrf={csrf} editStatusSignal={JSON.stringify([conversation?.id, conversation?.state.status, conversation?.state.pendingInputs, unresolved])} expanded={readerExpanded} onExpand={setReaderExpanded} onClose={closeReader}/> : undefined;
  return <><WorkbenchFrame style={sidebarWidth.style} navigationOpen={navigation} onNavigationChange={setNavigation} collapsed={collapsed} onCollapsedChange={setCollapsed}
    sidebar={sidebar} header={<>{header}{headerActions}</>} panel={panel} panelExpanded={!!reader && readerExpanded && !subagentPanel}>
      {view !== 'settings' && <AccountBanner accounts={accounts.accounts} onOpen={() => openSettings('account')}/>}
      {view === 'settings' ? <SettingsView tab={settingsTab} onTab={changeSettingsTab} configuration={configuration} workspaceAction={setWorkspaceAction} csrf={csrf} report={report}
          storage={storage} connection={connectionView} logout={logout} busy={busy} revision={listRevision} choose={choose} manage={setManaging} accounts={accounts}/>
        : view === 'archive' ? <ArchiveView configuration={configuration} revision={listRevision} csrf={csrf} report={report} choose={choose} manage={setManaging}/>
        : view === 'schedule' ? <ScheduleView csrf={csrf} report={report} configuration={configuration} revision={listRevision} tab={scheduleTab}
          onTab={changeScheduleTab} openConversation={choose} openFile={openWorkspaceFile}
          createFor={createFor} onCreateHandled={() => setCreateFor(undefined)}/>
        : creating ? configuration ? <NewConversation key={String(creating)} configuration={configuration} initialWorkspace={typeof creating==='string'?creating:undefined} addedWorkspace={addedWorkspace} csrf={csrf} onWorkspace={switchDraftWorkspace} onAddWorkspace={()=>setWorkspaceAction({kind:'add'})} onCreated={c=>{refreshList(value=>value+1);adoptConversation(c.id);}} report={report}/> : <p className="view-status" role="status">正在读取工作区与配置…</p>
        : !selected ? <section className="empty-workbench">
          <h2>选择一段对话，或开始新的工作</h2>
          <p>对话按工作区列在左侧。离开页面后 Agent 仍在工作，回来接着看就行。</p>
          <div className="empty-actions"><Button variant="primary" onClick={() => startDraft()}><SquarePen size={15}/>新对话</Button>
            <Button onClick={() => setSearching(true)}><Search size={15}/>搜索{!narrow && <Kbd keys={[modifierKey, 'K']}/>}</Button></div>
          {configuration?.workspaces.length === 0 && <p className="quiet">还没有工作区。可以在「设置 › 工作区」中添加。</p>}
        </section> : <>
        {conversation && conversation.automationId && <AutomationRunBar conversation={conversation} automations={automationData.automations} revision={listRevision} choose={choose} openTasks={() => openSchedule('tasks')}/>}
        {conversation && !conversation.automationId && <AutomationStrip conversation={conversation} automations={automationData.automations} notifications={automationData.notifications} openTasks={() => openSchedule('tasks')}/>}
        <div className="message-scroll" ref={scroll} onScroll={() => {
          const node = scroll.current!; const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
          atBottom.current = remaining < 80 && !newerRef.current.length; if (atBottom.current) setMoreOutput(false);
          // Scrolling near either edge keeps reading native pages, without a fixed history limit.
          if (node.scrollTop < 400 && pagesRef.current[0]?.olderCursor) void olderRef.current();
          if (newerRef.current.length && remaining < 400) void newerLoadRef.current();
        }}>
          <div className="message-column">
            {pages[0]?.olderCursor && <button className="load-history" disabled={loadingOlder} onClick={() => void older()}>{loadingOlder ? '正在读取…' : '查看更早的内容'}</button>}
            {snapshot && pages.length > 0 && !pages[0]!.olderCursor && items.length > 0 && <p className="history-note">这是对话的开头。</p>}
            {windowed && <p className="history-note">正在阅读较早的内容。<button className="text-button" onClick={backToLatest}>回到最新内容</button></p>}
            {snapshot?.history.error && <p className="history-note" role="status">{historyNotes[snapshot.history.error] ?? failures[snapshot.history.error] ?? historyNotes.native_history_unavailable}<button className="text-button" onClick={() => { if (selected) void load(selected); }}>重试</button></p>}
            {!snapshot && <p role="status" className="quiet">正在核对远端状态与历史…</p>}
            {snapshot && visible.length === 0 && !snapshot.history.error && <p className="quiet conversation-start">{conversation?.readiness !== 'ready' ? '正在准备原生会话…' : snapshot.history.loaded ? '对话已准备好。说说你希望完成什么。' : '正在读取原生历史…'}</p>}
            <AutomationTitles.Provider value={automationTitles}>
              <Transcript items={visible} conversation={selected} onQuote={quote} turnFiles={turnFiles} renderCollaboration={collaboration}
                activeRun={running ? conversation?.state.runId : undefined} activeFile={readerTarget?.runId !== undefined && readerTarget.conversationId === selected ? { runId: readerTarget.runId, path: readerTarget.path } : undefined}
                workspaceUnavailable={workspaceRemoved} unavailableFiles={unavailableFiles} onOpenFile={openTurnFile} {...(workspaceRemoved ? {} : { onOpenLink: openLinkedFile })}/>
            </AutomationTitles.Provider>
            {windowed && <button className="load-history" disabled={loadingNewer} onClick={() => void loadNewer()}>{loadingNewer ? '正在读取…' : '查看更新的内容'}</button>}
          </div>
        </div>
        <div className="composer-region">
          {moreOutput && <button className="new-output" aria-label="有新内容，回到底部" onClick={() => { atBottom.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setMoreOutput(false); }}>↓ 有新内容</button>}
          {(conversation?.error || (conversation?.state.reason && !(conversation.state.status === 'waiting' && openRequests))) && <p className="state-notice">{explain(conversation.error ?? conversation.state.reason!)}</p>}
          {conversation?.state.status === 'interrupted' && <p className="state-notice">本轮已中断。此前启动的后台工具可能仍在运行，已经产生的改动不会撤销。</p>}
          {conversation?.state.status === 'interrupted' && !!conversation.subagents?.running && <p className="state-notice" role="status">
            主 Agent 已停止，仍有 {conversation.subagents.running} 个子 Agent 在运行。{conversation.harnessId === 'dsh' && '它们完成后，DSH 可能让主 Agent 自动继续工作。'}
            <button type="button" className="text-button" onClick={() => openSubagents()}>查看子 Agent</button></p>}
          {conversation?.subagents?.resultsPending && !running && !conversation.subagents.running && <p className="state-notice" role="status">
            子 Agent 在主 Agent 上一轮结束后才完成，主 Agent 要到下一轮才会读到它们的结果。
            <button type="button" className="text-button" onClick={() => openSubagents()}>查看子 Agent</button>
            {usable && !draft.pending && <button type="button" className="text-button" onClick={() => updateDraft({ ...draft, text: draft.text.trim() ? `${draft.text}\n子 Agent 都结束了，请汇总它们的结果。` : '子 Agent 都结束了，请汇总它们的结果。' })}>填入“请汇总结果”</button>}</p>}
          {snapshot?.history.liveItemsLimited && <p className="state-notice">部分实时输出较长，将在完成后从历史中读取完整内容。</p>}
          {!!conversation?.state.pendingInputs && <p className="state-notice">原生服务仍保留 {conversation.state.pendingInputs} 项待处理输入。停止当前轮不会清空它们。</p>}
          {!workspaceRemoved && (unresolved || conversation?.state.status === 'unknown' || !previousMessageSettled) && <div className="state-notice">{!previousMessageSettled ? '正在核对上一条消息对应轮次的执行结果。' : '正在核对执行结果。'}<button className="text-button" onClick={() => void reconcile()}>查询原生结果</button></div>}
          {removedWorkspace && <button className="text-button" onClick={() => setWorkspaceAction({ kind: 'restore', workspace: removedWorkspace })}>恢复工作区</button>}
          {conversation?.archived && <div className="state-notice">这段对话已归档。<button className="text-button" onClick={() => setManaging(conversation)}>恢复对话</button></div>}
          {lastEarly?.delivery && lastEarly.delivery.mode !== 'next' && <div className="state-notice" role="status">
            <span>{lastEarly.runId === lastEarly.delivery.target ? '提前发送的消息已送达目标轮。' : '提前发送的消息已送达后续轮。'}</span>
            {visible.some(item => item.operationId === lastEarly.id) && <button type="button" className="text-button" onClick={() => {
              const item = visible.find(value => value.operationId === lastEarly.id);
              if (item) scroll.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(item.id)}"]`)?.focus();
            }}>查看消息</button>}
          </div>}
          {!workspaceRemoved && !conversation?.archived && draft.pending && <div className="state-notice">{rejectedDraft ? '上次发送未被接受，原始输入已保留。' : '上次发送尚未确认，原始输入已保留。'}<button className="text-button" disabled={sending} onClick={() => { if (rejectedDraft && selected) { const { pending: _pending, ...next } = draft; setDraft(next); saveDraft(selected, next); } else void send(); }}>{rejectedDraft ? '继续编辑' : '核对同一发送'}</button></div>}
          {conversation && snapshot?.conversation.id === conversation.id && <PlanArea conversation={conversation} planReady={snapshot.planReady} csrf={csrf} report={report}
            onChange={planning.change} onChanged={() => scheduleRefresh(conversation.id)}/>}
          {conversation && snapshot?.conversation.id === conversation.id && !!snapshot.requests?.length && <ConversationRequests conversation={conversation} requests={snapshot.requests} csrf={csrf}
            report={report} onNotice={setError} onReload={() => { if (selected) void load(selected); }} onOpenAgent={agentId => openSubagents(agentId)}/>}
          {!workspaceRemoved && !conversation?.archived && <Composer key={selected} conversation={selected} csrf={csrf} draft={draft} onChange={updateDraft}
            onSend={() => { if (ready || draft.pending) void send(); }} onStop={() => void stop()} onFiles={() => setPickingFile(true)}
            ready={ready} sending={sending} running={running} queueing={queueing}
            skillsEnabled={conversation?.id === selected && !!usable} usage={conversation?.id === selected ? snapshot?.usage : undefined}
            queue={queue && <InputQueue queue={queue} busy={sending}
              target={running && usable && !unresolved ? conversation.state.runId : undefined} canResume={!!usable && !unresolved} onCommand={changeQueue}/>}
            permission={conversation?.state.configurationVerified ? permission?.label ?? '配置按对话固定' : '配置待核实'}
            configurationNote={conversation?.state.configurationVerified ? permission?.description ?? '配置在本对话中保持不变。' : '正在核实当前对话的原生配置，核实后可继续工作。'}
            model={configurationLabel.model} reasoningEffort={configurationLabel.reasoningEffort} agentPreset={configurationLabel.agentPreset}
            toolbarExtras={conversation?.id === selected && <PlanToolbarToggle plan={conversation.plan} changing={planning.changing}
              busy={running || sending || ['waiting', 'unknown'].includes(conversation.state.status)} onChange={active => void planning.change(active)}/>}/>}
        </div>
      </>}
      {(error || authError || unavailableNotice) && <div className="workbench-error" role="alert"><span>{error || authError || unavailableNotice}</span><button className="text-button" onClick={() => { setError(''); setUnavailableNotice(''); }}>关闭</button></div>}
      <Toasts toasts={toasts} onDismiss={dismissToast}/>
    </WorkbenchFrame>
    {!view && narrow && subagentHost}
    <WorkbenchSearch open={searching} onOpenChange={setSearching} configuration={configuration} attention={attention?.conversations} actions={searchActions} csrf={csrf}/>
    {managing && <ManageDialog conversation={managing} workspaceLabel={configuration?.workspaces.find(w => w.id === managing.workspaceId)?.label ?? configuration?.removedWorkspaces?.find(w => w.id === managing.workspaceId)?.label ?? '未登记工作区'}
      csrf={csrf} close={() => setManaging(undefined)} changed={message => { pushToast({ title: message }); refreshNavigation(); }} report={report}/>}
    {pickingFile && selected && !workspaceRemoved && <FilePicker conversation={selected} onClose={() => setPickingFile(false)} onSelect={(reference: MessageReference) => { const next = { ...draft, text: draft.text.endsWith('@') ? draft.text.slice(0,-1) : draft.text, references: [...(draft.references ?? []), reference].slice(0,8) }; updateDraft(next); }}/ >}
    {workspaceAction && <WorkspaceManagement action={workspaceAction} roots={configuration?.workspaceRoots ?? []} csrf={csrf}
      close={() => setWorkspaceAction(undefined)} changed={id => { if(workspaceAction?.kind==='add')setAddedWorkspace(id);refreshConfiguration(); refreshNavigation(); }} report={report} />}
  </>;
}

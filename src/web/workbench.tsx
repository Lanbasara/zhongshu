import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  workbenchConfigurationSchema, conversationListSchema, conversationResponseSchema, operationResponseSchema,
  snapshotSchema, changeEventSchema, resetEventSchema,
  type WorkbenchConfiguration, type Conversation, type WorkbenchSnapshot, type WorkbenchItem,
} from '../shared/workbench.ts';
import { request, RequestError, readDraft, saveDraft, type Draft } from './workbench-client.ts';
import { sessionSchema } from '../shared/http.ts';
import './workbench.css';

const states = { idle: '就绪', running: '运行中', waiting: '等待处理', interrupted: '已中断', failed: '执行失败', unknown: '待核实' };
const stateLabel = (c: Conversation) => c.readiness === 'preparing' ? '正在准备' : c.readiness === 'blocked' ? '准备未完成' : states[c.state.status];
const failures: Record<string, string> = {
  conversation_not_ready: '对话尚未就绪，请等待状态核实。', operation_needs_reconciliation: '上一项操作尚未核实，请先查询结果。',
  operation_conflict: '操作编号与内容不一致；已保留输入。', configuration_unavailable: '所选配置暂时不可用，请刷新后重试。',
  active_conversation_limit: '当前观察的运行中对话较多，请稍后再试。', invalid_request: '输入未被接受，请检查内容与长度。',
};
const stateReasons: Record<string, string> = {
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
const mergeItems = (older: WorkbenchItem[], newer: WorkbenchItem[]): WorkbenchItem[] => {
  const incoming = new Map(newer.map(item => [item.id, item]));
  return [...older.filter(item => !incoming.has(item.id)), ...newer];
};
// Bound both the number of DOM entries and retained UTF-16 text, including long replies.
const fitsWindow = (items: WorkbenchItem[]) => items.length <= 500 && items.reduce((bytes, item) => bytes + item.text.length * 2 + 2048, 0) <= 8 * 1024 * 1024;
const boundedPage = (items: WorkbenchItem[]) => {
  let bytes = 0; let start = items.length;
  while (start > 0 && items.length - start < 500) {
    const next = items[start - 1]!; bytes += next.text.length * 2 + 2048;
    if (bytes > 8 * 1024 * 1024) break;
    start--;
  }
  return items.slice(start);
};

export function WorkbenchView({ csrf, logout, expired, busy, authError }: { csrf: string; logout(): void; expired(): void; busy: boolean; authError: string }) {
  const [configuration, setConfiguration] = useState<WorkbenchConfiguration>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listBefore, setListBefore] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | undefined>(() => /^#[0-9a-f-]{36}$/i.test(location.hash) ? location.hash.slice(1) : undefined);
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>();
  const [items, setItems] = useState<WorkbenchItem[]>([]);
  const [draft, setDraft] = useState<Draft>({ text: '' });
  const [creating, setCreating] = useState(false);
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
  const listSerial = useRef(0);
  const listExpanded = useRef(false);
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
  const loadList = async (older?: string) => {
    const serial = ++listSerial.current;
    try {
      const result = await request('/conversations' + (older ? `?beforeId=${encodeURIComponent(older)}` : ''), conversationListSchema);
      if (!alive.current || serial !== listSerial.current) return;
      if (older) listExpanded.current = true;
      setConversations(previous => older ? [...previous, ...result.conversations.filter(c => !previous.some(p => p.id === c.id))].slice(-200) : listExpanded.current ? [...result.conversations, ...previous.filter(c => !result.conversations.some(p => p.id === c.id))].slice(0, 200) : result.conversations);
      if (older || !listExpanded.current) setListBefore(result.olderBeforeId);
    } catch (reason) { report(reason); }
  };
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
      const pageItems = boundedPage(result.history.items);
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
      if (pending) {
        const operation = result.operations.find(op => op.id === pending.id);
        if (operation?.status === 'accepted') {
          setDraft(current => { const next = { text: current.text === pending.text ? '' : current.text }; saveDraft(id, next); return next; });
          setError('');
        } else if (operation?.status === 'rejected') setError(operation.reason ?? '本次发送未被接受，输入已保留。');
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
  const listRef = useRef(loadList); listRef.current = loadList;
  const scheduleRefresh = (id?: string) => {
    if (!listTimer.current) listTimer.current = setTimeout(() => { listTimer.current = undefined; void listRef.current(); }, 700);
    if (id && id !== selectedRef.current) return;
    if (!refreshTimer.current) refreshTimer.current = setTimeout(() => { refreshTimer.current = undefined; if (selectedRef.current) void loadRef.current(selectedRef.current); }, 180);
  };
  useEffect(() => {
    alive.current = true;
    void request('/configuration', workbenchConfigurationSchema).then(value => { if (alive.current) setConfiguration(value); }).catch(report);
    void loadList();
    return () => { alive.current = false; generation.current++; viewController.current?.abort(); if (refreshTimer.current) clearTimeout(refreshTimer.current); if (listTimer.current) clearTimeout(listTimer.current); };
  }, []);
  useEffect(() => {
    generation.current++; requestSerial.current++; viewController.current?.abort(); viewController.current = new AbortController();
    setSnapshot(undefined); snapshotRef.current = undefined; setItems([]); setError(''); setMoreOutput(false); setWindowed(false); setBefore(null); setHasOlder(false); atBottom.current = true;
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
      source.addEventListener('ready', () => { if (source !== own || stopped) return; delay = 500; lastMessage = Date.now(); setConnection('已连接'); scheduleRefresh(); });
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
          scheduleRefresh(change.conversationId);
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
  const choose = (id: string) => { history.replaceState(null, '', `#${id}`); setSelected(id); setNavigation(false); };
  const updateDraft = (text: string) => {
    if (!selected) return;
    const next = { ...draft, text }; setDraft(next); draftRef.current = next;
    if (!saveDraft(selected, next)) setError('浏览器暂时无法保存草稿；关闭页面前请先复制输入。');
  };
  const send = async () => {
    if (!selected || sendingRef.current || (!draft.text.trim() && !draft.pending)) return;
    const id = selected; const gen = generation.current;
    const operation = draft.pending ?? { id: crypto.randomUUID(), text: draft.text };
    const body = { id: operation.id, type: 'message', payload: { text: operation.text } };
    if (new TextEncoder().encode(JSON.stringify(body)).length > 60 * 1024) { setError('输入编码后较长，请减少内容再发送；本次尚未发送。'); return; }
    const next = { ...draft, pending: operation };
    if (!saveDraft(id, next)) { setError('浏览器无法保留本次发送编号，本次尚未发送。请保留输入后重新打开页面。'); return; }
    setDraft(next); draftRef.current = next;
    sendingRef.current = true; setSending(true); setError('');
    try {
      const result = await request(`/conversations/${id}/operations`, operationResponseSchema, { csrf, body });
      if (!alive.current || gen !== generation.current) return;
      if (result.operation.status === 'accepted') {
        setDraft(current => { const clean = { text: current.text === operation.text ? '' : current.text }; saveDraft(id, clean); return clean; });
      } else if (['unknown', 'rejected'].includes(result.operation.status)) setError(result.operation.reason ?? '操作结果待核实。');
      atBottom.current = true; await load(id);
    } catch (reason) {
      if (gen === generation.current && reason instanceof RequestError && [400, 413].includes(reason.status)) {
        setDraft(current => { const editable = { text: current.text }; saveDraft(id, editable); return editable; });
      }
      report(reason);
    }
    finally { sendingRef.current = false; if (alive.current) setSending(false); }
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
      if (scroll.current) anchor.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop };
      atBottom.current = false;
      const pageItems = boundedPage(result.history.items);
      const trimmed = pageItems.length < result.history.items.length;
      setItems(current => { const merged = mergeItems(pageItems, current); if (!fitsWindow(merged)) { anchor.current = null; setWindowed(true); return pageItems; } return merged; });
      setBefore(trimmed ? pageItems[0]?.id ?? null : result.history.olderBeforeItemId ?? pageItems[0]?.id ?? null); setHasOlder(trimmed || result.history.hasOlder);
    } catch (reason) { report(reason); }
    finally { if (alive.current) setLoadingOlder(false); }
  };
  const conversation = snapshot?.conversation;
  const unresolved = snapshot?.operations.some(op => ['queued', 'dispatching', 'unknown'].includes(op.status));
  const latestMessage = snapshot?.operations.find(op => op.type === 'message' && op.status === 'accepted');
  const rejectedDraft = draft.pending && snapshot?.operations.find(op => op.id === draft.pending!.id)?.status === 'rejected';
  const previousMessageSettled = !latestMessage || (latestMessage.runId !== null && (latestMessage.runId === conversation?.state.runId || latestMessage.runId === conversation?.state.terminalRunId));
  const ready = conversation?.readiness === 'ready' && conversation.state.configurationVerified && ['idle', 'interrupted', 'failed'].includes(conversation.state.status) && !conversation.state.pendingInputs && !unresolved && previousMessageSettled;
  const live = windowed ? [] : snapshot?.history.liveItems.filter(item => !items.some(saved => saved.id === item.id && saved.status !== 'running')) ?? [];
  const visible = items.map(item => live.find(current => current.id === item.id) ?? item).concat(live.filter(item => !items.some(saved => saved.id === item.id)));
  return <div className="workbench">
    <aside className={`sidebar ${navigation ? 'is-open' : ''}`} aria-label="对话导航">
      <div className="workbench-brand"><img src="/icon.svg" width="30" height="30" alt="" /><div>中书<small>ZHONGSHU</small></div><button className="icon-button mobile-only" aria-label="关闭导航" onClick={() => setNavigation(false)}>×</button></div>
      <button className="new-conversation" onClick={() => { setCreating(true); setNavigation(false); }}>＋ 新对话</button>
      <p className="nav-label">你的对话</p>
      <nav>{conversations.map(c => <button key={c.id} className={`conversation-link ${c.id === selected ? 'selected' : ''}`} aria-current={c.id === selected ? 'page' : undefined} onClick={() => choose(c.id)}><strong>{c.title}</strong><span>{c.harnessId === 'codex' ? 'Codex' : 'DSH'} <i>{stateLabel(c)}</i></span></button>)}</nav>
      {listBefore && <button className="text-button" onClick={() => void loadList(listBefore)}>更早的对话</button>}
      <div className="sidebar-bottom"><span className="network" role="status">{connection}</span><button className="text-button" onClick={logout} disabled={busy}>退出登录</button></div>
    </aside>
    {navigation && <button className="nav-backdrop" aria-label="关闭导航" onClick={() => setNavigation(false)} />}
    <main className="conversation-panel">
      <header className="conversation-header"><button className="icon-button mobile-only" aria-label="打开对话导航" onClick={() => setNavigation(true)}>☰</button><div><h1>{conversation?.title ?? (selected ? '正在恢复对话…' : '从这里，接着做。')}</h1><p>{conversation ? `${conversation.harnessId === 'codex' ? 'Codex' : 'DSH'} · ${configuration?.workspaces.find(w => w.id === conversation.workspaceId)?.label ?? '工作区'} · ${stateLabel(conversation)}` : '一段对话，一个可以接续的工作现场'}</p></div><button className="text-button" onClick={() => { scheduleRefresh(); void request('/configuration', workbenchConfigurationSchema).then(setConfiguration).catch(report); }}>重新连接</button></header>
      {!selected ? <section className="empty-workbench"><p className="eyebrow">A PLACE TO CONTINUE</p><h2>把想法，往前推进一步。</h2><p>选择一个工作区和 Agent，开始一件具体的工作。<br />离开页面后，可以回来继续。</p><button onClick={() => setCreating(true)}>开始新对话 ↗</button>{configuration?.workspaces.length === 0 && <p className="quiet">工作区与原生服务尚未由管理员连接。</p>}</section> : <>
        <div className="message-scroll" ref={scroll} onScroll={() => { const node = scroll.current!; atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; if (atBottom.current) setMoreOutput(false); }}>
          <div className="message-column">
            {hasOlder && <button className="load-history" disabled={loadingOlder} onClick={() => void older()}>{loadingOlder ? '正在读取…' : '查看更早的内容'}</button>}
            {windowed && <p className="history-note">正在阅读较早的一页。<button className="text-button" onClick={() => { if (selected) { atBottom.current = true; void load(selected, true); } }}>回到最新内容</button></p>}
            {!snapshot && <p role="status" className="quiet">正在核对远端状态与历史…</p>}
            {snapshot && visible.length === 0 && <p className="quiet conversation-start">{conversation?.readiness === 'ready' ? '对话已准备好。说说你希望完成什么。' : '正在准备原生会话…'}</p>}
            {visible.map(item => <Message key={item.id} item={item} />)}
          </div>
        </div>
        <div className="composer-region">
          {moreOutput && <button className="new-output" onClick={() => { atBottom.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setMoreOutput(false); }}>↓ 有新内容</button>}
          {(conversation?.error || conversation?.state.reason) && <p className="state-notice">{explain(conversation.error ?? conversation.state.reason!)}</p>}
          {conversation?.state.status === 'interrupted' && <p className="state-notice">本轮已中断。此前启动的后台工具可能仍在运行，已经产生的改动不会撤销。</p>}
          {snapshot?.history.liveItemsLimited && <p className="state-notice">部分实时输出较长，将在完成后从历史中读取完整内容。</p>}
          {!!conversation?.state.pendingInputs && <p className="state-notice">原生服务仍保留 {conversation.state.pendingInputs} 项待处理输入。停止当前轮不会清空它们。</p>}
          {(unresolved || conversation?.state.status === 'unknown' || !previousMessageSettled) && <div className="state-notice">{!previousMessageSettled ? '正在核对上一条消息对应轮次的执行结果。' : '正在核对执行结果。'}<button className="text-button" onClick={() => void reconcile()}>查询原生结果</button></div>}
          {draft.pending && <div className="state-notice">{rejectedDraft ? '上次发送未被接受，原始输入已保留。' : '上次发送尚未确认，原始输入已保留。'}<button className="text-button" disabled={sending} onClick={() => { if (rejectedDraft && selected) { const next = { text: draft.text }; setDraft(next); saveDraft(selected, next); } else void send(); }}>{rejectedDraft ? '继续编辑' : '核对同一发送'}</button></div>}
          <form className="composer" onSubmit={e => { e.preventDefault(); if (ready || draft.pending) void send(); }}>
            <label className="sr-only" htmlFor="message">给 Agent 的消息</label><textarea id="message" name="message" value={draft.text} maxLength={16_000} placeholder="继续思考，或开始一件工作…" onChange={e => updateDraft(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing && (ready || draft.pending)) { e.preventDefault(); void send(); } }} rows={3} />
            <div className="composer-actions"><span title={conversation?.configuration.modelId}>{configuration?.harnesses.find(h => h.id === conversation?.harnessId)?.models.find(m => m.id === conversation?.configuration.modelId)?.label ?? '配置按对话固定'}</span>{conversation && ['running', 'waiting'].includes(conversation.state.status) && conversation.state.runId ? <button type="button" className="stop-button" disabled={sending} onClick={() => void stop()}>停止当前轮</button> : <button type="submit" aria-label="发送消息" disabled={sending || (!ready && !draft.pending) || (!draft.text.trim() && !draft.pending)}>{sending ? '确认中…' : '发送 ↑'}</button>}</div>
          </form><p className="composer-hint">Enter 换行 · ⌘ / Ctrl + Enter 发送<span>配置在本对话中保持不变</span></p>
        </div>
      </>}
      {(error || authError) && <div className="workbench-error" role="alert"><span>{error || authError}</span><button className="text-button" onClick={() => setError('')}>关闭</button></div>}
    </main>
    {creating && <CreateConversation configuration={configuration} csrf={csrf} onClose={() => setCreating(false)} onCreated={c => { setCreating(false); setConversations(current => [c, ...current.filter(old => old.id !== c.id)]); choose(c.id); }} onError={report} />}
  </div>;
}

function Message({ item }: { item: WorkbenchItem }) {
  if (item.kind === 'tool') return <details className="tool-message"><summary><span aria-hidden="true">{item.status === 'running' ? '◌' : item.status === 'failed' ? '!' : '✓'}</span> 工具活动 <small>{item.status === 'running' ? '进行中' : item.status === 'failed' ? '未完成' : '已完成'}</small></summary><pre>{item.text}</pre></details>;
  return <article className={`message message-${item.kind}`}><div className="message-author">{item.kind === 'user' ? '你' : item.kind === 'assistant' ? '中书' : '状态'}</div><div className="message-text">{item.text || (item.status === 'running' ? '正在生成…' : '')}</div>{item.status === 'failed' && <small className="quiet">此项未完成</small>}</article>;
}

function CreateConversation({ configuration, csrf, onClose, onCreated, onError }: { configuration?: WorkbenchConfiguration; csrf: string; onClose(): void; onCreated(c: Conversation): void; onError(reason: unknown): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [harness, setHarness] = useState<'codex' | 'dsh'>(configuration?.harnesses.find(h => h.available)?.id ?? 'codex');
  const catalog = configuration?.harnesses.find(h => h.id === harness);
  const [workspace, setWorkspace] = useState(configuration?.workspaces[0]?.id ?? '');
  const [model, setModel] = useState(catalog?.models[0]?.id ?? '');
  const [permission, setPermission] = useState(catalog?.permissions[0]?.id ?? '');
  const [title, setTitle] = useState(''); const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const submission = useRef<unknown>(undefined);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => { if (!submission.current) { setModel(catalog?.models[0]?.id ?? ''); setPermission(catalog?.permissions[0]?.id ?? ''); setWorkspace(current => current || configuration?.workspaces[0]?.id || ''); } }, [harness, configuration]);
  const create = async () => {
    if (busy) return; setBusy(true); setFailed(false);
    submission.current ??= { id: crypto.randomUUID(), harnessId: harness, workspaceId: workspace, configuration: { modelId: model, permissionId: permission }, ...(title.trim() ? { title: title.trim() } : {}) };
    try { const result = await request('/conversations', conversationResponseSchema, { csrf, body: submission.current }); onCreated(result.conversation); }
    catch (reason) { setFailed(true); onError(reason); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="create-dialog" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}><form onSubmit={e => { e.preventDefault(); void create(); }}><header><h2>开始一段新对话</h2><button type="button" className="icon-button" aria-label="关闭新对话" disabled={busy} onClick={onClose}>×</button></header><p className="quiet">选择工作现场，模型和权限会在这段对话中保持不变。</p>
    <fieldset disabled={busy || !!submission.current}><label htmlFor="conversation-title">对话名称</label><input id="conversation-title" maxLength={60} placeholder="这次想完成什么？" value={title} onChange={e => setTitle(e.target.value)} /><label htmlFor="workspace">工作区</label><select id="workspace" value={workspace} onChange={e => setWorkspace(e.target.value)}>{configuration?.workspaces.map(w => <option key={w.id} value={w.id}>{w.label}</option>)}</select><label htmlFor="harness">Agent</label><select id="harness" value={harness} onChange={e => setHarness(e.target.value as 'codex' | 'dsh')}>{configuration?.harnesses.map(h => <option key={h.id} value={h.id} disabled={!h.available}>{h.id === 'codex' ? 'Codex' : 'DSH'}{!h.available ? ' · 未连接' : ''}</option>)}</select><label htmlFor="model">模型</label><select id="model" value={model} onChange={e => setModel(e.target.value)}>{catalog?.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select><label htmlFor="permission">权限</label><select id="permission" value={permission} onChange={e => setPermission(e.target.value)}>{catalog?.permissions.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select><p className="quiet permission-note">{catalog?.permissions.find(p => p.id === permission)?.description ?? catalog?.reason}</p></fieldset>
    {failed && <p role="status" className="state-notice">创建结果尚未确认。重试会核对同一个对话编号。</p>}
    <button className="primary" type="submit" disabled={busy || !workspace || !model || !permission || !catalog?.available}>{busy ? '正在创建…' : failed ? '核对创建结果' : '创建对话 ↗'}</button></form></dialog>;
}

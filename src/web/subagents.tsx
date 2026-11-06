import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { z } from 'zod';
import { Dialog } from 'radix-ui';
import { subagentHistorySchema, subagentListSchema, subagentStopResponseSchema, type Conversation, type SubagentList, type SubagentView, type WorkbenchItem } from '../shared/workbench.ts';
import type { MessageReference } from '../shared/content.ts';
import { request, RequestError } from './workbench-client.ts';
import { SubagentPanel, subagentBadges, type SubagentSummary } from './patterns/subagents.tsx';
import { Transcript } from './conversation-content.tsx';

const clock = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const minutes = (from: number, now: number) => {
  const value = Math.max(0, Math.floor((now - from) / 60_000));
  return value < 1 ? '不到 1 分钟' : value < 60 ? `${value} 分钟` : `${Math.floor(value / 60)} 小时 ${value % 60} 分钟`;
};
const ended = { completed: '完成', interrupted: '已停止', failed: '未完成', idle: '结束本轮' } as const;
export const harnessName = (conversation: Pick<Conversation, 'harnessId'>) => conversation.harnessId === 'codex' ? 'Codex' : 'DSH';

/** Presentation values derived from verified server facts. A pending stop is shown as stopping only while the agent still runs. */
/** Badges are computed over the whole list so a sub-agent keeps one badge in cards and panel alike. */
export function subagentDisplays(views: readonly SubagentView[], now: number): SubagentSummary[] {
  const badges = subagentBadges(views.map(view => view.name));
  return views.map((view, index) => ({ ...subagentDisplay(view, now), badge: badges[index]! }));
}
export function subagentDisplay(view: SubagentView, now: number): SubagentSummary {
  const stopping = view.status === 'running' && !!view.stop && ['queued', 'dispatching'].includes(view.stop.status);
  const stopUnverified = view.stop?.status === 'unknown' && ['running', 'unknown'].includes(view.status);
  const time = view.status === 'running' ? (view.startedAt ? `已运行 ${minutes(view.startedAt, now)}` : undefined)
    : view.status === 'unknown' ? (view.lastStatus === 'running' && view.verifiedAt ? `最后确认运行中 · ${clock(view.verifiedAt)}` : view.stop?.status === 'unknown' ? '停止回执未确认' : undefined)
    : view.endedAt ? `${clock(view.endedAt)} ${ended[view.status]}` : undefined;
  return { id: view.id, name: view.name, status: stopping ? 'stopping' : view.status,
    ...(view.task ? { task: view.task } : {}), ...(view.role ? { role: view.role } : {}), ...(view.model ? { model: view.model } : {}),
    ...(time ? { time } : {}), ...(view.spawnedBy ? { spawnedBy: view.spawnedBy } : {}),
    ...(view.external ? { external: '这个子 Agent ' } : {}), ...(stopUnverified ? { stopUnverified: true } : {}) };
}

/** The list follows the conversation summary revision; local reads are cheap and native reads happen server side only when needed. */
export function useSubagentList(conversation: Conversation | undefined, report: (reason: unknown) => void) {
  const [list, setList] = useState<SubagentList>();
  const [serial, setSerial] = useState(0);
  const id = conversation?.subagents ? conversation.id : undefined;
  const revision = conversation?.subagents?.revision;
  const reportRef = useRef(report); reportRef.current = report;
  useEffect(() => {
    setList(current => current && id ? current : undefined);
    if (!id) return;
    const controller = new AbortController();
    void request(`/conversations/${id}/subagents`, subagentListSchema, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setList(value); })
      .catch(reason => { if (!controller.signal.aborted) reportRef.current(reason); });
    return () => controller.abort();
  }, [id, revision, serial]);
  useEffect(() => { setList(undefined); }, [conversation?.id]);
  return { list: id ? list : undefined, reload: () => setSerial(value => value + 1) };
}

type Detail = { agentId: string; revision: number; brief?: string; items: WorkbenchItem[]; olderCursor: string | null; state: 'loading' | 'ready' | 'unavailable' };
const stopFailures: Record<string, string> = {
  subagent_not_running: '这个子 Agent 已不在运行。', subagent_state_unverified: '状态尚未核实，核实后才能停止。',
  subagent_stop_pending: '已经在停止这个子 Agent。', subagent_stop_unavailable: '当前原生服务不支持停止子 Agent。',
};

export function SubagentPanelHost({ conversation, list, selectedId, narrow, csrf, closeRef, onSelect, onClose, onReload, onQuote, report }: {
  conversation: Conversation; list: SubagentList | undefined; selectedId?: string; narrow: boolean; csrf: string;
  closeRef: RefObject<HTMLButtonElement | null>;
  onSelect(id: string | undefined, trigger?: HTMLButtonElement): void; onClose(): void; onReload(): void;
  onQuote(name: string, text: string): void; report(reason: unknown): void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [detail, setDetail] = useState<Detail>();
  const [notice, setNotice] = useState('');
  // Stops this page has requested whose outcome the list has not shown yet; they read as stopping immediately.
  const [requested, setRequested] = useState<ReadonlySet<string>>(() => new Set());
  const answered = useRef(new Set<string>());
  // DSH stops this page sent, by agent; their notice waits for the verified outcome, which arrives after the 202.
  const delivered = useRef(new Map<string, string>());
  const harness = harnessName(conversation);
  const selected = list?.agents.find(agent => agent.id === selectedId);
  const reportRef = useRef(report); reportRef.current = report;
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => { setNotice(''); }, [selectedId]);
  // A list read that arrives after the stop request returned carries the server's own stop state.
  useEffect(() => {
    if (!answered.current.size) return;
    const done = answered.current; answered.current = new Set();
    setRequested(current => new Set([...current].filter(id => !done.has(id))));
  }, [list]);
  useEffect(() => {
    for (const [agentId, stopId] of delivered.current) {
      const stop = list?.agents.find(agent => agent.id === agentId)?.stop;
      if (stop?.id !== stopId || !['accepted', 'unknown', 'rejected'].includes(stop.status)) continue;
      delivered.current.delete(agentId);
      // DSH reports a stopped child to its parent; an idle parent starts a new turn on that notice.
      if (stop.status === 'accepted') setNotice('DSH 已接受停止请求，会把停止结果告诉主 Agent；主 Agent 空闲时会因此自动开始新的一轮。');
    }
  }, [list]);
  // Move focus into the panel when it opens or changes view; the opener regains it on close.
  useEffect(() => { if (!narrow) requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true })); }, [selectedId, narrow, closeRef]);

  // Refetch the latest page whenever the agent's revision changes; keep older pages the reader already loaded.
  useEffect(() => {
    if (!selected) { setDetail(undefined); return; }
    if (selected.external) { setDetail({ agentId: selected.id, revision: selected.revision, items: [], olderCursor: null, state: 'ready' }); return; }
    const controller = new AbortController();
    setDetail(current => current?.agentId === selected.id ? current : { agentId: selected.id, revision: selected.revision, items: [], olderCursor: null, state: 'loading' });
    void request(`/conversations/${conversation.id}/subagents/${encodeURIComponent(selected.id)}/history`, subagentHistorySchema, { signal: controller.signal })
      .then(page => {
        if (controller.signal.aborted) return;
        setDetail(current => {
          // Items already shown but outside the latest page are older; their cursor still points before the first of them.
          const extras = current?.agentId === selected.id && current.state === 'ready' ? current.items.filter(item => !page.items.some(next => next.id === item.id)) : [];
          const items = [...extras, ...page.items].slice(-300);
          return { agentId: selected.id, revision: selected.revision, ...(page.brief ? { brief: page.brief } : {}),
            items, olderCursor: extras.length && items.length === extras.length + page.items.length ? current!.olderCursor : page.olderCursor, state: 'ready' };
        });
      })
      .catch(reason => {
        if (controller.signal.aborted) return;
        setDetail({ agentId: selected.id, revision: selected.revision, items: [], olderCursor: null, state: 'unavailable' });
        if (!(reason instanceof RequestError) || reason.status === 401) reportRef.current(reason);
      });
    return () => controller.abort();
  }, [conversation.id, selected?.id, selected?.revision, selected?.external]);

  // A reading lease keeps the sub-agent's live hints flowing while it is open.
  useEffect(() => {
    if (!selectedId) return;
    const readerId = crypto.randomUUID();
    const path = `/conversations/${conversation.id}/subagents/${encodeURIComponent(selectedId)}/reading`;
    const renew = () => { void request(path, z.object({ ok: z.literal(true) }), { csrf, body: { readerId, active: document.visibilityState === 'visible' } }).catch(() => {}); };
    renew();
    const timer = setInterval(renew, 15_000);
    document.addEventListener('visibilitychange', renew);
    return () => {
      clearInterval(timer); document.removeEventListener('visibilitychange', renew);
      void request(path, z.object({ ok: z.literal(true) }), { csrf, body: { readerId, active: false } }).catch(() => {});
    };
  }, [conversation.id, selectedId, csrf]);

  const older = async () => {
    if (!detail?.olderCursor || !selected) return;
    const agentId = selected.id; const cursor = detail.olderCursor;
    try {
      const page = await request(`/conversations/${conversation.id}/subagents/${encodeURIComponent(agentId)}/history?cursor=${encodeURIComponent(cursor)}`, subagentHistorySchema);
      setDetail(current => current?.agentId === agentId ? { ...current, items: [...page.items.filter(item => !current.items.some(old => old.id === item.id)), ...current.items], olderCursor: page.olderCursor } : current);
    } catch (reason) { reportRef.current(reason); }
  };
  const stop = async (agentId: string) => {
    setNotice('');
    setRequested(current => new Set(current).add(agentId));
    try {
      const result = await request(`/conversations/${conversation.id}/subagents/${encodeURIComponent(agentId)}/stop`, subagentStopResponseSchema, { csrf, body: { id: crypto.randomUUID() } });
      // An unconfirmed stop has its own callout; only a delivered one is described as reaching the main agent.
      if (conversation.harnessId === 'dsh') delivered.current.set(agentId, result.stop.id);
    } catch (reason) {
      if (reason instanceof RequestError && stopFailures[reason.code]) setNotice(stopFailures[reason.code]!); else reportRef.current(reason);
    } finally { answered.current.add(agentId); onReload(); }
  };
  const reconcileStop = async (agentId: string) => {
    const stopId = list?.agents.find(agent => agent.id === agentId)?.stop?.id;
    if (!stopId) return;
    try {
      const result = await request(`/conversations/${conversation.id}/subagent-stops/${stopId}/reconcile`, subagentStopResponseSchema, { csrf, body: {} });
      if (result.stop.status === 'unknown') setNotice('仍无法确认停止结果；没有重复发送停止请求。子 Agent 仍在运行时可以再次停止。');
    } catch (reason) { reportRef.current(reason); }
    finally { onReload(); }
  };
  const agents = useMemo(() => subagentDisplays(list?.agents ?? [], now)
    .map(agent => agent.status === 'running' && requested.has(agent.id) ? { ...agent, status: 'stopping' as const } : agent), [list, now, requested]);
  const selectedDisplay = selected ? agents.find(agent => agent.id === selected.id) : undefined;
  const transcript = selected && detail?.agentId === selected.id && <>
    {detail.olderCursor && <button type="button" className="load-history" onClick={() => void older()}>查看更早的内容</button>}
    {detail.items.length ? <Transcript conversation={`subagent-${selected.id}`} items={detail.items}
      onQuote={(reference: MessageReference) => { if (reference.type === 'quote') onQuote(selected.name, reference.text); }}/>
      : <p className="quiet">原生过程里还没有可显示的内容。</p>}
  </>;
  const panel = <>
    {notice && <p className="subagent-callout subagent-notice" role="status">{notice}</p>}
    <SubagentPanel harness={harness} agents={agents} {...(list?.team ? { team: list.team } : {})} stale={!!list?.stale}
      {...(selectedDisplay ? { selected: selectedDisplay } : {})} {...(detail?.brief && detail.agentId === selected?.id ? { brief: detail.brief } : {})}
      detail={transcript} detailState={detail?.agentId === selected?.id ? detail?.state ?? 'loading' : 'loading'} closeRef={closeRef}
      onSelect={(id, trigger) => onSelect(id, trigger)} onBack={() => onSelect(undefined)} onStop={id => void stop(id)}
      onRecheck={onReload} onReconcileStop={id => void reconcileStop(id)} onClose={onClose}/>
  </>;
  if (!narrow) return <aside className="workspace-reader subagent-panel" aria-label="子 Agent"
    onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>{panel}</aside>;
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Content className="workspace-reader subagent-panel subagent-sheet" aria-describedby={undefined}
        onCloseAutoFocus={event => event.preventDefault()}>
        <Dialog.Title className="sr-only">子 Agent</Dialog.Title>
        {panel}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

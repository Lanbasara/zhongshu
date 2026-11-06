import { useId, useState, type ReactNode, type Ref } from 'react';
import { Tabs } from 'radix-ui';
import { ChevronDown, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, RefreshCw, Square, Users, X } from 'lucide-react';
import { Button, IconButton } from '../ui/controls.tsx';
import './subagents.css';

/** Native sub-agent status as last verified by the workbench; `stopping` is a pending stop operation. */
export type SubagentStatus = 'running' | 'stopping' | 'idle' | 'completed' | 'interrupted' | 'failed' | 'unknown';
export type SubagentSummary = {
  id: string;
  name: string;
  task?: string;
  role?: string;
  model?: string;
  status: SubagentStatus;
  /** Display text such as elapsed or finish time; the caller owns clocks. */
  time?: string;
  /** Present when another sub-agent, not the conversation's main agent, spawned this one. */
  spawnedBy?: string;
  /** External backends only report a final result, never a native transcript. */
  external?: string;
  /** A stop whose native receipt has not been verified. */
  stopUnverified?: boolean;
  /** Short avatar text chosen by the caller so siblings stay distinguishable. */
  badge?: string;
};
export type TeamMember = { id: string; name: string; status: 'running' | 'idle' | 'unknown'; lead?: boolean; agentId?: string };
export type TeamTask = { id: string; title: string; description: string; status: 'pending' | 'in_progress' | 'completed'; owner?: string; writeScopes: string[] };
export type TeamSnapshot = { members: TeamMember[]; tasks: TeamTask[] };

export const subagentStatusLabel: Record<SubagentStatus, string> = {
  running: '运行中', stopping: '正在停止…', idle: '空闲', completed: '已完成', interrupted: '已停止', failed: '未完成', unknown: '待核实',
};
const active = (status: SubagentStatus) => status === 'running' || status === 'stopping';
/** Visible and accessible status text; an unconfirmed stop outranks the last verified status. */
const statusText = (agent: Pick<SubagentSummary, 'status' | 'stopUnverified'>) => agent.stopUnverified ? '停止待核实' : subagentStatusLabel[agent.status];
const memberLabel = { running: '运行中', idle: '未运行', unknown: '待核实' } as const;
const taskLabel = { pending: '待处理', in_progress: '进行中', completed: '已完成' } as const;

function StatusMark({ status }: { status: SubagentStatus | TeamMember['status'] | TeamTask['status'] }) {
  return <span className={`subagent-status-mark is-${status}`} aria-hidden="true"/>;
}
/** First and last segment initials keep siblings such as browser_a / browser_b or agent_1 / agent_2 apart. */
export function subagentInitials(name: string): string {
  const parts = name.trim().split(/[\s_\-/.]+/).filter(Boolean);
  return (parts.length > 1 ? [parts[0]!, parts.at(-1)!].map(part => [...part][0]).join('') : [...(parts[0] ?? '?')].slice(0, 2).join('')).toUpperCase();
}
/** Initials when unique in the list; otherwise the first letter plus the agent's position, so siblings never share a badge. */
export function subagentBadges(names: readonly string[]): string[] {
  const initials = names.map(subagentInitials);
  return initials.map((value, index) => initials.indexOf(value) === initials.lastIndexOf(value) ? value : `${[...value][0] ?? '?'}${index + 1}`);
}
function Avatar({ name, badge }: { name: string; badge?: string }) {
  return <span className="subagent-avatar" aria-hidden="true">{badge ?? subagentInitials(name)}</span>;
}

/** Header entry. Hidden by the caller when the conversation has no sub-agents. */
export function SubagentTrigger({ running, unverified = 0, total, attention, expanded, onClick, ref }: {
  running: number; unverified?: number; total: number; attention?: boolean; expanded: boolean; onClick(): void; ref?: Ref<HTMLButtonElement>;
}) {
  const label = running ? `子 Agent，${running} 个运行中，共 ${total} 个`
    : unverified ? `子 Agent，${unverified} 个状态待核实，共 ${total} 个`
    : `子 Agent，共 ${total} 个${attention ? '，结果待处理' : ''}`;
  return <button ref={ref} type="button" className={`subagent-trigger ${running ? 'is-running' : ''}`} aria-expanded={expanded}
    aria-label={label} onClick={onClick}>
    <Users size={15} aria-hidden="true"/>
    <span className="subagent-trigger-label">子 Agent</span>
    {running ? <span className="subagent-trigger-count"><span className="activity-dot"/>{running} 运行中</span>
      : unverified ? <span className="subagent-trigger-count"><i className="subagent-attention" aria-hidden="true"/>{unverified} 待核实</span>
      : <span className="subagent-trigger-count">{total}{attention && <i className="subagent-attention" aria-hidden="true"/>}</span>}
  </button>;
}

function AgentRow({ agent, stale, onSelect, onStop }: RowActions & { agent: SubagentSummary }) {
  const meta = [agent.external && '外部执行', agent.task, agent.spawnedBy && `由 ${agent.spawnedBy} 派出`].filter(Boolean).join(' · ');
  return <li className="subagent-row">
    <button type="button" className="subagent-row-main" onClick={event => onSelect(agent.id, event.currentTarget)}
      aria-label={`查看 ${agent.name} 的过程，${statusText(agent)}`}>
      <Avatar name={agent.name} badge={agent.badge}/>
      <span className="subagent-row-text">
        <strong>{agent.name}</strong>
        {meta && <small>{meta}</small>}
      </span>
      <span className="subagent-row-state">
        <span className={`subagent-status is-${agent.status}`}><StatusMark status={agent.status}/>{statusText(agent)}</span>
        {agent.time && <small>{agent.time}</small>}
      </span>
      <ChevronRight size={15} aria-hidden="true"/>
    </button>
    {agent.status === 'running' ? <Button variant="quiet" className="subagent-stop" aria-label={`停止 ${agent.name}`}
      title={stale ? '连接恢复并核实状态后才能停止' : undefined} disabled={stale}
      onClick={() => onStop(agent.id)}>停止</Button>
      : <span className="subagent-stop" aria-hidden="true"/>}
  </li>;
}

type RowActions = { stale?: boolean; onSelect(id: string, trigger: HTMLButtonElement): void; onStop(id: string): void };
function AgentGroup({ title, agents, empty, ...actions }: RowActions & { title: string; agents: SubagentSummary[]; empty?: string }) {
  return <section className="subagent-group">
    <h3>{title}<span>{agents.length}</span></h3>
    {agents.length ? <ul role="list">{agents.map(agent => <AgentRow key={agent.id} agent={agent} {...actions}/>)}</ul>
      : <p className="subagent-empty">{empty}</p>}
  </section>;
}
/** Unverified agents are never counted as running or as finished. */
function AgentList({ agents, ...actions }: RowActions & { agents: SubagentSummary[] }) {
  const unverified = agents.filter(agent => agent.status === 'unknown');
  const rest = agents.filter(agent => !active(agent.status) && agent.status !== 'unknown');
  return <div className="subagent-groups">
    <AgentGroup title="运行中" agents={agents.filter(agent => active(agent.status))} empty="没有已确认正在运行的子 Agent" {...actions}/>
    {unverified.length > 0 && <AgentGroup title="待核实" agents={unverified} {...actions}/>}
    {rest.length > 0 && <AgentGroup title="未运行" agents={rest} {...actions}/>}
  </div>;
}

function TaskCard({ task }: { task: TeamTask }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <li className="team-task">
    <div className="team-task-head">
      <strong>{task.title}</strong>
      <span className={`subagent-status is-${task.status}`}><StatusMark status={task.status}/>{taskLabel[task.status]}</span>
    </div>
    <p id={id} className={open ? 'is-open' : ''}>{task.description}</p>
    <div className="team-task-meta">
      <span>{task.id}</span>{task.owner && <span>负责人 {task.owner}</span>}
      <span className="team-task-scope">写入范围 {task.writeScopes.join('，')}</span>
      <button type="button" className="text-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        {open ? '收起' : '展开'}<ChevronDown size={13} aria-hidden="true"/>
      </button>
    </div>
  </li>;
}

function TeamView({ team, onSelect }: { team: TeamSnapshot; onSelect(id: string, trigger: HTMLButtonElement): void }) {
  return <div className="subagent-groups">
    <section className="subagent-group">
      <h3>成员<span>{team.members.length}</span></h3>
      <ul role="list" className="team-members">
        {team.members.map(member => <li key={member.id}>
          {member.lead || !member.agentId ? <div className="team-member is-lead">
            <span className="team-member-name">{member.name}{member.lead && <em>本对话</em>}</span>
            <span className={`subagent-status is-${member.status}`}><StatusMark status={member.status}/>{memberLabel[member.status]}</span>
          </div> : <button type="button" className="team-member" aria-label={`查看成员 ${member.name} 的过程`}
            onClick={event => onSelect(member.agentId!, event.currentTarget)}>
            <span className="team-member-name">{member.name}</span>
            <span className={`subagent-status is-${member.status}`}><StatusMark status={member.status}/>{memberLabel[member.status]}</span>
          </button>}
        </li>)}
      </ul>
    </section>
    <section className="subagent-group">
      <h3>共享任务<span>{team.tasks.length}</span></h3>
      <ul role="list" className="team-tasks">{team.tasks.map(task => <TaskCard key={task.id} task={task}/>)}</ul>
    </section>
  </div>;
}

/**
 * The panel only presents verified snapshots and forwards intents. The workbench owns
 * native reads, observation leases, stop operations and their reconciliation.
 */
export function SubagentPanel({ harness, agents, team, stale, selected, brief, detail, detailState, closeRef, onSelect, onBack, onStop, onRecheck, onReconcileStop, onClose }: {
  harness: string;
  agents: SubagentSummary[];
  team?: TeamSnapshot;
  /** The native host is unreachable; rows are last-known facts, not live state. */
  stale?: boolean;
  selected?: SubagentSummary;
  /** The instruction the spawning agent gave; shown as delegated input, never as the user's message. */
  brief?: string;
  detail?: ReactNode;
  detailState?: 'loading' | 'ready' | 'unavailable';
  closeRef?: Ref<HTMLButtonElement>;
  onSelect(id: string, trigger: HTMLButtonElement): void;
  onBack(): void;
  onStop(id: string): void;
  onRecheck(): void;
  /** Query the native result of an unverified stop; never resends it. */
  onReconcileStop(id: string): void;
  onClose(): void;
}) {
  const [tab, setTab] = useState('agents');
  const running = agents.filter(agent => active(agent.status)).length;
  const staleNotice = stale && <p className="subagent-stale" role="status"><CircleAlert size={15} aria-hidden="true"/>
    <span>暂时连不上 {harness}，以下是最后已知状态。</span>
    <button type="button" className="text-button" onClick={onRecheck}><RefreshCw size={13} aria-hidden="true"/>重新核对</button></p>;

  if (selected) {
    const meta = [selected.role, selected.model, selected.spawnedBy ? `由 ${selected.spawnedBy} 派出` : '由主 Agent 派出'].filter(Boolean).join(' · ');
    return <>
      <div className="workspace-reader-bar subagent-bar">
        <IconButton label="返回子 Agent 列表" onClick={onBack}><ChevronLeft size={17} aria-hidden="true"/></IconButton>
        <span className="subagent-bar-title"><strong>{selected.name}</strong>
          <span className={`subagent-status is-${selected.status}`}><StatusMark status={selected.status}/>{statusText(selected)}</span></span>
        {selected.status === 'running' && <Button className="subagent-detail-stop" disabled={stale} onClick={() => onStop(selected.id)}><Square size={12} aria-hidden="true"/>停止</Button>}
        <button ref={closeRef} type="button" className="reader-icon" aria-label="关闭子 Agent 面板" onClick={onClose}><X size={17} aria-hidden="true"/></button>
      </div>
      {staleNotice}
      <div className="workspace-reader-content subagent-detail">
        <p className="subagent-meta">{meta}{selected.time && <> · {selected.time}</>}</p>
        {selected.stopUnverified && <p className="subagent-callout">停止请求已发出，但还没有收到 {harness} 的确认。<button type="button" className="text-button" onClick={() => onReconcileStop(selected.id)}>查询原生结果</button></p>}
        {brief && <section className="subagent-brief" aria-label="主 Agent 交代的任务"><h4>{selected.spawnedBy ?? '主 Agent'} 交代的任务</h4><p>{brief}</p></section>}
        {selected.external ? <p className="subagent-callout"><ExternalLink size={14} aria-hidden="true"/>{selected.external}在 {harness} 之外执行，只回传最终结果，没有可查看的过程记录。</p>
          : detailState === 'unavailable' ? <p className="subagent-callout">过程记录需要从 {harness} 读取，现在连不上。名单和最后状态仍可查看。<button type="button" className="text-button" onClick={onRecheck}>重试</button></p>
          : detailState === 'loading' ? <p className="quiet" role="status">正在读取原生过程…</p>
          : <div className="subagent-transcript">{detail}</div>}
        <p className="subagent-readonly">只读。要调整这个子 Agent 的工作，请在主对话里告诉主 Agent。</p>
      </div>
    </>;
  }

  return <>
    <div className="workspace-reader-bar subagent-bar">
      <Users size={17} aria-hidden="true"/>
      <span className="subagent-bar-title"><strong>子 Agent</strong><span className="subagent-bar-count">{running ? `${running} 运行中 · ` : ''}共 {agents.length} 个</span></span>
      <button ref={closeRef} type="button" className="reader-icon" aria-label="关闭子 Agent 面板" onClick={onClose}><X size={17} aria-hidden="true"/></button>
    </div>
    {staleNotice}
    <div className="workspace-reader-content subagent-list">
      {team ? <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="subagent-tabs" aria-label="子 Agent 视图">
          <Tabs.Trigger value="agents">全部子 Agent</Tabs.Trigger>
          <Tabs.Trigger value="team">团队</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="agents"><AgentList agents={agents} stale={stale} onSelect={onSelect} onStop={onStop}/></Tabs.Content>
        <Tabs.Content value="team"><TeamView team={team} onSelect={onSelect}/></Tabs.Content>
      </Tabs.Root> : <AgentList agents={agents} stale={stale} onSelect={onSelect} onStop={onStop}/>}
    </div>
  </>;
}

/** A compact transcript card for native collaboration items; it never inlines a child transcript. */
export function SubagentActivity({ action, agents, onOpen }: {
  action: 'started' | 'completed' | 'interrupted' | 'closed' | 'messaged' | 'waiting';
  agents: Pick<SubagentSummary, 'id' | 'name' | 'task' | 'status' | 'badge' | 'stopUnverified'>[];
  onOpen(id: string, trigger: HTMLButtonElement): void;
}) {
  const title = action === 'started' ? `派出 ${agents.length} 个子 Agent`
    : action === 'completed' ? `${agents.length} 个子 Agent 已结束`
    : action === 'interrupted' ? `停止了 ${agents.map(agent => agent.name).join('、')}`
    : action === 'closed' ? `关闭了 ${agents.map(agent => agent.name).join('、')}`
    : action === 'messaged' ? `向 ${agents.map(agent => agent.name).join('、')} 发送了新任务`
    : `等待 ${agents.length} 个子 Agent`;
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const extra = agents.length - 3;
  return <section className="subagent-activity" aria-label={title}>
    <header><Users size={15} aria-hidden="true"/><h2>{title}</h2></header>
    <ul role="list" id={id}>{agents.map((agent, index) => <li key={agent.id} hidden={!expanded && index >= 3}>
      <button type="button" className="subagent-activity-row" onClick={event => onOpen(agent.id, event.currentTarget)}
        aria-label={`查看 ${agent.name} 的过程，${statusText(agent)}`}>
        <Avatar name={agent.name} badge={agent.badge}/>
        <span className="subagent-row-text"><strong>{agent.name}</strong>{agent.task && <small>{agent.task}</small>}</span>
        <span className={`subagent-status is-${agent.status}`}><StatusMark status={agent.status}/>{statusText(agent)}</span>
        <ChevronRight size={15} aria-hidden="true"/>
      </button>
    </li>)}</ul>
    {extra > 0 && <Button variant="quiet" className="subagent-activity-toggle" aria-controls={id} aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : `再显示 ${extra} 个`}<ChevronDown size={14} aria-hidden="true"/></Button>}
  </section>;
}

/** Sidebar hint: the main agent is idle but delegated work continues. */
export function SubagentBackgroundMark({ running, unverified = 0 }: { running: number; unverified?: number }) {
  if (!running && unverified) return <i className="subagent-background is-unverified"><span className="subagent-attention" aria-hidden="true"/>子 Agent 待核实</i>;
  return <i className="subagent-background"><span className="activity-dot" aria-hidden="true"/>{running} 个子 Agent 运行中</i>;
}

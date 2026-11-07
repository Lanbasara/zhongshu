import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Dialog } from 'radix-ui';
import { Transcript } from '../../src/web/conversation-content.tsx';
import { SubagentActivity, SubagentBackgroundMark, SubagentPanel, SubagentTrigger, subagentBadges, type SubagentSummary } from '../../src/web/patterns/subagents.tsx';
import { useNarrow } from '../../src/web/patterns/workbench-frame.tsx';
import { subagents, subagentTranscript, team } from './fixtures.tsx';
import { Page, Section, Stage, phone, useReadout } from './catalog.tsx';

type Args = {
  harness: 'Codex' | 'DSH'; agents: 'mixed' | 'running' | 'finished' | 'unverified'; team: boolean; stale: boolean; stopReceipt: 'confirmed' | 'unknown';
  selected: string; detailState: 'ready' | 'loading' | 'unavailable'; brief: boolean;
  running: number; unverified: number; total: number; attention: boolean; expanded: boolean;
  action: 'started' | 'completed' | 'interrupted' | 'closed' | 'messaged' | 'waiting'; count: number;
};

function agentSet(kind: Args['agents']): SubagentSummary[] {
  const list = kind === 'running' ? subagents.slice(0, 3)
    : kind === 'finished' ? subagents.map(agent => agent.status === 'running' ? { ...agent, status: 'completed' as const, time: '10:30 完成' } : agent)
    : kind === 'unverified' ? subagents.map(agent => agent.status === 'running' ? { ...agent, status: 'unknown' as const, time: '最后确认运行中 · 10:31' } : agent)
    : subagents;
  const badges = subagentBadges(list.map(agent => agent.name));
  return list.map((agent, index) => ({ ...agent, badge: badges[index]! }));
}

/** Host for the panel, as the workbench does it: a side panel on desktop, a full-page sheet on phones. */
function PanelHost({ children }: { children: ReactNode }) {
  const narrow = useNarrow();
  if (!narrow) return <div className="catalog-panel"><aside className="workspace-reader subagent-panel" aria-label="子 Agent">{children}</aside></div>;
  return <Dialog.Root open><Dialog.Portal><Dialog.Content className="workspace-reader subagent-panel subagent-sheet" aria-describedby={undefined}>
    <Dialog.Title className="sr-only">子 Agent</Dialog.Title>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function PanelDemo(args: Args) {
  const [agents, setAgents] = useState(() => agentSet(args.agents));
  const [selectedId, setSelectedId] = useState(args.selected || undefined);
  const [readout, say] = useReadout();
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const selected = agents.find(agent => agent.id === selectedId);
  function stop(id: string) {
    say(`停止 ${id}`);
    setAgents(list => list.map(agent => agent.id === id ? { ...agent, status: 'stopping', time: '刚刚请求停止' } : agent));
    timers.current.push(window.setTimeout(() => setAgents(list => list.map(agent => agent.id !== id ? agent
      : args.stopReceipt === 'unknown' ? { ...agent, status: 'unknown', stopUnverified: true, time: '停止回执未确认' }
      : { ...agent, status: 'interrupted', time: '刚刚停止' })), 1200));
  }
  const reconcile = () => setAgents(list => list.map(agent => agent.stopUnverified ? { ...agent, status: 'interrupted', stopUnverified: false, time: '已核实停止' } : agent));
  return <div style={{ display: 'flex', minHeight: '100dvh' }}>
    <div style={{ flex: 1, padding: 32 }}>
      <p className="catalog-muted" style={{ maxWidth: 420, lineHeight: 1.7 }}>面板只展示已核实的原生快照并转交意图：点一行看该子 Agent 的过程，运行中的可以停止。未核实的状态既不算运行中，也不算已结束。</p>
      {readout}
    </div>
    <PanelHost>
      <SubagentPanel harness={args.harness} agents={agents} team={args.team ? team : undefined} stale={args.stale} selected={selected}
        brief={args.brief && selected ? `完成「${selected.task ?? selected.name}」，交付结果和核对记录。` : undefined}
        detailState={args.detailState}
        detail={selected && <Transcript conversation={`child-${selected.id}`} items={subagentTranscript(selected)} onQuote={reference => say(`引用：${reference.type === 'quote' ? reference.text : reference.path}`)}/>}
        onSelect={id => { setSelectedId(id); say(`查看 ${id}`); }} onBack={() => setSelectedId(undefined)} onStop={stop}
        onRecheck={() => { reconcile(); say('重新核对'); }} onReconcileStop={id => { reconcile(); say(`查询 ${id} 的原生结果`); }} onClose={() => say('关闭面板')}/>
    </PanelHost>
  </div>;
}

function TriggerDemo({ running, unverified, total, attention, expanded }: Args) {
  const [open, setOpen] = useState(expanded);
  return <Page title="子 Agent 入口" lead="放在页头右侧；对话没有子 Agent 时不显示。运行中优先显示数量，其次是待核实，最后是总数和“结果待处理”的提示点。手机上只显示图标和数量。">
    <Stage><div className="header-actions"><SubagentTrigger running={running} unverified={unverified} total={Math.max(total, running + unverified, 1)} attention={attention} expanded={open} onClick={() => setOpen(value => !value)}/></div></Stage>
    <Section title="常见组合"><Stage>
      <SubagentTrigger running={2} total={4} expanded={false} onClick={() => {}}/>
      <SubagentTrigger running={0} unverified={1} total={4} expanded={false} onClick={() => {}}/>
      <SubagentTrigger running={0} total={6} attention expanded={false} onClick={() => {}}/>
      <SubagentTrigger running={0} total={3} expanded onClick={() => {}}/>
    </Stage></Section>
  </Page>;
}

function ActivityDemo({ action, count }: Args) {
  const [readout, say] = useReadout();
  const agents = agentSet('mixed').slice(0, count);
  return <div className="catalog-column">
    <p className="catalog-muted" style={{ marginBottom: 12 }}>主对话里的协作记录，只显示名单与状态，不内嵌子 Agent 的过程；超过三个时折叠。</p>
    <SubagentActivity action={action} agents={agents} onOpen={id => say(`查看 ${id}`)}/>
    {readout}
  </div>;
}

function BackgroundDemo({ running, unverified }: Args) {
  return <Page title="侧栏后台标记" lead="主 Agent 已空闲但子 Agent 仍在工作时，对话行右侧显示这一标记；只有待核实时显示待核实。">
    <Stage tone="sidebar"><span className="conversation-meta"><SubagentBackgroundMark running={running} unverified={unverified}/></span></Stage>
  </Page>;
}

const meta = {
  title: '模式/子 Agent',
  component: PanelDemo,
  args: {
    harness: 'Codex', agents: 'mixed', team: false, stale: false, stopReceipt: 'confirmed', selected: '', detailState: 'ready', brief: true,
    running: 2, unverified: 0, total: 4, attention: false, expanded: false, action: 'started', count: 3,
  },
  argTypes: {
    harness: { control: 'inline-radio', options: ['Codex', 'DSH'] },
    agents: { control: 'inline-radio', options: ['mixed', 'running', 'finished', 'unverified'] },
    stopReceipt: { control: 'inline-radio', options: ['confirmed', 'unknown'] },
    selected: { control: 'select', options: ['', ...subagents.map(agent => agent.id)] },
    detailState: { control: 'inline-radio', options: ['ready', 'loading', 'unavailable'] },
    action: { control: 'select', options: ['started', 'completed', 'interrupted', 'closed', 'messaged', 'waiting'] },
    count: { control: { type: 'range', min: 1, max: subagents.length, step: 1 } },
    running: { control: { type: 'number', min: 0, max: 20 } },
    unverified: { control: { type: 'number', min: 0, max: 20 } },
    total: { control: { type: 'number', min: 1, max: 20 } },
  },
  render: args => <PanelDemo key={JSON.stringify(args)} {...args}/>,
} satisfies Meta<typeof PanelDemo>;
export default meta;
type Story = StoryObj<typeof meta>;
const panelControls = { controls: { include: ['harness', 'agents', 'team', 'stale', 'stopReceipt', 'selected', 'detailState', 'brief'] } };

export const List: Story = { name: '面板 · 列表', parameters: panelControls };
export const AllFinished: Story = { name: '面板 · 都已结束', args: { agents: 'finished' }, parameters: panelControls };
export const Team: Story = { name: '面板 · 团队（成员与共享任务）', args: { harness: 'DSH', team: true }, parameters: panelControls };
export const Stale: Story = { name: '面板 · Host 暂时连不上', args: { harness: 'DSH', agents: 'unverified', stale: true }, parameters: panelControls };
export const StopUnverified: Story = { name: '面板 · 停止回执未确认（点“停止”）', args: { stopReceipt: 'unknown' }, parameters: panelControls };
export const Detail: Story = { name: '详情 · 运行中', args: { selected: 'agent-1' }, parameters: panelControls };
export const DetailLoading: Story = { name: '详情 · 正在读取', args: { selected: 'agent-3', detailState: 'loading' }, parameters: panelControls };
export const DetailUnavailable: Story = { name: '详情 · 过程不可读', args: { selected: 'agent-3', detailState: 'unavailable' }, parameters: panelControls };
export const DetailExternal: Story = { name: '详情 · 外部执行', args: { selected: 'agent-8' }, parameters: panelControls };
export const DetailNested: Story = { name: '详情 · 由子 Agent 派出', args: { selected: 'agent-4' }, parameters: panelControls };
export const Trigger: Story = { name: '入口按钮', render: args => <TriggerDemo {...args}/>, parameters: { controls: { include: ['running', 'unverified', 'total', 'attention', 'expanded'] } } };
export const Activity: Story = { name: '对话中的协作记录', render: args => <ActivityDemo {...args}/>, parameters: { controls: { include: ['action', 'count'] } } };
export const Background: Story = { name: '侧栏后台标记', render: args => <BackgroundDemo {...args}/>, parameters: { controls: { include: ['running', 'unverified'] } } };
export const PhoneList: Story = { name: '手机 · 面板', globals: phone, parameters: panelControls };
export const PhoneDetail: Story = { name: '手机 · 详情', args: { selected: 'agent-1' }, globals: phone, parameters: panelControls };

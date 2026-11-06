import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Dialog } from 'radix-ui';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { Transcript } from '../../src/web/conversation-content.tsx';
import { ComposerView } from '../../src/web/patterns/composer.tsx';
import { WorkbenchFrame } from '../../src/web/patterns/workbench-frame.tsx';
import {
  SubagentActivity, SubagentBackgroundMark, SubagentPanel, SubagentTrigger,
  type SubagentSummary, type TeamSnapshot,
} from '../../src/web/patterns/subagents.tsx';
import { BrandMark, IconButton } from '../../src/web/ui/controls.tsx';
import type { WorkbenchItem } from '../../src/shared/workbench.ts';

/*
 * Prototype only. Every agent, status, timing and transcript here is simulated
 * in the browser; nothing reads Codex or DSH, and stop outcomes are scripted.
 */

type Scenario = 'none' | 'codex-running' | 'codex-pending' | 'dsh-stopped' | 'dsh-team' | 'dsh-unreachable';
type Fixture = {
  harness: 'Codex' | 'DSH';
  title: string;
  workspace: string;
  mainStatus: 'running' | 'idle' | 'interrupted' | 'unknown';
  agents: SubagentSummary[];
  team?: TeamSnapshot;
  stale?: boolean;
  transcript: (WorkbenchItem | { activity: 'started' | 'completed' | 'interrupted' | 'waiting'; ids: string[] })[];
  /** Codex keeps child results in the parent's mailbox until the next input. */
  resultsPending?: boolean;
};

const codexAgents: SubagentSummary[] = [
  { id: 'c1', name: 'browser_a', task: '独立浏览器 A：核心旅程', role: 'worker', model: 'GPT-6 Astra · 中', status: 'running', time: '已运行 6 分钟' },
  { id: 'c2', name: 'browser_b', task: '独立浏览器 B：归档与恢复', role: 'worker', model: 'GPT-6 Astra · 中', status: 'running', time: '已运行 6 分钟' },
  { id: 'c3', name: 'native_delete', task: '核对 Codex 原生删除', role: 'explorer', model: 'GPT-6 Luna · 低', status: 'completed', time: '14:58 完成' },
  { id: 'c4', name: 'delete_rollout', task: '确认 rollout 文件清理', role: 'explorer', model: 'GPT-6 Luna · 低', status: 'completed', time: '14:52 完成', spawnedBy: 'native_delete' },
];
const codexDone: SubagentSummary[] = [
  { id: 'c1', name: 'browser_a', task: '独立浏览器 A：核心旅程', role: 'worker', model: 'GPT-6 Astra · 中', status: 'completed', time: '15:22 完成' },
  { id: 'c2', name: 'browser_b', task: '独立浏览器 B：归档与恢复', role: 'worker', model: 'GPT-6 Astra · 中', status: 'completed', time: '15:19 完成' },
  { id: 'c3', name: 'native_delete', task: '核对 Codex 原生删除', role: 'explorer', model: 'GPT-6 Luna · 低', status: 'completed', time: '14:58 完成' },
  { id: 'c4', name: 'delete_rollout', task: '确认 rollout 文件清理', role: 'explorer', model: 'GPT-6 Luna · 低', status: 'completed', time: '14:52 完成', spawnedBy: 'native_delete' },
  { id: 'c5', name: 'observation', task: '观察租约回收', role: 'explorer', model: 'GPT-6 Luna · 低', status: 'failed', time: '15:03 未完成' },
  { id: 'c6', name: 'navigation', task: '侧栏分页性能', role: 'worker', model: 'GPT-6 Astra · 中', status: 'interrupted', time: '15:10 已停止' },
];
const dshAgents: SubagentSummary[] = [
  { id: 'd1', name: 'us-market', task: '美股 11-05 收盘事实包与归因', model: 'deepseek-v4 · 高', status: 'running', time: '已运行 4 分钟' },
  { id: 'd2', name: 'asia-market', task: '日韩与亚太盘前事实包', model: 'deepseek-v4 · 高', status: 'running', time: '已运行 4 分钟' },
  { id: 'd3', name: 'a-share-setup', task: 'A 股收盘基准与敏感结构', model: 'deepseek-v4 · 高', status: 'completed', time: '09:12 完成' },
  { id: 'd4', name: 'analog-quant', task: '历史类比与条件概率', model: 'deepseek-v4 · 高', status: 'idle', time: '09:20 结束本轮' },
  { id: 'd5', name: 'reviewer', task: '交叉复核与反方论证', model: 'deepseek-v4 · 高', status: 'idle', time: '尚未开始' },
  { id: 'd6', name: 'codex-check', task: '用 Codex 复算关键数字', status: 'completed', time: '09:25 完成', external: 'Codex 子任务' },
];
const team: TeamSnapshot = {
  members: [
    { id: 'lead', name: 'lead', status: 'running', lead: true },
    { id: 'm1', name: 'us-market', status: 'running', agentId: 'd1' },
    { id: 'm2', name: 'asia-market', status: 'running', agentId: 'd2' },
    { id: 'm3', name: 'a-share-setup', status: 'idle', agentId: 'd3' },
    { id: 'm4', name: 'analog-quant', status: 'idle', agentId: 'd4' },
    { id: 'm5', name: 'reviewer', status: 'idle', agentId: 'd5' },
  ],
  tasks: [
    { id: 'task-1', title: '美股 11-05 收盘事实包与归因', status: 'in_progress', owner: 'us-market', writeScopes: ['2026-11-06/case-001/work/us-market.md', '2026-11-06/case-001/work/raw/us'],
      description: '指数/板块/个股精确数据、VIX/美债/黄金/油/美元、中期选举结果与 AI 资本开支质疑的归因、盘后与期货。交付 work/us-market.md + raw/us/。' },
    { id: 'task-2', title: '日韩与亚太盘前事实包及对 A 股的外溢信号', status: 'in_progress', owner: 'asia-market', writeScopes: ['2026-11-06/case-001/work/asia-pacific.md', '2026-11-06/case-001/work/raw/asia'],
      description: '日经/TOPIX/KOSPI/KOSDAQ 11-06 盘中跌幅与熔断细节、日债日元韩元、软银三星海力士、A50 期货/中概 ADR/CNH、政策表态。' },
    { id: 'task-3', title: 'A 股 11-05 收盘基准、盘前消息面与敏感结构', status: 'completed', owner: 'a-share-setup', writeScopes: ['2026-11-06/case-001/work/a-share-setup.md', '2026-11-06/case-001/work/raw/ashare'],
      description: 'A 股 11-05 收盘各指数/成交/涨跌停/两融/行业排名/技术位；11-05 15:00 后至 11-06 08:45 的 A 股相关消息与政策表态。' },
    { id: 'task-4', title: '历史类比与条件概率：美股科技暴跌后 A 股次日表现', status: 'pending', owner: 'analog-quant', writeScopes: ['2026-11-06/case-001/work/analog.md'],
      description: '筛选近 10 年美股科技单日跌幅超过 3% 的样本，统计 A 股次日开盘与收盘分布，并标注样本限制。' },
    { id: 'task-5', title: '交叉复核与反方论证', status: 'pending', owner: 'reviewer', writeScopes: ['2026-11-06/case-001/work/review.md'],
      description: '在前四项交付后，逐条核对数据来源与口径，给出最强反方论证和尚未覆盖的风险。' },
  ],
};

const fixtures: Record<Scenario, Fixture> = {
  none: { harness: 'Codex', title: '修复登录页文案', workspace: '中书', mainStatus: 'idle', agents: [], transcript: [
    { id: 'n1', kind: 'user', text: '把登录页的错误提示改得更清楚一点。', status: 'completed', runId: 'n' },
    { id: 'n2', kind: 'assistant', text: '已把三种失败分别说明，并保留原有的重试入口。', status: 'completed', runId: 'n' },
  ] },
  'codex-running': { harness: 'Codex', title: '验收会话生命周期改动', workspace: '中书', mainStatus: 'running', agents: codexAgents, transcript: [
    { id: 'r1', kind: 'user', text: '把会话生命周期的改动分头验收：两个独立浏览器各跑一遍核心旅程，另外核对原生删除。', status: 'completed', runId: 'r' },
    { id: 'r2', kind: 'assistant', text: '我派了三个子 Agent 分头验收，侧栏分页性能我自己先看。', status: 'completed', runId: 'r' },
    { activity: 'started', ids: ['c1', 'c2', 'c3'] },
    { id: 'r3', kind: 'tool', text: 'npm test', status: 'completed', runId: 'r', tool: { name: '运行命令', input: 'node --test test/workbench-store.test.ts', output: '# pass 48\n# fail 0' } },
    { activity: 'completed', ids: ['c3'] },
    { id: 'r4', kind: 'tool', text: '读取侧栏分页', status: 'running', runId: 'r', tool: { name: '运行命令', input: 'node scripts/measure-navigation.mjs' } },
  ] },
  'codex-pending': { harness: 'Codex', title: '验收会话生命周期改动', workspace: '中书', mainStatus: 'idle', resultsPending: true, agents: codexDone, transcript: [
    { id: 'p1', kind: 'user', text: '把会话生命周期的改动分头验收，结果汇总给我。', status: 'completed', runId: 'p' },
    { id: 'p2', kind: 'assistant', text: '我派了六个子 Agent 分头验收。它们还在运行，我先结束这一轮；结果回来后我再汇总。', status: 'completed', runId: 'p' },
    { activity: 'started', ids: ['c1', 'c2', 'c3', 'c5', 'c6'] },
  ] },
  'dsh-stopped': { harness: 'DSH', title: '11-06 开盘前市场简报', workspace: '见微研究', mainStatus: 'interrupted', agents: dshAgents.slice(0, 5), transcript: [
    { id: 's1', kind: 'user', text: '按 case-001 的结构准备今天开盘前的市场简报。', status: 'completed', runId: 's' },
    { id: 's2', kind: 'assistant', text: '我组建了一个五人的团队，先并行收集事实包，再交给 reviewer 复核。', status: 'completed', runId: 's' },
    { activity: 'started', ids: ['d1', 'd2', 'd3', 'd4', 'd5'] },
    { id: 's3', kind: 'notice', text: '本轮已中断。', status: 'completed', runId: 's' },
  ] },
  'dsh-team': { harness: 'DSH', title: '11-06 开盘前市场简报', workspace: '见微研究', mainStatus: 'running', agents: dshAgents, team, transcript: [
    { id: 't1', kind: 'user', text: '按 case-001 的结构准备今天开盘前的市场简报。', status: 'completed', runId: 't' },
    { id: 't2', kind: 'assistant', text: '我组建了一个五人的团队，先并行收集事实包，再交给 reviewer 复核。', status: 'completed', runId: 't' },
    { activity: 'started', ids: ['d1', 'd2', 'd3'] },
    { activity: 'completed', ids: ['d3'] },
    { activity: 'waiting', ids: ['d1', 'd2'] },
  ] },
  'dsh-unreachable': { harness: 'DSH', title: '11-06 开盘前市场简报', workspace: '见微研究', mainStatus: 'unknown', stale: true, agents: dshAgents.slice(0, 4).map(agent => agent.status === 'running' ? { ...agent, status: 'unknown', time: '最后确认运行中 · 09:31' } : agent), transcript: [
    { id: 'u1', kind: 'user', text: '按 case-001 的结构准备今天开盘前的市场简报。', status: 'completed', runId: 'u' },
    { activity: 'started', ids: ['d1', 'd2', 'd3', 'd4'] },
  ] },
};

const briefs: Record<string, string> = {
  c1: '用一个全新的浏览器上下文，按 docs/features/conversation-management.md 的 M01–M04 跑一遍核心旅程。只读 feature map，不看实现；记录每一步的截图和判据。',
  d1: '整理美股 11-05 收盘事实包：指数、板块、个股精确数据；VIX、美债、黄金、原油、美元；中期选举结果与 AI 资本开支质疑的归因。交付 work/us-market.md 与 raw/us/。',
};
function childItems(agent: SubagentSummary): WorkbenchItem[] {
  const run = `child-${agent.id}`;
  const running = agent.status === 'running' || agent.status === 'stopping';
  return [
    { id: `${run}-a`, kind: 'assistant', text: `收到。我先确认范围，再开始「${agent.task ?? agent.name}」。`, status: 'completed', runId: run },
    { id: `${run}-t1`, kind: 'tool', text: '读取资料', status: 'completed', runId: run, tool: { name: '运行命令', input: 'rg -n "case-001" work/', output: 'work/plan.md:3: case-001 结构\nwork/raw/README.md:1: 原始数据目录' } },
    { id: `${run}-t2`, kind: 'tool', text: '整理数据', status: running ? 'running' : 'completed', runId: run, tool: { name: '运行命令', input: 'python3 scripts/collect.py --date 2026-11-05' } },
    ...(running || agent.status === 'idle' ? [] : agent.status === 'interrupted' ? [{ id: `${run}-stopped`, kind: 'notice' as const, text: '本轮已中断。', status: 'completed' as const, runId: run }]
      : [{ id: `${run}-done`, kind: 'assistant' as const, text: agent.status === 'failed' ? '未能完成：原生观察租约在复现时已经被回收，需要主 Agent 决定是否重试。' : '已完成，交付文件与核对记录见上方。', status: 'completed' as const, runId: run }]),
  ];
}

function SubagentPrototype({ scenario, stopReceipt = 'confirmed' }: { scenario: Scenario; stopReceipt?: 'confirmed' | 'unknown' }) {
  const fixture = fixtures[scenario];
  const [agents, setAgents] = useState(fixture.agents);
  const [mainStatus, setMainStatus] = useState(fixture.mainStatus);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [text, setText] = useState('');
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width:759px)').matches);
  const [navigation, setNavigation] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const origin = useRef<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const query = matchMedia('(max-width:759px)');
    const resize = () => setNarrow(query.matches);
    query.addEventListener('change', resize);
    return () => { query.removeEventListener('change', resize); timers.current.forEach(clearTimeout); };
  }, []);
  useEffect(() => { if (open && !narrow) closeButton.current?.focus({ preventScroll: true }); }, [open, selectedId, narrow]);

  const running = agents.filter(agent => agent.status === 'running' || agent.status === 'stopping').length;
  const unverified = agents.filter(agent => agent.status === 'unknown').length;
  const selected = agents.find(agent => agent.id === selectedId);
  const byId = new Map(agents.map(agent => [agent.id, agent]));

  function openAgent(id?: string, from?: HTMLButtonElement) {
    origin.current = from ?? trigger.current;
    setSelectedId(id); setOpen(true);
  }
  function close() {
    setOpen(false); setSelectedId(undefined);
    if (!narrow) (origin.current?.isConnected ? origin.current : trigger.current)?.focus();
  }
  function stop(id: string) {
    setAgents(list => list.map(agent => agent.id === id ? { ...agent, status: 'stopping', time: '刚刚请求停止' } : agent));
    timers.current.push(window.setTimeout(() => setAgents(list => list.map(agent => agent.id !== id ? agent
      : stopReceipt === 'unknown' ? { ...agent, status: 'unknown', stopUnverified: true, time: '停止回执未确认' }
      : { ...agent, status: 'interrupted', time: '刚刚停止' })), 1200));
  }
  function recheck() {
    setAgents(list => list.map(agent => agent.stopUnverified ? { ...agent, status: 'interrupted', stopUnverified: false, time: '已核实停止' } : agent));
  }

  const panel = <SubagentPanel harness={fixture.harness} agents={agents} team={fixture.team} stale={fixture.stale}
    selected={selected} brief={selected && (briefs[selected.id] ?? `完成「${selected.task ?? selected.name}」，交付结果和核对记录。`)}
    detailState={fixture.stale ? 'unavailable' : 'ready'} closeRef={closeButton}
    detail={selected && <Transcript conversation={`child-${selected.id}`} items={childItems(selected)}
      onQuote={reference => { if (reference.type === 'quote') setText(value => `${value}${value ? '\n' : ''}> ${selected.name}：${reference.text}\n`); }}/>}
    onSelect={(id, from) => openAgent(id, from)} onBack={() => setSelectedId(undefined)}
    onStop={stop} onRecheck={recheck} onReconcileStop={recheck} onClose={close}/>;

  const mainLabel = mainStatus === 'running' ? '运行中' : mainStatus === 'interrupted' ? '已中断' : mainStatus === 'unknown' ? '待核实' : '空闲';
  const backgroundOnly = mainStatus !== 'running' && (running > 0 || unverified > 0);

  return <>
    <WorkbenchFrame navigationOpen={navigation} onNavigationChange={setNavigation}
      sidebar={<>
        <div className="workbench-brand"><BrandMark/><span>中书</span></div>
        <p className="nav-label">{fixture.workspace} · 模拟数据</p>
        <div className="conversation-row"><button type="button" className="conversation-link selected" onClick={() => setNavigation(false)}>
          <strong>{fixture.title}</strong>
          <span>{fixture.harness}{backgroundOnly ? <SubagentBackgroundMark running={running} unverified={unverified}/> : <i>{mainLabel}</i>}</span>
        </button></div>
        <div className="conversation-row"><button type="button" className="conversation-link" onClick={() => setNavigation(false)}>
          <strong>整理研究资料目录</strong><span>{fixture.harness}<i>空闲</i></span>
        </button></div>
      </>}
      header={<>
        <div className="conversation-heading"><h1>{fixture.title}</h1><p>{fixture.harness} · {fixture.workspace} · {mainLabel} · Storybook 模拟数据</p></div>
        <div className="header-actions">
          {agents.length > 0 && <SubagentTrigger ref={trigger} running={running} unverified={unverified} total={agents.length} attention={fixture.resultsPending}
            expanded={open} onClick={() => open ? close() : openAgent()}/>}
          <IconButton label="打开工作区文件"><FolderOpen size={17}/></IconButton>
          <IconButton label="重新连接"><RefreshCw size={15}/></IconButton>
        </div>
      </>}
      reader={open && !narrow && <aside className="workspace-reader subagent-panel" aria-label="子 Agent"
        onKeyDown={event => { if (event.key === 'Escape') close(); }}>{panel}</aside>}>
      <div className="message-scroll"><div className="message-column">
        {fixture.transcript.map((entry, index) => 'activity' in entry
          ? <SubagentActivity key={`activity-${index}`} action={entry.activity}
            agents={entry.ids.map(id => byId.get(id)).filter((agent): agent is SubagentSummary => !!agent)}
            onOpen={(id, from) => openAgent(id, from)}/>
          : <Transcript key={entry.id} conversation="subagent-prototype" items={[entry]} onQuote={() => {}}/>)}
      </div></div>
      <div className="composer-region">
        {mainStatus === 'interrupted' && running > 0 && <p className="state-notice" role="status">
          主 Agent 已停止，仍有 {running} 个子 Agent 在运行。{fixture.harness === 'DSH' && '它们完成后，DSH 可能让主 Agent 自动继续工作。'}
          <button type="button" className="text-button" onClick={() => openAgent()}>查看子 Agent</button>
        </p>}
        {mainStatus === 'interrupted' && running === 0 && <p className="state-notice">本轮已中断。此前启动的后台工具可能仍在运行，已经产生的改动不会撤销。</p>}
        {fixture.resultsPending && mainStatus === 'idle' && running === 0 && <p className="state-notice" role="status">
          子 Agent 在主 Agent 上一轮结束后才完成，主 Agent 要到下一轮才会读到它们的结果。
          <button type="button" className="text-button" onClick={() => openAgent()}>查看子 Agent</button>
          <button type="button" className="text-button" onClick={() => setText('子 Agent 都结束了，请汇总它们的结果。')}>填入“请汇总结果”</button>
        </p>}
        <ComposerView value={text} onChange={setText} onSend={() => setText('')} onStop={() => setMainStatus('interrupted')}
          onImages={() => {}} onFiles={() => {}} editDisabled={false} imagesDisabled={false} filesDisabled={false}
          sendDisabled={!text.trim()} sending={false} running={mainStatus === 'running'} model={fixture.harness === 'Codex' ? 'GPT-6 Astra' : 'deepseek-v4'}
          reasoningEffort="中" permission="示例配置" configurationNote="Storybook 原型：停止只改变模拟状态。" hasMaterials={false}/>
      </div>
    </WorkbenchFrame>
    <Dialog.Root open={narrow && open} onOpenChange={value => { if (!value) close(); }}>
      <Dialog.Portal>
        <Dialog.Content className="workspace-reader subagent-panel subagent-sheet" aria-describedby={undefined}
          onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
          <Dialog.Title className="sr-only">子 Agent</Dialog.Title>
          {panel}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}

const meta = {
  id: 'subagents',
  title: '原型/原生子 Agent',
  component: SubagentPrototype,
  args: { scenario: 'codex-running', stopReceipt: 'confirmed' },
  argTypes: {
    scenario: { control: 'select', options: Object.keys(fixtures) },
    stopReceipt: { control: 'inline-radio', options: ['confirmed', 'unknown'] },
  },
  render: args => <SubagentPrototype key={`${args.scenario}-${args.stopReceipt}`} {...args}/>,
} satisfies Meta<typeof SubagentPrototype>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CodexRunning: Story = { name: 'Codex · 子 Agent 运行中' };
export const CodexResultsPending: Story = { name: 'Codex · 全部结束，结果待处理', args: { scenario: 'codex-pending' } };
export const MainStopped: Story = { name: 'DSH · 主 Agent 已停止，子 Agent 仍在运行', args: { scenario: 'dsh-stopped' } };
export const DshTeam: Story = { name: 'DSH · 团队（成员与共享任务）', args: { scenario: 'dsh-team' } };
export const StopUnverified: Story = { name: '停止回执未确认', args: { scenario: 'codex-running', stopReceipt: 'unknown' } };
export const HostUnreachable: Story = { name: 'DSH · Host 暂时连不上', args: { scenario: 'dsh-unreachable' } };
export const NoSubagents: Story = { name: '没有子 Agent（入口隐藏）', args: { scenario: 'none' } };
export const Narrow: Story = { name: '窄屏 · DSH 团队', args: { scenario: 'dsh-team' }, globals: { viewport: { value: '390-740', isRotated: false } } };

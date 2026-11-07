import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Conversation, PendingRequest, WorkbenchItem } from '../../src/shared/workbench.ts';
import { WorkbenchFrame, useNarrow } from '../../src/web/patterns/workbench-frame.tsx';
import { ComposerView } from '../../src/web/patterns/composer.tsx';
import { PlanNotice, PlanReadyCard, PlanToggle } from '../../src/web/patterns/plan.tsx';
import { RequestStack, answerSummary } from '../../src/web/patterns/requests.tsx';
import { MarkdownText, Transcript } from '../../src/web/conversation-content.tsx';
import { ExampleHeader, ExampleSidebar } from './compositions.tsx';
import { conversations } from './fixtures.tsx';
import { Page, Section, Stage, phone, useReadout } from './catalog.tsx';

/** Story-only examples of Plan mode. Wording mirrors what the native Harnesses send; nothing reaches a Harness. */
const planText = `## 周报改版计划

1. 读取 \`示例周报.md\` 与上周数据，列出缺失的转化率行。
2. 新增“本周要点”小节，放在开头，最多三条。
3. 把访问量表格改为按渠道分组，并保留原始数字。
4. 生成前后对比，交给你确认后再写回文件。

不会修改工作区以外的文件。`;
const runId = 'plan-run';
const codexItems: WorkbenchItem[] = [
  { id: 'p-user', kind: 'user', status: 'completed', runId, text: '先帮我规划一下周报怎么改版，别急着动文件。' },
  { id: 'p-tool', kind: 'tool', status: 'completed', runId, text: '', tool: { name: '运行命令', input: 'rg -n "转化率" 示例周报.md', output: '12: | 转化率 | — |' } },
  { id: 'p-reply', kind: 'assistant', status: 'completed', runId, text: '我看过了周报和上周数据，下面是改版计划。' },
  { id: `${runId}-plan`, kind: 'assistant', status: 'completed', runId, plan: true, text: planText },
];
const at = Date.UTC(2026, 10, 7, 3, 0);
const codexQuestion: PendingRequest = {
  id: 'cx-question', kind: 'question', status: 'open', createdAt: at,
  questions: [{ id: 'scope', header: '范围', text: '改版只动周报正文，还是连同数据表一起调整？', multiple: false, custom: true,
    options: [{ label: '只改正文 (Recommended)', description: '风险最小，数据表保持原样' }, { label: '正文和数据表一起改', description: '需要多读一份数据' }] }],
};
const dshReview: PendingRequest = {
  id: 'ds-review', kind: 'question', status: 'open', createdAt: at,
  questions: [{ id: 'plan-review', text: 'Approve this plan and leave plan mode?', multiple: false, custom: true,
    options: [{ label: 'Approve' }, { label: 'Keep planning' }], review: { approve: 'Approve', keep: 'Keep planning', plan: planText } }],
};
const markdown = (text: string) => <MarkdownText text={text}/>;

function Catalog() {
  const [readout, say] = useReadout();
  return <Page title="Plan 模式" lead={<>Plan 开着时，Agent 先规划，计划交你审核后再执行。它不限制 Agent 的工具，限制仍靠权限与审批。{readout}</>}>
    <Section title="开关" note="在输入框工具栏里、模型旁边。本轮运行中不能切换；DSH 的切换要等原生生效，期间显示“切换中”。">
      <Stage>
        <PlanToggle active={false} onToggle={() => say('开启 Plan')}/>
        <PlanToggle active onToggle={() => say('关闭 Plan')}/>
        <PlanToggle active pending onToggle={() => say('切换中')}/>
        <PlanToggle active disabled onToggle={() => {}}/>
      </Stage>
    </Section>
    <Section title="说明条" note="Plan 开着时显示在输入框上方。">
      <Stage stack style={{ maxWidth: 720 }}><PlanNotice harness="Codex"/><PlanNotice harness="DSH"/></Stage>
    </Section>
    <Section title="Codex：计划已就绪" note="Plan 轮结束、且之后没有新消息时出现。按计划执行会关闭 Plan，并发一句执行指令开始下一轮。">
      <Stage stack style={{ maxWidth: 720 }}><PlanReadyCard onImplement={() => say('按计划执行')} onKeepPlanning={() => say('继续规划')}/><PlanReadyCard busy onImplement={() => {}} onKeepPlanning={() => {}}/></Stage>
    </Section>
    <Section title="DSH：计划审核" note="DSH 把计划作为一次提问交来。批准后原生退出 Plan 并在同一轮继续执行；继续规划可以附意见。">
      <Stage stack style={{ maxWidth: 720 }}><RequestStack requests={[dshReview]} renderMarkdown={markdown} onAnswer={(_id, value) => say(`回答：${answerSummary(dshReview, value)}`)} onReconcile={() => {}} onDismiss={() => {}}/></Stage>
    </Section>
    <Section title="Codex：Plan 中的提问" note="单选；“或者自己填写”对应 Codex 的“以上都不是”加补充说明。">
      <Stage stack style={{ maxWidth: 720 }}><RequestStack requests={[codexQuestion]} onAnswer={(_id, value) => say(`回答：${answerSummary(codexQuestion, value)}`)} onReconcile={() => {}} onDismiss={() => {}}/></Stage>
    </Section>
  </Page>;
}

type Args = { harness: 'Codex' | 'DSH' };
function InConversation(args: Args) {
  const narrow = useNarrow();
  const [navigation, setNavigation] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [plan, setPlan] = useState(true);
  const [items, setItems] = useState<WorkbenchItem[]>(args.harness === 'Codex' ? codexItems : codexItems.slice(0, 3));
  const [ready, setReady] = useState(args.harness === 'Codex');
  const [busy, setBusy] = useState(false);
  const [requests, setRequests] = useState<PendingRequest[]>(args.harness === 'DSH' ? [dshReview] : []);
  const [text, setText] = useState('');
  const [readout, say] = useReadout();
  const first = conversations[0]!;
  const waiting = requests.some(request => request.status === 'open');
  const conversation: Conversation = { ...first, harnessId: args.harness === 'Codex' ? 'codex' : 'dsh', state: { ...first.state, status: waiting ? 'waiting' : busy ? 'running' : 'idle' }, plan: { active: plan } };
  function implement() {
    say('按计划执行：关闭 Plan，并发送执行指令');
    setBusy(true); setReady(false); setPlan(false);
    setItems(list => [...list, { id: 'p-go', kind: 'user', status: 'completed', runId: 'go', text: '按上面的计划开始执行。' }]);
    window.setTimeout(() => { setBusy(false); setItems(list => [...list, { id: 'p-done', kind: 'assistant', status: 'completed', runId: 'go', text: '已按计划完成第 1、2 步，对比结果如下。（Storybook 模拟）' }]); }, 1400);
  }
  function answer(id: string, value: Parameters<typeof answerSummary>[1]) {
    const request = requests.find(item => item.id === id)!;
    const summary = answerSummary(request, value);
    say(`回答：${summary}`);
    setRequests(list => list.map(item => item.id === id ? { ...item, status: 'answered', answer: { id: '00000000-0000-4000-8000-000000000002', status: 'accepted', reason: null, updatedAt: at, summary } } : item));
    if (summary === '批准并执行') setPlan(false);
  }
  return <WorkbenchFrame navigationOpen={navigation} onNavigationChange={setNavigation} collapsed={collapsed} onCollapsedChange={setCollapsed}
    sidebar={<ExampleSidebar narrow={narrow} conversations={conversations.map(item => item.id === first.id ? conversation : item)} selected={first.id} onSelect={() => setNavigation(false)} onClose={() => setNavigation(false)} onCollapse={() => setCollapsed(true)}/>}
    header={<ExampleHeader conversation={conversation}/>}>
    <div className="message-scroll"><div className="message-column"><Transcript items={items} conversation="example" onQuote={() => {}}/>{readout}</div></div>
    <div className="composer-region">
      {plan && <PlanNotice harness={args.harness}/>}
      {ready && plan && <PlanReadyCard busy={busy} onImplement={implement} onKeepPlanning={() => { setReady(false); say('继续规划：在输入框写意见'); }}/>}
      {!!requests.length && <RequestStack requests={requests} renderMarkdown={markdown} onAnswer={answer} onReconcile={() => {}} onDismiss={id => setRequests(list => list.filter(item => item.id !== id))}/>}
      <ComposerView value={text} onChange={setText} onSend={() => { say(`发送（${plan ? 'Plan' : '默认'}模式）：${text}`); setText(''); }} onStop={() => {}} onImages={() => {}} onFiles={() => {}}
        editDisabled={false} imagesDisabled={false} filesDisabled={false} sendDisabled={!text.trim()} sending={false} running={busy || waiting}
        model="示例模型" permission="工作区读写" configurationNote="配置在本对话中保持不变。" hasMaterials={false}
        toolbarExtras={<PlanToggle active={plan} disabled={busy || waiting} onToggle={() => { setPlan(value => !value); setReady(false); say(plan ? '关闭 Plan' : '开启 Plan'); }}/>}/>
    </div>
  </WorkbenchFrame>;
}

const meta = {
  title: '工作台/Plan 模式',
  component: InConversation,
  args: { harness: 'Codex' },
  argTypes: { harness: { control: 'inline-radio', options: ['Codex', 'DSH'] } },
  render: args => <InConversation key={JSON.stringify(args)} {...args}/>,
} satisfies Meta<typeof InConversation>;
export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = { name: '全部状态', render: () => <Catalog/> };
export const Codex: Story = { name: '桌面 · Codex 计划已就绪' };
export const Dsh: Story = { name: '桌面 · DSH 计划审核', args: { harness: 'DSH' } };
export const PhoneCodex: Story = { name: '手机 · Codex 计划已就绪', globals: phone };
export const PhoneDsh: Story = { name: '手机 · DSH 计划审核', args: { harness: 'DSH' }, globals: phone };
export const PhoneStates: Story = { name: '手机 · 全部状态', render: () => <Catalog/>, globals: phone };

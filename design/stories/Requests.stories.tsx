import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Conversation, PendingRequest, RequestAnswer, WorkbenchItem } from '../../src/shared/workbench.ts';
import { WorkbenchFrame, useNarrow } from '../../src/web/patterns/workbench-frame.tsx';
import { ComposerView } from '../../src/web/patterns/composer.tsx';
import { RequestCard, RequestStack, answerSummary } from '../../src/web/patterns/requests.tsx';
import { Transcript } from '../../src/web/conversation-content.tsx';
import { ExampleHeader, ExampleSidebar } from './compositions.tsx';
import { conversations } from './fixtures.tsx';
import { Page, Section, Stage, phone, useReadout } from './catalog.tsx';

/** Story-only examples. The wording mirrors what the native Harnesses send; nothing here reaches a Harness. */
const at = Date.UTC(2026, 10, 7, 2, 30);
const command: PendingRequest = {
  id: 'req-command', kind: 'approval', status: 'open', createdAt: at,
  approval: { action: 'command', network: true, reason: '沙箱阻止了联网。允许用更高权限重新运行同一条命令吗？',
    command: 'node -e "fetch(\'https://example.com\').then(r=>console.log(r.status))"', cwd: '示例工作区', decisions: ['accept', 'cancel'] },
};
const fileChange: PendingRequest = {
  id: 'req-file', kind: 'approval', status: 'open', createdAt: at + 1,
  approval: { action: 'fileChange', reason: '需要写入工作区以外的目录。', paths: ['../共享配置/发布清单.md', '../共享配置/版本.txt'], decisions: ['accept', 'acceptForSession', 'decline', 'cancel'] },
};
const permissions: PendingRequest = {
  id: 'req-permissions', kind: 'approval', status: 'open', createdAt: at + 2,
  approval: { action: 'permissions', reason: '下载依赖需要联网，并写入缓存目录。', network: true, paths: ['~/.cache/示例'], decisions: ['accept', 'acceptForSession', 'decline'] },
};
const fromSubagent: PendingRequest = { ...command, id: 'req-child', createdAt: at + 3, agent: { id: 'agent-review', name: '检查员' },
  approval: { ...command.approval!, network: false, reason: '需要读取工作区外的日志。', command: 'tail -n 50 /var/log/示例.log', decisions: ['accept', 'acceptForSession', 'decline', 'cancel'] } };
const single: PendingRequest = {
  id: 'req-question', kind: 'question', status: 'open', createdAt: at + 4,
  questions: [{ id: 'format', header: '格式', text: '周报要用哪种格式交付？', multiple: false, custom: true,
    options: [{ label: 'Markdown', description: '直接放进工作区，便于后续修改' }, { label: 'HTML 报告', description: '带图表，适合转发' }, { label: '两种都要' }] }],
};
const several: PendingRequest = {
  id: 'req-questions', kind: 'question', status: 'open', createdAt: at + 5, deadline: at + 10 * 60_000,
  questions: [
    { id: 'scope', header: '范围', text: '这次要覆盖哪些数据源？', multiple: true, custom: true, options: [{ label: '访问日志' }, { label: '转化数据' }, { label: '客服记录' }] },
    { id: 'deadline', text: '什么时候需要初稿？', multiple: false, custom: true, options: [] },
  ],
};
const form: PendingRequest = {
  id: 'req-form', kind: 'form', status: 'open', createdAt: at + 6,
  form: { source: '示例数据服务', message: '连接数据服务前需要确认查询范围。', fields: [
    { name: 'project', label: '项目', type: 'enum', required: true, options: ['示例项目 A', '示例项目 B'] },
    { name: 'days', label: '回溯天数', type: 'integer', required: true, description: '1 到 90 天' },
    { name: 'raw', label: '包含原始记录', type: 'boolean', required: false },
  ] },
};
const answer = (status: NonNullable<PendingRequest['answer']>['status'], extra: Partial<NonNullable<PendingRequest['answer']>> = {}) =>
  ({ id: '00000000-0000-4000-8000-000000000001', status, reason: null, updatedAt: at, summary: '允许运行', ...extra });

function Catalog() {
  const [readout, say] = useReadout();
  const card = (request: PendingRequest) => <RequestCard request={request} now={at} onAnswer={value => say(`回答：${answerSummary(request, value)}`)}
    onReconcile={() => say('查询原生结果')} onDismiss={() => say('收起')} onOpenAgent={id => say(`打开子 Agent ${id}`)}/>;
  return <Page title="提问与审批" lead={<>Agent 等待你处理的请求出现在输入框上方。选项完全按原生请求给出；回答提交后由原生确认，确认之前不显示为已回答。{readout}</>}>
    <Section title="审批" note="只在「工作区读写」和「只读」的对话出现；「完全访问」不询问。">
      <Stage stack style={{ maxWidth: 720 }}>{card(command)}{card(fileChange)}{card(permissions)}{card(fromSubagent)}</Stage>
    </Section>
    <Section title="提问" note="任何权限下都会出现。单选可以改为自己填写；多个问题需要都回答后提交。DSH 的限时提问到点后 Agent 先做别的，之后仍可回答。">
      <Stage stack style={{ maxWidth: 720 }}>{card(single)}{card(several)}</Stage>
    </Section>
    <Section title="工具要你填写信息" note="MCP 工具发起的表单；中书无法呈现的类型会明确拒绝并说明。">
      <Stage stack style={{ maxWidth: 720 }}>{card(form)}</Stage>
    </Section>
    <Section title="提交之后" note="正在提交 → 原生确认后显示已回答；回执未知时不自动重发，可查询原生结果；没送达时重新打开选择。">
      <Stage stack style={{ maxWidth: 720 }}>
        {card({ ...command, answer: answer('dispatching') })}
        {card({ ...command, answer: answer('unknown') })}
        {card({ ...command, answer: answer('rejected', { reason: 'answer_not_delivered' }) })}
        {card({ ...command, status: 'answered', answer: answer('accepted') })}
        {card({ ...single, status: 'expired' })}
        {card({ ...command, status: 'expired', answer: answer('unknown') })}
      </Stage>
    </Section>
  </Page>;
}

const runId = 'request-run';
const items: WorkbenchItem[] = [
  { id: 'r-user', kind: 'user', status: 'completed', runId, text: '检查一下示例网站现在能不能访问，再把结果写进周报。' },
  { id: 'r-tool', kind: 'tool', status: 'failed', runId, text: '', tool: { name: '运行命令', input: 'node -e "fetch(\'https://example.com\')"', output: 'TypeError: fetch failed (sandbox: network disabled)', exitCode: 1 } },
  { id: 'r-reply', kind: 'assistant', status: 'completed', runId, text: '沙箱不允许联网。我需要你批准用更高权限重新运行同一条命令。' },
];

type Args = { scene: 'approval' | 'question' | 'several' | 'subagent'; receipt: 'confirmed' | 'unknown' };
function InConversation(args: Args) {
  const initial = args.scene === 'approval' ? [command] : args.scene === 'question' ? [single] : args.scene === 'subagent' ? [fromSubagent, command] : [command, single, form];
  const [requests, setRequests] = useState<PendingRequest[]>(initial);
  const [readout, say] = useReadout();
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const [navigation, setNavigation] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const narrow = useNarrow();
  const first = conversations[0]!;
  const waiting = requests.some(request => request.status === 'open');
  const conversation: Conversation = { ...first, state: { ...first.state, status: waiting ? 'waiting' : 'running' } };
  function respond(id: string, value: RequestAnswer) {
    const request = requests.find(item => item.id === id)!;
    const summary = answerSummary(request, value);
    say(`回答 ${id}：${summary}`);
    setRequests(list => list.map(item => item.id === id ? { ...item, answer: answer('dispatching', { summary }) } : item));
    timers.current.push(window.setTimeout(() => setRequests(list => list.map(item => item.id !== id ? item
      : args.receipt === 'unknown' ? { ...item, answer: answer('unknown', { summary }) } : { ...item, status: 'answered', answer: answer('accepted', { summary }) })), 900));
  }
  return <WorkbenchFrame navigationOpen={navigation} onNavigationChange={setNavigation} collapsed={collapsed} onCollapsedChange={setCollapsed}
    sidebar={<ExampleSidebar narrow={narrow} conversations={conversations.map(item => item.id === first.id ? conversation : item)} selected={first.id} onSelect={() => setNavigation(false)} onClose={() => setNavigation(false)} onCollapse={() => setCollapsed(true)}/>}
    header={<ExampleHeader conversation={conversation}/>}>
    <div className="message-scroll"><div className="message-column"><Transcript items={items} conversation="example" onQuote={() => {}}/>{readout}</div></div>
    <div className="composer-region">
      <RequestStack requests={requests} now={at} onAnswer={respond} onOpenAgent={id => say(`打开子 Agent ${id}`)}
        onReconcile={id => { say(`查询 ${id} 的原生结果`); setRequests(list => list.map(item => item.id === id ? { ...item, status: 'answered', answer: { ...item.answer!, status: 'accepted' } } : item)); }}
        onDismiss={id => setRequests(list => list.filter(item => item.id !== id))}/>
      <ComposerView value="" onChange={() => {}} onSend={() => {}} onStop={() => say('停止当前轮')} onImages={() => {}} onFiles={() => {}}
        editDisabled={false} imagesDisabled={false} filesDisabled={false} sendDisabled sending={false} running
        model="示例模型" permission="工作区读写" configurationNote="配置在本对话中保持不变。" hasMaterials={false}/>
    </div>
  </WorkbenchFrame>;
}

const meta = {
  title: '工作台/提问与审批',
  component: InConversation,
  args: { scene: 'approval', receipt: 'confirmed' },
  argTypes: { scene: { control: 'inline-radio', options: ['approval', 'question', 'several', 'subagent'] }, receipt: { control: 'inline-radio', options: ['confirmed', 'unknown'] } },
  render: args => <InConversation key={JSON.stringify(args)} {...args}/>,
} satisfies Meta<typeof InConversation>;
export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = { name: '全部状态', render: () => <Catalog/> };
export const Approval: Story = { name: '桌面 · 审批' };
export const Question: Story = { name: '桌面 · 提问', args: { scene: 'question' } };
export const Several: Story = { name: '桌面 · 多个请求', args: { scene: 'several' } };
export const Subagent: Story = { name: '桌面 · 子 Agent 的审批', args: { scene: 'subagent' } };
export const Unknown: Story = { name: '桌面 · 回执未知', args: { receipt: 'unknown' } };
export const PhoneApproval: Story = { name: '手机 · 审批', globals: phone };
export const PhoneQuestion: Story = { name: '手机 · 提问', args: { scene: 'question' }, globals: phone };
export const PhoneStates: Story = { name: '手机 · 全部状态', render: () => <Catalog/>, globals: phone };

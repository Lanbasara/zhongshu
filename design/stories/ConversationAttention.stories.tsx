import type { Meta, StoryObj } from '@storybook/react-vite';
import { ConversationAttention, type ConversationAttentionView } from '../../src/web/patterns/conversation-attention.tsx';
import { Page, Section, Stage, phone, useReadout } from './catalog.tsx';

/** The same words the feature module produces; these examples check layout, tone and the action, not the copy rules. */
const situations = {
  'state-unavailable': {
    label: '状态无法核实 · 持续约 2 秒仍没有结果（没有已知原因）',
    attention: {
      tone: 'unknown', title: '运行状态暂时无法核实', action: 'reconcile',
      detail: '原生服务没有返回可以确认的运行状态。已收到的内容都会保留，消息不会自动重发；页面打开期间会自动重试。',
    },
  },
  'state-restored': {
    label: '状态无法核实 · 数据库从备份恢复',
    attention: {
      tone: 'unknown', title: '运行状态暂时无法核实', action: 'reconcile',
      detail: '应用数据库已从备份恢复，之前的执行记录需要重新核对。已收到的内容都会保留，消息不会自动重发；页面打开期间会自动重试。',
    },
  },
  'blocked-connection': {
    label: '对话被阻断 · 原生连接中断',
    attention: {
      tone: 'blocked', title: '与原生服务的连接中断', action: 'reconcile',
      detail: '暂时读不到运行状态。已收到的内容都会保留，消息不会自动重发；页面打开期间会自动重试。',
    },
  },
  'blocked-config': {
    label: '对话被阻断 · 配置变化',
    attention: {
      tone: 'blocked', title: '这段对话暂时不能继续',
      detail: '工作区或原生服务的配置发生了变化，需要核对后才能继续。已有内容都会保留，消息不会自动重发。',
    },
  },
  'blocked-workspace': {
    label: '对话被阻断 · 工作区目录不可用',
    attention: {
      tone: 'blocked', title: '工作区目录暂时无法访问',
      detail: '中书暂时读不到这个工作区；已有内容都会保留，消息不会自动重发。目录恢复访问后才能继续。',
    },
  },
  'blocked-verifying': {
    label: '对话被阻断 · 配置待核实（可查询原生结果）',
    attention: {
      tone: 'blocked', title: '配置还没有核实完成', action: 'reconcile',
      detail: '原生服务还没有确认这段对话的模型与权限配置；核实前不能继续发送，已有内容都会保留。页面打开期间会继续核对。',
    },
  },
  'pending-operation': {
    label: '结果待核实 · 一条消息的接收结果未知',
    attention: {
      tone: 'pending', title: '有一条消息的结果还没有核实', action: 'reconcile',
      detail: '消息已经提交，但原生服务还没有确认是否收到；消息不会自动重发，已收到的内容都会保留。',
    },
  },
  'pending-run': {
    label: '结果待核实 · 已发送但还没有对应原生轮次',
    attention: {
      tone: 'pending', title: '已发送，正在确认是否开始执行', action: 'reconcile',
      detail: '消息已经交给原生服务，但还没有确认它对应哪一轮执行；确认之前不会重复发送，已收到的内容都会保留。',
    },
  },
} satisfies Record<string, { label: string; attention: ConversationAttentionView }>;
type Situation = keyof typeof situations | 'none';

function Demo({ situation }: { situation: Situation }) {
  const [readout, say] = useReadout();
  const attention = situation === 'none' ? null : situations[situation].attention;
  return <div className="catalog-column">
    <p className="catalog-muted" style={{ marginBottom: 4 }}>
      {situation === 'none' ? '正常等待（排队、派发中、刚发送还没拿到原生轮次）：这里不渲染任何东西。' : situations[situation].label}
    </p>
    <ConversationAttention attention={attention} onReconcile={() => say('向服务器查询原生结果，重新核对这段对话')}/>
    {readout}
  </div>;
}

function Catalog() {
  const [readout, say] = useReadout();
  return <Page title="对话状态提示" lead="只在真正无法核实或需要处理时出现一条：一句话说清现在是什么状态，次要行说明已知原因、已保留的内容、不会自动重发和是否自动重试。同一时刻最多一条；正常等待不显示。">
    {readout}
    <Section title="无法核实状态" note="原生状态读不到、也没有已知原因。状态未知需持续约 2 秒才提示，避免新建或切换对话时首次核实的那一下闪烁；提示明确说明正在自动重试，并提供“查询原生结果”。">
      <Stage stack style={{ maxWidth: 760 }}>{(['state-unavailable', 'state-restored'] as const).map(situation =>
        <ConversationAttention key={situation} attention={situations[situation].attention} onReconcile={() => say(`查询原生结果（${situations[situation].label}）`)}/>)}</Stage>
    </Section>
    <Section title="对话被阻断" note="准备或配置不满足继续执行的条件；说清现在不能做什么，以及已有内容仍然保留。能再次核实的才提供“查询原生结果”。">
      <Stage stack style={{ maxWidth: 760 }}>{(['blocked-connection', 'blocked-config', 'blocked-workspace', 'blocked-verifying'] as const).map(situation =>
        <ConversationAttention key={situation} attention={situations[situation].attention} onReconcile={() => say(`查询原生结果（${situations[situation].label}）`)}/>)}</Stage>
    </Section>
    <Section title="结果待核实" note="消息已提交但原生接收结果未知，或已发送却还没有对应原生轮次；说明不会重复发送。">
      <Stage stack style={{ maxWidth: 760 }}>{(['pending-operation', 'pending-run'] as const).map(situation =>
        <ConversationAttention key={situation} attention={situations[situation].attention} onReconcile={() => say(`查询原生结果（${situations[situation].label}）`)}/>)}</Stage>
    </Section>
    <Section title="正常等待时不出现" note="发送后的排队、派发中、刚拿到操作号但消息还没有原生轮次，都只是正常等待；超过一段明确延迟仍未核实时才升级为上面的提示，避免每次发送闪烁。新对话和切换对话的首次状态核实同理：状态未知持续约 2 秒才提示。">
      <Stage style={{ maxWidth: 760 }}><p className="catalog-muted"><code>conversationAttention(...)</code> 返回 <code>null</code>，正文区顶部保持空白。</p></Stage>
    </Section>
  </Page>;
}

const meta = {
  title: '模式/对话状态提示',
  component: Demo,
  args: { situation: 'state-unavailable' },
  argTypes: {
    situation: { control: 'select', options: [...Object.keys(situations), 'none'],
      description: '未知状态 / 阻断 / 待核实 / 不显示' },
  },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unknown: Story = { name: '状态无法核实', args: { situation: 'state-unavailable' } };
export const Blocked: Story = { name: '对话被阻断', args: { situation: 'blocked-config' } };
export const Pending: Story = { name: '结果待核实', args: { situation: 'pending-run' } };
export const None: Story = { name: '正常等待 · 不显示', args: { situation: 'none' } };
export const All: Story = { name: '状态一览', render: () => <Catalog/>, parameters: { controls: { disable: true } } };
export const Phone: Story = { name: '手机', args: { situation: 'state-unavailable' }, globals: phone };

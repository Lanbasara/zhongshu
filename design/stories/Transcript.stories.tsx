import type { Meta, StoryObj } from '@storybook/react-vite';
import type { WorkbenchItem } from '../../src/shared/workbench.ts';
import type { MessageReference } from '../../src/shared/content.ts';
import { Message, Transcript } from '../../src/web/conversation-content.tsx';
import { SubagentActivity } from '../../src/web/patterns/subagents.tsx';
import { exampleRun, runningRun, runningTurn, subagents, transcript, turnFiles } from './fixtures.tsx';
import { phone, useReadout } from './catalog.tsx';

type Args = {
  kind: WorkbenchItem['kind']; status: WorkbenchItem['status']; content: 'short' | 'markdown' | 'long' | 'empty';
  images: number; references: 'none' | 'file' | 'quote' | 'both';
  running: boolean; showTurnFiles: boolean; workspaceUnavailable: boolean; collaboration: boolean;
};

const texts = {
  short: '把示例周报整理一下，再写一段摘要。',
  markdown: transcript.find(item => item.kind === 'assistant')!.text,
  long: Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 段示例正文：这是一段较长的内容，用来检查正文的行宽、行距和换行。超长的无空格字符串也要能换行：示例/很长的路径/没有空格的文件名称示例示例示例示例示例示例示例示例.md`).join('\n\n'),
  empty: '',
};
const references: Record<Args['references'], MessageReference[]> = {
  none: [], file: [{ type: 'file', path: '示例/周报/数据表.csv' }], quote: [{ type: 'quote', itemId: 'item-reply', text: '转化率缺失的一行按前后两周的平均值补齐。' }],
  both: [{ type: 'file', path: '示例/周报/数据表.csv' }, { type: 'quote', itemId: 'item-reply', text: '转化率缺失的一行按前后两周的平均值补齐。' }],
};

function MessageDemo({ kind, status, content, images, references: referenceKind }: Args) {
  const [readout, say] = useReadout();
  const item: WorkbenchItem = {
    id: 'example-message', kind, status, text: texts[content],
    ...(images ? { images: Array.from({ length: images }, (_, index) => ({ id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, name: `示例图片 ${index + 1}.png`, mediaType: 'image/png' as const })) } : {}),
    ...(referenceKind !== 'none' ? { references: references[referenceKind] } : {}),
  };
  return <div className="catalog-column">
    <p className="catalog-muted" style={{ marginBottom: 12 }}>用户消息是右侧气泡；Agent 回复是阅读宽度上的正文（Markdown）；notice 是一行说明。失败与待核实在正文下方说明。Storybook 没有图片资源接口，图片显示为“暂时无法读取”的兜底状态。</p>
    <Message item={item} conversation="example" onQuote={reference => say(`引用：${reference.type === 'quote' ? reference.text : reference.path}`)}/>
    {readout}
  </div>;
}

const collaborationItems: WorkbenchItem[] = [
  { id: 'item-collab-1', kind: 'notice', status: 'completed', runId: exampleRun, text: '', collaboration: { action: 'started', agentIds: ['agent-1', 'agent-2', 'agent-3', 'agent-5'] } },
];
function TranscriptDemo({ running, showTurnFiles, workspaceUnavailable, collaboration }: Args) {
  const [readout, say] = useReadout();
  const [user, ...rest] = transcript;
  const items = [user!, ...(collaboration ? collaborationItems : []), ...rest, ...(running ? runningTurn : [])];
  return <div className="message-scroll" style={{ height: '100dvh' }}><div className="message-column">
    <Transcript items={items} conversation="example" onQuote={reference => say(`引用：${reference.type === 'quote' ? reference.text : reference.path}`)}
      turnFiles={showTurnFiles ? turnFiles : undefined} activeRun={running ? runningRun : undefined} workspaceUnavailable={workspaceUnavailable}
      onOpenFile={(_run, path) => say(`在阅读器中打开 ${path}`)}
      renderCollaboration={records => <SubagentActivity action={records[0]!.collaboration!.action}
        agents={subagents.filter(agent => records.some(record => record.collaboration?.agentIds.includes(agent.id)))} onOpen={id => say(`查看子 Agent ${id}`)}/>}/>
    {readout}
  </div></div>;
}

const meta = {
  title: '模式/对话内容',
  component: MessageDemo,
  args: { kind: 'assistant', status: 'completed', content: 'markdown', images: 0, references: 'none', running: false, showTurnFiles: true, workspaceUnavailable: false, collaboration: false },
  argTypes: {
    kind: { control: 'inline-radio', options: ['user', 'assistant', 'notice'] },
    status: { control: 'inline-radio', options: ['completed', 'running', 'failed', 'unknown'] },
    content: { control: 'inline-radio', options: ['short', 'markdown', 'long', 'empty'] },
    images: { control: { type: 'range', min: 0, max: 4, step: 1 } },
    references: { control: 'inline-radio', options: ['none', 'file', 'quote', 'both'] },
  },
} satisfies Meta<typeof MessageDemo>;
export default meta;
type Story = StoryObj<typeof meta>;
const messageControls = { controls: { include: ['kind', 'status', 'content', 'images', 'references'] } };
const transcriptControls = { controls: { include: ['running', 'showTurnFiles', 'workspaceUnavailable', 'collaboration'] } };

export const AssistantReply: Story = { name: '消息 · Agent 回复', parameters: messageControls };
export const UserMessage: Story = { name: '消息 · 用户（带引用与图片）', args: { kind: 'user', content: 'short', references: 'both', images: 1 }, parameters: messageControls };
export const Streaming: Story = { name: '消息 · 正在生成', args: { status: 'running', content: 'empty' }, parameters: messageControls };
export const FailedMessage: Story = { name: '消息 · 未完成', args: { status: 'failed', content: 'short' }, parameters: messageControls };
export const UnknownMessage: Story = { name: '消息 · 状态未提供', args: { status: 'unknown', content: 'short' }, parameters: messageControls };
export const Notice: Story = { name: '消息 · 说明', args: { kind: 'notice', content: 'short', status: 'completed' }, parameters: messageControls };
export const WholeTurn: Story = { name: '完整一轮', render: args => <TranscriptDemo {...args}/>, parameters: transcriptControls };
export const RunningTurn: Story = { name: '完整一轮 · 下一轮进行中', args: { running: true }, render: args => <TranscriptDemo {...args}/>, parameters: transcriptControls };
export const WithSubagents: Story = { name: '完整一轮 · 派出子 Agent', args: { collaboration: true }, render: args => <TranscriptDemo {...args}/>, parameters: transcriptControls };
export const PhoneTurn: Story = { name: '完整一轮 · 手机', render: args => <TranscriptDemo {...args}/>, globals: phone, parameters: transcriptControls };

import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Dialog } from 'radix-ui';
import { FileText, X } from 'lucide-react';
import type { Conversation, WorkbenchItem } from '../../src/shared/workbench.ts';
import { skillLabelText, skillLimit, type SkillReference } from '../../src/shared/content.ts';
import { WorkbenchFrame, useNarrow } from '../../src/web/patterns/workbench-frame.tsx';
import { ComposerView } from '../../src/web/patterns/composer.tsx';
import { ComposerUsage, SkillEditor } from '../../src/web/patterns/composer-extras.tsx';
import { CommandPalette, type PaletteItem } from '../../src/web/patterns/command-palette.tsx';
import { Toasts, type ToastView } from '../../src/web/patterns/toasts.tsx';
import { SubagentActivity, SubagentPanel, SubagentTrigger, subagentBadges } from '../../src/web/patterns/subagents.tsx';
import { Transcript } from '../../src/web/conversation-content.tsx';
import { conversationStatus } from '../../src/web/conversation-status.ts';
import { ExampleHeader, ExampleSidebar, type Connection } from './compositions.tsx';
import { conversations, exampleRun, runningRun, runningTurn, skillOptions, subagentTranscript, subagents, transcript, turnFiles, workspaces } from './fixtures.tsx';
import { phone } from './catalog.tsx';

type Args = { state: 'idle' | 'running'; panel: 'none' | 'reader' | 'subagents'; collapsed: boolean; navigationOpen: boolean; connection: Connection; toast: boolean; subagentCard: boolean };

const loadSkills = () => Promise.resolve(skillOptions);
const picker = { load: loadSkills, format: skillLabelText, limit: skillLimit };
const team = (() => { const list = subagents.slice(0, 5); const badges = subagentBadges(list.map(agent => agent.name)); return list.map((agent, index) => ({ ...agent, badge: badges[index]! })); })();
const collaboration: WorkbenchItem = { id: 'item-collab', kind: 'notice', status: 'completed', runId: exampleRun, text: '', collaboration: { action: 'started', agentIds: team.slice(0, 4).map(agent => agent.id) } };

/**
 * The composed workbench: sidebar, header, transcript (user, process, reply, turn files), composer, toasts,
 * search and the side panel, wired with local state only.
 */
function WorkbenchDemo(args: Args) {
  const narrow = useNarrow();
  const first = conversations[0]!;
  const [selected, setSelected] = useState(first.id);
  const [collapsed, setCollapsed] = useState(args.collapsed);
  const [navigation, setNavigation] = useState(args.navigationOpen);
  const [running, setRunning] = useState(args.state === 'running');
  const [panel, setPanel] = useState(args.panel);
  const [readerPath, setReaderPath] = useState<string>(turnFiles.get(exampleRun)!.paths[1]!);
  const [agentId, setAgentId] = useState<string>();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [extra, setExtra] = useState<WorkbenchItem[]>([]);
  const [text, setText] = useState('');
  const [spans, setSpans] = useState<SkillReference[]>([]);
  const [interrupted, setInterrupted] = useState(false);
  const [toasts, setToasts] = useState<ToastView[]>(() => args.toast ? [{ id: 'toast-0', title: '「起草示例发布说明」已完成', detail: '示例笔记', status: 'unread', action: { label: '查看', run: () => {} } }] : []);
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const list: Conversation[] = conversations.map(conversation => conversation.id === first.id
    ? { ...conversation, state: { ...conversation.state, status: running ? 'running' : interrupted ? 'interrupted' : 'idle' }, ...(running ? {} : { unread: false }),
      subagents: { total: team.length, running: team.filter(agent => agent.status === 'running').length, unverified: 0, resultsPending: false, revision: 1 } }
    : conversation);
  const conversation = list.find(item => item.id === selected)!;
  const isFirst = selected === first.id;
  const items = isFirst ? [transcript[0]!, ...(args.subagentCard ? [collaboration] : []), ...transcript.slice(1), ...(args.state === 'running' ? runningTurn.map(item => running || item.status !== 'running' ? item : { ...item, status: 'completed' as const }) : []), ...extra] : [
    { id: `${selected}-u`, kind: 'user', status: 'completed', runId: `${selected}-run`, text: `关于「${conversation.title}」的示例消息。` },
    { id: `${selected}-a`, kind: 'assistant', status: conversation.state.status === 'failed' ? 'failed' : 'completed', runId: `${selected}-run`, text: '这是一段示例回复。这个对话只用于展示切换后的页头与侧栏选中状态。' },
  ] satisfies WorkbenchItem[];
  const activeRun = running ? (extra.length ? 'example-live' : runningRun) : undefined;

  function send() {
    const message: WorkbenchItem = { id: `live-${extra.length}`, kind: 'user', status: 'completed', runId: 'example-live', text };
    setExtra(current => [...current, message, { id: `live-tool-${extra.length}`, kind: 'tool', status: 'running', runId: 'example-live', text: '', tool: { name: '运行命令', input: 'python3 示例/脚本/处理.py' } }]);
    setText(''); setSpans([]); setRunning(true); setInterrupted(false);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setExtra(current => [...current.map(item => item.status === 'running' ? { ...item, status: 'completed' as const, tool: { ...item.tool!, output: '处理完成。' } } : item),
        { id: `live-reply-${current.length}`, kind: 'assistant', status: 'completed', runId: 'example-live', text: '示例回复：已经处理好了。（这是 Storybook 中的模拟回复。）' }]);
      setRunning(false);
      setToasts(current => [...current.slice(-2), { id: `toast-${Date.now()}`, title: '「整理示例周报」已完成', detail: '示例笔记', status: 'unread' }]);
    }, 2400);
  }
  const term = query.trim().toLocaleLowerCase();
  const paletteItems: PaletteItem[] = list.filter(item => !term || item.title.toLocaleLowerCase().includes(term)).slice(0, 8).map((item): PaletteItem => {
    const view = conversationStatus(item);
    return { id: item.id, group: term ? '对话' : view.status === 'idle' ? '最近' : '需要关注', title: item.title,
      detail: workspaces.find(workspace => workspace.id === item.workspaceId)?.label, status: view.status, statusLabel: view.label, run: () => setSelected(item.id) };
  }).sort((a, b) => (a.group === '需要关注' ? 0 : 1) - (b.group === '需要关注' ? 0 : 1));

  const subagentPanel = <SubagentPanel harness="Codex" agents={team} selected={team.find(agent => agent.id === agentId)} onSelect={id => setAgentId(id)} onBack={() => setAgentId(undefined)}
    detail={agentId && <Transcript conversation="example-child" items={subagentTranscript(team.find(agent => agent.id === agentId)!)} onQuote={() => {}}/>} detailState="ready"
    onStop={() => {}} onRecheck={() => {}} onReconcileStop={() => {}} onClose={() => { setPanel('none'); setAgentId(undefined); }}/>;
  const reader = <aside className="workspace-reader" aria-label="工作区文件">
    <div className="workspace-reader-bar"><FileText size={16} style={{ marginLeft: 8, color: 'var(--zs-text-muted)' }}/><strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{readerPath}</strong>
      <button type="button" className="reader-icon" aria-label="关闭文件阅读器" onClick={() => setPanel('none')}><X size={17}/></button></div>
    <div className="workspace-reader-content" style={{ padding: 24, overflow: 'auto' }}><p className="quiet">文件阅读器的示例占位。真实阅读器从工作区读取文件，不在组件目录中展示。</p>
      <pre style={{ marginTop: 16, font: 'var(--zs-type-caption)/1.7 var(--zs-font-code)', whiteSpace: 'pre-wrap' }}>{`# 示例周报摘要\n\n访问量比上周增加约 8%。\n转化率缺失的一行已补齐并标注。`}</pre></div>
  </aside>;
  const showPanel = !narrow || panel === 'reader';

  return <>
    <WorkbenchFrame collapsed={collapsed} onCollapsedChange={setCollapsed} navigationOpen={navigation} onNavigationChange={setNavigation}
      sidebar={<ExampleSidebar narrow={narrow} connection={args.connection} conversations={list} selected={selected}
        onSelect={id => { setSelected(id); setNavigation(false); }} onCollapse={() => setCollapsed(true)} onClose={() => setNavigation(false)}
        onSearch={() => { setNavigation(false); setSearching(true); }}/>}
      header={<ExampleHeader conversation={conversation} onSearch={() => setSearching(true)}
        extraActions={isFirst && <SubagentTrigger running={team.filter(agent => agent.status === 'running').length} total={team.length} expanded={panel === 'subagents'}
          onClick={() => setPanel(panel === 'subagents' ? 'none' : 'subagents')}/>}/>}
      panel={showPanel && panel !== 'none' ? panel === 'reader' ? reader : subagentPanel : undefined}>
      <div className="message-scroll"><div className="message-column">
        <Transcript items={items} conversation="example" onQuote={reference => setText(value => `${value}${value ? '\n' : ''}> ${reference.type === 'quote' ? reference.text : reference.path}\n`)}
          turnFiles={turnFiles} activeRun={activeRun} activeFile={panel === 'reader' ? { runId: exampleRun, path: readerPath } : undefined}
          onOpenFile={(_run, path) => { setReaderPath(path); setPanel('reader'); }}
          renderCollaboration={records => <SubagentActivity action={records[0]!.collaboration!.action} agents={team.filter(agent => records[0]!.collaboration!.agentIds.includes(agent.id))}
            onOpen={id => { setAgentId(id); setPanel('subagents'); }}/>}/>
      </div></div>
      <div className="composer-region">
        {interrupted && <p className="state-notice">本轮已中断。此前启动的后台工具可能仍在运行，已经产生的改动不会撤销。</p>}
        <ComposerView value={text} onChange={value => { setText(value); setSpans([]); }}
          renderEditor={editor => <SkillEditor editor={editor} spans={spans} picker={picker} onEdit={(value, next) => { setText(value); setSpans(next); }}/>}
          onSend={send} onStop={() => { window.clearTimeout(timer.current); setRunning(false); setInterrupted(true); setExtra(current => current.map(item => item.status === 'running' ? { ...item, status: 'completed' as const } : item)); }} onImages={() => {}} onFiles={() => {}}
          editDisabled={false} imagesDisabled={false} filesDisabled={false} sendDisabled={!text.trim()} sending={false} running={running}
          model="示例模型" reasoningEffort="均衡" permission="工作区读写" configurationNote="配置在本对话中保持不变。" hasMaterials={false}
          footerDetails={<ComposerUsage usage={{ total: 486_000, context: { used: 72_000, capacity: 200_000, estimated: true } }}/>}/>
      </div>
      <Toasts toasts={toasts} onDismiss={id => setToasts(current => current.filter(toast => toast.id !== id))}/>
    </WorkbenchFrame>
    {narrow && panel === 'subagents' && <Dialog.Root open onOpenChange={open => { if (!open) setPanel('none'); }}><Dialog.Portal>
      <Dialog.Content className="workspace-reader subagent-panel subagent-sheet" aria-describedby={undefined}><Dialog.Title className="sr-only">子 Agent</Dialog.Title>{subagentPanel}</Dialog.Content>
    </Dialog.Portal></Dialog.Root>}
    <CommandPalette open={searching} onOpenChange={value => { setSearching(value); if (!value) setQuery(''); }} query={query} onQuery={setQuery} items={paletteItems}/>
  </>;
}

const meta = {
  title: '工作台/整体',
  component: WorkbenchDemo,
  args: { state: 'idle', panel: 'none', collapsed: false, navigationOpen: false, connection: 'online', toast: false, subagentCard: true },
  argTypes: {
    state: { control: 'inline-radio', options: ['idle', 'running'] },
    panel: { control: 'inline-radio', options: ['none', 'reader', 'subagents'] },
    connection: { control: 'inline-radio', options: ['online', 'connecting', 'offline'] },
  },
  render: args => <WorkbenchDemo key={JSON.stringify(args)} {...args}/>,
} satisfies Meta<typeof WorkbenchDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = { name: '桌面' };
export const Running: Story = { name: '桌面 · 运行中', args: { state: 'running' } };
export const Reader: Story = { name: '桌面 · 打开本轮文件', args: { panel: 'reader' } };
export const Subagents: Story = { name: '桌面 · 子 Agent 面板', args: { panel: 'subagents' } };
export const Collapsed: Story = { name: '桌面 · 侧栏收起与提示', args: { collapsed: true, toast: true } };
export const Phone: Story = { name: '手机', globals: phone };
export const PhoneDrawer: Story = { name: '手机 · 导航抽屉', args: { navigationOpen: true }, globals: phone };
export const PhoneRunning: Story = { name: '手机 · 运行中', args: { state: 'running' }, globals: phone };

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Archive, Settings, SquarePen } from 'lucide-react';
import { modifierKey, type StatusKind } from '../../src/web/ui/controls.tsx';
import { ConnectionStatus, ConversationRow, SidebarAction, WorkspaceActions, WorkspaceGroup } from '../../src/web/patterns/sidebar.tsx';
import { SubagentBackgroundMark } from '../../src/web/patterns/subagents.tsx';
import { useNarrow } from '../../src/web/patterns/workbench-frame.tsx';
import { conversationStatus } from '../../src/web/conversation-status.ts';
import { ExampleSidebar, connectionText, type Connection, type SidebarPage, type StorageBadge } from './compositions.tsx';
import { conversations } from './fixtures.tsx';
import { Page, Section, phone, useReadout } from './catalog.tsx';

const statuses: StatusKind[] = ['running', 'waiting', 'unread', 'failed', 'unknown', 'interrupted', 'idle'];
const statusLabels: Record<StatusKind, string> = { running: '运行中', waiting: '等待处理', unread: '已完成，还没看', failed: '执行失败', unknown: '待核实', interrupted: '已中断', idle: '就绪' };

type Args = {
  connection: Connection; storage: StorageBadge; page: SidebarPage; empty: boolean; collapseSecondGroup: boolean;
  title: string; status: StatusKind; unread: boolean; selected: boolean; detail: string; meta: 'none' | 'subagents-running' | 'subagents-unverified'; manage: boolean;
  label: string; open: boolean; pinned: boolean; summary: StatusKind[]; count: number;
  current: boolean; disabled: boolean; shortcut: boolean; badge: StorageBadge;
};

function WholeSidebar({ connection, storage, page, empty, collapseSecondGroup }: Args) {
  const narrow = useNarrow();
  const [selected, setSelected] = useState(conversations[0]!.id);
  const [readout, say] = useReadout();
  return <div style={{ display: 'flex', minHeight: '100dvh', flexWrap: 'wrap' }}>
    <aside className="sidebar catalog-sidebar" aria-label="对话导航">
      <ExampleSidebar key={String(collapseSecondGroup)} narrow={narrow} connection={connection} storage={storage} page={page} empty={empty} selected={selected}
        closedWorkspaces={collapseSecondGroup ? ['example-site'] : []} onSelect={id => { setSelected(id); say(`打开 ${conversations.find(item => item.id === id)?.title}`); }}
        onClose={() => say('关闭导航')} onCollapse={() => say('收起导航')} onAction={say}/>
    </aside>
    {!narrow && <div style={{ flex: 1, padding: 32, minWidth: 240 }}>
      <p className="catalog-muted" style={{ maxWidth: 420, lineHeight: 1.7 }}>每个工作区一组，组内一行一段对话。悬停工作区标题显示新建与管理；收起的工作区用状态点汇总需要关注的对话。悬停对话行时，右侧的附加信息让位给“管理”按钮。</p>
      {readout}
    </div>}
  </div>;
}

function RowDemo({ title, status, unread, selected, detail, meta, manage }: Args) {
  const [readout, say] = useReadout();
  return <Page title="对话行" lead="状态点在左，标题一行截断；未读加粗；选中时整行填充并有强调色竖条。手机上行高增至 44px，管理按钮常驻。">
    <div className="sidebar" style={{ width: 'var(--zs-sidebar-width)', padding: 8, border: '1px solid var(--zs-line)', borderRadius: 'var(--zs-radius-item)' }}>
      <ConversationRow title={title} status={status} statusLabel={statusLabels[status]} unread={unread} selected={selected} detail={detail || undefined}
        meta={meta === 'none' ? undefined : <SubagentBackgroundMark running={meta === 'subagents-running' ? 2 : 0} unverified={meta === 'subagents-unverified' ? 1 : 0}/>}
        onOpen={() => say(`打开 ${title}`)} onManage={manage ? () => say(`管理 ${title}`) : undefined}/>
    </div>
    {readout}
    <Section title="全部状态" note="状态和文字来自产品的 conversationStatus。">
      <div className="sidebar" style={{ width: 'var(--zs-sidebar-width)', padding: 8, border: '1px solid var(--zs-line)', borderRadius: 'var(--zs-radius-item)' }}>
        {conversations.map(conversation => { const view = conversationStatus(conversation); return <ConversationRow key={conversation.id} title={conversation.title} status={view.status}
          statusLabel={view.label} unread={conversation.unread} detail={view.label} onOpen={() => say(`打开 ${conversation.title}`)} onManage={() => say(`管理 ${conversation.title}`)}/>; })}
      </div>
    </Section>
  </Page>;
}

function GroupDemo({ label, open, pinned, summary, count }: Args) {
  const [isOpen, setOpen] = useState(open);
  const [readout, say] = useReadout();
  return <Page title="工作区分组" lead="点标题展开或收起；收起时按 运行中 → 等待 → 失败 → 待核实 → 未读 的顺序汇总状态，数量大于 1 时显示数字。">
    <div className="sidebar" style={{ width: 'var(--zs-sidebar-width)', padding: '0 8px 8px', border: '1px solid var(--zs-line)', borderRadius: 'var(--zs-radius-item)' }}>
      <WorkspaceGroup label={label} pinned={pinned} open={isOpen} onToggle={() => setOpen(value => !value)}
        summary={summary.map(status => ({ status, count }))}
        actions={<WorkspaceActions label={label} onCreate={() => say(`在 ${label} 新建对话`)} onManage={() => say(`管理工作区：${label}`)}/>}>
        {conversations.slice(0, 3).map(conversation => { const view = conversationStatus(conversation); return <ConversationRow key={conversation.id} title={conversation.title}
          status={view.status} statusLabel={view.label} unread={conversation.unread} onOpen={() => say(`打开 ${conversation.title}`)}/>; })}
      </WorkspaceGroup>
    </div>
    {readout}
  </Page>;
}

function ActionDemo({ label, current, disabled, shortcut, badge }: Args) {
  const [readout, say] = useReadout();
  return <Page title="侧栏动作" lead="侧栏顶部的主动作与底部入口共用这一按钮。当前页面用填充表示；设置上的小圆点提示存储接近或达到上限。">
    <div className="sidebar" style={{ width: 'var(--zs-sidebar-width)', padding: 8, border: '1px solid var(--zs-line)', borderRadius: 'var(--zs-radius-item)', display: 'grid', gap: 1 }}>
      <SidebarAction icon={<SquarePen size={16}/>} label={label} current={current} disabled={disabled} shortcut={shortcut ? [modifierKey, 'N'] : undefined}
        badge={badge !== 'none' && <span className="sidebar-badge" data-state={badge} aria-label={badge === 'full' ? '存储已满' : '存储接近上限'}/>} onClick={() => say(label)}/>
      <SidebarAction icon={<Archive size={16}/>} label="已归档" onClick={() => say('已归档')}/>
      <SidebarAction icon={<Settings size={16}/>} label="设置" onClick={() => say('设置')}/>
    </div>
    {readout}
  </Page>;
}

function ConnectionDemo({ connection }: Args) {
  return <Page title="连接状态" lead="绿色已连接，黄色呼吸表示正在恢复，红色表示离线；离线时 Agent 仍在远端继续工作。">
    <div className="sidebar" style={{ width: 'var(--zs-sidebar-width)', padding: 8, border: '1px solid var(--zs-line)', borderRadius: 'var(--zs-radius-item)' }}>
      <div className="sidebar-status"><ConnectionStatus state={connection} text={connectionText[connection]}/></div>
    </div>
    <Section title="全部状态">{(Object.keys(connectionText) as Connection[]).map(state => <div key={state} className="sidebar-status"><ConnectionStatus state={state} text={connectionText[state]}/></div>)}</Section>
  </Page>;
}

const meta = {
  title: '模式/侧栏',
  component: WholeSidebar,
  args: {
    connection: 'online', storage: 'none', page: 'none', empty: false, collapseSecondGroup: true,
    title: '整理示例周报', status: 'running', unread: false, selected: true, detail: '', meta: 'none', manage: true,
    label: '新对话', open: false, pinned: true, summary: ['running', 'failed', 'unread'], count: 2,
    current: false, disabled: false, shortcut: false, badge: 'none',
  },
  argTypes: {
    connection: { control: 'inline-radio', options: ['online', 'connecting', 'offline'] },
    storage: { control: 'inline-radio', options: ['none', 'warning', 'full'] },
    badge: { control: 'inline-radio', options: ['none', 'warning', 'full'] },
    page: { control: 'inline-radio', options: ['none', 'new', 'archive', 'settings'] },
    status: { control: 'select', options: statuses },
    meta: { control: 'inline-radio', options: ['none', 'subagents-running', 'subagents-unverified'] },
    summary: { control: 'check', options: statuses.filter(status => status !== 'idle' && status !== 'interrupted') },
    count: { control: { type: 'number', min: 1, max: 9 } },
  },
} satisfies Meta<typeof WholeSidebar>;
export default meta;
type Story = StoryObj<typeof meta>;
const only = (...names: (keyof Args)[]) => ({ controls: { include: names } });

export const Whole: Story = { name: '整体', parameters: only('connection', 'storage', 'page', 'empty', 'collapseSecondGroup') };
export const WholePhone: Story = { name: '整体 · 手机', globals: phone, parameters: only('connection', 'storage', 'page', 'empty', 'collapseSecondGroup') };
export const Row: Story = { name: '对话行', render: args => <RowDemo {...args}/>, parameters: only('title', 'status', 'unread', 'selected', 'detail', 'meta', 'manage') };
export const Group: Story = { name: '工作区分组', args: { label: '示例站点' }, render: args => <GroupDemo key={String(args.open)} {...args}/>, parameters: only('label', 'open', 'pinned', 'summary', 'count') };
export const Action: Story = { name: '侧栏动作', render: args => <ActionDemo {...args}/>, parameters: only('label', 'current', 'disabled', 'shortcut', 'badge') };
export const Connectivity: Story = { name: '连接状态', render: args => <ConnectionDemo {...args}/>, parameters: only('connection') };

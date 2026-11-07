import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Archive, FolderOpen, FolderPlus, HardDrive, PanelLeft, Puzzle, Search, Settings, SquarePen } from 'lucide-react';
import { CommandPalette, type PaletteItem } from '../../src/web/patterns/command-palette.tsx';
import { Button, Kbd, modifierKey } from '../../src/web/ui/controls.tsx';
import { conversationStatus } from '../../src/web/conversation-status.ts';
import { conversations, workspaces } from './fixtures.tsx';
import { Page, phone, useReadout } from './catalog.tsx';

type Args = { query: string; search: 'ready' | 'searching' | 'failed'; attention: boolean };

/** Mirrors workbench-search.tsx: empty input lists attention first, then recent, then actions; typing searches titles, workspaces and actions. */
function PaletteDemo({ query: initialQuery, search, attention }: Args) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState(initialQuery);
  const [readout, say] = useReadout();
  const items = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const match = (text: string) => !term || text.toLocaleLowerCase().includes(term);
    const flagged = attention ? conversations.filter(conversation => conversationStatus(conversation).status !== 'idle') : [];
    const list = term ? (search === 'ready' ? conversations.filter(conversation => match(conversation.title)) : [])
      : [...flagged, ...conversations.filter(conversation => !flagged.includes(conversation))].slice(0, 8);
    const label = (id: string) => workspaces.find(workspace => workspace.id === id)?.label ?? '未登记工作区';
    const result: PaletteItem[] = list.map(conversation => {
      const { status, label: statusLabel } = conversationStatus(conversation);
      return { id: `c:${conversation.id}`, group: term ? '对话' : flagged.includes(conversation) ? '需要关注' : '最近', title: conversation.title,
        detail: label(conversation.workspaceId), status, statusLabel, run: () => say(`打开对话：${conversation.title}`) };
    });
    for (const workspace of workspaces) if (term && match(workspace.label))
      result.push({ id: `w:${workspace.id}`, group: '工作区', title: workspace.label, detail: '在这里新建对话', icon: <FolderOpen size={15}/>, run: () => say(`在 ${workspace.label} 新建对话`) });
    const commands: Omit<PaletteItem, 'group' | 'run'>[] = [
      { id: 'a:new', title: '新对话', icon: <SquarePen size={15}/> },
      { id: 'a:files', title: '工作区文件', icon: <FolderOpen size={15}/> },
      { id: 'a:archive', title: '已归档', icon: <Archive size={15}/> },
      { id: 'a:settings', title: '设置', icon: <Settings size={15}/> },
      { id: 'a:workspaces', title: '管理工作区', icon: <FolderPlus size={15}/> },
      { id: 'a:plugins', title: '插件', icon: <Puzzle size={15}/> },
      { id: 'a:storage', title: '存储', icon: <HardDrive size={15}/> },
      { id: 'a:sidebar', title: '收起或展开侧栏', icon: <PanelLeft size={15}/>, shortcut: [modifierKey, '\\'] },
    ];
    for (const command of commands) if (match(command.title)) result.push({ ...command, group: '操作', run: () => say(`操作：${command.title}`) });
    return result;
  }, [query, search, attention, say]);
  const status = search === 'failed' && query.trim() ? '暂时无法搜索对话，请稍后重试。' : search === 'searching' && query.trim() ? '正在搜索…' : undefined;
  return <Page title="搜索与跳转" lead={<>按 <Kbd keys={[modifierKey, 'K']}/> 打开。方向键选择、回车打开、Esc 关闭；匹配的文字高亮。手机上铺满全屏，并显示“取消”。</>}>
    <Button onClick={() => setOpen(true)}><Search size={15}/>打开搜索</Button>
    {readout}
    <CommandPalette open={open} onOpenChange={setOpen} query={query} onQuery={setQuery} items={items} status={status}/>
  </Page>;
}

const meta = {
  title: '模式/搜索与跳转',
  component: PaletteDemo,
  args: { query: '', search: 'ready', attention: true },
  argTypes: { search: { control: 'inline-radio', options: ['ready', 'searching', 'failed'] } },
  render: args => <PaletteDemo key={JSON.stringify(args)} {...args}/>,
} satisfies Meta<typeof PaletteDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { name: '未输入 · 需要关注与最近' };
export const Results: Story = { name: '输入后 · 分组结果与高亮', args: { query: '示例' } };
export const Searching: Story = { name: '正在搜索', args: { query: '周报', search: 'searching' } };
export const Failed: Story = { name: '搜索失败', args: { query: '周报', search: 'failed' } };
export const NoMatch: Story = { name: '没有匹配', args: { query: '不存在的内容' } };
export const Phone: Story = { name: '手机 · 全屏', globals: phone };

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Archive, Bold, Copy, FolderOpen, MoreHorizontal, Pencil, Plus, Settings, SquarePen, Trash2 } from 'lucide-react';
import { Button, IconButton, Information, Kbd, Menu, MenuItem, MenuSeparator, StatusDot, modifierKey, type ButtonVariant, type StatusKind } from '../../src/web/ui/controls.tsx';
import { Page, Section, Stage, phone, useReadout } from './catalog.tsx';

const variants: ButtonVariant[] = ['primary', 'secondary', 'quiet', 'danger'];
const statuses: StatusKind[] = ['running', 'waiting', 'unread', 'failed', 'unknown', 'interrupted', 'idle'];

type Args = {
  variant: ButtonVariant; size: 'default' | 'small'; disabled: boolean; label: string; icon: boolean;
  tooltip: string; shortcut: boolean; pressed: boolean;
  align: 'start' | 'end'; dangerItem: boolean; disabledItem: boolean;
  summary: string; longContent: boolean;
  status: StatusKind; statusLabel: string; keys: string;
};

function ButtonDemo({ variant, size, disabled, label, icon }: Args) {
  const [readout, say] = useReadout();
  return <Page title="按钮" lead="四种语气：primary 用于本页唯一的主操作，secondary 是默认，quiet 用于工具栏和次要动作，danger 只用于确认破坏性操作。">
    <Stage><Button variant={variant} size={size === 'small' ? 'small' : undefined} disabled={disabled} onClick={() => say(`点击了「${label}」`)}>
      {icon && <SquarePen size={size === 'small' ? 13 : 15}/>}{label}</Button></Stage>
    {readout}
  </Page>;
}
function ButtonMatrix() {
  return <Page title="按钮 · 全部变体">
    <table className="catalog-table"><thead><tr><th>variant</th><th>默认</th><th>small</th><th>带图标</th><th>disabled</th></tr></thead><tbody>
      {variants.map(variant => <tr key={variant}><td><code>{variant}</code></td>
        <td><Button variant={variant}>继续工作</Button></td>
        <td><Button variant={variant} size="small">继续工作</Button></td>
        <td><Button variant={variant}><FolderOpen size={15}/>打开文件</Button></td>
        <td><Button variant={variant} disabled>暂不可用</Button></td>
      </tr>)}
    </tbody></table>
  </Page>;
}
function IconButtonDemo({ label, tooltip, shortcut, pressed, disabled }: Args) {
  const [readout, say] = useReadout();
  return <Page title="图标按钮" lead="没有文字的按钮必须有 label（读屏用）；悬停或聚焦时显示 tooltip，可附带快捷键。触屏设备不显示 tooltip。">
    <Stage>
      <IconButton label={label} tooltip={tooltip || undefined} shortcut={shortcut ? [modifierKey, 'K'] : undefined} aria-pressed={pressed || undefined}
        disabled={disabled} onClick={() => say(`点击了「${label}」`)}><Bold size={16}/></IconButton>
      <span className="catalog-muted">← 悬停或用 Tab 聚焦查看提示</span>
    </Stage>
    {readout}
    <Section title="常见用法">
      <Stage><IconButton label="设置"><Settings size={16}/></IconButton><IconButton label="复制"><Copy size={16}/></IconButton>
        <IconButton label="加粗" aria-pressed><Bold size={16}/></IconButton><IconButton label="暂不可用" disabled><Archive size={16}/></IconButton></Stage>
    </Section>
  </Page>;
}
function MenuDemo({ align, disabled, dangerItem, disabledItem }: Args) {
  const [readout, say] = useReadout();
  return <Page title="菜单" lead="Radix 负责键盘与焦点：方向键移动，Enter 选择，Esc 关闭并回到触发按钮。危险项放在分隔线之后。">
    <Stage style={{ justifyContent: align === 'end' ? 'flex-end' : 'flex-start' }}>
      <Menu label="对话操作" trigger={<MoreHorizontal size={17}/>} align={align} disabled={disabled}>
        <MenuItem onSelect={() => say('重命名')}><Pencil size={15}/>重命名</MenuItem>
        <MenuItem onSelect={() => say('归档')}><Archive size={15}/>归档</MenuItem>
        {disabledItem && <MenuItem disabled onSelect={() => say('不会触发')}><FolderOpen size={15}/>暂不可用的操作</MenuItem>}
        {dangerItem && <><MenuSeparator/><MenuItem tone="danger" onSelect={() => say('删除')}><Trash2 size={15}/>删除对话</MenuItem></>}
      </Menu>
      <Menu label="添加" trigger={<Plus size={18}/>} align={align} disabled={disabled}>
        <MenuItem onSelect={() => say('添加图片')}>添加图片</MenuItem><MenuItem onSelect={() => say('引用工作区文件')}>引用工作区文件</MenuItem>
      </Menu>
    </Stage>
    {readout}
  </Page>;
}
function InformationDemo({ label, summary, longContent }: Args) {
  return <Page title="信息浮层" lead="把次要说明收进一个可点开的摘要里，例如输入框里的模型与权限。浮层默认出现在上方。">
    <Stage style={{ paddingTop: 220 }}>
      <Information label={label} summary={<span>{summary}</span>}>
        <dl><div><dt>模型</dt><dd>示例模型</dd></div><div><dt>思考深度</dt><dd>均衡</dd></div><div><dt>权限</dt><dd>工作区读写</dd></div></dl>
        <p>{longContent ? '这是一段较长的示例说明，用来检查浮层在内容变多时的换行与宽度。配置在首次发送时固定，之后在本对话中保持不变；需要不同配置时请新建对话。' : '配置在本对话中保持不变。'}</p>
      </Information>
    </Stage>
  </Page>;
}
function StatusDotDemo({ status, statusLabel }: Args) {
  return <Page title="状态点" lead="带 label 时作为图片朗读；不带 label 时对读屏隐藏（旁边应有文字）。idle 渲染为空白占位。">
    <Stage><StatusDot status={status} label={statusLabel || undefined}/><code className="catalog-token">{status}</code></Stage>
    <Section title="全部状态">
      <Stage>{statuses.map(item => <span key={item} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><StatusDot status={item}/><code className="catalog-token">{item}</code></span>)}</Stage>
    </Section>
  </Page>;
}
function KbdDemo({ keys }: Args) {
  const list = keys.split(',').map(key => key.trim()).filter(Boolean);
  return <Page title="快捷键" lead={`修饰键按平台显示：当前为 ${modifierKey}。`}>
    <Stage><Kbd keys={list}/></Stage>
    <Section title="常见组合"><Stage><Kbd keys={[modifierKey, 'K']}/><Kbd keys={[modifierKey, '\\']}/><Kbd keys={['↑', '↓']}/><Kbd keys={['↵']}/><Kbd keys={['Esc']}/></Stage></Section>
  </Page>;
}

const meta = {
  title: '基础/控件',
  component: ButtonDemo,
  args: {
    variant: 'primary', size: 'default', disabled: false, label: '继续工作', icon: false,
    tooltip: '加粗', shortcut: true, pressed: false,
    align: 'start', dangerItem: true, disabledItem: false,
    summary: '示例模型 · 均衡', longContent: false,
    status: 'running', statusLabel: '运行中', keys: `${modifierKey}, K`,
  },
  argTypes: {
    variant: { control: 'inline-radio', options: variants },
    size: { control: 'inline-radio', options: ['default', 'small'] },
    align: { control: 'inline-radio', options: ['start', 'end'] },
    status: { control: 'select', options: statuses },
  },
} satisfies Meta<typeof ButtonDemo>;
export default meta;
type Story = StoryObj<typeof meta>;
const only = (...names: (keyof Args)[]) => ({ controls: { include: names } });

export const Buttons: Story = { name: '按钮', parameters: only('variant', 'size', 'disabled', 'label', 'icon') };
export const ButtonVariants: Story = { name: '按钮 · 全部变体', render: () => <ButtonMatrix/>, parameters: { controls: { disable: true } } };
export const IconButtons: Story = { name: '图标按钮', args: { label: '加粗' }, render: args => <IconButtonDemo {...args}/>, parameters: only('label', 'tooltip', 'shortcut', 'pressed', 'disabled') };
export const Menus: Story = { name: '菜单', render: args => <MenuDemo {...args}/>, parameters: only('align', 'disabled', 'dangerItem', 'disabledItem') };
export const Popover: Story = { name: '信息浮层', args: { label: '当前对话配置' }, render: args => <InformationDemo {...args}/>, parameters: only('label', 'summary', 'longContent') };
export const StatusDots: Story = { name: '状态点', render: args => <StatusDotDemo {...args}/>, parameters: only('status', 'statusLabel') };
export const Shortcuts: Story = { name: '快捷键', render: args => <KbdDemo {...args}/>, parameters: only('keys') };
export const PhoneMenus: Story = { name: '菜单 · 手机', render: args => <MenuDemo {...args}/>, globals: phone, parameters: only('align', 'disabled', 'dangerItem', 'disabledItem') };

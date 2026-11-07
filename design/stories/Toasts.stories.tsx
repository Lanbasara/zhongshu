import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Toasts, type ToastView } from '../../src/web/patterns/toasts.tsx';
import { Button, type StatusKind } from '../../src/web/ui/controls.tsx';
import { Page, Section, phone, useReadout } from './catalog.tsx';

type Args = { title: string; detail: string; status: StatusKind | 'none'; action: boolean; autoDismiss: boolean };

const presets: Omit<ToastView, 'id'>[] = [
  { title: '已重命名对话' },
  { title: '已归档「整理示例周报」', detail: '可以在「已归档」中恢复。', action: { label: '撤销', run: () => {} } },
  { title: '「修复示例页面样式」执行失败', detail: '示例工作区', status: 'failed' },
  { title: '「起草示例发布说明」已完成', detail: '示例笔记', status: 'unread', action: { label: '查看', run: () => {} } },
];

/** The caller owns timing; the product keeps the newest three and dismisses each after 6 seconds. */
function ToastDemo({ title, detail, status, action, autoDismiss }: Args) {
  const [toasts, setToasts] = useState<ToastView[]>([{ id: 'initial', title, ...(detail ? { detail } : {}), ...(status !== 'none' ? { status } : {}),
    ...(action ? { action: { label: '查看', run: () => {} } } : {}) }]);
  const [readout, say] = useReadout();
  const serial = useRef(0);
  const dismiss = (id: string) => setToasts(current => current.filter(toast => toast.id !== id));
  const push = (toast: Omit<ToastView, 'id'>) => {
    const id = `toast-${++serial.current}`;
    const withAction = toast.action ? { ...toast, action: { label: toast.action.label, run: () => say(`${toast.action!.label}：${toast.title}`) } } : toast;
    setToasts(current => [...current.slice(-2), { ...withAction, id }]);
    if (autoDismiss) setTimeout(() => dismiss(id), 6000);
  };
  return <div className="catalog-frame">
    <Page title="提示" lead="短暂的结果通知，最新的在最下方，最多同时显示三条。区域是 polite 的 status，读屏会各读一次。桌面在页头下方右侧，手机在顶部。">
      <Section title="添加一条">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{presets.map(preset => <Button key={preset.title} onClick={() => push(preset)}>{preset.status ? `${preset.status} · ` : ''}{preset.title.slice(0, 10)}…</Button>)}</div>
      </Section>
      {readout}
    </Page>
    <Toasts toasts={toasts} onDismiss={dismiss}/>
  </div>;
}

const meta = {
  title: '模式/提示',
  component: ToastDemo,
  args: { title: '已归档「整理示例周报」', detail: '可以在「已归档」中恢复。', status: 'none', action: true, autoDismiss: true },
  argTypes: { status: { control: 'select', options: ['none', 'running', 'waiting', 'unread', 'failed', 'unknown', 'interrupted'] } },
  render: args => <ToastDemo key={JSON.stringify(args)} {...args}/>,
} satisfies Meta<typeof ToastDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: '提示' };
export const WithStatus: Story = { name: '带状态', args: { title: '「修复示例页面样式」执行失败', detail: '示例站点', status: 'failed', action: false } };
export const Phone: Story = { name: '手机', globals: phone };

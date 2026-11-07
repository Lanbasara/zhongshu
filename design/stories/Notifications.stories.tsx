import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { pushMessage, type PushKind } from '../../src/shared/push.ts';
import { DeviceCard, NotificationSettings, type DeviceStatus, type InstallStatus, type NotificationDevice, type NotificationNotice } from '../../src/web/patterns/notifications.tsx';
import { Page, Section, Stage, phone, useReadout } from './catalog.tsx';

/** Story-only examples of notification settings and of the notifications themselves. Nothing is subscribed or sent. */
const at = Date.UTC(2026, 10, 7, 11, 20);
const phoneDevice: NotificationDevice = { id: 'd-phone', label: 'Android · Chrome', thisDevice: false, stale: false, createdAt: at - 86_400_000, deliveredAt: at - 600_000, failedAt: null, failure: null };
const desktopDevice: NotificationDevice = { id: 'd-desktop', label: 'macOS · Chrome', thisDevice: true, stale: false, createdAt: at - 3_600_000, deliveredAt: at - 60_000, failedAt: null, failure: null };
const failingDevice: NotificationDevice = { id: 'd-laptop', label: 'Windows · Edge', thisDevice: false, stale: false, createdAt: at - 7 * 86_400_000, deliveredAt: at - 5 * 86_400_000, failedAt: at - 3_600_000, failure: 'push_service_unreachable' };
const staleDevice: NotificationDevice = { id: 'd-old', label: 'iOS · Safari', thisDevice: false, stale: true, createdAt: at - 30 * 86_400_000, deliveredAt: null, failedAt: null, failure: null };

function Settings({ initial, install, startDevices }: { initial: DeviceStatus['kind']; install: InstallStatus['kind']; startDevices: NotificationDevice[] }) {
  const [readout, say] = useReadout();
  const [device, setDevice] = useState<DeviceStatus>({ kind: initial } as DeviceStatus);
  const [devices, setDevices] = useState(startDevices);
  const [notice, setNotice] = useState<NotificationNotice>();
  const [busy, setBusy] = useState(false);
  const later = (action: () => void) => { setBusy(true); setTimeout(() => { action(); setBusy(false); }, 600); };
  return <div className="settings" style={{ height: '100dvh' }}>
    <div className="settings-tabs" role="tablist" aria-label="设置">
      {['工作区', '插件', '存储', '通知', '账户'].map(label => <button key={label} type="button" role="tab" aria-selected={label === '通知'}>{label}</button>)}
    </div>
    <div className="settings-scroll"><div className="settings-column">
      <NotificationSettings device={device} devices={devices} install={{ kind: install } as InstallStatus} busy={busy} notice={notice}
        onEnable={() => { say('请求通知权限并订阅'); later(() => {
          setDevice({ kind: 'on' }); setNotice({ tone: 'ok', text: '已开启。离开页面后，这台设备会收到提醒。' });
          setDevices(list => list.some(item => item.thisDevice) ? list.map(item => item.thisDevice ? { ...item, stale: false } : item) : [...list, { ...desktopDevice, createdAt: Date.now(), deliveredAt: null }]);
        }); }}
        onDisable={() => { say('取消订阅并从实例移除'); later(() => { setDevice({ kind: 'off' }); setNotice(undefined); setDevices(list => list.filter(item => !item.thisDevice)); }); }}
        onTest={() => { say('给这台设备发测试通知'); later(() => setNotice({ tone: 'ok', text: '测试通知已交给推送服务，几秒内应出现在这台设备上。' })); }}
        onRemove={item => { say(`移除 ${item.label}`); setDevices(list => list.filter(value => value.id !== item.id)); if (item.thisDevice) setDevice({ kind: 'off' }); }}
        onInstall={() => say('弹出浏览器的安装确认')}/>
      {readout}
    </div></div>
  </div>;
}

const titles: Partial<Record<PushKind, string>> = { completed: '周报改版', failed: '整理发布说明', waiting: '清理旧的测试数据', interrupted: '重构登录页' };
/** Roughly how an Android notification shade shows one notification; the real look belongs to the platform. */
function Preview({ kind }: { kind: PushKind }) {
  const message = pushMessage({ kind, conversationId: '11111111-1111-4111-8111-111111111111', harnessId: kind === 'waiting' ? 'dsh' : 'codex', title: titles[kind] });
  return <div style={{ display: 'flex', gap: 12, width: 340, padding: '12px 14px', borderRadius: 18, background: 'var(--zs-surface)', boxShadow: 'var(--zs-elevation-action)', border: '1px solid var(--zs-line)' }}>
    <svg width="28" height="28" viewBox="0 0 512 512" aria-hidden="true" style={{ flex: 'none' }}><rect width="512" height="512" rx="112" fill="#5e6ad2"/>
      <g transform="translate(256 262) skewY(-14) translate(-256 -256)" fill="#fff"><rect x="136" y="176" width="58" height="200" rx="18"/><rect x="227" y="128" width="58" height="268" rx="18"/>
        <rect x="326" y="160" width="46" height="222" rx="14" fill="none" stroke="#fff" strokeWidth="22"/></g></svg>
    <div style={{ minWidth: 0, display: 'grid', gap: 2 }}>
      <span style={{ fontSize: 'var(--zs-type-caption)', color: 'var(--zs-text-muted)' }}>中书 · 现在</span>
      <strong style={{ fontSize: 'var(--zs-type-control)', fontWeight: 600 }}>{message.title}</strong>
      <span style={{ fontSize: 'var(--zs-type-control)', color: 'var(--zs-text-secondary)' }}>{message.body}</span>
    </div>
  </div>;
}

function Catalog() {
  return <Page title="通知与安装" lead="离开页面后提醒你：对话完成、失败、Agent 在等回答或批准、Harness 账号需要处理。通知只说明发生了什么，点开后经正常登录查看详情。">
    <Section title="通知长什么样" note="标题是对话标题，正文是固定文案，不含消息、提问或文件内容。同一个对话的新通知会替换旧的；点开直达对应对话，账号提醒打开设置。">
      <Stage stack style={{ justifyItems: 'start', background: 'var(--zs-surface-subtle)' }}>
        {(['completed', 'failed', 'waiting', 'interrupted', 'account', 'test'] as const).map(kind => <Preview key={kind} kind={kind}/>)}
      </Stage>
    </Section>
    <Section title="这台设备的各种状态" note="由浏览器权限、订阅和实例记录共同决定。">
      <Stage stack>
        {(['off', 'on', 'stale', 'denied', 'needs-install', 'unsupported'] as const).map(kind =>
          <DeviceCard key={kind} device={{ kind }} onEnable={() => {}} onDisable={() => {}} onTest={() => {}}/>)}
      </Stage>
    </Section>
  </Page>;
}
const meta = {
  title: '工作台/通知与安装',
  component: Settings,
  args: { initial: 'off', install: 'available', startDevices: [phoneDevice, failingDevice, staleDevice] },
  argTypes: {
    initial: { control: 'select', options: ['checking', 'off', 'on', 'stale', 'denied', 'needs-install', 'unsupported'] },
    install: { control: 'inline-radio', options: ['available', 'installed', 'ios', 'manual'] },
  },
  render: args => <Settings key={JSON.stringify(args)} {...args}/>,
} satisfies Meta<typeof Settings>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = { name: '桌面 · 设置' };
export const DesktopOn: Story = { name: '桌面 · 已开启', args: { initial: 'on', install: 'installed', startDevices: [phoneDevice, desktopDevice, failingDevice] } };
export const Phone: Story = { name: '手机 · 设置', globals: phone };
export const PhoneIos: Story = { name: '手机 · iPhone 未添加到主屏幕', args: { initial: 'needs-install', install: 'ios', startDevices: [desktopDevice] }, globals: phone };
export const States: Story = { name: '通知与状态一览', render: () => <Catalog/> };
export const PhoneStates: Story = { name: '手机 · 通知与状态一览', render: () => <Catalog/>, globals: phone };

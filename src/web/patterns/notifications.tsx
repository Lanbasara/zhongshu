import { Bell, BellOff, Download, Monitor, Send, Smartphone, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../ui/controls.tsx';
import './notifications.css';

/** Where this browser stands with notifications. Decided by the feature layer from permission, subscription and server state. */
export type DeviceStatus =
  | { kind: 'checking' }
  | { kind: 'unsupported' }
  /** iPhone and iPad deliver notifications only to a Home Screen app. */
  | { kind: 'needs-install' }
  | { kind: 'denied' }
  | { kind: 'off' }
  | { kind: 'on' }
  /** Subscribed for an earlier instance key, or the server no longer knows this subscription. */
  | { kind: 'stale' };
export type NotificationDevice = {
  id: string; label: string; thisDevice: boolean; stale: boolean;
  createdAt: number; deliveredAt: number | null; failedAt: number | null; failure: string | null;
};
export type InstallStatus = { kind: 'installed' } | { kind: 'available' } | { kind: 'ios' } | { kind: 'manual' };
export type NotificationNotice = { tone: 'ok' | 'error'; text: string };

const date = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const failures: Record<string, string> = {
  subscription_key_changed: '推送密钥已更换，需要在这台设备上重新开启',
  push_rate_limited: '发送太频繁，这一条被跳过',
  push_service_unreachable: '连不上推送服务',
};
export function failureText(code: string): string {
  if (failures[code]) return failures[code];
  const status = /^push_service_(\d{3})$/.exec(code)?.[1];
  return status ? `推送服务没有接收（${status}）` : '发送失败';
}

/**
 * Notification and install settings (ADR 0018). Presentation only: permission prompts, subscriptions and
 * delivery belong to the caller.
 */
export function NotificationSettings({ device, devices, install, busy, notice, onEnable, onDisable, onTest, onRemove, onInstall }: {
  device: DeviceStatus; devices?: NotificationDevice[]; install: InstallStatus; busy?: boolean; notice?: NotificationNotice;
  onEnable(): void; onDisable(): void; onTest(): void; onRemove(device: NotificationDevice): void; onInstall(): void;
}) {
  return <>
    <section className="settings-section" aria-labelledby="notifications-title">
      <h2 id="notifications-title">通知</h2>
      <p className="settings-lead">离开页面后，对话完成、失败，或 Agent 在等你回答或批准时，提醒开启了通知的设备。通知显示对话标题和发生了什么，不含消息、提问或文件内容；有设备正在看这个对话时不提醒。</p>
      <DeviceCard device={device} busy={busy} notice={notice} onEnable={onEnable} onDisable={onDisable} onTest={onTest}/>
      <p className="settings-note">安卓和电脑上的 Chrome 经 Google 的推送服务送达，设备要能连上 Google；暂时连不上时，通知最多保留 12 小时，之后作废。</p>
      <h3 className="settings-subheading">已开启通知的设备</h3>
      {!devices ? <p className="settings-note" role="status">正在读取…</p>
        : devices.length ? <ul className="settings-list">{devices.map(item => <li key={item.id}>
          {/^(Android|iOS|iPadOS)\b/.test(item.label) ? <Smartphone size={15} className="notify-device-icon" aria-hidden="true"/> : <Monitor size={15} className="notify-device-icon" aria-hidden="true"/>}
          <div className="settings-item-text">
            <strong>{item.label}{item.thisDevice && <span className="notify-chip">这台设备</span>}</strong>
            <small>{deviceLine(item)}</small>
          </div>
          <IconButton label={`移除设备：${item.label}`} tooltip="移除：这台设备不再收到通知" disabled={busy} onClick={() => onRemove(item)}><Trash2 size={15}/></IconButton>
        </li>)}</ul>
        : <p className="settings-note">还没有设备开启通知。</p>}
    </section>
    <section className="settings-section notify-install" aria-labelledby="install-title">
      <h2 id="install-title">安装</h2>
      <p className="settings-lead">安装后，中书有自己的图标和窗口，不和浏览器标签混在一起；支持的设备上，图标会显示未读数。</p>
      <div className="settings-card"><Install install={install} busy={busy} onInstall={onInstall}/></div>
    </section>
  </>;
}

/** This browser's notification state and its actions. */
export function DeviceCard({ device, busy, notice, onEnable, onDisable, onTest }: {
  device: DeviceStatus; busy?: boolean; notice?: NotificationNotice; onEnable(): void; onDisable(): void; onTest(): void;
}) {
  return <div className="settings-card">
    <DeviceState device={device} busy={busy} onEnable={onEnable} onDisable={onDisable} onTest={onTest}/>
    {notice && <p className={notice.tone === 'error' ? 'settings-alert' : 'notify-ok'} role="status">{notice.text}</p>}
  </div>;
}
function DeviceState({ device, busy, onEnable, onDisable, onTest }: { device: DeviceStatus; busy?: boolean; onEnable(): void; onDisable(): void; onTest(): void }) {
  const head = (on: boolean, text: string) => <div className="notify-state" data-on={on || undefined}>
    {on ? <Bell size={16} aria-hidden="true"/> : <BellOff size={16} aria-hidden="true"/>}<strong>这台设备</strong><span>{text}</span></div>;
  switch (device.kind) {
    case 'checking': return <>{head(false, '正在检查…')}</>;
    case 'unsupported': return <>{head(false, '不支持')}<p className="settings-note">这个浏览器不支持网页通知。换用 Chrome、Edge、Firefox 或 Safari 的较新版本。</p></>;
    case 'needs-install': return <>{head(false, '需要先添加到主屏幕')}<p className="settings-note">iPhone 和 iPad 只给主屏幕上的应用发通知：在 Safari 中点“分享”→“添加到主屏幕”，再从主屏幕打开中书，回到这里开启。</p></>;
    case 'denied': return <>{head(false, '浏览器已拒绝')}<p className="settings-note">在浏览器的网站设置里允许中书发送通知，再回来开启。</p></>;
    case 'off': return <>{head(false, '未开启')}<div className="settings-actions"><Button variant="primary" size="small" disabled={busy} onClick={onEnable}><Bell size={14}/>开启通知</Button></div></>;
    case 'stale': return <>{head(false, '需要重新开启')}<p className="settings-note">实例的推送密钥已更换，或这台设备的订阅已失效。</p>
      <div className="settings-actions"><Button variant="primary" size="small" disabled={busy} onClick={onEnable}><Bell size={14}/>重新开启</Button></div></>;
    case 'on': return <>{head(true, '已开启')}<div className="settings-actions">
      <Button size="small" disabled={busy} onClick={onTest}><Send size={14}/>发送测试通知</Button>
      <Button variant="quiet" size="small" disabled={busy} onClick={onDisable}>关闭</Button></div></>;
  }
}

function deviceLine(item: NotificationDevice): string {
  const parts = [`开启于 ${date.format(item.createdAt)}`];
  if (item.stale) parts.push('需要重新开启');
  else if (item.failure && (item.failedAt ?? 0) >= (item.deliveredAt ?? 0)) parts.push(`最近一次失败：${failureText(item.failure)}`);
  else if (item.deliveredAt) parts.push(`最近送达 ${date.format(item.deliveredAt)}`);
  return parts.join(' · ');
}

function Install({ install, busy, onInstall }: { install: InstallStatus; busy?: boolean; onInstall(): void }) {
  switch (install.kind) {
    case 'installed': return <p className="notify-ok">已安装，正在独立窗口中运行。</p>;
    case 'available': return <Button variant="primary" size="small" disabled={busy} onClick={onInstall}><Download size={14}/>安装中书</Button>;
    case 'ios': return <p className="settings-note notify-flush">在 Safari 中点“分享”→“添加到主屏幕”。</p>;
    case 'manual': return <p className="settings-note notify-flush">在浏览器菜单中选择“安装应用”或“添加到主屏幕”。如果已经装过，从桌面或主屏幕的图标打开即可。</p>;
  }
}

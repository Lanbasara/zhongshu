import { useCallback, useEffect, useRef, useState } from 'react';
import type { PushState } from '../shared/push.ts';
import { NotificationSettings, failureText, type DeviceStatus, type NotificationDevice, type NotificationNotice } from './patterns/notifications.tsx';
import { disableDevice, enableDevice, install, installKind, isAndroid, localDevice, onInstallChange, ownFingerprint, readPushState, removeDevice, testDevice, type LocalDevice } from './push-client.ts';
import { RequestError } from './workbench-client.ts';

const errors: Record<string, string> = {
  notifications_denied: '浏览器拒绝了通知。可以在浏览器的网站设置里改为允许。',
  notifications_dismissed: '没有允许通知，这台设备保持关闭。',
  push_service_not_allowed: '这个浏览器使用的推送服务不在中书支持的范围内。',
  push_device_limit: '已开启通知的设备太多，先移除不用的设备。',
  service_worker_unavailable: '通知组件没能启动，刷新页面后再试。',
};
function errorText(reason: unknown): string {
  if (reason instanceof RequestError) return errors[reason.code] ?? '操作没有完成，请稍后重试。';
  if (reason instanceof DOMException && reason.name === 'NotAllowedError') return errors.notifications_denied!;
  if (reason instanceof DOMException && reason.name === 'AbortError') return '推送服务暂时连不上，这台设备可能连不上 Google 等推送服务。稍后再试。';
  return '操作没有完成，请稍后重试。';
}

/** Settings → 通知 (ADR 0018). The pattern renders; this component owns permission, subscription and delivery. */
export function NotificationSettingsPanel({ csrf, report }: { csrf: string; report(reason: unknown): void }) {
  const [state, setState] = useState<PushState>();
  const [local, setLocal] = useState<LocalDevice>();
  const [own, setOwn] = useState<string>();
  const [installState, setInstall] = useState(installKind);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NotificationNotice>();
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const next = await readPushState();
      const [device, fingerprint] = await Promise.all([localDevice(next).catch((): LocalDevice => ({ kind: 'unsupported' })), ownFingerprint().catch(() => undefined)]);
      if (!alive.current) return;
      setState(next); setLocal(device); setOwn(fingerprint);
    } catch (reason) { if (alive.current) report(reason); }
  }, [report]);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [refresh]);
  useEffect(() => onInstallChange(() => setInstall(installKind())), []);

  const run = async (action: () => Promise<NotificationNotice | undefined>) => {
    if (busy) return;
    setBusy(true); setNotice(undefined);
    try { const result = await action(); if (alive.current) setNotice(result); }
    catch (reason) { if (alive.current) setNotice({ tone: 'error', text: errorText(reason) }); }
    finally { if (alive.current) setBusy(false); await refresh(); }
  };
  // The permission prompt needs the click itself, so enabling starts without any await before it.
  const enable = () => { if (state) void run(async () => { await enableDevice(state.publicKey, csrf); return { tone: 'ok', text: '已开启。离开页面后，这台设备会收到提醒。' }; }); };
  const disable = () => void run(async () => { await disableDevice(local?.deviceId, csrf); return { tone: 'ok', text: '已关闭，这台设备不再收到通知。' }; });
  const test = () => { const id = local?.deviceId; if (id) void run(async () => {
    const result = await testDevice(id, csrf);
    return result.delivered ? { tone: 'ok', text: '测试通知已交给推送服务，几秒内应出现在这台设备上。' } : { tone: 'error', text: `没有发出：${failureText(result.failure ?? '')}。` };
  }); };
  const remove = (device: NotificationDevice) => void run(async () => {
    if (device.thisDevice) await disableDevice(device.id, csrf); else await removeDevice(device.id, csrf);
    return { tone: 'ok', text: `已移除：${device.label}。` };
  });
  const installNow = () => void run(async () => { await install(); setInstall(installKind()); return undefined; });

  const device: DeviceStatus = local ? { kind: local.kind } : { kind: 'checking' };
  const devices = state?.devices.map(item => ({ id: item.id, label: item.label, thisDevice: item.fingerprint === own, stale: !item.current,
    createdAt: item.createdAt, deliveredAt: item.deliveredAt, failedAt: item.failedAt, failure: item.failure }));
  return <NotificationSettings device={device} devices={devices} install={{ kind: installState }} android={isAndroid()} busy={busy || !state} notice={notice}
    onEnable={enable} onDisable={disable} onTest={test} onRemove={remove} onInstall={installNow}/>;
}

import { z } from 'zod';
import { pushStateSchema, pushSubscribeResponseSchema, pushTestResponseSchema, type PushState } from '../shared/push.ts';
import { RequestError } from './workbench-client.ts';
import { privateRequest } from './private-api.ts';

/**
 * Browser side of notifications and install (ADR 0018). The service worker only shows notifications and
 * opens their entry; it never intercepts requests.
 */
const call = <T>(path: string, schema: z.ZodType<T>, options: { csrf?: string; body?: unknown } = {}) => privateRequest(`/push${path}`, schema, options);
export const readPushState = () => call('', pushStateSchema);
export const testDevice = (id: string, csrf: string) => call(`/devices/${id}/test`, pushTestResponseSchema, { csrf, body: {} });
export const removeDevice = (id: string, csrf: string) => call(`/devices/${id}/remove`, z.object({ ok: z.literal(true) }), { csrf, body: {} });

const workerSupported = () => typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator;
export const pushSupported = () => workerSupported() && 'PushManager' in window && 'Notification' in window;
export const isAppleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = () => /Android/.test(navigator.userAgent);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Registered on every load so the worker stays current; it has no fetch handler, so pages are unaffected. */
export function registerWorker(): void {
  if (!workerSupported()) return;
  void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => { /* notifications stay unavailable */ });
}

/** The browser's install offer arrives once, early; it is kept until the user takes it. */
type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let installOffer: InstallEvent | undefined;
const installListeners = new Set<() => void>();
export function captureInstallOffer(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installOffer = event as InstallEvent; for (const listener of installListeners) listener(); });
  window.addEventListener('appinstalled', () => { installOffer = undefined; for (const listener of installListeners) listener(); });
}
export function onInstallChange(listener: () => void): () => void { installListeners.add(listener); return () => installListeners.delete(listener); }
export function installKind(): 'installed' | 'available' | 'ios' | 'manual' {
  if (isStandalone()) return 'installed';
  if (installOffer) return 'available';
  return isAppleMobile() ? 'ios' : 'manual';
}
export async function install(): Promise<boolean> {
  const offer = installOffer; if (!offer) return false;
  installOffer = undefined;
  await offer.prompt();
  const { outcome } = await offer.userChoice;
  for (const listener of installListeners) listener();
  return outcome === 'accepted';
}

/** "Android · Chrome", "macOS · Edge": enough to tell devices apart without storing the user agent. */
export function deviceLabel(): string {
  const agent = navigator.userAgent;
  const system = /Android/.test(agent) ? 'Android' : /iPad/.test(agent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPadOS'
    : /iPhone|iPod/.test(agent) ? 'iOS' : /Windows/.test(agent) ? 'Windows' : /CrOS/.test(agent) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(agent) ? 'macOS'
    : /Linux/.test(agent) ? 'Linux' : '设备';
  const browser = /EdgA?\//.test(agent) ? 'Edge' : /SamsungBrowser\//.test(agent) ? 'Samsung' : /Firefox\/|FxiOS\//.test(agent) ? 'Firefox'
    : /OPR\//.test(agent) ? 'Opera' : /Chrome\/|CriOS\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : '浏览器';
  return `${system} · ${browser}`;
}

async function fingerprint(endpoint: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
  let binary = ''; for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
}
const keyBytes = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const a = new Uint8Array(current); const b = keyBytes(publicKey);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
async function registration(): Promise<ServiceWorkerRegistration> {
  registerWorker();
  return await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => setTimeout(() => reject(new RequestError('service_worker_unavailable')), 10_000))]);
}

export type LocalDevice = { kind: 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on' | 'stale'; deviceId?: string };
/** This browser's standing, from its permission, its own subscription and the instance's device list. */
export async function localDevice(state: PushState): Promise<LocalDevice> {
  if (!pushSupported()) return { kind: isAppleMobile() && !isStandalone() ? 'needs-install' : 'unsupported' };
  if (Notification.permission === 'denied') return { kind: 'denied' };
  const subscription = await (await registration()).pushManager.getSubscription();
  if (!subscription) return { kind: 'off' };
  const own = await fingerprint(subscription.endpoint);
  const device = state.devices.find(item => item.fingerprint === own);
  if (!device || !device.current || !sameKey(subscription, state.publicKey) || Notification.permission !== 'granted') return { kind: 'stale', ...(device ? { deviceId: device.id } : {}) };
  return { kind: 'on', deviceId: device.id };
}
export async function ownFingerprint(): Promise<string | undefined> {
  if (!pushSupported()) return undefined;
  const subscription = await (await registration()).pushManager.getSubscription();
  return subscription ? fingerprint(subscription.endpoint) : undefined;
}

/** Must run inside the click that asked for it: browsers only show the permission prompt for a user gesture. */
export async function enableDevice(publicKey: string, csrf: string): Promise<string> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new RequestError(permission === 'denied' ? 'notifications_denied' : 'notifications_dismissed');
  const manager = (await registration()).pushManager;
  const existing = await manager.getSubscription();
  // A subscription made for an earlier instance key cannot be reused.
  if (existing && !sameKey(existing, publicKey)) await existing.unsubscribe();
  const subscription = existing && sameKey(existing, publicKey) ? existing : await manager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const json = subscription.toJSON();
  const { id } = await call('/devices', pushSubscribeResponseSchema, { csrf, body: { endpoint: subscription.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' }, label: deviceLabel() } });
  return id;
}
/** Removes this browser's subscription locally first, so a failed server call still stops delivery here. */
export async function disableDevice(deviceId: string | undefined, csrf: string): Promise<void> {
  const subscription = await (await registration()).pushManager.getSubscription();
  await subscription?.unsubscribe().catch(() => false);
  if (deviceId) await removeDevice(deviceId, csrf).catch(error => { if (!(error instanceof RequestError && error.code === 'push_device_not_found')) throw error; });
}

/** Unread count on the installed app's icon, where the platform offers it. */
export function setBadge(count: number): void {
  const target = navigator as Navigator & { setAppBadge?(count?: number): Promise<void>; clearAppBadge?(): Promise<void> };
  try { void (count > 0 ? target.setAppBadge?.(count) : target.clearAppBadge?.())?.catch(() => {}); } catch { /* optional */ }
}

/** Entries a notification click may ask an open page to show. */
export type OpenRequest = { kind: 'conversation'; id: string; notice?: string } | { kind: 'settings'; tab?: string } | { kind: 'schedule'; tab?: string } | { kind: 'home' };
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A conversation, optionally at the turn an agent notification points to (ADR 0021). */
const conversationEntry = new RegExp(`^#(${uuid})(?::notice:(${uuid}))?$`);
const settingsEntry = /^#settings(?::([a-z]{1,32}))?$/;
const scheduleEntry = /^#schedule(?::([a-z]{1,32}))?$/;
export function parseEntry(hash: string): OpenRequest | undefined {
  const conversation = conversationEntry.exec(hash);
  if (conversation) return { kind: 'conversation', id: conversation[1]!, ...(conversation[2] ? { notice: conversation[2] } : {}) };
  const schedule = scheduleEntry.exec(hash);
  if (schedule) return schedule[1] ? { kind: 'schedule', tab: schedule[1] } : { kind: 'schedule' };
  const settings = settingsEntry.exec(hash);
  if (settings) return settings[1] ? { kind: 'settings', tab: settings[1] } : { kind: 'settings' };
  return undefined;
}
/** Messages from this origin's service worker only. */
export function onNotificationOpen(listener: (request: OpenRequest) => void): () => void {
  if (!workerSupported()) return () => {};
  const handle = (event: MessageEvent) => {
    if (event.origin !== location.origin) return;
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (!data || data.type !== 'zhongshu:open' || typeof data.url !== 'string' || !data.url.startsWith('/')) return;
    listener(parseEntry(new URL(data.url, location.origin).hash) ?? { kind: 'home' });
  };
  navigator.serviceWorker.addEventListener('message', handle);
  return () => navigator.serviceWorker.removeEventListener('message', handle);
}

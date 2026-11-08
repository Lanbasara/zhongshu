// Push-only service worker (ADR 0018). It shows notifications and opens their entry, nothing else:
// no fetch handler and no caches, so every page and API request still goes to the server.
const kinds = new Set(['completed', 'failed', 'interrupted', 'waiting', 'account', 'test', 'agent']);
/** Entries a notification may open: the app root, a conversation (optionally at an agent notice), a settings tab, or the schedule. */
const entry = /^\/(#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:notice:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?|settings(:[a-z]{1,32})?|schedule(:[a-z]{1,32})?))?$/;
const text = (value, limit) => (typeof value === 'string' && value.length <= limit ? value : '');
const safeEntry = value => (typeof value === 'string' && entry.test(value) ? value : '/');

function read(event) {
  try {
    const value = event.data ? event.data.json() : null;
    if (!value || value.v !== 1 || !kinds.has(value.kind)) return null;
    return {
      title: text(value.title, 120) || '中书', body: text(value.body, 240), url: safeEntry(value.url), tag: text(value.tag, 120) || 'zhongshu',
      badge: Number.isSafeInteger(value.badge) && value.badge >= 0 && value.badge < 100000 ? value.badge : undefined,
    };
  } catch { return null; }
}

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', event => {
  // A message this worker cannot read still gets a visible notice; browsers require one for every push.
  const message = read(event) ?? { title: '中书', body: '有新的动态。', url: '/', tag: 'zhongshu' };
  event.waitUntil((async () => {
    if (message.badge !== undefined && 'setAppBadge' in self.navigator) {
      try { if (message.badge > 0) await self.navigator.setAppBadge(message.badge); else await self.navigator.clearAppBadge(); } catch { /* badges are optional */ }
    }
    await self.registration.showNotification(message.title, {
      body: message.body, tag: message.tag, renotify: true, lang: 'zh-CN', icon: '/icon-192.png', badge: '/badge-96.png', data: { url: message.url },
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = safeEntry(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .filter(client => new URL(client.url).origin === self.location.origin);
    const target = windows.find(client => client.focused) ?? windows.find(client => client.visibilityState === 'visible') ?? windows[0];
    if (target) {
      // An open page switches in place, keeping drafts and the connection. Focus may be refused; the switch still happens.
      try { await target.focus(); } catch { /* the page still switches */ }
      target.postMessage({ type: 'zhongshu:open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

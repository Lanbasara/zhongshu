// Browser history for the workbench: each page has its own address, and on phones each open overlay adds one entry so
// the back gesture closes it before leaving the page. Native <dialog> elements are left to the browser, which closes
// them on back by itself.
import { useEffect, useId, useRef } from 'react';
import { workspaceIdSchema } from '../shared/workbench.ts';

export type Route =
  | { kind: 'home' }
  | { kind: 'conversation'; id: string; notice?: string }
  | { kind: 'new'; workspaceId?: string }
  | { kind: 'draft'; id: string }
  | { kind: 'schedule'; tab?: string }
  | { kind: 'settings'; tab?: string }
  | { kind: 'archive' };

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A conversation, optionally at the turn an agent notification points to (ADR 0021). */
const conversationEntry = new RegExp(`^#(${uuid})(?::notice:(${uuid}))?$`);
const draftEntry = new RegExp(`^#draft/(${uuid})$`);
const tabbed = (name: string) => new RegExp(`^#${name}(?::([a-z]{1,32}))?$`);
const scheduleEntry = tabbed('schedule');
const settingsEntry = tabbed('settings');

export function parseRoute(hash: string): Route {
  const conversation = conversationEntry.exec(hash);
  if (conversation) return { kind: 'conversation', id: conversation[1]!, ...(conversation[2] ? { notice: conversation[2] } : {}) };
  const draft = draftEntry.exec(hash);
  if (draft) return { kind: 'draft', id: draft[1]! };
  if (hash === '#new') return { kind: 'new' };
  if (hash.startsWith('#new:')) {
    try {
      const workspaceId = workspaceIdSchema.safeParse(decodeURIComponent(hash.slice(5)));
      if (workspaceId.success) return { kind: 'new', workspaceId: workspaceId.data };
    } catch { /* An unreadable workspace opens a plain draft. */ }
    return { kind: 'new' };
  }
  const schedule = scheduleEntry.exec(hash);
  if (schedule) return schedule[1] ? { kind: 'schedule', tab: schedule[1] } : { kind: 'schedule' };
  const settings = settingsEntry.exec(hash);
  if (settings) return settings[1] ? { kind: 'settings', tab: settings[1] } : { kind: 'settings' };
  if (hash === '#archive') return { kind: 'archive' };
  return { kind: 'home' };
}
/** The address of a route; the home page has no fragment. A notice marker is never written back. */
export function routeHash(route: Route): string {
  switch (route.kind) {
    case 'conversation': return `#${route.id}`;
    case 'new': return `#new:${encodeURIComponent(route.workspaceId ?? '')}`;
    case 'draft': return `#draft/${route.id}`;
    case 'schedule': return route.tab && route.tab !== 'calendar' ? `#schedule:${route.tab}` : '#schedule';
    case 'settings': return route.tab && route.tab !== 'workspaces' ? `#settings:${route.tab}` : '#settings';
    case 'archive': return '#archive';
    case 'home': return '';
  }
}

type OverlayState = { zhOverlays?: string[] } | null;
const overlaysOf = (state: unknown): string[] => Array.isArray((state as OverlayState)?.zhOverlays) ? (state as { zhOverlays: string[] }).zhOverlays : [];

/**
 * One owner for history writes. Overlay entries sit above the page entry; a page change first steps back over them.
 * Steps back are asynchronous, so writes requested meanwhile wait until the browser reports the step.
 */
class History {
  /** Overlay tokens above the current page entry, oldest first. */
  private stack: string[] = [];
  private pendingSteps = 0;
  private waiting: (() => void)[] = [];
  private fallback?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<() => void>();
  private lastHref = '';
  private started = false;

  private start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    // A reload keeps the entry the page was on; overlays are closed after a reload, so that entry is a page again.
    if (overlaysOf(history.state).length) history.replaceState(null, '', location.href);
    this.lastHref = location.href;
    window.addEventListener('popstate', () => {
      if (this.pendingSteps) { this.pendingSteps--; if (!this.pendingSteps) this.flush(); return; }
      this.stack = overlaysOf(history.state);
      this.changed();
    });
    // Typing a new fragment, or a tool that navigates within the document, may report only a hash change.
    window.addEventListener('hashchange', () => { if (location.href !== this.lastHref) { this.stack = []; this.changed(); } });
  }
  private changed(): void {
    this.lastHref = location.href;
    for (const listener of [...this.listeners]) listener();
  }
  private flush(): void {
    if (this.fallback) { clearTimeout(this.fallback); this.fallback = undefined; }
    for (const run of this.waiting.splice(0)) run();
  }
  private whenSettled(run: () => void): void { if (this.pendingSteps) this.waiting.push(run); else run(); }
  private stepBack(count: number): void {
    this.pendingSteps++;
    history.go(-count);
    // A browser that never reports the step must not hold later writes forever.
    this.fallback ??= setTimeout(() => { this.fallback = undefined; this.pendingSteps = 0; this.flush(); }, 1000);
  }

  /** Called after the user moved through history (back, forward or a typed address); not after writes made here. */
  subscribe(listener: () => void): () => void {
    this.start(); this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  /** Show a page at this address: `push` for a page the user moves to, `replace` for a correction of the current one. */
  page(hash: string, mode: 'push' | 'replace'): void {
    this.start();
    this.whenSettled(() => {
      if (this.stack.length) { const count = this.stack.length; this.stack = []; this.stepBack(count); }
      this.whenSettled(() => {
        const target = hash || location.pathname + location.search;
        if (mode === 'push' && (hash || '') === location.hash) return;
        if (mode === 'push') history.pushState(null, '', target); else history.replaceState(null, '', target);
        this.lastHref = location.href;
      });
    });
  }
  openOverlay(token: string): void {
    this.start();
    this.whenSettled(() => {
      this.stack = [...this.stack, token];
      history.pushState({ zhOverlays: this.stack } satisfies OverlayState, '', location.href);
    });
  }
  /** An overlay closed from the page itself: remove its entry when it is the newest one. */
  closeOverlay(token: string): void {
    this.whenSettled(() => {
      if (this.stack.at(-1) !== token) { this.stack = this.stack.filter(value => value !== token); return; }
      this.stack = this.stack.slice(0, -1);
      this.stepBack(1);
    });
  }
  isOpen(token: string): boolean { return this.stack.includes(token); }
}

export const navigation = new History();

/** On phones, give an open overlay its own history entry so the back gesture closes it. */
export function useBackDismiss(open: boolean, close: () => void, enabled: boolean): void {
  const token = useId();
  const closeRef = useRef(close); closeRef.current = close;
  const pushed = useRef(false);
  useEffect(() => {
    if (open && enabled && !pushed.current) { pushed.current = true; navigation.openOverlay(token); }
    else if (!open && pushed.current) { pushed.current = false; navigation.closeOverlay(token); }
  }, [open, enabled, token]);
  useEffect(() => navigation.subscribe(() => {
    if (pushed.current && !navigation.isOpen(token)) { pushed.current = false; closeRef.current(); }
  }), [token]);
  useEffect(() => () => { if (pushed.current) { pushed.current = false; navigation.closeOverlay(token); } }, [token]);
}

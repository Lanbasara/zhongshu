import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountsSchema, accountViewSchema, loginCompleteSchema, loginResponseSchema, type AccountStateView, type AccountView, type LoginResponse } from '../shared/accounts.ts';
import type { HarnessAdapter, HarnessId } from '../harness/types.ts';
import type { PushEvent } from './push.ts';

export class AccountError extends Error {
  readonly code: string; readonly statusCode: number;
  constructor(code: string, statusCode: number) { super(code); this.name = 'AccountError'; this.code = code; this.statusCode = statusCode; }
}
type Entry = {
  adapter: HarnessAdapter;
  view: AccountView;
  checking?: Promise<AccountView>;
  /** The native login identity stays here; the user code is returned once and never kept. */
  login?: { loginId: string; kind: 'device-code' | 'paste-back'; startedAt: number; expiry: NodeJS.Timeout };
  failure?: string;
};
const pushStates = new Set<AccountStateView>(['signed-out', 'rejected']);

/**
 * Harness account status (ADR 0015). Verifies with each vendor through the native adapter, on start, on a timer,
 * on native account notifications and on request. State lives in memory; nothing about credentials is stored.
 */
export function createHarnessAccounts(adapters: readonly HarnessAdapter[], options: {
  notify(event: PushEvent): void;
  log(event: Record<string, string>): void;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  loginTtlMs?: number;
}) {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const loginTtlMs = options.loginTtlMs ?? 20 * 60_000;
  const entries = new Map<HarnessId, Entry>();
  const unsubscribe: (() => void)[] = [];
  let timer: NodeJS.Timeout | undefined; let first: NodeJS.Timeout | undefined; let closed = false;
  const log = (event: Record<string, string>) => { try { options.log(event); } catch { /* logging never breaks status */ } };

  for (const adapter of adapters) {
    if (!adapter.account) continue;
    entries.set(adapter.id, { adapter, view: { harnessId: adapter.id, state: 'checking', canLogin: !!adapter.startLogin } });
    const off = adapter.onAccountEvent?.(event => {
      const entry = entries.get(adapter.id); if (!entry || closed) return;
      if (event.type === 'login') {
        if (entry.login?.loginId !== event.loginId) return;
        settle(entry, event.success ? 'succeeded' : 'failed');
      }
      void check(adapter.id).catch(() => {});
    });
    if (off) unsubscribe.push(off);
  }

  function view(entry: Entry): AccountView {
    const login = entry.login ? { status: 'waiting' as const, startedAt: entry.login.startedAt } : entry.failure ? { status: 'failed' as const, reason: entry.failure } : undefined;
    return accountViewSchema.parse({ ...entry.view, ...(login ? { login } : {}) });
  }
  function entryOf(id: string): Entry {
    const entry = entries.get(id as HarnessId);
    if (!entry) throw new AccountError('harness_not_found', 404);
    return entry;
  }
  /** One verification at a time per Harness; callers asking meanwhile share it. */
  function check(id: HarnessId, maxAgeMs = 0): Promise<AccountView> {
    const entry = entryOf(id);
    if (entry.checking) return entry.checking;
    if (maxAgeMs && entry.view.checkedAt && now() - entry.view.checkedAt < maxAgeMs && entry.view.state !== 'checking') return Promise.resolve(view(entry));
    const previous = entry.view.state;
    entry.checking = (async () => {
      let next: AccountView;
      try {
        const account = await Promise.race([entry.adapter.account!(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('account_timeout')), timeoutMs).unref())]);
        next = { harnessId: id, state: account.state, canLogin: entry.view.canLogin, checkedAt: now(),
          ...(account.identity ? { identity: account.identity } : {}), ...(account.plan ? { plan: account.plan } : {}), ...(account.usage ? { usage: account.usage } : {}),
          ...(account.links ? { links: account.links } : {}) };
      } catch {
        next = { harnessId: id, state: 'disconnected', canLogin: entry.view.canLogin, checkedAt: now() };
      }
      // A rejected credential stays rejected until a verification succeeds, even when the native side later reports plain absence.
      if (previous === 'rejected' && next.state === 'signed-out') next = { ...next, state: 'rejected' };
      entry.view = accountViewSchema.parse(next);
      // Push once when work in that Harness stops being possible; reachability alone stays in the page (startup noise).
      if (!closed && pushStates.has(next.state) && !pushStates.has(previous)) {
        log({ event: 'harness_account_attention', harness: id, state: next.state });
        try { options.notify({ kind: 'account', harnessId: id }); } catch { /* push is best effort */ }
      }
      return view(entry);
    })().finally(() => { entry.checking = undefined; });
    return entry.checking;
  }
  const list = () => accountsSchema.parse({ accounts: [...entries.values()].map(view) });
  async function checkAll(): Promise<void> { await Promise.allSettled([...entries.keys()].map(id => check(id))); }

  function settle(entry: Entry, outcome: 'succeeded' | 'failed' | 'expired'): void {
    if (entry.login) clearTimeout(entry.login.expiry);
    entry.login = undefined;
    entry.failure = outcome === 'succeeded' ? undefined : outcome === 'expired' ? '登录已过期，请重新发起。' : '登录没有完成，可以重新发起。';
    log({ event: `harness_login_${outcome}`, harness: entry.adapter.id });
  }
  async function startLogin(id: string): Promise<LoginResponse> {
    const entry = entryOf(id);
    if (!entry.adapter.startLogin) throw new AccountError('login_not_supported', 409);
    const started = await entry.adapter.startLogin().catch(() => { throw new AccountError('login_start_failed', 502); });
    // A new native start supersedes the old one; keep only the newest identity.
    if (entry.login) clearTimeout(entry.login.expiry);
    const ttl = started.kind === 'paste-back' && started.expiresAt ? Math.max(1000, Math.min(loginTtlMs, started.expiresAt - now())) : loginTtlMs;
    const expiry = setTimeout(() => {
      if (entry.login?.loginId !== started.loginId) return;
      settle(entry, 'expired');
      void entry.adapter.cancelLogin?.(started.loginId).catch(() => {});
    }, ttl);
    expiry.unref();
    entry.login = { loginId: started.loginId, kind: started.kind, startedAt: now(), expiry }; entry.failure = undefined;
    log({ event: 'harness_login_started', harness: entry.adapter.id });
    const account = view(entry);
    return loginResponseSchema.parse(started.kind === 'device-code'
      ? { kind: 'device-code', account, verificationUrl: started.verificationUrl, userCode: started.userCode }
      : { kind: 'paste-back', account, authorizeUrl: started.authorizeUrl, callbackPrefix: started.callbackPrefix });
  }
  /** Finish a paste-back login. A wrong paste leaves the attempt open for another try. */
  async function completeLogin(id: string, callbackUrl: string): Promise<AccountView> {
    const entry = entryOf(id);
    const login = entry.login;
    if (!login || login.kind !== 'paste-back' || !entry.adapter.completeLogin) throw new AccountError('login_not_waiting', 409);
    const outcome = await entry.adapter.completeLogin(login.loginId, callbackUrl).catch((): 'failed' => 'failed');
    if (outcome === 'invalid') throw new AccountError('login_callback_invalid', 400);
    if (entry.login?.loginId !== login.loginId) return view(entry);
    settle(entry, outcome);
    return outcome === 'succeeded' ? check(entry.adapter.id) : view(entry);
  }
  async function cancelLogin(id: string): Promise<AccountView> {
    const entry = entryOf(id);
    const login = entry.login; entry.failure = undefined;
    if (login) {
      clearTimeout(login.expiry); entry.login = undefined;
      await entry.adapter.cancelLogin?.(login.loginId).catch(() => 'notFound');
      log({ event: 'harness_login_canceled', harness: entry.adapter.id });
    }
    return view(entry);
  }

  function start(intervalMs = options.intervalMs ?? 30 * 60_000): void {
    if (closed || !entries.size) return;
    first = setTimeout(() => { void checkAll(); }, 5_000); first.unref();
    timer = setInterval(() => { void checkAll(); }, intervalMs); timer.unref();
  }
  function close(): void {
    closed = true; if (timer) clearInterval(timer); if (first) clearTimeout(first);
    for (const off of unsubscribe) off();
    for (const entry of entries.values()) if (entry.login) clearTimeout(entry.login.expiry);
  }

  async function routes(app: FastifyInstance): Promise<void> {
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AccountError) return reply.code(error.statusCode).send({ error: error.code });
      const code = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
      const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
      if (status === 500) app.log.error({ event: 'harness_account_request_failed' });
      return reply.code(status).send({ error: status === 500 ? 'accounts_unavailable' : 'invalid_request' });
    });
    const params = z.object({ harness: z.enum(['codex', 'dsh']) }).strict();
    const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const parsed = schema.safeParse(value); if (!parsed.success) throw new AccountError('invalid_request', 400); return parsed.data; };
    const noQuery = z.object({}).strict();
    const checkBody = z.object({ maxAgeMs: z.number().int().min(0).max(3_600_000).optional() }).strict();
    app.get('/', async request => { parse(noQuery, request.query); return list(); });
    app.post('/:harness/check', { bodyLimit: 1024 }, async request => {
      const { harness } = parse(params, request.params); const { maxAgeMs } = parse(checkBody, request.body ?? {});
      return check(harness, maxAgeMs);
    });
    app.post('/:harness/login', { bodyLimit: 1024 }, async request => { const { harness } = parse(params, request.params); return startLogin(harness); });
    app.post('/:harness/login/cancel', { bodyLimit: 1024 }, async request => { const { harness } = parse(params, request.params); return cancelLogin(harness); });
    app.post('/:harness/login/complete', { bodyLimit: 8192 }, async request => {
      const { harness } = parse(params, request.params); const { callbackUrl } = parse(loginCompleteSchema, request.body);
      return completeLogin(harness, callbackUrl);
    });
  }

  return { list, check, checkAll, startLogin, completeLogin, cancelLogin, start, close, routes };
}

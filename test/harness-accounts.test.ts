import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { AccountEvent, HarnessAdapter, LoginCompletion, NativeAccount } from '../src/harness/types.ts';
import { buildApp } from '../src/server/app.ts';
import { createAuth } from '../src/server/auth.ts';
import { openDatabase } from '../src/server/database.ts';
import { createHarnessAccounts } from '../src/server/harness-accounts.ts';
import { productMigrations } from '../src/server/migrations.ts';
import type { PushEvent } from '../src/server/push.ts';

/** Synthetic account peer; it proves the monitor's rules, not vendor behaviour. */
function fakeAdapter(id: 'codex' | 'dsh', login: boolean) {
  const state = { next: { state: 'valid', identity: 'a***@example.com' } as NativeAccount | Error | 'hang', cancels: [] as string[], starts: 0 };
  const listeners = new Set<(event: AccountEvent) => void>();
  const adapter = {
    id, async account() { if (state.next === 'hang') return new Promise<NativeAccount>(() => {}); if (state.next instanceof Error) throw state.next; return state.next; },
    ...(login ? {
      async startLogin() { state.starts++; return { kind: 'device-code' as const, loginId: `login-${state.starts}`, verificationUrl: 'https://auth.openai.com/codex/device', userCode: `CODE-${state.starts}XYZ` }; },
      async cancelLogin(loginId: string) { state.cancels.push(loginId); return 'canceled' as const; },
      onAccountEvent(listener: (event: AccountEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    } : {}),
  } as unknown as HarnessAdapter;
  return { adapter, state, emit(event: AccountEvent) { for (const listener of listeners) listener(event); } };
}
function monitor(t: TestContext, options: { loginTtlMs?: number; timeoutMs?: number } = {}) {
  const codex = fakeAdapter('codex', true); const dsh = fakeAdapter('dsh', false);
  const pushes: PushEvent[] = []; const logs: Record<string, string>[] = [];
  const accounts = createHarnessAccounts([codex.adapter, dsh.adapter], { notify: event => pushes.push(event), log: event => logs.push(event), ...options });
  t.after(() => accounts.close());
  return { accounts, codex, dsh, pushes, logs };
}

test('status follows each verification and pushes once when work stops being possible', async t => {
  const { accounts, codex, dsh, pushes, logs } = monitor(t);
  assert.deepEqual(accounts.list().accounts.map(view => [view.harnessId, view.state, view.canLogin]), [['codex', 'checking', true], ['dsh', 'checking', false]]);
  codex.state.next = { state: 'valid', identity: 'a***@example.com', plan: 'Pro', usage: { usedPercent: 74, resetsAt: 1, windowMinutes: 10080 } };
  const valid = await accounts.check('codex');
  assert.equal(valid.state, 'valid'); assert.equal(valid.usage?.usedPercent, 74); assert.ok(valid.checkedAt);
  codex.state.next = { state: 'rejected', identity: 'a***@example.com' };
  await accounts.check('codex'); await accounts.check('codex');
  codex.state.next = { state: 'signed-out' };
  assert.equal((await accounts.check('codex')).state, 'rejected', 'rejected stays until a verification succeeds');
  assert.deepEqual(pushes, [{ kind: 'account', harnessId: 'codex' }], 'rejected then signed-out is one episode');
  codex.state.next = { state: 'valid' }; await accounts.check('codex');
  codex.state.next = { state: 'signed-out' }; await accounts.check('codex');
  assert.equal(pushes.length, 2, 'a new episode pushes again');
  dsh.state.next = new Error('host unreachable');
  assert.equal((await accounts.check('dsh')).state, 'disconnected');
  dsh.state.next = { state: 'unverified' };
  assert.equal((await accounts.check('dsh')).state, 'unverified');
  assert.equal(pushes.length, 2, 'unreachable and unverified stay in the page');
  assert.ok(logs.filter(event => event.event === 'harness_account_attention').length === 2);
  const [one, two] = await Promise.all([accounts.check('dsh'), accounts.check('dsh')]);
  assert.equal(one, two, 'concurrent checks share one verification');
  assert.equal((await accounts.check('dsh', 60_000)).checkedAt, one.checkedAt, 'a recent result is reused when allowed');
});

test('a verification that never answers counts as disconnected', async t => {
  const { accounts, codex } = monitor(t, { timeoutMs: 30 });
  codex.state.next = 'hang';
  assert.equal((await accounts.check('codex')).state, 'disconnected');
});

test('device login: the code goes only to the caller; completion, failure, supersede, cancel and expiry', async t => {
  const { accounts, codex, logs } = monitor(t, { loginTtlMs: 80 });
  const first = await accounts.startLogin('codex');
  assert.ok(first.kind === 'device-code');
  assert.equal(first.userCode, 'CODE-1XYZ'); assert.equal(first.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(first.account.login?.status, 'waiting');
  assert.equal(JSON.stringify(accounts.list()).includes('CODE-'), false, 'reads never carry the user code');
  const second = await accounts.startLogin('codex');
  assert.ok(second.kind === 'device-code'); assert.equal(second.userCode, 'CODE-2XYZ');
  codex.emit({ type: 'login', loginId: 'login-1', success: false });
  assert.equal(accounts.list().accounts[0]!.login?.status, 'waiting', 'a superseded login no longer counts');
  codex.state.next = { state: 'valid' };
  codex.emit({ type: 'login', loginId: 'login-2', success: true });
  await delay(5);
  assert.equal(accounts.list().accounts[0]!.login, undefined);
  assert.equal(accounts.list().accounts[0]!.state, 'valid', 'completion re-verifies');
  await accounts.startLogin('codex');
  codex.emit({ type: 'login', loginId: 'login-3', success: false, reason: 'Login was not completed' });
  assert.deepEqual(accounts.list().accounts[0]!.login, { status: 'failed', reason: '登录没有完成，可以重新发起。' });
  await accounts.startLogin('codex');
  assert.equal((await accounts.cancelLogin('codex')).login, undefined);
  assert.deepEqual(codex.state.cancels, ['login-4']);
  await accounts.startLogin('codex');
  await delay(150);
  assert.deepEqual(accounts.list().accounts[0]!.login, { status: 'failed', reason: '登录已过期，请重新发起。' });
  assert.deepEqual(codex.state.cancels, ['login-4', 'login-5']);
  assert.equal(JSON.stringify(logs).includes('CODE-'), false, 'logs never carry the user code');
  assert.deepEqual(logs.filter(event => event.event?.startsWith('harness_login')).map(event => event.event),
    ['harness_login_started', 'harness_login_started', 'harness_login_succeeded', 'harness_login_started', 'harness_login_failed', 'harness_login_started', 'harness_login_canceled', 'harness_login_started', 'harness_login_expired']);
  await assert.rejects(accounts.startLogin('dsh'), (error: Error & { code?: string }) => error.code === 'login_not_supported', 'an adapter without login refuses');
});

test('account routes sit behind authentication and CSRF', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zhongshu-accounts-http-'));
  const db = openDatabase(directory, productMigrations);
  const password = 'synthetic-test-password-only';
  await createAuth(db, { audit: () => {} }).initialize(password);
  const origin = 'https://workbench.example';
  const codex = fakeAdapter('codex', true);
  const accounts = createHarnessAccounts([codex.adapter], { notify: () => {}, log: () => {} });
  const app = await buildApp({ db, origin, privateRoutes: async scope => { await scope.register(accounts.routes, { prefix: '/accounts' }); } });
  t.after(async () => { accounts.close(); await app.close(); db.close(); await rm(directory, { recursive: true }); });
  assert.equal((await app.inject({ method: 'GET', url: '/api/private/accounts' })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin }, payload: { password } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!; const csrf = login.json().csrfToken as string;
  const post = (url: string, payload: object, headers: Record<string, string> = { 'x-csrf-token': csrf }) => app.inject({ method: 'POST', url, headers: { origin, cookie, ...headers }, payload });
  assert.equal((await post('/api/private/accounts/codex/login', {}, {})).statusCode, 403);
  assert.equal((await post('/api/private/accounts/codex/check', {})).json().state, 'valid');
  const started = await post('/api/private/accounts/codex/login', {});
  assert.equal(started.json().kind, 'device-code'); assert.equal(started.json().userCode, 'CODE-1XYZ');
  const read = await app.inject({ method: 'GET', url: '/api/private/accounts', headers: { cookie } });
  assert.equal(read.body.includes('CODE-1XYZ'), false);
  assert.equal(read.json().accounts[0].login.status, 'waiting');
  assert.equal((await post('/api/private/accounts/codex/login/cancel', {})).json().login, undefined);
  assert.equal((await post('/api/private/accounts/dsh/check', {})).json().error, 'harness_not_found');
  assert.equal((await post('/api/private/accounts/other/check', {})).json().error, 'invalid_request');
});

test('paste-back login: a wrong paste keeps the attempt, success re-verifies, nothing pasted reaches the logs', async t => {
  let completion: LoginCompletion = 'invalid'; const pasted: string[] = []; let signedIn = false;
  const dsh = { id: 'dsh',
    async account(): Promise<NativeAccount> { return signedIn ? { state: 'valid', links: { usage: 'https://platform.example/usage', topUp: 'https://platform.example/top_up' } } : { state: 'signed-out' }; },
    async startLogin() { return { kind: 'paste-back' as const, loginId: 'attempt-1', authorizeUrl: 'https://platform.example/sign_in?state=s', callbackPrefix: 'http://127.0.0.1:3007/oauth/callback', expiresAt: Date.now() + 600_000 }; },
    async completeLogin(_loginId: string, url: string) { pasted.push(url); if (completion === 'succeeded') signedIn = true; return completion; },
    async cancelLogin() { return 'canceled' as const; },
  } as unknown as HarnessAdapter;
  const logs: Record<string, string>[] = []; const pushes: PushEvent[] = [];
  const accounts = createHarnessAccounts([dsh], { notify: event => pushes.push(event), log: event => logs.push(event) });
  t.after(() => accounts.close());
  assert.equal((await accounts.check('dsh')).state, 'signed-out');
  await assert.rejects(accounts.completeLogin('dsh', 'http://127.0.0.1:3007/oauth/callback?code=x&state=s'), (error: Error & { code?: string }) => error.code === 'login_not_waiting');
  const started = await accounts.startLogin('dsh');
  assert.ok(started.kind === 'paste-back'); assert.equal(started.callbackPrefix, 'http://127.0.0.1:3007/oauth/callback');
  assert.equal(JSON.stringify(accounts.list()).includes('platform.example/sign_in'), false, 'reads never carry the sign-in address');
  await assert.rejects(accounts.completeLogin('dsh', 'https://example.com/wrong'), (error: Error & { code?: string }) => error.code === 'login_callback_invalid');
  assert.equal(accounts.list().accounts[0]!.login?.status, 'waiting', 'a wrong paste keeps the attempt');
  completion = 'succeeded';
  const done = await accounts.completeLogin('dsh', 'http://127.0.0.1:3007/oauth/callback?code=secret-code&state=s');
  assert.equal(done.state, 'valid'); assert.equal(done.login, undefined);
  assert.deepEqual(done.links, { usage: 'https://platform.example/usage', topUp: 'https://platform.example/top_up' });
  assert.equal(pasted.length, 2);
  assert.equal(JSON.stringify(logs).includes('secret-code'), false);
  assert.deepEqual(logs.filter(event => event.event?.startsWith('harness_login')).map(event => event.event), ['harness_login_started', 'harness_login_succeeded']);
  await accounts.startLogin('dsh'); completion = 'expired';
  assert.deepEqual((await accounts.completeLogin('dsh', 'http://127.0.0.1:3007/oauth/callback?code=c&state=s')).login, { status: 'failed', reason: '登录已过期，请重新发起。' });
});

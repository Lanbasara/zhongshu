import { useCallback, useEffect, useRef, useState } from 'react';
import { accountsSchema, accountViewSchema, deviceLoginResponseSchema, type AccountView } from '../shared/accounts.ts';
import { AccountAttentionBanner, HarnessAccountCard, type DeviceLogin, type HarnessAccount } from './patterns/harness-accounts.tsx';
import { privateRequest } from './private-api.ts';
import { RequestError } from './workbench-client.ts';

const names = { codex: 'Codex', dsh: 'DSH' } as const;
function usageLabel(minutes: number | undefined): string {
  if (minutes === 10080) return '本周额度';
  if (minutes === 1440) return '今日额度';
  if (minutes && minutes % 60 === 0 && minutes < 1440) return `${minutes / 60} 小时额度`;
  return '额度';
}
export function toCard(view: AccountView): HarnessAccount {
  return { harness: names[view.harnessId], state: view.state, canLogin: view.canLogin,
    ...(view.identity ? { identity: view.identity } : {}), ...(view.plan ? { plan: view.plan } : {}), ...(view.checkedAt ? { checkedAt: view.checkedAt } : {}),
    ...(view.usage ? { usage: { label: usageLabel(view.usage.windowMinutes), usedPercent: view.usage.usedPercent, ...(view.usage.resetsAt ? { resetsAt: view.usage.resetsAt } : {}) } } : {}) };
}

/** Server-held status (ADR 0015). Reads are cheap: they return the last verification without asking the vendor. */
export function useAccounts(report: (reason: unknown) => void) {
  const [accounts, setAccounts] = useState<AccountView[]>();
  const refresh = useCallback(async () => {
    try { setAccounts((await privateRequest('/accounts', accountsSchema)).accounts); }
    catch (reason) { if (!(reason instanceof RequestError && reason.status === 401)) report(reason); }
  }, [report]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 60_000);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  const replace = useCallback((view: AccountView) => setAccounts(list => list?.map(item => item.harnessId === view.harnessId ? view : item) ?? [view]), []);
  return { accounts, refresh, replace };
}
export type Accounts = ReturnType<typeof useAccounts>;

const loginErrors: Record<string, string> = { login_start_failed: '没能向 OpenAI 申请登录码，请检查服务器网络后再试。', login_not_supported: '这个 Harness 不能在页内登录。' };

/** Settings → 账户: one card per Harness; Codex device-code login keeps its user code only in this page. */
export function HarnessAccountsPanel({ csrf, accounts }: { csrf: string; accounts: Accounts }) {
  const { accounts: list, refresh, replace } = accounts;
  const [logins, setLogins] = useState<Partial<Record<AccountView['harnessId'], DeviceLogin>>>({});
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const checked = useRef(false);
  const check = useCallback(async (harnessId: AccountView['harnessId'], maxAgeMs?: number) => {
    try { replace(await privateRequest(`/accounts/${harnessId}/check`, accountViewSchema, { csrf, body: maxAgeMs === undefined ? {} : { maxAgeMs }, timeoutMs: 30_000 })); }
    catch { /* the card keeps its last verified state */ }
  }, [csrf, replace]);
  // Opening the page verifies anything not checked in the last minute.
  useEffect(() => { if (checked.current || !list) return; checked.current = true; for (const item of list) void check(item.harnessId, 60_000); }, [list, check]);
  // While a login waits, follow the server: completion clears it, failure shows why.
  const waiting = list?.some(item => item.login?.status === 'waiting');
  useEffect(() => { if (!waiting) return; const timer = setInterval(() => { void refresh(); }, 3000); return () => clearInterval(timer); }, [waiting, refresh]);
  useEffect(() => {
    if (!list) return;
    setLogins(current => {
      const next = { ...current };
      for (const item of list) {
        const local = current[item.harnessId];
        if (item.login?.status === 'failed') next[item.harnessId] = { status: 'failed', reason: item.login.reason };
        else if (!item.login && local?.status === 'waiting') delete next[item.harnessId];
      }
      return next;
    });
  }, [list]);

  const login = async (harnessId: AccountView['harnessId']) => {
    setBusy(true); setLogins(current => ({ ...current, [harnessId]: { status: 'starting' } }));
    try {
      const started = await privateRequest(`/accounts/${harnessId}/login`, deviceLoginResponseSchema, { csrf, body: {}, timeoutMs: 30_000 });
      replace(started.account);
      setLogins(current => ({ ...current, [harnessId]: { status: 'waiting', verificationUrl: started.verificationUrl, userCode: started.userCode } }));
    } catch (reason) {
      setLogins(current => ({ ...current, [harnessId]: { status: 'failed', reason: reason instanceof RequestError ? loginErrors[reason.code] ?? '登录没有开始，请稍后再试。' : '登录没有开始，请稍后再试。' } }));
    } finally { setBusy(false); }
  };
  const cancel = async (harnessId: AccountView['harnessId']) => {
    setLogins(current => { const next = { ...current }; delete next[harnessId]; return next; });
    try { replace(await privateRequest(`/accounts/${harnessId}/login/cancel`, accountViewSchema, { csrf, body: {} })); } catch { /* the server expires it anyway */ }
  };
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => { setCopied('已复制登录码'); setTimeout(() => setCopied(''), 2000); }, () => setCopied('复制失败，请手动输入')); };

  return <section className="settings-section" aria-labelledby="harness-accounts-title">
    <h2 id="harness-accounts-title">Harness 账号</h2>
    <p className="settings-lead">Codex 和 DSH 各用自己的厂商账号工作。中书定期向厂商核实，失效时提醒你。凭据一直留在各自的 Harness 里，中书不保存。</p>
    {!list ? <p className="settings-note" role="status">正在读取…</p>
      : !list.length ? <p className="settings-note">当前实例没有配置 Harness。</p>
      : <div className="account-list">{list.map(item => <HarnessAccountCard key={item.harnessId} account={toCard(item)} login={logins[item.harnessId]} busy={busy}
          onCheck={() => void check(item.harnessId)} onLogin={() => void login(item.harnessId)} onCancelLogin={() => void cancel(item.harnessId)} onCopy={copy}/>)}</div>}
    {copied && <p className="settings-note" role="status">{copied}</p>}
  </section>;
}

/** Above the conversation area while a Harness cannot start new work. */
export function AccountBanner({ accounts, onOpen }: { accounts?: AccountView[]; onOpen(): void }) {
  if (!accounts?.length) return null;
  return <div className="account-banner-slot"><AccountAttentionBanner accounts={accounts.map(toCard)} onOpen={onOpen}/></div>;
}

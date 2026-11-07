import { CircleAlert, Copy, ExternalLink, KeyRound, LoaderCircle, RefreshCw, Unplug } from 'lucide-react';
import { Button } from '../ui/controls.tsx';
import './harness-accounts.css';

/** What Zhongshu knows about one Harness account (ADR 0015). Local credentials alone never count as valid. */
export type AccountState = 'checking' | 'valid' | 'signed-out' | 'rejected' | 'unverified' | 'disconnected';
export type HarnessAccount = {
  harness: 'Codex' | 'DSH';
  state: AccountState;
  /** Display-safe identity, already masked by the caller. */
  identity?: string;
  plan?: string;
  usage?: { label: string; usedPercent: number; resetsAt?: number };
  checkedAt?: number;
  /** Codex can sign in from the page; DSH is handled by the operator. */
  canLogin: boolean;
};
export type DeviceLogin =
  | { status: 'starting' }
  | { status: 'waiting'; verificationUrl: string; userCode: string }
  | { status: 'failed'; reason: string };

const time = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const words: Record<AccountState, { badge: string; tone: 'ok' | 'warn' | 'danger' | 'muted' }> = {
  checking: { badge: '正在核实', tone: 'muted' },
  valid: { badge: '可用', tone: 'ok' },
  'signed-out': { badge: '未登录', tone: 'danger' },
  rejected: { badge: '登录已失效', tone: 'danger' },
  unverified: { badge: '暂时无法核实', tone: 'warn' },
  disconnected: { badge: '未连接', tone: 'warn' },
};
/** States that stop new work in that Harness; the attention banner and push use the same rule. */
export const needsAttention = (state: AccountState) => state === 'signed-out' || state === 'rejected' || state === 'disconnected';

function explanation(account: HarnessAccount): string | undefined {
  const operator = '这一步要由操作者在服务器上完成，中书无法代为登录。';
  switch (account.state) {
    case 'signed-out': return account.canLogin ? `${account.harness} 没有可用的登录：可能从未登录，或登录已过期、无法续期。用设备码登录，可以在任意设备的浏览器上完成。` : `${account.harness} 没有登录。${operator}`;
    case 'rejected': return account.canLogin ? '厂商拒绝了当前凭据，可能已过期或在别处退出。新对话会失败，请重新登录。' : `厂商拒绝了当前凭据，需要重新登录。${operator}`;
    case 'unverified': return '账号在，但这次没能向厂商核实（网络或服务问题）。稍后会自动再试，正在运行的对话不受影响。';
    case 'disconnected': return `中书连不上 ${account.harness} 的 Host。请检查服务器上的 Host 是否在运行。`;
    default: return undefined;
  }
}

/** One Harness account card. Presentation only: checking, signing in and cancelling belong to the caller. */
export function HarnessAccountCard({ account, login, busy, onCheck, onLogin, onCancelLogin, onCopy }: {
  account: HarnessAccount; login?: DeviceLogin; busy?: boolean;
  onCheck(): void; onLogin(): void; onCancelLogin(): void; onCopy(text: string): void;
}) {
  const word = words[account.state];
  const note = explanation(account);
  const tone = needsAttention(account.state) ? 'is-urgent' : account.state === 'unverified' ? 'is-warn' : '';
  return <article className="account-card" data-tone={word.tone} aria-labelledby={`account-${account.harness}`}>
    <header className="account-head">
      <strong id={`account-${account.harness}`}>{account.harness}</strong>
      <span className="account-badge" data-tone={word.tone}>{account.state === 'checking' && <LoaderCircle size={12} className="account-spin" aria-hidden="true"/>}{word.badge}</span>
    </header>
    {(account.identity || account.plan) && <p className="account-identity">{[account.identity, account.plan].filter(Boolean).join(' · ')}</p>}
    {account.usage && <div className="account-usage">
      <div className="account-usage-line"><span>{account.usage.label}已用 {account.usage.usedPercent}%</span>{account.usage.resetsAt && <span>{time.format(account.usage.resetsAt)} 重置</span>}</div>
      <div className="account-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={account.usage.usedPercent} aria-label={`${account.usage.label}用量`}>
        <i style={{ width: `${Math.min(100, Math.max(0, account.usage.usedPercent))}%` }} data-high={account.usage.usedPercent >= 90 || undefined}/></div>
    </div>}
    {note && <p className={`account-note ${tone}`}>{account.state === 'disconnected' ? <Unplug size={14} aria-hidden="true"/> : <CircleAlert size={14} aria-hidden="true"/>}<span>{note}</span></p>}
    {login && <LoginPanel login={login} busy={busy} onCancel={onCancelLogin} onRetry={onLogin} onCopy={onCopy}/>}
    <footer className="account-foot">
      <span className="account-checked">{account.checkedAt ? `最近核实 ${time.format(account.checkedAt)}` : '尚未核实'}</span>
      <div className="account-actions">
        {account.canLogin && !login && <Button size="small" variant={needsAttention(account.state) ? 'primary' : 'secondary'} disabled={busy || account.state === 'disconnected'} onClick={onLogin}><KeyRound size={14}/>{account.state === 'valid' || account.state === 'unverified' ? '重新登录' : '登录'}</Button>}
        <Button size="small" variant="quiet" disabled={busy || account.state === 'checking'} onClick={onCheck}><RefreshCw size={14}/>重新核实</Button>
      </div>
    </footer>
  </article>;
}

function LoginPanel({ login, busy, onCancel, onRetry, onCopy }: { login: DeviceLogin; busy?: boolean; onCancel(): void; onRetry(): void; onCopy(text: string): void }) {
  if (login.status === 'starting') return <div className="account-login" role="status"><LoaderCircle size={14} className="account-spin" aria-hidden="true"/>正在向 OpenAI 申请登录码…</div>;
  if (login.status === 'failed') return <div className="account-login is-failed" role="alert">
    <p>登录没有完成：{login.reason}</p>
    <div className="account-actions"><Button size="small" variant="primary" disabled={busy} onClick={onRetry}>再试一次</Button><Button size="small" variant="quiet" onClick={onCancel}>关闭</Button></div>
  </div>;
  const host = new URL(login.verificationUrl).host + new URL(login.verificationUrl).pathname;
  return <div className="account-login" aria-label="设备码登录">
    <ol>
      <li>在任意设备的浏览器打开 <a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">{host}<ExternalLink size={12} aria-hidden="true"/></a></li>
      <li>登录要给 Codex 使用的 ChatGPT 账号，输入这个代码：
        <span className="account-code"><code>{login.userCode}</code><Button size="small" variant="quiet" aria-label="复制登录码" onClick={() => onCopy(login.userCode)}><Copy size={13}/>复制</Button></span></li>
      <li>完成后这里会自动更新，不用刷新页面。</li>
    </ol>
    <div className="account-waiting" role="status"><LoaderCircle size={14} className="account-spin" aria-hidden="true"/><span>等待你完成登录…</span>
      <Button size="small" variant="quiet" disabled={busy} onClick={onCancel}>取消</Button></div>
  </div>;
}

/** Shown above the conversation area while a Harness cannot start new work. */
export function AccountAttentionBanner({ accounts, onOpen }: { accounts: HarnessAccount[]; onOpen(): void }) {
  const blocked = accounts.filter(account => needsAttention(account.state));
  if (!blocked.length) return null;
  const text = blocked.map(account => `${account.harness} ${words[account.state].badge}`).join('，');
  return <div className="account-banner" role="alert"><CircleAlert size={15} aria-hidden="true"/>
    <span>{text}，相关对话暂时无法运行。</span><Button size="small" variant="secondary" onClick={onOpen}>去处理</Button></div>;
}

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
  /** Vendor pages for usage and top-up. */
  links?: { usage?: string; topUp?: string };
  checkedAt?: number;
  /** Whether the page can start a login for this Harness. */
  canLogin: boolean;
};
export type DeviceLogin =
  | { status: 'starting' }
  /** Codex: enter the code on the vendor's page. */
  | { status: 'waiting'; verificationUrl: string; userCode: string }
  /** DSH: sign in on the vendor's page, then paste back the loopback address it redirects to. */
  | { status: 'paste'; authorizeUrl: string; callbackPrefix: string; completing?: boolean; error?: string }
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

const how = (account: HarnessAccount) => account.harness === 'Codex' ? '用设备码登录，可以在任意设备的浏览器上完成。' : '用 DeepSeek 账号登录：打开登录页，完成后把跳转地址粘贴回来。';
function explanation(account: HarnessAccount): string | undefined {
  const operator = '这一步要由操作者在服务器上完成，中书无法代为登录。';
  switch (account.state) {
    case 'signed-out': return account.canLogin ? `${account.harness} 没有可用的登录：可能从未登录，或登录已过期、无法续期。${how(account)}` : `${account.harness} 没有登录。${operator}`;
    case 'rejected': return account.canLogin ? `厂商拒绝了当前凭据，可能已过期或在别处退出。新对话会失败，请重新登录。${how(account)}` : `厂商拒绝了当前凭据，需要重新登录。${operator}`;
    case 'unverified': return '账号在，但这次没能向厂商核实（网络或服务问题）。稍后会自动再试，正在运行的对话不受影响。';
    case 'disconnected': return `中书连不上 ${account.harness} 的 Host。请检查服务器上的 Host 是否在运行。`;
    default: return undefined;
  }
}

/** One Harness account card. Presentation only: checking, signing in and cancelling belong to the caller. */
export function HarnessAccountCard({ account, login, busy, onCheck, onLogin, onCancelLogin, onCompleteLogin, onCopy }: {
  account: HarnessAccount; login?: DeviceLogin; busy?: boolean;
  onCheck(): void; onLogin(): void; onCancelLogin(): void; onCompleteLogin?(callbackUrl: string): void; onCopy(text: string): void;
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
    {(account.links?.usage || account.links?.topUp) && <p className="account-links">
      {account.links.usage && <a href={account.links.usage} target="_blank" rel="noopener noreferrer">查看用量<ExternalLink size={12} aria-hidden="true"/></a>}
      {account.links.topUp && <a href={account.links.topUp} target="_blank" rel="noopener noreferrer">去充值<ExternalLink size={12} aria-hidden="true"/></a>}</p>}
    {login && <LoginPanel login={login} busy={busy} onCancel={onCancelLogin} onRetry={onLogin} onComplete={onCompleteLogin} onCopy={onCopy}/>}
    <footer className="account-foot">
      <span className="account-checked">{account.checkedAt ? `最近核实 ${time.format(account.checkedAt)}` : '尚未核实'}</span>
      <div className="account-actions">
        {account.canLogin && !login && <Button size="small" variant={needsAttention(account.state) ? 'primary' : 'secondary'} disabled={busy || account.state === 'disconnected'} onClick={onLogin}><KeyRound size={14}/>{account.state === 'valid' || account.state === 'unverified' ? '重新登录' : '登录'}</Button>}
        <Button size="small" variant="quiet" disabled={busy || account.state === 'checking'} onClick={onCheck}><RefreshCw size={14}/>重新核实</Button>
      </div>
    </footer>
  </article>;
}

function LoginPanel({ login, busy, onCancel, onRetry, onComplete, onCopy }: { login: DeviceLogin; busy?: boolean; onCancel(): void; onRetry(): void; onComplete?(url: string): void; onCopy(text: string): void }) {
  if (login.status === 'starting') return <div className="account-login" role="status"><LoaderCircle size={14} className="account-spin" aria-hidden="true"/>正在发起登录…</div>;
  if (login.status === 'paste') return <PastePanel login={login} busy={busy} onCancel={onCancel} onComplete={url => onComplete?.(url)}/>;
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

function PastePanel({ login, busy, onCancel, onComplete }: { login: Extract<DeviceLogin, { status: 'paste' }>; busy?: boolean; onCancel(): void; onComplete(url: string): void }) {
  const authorize = new URL(login.authorizeUrl);
  return <form className="account-login" aria-label="粘贴回调登录" onSubmit={event => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('callback');
    if (typeof value === 'string' && value.trim()) onComplete(value.trim());
  }}>
    <ol>
      <li>打开 <a href={login.authorizeUrl} target="_blank" rel="noopener noreferrer">{authorize.host} 登录页<ExternalLink size={12} aria-hidden="true"/></a>，用 DeepSeek 账号登录（手机或电脑都可以）。</li>
      <li>登录后浏览器会跳到一个打不开的页面，地址以 <code className="account-inline">{login.callbackPrefix}</code> 开头。这是正常的，复制地址栏里的完整地址。</li>
      <li>粘贴到下面，点“完成登录”。地址里的一次性授权码只用于这一次登录，中书不保存。</li>
    </ol>
    <input className="account-paste" name="callback" type="url" inputMode="url" autoComplete="off" spellCheck={false} required
      placeholder={`${login.callbackPrefix}?code=…&state=…`} aria-label="跳转后的完整地址" disabled={login.completing}/>
    {login.error && <p className="account-paste-error" role="alert">{login.error}</p>}
    <div className="account-waiting">
      {login.completing ? <><LoaderCircle size={14} className="account-spin" aria-hidden="true"/><span>正在完成登录…</span></> : <span/>}
      <Button size="small" variant="primary" type="submit" disabled={busy || login.completing}>完成登录</Button>
      <Button size="small" variant="quiet" disabled={login.completing} onClick={onCancel}>取消</Button>
    </div>
  </form>;
}

/** Shown above the conversation area while a Harness cannot start new work. */
export function AccountAttentionBanner({ accounts, onOpen }: { accounts: HarnessAccount[]; onOpen(): void }) {
  const blocked = accounts.filter(account => needsAttention(account.state));
  if (!blocked.length) return null;
  const text = blocked.map(account => `${account.harness} ${words[account.state].badge}`).join('，');
  return <div className="account-banner" role="alert"><CircleAlert size={15} aria-hidden="true"/>
    <span>{text}，相关对话暂时无法运行。</span><Button size="small" variant="secondary" onClick={onOpen}>去处理</Button></div>;
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { sessionSchema, versionSchema, errorSchema, type SessionView } from '../shared/http.ts';
import './style.css';
import { UIProvider } from './ui/provider.tsx';
import { BrandMark, Button } from './ui/controls.tsx';
import { WorkbenchView } from './workbench.tsx';
import { clearDrafts } from './workbench-client.ts';
import { captureInstallOffer, registerWorker } from './push-client.ts';

type Version = { version: string; revision: string };
const failureText: Record<string, string> = {
  invalid_credentials: '密码不正确，请重试。',
  rate_limited: '尝试次数较多，请稍后再试。',
  busy: '服务正在处理登录，请稍后再试。',
  not_initialized: '管理员尚未完成初始化。',
};

function App() {
  const [session, setSession] = useState<SessionView>();
  const [version, setVersion] = useState<Version>();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const authEpoch = useRef(0);
  const authPending = useRef(false);
  const refreshController = useRef<AbortController | undefined>(undefined);
  const refresh = async () => {
    if (authPending.current) return;
    const epoch = ++authEpoch.current;
    refreshController.current?.abort();
    const controller = new AbortController(); refreshController.current = controller;
    try {
      const response = await fetch('/api/session', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
      if (!response.ok) throw new Error();
      const result = sessionSchema.parse(await response.json());
      if (epoch === authEpoch.current) { setSession(result); setError(''); }
    } catch { if (epoch === authEpoch.current && !controller.signal.aborted) setError('暂时无法连接。你的输入仍在，请重试。'); }
  };
  useEffect(() => {
    void refresh();
    void fetch('/api/version', { signal: AbortSignal.timeout(8000) }).then(async r => { if (r.ok) setVersion(versionSchema.parse(await r.json())); }).catch(() => {});
    const restore = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('pageshow', restore); document.addEventListener('visibilitychange', restore);
    return () => { refreshController.current?.abort(); window.removeEventListener('pageshow', restore); document.removeEventListener('visibilitychange', restore); };
  }, []);
  const login = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || !password) return;
    const epoch = ++authEpoch.current; authPending.current = true; refreshController.current?.abort();
    let reconcile = false;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(15_000) });
      const result: unknown = await response.json();
      if (epoch !== authEpoch.current) return;
      if (!response.ok) { setError(failureText[errorSchema.parse(result).error] ?? '登录未完成，请稍后重试。'); return; }
      setSession(sessionSchema.parse(result)); setPassword('');
    } catch { if (epoch === authEpoch.current) { setError('未能确认登录结果，请重试。'); reconcile = true; } }
    finally { authPending.current = false; setBusy(false); if (reconcile) void refresh(); }
  };
  const logout = async () => {
    if (authPending.current) return;
    const epoch = ++authEpoch.current; authPending.current = true; refreshController.current?.abort();
    setBusy(true);
    try {
      const response = await fetch('/api/private/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.authenticated ? session.csrfToken : '' }, body: '{}', signal: AbortSignal.timeout(8000) });
      if (!response.ok && response.status !== 401) throw new Error();
      if (epoch === authEpoch.current) { setSession({ authenticated: false, initialized: true }); clearDrafts(); setError(''); }
    } catch { if (epoch === authEpoch.current) setError('退出尚未确认，请重试。'); }
    finally { authPending.current = false; setBusy(false); }
  };
  const expired = useCallback(() => { ++authEpoch.current; setSession({ authenticated: false, initialized: true }); }, []);
  useEffect(() => { if (!session?.authenticated) document.title = '中书'; }, [session?.authenticated]);
  if (session?.authenticated) return <WorkbenchView csrf={session.csrfToken} logout={() => void logout()} expired={expired} busy={busy} authError={error} />;
  return <main className="entry">
    <section className="entry-card" aria-label="登录中书">
      <div className="entry-brand"><BrandMark size={22}/><span>中书</span></div>
      <h1>登录</h1>
      <p className="intro">个人 Agent 工作台。离开后回来，工作还在。</p>
      {!session ? <form onSubmit={event => { event.preventDefault(); void refresh(); }}><p role="status">正在连接服务…</p><Button type="submit">重新连接</Button></form> : <form onSubmit={event => void login(event)}>
        {session.initialized === false ? <p role="status">管理员尚未完成初始化。完成后即可登录。</p> : <>
          <div className="field"><label htmlFor="password">管理员密码</label>
            <input id="password" name="password" type="password" autoComplete="current-password" maxLength={1024} required value={password} onChange={e => setPassword(e.target.value)} aria-describedby={error ? 'entry-error' : undefined} autoFocus /></div>
          <Button variant="primary" type="submit" disabled={busy || !password}>{busy ? '正在登录…' : '进入工作台'}</Button>
        </>}
      </form>}
      {error && <p className="error" id="entry-error" role="alert">{error}</p>}
      <footer className="entry-footer">{version ? <><span className="connection">已连接</span><span>v{version.version} · {version.revision === 'development' ? '本地开发' : version.revision.slice(0, 8)}</span></> : <span>正在检查运行版本…</span>}</footer>
    </section>
  </main>;
}

// Push-only service worker and the browser's install offer (ADR 0018); both are harmless before login.
registerWorker();
captureInstallOffer();
createRoot(document.getElementById('root')!).render(<UIProvider><App /></UIProvider>);

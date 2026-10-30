import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { sessionSchema, versionSchema, errorSchema, identitySchema, type SessionView } from '../shared/http.ts';
import './style.css';

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
  const [identity, setIdentity] = useState<string>();
  const refresh = async () => {
    try {
      const response = await fetch('/api/session', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error();
      setSession(sessionSchema.parse(await response.json()));
      setError('');
    } catch { setError('暂时无法连接。你的输入仍在，请重试。'); }
  };
  useEffect(() => {
    void refresh();
    void fetch('/api/version', { signal: AbortSignal.timeout(8000) }).then(async r => { if (r.ok) setVersion(versionSchema.parse(await r.json())); }).catch(() => {});
    const restore = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('pageshow', restore); document.addEventListener('visibilitychange', restore);
    return () => { window.removeEventListener('pageshow', restore); document.removeEventListener('visibilitychange', restore); };
  }, []);
  useEffect(() => {
    if (!session?.authenticated) { setIdentity(undefined); return; }
    const controller = new AbortController();
    void fetch('/api/private/identity', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (response.status === 401) { setSession({ authenticated: false, initialized: true }); return; }
      if (!response.ok) throw new Error();
      const data = identitySchema.parse(await response.json());
      if (!controller.signal.aborted) setIdentity(data.name);
    }).catch(() => { if (!controller.signal.aborted) setError('身份暂时无法核实，请重新连接。'); });
    return () => controller.abort();
  }, [session?.authenticated]);
  const login = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || !password) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(15_000) });
      const result: unknown = await response.json();
      if (!response.ok) { setError(failureText[errorSchema.parse(result).error] ?? '登录未完成，请稍后重试。'); return; }
      setSession(sessionSchema.parse(result)); setPassword('');
    } catch { setError('未能确认登录结果，请重试。'); void refresh(); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/private/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.authenticated ? session.csrfToken : '' }, body: '{}', signal: AbortSignal.timeout(8000) });
      if (!response.ok && response.status !== 401) throw new Error();
      setSession({ authenticated: false, initialized: true }); setError('');
    } catch { setError('退出尚未确认，请重试。'); }
    finally { setBusy(false); }
  };
  return <main className="entry">
    <header className="brand"><img src="/icon.svg" width="36" height="36" alt="" /><span>中书 <small>ZHONGSHU</small></span></header>
    <p className="eyebrow">YOUR WORK, CONTINUED</p>
    <h1>{session?.authenticated ? '回到你的工作。' : '从这里，接着做。'}</h1>
    <p className="intro">让每一段思考，都有可以接续的地方。</p>
    <section className="entry-card" aria-label={session?.authenticated ? '私人入口' : '登录中书'}>
      {!session ? <><p role="status">正在连接服务…</p><button onClick={() => void refresh()}>重新连接</button></> : session.authenticated ? <>
        <div className="status"><span className="dot" />已登录私人工作台</div>
        <p>当前身份：{identity ?? '正在核实…'}</p><button className="secondary" onClick={() => void logout()} disabled={busy}>退出登录</button>
      </> : <form onSubmit={event => void login(event)}>
        <h2>登录中书</h2>
        {session.initialized === false ? <p>管理员尚未完成初始化。完成后即可登录。</p> : <>
          <label htmlFor="password">管理员密码</label>
          <input id="password" name="password" type="password" autoComplete="current-password" maxLength={1024} required value={password} onChange={e => setPassword(e.target.value)} aria-describedby={error ? 'entry-error' : undefined} autoFocus />
          <button className="primary" type="submit" disabled={busy || !password}>{busy ? '正在登录…' : '进入工作台'}<span aria-hidden="true">↗</span></button>
        </>}
      </form>}
      {error && <p className="error" id="entry-error" role="alert">{error}</p>}
    </section>
    <footer>{version ? <><span className="connection">前后端已连通</span><span>v{version.version} · {version.revision === 'development' ? '本地开发' : version.revision.slice(0, 8)}</span></> : '正在检查运行版本…'}</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);

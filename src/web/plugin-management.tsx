import { useEffect, useRef, useState } from 'react';
import { Puzzle, RefreshCw, X } from 'lucide-react';
import { Button, IconButton } from './ui/controls.tsx';
import { pluginOperation, pluginView, type PluginAction, type PluginCommand, type PluginEntry, type PluginHarness, type PluginView } from '../shared/plugins.ts';
import { RequestError, request } from './workbench-client.ts';
import './plugin-management.css';

const names = { codex: 'Codex', dsh: 'DSH' };
const actions = { install: '安装', enable: '启用', disable: '停用', remove: '卸载' };
const results = {
  applying: '正在处理…', unknown: '结果待核实', applied: '已核对原生结果',
  'restart-required': '等待原生 Host 重启', failed: '原生操作失败',
};
const application = { applied: '已生效', 'restart-required': '待重启', failed: '未能应用', unverified: '加载状态未核实' };

export function PluginManagement({ csrf, close, report }: { csrf: string; close(): void; report(reason: unknown): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [harness, setHarness] = useState<PluginHarness>('codex');
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return <dialog ref={dialog} className="plugin-manager" aria-labelledby="plugins-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="plugin-header">
      <div><h2 id="plugins-title">插件管理</h2><p>在中书实例中发现和管理原生插件。</p></div>
      <IconButton label="关闭插件管理" onClick={close}><X size={18}/></IconButton>
    </header>
    <nav className="plugin-tabs" aria-label="插件所属 Harness">
      {(['codex', 'dsh'] as const).map(id => <button type="button" key={id} aria-pressed={harness === id} onClick={() => setHarness(id)}>{names[id]}</button>)}
    </nav>
    <PluginCatalog key={harness} harness={harness} csrf={csrf} report={report}/>
  </dialog>;
}

function PluginCatalog({ harness, csrf, report }: { harness: PluginHarness; csrf: string; report(reason: unknown): void }) {
  const [view, setView] = useState<PluginView>();
  const [showInstalled, setShowInstalled] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string>();
  const [confirm, setConfirm] = useState<{ entry: PluginEntry; action: PluginAction }>();
  const [uncertain, setUncertain] = useState<PluginCommand>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const onReport = useRef(report);
  const operation = view?.operation;
  const path = '/plugins/' + harness;
  const settling = operation && ['applying', 'unknown', 'restart-required'].includes(operation.status);
  useEffect(() => { onReport.current = report; }, [report]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const current = await request(path, pluginView, { signal: controller.signal, timeoutMs: 45_000 });
        if (controller.signal.aborted) return;
        setView(current);
        setUncertain(value => value?.id === current.operation?.id ? undefined : value);
        if (current.operation?.status === 'applying') timer = setTimeout(() => void refresh(), 1800);
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof RequestError && reason.status === 401) onReport.current(reason);
        setView(undefined);
        setError('暂时无法读取插件状态，请刷新。');
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, revision]);

  async function update(command: PluginCommand | { id: string }, reconcile = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    setConfirm(undefined);
    try {
      await request(path + (reconcile ? '/reconcile' : '/operations'), pluginOperation, { csrf, body: command, timeoutMs: 45_000 });
      if (mounted.current) setUncertain(undefined);
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof RequestError && reason.status === 401) onReport.current(reason);
      if (reason instanceof RequestError && [400, 403, 409].includes(reason.status)) {
        setUncertain(undefined);
        setError(reason.status === 403 ? '这个来源或当前状态不允许执行此操作。' : '插件状态已变化，请核对最新结果。');
      } else {
        if (!reconcile && 'pluginId' in command) setUncertain(command);
        setError('暂时无法确认操作结果，请核对同一操作。');
      }
    } finally {
      if (mounted.current) { setBusy(false); setRevision(value => value + 1); }
    }
  }

  const needle = search.trim().toLocaleLowerCase();
  const entries = (view?.entries ?? []).filter(item => (!showInstalled || item.installed) &&
    [item.name, item.id, item.description, item.source].some(value => value.toLocaleLowerCase().includes(needle)));
  const active = entries.find(item => item.id === selected) ?? entries[0];
  const showApplication = active && (active.application !== 'unverified' || active.installed && active.enabled);
  return <section className="plugin-body" aria-label={names[harness] + ' 插件'}>
    <div className="plugin-scope"><strong>本实例共享 · {names[harness]}</strong><span>{harness === 'codex' ? 'Codex 原生环境' : 'DSH Web profile'}</span></div>
    <div className="plugin-toolbar">
      <nav className="plugin-tabs" aria-label="插件视图">
        <button type="button" aria-pressed={!showInstalled} onClick={() => setShowInstalled(false)}>发现</button>
        <button type="button" aria-pressed={showInstalled} onClick={() => setShowInstalled(true)}>已安装</button>
      </nav>
      <input aria-label={'搜索 ' + names[harness] + ' 插件'} placeholder="搜索名称或来源" type="search" value={search} maxLength={120} onChange={event => setSearch(event.target.value)}/>
      <IconButton label="刷新插件状态" onClick={() => { setError(''); setRevision(value => value + 1); }}><RefreshCw size={16}/></IconButton>
    </div>
    {error && <p className="plugin-message" role="alert">{error}</p>}
    {operation && <div className="plugin-message" role="status">
      <span>{actions[operation.action]} · {results[operation.status]}</span>
      {['unknown', 'restart-required'].includes(operation.status) &&
        <Button disabled={busy} onClick={() => void update({ id: operation.id }, true)}>核对原生结果</Button>}
    </div>}
    {uncertain && <div className="plugin-message"><Button disabled={busy} onClick={() => void update(uncertain)}>核对同一操作</Button></div>}
    {!view && !error && <p className="quiet" role="status">正在读取原生插件状态…</p>}
    {view?.availability === 'unconfigured' && <p className="quiet">此实例尚未配置 {names[harness]} 插件管理。</p>}
    {view?.availability === 'offline' && <p className="quiet">暂时无法读取 {names[harness]} 的原生插件状态。</p>}
    {view?.availability === 'available' && !entries.length && <p className="quiet">{needle ? '没有匹配的插件。' : showInstalled ? '此环境还没有已安装的插件。' : '此环境没有可发现的插件。'}</p>}
    {active && <div className="plugin-columns">
      <ul className="plugin-entries" aria-label="插件列表">{entries.map(entry => <li key={entry.id}>
        <button type="button" aria-pressed={active.id === entry.id} onClick={() => { setSelected(entry.id); setConfirm(undefined); }}>
          <Puzzle size={16}/><span><strong>{entry.name}</strong><small>{entry.source}</small></span>
          <small>{entry.installed ? entry.enabled ? '已启用' : '已停用' : '可发现'}</small>
        </button>
      </li>)}</ul>
      <section className="plugin-detail" aria-label="插件详情">
        <h3>{active.name}</h3>
        {active.description && <p>{active.description}</p>}
        <dl><div><dt>来源</dt><dd>{active.source}</dd></div><div><dt>目标</dt><dd>本实例 · {names[harness]}</dd></div>
          {active.version && <div><dt>版本</dt><dd>{active.version}</dd></div>}
          {showApplication && <div><dt>应用状态</dt><dd>{application[active.application]}</dd></div>}
        </dl>
        <div className="plugin-actions">{active.actions.map(action =>
          <Button key={action} disabled={busy || !!settling || !!uncertain} onClick={() => setConfirm({ entry: active, action })}>{actions[action]}</Button>)}</div>
        {confirm && confirm.entry.id === active.id && <div className="plugin-confirm" role="group" aria-label="确认插件操作">
          <p>{actions[confirm.action]}「{confirm.entry.name}」，范围为本实例的 {names[harness]}。</p>
          <div className="plugin-actions"><Button onClick={() => setConfirm(undefined)}>取消</Button><Button disabled={busy || !!settling}
            onClick={() => void update({ id: crypto.randomUUID(), action: confirm.action, pluginId: confirm.entry.id })}>确认{actions[confirm.action]}</Button></div>
        </div>}
      </section>
    </div>}
  </section>;
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, Boxes, Check, ChevronRight, ExternalLink, GitFork, Plus, Puzzle, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { Button, IconButton } from '../ui/controls.tsx';
import './plugin-library.css';

export const pluginActionName = { install: '安装', enable: '启用', disable: '停用', remove: '卸载' };
const nativeResult = {
  applying: '正在处理', unknown: '结果待核实', applied: '已核对原生结果',
  'restart-required': '等待原生 Host 重启', failed: '原生操作失败',
};
const application = { applied: '已生效', 'restart-required': '待重启', failed: '未能应用', unverified: '加载状态未核实' };
const harnessName = { codex: 'Codex', dsh: 'DSH' };
const date = (seconds: number) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeZone: 'UTC' }).format(seconds * 1000);

type PluginHarness = keyof typeof harnessName;
type PluginAction = keyof typeof pluginActionName;
type PluginEntry = {
  id: string; name: string; description: string; source: string; sourceId?: string; author?: string; homepage?: string;
  version: string | null; installed: boolean; enabled: boolean; system?: boolean;
  application: keyof typeof application;
  actions: PluginAction[];
  releases?: { version: string; installable: boolean; publishedAt?: number; repository?: string; commit?: string; directory?: string }[];
  skills?: { name: string; description: string }[];
};
type PluginView = {
  availability: 'available' | 'unconfigured' | 'offline';
  entries: PluginEntry[];
  sources?: { id: string; name: string; url: string; removable: boolean; unavailable?: boolean }[];
  operation: { pluginId: string; action: PluginAction; status: keyof typeof nativeResult } | null;
};
type PluginSourceCommand = { action: 'add'; source: string; ref?: string } | { action: 'remove'; id: string };

type Props = {
  harness: PluginHarness;
  onHarness(value: PluginHarness): void;
  view?: PluginView;
  error?: string;
  sourceError?: string;
  busy?: boolean;
  uncertain?: boolean;
  detail?: PluginEntry;
  onRefresh(): void;
  onDetail(id?: string): void;
  onSource(command: PluginSourceCommand): Promise<boolean>;
  onAction(entry: PluginEntry, action: PluginAction, version?: string): void;
  onReconcile(): void;
  onRetry(): void;
};

function SurfaceDialog({ title, children, close }: { title: string; children: ReactNode; close(): void }) {
  return <Dialog.Root open onOpenChange={open => { if (!open) close(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="pl-overlay"/>
      <Dialog.Content className="pl-dialog" aria-describedby={undefined}>
        <header><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><IconButton label="关闭"><X size={18}/></IconButton></Dialog.Close></header>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function Mark({ entry }: { entry: PluginEntry }) {
  const label = entry.name.trim().match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase();
  return <span className="pl-mark" aria-hidden="true">{entry.system || !label ? <Puzzle size={19}/> : label}</span>;
}

function EntryRow({ entry, open }: { entry: PluginEntry; open(): void }) {
  return <li><button className="pl-entry" onClick={open}>
    <Mark entry={entry}/>
    <span className="pl-entry-copy"><strong>{entry.name}</strong>
      {entry.description && <span>{entry.description}</span>}
      <small>{[entry.source, entry.version, entry.author].filter(Boolean).join(' · ')}</small>
    </span>
    {entry.installed && <span className={entry.enabled ? 'pl-status pl-status-active' : 'pl-status'}>
      {entry.enabled && <Check size={13}/>} {entry.enabled ? '已启用' : '已停用'}
    </span>}
    <ChevronRight className="pl-chevron" size={16} aria-hidden="true"/>
  </button></li>;
}

export function PluginLibrary({ harness, onHarness, view, error, sourceError, busy, uncertain, detail, onRefresh, onDetail, onSource, onAction, onReconcile, onRetry }: Props) {
  const [tab, setTab] = useState<'discover' | 'installed'>('discover');
  const [source, setSource] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>();
  const [layer, setLayer] = useState<'sources' | 'add'>();
  const [input, setInput] = useState('');
  const [ref, setRef] = useState('');
  const [confirm, setConfirm] = useState<{ entry: PluginEntry; action: PluginAction; version?: string }>();
  const [remove, setRemove] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  const rowOrigin = useRef<HTMLButtonElement | null>(null);
  const previous = useRef<string | undefined>(undefined);
  const sources = view?.sources ?? [];
  const operation = view?.operation;
  const waiting = operation && ['applying', 'unknown', 'restart-required'].includes(operation.status);
  const locked = !!(busy || waiting || uncertain);
  const active = selected ? (detail?.id === selected ? detail : view?.entries.find(entry => entry.id === selected)) : undefined;
  const needle = query.trim().toLocaleLowerCase();
  const entries = (view?.entries ?? []).filter(entry => (tab === 'installed' ? entry.installed : !entry.system && !!entry.sourceId) &&
    (tab === 'installed' || !source || entry.sourceId === source) &&
    [entry.name, entry.id, entry.description, entry.source].some(value => value.toLocaleLowerCase().includes(needle)));
  const userEntries = entries.filter(entry => !entry.system);
  const system = entries.filter(entry => entry.system);
  const pastedMarket = tab === 'discover' && /^https:\/\//i.test(query.trim());
  const chosenMarket = sources.find(item => item.id === source);
  const detailMarket = sources.find(item => item.id === active?.sourceId);
  const currentRelease = active?.releases?.find(release => release.version === active.version);
  useEffect(() => {
    if (selected) heading.current?.focus({ preventScroll: true });
    else if (previous.current) rowOrigin.current?.focus({ preventScroll: true });
    previous.current = selected;
  }, [selected]);
  useEffect(() => { if (source && view?.sources && !view.sources.some(item => item.id === source)) setSource(''); }, [source, view?.sources]);
  function chooseTab(value: typeof tab) { setTab(value); setSelected(undefined); onDetail(); }
  function add(value = '') { setInput(value); setRef(''); setLayer('add'); }
  function close() { setLayer(undefined); setRemove(undefined); }
  async function saveSource() {
    if (!input.trim()) return;
    if (await onSource({ action: 'add', source: input.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}) })) {
      setLayer(undefined); setTab('discover'); setSource(''); setQuery('');
    }
  }
  const showStatus = operation && (operation.status !== 'applied' || active?.id === operation.pluginId);
  return <section className="pl-scroll" aria-label="插件管理">
    <div className="pl-wrap">
      <header className="pl-hero">
        <div><h2>插件</h2><p className="pl-intro">浏览市场，为本实例的 Codex 与 DSH 安装和管理插件。</p></div>
        <Button variant="primary" disabled={view?.availability === 'unconfigured' || locked} onClick={() => add()}><Plus size={17}/>添加来源</Button>
      </header>
      <div className="pl-switches">
        <nav className="pl-segment" aria-label="插件运行环境">
          {(['codex', 'dsh'] as const).map(value => <button key={value} type="button" aria-pressed={harness === value} onClick={() => onHarness(value)}>{harnessName[value]}</button>)}
        </nav>
        <nav className="pl-tabs" aria-label="插件视图">
          <button aria-current={tab === 'discover' ? 'page' : undefined} onClick={() => chooseTab('discover')}>发现</button>
          <button aria-current={tab === 'installed' ? 'page' : undefined} onClick={() => chooseTab('installed')}>已安装</button>
        </nav>
      </div>
      {error && <p className="pl-notice" role="alert">{error}</p>}
      {showStatus && <div className="pl-notice" role="status"><span>{pluginActionName[operation.action]} · {nativeResult[operation.status]}</span>
        {['unknown', 'restart-required'].includes(operation.status) && <Button variant="quiet" disabled={busy} onClick={onReconcile}>核对原生结果</Button>}</div>}
      {uncertain && <div className="pl-notice"><Button variant="quiet" disabled={busy} onClick={onRetry}>核对同一操作</Button></div>}
      {active ? <>
        <Button variant="quiet" className="pl-back" onClick={() => { setSelected(undefined); onDetail(); }}><ArrowLeft size={16}/>返回{tab === 'discover' ? '发现' : '已安装'}</Button>
        <div className="pl-detail-head"><Mark entry={active}/><div><h2 ref={heading} tabIndex={-1}>{active.name}</h2><p>{active.id} {active.version && <span className="pl-version">{active.version}</span>}</p></div>
          <div className="pl-actions">{active.actions.filter(action => action !== 'install' || !active.installed).map(action => <Button key={action} disabled={locked} variant={action === 'install' || action === 'enable' ? 'primary' : 'secondary'}
            onClick={() => setConfirm({ entry: active, action })}>{pluginActionName[action]}</Button>)}</div></div>
        <p className="pl-detail-copy">{active.description}</p>
        {!!active.skills?.length && <section className="pl-detail-section"><h3>技能 <small>{active.skills.length}</small></h3>
          <ul className="pl-skill-list">{active.skills.map(skill => <li key={skill.name}><Boxes size={17}/><div><strong>{skill.name}</strong><p>{skill.description}</p></div></li>)}</ul></section>}
        <section className="pl-detail-section"><h3>来源与状态</h3><dl className="pl-facts">
          <div><dt>市场来源</dt><dd>{detailMarket ? <a href={detailMarket.url} target="_blank" rel="noreferrer">{active.source} <ExternalLink size={13}/></a> : active.source}</dd></div>
          <div><dt>安装范围</dt><dd>本实例 · {harnessName[harness]}</dd></div>
          {active.author && <div><dt>作者</dt><dd>{active.author}</dd></div>}
          {active.homepage && <div><dt>主页</dt><dd><a href={active.homepage} target="_blank" rel="noreferrer">打开插件主页 <ExternalLink size={13}/></a></dd></div>}
          {currentRelease?.repository && <div><dt>源代码</dt><dd><a href={currentRelease.repository} target="_blank" rel="noreferrer">查看仓库 <ExternalLink size={13}/></a></dd></div>}
          {currentRelease?.commit && <div><dt>发行提交</dt><dd><code>{currentRelease.commit}</code></dd></div>}
          {currentRelease?.directory && <div><dt>包目录</dt><dd><code>{currentRelease.directory}</code></dd></div>}
          {active.installed && <div><dt>安装状态</dt><dd>{active.enabled ? '已启用' : '已停用'}</dd></div>}
          {(active.application !== 'unverified' || active.installed && active.enabled) && <div><dt>加载状态</dt><dd>{application[active.application]}</dd></div>}
        </dl></section>
        {!!active.releases?.length && <section className="pl-detail-section"><h3>版本</h3>
          <ul className="pl-releases">{active.releases.map(release => <li key={release.version}>
            <div><strong>{release.version}</strong> {active.installed && release.version === active.version && <span className="pl-status pl-status-active">当前安装</span>}
              <p>{[release.publishedAt && date(release.publishedAt), release.commit?.slice(0, 12), release.directory].filter(Boolean).join(' · ')}</p>
              {release.repository && <a href={release.repository} target="_blank" rel="noreferrer"><GitFork size={13}/> 源代码 <ArrowUpRight size={12}/></a>}
            </div>{(!active.installed || release.version !== active.version) && release.installable && active.actions.includes('install') &&
              <Button disabled={locked} onClick={() => setConfirm({ entry: active, action: 'install', version: release.version })}>{active.installed ? '切换至' : '安装'} {release.version}</Button>}
          </li>)}</ul></section>}
      </> : <>
        <div className="pl-toolbar">
          {tab === 'discover' && <select aria-label="市场来源" value={source} onChange={event => setSource(event.target.value)}>
            <option value="">全部市场</option>{sources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>}
          <label className="pl-search"><Search size={17} aria-hidden="true"/><input type="search" aria-label="搜索插件" placeholder="搜索名称、描述或来源" value={query} maxLength={512} onChange={event => setQuery(event.target.value)}/></label>
          <IconButton label="刷新插件状态" onClick={onRefresh}><RefreshCw size={16}/></IconButton>
          <Button variant="quiet" className="pl-manage" aria-label="管理来源" disabled={view?.availability === 'unconfigured'} onClick={() => setLayer('sources')}><SlidersHorizontal size={17}/><span>管理来源</span></Button>
        </div>
        {chosenMarket && <p className="pl-source-hint">{chosenMarket.url}</p>}
        {userEntries.length ? <ul className="pl-list" aria-label="插件列表">{userEntries.map(entry => <EntryRow key={entry.id} entry={entry} open={() => {
          rowOrigin.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
          setSelected(entry.id); onDetail(entry.id);
        }}/>)}</ul> : <div className="pl-empty">
          <Puzzle size={25} aria-hidden="true"/>
          <h2>{!view ? '正在读取插件' : view.availability === 'offline' || chosenMarket?.unavailable ? '暂时无法读取市场' : view.availability === 'unconfigured' ? '此环境尚未接通' :
            pastedMarket ? '这是市场链接' : needle ? '没有匹配的插件' : tab === 'installed' ? '还没有安装插件' : sources.length ? '当前市场没有可展示的插件' : '添加一个市场来源'}</h2>
          {view?.availability === 'available' && pastedMarket && <Button disabled={locked} onClick={() => add(query.trim())}>添加这个来源</Button>}
          {view?.availability === 'available' && tab === 'discover' && !pastedMarket && !sources.length && <Button onClick={() => add()}><Plus size={15}/>添加来源</Button>}
          {view?.availability === 'available' && tab === 'installed' && !needle && <Button onClick={() => chooseTab('discover')}>浏览市场</Button>}
        </div>}
        {!!system.length && <details className="pl-system"><summary>原生内置组件 <span>{system.length}</span></summary>
          <ul className="pl-list">{system.map(entry => <EntryRow key={entry.id} entry={entry} open={() => { setSelected(entry.id); onDetail(entry.id); }}/>)}</ul></details>}
      </>}
    </div>
    {layer === 'add' && <SurfaceDialog title={harness === 'dsh' ? '添加 DSH 索引源' : '添加 Codex 插件市场'} close={close}>
      <form onSubmit={event => { event.preventDefault(); void saveSource(); }}>
        <p>{harness === 'dsh' ? '粘贴公开 GitHub 市场的 index.json 原始链接。' : '输入公开 GitHub 市场仓库。中书会保存这次选定的提交。'}</p>
        <label>{harness === 'dsh' ? '索引 URL' : 'GitHub 仓库'}<input value={input} onChange={event => setInput(event.target.value)}
          maxLength={512} placeholder={harness === 'dsh' ? 'https://raw.githubusercontent.com/作者/仓库/main/dsh/index.json' : '作者/市场仓库'} required/></label>
        {harness === 'codex' && <label>Git 引用 <small>可选</small><input value={ref} onChange={event => setRef(event.target.value)} maxLength={128} placeholder="默认分支、标签或提交"/></label>}
        {sourceError && <p role="alert">{sourceError}</p>}
        <footer><Button onClick={close}>取消</Button><Button type="submit" variant="primary" disabled={!input.trim() || busy}>{busy ? '正在添加…' : '添加来源'}</Button></footer>
      </form>
    </SurfaceDialog>}
    {layer === 'sources' && <SurfaceDialog title={'管理 ' + harnessName[harness] + ' 来源'} close={close}>
      <p>这些市场为本实例提供插件目录。</p>
      <ul className="pl-source-list">{sources.map(item => <li key={item.id}>
        <div><strong>{item.name}</strong><p>{item.url}</p>{item.unavailable && <small>暂时不可用</small>}</div>
        {item.removable ? <Button variant="quiet" disabled={locked} onClick={() => setRemove(item.id)}>移除</Button> : <small>实例预设</small>}
      </li>)}</ul>
      {remove && <div className="pl-notice"><span>移除这个市场来源？</span><Button disabled={busy} onClick={() => setRemove(undefined)}>取消</Button>
        <Button variant="primary" disabled={busy} onClick={() => void onSource({ action: 'remove', id: remove }).then(ok => { if (ok) setRemove(undefined); })}>确认移除</Button></div>}
      {sourceError && <p role="alert">{sourceError}</p>}
      <footer><Button variant="primary" disabled={locked} onClick={() => add()}><Plus size={16}/>添加来源</Button></footer>
    </SurfaceDialog>}
    {confirm && <SurfaceDialog title={(confirm.action === 'install' && confirm.entry.installed ? '切换版本' : pluginActionName[confirm.action]) + ' ' + confirm.entry.name} close={() => setConfirm(undefined)}>
      <p>{confirm.entry.source} · 本实例 · {harnessName[harness]}{confirm.version ? ' · ' + confirm.version : ''}</p>
      <footer><Button onClick={() => setConfirm(undefined)}>取消</Button><Button variant="primary" disabled={locked}
        onClick={() => { onAction(confirm.entry, confirm.action, confirm.version); setConfirm(undefined); }}>确认{confirm.action === 'install' && confirm.entry.installed ? '切换' : pluginActionName[confirm.action]}</Button></footer>
    </SurfaceDialog>}
  </section>;
}

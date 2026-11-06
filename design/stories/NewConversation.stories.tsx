import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Folder, Plus, PenSquare, Check } from 'lucide-react';
import { BrandMark, Button, IconButton, Information } from '../../src/web/ui/controls.tsx';
import { WorkbenchFrame } from '../../src/web/patterns/workbench-frame.tsx';
import { ComposerView } from '../../src/web/patterns/composer.tsx';
import { DraftConfiguration, type DraftConfigurationCatalog } from '../../src/web/patterns/draft-configuration.tsx';
import './new-conversation.css';

// Design-only, synthetic fixtures. No API, credentials, uploads or persistence.
const workspaces = ['研究笔记', '产品工作台'];
const catalogs = {
  Codex: ['GPT-6.1-Sol', 'GPT-6-Astra'],
  DSH: ['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro'],
};
type Agent = keyof typeof catalogs;
const levels: Record<Agent, string[]> = { Codex: ['Low', 'Medium', 'High', 'XHigh', 'Max', 'Ultra'], DSH: ['Off', 'Low', 'High', 'Max'] };
const configurationCatalogs: DraftConfigurationCatalog[] = (['Codex','DSH'] as Agent[]).map(agent => ({
  id: agent === 'Codex' ? 'codex' : 'dsh', available: true,
  ...(agent === 'Codex' ? { defaultModelId: catalogs.Codex[0] } : {}),
  models: catalogs[agent].map(label => ({ id: label, label, reasoningEfforts: levels[agent].map(level => ({id:level,label:level})), ...(agent === 'Codex' ? {defaultReasoningEffort:label.includes('Astra')?'Medium':'Low'} : {}) })),
  permissions: ['只读', '工作区读写', '完全访问'].map(label => ({id:label,label,description:'示例权限，未连接真实服务'})),
}));
type Saved = { id: number; workspace: string; text: string; agent: Agent; model: string; effort: string; permission: string };
function NewConversation({ firstUse = false }: { firstUse?: boolean }) {
  const [navigation, setNavigation] = useState(false);
  const [workspace, setWorkspace] = useState(firstUse ? '' : workspaces[0]!);
  const [agent, setAgent] = useState<Agent>('Codex');
  const initial = { Codex: {model: catalogs.Codex[0]!, effort:'Low', permission:'只读', automatic:true}, DSH: {model:catalogs.DSH[0]!, effort:'', permission:'只读', automatic:true} };
  const [powerSettings, setPowerSettings] = useState(initial);
  const {model,effort,permission,automatic} = powerSettings[agent];
  const update = (patch: Partial<typeof initial.Codex>) => setPowerSettings(old=>({...old,[agent]:{...old[agent],...patch}}));
  const [text, setText] = useState('');
  const [saved, setSaved] = useState<Saved[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState(firstUse ? '先选择工作区，再开始。' : '已沿用最近使用的工作区与配置，可在发送前调整。');
  const current = saved.find(s => s.id === active);
  function start(ws?: string) {
    setActive(null); setText(draft); setNavigation(false);
    if (ws) setWorkspace(ws);
    setNote(ws ? '首条消息发送前，可以调整下方配置。' : '沿用当前工作区与配置；需要时可直接修改。');
  }
  function send() {
    if (!text.trim() || !workspace || current) return;
    const item = { id: saved.length + 1, workspace, text, agent, model, effort, permission };
    setSaved([...saved, item]); setActive(item.id); setText(''); setDraft('');
  }
  const choose = (items: string[], selected: string, update: (v: string) => void) => <div className="nc-choices">{items.map(item => <button type="button" key={item} aria-pressed={selected === item} onClick={() => update(item)}>{item}{selected === item && <Check size={14}/>}</button>)}</div>;
  const settings = <DraftConfiguration catalogs={configurationCatalogs} harnessId={agent === 'Codex' ? 'codex' : 'dsh'} configuration={{modelId:model,permissionId:permission,reasoningEffort:effort || undefined}}
    onPowerChange={id => setAgent(id === 'codex' ? 'Codex' : 'DSH')}
    onConfigurationChange={value => update({model:value.modelId,permission:value.permissionId,effort:value.reasoningEffort ?? '',automatic:false})}/>;
  return <div className="nc-prototype"><div className="nc-banner"><span>设计预览 · 不连接真实 Agent</span><span>点新对话 → 写消息与调整配置 → 首次发送后入历史</span></div>
    <WorkbenchFrame navigationOpen={navigation} onNavigationChange={setNavigation}
      sidebar={<><div className="workbench-brand"><BrandMark/><span>中书</span></div><Button onClick={() => start()}><PenSquare size={16}/>新对话</Button><div className="nc-workspaces">{workspaces.map(ws => <section key={ws}><div className="nc-workspace-row"><Folder size={16}/><strong>{ws}</strong><IconButton label={`在${ws}新建对话`} onClick={() => start(ws)}><Plus size={16}/></IconButton></div>{saved.filter(s => s.workspace === ws).map(s => <button key={s.id} className="nc-history" aria-current={active === s.id ? 'page' : undefined} onClick={() => { if (!current) setDraft(text); setActive(s.id); setText(''); setNavigation(false); }}>{s.text.slice(0, 26)}<small>{s.agent} · {s.effort}</small></button>)}{!saved.some(s => s.workspace === ws) && <p className="nc-empty-history">发送第一条消息后显示在这里</p>}</section>)}</div><p className="nc-sidebar-note">模拟历史 {saved.length} 条 · 未发送的草稿不计入</p></>}
      header={<><div className="conversation-heading"><h1>{current ? current.text.slice(0, 24) : '新对话'}</h1><p>{current ? `${current.workspace} · ${current.agent} · ${current.model} · ${current.effort}` : workspace || '尚未选择工作区'}</p></div><span className="nc-state">{current ? '已创建 · 模拟' : '草稿'}</span></>}>
      <div className={`nc-main ${current ? 'nc-created' : ''}`}>
        {current ? <div className="nc-transcript"><div className="nc-user">{current.text}</div><h2>对话已创建</h2><p>这里将呈现 Agent 的回复。当前是交互模拟，没有发送真实请求。</p><p className="nc-muted">{current.model} · {current.effort} · {current.permission}<br/>配置在首次发送时固定。点击侧栏「新对话」可继续体验。</p></div> : <div className="nc-intro"><span className="nc-kicker">A PLACE TO BEGIN</span><h2>从一个想法开始。</h2><p>选择工作现场，然后开始。</p></div>}
        <div className="nc-compose">

          {!current && <div className="nc-context"><Folder size={15}/><Information label="选择工作区" summary={workspace || '选择工作区'}>{choose(workspaces, workspace, setWorkspace)}</Information><span>{workspace ? '此对话的工作现场' : '选择后即可发送'}</span></div>}
          <ComposerView value={text} onChange={value => {setText(value); setDraft(value);}} onSend={send} onStop={() => {}} onImages={() => {}} onFiles={() => {}} editDisabled={!!current} imagesDisabled filesDisabled sendDisabled={!workspace || !text.trim() || !effort || !!current} sending={false} running={false} model={current?.model ?? model} permission={current?.permission ?? permission} configurationNote="原型：首次发送固定配置" hasMaterials={false} renderEditor={props => <textarea {...props} placeholder="你想从哪里开始？"/>} configurationControls={!current ? settings : undefined} footerDetails={current ? <span>{current.effort} · 配置已固定</span> : undefined}/>
          {!current && <p className="nc-hint" role="status">{note}</p>}
        </div>
      </div>
    </WorkbenchFrame>
  </div>;
}
export default { title: '设计探索/新对话与思考深度', component: NewConversation } satisfies Meta<typeof NewConversation>;
export const RecentWorkspace: StoryObj<typeof NewConversation> = {};
export const FirstUse: StoryObj<typeof NewConversation> = { args: { firstUse: true } };

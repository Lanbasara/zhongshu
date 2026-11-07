import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { FileText, Folder, X } from 'lucide-react';
import { skillLabelText, skillLimit, type SkillReference } from '../../src/shared/content.ts';
import { ComposerView } from '../../src/web/patterns/composer.tsx';
import { SkillEditor } from '../../src/web/patterns/composer-extras.tsx';
import { DraftConfiguration, type DraftConfigurationCatalog, type DraftConfigurationValue } from '../../src/web/patterns/draft-configuration.tsx';
import { Button } from '../../src/web/ui/controls.tsx';
import '../../src/web/new-conversation.css';
import { draftCatalogs, skillOptions, workspaces } from './fixtures.tsx';
import { phone, useReadout } from './catalog.tsx';

type Args = {
  workspace: '' | 'example-notes' | 'example-site'; noWorkspaces: boolean; harness: 'codex' | 'dsh';
  model: 'default' | 'example-fast' | 'example-deep' | 'example-plain' | 'unavailable' | 'none';
  effort: 'native-default' | 'unselected' | 'unavailable';
  permission: 'read-only' | 'workspace-write' | 'full' | 'unavailable' | 'none';
  availability: 'all' | 'codex-unavailable' | 'dsh-unavailable' | 'no-default' | 'no-catalogs';
  locked: boolean; preparation: 'ready' | 'loading' | 'failed' | 'unsupported'; submission: boolean; reference: boolean; error: string;
};

function catalogsFor(availability: Args['availability']): DraftConfigurationCatalog[] {
  if (availability === 'no-catalogs') return [];
  return draftCatalogs.map(catalog => {
    if (availability === `${catalog.id}-unavailable`) return { ...catalog, available: false, reason: `示例：${catalog.id === 'codex' ? 'Codex' : 'DSH'} 暂未连接` };
    if (availability === 'no-default' && catalog.id === 'codex') { const { defaultModelId: _default, ...rest } = catalog; return rest; }
    return catalog;
  });
}
function configurationFor(catalog: DraftConfigurationCatalog | undefined, args: Pick<Args, 'model' | 'effort' | 'permission'>): DraftConfigurationValue {
  const modelId = args.model === 'default' ? catalog?.defaultModelId ?? catalog?.models[0]?.id ?? '' : args.model === 'unavailable' ? 'example-retired' : args.model === 'none' ? '' : args.model;
  const model = catalog?.models.find(item => item.id === modelId);
  const reasoningEffort = args.effort === 'unavailable' ? 'retired-effort' : args.effort === 'native-default' ? model?.defaultReasoningEffort : undefined;
  const permissionId = args.permission === 'unavailable' ? 'retired-permission' : args.permission === 'none' ? '' : args.permission;
  return { modelId, permissionId, ...(reasoningEffort ? { reasoningEffort } : {}) };
}
const loadSkills = () => Promise.resolve(skillOptions);

/** The first-message page as new-conversation.tsx lays it out: workspace chip, composer with draft configuration, status lines. */
function NewDraftDemo(args: Args) {
  const catalogs = catalogsFor(args.availability);
  const [workspace, setWorkspace] = useState<string>(args.noWorkspaces ? '' : args.workspace);
  const [harness, setHarness] = useState(args.harness);
  const [configuration, setConfiguration] = useState(() => configurationFor(catalogs.find(item => item.id === args.harness), args));
  const [text, setText] = useState('');
  const [spans, setSpans] = useState<SkillReference[]>([]);
  const [reference, setReference] = useState(args.reference);
  const [readout, say] = useReadout();
  const catalog = catalogs.find(item => item.id === harness);
  const model = catalog?.models.find(item => item.id === configuration.modelId);
  const valid = !!workspace && !!catalog?.available && !!model && (!model.reasoningEfforts?.length || model.reasoningEfforts.some(item => item.id === configuration.reasoningEffort))
    && !!catalog.permissions.some(item => item.id === configuration.permissionId);
  const locked = args.locked || args.submission;
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
    <section className="new-draft-page"><div className="new-draft-content">
      <div className="new-draft-intro"><h2>要做点什么？</h2><p>选好工作区，写下要做的事。第一次发送时才会创建对话。</p></div>
      <div className="new-draft-workspace"><Folder size={15}/><label className="sr-only" htmlFor="example-draft-workspace">工作区</label>
        <select id="example-draft-workspace" value={workspace} disabled={locked} onChange={event => setWorkspace(event.target.value)}>
          <option value="">选择工作区</option>{!args.noWorkspaces && workspaces.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
      {args.noWorkspaces && <div className="state-notice"><p>先添加工作区，再开始对话。</p><Button onClick={() => say('添加工作区')}>添加工作区</Button></div>}
      <ComposerView value={text} onChange={value => { setText(value); setSpans([]); }}
        renderEditor={editor => <SkillEditor editor={{ ...editor, placeholder: '你想从哪里开始？' }} spans={spans}
          picker={workspace && catalog?.available && args.preparation === 'ready' && !locked ? { load: loadSkills, format: skillLabelText, limit: skillLimit } : undefined}
          onEdit={(value, next) => { setText(value); setSpans(next); }}/>}
        onSend={() => { say(`创建对话并发送：${text}`); setText(''); setSpans([]); }} onStop={() => {}}
        onImages={() => say('添加图片（未上传）')} onFiles={() => setReference(true)}
        editDisabled={locked} imagesDisabled={locked} filesDisabled={locked || !workspace}
        sendDisabled={!args.submission && (!valid || (!text.trim() && !reference))} sending={false} running={false}
        model={model?.label ?? '选择模型'} permission={catalog?.permissions.find(item => item.id === configuration.permissionId)?.label ?? '选择权限'} configurationNote="首次发送后配置固定。"
        configurationControls={<DraftConfiguration catalogs={catalogs} harnessId={harness} configuration={configuration} disabled={locked}
          onPowerChange={id => { setHarness(id); setConfiguration(configurationFor(catalogs.find(item => item.id === id), { model: 'default', effort: 'native-default', permission: 'read-only' })); }}
          onConfigurationChange={value => { setConfiguration(value); say(`配置：${value.modelId} · ${value.reasoningEffort ?? '无深度'} · ${value.permissionId}`); }}/>}
        hasMaterials={reference} error={args.error || undefined}
        materials={reference && <div className="reference-card"><FileText size={14}/><span>示例/周报/数据表.csv</span>
          <button type="button" aria-label="移除引用" disabled={locked} onClick={() => setReference(false)}><X size={14}/></button></div>}/>
      {args.preparation === 'unsupported' && <p className="new-draft-status">当前 Power 暂未提供首发技能目录。</p>}
      {!args.submission && args.preparation === 'loading' && <p className="new-draft-status" role="status">正在准备首发技能…</p>}
      {!args.submission && args.preparation === 'failed' && <div className="new-draft-status" role="status"><p>首发技能准备未完成，内容已保留。可重试核对同一准备。</p>
        <Button onClick={() => say('重试准备首发技能')}>重试准备首发技能</Button></div>}
      <p className="new-draft-status" role="status">{args.submission ? '上次创建或发送尚待核对，重试会使用同一编号。' : '首次发送时创建对话；配置在对话中保持不变。'}</p>
      {args.submission && <><Button onClick={() => say('重试核对首条消息')}>重试核对首条消息</Button><Button onClick={() => say('查看已创建的对话')}>查看已创建的对话</Button></>}
      {readout}
    </div></section>
  </div>;
}

const meta = {
  title: '模式/新对话',
  component: NewDraftDemo,
  args: {
    workspace: 'example-notes', noWorkspaces: false, harness: 'codex', model: 'default', effort: 'native-default', permission: 'workspace-write',
    availability: 'all', locked: false, preparation: 'ready', submission: false, reference: false, error: '',
  },
  argTypes: {
    workspace: { control: 'inline-radio', options: ['', 'example-notes', 'example-site'] },
    harness: { control: 'inline-radio', options: ['codex', 'dsh'] },
    model: { control: 'select', options: ['default', 'example-fast', 'example-deep', 'example-plain', 'unavailable', 'none'] },
    effort: { control: 'inline-radio', options: ['native-default', 'unselected', 'unavailable'] },
    permission: { control: 'select', options: ['read-only', 'workspace-write', 'full', 'unavailable', 'none'] },
    availability: { control: 'select', options: ['all', 'codex-unavailable', 'dsh-unavailable', 'no-default', 'no-catalogs'] },
    preparation: { control: 'inline-radio', options: ['ready', 'loading', 'failed', 'unsupported'] },
  },
  render: args => <NewDraftDemo key={JSON.stringify(args)} {...args}/>,
} satisfies Meta<typeof NewDraftDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Draft: Story = { name: '草稿页' };
export const NoWorkspaceChosen: Story = { name: '尚未选择工作区', args: { workspace: '' } };
export const NoWorkspaces: Story = { name: '还没有工作区', args: { noWorkspaces: true } };
export const EffortUnselected: Story = { name: '思考深度未选择', args: { effort: 'unselected' } };
export const NoEffortLevels: Story = { name: '模型没有深度档位', args: { model: 'example-plain', effort: 'unselected' } };
export const ConfigurationGone: Story = { name: '原配置已不可用', args: { model: 'unavailable', permission: 'unavailable' } };
export const PowerUnavailable: Story = { name: 'Power 不可用', args: { availability: 'codex-unavailable' } };
export const NoReliableDefault: Story = { name: '原生没有可靠默认', args: { availability: 'no-default', model: 'example-deep' } };
export const NoCatalogs: Story = { name: '没有可用 Power', args: { availability: 'no-catalogs' } };
export const SkillsPreparing: Story = { name: '首发技能准备中', args: { preparation: 'loading' } };
export const SkillsFailed: Story = { name: '首发技能准备失败', args: { preparation: 'failed' } };
export const SubmissionPending: Story = { name: '首条消息待核对（锁定）', args: { submission: true, reference: true } };
export const Phone: Story = { name: '手机', globals: phone };

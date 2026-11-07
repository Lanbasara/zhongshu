import { useMemo, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { FileText, ImagePlus, LoaderCircle, Quote, RotateCcw, X } from 'lucide-react';
import type { QueueCommand, QueueView } from '../../src/shared/workbench.ts';
import { skillLabelText, skillLimit, type SkillReference } from '../../src/shared/content.ts';
import { ComposerView } from '../../src/web/patterns/composer.tsx';
import { ComposerUsage, SkillEditor } from '../../src/web/patterns/composer-extras.tsx';
import { InputQueue } from '../../src/web/input-queue.tsx';
import { queueEntries, skillOptions } from './fixtures.tsx';
import { Page, Section, Stage, phone, useReadout } from './catalog.tsx';

type State = 'idle' | 'running' | 'queueing' | 'sending' | 'pending';
type Materials = 'none' | 'file' | 'quote' | 'image' | 'uploading' | 'upload-failed' | 'all';
type Usage = 'none' | 'low' | 'warm' | 'high' | 'full' | 'total-only' | 'context-only';
type Skills = 'ready' | 'loading' | 'unavailable' | 'limit' | 'off';
type Queue = 'none' | 'single' | 'multiple' | 'dispatching' | 'accepted' | 'unknown' | 'paused' | 'failed' | 'restored' | 'next-turn-skill' | 'skill-unavailable';
type Args = {
  state: State; text: string; error: string; materials: Materials; usage: Usage; skills: Skills; queue: Queue;
  model: string; reasoningEffort: string; permission: string; configurationNote: string; imagesDisabled: boolean; filesDisabled: boolean;
};

const thumbnail = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#c8ccf1"/><path d="M0 24 10 14l8 8 5-5 9 9v6H0z" fill="#5e6ad2"/><circle cx="23" cy="9" r="4" fill="#fff"/></svg>')}`;
function MaterialsView({ kind, onRemove }: { kind: Materials; onRemove(text: string): void }) {
  const show = (item: Materials) => kind === item || kind === 'all';
  const remove = (text: string) => <button type="button" aria-label={`移除${text}`} onClick={() => onRemove(text)}><X size={14}/></button>;
  return <>
    {(show('image') || show('uploading') || show('upload-failed')) && <div className="attachment-tray">
      {show('image') && <div className="attachment-card"><img src={thumbnail} alt="示例截图.png"/><span>示例截图.png<small>已准备好</small></span>{remove('图片：示例截图.png')}</div>}
      {show('uploading') && <div className="attachment-card upload-card"><ImagePlus size={22}/><span>示例照片.jpg<small>正在上传…</small></span><LoaderCircle size={16} className="spin"/></div>}
      {show('upload-failed') && <div className="attachment-card upload-card"><ImagePlus size={22}/><span>示例图表.webp<small>上传失败 · 已保留</small></span>
        <button type="button" aria-label="重试上传：示例图表.webp" onClick={() => onRemove('重试上传')}><RotateCcw size={14}/></button>{remove('待上传图片：示例图表.webp')}</div>}
    </div>}
    {(show('file') || show('quote')) && <div className="composer-references">
      {show('file') && <div className="reference-card"><FileText size={15}/><span>示例/周报/数据表.csv<small>工作区原文件</small></span>{remove('引用')}</div>}
      {show('quote') && <div className="reference-card"><Quote size={15}/><span>转化率缺失的一行按前后两周的平均值补齐。<small>消息选段</small></span>{remove('引用')}</div>}
    </div>}
  </>;
}

const usages: Record<Exclude<Usage, 'none'>, Parameters<typeof ComposerUsage>[0]['usage']> = {
  low: { total: 12_480, context: { used: 18_200, capacity: 200_000, estimated: false } },
  warm: { total: 486_000, context: { used: 151_000, capacity: 200_000, estimated: true } },
  high: { total: 1_920_000, context: { used: 188_400, capacity: 200_000, estimated: true } },
  full: { total: 2_400_000, context: { used: 200_000, capacity: 200_000, estimated: false } },
  'total-only': { total: 1_234_567 },
  'context-only': { context: { used: 64_000, capacity: 200_000, estimated: true } },
};

const firstSkill = skillOptions[0]!;
function queueView(kind: Queue): QueueView | undefined {
  const one = queueEntries[0]!;
  switch (kind) {
    case 'none': return undefined;
    case 'single': return { entries: [one], mode: 'soon', pause: null, version: 0 };
    case 'multiple': return { entries: queueEntries, mode: 'current', pause: null, version: 0 };
    case 'dispatching': case 'accepted': case 'unknown': return { entries: [{ ...one, status: kind }, ...queueEntries.slice(1)], mode: 'soon', pause: null, version: 1 };
    case 'paused': return { entries: [{ ...one, status: 'held' }], mode: 'current', pause: 'missed', version: 1 };
    case 'failed': return { entries: queueEntries.slice(0, 2), mode: 'soon', pause: 'failed', version: 1 };
    case 'restored': return { entries: [one], mode: 'soon', pause: 'restored', version: 1 };
    case 'next-turn-skill': {
      const text = `${skillLabelText(firstSkill.label)} 汇总本周变化`;
      return { entries: [{ ...one, content: { text, skills: [{ id: firstSkill.id, label: firstSkill.label, start: 0, end: skillLabelText(firstSkill.label).length }] } }], mode: 'current', pause: null, version: 1 };
    }
    case 'skill-unavailable': return { entries: [{ ...one, skillUnavailable: true }], mode: 'soon', pause: null, version: 1 };
  }
}

function initialSpans(skills: Skills, text: string): SkillReference[] {
  const label = skillLabelText(firstSkill.label);
  return skills === 'limit' && text.startsWith(label) ? [{ id: firstSkill.id, label: firstSkill.label, start: 0, end: label.length }] : [];
}

/** ComposerView with the same materials, skill editor, usage and queue the product composer passes in; all state is local. */
function ComposerDemo(args: Args) {
  const { state: initialState, error, materials: initialMaterials, usage, skills, queue: queueKind, model, reasoningEffort, permission, configurationNote } = args;
  const [state, setState] = useState(initialState);
  const [text, setText] = useState(args.skills === 'limit' && !args.text ? `${skillLabelText(firstSkill.label)} ` : args.text);
  const [spans, setSpans] = useState(() => initialSpans(skills, text));
  const [materials, setMaterials] = useState(initialMaterials);
  const [queue, setQueue] = useState(() => queueView(queueKind));
  const [readout, say] = useReadout();
  const added = useRef(0);
  const picker = useMemo(() => skills === 'off' ? undefined : {
    format: skillLabelText, limit: skills === 'limit' ? 1 : skillLimit,
    load: (signal: AbortSignal) => skills === 'unavailable' ? Promise.reject(new Error('示例：技能目录不可用'))
      : skills === 'loading' ? new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
      : Promise.resolve(skillOptions),
  }, [skills]);
  const running = state === 'running' || state === 'queueing';
  const pending = state === 'pending';
  const hasMaterials = materials !== 'none';
  async function command(action: QueueCommand) {
    say(`队列操作：${action.action}`);
    setQueue(current => {
      if (!current) return current;
      if (action.action === 'resume') return { ...current, pause: null, entries: current.entries.map(entry => ({ ...entry, status: 'waiting' as const })) };
      if (action.action === 'edit') return { ...current, entries: current.entries.map(entry => entry.entryId === action.entryId ? { ...entry, content: action.content, version: entry.version + 1 } : entry) };
      if (action.action === 'remove' || action.action === 'send') { const entries = current.entries.filter(entry => entry.entryId !== action.entryId); return entries.length ? { ...current, entries } : undefined; }
      return current;
    });
    return true;
  }
  function send() {
    say(`${state === 'queueing' ? '加入队列' : '发送'}：${text.trim() || '（仅材料）'}`);
    const entryId = `30000000-0000-4000-8000-${String(++added.current).padStart(12, '0')}`;
    if (state === 'queueing') setQueue(current => ({ entries: [...(current?.entries ?? []), { entryId, version: 0, status: 'waiting', content: { text } }], mode: current?.mode ?? 'soon', pause: null, version: (current?.version ?? 0) + 1 }));
    else setState('running');
    setText(''); setSpans([]); setMaterials('none');
  }
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
    <div className="message-scroll"><div className="message-column">
      <p className="catalog-muted" style={{ lineHeight: 1.7 }}>输入 <kbd>/</kbd> 打开技能列表（↑↓ 切换，Tab 插入）；⌘/Ctrl + ↵ 发送；可以把图片拖进输入框。下方的用量可点开查看明细。这里的发送、停止、上传都只改变本页状态。</p>
      {readout}
    </div></div>
    <div className="composer-region">
      {pending && <div className="state-notice">上次发送尚未确认，原始输入已保留。<button className="text-button" onClick={() => say('核对同一发送')}>核对同一发送</button></div>}
      <ComposerView value={text} onChange={value => { setText(value); setSpans([]); }}
        renderEditor={editor => <SkillEditor editor={editor} spans={spans} picker={picker} onEdit={(value, next) => { setText(value); setSpans(next); }}/>}
        onSend={send} onStop={() => { setState('idle'); say('停止当前轮'); }}
        onImages={files => { setMaterials('image'); say(`添加 ${files.length} 张图片（未上传）`); }} onFiles={() => { setMaterials('file'); say('引用工作区文件'); }}
        editDisabled={pending} imagesDisabled={pending || state === 'sending' || args.imagesDisabled} filesDisabled={pending || args.filesDisabled}
        sendDisabled={pending || state === 'sending' || materials === 'uploading' || (!text.trim() && !hasMaterials)}
        sending={state === 'sending'} running={running} queueing={state === 'queueing'}
        model={model} reasoningEffort={reasoningEffort || undefined} permission={permission} configurationNote={configurationNote}
        error={error || undefined} hasMaterials={hasMaterials} materials={<MaterialsView kind={materials} onRemove={item => { setMaterials('none'); say(item); }}/>}
        queue={queue && <InputQueue queue={queue} target={running ? 'example-turn' : undefined} busy={false} canResume onCommand={command}/>}
        footerDetails={usage !== 'none' && <ComposerUsage usage={usages[usage]}/>}/>
    </div>
  </div>;
}

function UsageLevels() {
  return <Page title="对话用量" lead="累计 Token 与上下文占用。上下文用扇形表示；70% 起变为提醒色，90% 起变为危险色。“约”表示原生只给出估计值。点开查看明细。">
    {(Object.keys(usages) as (keyof typeof usages)[]).map(key => <Section key={key} title={key}>
      <Stage style={{ paddingTop: 140, justifyContent: 'flex-end' }}><div className="writing-footnote" style={{ flex: 1 }}><span/><ComposerUsage usage={usages[key]}/></div></Stage>
    </Section>)}
  </Page>;
}

const meta = {
  title: '模式/输入框',
  component: ComposerDemo,
  args: {
    state: 'idle', text: '', error: '', materials: 'none', usage: 'low', skills: 'ready', queue: 'none',
    model: '示例模型', reasoningEffort: '均衡', permission: '工作区读写', configurationNote: '配置在本对话中保持不变。',
    imagesDisabled: false, filesDisabled: false,
  },
  argTypes: {
    state: { control: 'inline-radio', options: ['idle', 'running', 'queueing', 'sending', 'pending'] },
    materials: { control: 'select', options: ['none', 'file', 'quote', 'image', 'uploading', 'upload-failed', 'all'] },
    usage: { control: 'select', options: ['none', 'low', 'warm', 'high', 'full', 'total-only', 'context-only'] },
    skills: { control: 'inline-radio', options: ['ready', 'loading', 'unavailable', 'limit', 'off'] },
    queue: { control: 'select', options: ['none', 'single', 'multiple', 'dispatching', 'accepted', 'unknown', 'paused', 'failed', 'restored', 'next-turn-skill', 'skill-unavailable'] },
  },
  render: args => <ComposerDemo key={JSON.stringify(args)} {...args}/>,
} satisfies Meta<typeof ComposerDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = { name: '输入框' };
export const Typed: Story = { name: '已输入', args: { text: '把示例周报的数据表整理一下，补齐缺失的转化率。\n再写一段不超过三百字的摘要。' } };
export const Running: Story = { name: '运行中', args: { state: 'running', text: '下一步：按月汇总。' } };
export const Queueing: Story = { name: '运行中 · 加入队列', args: { state: 'queueing', queue: 'single', text: '再补一张趋势图。' } };
export const Sending: Story = { name: '发送中', args: { state: 'sending', text: '正在发送的示例消息。' } };
export const Pending: Story = { name: '发送待核对（锁定）', args: { state: 'pending', text: '上次发送的原始内容。', materials: 'file' } };
export const SendDisabled: Story = { name: '不可发送（空）', args: { text: '' } };
export const WithMaterials: Story = { name: '带材料', args: { materials: 'all', text: '结合这些材料整理。' } };
export const UploadFailed: Story = { name: '上传失败', args: { materials: 'upload-failed', error: '图片上传失败，文件已保留；可以重试或移除。' } };
export const SkillsLoading: Story = { name: '技能 · 正在读取', args: { skills: 'loading', text: '/' } };
export const SkillsUnavailable: Story = { name: '技能 · 读取失败', args: { skills: 'unavailable', text: '/' } };
export const SkillsLimit: Story = { name: '技能 · 达到上限', args: { skills: 'limit' } };
export const LongModel: Story = { name: '模型名很长', args: { model: '一个名字非常长的示例模型（含版本与上下文长度说明）', permission: '配置待核实', configurationNote: '正在核实当前对话的原生配置，核实后可继续工作。' } };
export const QueueStates: Story = { name: '消息队列', args: { state: 'queueing', queue: 'multiple' } };
export const QueuePaused: Story = { name: '消息队列 · 已暂停', args: { state: 'running', queue: 'paused' } };
export const QueueUnknown: Story = { name: '消息队列 · 接收待核实', args: { state: 'queueing', queue: 'unknown' } };
export const QueueSkill: Story = { name: '消息队列 · 技能下一轮生效', args: { state: 'queueing', queue: 'next-turn-skill' } };
export const Usage: Story = { name: '对话用量 · 全部档位', render: () => <UsageLevels/>, parameters: { controls: { disable: true } } };
export const Phone: Story = { name: '手机', args: { materials: 'file', usage: 'warm', text: '在手机上输入的示例消息。' }, globals: phone };
export const PhoneRunning: Story = { name: '手机 · 运行中与队列', args: { state: 'queueing', queue: 'multiple' }, globals: phone };


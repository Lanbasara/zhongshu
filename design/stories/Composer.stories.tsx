import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ComposerView, type ComposerViewProps } from '../../src/web/patterns/composer.tsx';
import { Button } from '../../src/web/ui/controls.tsx';
import { InputQueue } from '../../src/web/input-queue.tsx';
import type { QueueCommand, QueueView } from '../../src/shared/workbench.ts';

function Example(args: Partial<ComposerViewProps>) {
  const [text, setText] = useState(args.value ?? '');
  const [running, setRunning] = useState(args.running ?? false);
  const [material, setMaterial] = useState(false);
  const [status, setStatus] = useState('这是隔离交互示例，不提交到 Agent。');
  return <div style={{ maxWidth: 800, margin: '48px auto', padding: 24 }}><ComposerView
    onChange={setText} editDisabled={false} imagesDisabled={false} filesDisabled={false} sendDisabled={!text.trim() && !material}
    sending={false} model="示例模型" permission="配置按对话固定" configurationNote="这里展示产品使用的同一个输入组件。"
    onImages={files => { setMaterial(!!files.length); setStatus('仅演示材料状态，不上传文件。'); }} onFiles={() => setMaterial(true)}
    onSend={() => { setRunning(true); setText(''); setStatus(args.queueing ? '演示消息已入队。' : '演示执行中，可以写下一条草稿或停止。'); }} onStop={() => { setRunning(false); setStatus('演示已停止，当前草稿保留。'); }}
    hasMaterials={material} materials={<div className="reference-card"><span>研究笔记.md<small>工作区原文件</small></span><Button onClick={() => setMaterial(false)}>移除</Button></div>}
    {...args} value={text} running={running}/><p role="status" style={{ color:'var(--zs-text-muted)', fontSize:12, marginTop:20 }}>{status}</p></div>;
}
const meta = { title:'产品模式/输入区', component:Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Interactive: Story = {};
export const Running: Story = { args: { running:true, value:'执行期间先写下一步，草稿保留。' } };
const entries: QueueView['entries'] = [
  { entryId: '75f1f98a-869c-4ebb-ab98-c14e76f01743', version: 0, status: 'waiting', content: { text: '本轮结束后补一组测试。' } },
  { entryId: '85f1f98a-869c-4ebb-ab98-c14e76f01743', version: 0, status: 'waiting', content: { text: '请再检查文档里提到的三个限制，确认每项限制都能在真实运行中复现。', references: [{ type: 'file', path: 'notes.md' }] } },
  { entryId: '95f1f98a-869c-4ebb-ab98-c14e76f01743', version: 0, status: 'waiting', content: { text: '最后汇总本次变更。' } },
];
function QueueExample({ initial }: { initial: QueueView }) {
  const [queue, setQueue] = useState(initial);
  async function command(action: QueueCommand) {
    setQueue(current => {
      if (action.action === 'resume') return { ...current, pause: null, entries: current.entries.map(entry => ({ ...entry, status: 'waiting' })) };
      if (action.action === 'edit') return { ...current, entries: current.entries.map(entry => entry.entryId === action.entryId ? { ...entry, content: action.content, version: entry.version + 1 } : entry) };
      if (action.action === 'remove' || action.action === 'send') return { ...current, entries: current.entries.filter(entry => entry.entryId !== action.entryId) };
      return current;
    });
    return true;
  }
  return <Example running={!queue.pause} queueing queue={<InputQueue queue={queue} target={queue.pause ? undefined : 'example-turn'} busy={false} canResume onCommand={command}/>}/>;
}
export const Queueing: Story = { render: () => <QueueExample initial={{ entries: entries.slice(0, 1), mode: 'soon', pause: null, version: 0 }}/> };
export const QueueMultiple: Story = { render: () => <QueueExample initial={{ entries, mode: 'current', pause: null, version: 0 }}/> };
export const QueuePaused: Story = { render: () => <QueueExample initial={{ entries: [{ ...entries[0]!, status: 'held' }], mode: 'current', pause: 'missed', version: 1 }}/> };
export const QueueUnknown: Story = { render: () => <QueueExample initial={{ entries: [{ ...entries[0]!, status: 'unknown' }], mode: 'soon', pause: null, version: 1 }}/> };
export const Pending: Story = { args: { value:'原始提交内容', editDisabled:true, imagesDisabled:true, filesDisabled:true, sendDisabled:true, configurationNote:'发送结果尚未确认。由功能层提供核对同一发送的操作。' } };
export const UploadFailure: Story = { args: { value:'请结合材料整理', error:'图片上传失败，文件已保留；可以重试或移除。', sendDisabled:true } };
export const LongModel: Story = { args: { model:'非常长的模型名称 · 固定配置与运行环境的说明', permission:'配置待核实', sendDisabled:true } };

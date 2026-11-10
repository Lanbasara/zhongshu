import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Play, Square } from 'lucide-react';
import { ProcessBlock, type ProcessRunState, type ProcessStep } from '../../src/web/patterns/process.tsx';
import { Button } from '../../src/web/ui/controls.tsx';
import { exampleProcess, longStep } from './fixtures.tsx';
import { phone } from './catalog.tsx';

type Kind = 'running' | 'completed' | 'mid-failure' | 'turn-failure' | 'interrupted' | 'unknown' | 'exit-code' | 'no-detail' | 'stopped';
type Args = { state: Kind; steps: number; long: boolean };
type Built = { steps: ProcessStep[]; runState?: ProcessRunState; stopped?: boolean };

/** The catalog's states, each built from steps plus the native turn state a real page would pass in. */
function buildSteps({ state, steps, long }: Args): Built {
  const base = Array.from({ length: steps }, (_, index): ProcessStep => {
    const source = exampleProcess[index % exampleProcess.length]!;
    return { ...source, id: `step-${index}`, name: index < exampleProcess.length ? source.name : `${source.name} ${index + 1}` };
  });
  const list = long ? [...base.slice(0, -1), { ...longStep, id: 'step-long' }, ...base.slice(-1)] : base;
  const completed = list.map((step): ProcessStep => ({ ...step, status: 'completed' }));
  const last = completed.length - 1;
  const middle = Math.max(0, Math.floor(last / 2));
  // A step whose run ended before it recorded a result keeps no preview output.
  const unfinished = (step: ProcessStep): ProcessStep => ({ id: step.id, name: step.name, status: 'running', ...(step.input ? { input: step.input } : {}) });
  switch (state) {
    case 'running':
      return { steps: completed.map((step, index) => index === last ? unfinished(step) : step), runState: 'running' };
    case 'completed':
      return { steps: completed, runState: 'completed' };
    case 'mid-failure':
      return { steps: completed.map((step, index) => index === middle ? { ...step, status: 'failed', output: '错误：示例/周报/摘要.md 不存在。' } : step), runState: 'completed' };
    case 'turn-failure':
      return { steps: completed.map((step, index) => index === last ? { ...step, status: 'failed', output: '错误：示例/周报/摘要.md 不存在。' } : step), runState: 'failed' };
    case 'interrupted':
      return { steps: completed.map((step, index) => index === last ? unfinished(step) : step), runState: 'interrupted' };
    case 'unknown':
      return { steps: completed.map((step, index) => index === middle ? { ...step, status: 'unknown', output: '原生没有返回这一步的结果。' } : step), runState: 'unknown' };
    case 'exit-code':
      return { steps: completed.map((step, index) => index === middle ? { ...step, status: 'failed', exitCode: 2, output: 'python3: 找不到示例脚本。' } : step), runState: 'completed' };
    case 'no-detail':
      return { steps: completed.map(step => ({ id: step.id, name: step.name, status: step.status })), runState: 'completed' };
    // Kept for catalogs that show an interrupted run without a native terminal state: an explicit stop is still a fact.
    case 'stopped':
      return { steps: completed.map((step, index) => index === last ? unfinished(step) : step), stopped: true };
  }
}

/** Arg changes keep the same instance, so the reader's open/closed choice is visible across state changes. */
function ProcessDemo(args: Args) {
  return <div className="catalog-column">
    <p className="catalog-muted" style={{ marginBottom: 8 }}>默认收起。开合只由读者点击决定：数据更新、运行结束、下一轮出现都不会自动展开或收起；步骤行也默认收起。运行中摘要显示转圈与当前步骤名；结束后只报事实——有未成功步骤时显示警示色「N 项未成功」，只有原生轮次终态失败才显示「本轮失败」，未知不显示为成功。系统开启“减少动态效果”时，转圈、流光与开合过渡都会停止。</p>
    <ProcessBlock {...buildSteps(args)}/>
  </div>;
}

const script: Omit<ProcessStep, 'status'>[] = [
  { id: 'live-1', name: '读取文件', input: 'cat 示例/周报/数据表.csv', output: '共 14 行。' },
  { id: 'live-2', name: '运行命令', input: 'python3 示例/脚本/补齐列.py', output: '已补齐 1 列。' },
  { id: 'live-3', name: '修改文件', input: '示例/周报/摘要.md', output: '写入 18 行。' },
  { id: 'live-4', name: '运行命令', input: 'python3 示例/脚本/检查.py', output: '检查通过。' },
];
function LiveDemo() {
  const [done, setDone] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'running' | 'completed' | 'interrupted'>('idle');
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearInterval(timer.current), []);
  function start() {
    window.clearInterval(timer.current); setDone(0); setPhase('running');
    timer.current = window.setInterval(() => setDone(value => {
      if (value + 1 >= script.length) { window.clearInterval(timer.current); setPhase('completed'); }
      return Math.min(script.length, value + 1);
    }), 1100);
  }
  function stop() { window.clearInterval(timer.current); setPhase('interrupted'); }
  const steps: ProcessStep[] = phase === 'idle' ? [] : script.slice(0, Math.min(script.length, done + (phase === 'running' || phase === 'interrupted' ? 1 : 0)))
    .map((step, index) => index < done ? { ...step, status: 'completed' }
      : { id: step.id, name: step.name, status: 'running', ...(step.input ? { input: step.input } : {}) });
  const runState: ProcessRunState | undefined = phase === 'running' ? 'running' : phase === 'completed' ? 'completed' : phase === 'interrupted' ? 'interrupted' : undefined;
  return <div className="catalog-column">
    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
      <Button variant="primary" onClick={start}><Play size={14}/>模拟一次执行</Button>
      <Button disabled={phase !== 'running'} onClick={stop}><Square size={12}/>停止</Button>
    </div>
    {steps.length ? <ProcessBlock steps={steps} runState={runState}/> : <p className="catalog-muted">点“模拟一次执行”。</p>}
  </div>;
}

const meta = {
  title: '模式/过程展示',
  component: ProcessDemo,
  args: { state: 'completed', steps: 3, long: false },
  argTypes: {
    state: { control: 'inline-radio', options: ['running', 'completed', 'mid-failure', 'turn-failure', 'interrupted', 'unknown', 'exit-code', 'no-detail', 'stopped'],
      description: '数据来源 + 原生轮次终态：running / completed / failed（整轮）/ interrupted / unknown，以及中途失败、非零退出码、无详情、无原生终态的旧停止状态' },
    steps: { control: { type: 'range', min: 1, max: 12, step: 1 } },
    long: { description: '插入一条输入输出都很长的步骤' },
  },
} satisfies Meta<typeof ProcessDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = { name: '运行中 · 默认收起', args: { state: 'running' } };
export const Completed: Story = { name: '已完成', args: { state: 'completed' } };
export const MidFailure: Story = { name: '中途失败 · 警示未成功', args: { state: 'mid-failure' } };
export const TurnFailure: Story = { name: '整轮失败 · 本轮失败', args: { state: 'turn-failure' } };
export const Interrupted: Story = { name: '已中断', args: { state: 'interrupted' } };
export const Unknown: Story = { name: '状态未明', args: { state: 'unknown' } };
export const ExitCode: Story = { name: '非零退出码', args: { state: 'exit-code' } };
export const NoDetail: Story = { name: '没有输入输出的步骤', args: { state: 'no-detail' } };
export const Stopped: Story = { name: '已停止 · 无原生终态', args: { state: 'stopped' } };
export const LongDetail: Story = { name: '很长的输入与输出', args: { state: 'completed', long: true, steps: 4 } };
export const Live: Story = { name: '模拟执行（开合只由你决定）', render: () => <LiveDemo/>, parameters: { controls: { disable: true } } };
export const Phone: Story = { name: '手机', args: { state: 'running', long: true, steps: 4 }, globals: phone };

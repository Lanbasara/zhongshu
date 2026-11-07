import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Play, Square } from 'lucide-react';
import { ProcessBlock, type ProcessStep } from '../../src/web/patterns/process.tsx';
import { Button } from '../../src/web/ui/controls.tsx';
import { exampleProcess, longStep } from './fixtures.tsx';
import { phone } from './catalog.tsx';

type Outcome = 'completed' | 'failed' | 'unknown' | 'exit-code' | 'no-detail';
type Args = { running: boolean; stopped: boolean; outcome: Outcome; steps: number; long: boolean };

function buildSteps({ running, stopped, outcome, steps, long }: Args): ProcessStep[] {
  const base = Array.from({ length: steps }, (_, index): ProcessStep => {
    const source = exampleProcess[index % exampleProcess.length]!;
    return { ...source, id: `step-${index}`, name: index < exampleProcess.length ? source.name : `${source.name} ${index + 1}` };
  });
  const list = long ? [...base.slice(0, -1), longStep, ...base.slice(-1)] : base;
  const last = list.length - 1;
  return list.map((step, index): ProcessStep => {
    if (index !== last) return outcome === 'unknown' && index === 0 ? { ...step, status: 'unknown', output: '原生没有返回这一步的结果。' } : step;
    // A stop leaves the in-flight step as natively running; the block shows it as stopped.
    if (running || stopped) return { id: step.id, name: step.name, status: 'running', ...(step.input ? { input: step.input } : {}) };
    if (outcome === 'failed') return { ...step, status: 'failed', output: '错误：示例/周报/摘要.md 不存在。' };
    if (outcome === 'exit-code') return { ...step, status: 'failed', exitCode: 2, output: 'python3: 找不到示例脚本。' };
    if (outcome === 'no-detail') return { id: step.id, name: step.name, status: 'completed' };
    return step;
  });
}

/** Arg changes keep the same instance, so switching `running` off shows the automatic fold. */
function ProcessDemo(args: Args) {
  return <div className="catalog-column">
    <p className="catalog-muted" style={{ marginBottom: 8 }}>运行中逐步展开；结束后自动收成一行摘要，可再展开。读者手动展开或收起后，以读者的选择为准，直到下一次运行结束。每一步点开看输入与输出。</p>
    <ProcessBlock steps={buildSteps(args)} running={args.running} stopped={args.stopped}/>
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
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState(false);
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearInterval(timer.current), []);
  function start() {
    window.clearInterval(timer.current); setDone(0); setStopped(false); setRunning(true);
    timer.current = window.setInterval(() => setDone(value => {
      if (value + 1 >= script.length) { window.clearInterval(timer.current); setRunning(false); }
      return Math.min(script.length, value + 1);
    }), 1100);
  }
  function stop() { window.clearInterval(timer.current); setStopped(true); setRunning(false); }
  const steps: ProcessStep[] = script.slice(0, Math.min(script.length, done + (running || stopped ? 1 : 0)))
    .map((step, index) => ({ ...step, status: index < done ? 'completed' : 'running', ...(index < done ? {} : { output: '' }) }));
  return <div className="catalog-column">
    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
      <Button variant="primary" onClick={start}><Play size={14}/>模拟一次执行</Button>
      <Button disabled={!running} onClick={stop}><Square size={12}/>停止</Button>
    </div>
    {steps.length ? <ProcessBlock steps={steps} running={running} stopped={stopped}/> : <p className="catalog-muted">点“模拟一次执行”。</p>}
  </div>;
}

const meta = {
  title: '模式/过程展示',
  component: ProcessDemo,
  args: { running: false, stopped: false, outcome: 'completed', steps: 3, long: false },
  argTypes: {
    outcome: { control: 'inline-radio', options: ['completed', 'failed', 'unknown', 'exit-code', 'no-detail'] },
    steps: { control: { type: 'range', min: 1, max: 12, step: 1 } },
  },
} satisfies Meta<typeof ProcessDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = { name: '运行中 · 展开', args: { running: true } };
export const Completed: Story = { name: '已完成 · 收起' };
export const Failed: Story = { name: '失败于某一步', args: { outcome: 'failed' } };
export const ExitCode: Story = { name: '非零退出码', args: { outcome: 'exit-code' } };
export const Unknown: Story = { name: '状态未明', args: { outcome: 'unknown' } };
export const Stopped: Story = { name: '已停止', args: { stopped: true, running: false } };
export const LongDetail: Story = { name: '很长的输入与输出', args: { long: true, steps: 4 } };
export const NoDetail: Story = { name: '没有输入输出的步骤', args: { outcome: 'no-detail' } };
export const Live: Story = { name: '模拟执行（自动收起）', render: () => <LiveDemo/>, parameters: { controls: { disable: true } } };
export const Phone: Story = { name: '手机', args: { running: true, long: true, steps: 4 }, globals: phone };

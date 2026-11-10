import { useId, useState } from 'react';
import { Check, ChevronRight, CircleHelp, Square, TriangleAlert, X } from 'lucide-react';
import './transcript.css';

export type ProcessStep = { id: string; name: string; input?: string; output?: string; status: 'running' | 'completed' | 'failed' | 'unknown'; exitCode?: number };
/** What the native turn itself says about a run; the steps only supply the facts when this is missing. */
export type ProcessRunState = 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';

/** A step also shows "stopped" when its run ended and its own record never got a result. */
type StepState = ProcessStep['status'] | 'stopped';

const stepState = { running: '进行中', completed: '已完成', failed: '未完成', unknown: '状态未明', stopped: '已停止' } as const;

function firstLine(text?: string) { return text?.split('\n').find(line => line.trim())?.trim(); }

/**
 * A step's own status, except that a run we know ended cannot leave a step spinning: an interrupted run
 * stopped it, and a run whose state we cannot trust leaves it unknown instead of claiming progress.
 */
function displayStatus(step: ProcessStep, runState?: ProcessRunState, stopped?: boolean): StepState {
  if (step.status !== 'running') return step.status;
  if (stopped || runState === 'interrupted') return 'stopped';
  if (runState === 'completed' || runState === 'failed' || runState === 'unknown') return 'unknown';
  return 'running';
}

/** One step: a one-line row that opens to its input and output. Unknown never reads as success. */
function Step({ step, status }: { step: ProcessStep; status: StepState }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const preview = firstLine(step.input);
  const hasDetail = !!(step.input || step.output);
  return <li className="process-step" data-status={status} data-anchor={step.id}>
    <button type="button" className="process-step-row" aria-expanded={hasDetail ? open : undefined} aria-controls={hasDetail ? id : undefined}
      disabled={!hasDetail} onClick={() => setOpen(value => !value)}>
      <span className="process-step-icon" aria-hidden="true">{status === 'running' ? <i className="process-spinner"/> : status === 'failed' ? <X size={12}/> : status === 'unknown' ? <CircleHelp size={12}/> : status === 'stopped' ? <Square size={9}/> : <Check size={12}/>}</span>
      <span className="process-step-name">{step.name}</span>
      {preview && <span className="process-step-input">{preview}</span>}
      <span className="process-step-state">{step.exitCode !== undefined && step.exitCode !== 0 ? `退出码 ${step.exitCode}` : stepState[status]}</span>
    </button>
    {hasDetail && <div className="process-step-detail" id={id} data-open={open}><div>
      {step.input && <pre className="tool-input">{step.input}</pre>}
      <pre>{step.output || '暂无输出'}</pre>
    </div></div>}
  </li>;
}

/**
 * Agent process: one folded summary line with the step rows behind it. The reader alone decides whether
 * it is open — data updates, the end of a run or the next turn never change the reader's choice (2026-11-10).
 * The summary reports facts only: a running step, the native turn's terminal result, or the steps themselves.
 */
export function ProcessBlock({ steps, runState, lastOfRun = true, stopped, anchor }: {
  steps: ProcessStep[]; runState?: ProcessRunState; lastOfRun?: boolean;
  /** Legacy explicit stop, kept for catalogs that show an interrupted run without a native terminal state. */
  stopped?: boolean; anchor?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const states = steps.map(step => displayStatus(step, runState, stopped));
  const running = states.includes('running');
  const unknown = states.filter(state => state === 'unknown').length;
  const failed = states.filter(state => state === 'failed').length;
  const stoppedSteps = states.includes('stopped');
  // A native turn that is still running keeps its latest group marked as executing, even between steps.
  const executing = running || (runState === 'running' && lastOfRun);
  const currentIndex = states.lastIndexOf('running');
  // Only a step whose own record still says running is named as the current one; between steps the summary
  // says the run is executing without mislabelling the last finished step.
  const current = currentIndex >= 0 ? steps[currentIndex] : undefined;
  // Only the native turn's own terminal result can conclude the turn, and only its last tool group says it once.
  const tone = runState === 'unknown' ? 'unknown'
    : runState === 'failed' && lastOfRun ? 'failed'
    : stopped ? 'stopped'
    : runState === 'interrupted' && (lastOfRun || stoppedSteps) ? 'stopped'
    : executing ? 'running'
    : unknown ? 'unknown'
    : failed ? 'warning'
    : 'completed';
  const summary = tone === 'running' ? <>正在执行{current && <span className="process-current">{current.name}</span>}</>
    : tone === 'failed' ? '本轮失败'
    : tone === 'stopped' ? '已中断'
    : tone === 'unknown' ? `状态未明${unknown ? ` · ${unknown} 项待核对` : ''}${failed ? ` · ${failed} 项未成功` : ''}`
    : tone === 'warning' ? `${failed} 项未成功`
    : '已完成';
  return <div className="process" data-tone={tone} data-open={open} data-anchor={anchor}>
    <button type="button" className="process-summary" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span className="process-icon" aria-hidden="true">{tone === 'running' ? <i className="process-spinner"/> : tone === 'failed' ? <X size={13}/> : tone === 'stopped' ? <Square size={10}/> : tone === 'unknown' ? <CircleHelp size={13}/> : tone === 'warning' ? <TriangleAlert size={13}/> : <Check size={13}/>}</span>
      <span className="process-text">{summary}</span>
      <span className="process-count">{steps.length} 项操作</span>
      <ChevronRight size={14} className="process-chevron" aria-hidden="true"/>
    </button>
    <div className="process-body" id={id} data-open={open}><div>
      <ol className="process-steps" role="list">{steps.map((step, index) => <Step key={step.id} step={step} status={states[index]!}/>)}</ol>
    </div></div>
  </div>;
}

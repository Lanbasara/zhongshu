import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronRight, CircleHelp, Square, X } from 'lucide-react';
import './transcript.css';

export type ProcessStep = { id: string; name: string; input?: string; output?: string; status: 'running' | 'completed' | 'failed' | 'unknown'; exitCode?: number };

const stepState = { running: '进行中', completed: '已完成', failed: '未完成', unknown: '状态未明' } as const;

function firstLine(text?: string) { return text?.split('\n').find(line => line.trim())?.trim(); }

/** One step: a one-line row that opens to its input and output. Unknown never reads as success. */
function Step({ step, stopped }: { step: ProcessStep; stopped?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const preview = firstLine(step.input);
  const hasDetail = !!(step.input || step.output);
  const status = stopped && step.status === 'running' ? 'stopped' : step.status;
  return <li className="process-step" data-status={status} data-anchor={step.id}>
    <button type="button" className="process-step-row" aria-expanded={hasDetail ? open : undefined} aria-controls={hasDetail ? id : undefined}
      disabled={!hasDetail} onClick={() => setOpen(value => !value)}>
      <span className="process-step-icon" aria-hidden="true">{status === 'running' ? <i className="process-spinner"/> : status === 'failed' ? <X size={12}/> : status === 'unknown' ? <CircleHelp size={12}/> : status === 'stopped' ? <Square size={9}/> : <Check size={12}/>}</span>
      <span className="process-step-name">{step.name}</span>
      {preview && <span className="process-step-input">{preview}</span>}
      <span className="process-step-state">{step.exitCode !== undefined && step.exitCode !== 0 ? `退出码 ${step.exitCode}` : status === 'stopped' ? '已停止' : stepState[step.status]}</span>
    </button>
    {hasDetail && <div className="process-step-detail" id={id} data-open={open}><div>
      {step.input && <pre className="tool-input">{step.input}</pre>}
      <pre>{step.output || '暂无输出'}</pre>
    </div></div>}
  </li>;
}

/**
 * Agent process: expanded step by step while running, folded into a one-line summary when the run ends,
 * and re-openable (decided 2026-11-07). A reader's explicit toggle wins over the automatic fold.
 */
export function ProcessBlock({ steps, running, stopped, anchor }: { steps: ProcessStep[]; running: boolean; stopped?: boolean; anchor?: string }) {
  const [choice, setChoice] = useState<boolean>();
  const wasRunning = useRef(running);
  useEffect(() => { if (wasRunning.current && !running) setChoice(undefined); wasRunning.current = running; }, [running]);
  const open = choice ?? running;
  const id = useId();
  const failed = steps.filter(step => step.status === 'failed');
  const unknown = steps.filter(step => step.status === 'unknown').length;
  const current = [...steps].reverse().find(step => step.status === 'running') ?? steps.at(-1);
  // A step that failed and was followed by more work is part of the turn, not its outcome; only a failed last step fails the turn.
  const endedInFailure = steps.at(-1)?.status === 'failed';
  const tone = running ? 'running' : unknown ? 'unknown' : endedInFailure ? 'failed' : stopped ? 'stopped' : 'completed';
  const summary = running ? <>正在执行<span className="process-current">{current?.name}</span></>
    : unknown ? `状态未明 · ${unknown} 项待核对${failed.length ? ` · ${failed.length} 项未完成` : ''}`
    : endedInFailure ? <>失败于「{failed.at(-1)!.name}」</>
    : stopped ? '已停止' : failed.length ? `已完成，其中 ${failed.length} 项未成功` : '已完成';
  return <div className="process" data-tone={tone} data-open={open} data-anchor={anchor}>
    <button type="button" className="process-summary" aria-expanded={open} aria-controls={id} onClick={() => setChoice(!open)}>
      <span className="process-icon" aria-hidden="true">{tone === 'running' ? <i className="process-spinner"/> : tone === 'failed' ? <X size={13}/> : tone === 'unknown' ? <CircleHelp size={13}/> : tone === 'stopped' ? <Square size={10}/> : <Check size={13}/>}</span>
      <span className="process-text">{summary}</span>
      <span className="process-count">{steps.length} 项操作</span>
      <ChevronRight size={14} className="process-chevron" aria-hidden="true"/>
    </button>
    <div className="process-body" id={id} data-open={open}><div>
      <ol className="process-steps" role="list">{steps.map(step => <Step key={step.id} step={step} stopped={stopped}/>)}</ol>
    </div></div>
  </div>;
}

import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, FileText, Globe, KeyRound, MessageCircleQuestion, ShieldCheck, Terminal } from 'lucide-react';
import { Button } from '../ui/controls.tsx';
import { answerSummary, decisionLabel } from './request-words.ts';
export { answerSummary };
import './requests.css';

/**
 * Questions, approvals and forms that a native agent is waiting on. Presentation only: the caller owns
 * the request lifecycle and sends answers; this component never decides whether an answer took effect.
 * The shapes mirror the workbench contract structurally, so the feature layer passes its views as they are.
 */
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export type RequestQuestion = { id: string; header?: string; text: string; options: { label: string; description?: string }[]; multiple: boolean; custom: boolean };
export type RequestField = { name: string; label: string; description?: string; type: 'string' | 'number' | 'integer' | 'boolean' | 'enum'; required: boolean; options?: string[] };
type Approval = { action: 'command' | 'fileChange' | 'permissions' | 'other'; reason?: string; command?: string; cwd?: string; paths?: string[]; network?: boolean; decisions: ApprovalDecision[] };
export type PendingRequest = {
  id: string; kind: 'question' | 'approval' | 'form'; status: 'open' | 'answered' | 'expired'; createdAt: number;
  agent?: { id: string; name: string }; questions?: RequestQuestion[]; deadline?: number; approval?: Approval;
  form?: { source: string; message: string; url?: string; fields: RequestField[] };
  answer?: { id: string; status: 'queued' | 'dispatching' | 'accepted' | 'unknown' | 'rejected'; reason: string | null; updatedAt: number; summary?: string };
};
export type RequestAnswer =
  | { kind: 'question'; answers: { id: string; selected: string[]; custom?: string }[] }
  | { kind: 'approval'; decision: ApprovalDecision }
  | { kind: 'form'; action: 'accept' | 'decline' | 'cancel'; values?: Record<string, string | number | boolean> };

const decisionVariant = (decision: ApprovalDecision) => decision === 'accept' ? 'primary' as const : decision === 'cancel' ? 'quiet' as const : 'secondary' as const;
const approvalTitle = (approval: Approval) => approval.action === 'command' ? (approval.network ? '请求联网运行命令' : '请求运行命令')
  : approval.action === 'fileChange' ? '请求修改文件' : approval.action === 'permissions' ? '请求追加权限' : '请求你的批准';
const approvalIcon = (approval: Approval) => approval.network ? <Globe size={15}/> : approval.action === 'command' ? <Terminal size={15}/>
  : approval.action === 'fileChange' ? <FileText size={15}/> : approval.action === 'permissions' ? <KeyRound size={15}/> : <ShieldCheck size={15}/>;

function clock(at: number) { const date = new Date(at); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }

function Frame({ icon, title, agent, onOpenAgent, children, tone }: { icon: ReactNode; title: string; agent?: PendingRequest['agent']; onOpenAgent?: (id: string) => void; children: ReactNode; tone?: 'quiet' }) {
  return <div className="request-card" data-tone={tone}>
    <div className="request-head">
      <span className="request-icon" aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      {agent && (onOpenAgent
        ? <button type="button" className="request-agent" onClick={() => onOpenAgent(agent.id)}>来自子 Agent · {agent.name}</button>
        : <span className="request-agent">来自子 Agent · {agent.name}</span>)}
    </div>
    {children}
  </div>;
}

/** Delivery of the latest answer, as the server reports it. */
function Delivery({ request, onReconcile }: { request: PendingRequest; onReconcile(): void }) {
  const answer = request.answer;
  if (!answer) return null;
  if (answer.status === 'queued' || answer.status === 'dispatching') return <p className="request-status" role="status">正在提交{answer.summary ? `「${answer.summary}」` : ''}…</p>;
  if (answer.status === 'unknown') return <p className="request-status" data-tone="unknown" role="status">
    还没确认回答{answer.summary ? `「${answer.summary}」` : ''}是否送达。不会自动重发。<button type="button" className="text-button" onClick={onReconcile}>查询原生结果</button></p>;
  if (answer.status === 'rejected') return <p className="request-status" data-tone="failed" role="status">
    {answer.reason === 'answer_not_delivered' ? '没能确认上一次回答被采用，请再选一次；原生只会采用一次回答。' : '上一次回答没有被接受，请重新选择。'}</p>;
  return null;
}

const locked = (request: PendingRequest) => request.status !== 'open' || ['queued', 'dispatching', 'unknown'].includes(request.answer?.status ?? '');

function ApprovalBody({ request, approval, onAnswer }: { request: PendingRequest; approval: Approval; onAnswer(answer: RequestAnswer): void }) {
  const disabled = locked(request);
  return <>
    {approval.reason && <p className="request-text">{approval.reason}</p>}
    {approval.command && <pre className="request-command" aria-label="命令"><code>{approval.command}</code></pre>}
    {approval.cwd && <p className="request-meta">目录 <code>{approval.cwd}</code></p>}
    {!!approval.paths?.length && <ul className="request-paths" aria-label="涉及的路径">{approval.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul>}
    {approval.network && approval.action === 'permissions' && <p className="request-meta">包含联网权限</p>}
    <div className="request-actions">
      {approval.decisions.map(decision => <Button key={decision} variant={decisionVariant(decision)} size="small" disabled={disabled}
        onClick={() => onAnswer({ kind: 'approval', decision })}>{decisionLabel(decision, approval.action)}</Button>)}
    </div>
  </>;
}

type Choice = { selected: string[]; custom: string };
function QuestionField({ question, value, disabled, onChange }: { question: RequestQuestion; value: Choice; disabled: boolean; onChange(value: Choice): void }) {
  const id = useId();
  const toggle = (label: string) => onChange(question.multiple
    ? { ...value, selected: value.selected.includes(label) ? value.selected.filter(item => item !== label) : [...value.selected, label] }
    : { selected: [label], custom: '' });
  return <fieldset className="request-question" disabled={disabled}>
    <legend>{question.header && <span className="request-chip">{question.header}</span>}<span id={`${id}-text`}>{question.text}</span></legend>
    {!!question.options.length && <div className="request-options" role={question.multiple ? 'group' : 'radiogroup'} aria-labelledby={`${id}-text`}>
      {question.options.map(option => {
        const checked = value.selected.includes(option.label) && !(!question.multiple && value.custom.trim());
        return <button key={option.label} type="button" role={question.multiple ? 'checkbox' : 'radio'} aria-checked={checked} className="request-option" data-checked={checked || undefined} onClick={() => toggle(option.label)}>
          <span className="request-mark" data-shape={question.multiple ? 'box' : 'round'} aria-hidden="true"/>
          <span><span className="request-option-label">{option.label}</span>{option.description && <span className="request-option-description">{option.description}</span>}</span>
        </button>;
      })}
    </div>}
    {question.custom && <label className="request-custom">
      <span>{question.options.length ? (question.multiple ? '补充（可选）' : '或者自己填写') : '你的回答'}</span>
      <textarea rows={2} value={value.custom} placeholder={!question.options.length ? '输入回答' : question.multiple ? '补充说明' : '填写后以此为准'}
        onChange={event => onChange(question.multiple ? { ...value, custom: event.target.value } : { selected: event.target.value.trim() ? [] : value.selected, custom: event.target.value })}/>
    </label>}
  </fieldset>;
}
const answered = (choice: Choice | undefined) => !!choice && (choice.selected.length > 0 || !!choice.custom.trim());

function QuestionBody({ request, questions, now, onAnswer }: { request: PendingRequest; questions: RequestQuestion[]; now: number; onAnswer(answer: RequestAnswer): void }) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const disabled = locked(request);
  const ready = questions.every(question => answered(choices[question.id]));
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || disabled) return;
    onAnswer({ kind: 'question', answers: questions.map(question => { const choice = choices[question.id]!; return { id: question.id, selected: choice.selected, ...(choice.custom.trim() ? { custom: choice.custom.trim() } : {}) }; }) });
  }
  return <form onSubmit={submit}>
    {questions.map(question => <QuestionField key={question.id} question={question} value={choices[question.id] ?? { selected: [], custom: '' }} disabled={disabled}
      onChange={value => setChoices(current => ({ ...current, [question.id]: value }))}/>)}
    {request.deadline !== undefined && <p className="request-meta">{request.deadline > now
      ? `Agent 会在 ${clock(request.deadline)} 先去做其他工作；之后仍可回答。`
      : 'Agent 已先去做其他工作；现在回答会作为补充消息送达。'}</p>}
    <div className="request-actions"><Button type="submit" variant="primary" size="small" disabled={!ready || disabled}>提交回答</Button>
      {!ready && !disabled && <span className="request-hint">{questions.length > 1 ? '每个问题都需要回答' : '选择或填写后提交'}</span>}</div>
  </form>;
}

function FieldInput({ field, value, onChange }: { field: RequestField; value: string | boolean | undefined; onChange(value: string | boolean): void }) {
  if (field.type === 'boolean') return <label className="request-check"><input type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)}/><span>{field.label}{field.required && ' *'}</span></label>;
  const control = field.type === 'enum'
    ? <select value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value)}><option value="">请选择</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select>
    : <input type={field.type === 'string' ? 'text' : 'number'} step={field.type === 'integer' ? 1 : 'any'} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value)}/>;
  return <label className="request-custom"><span>{field.label}{field.required && ' *'}</span>{control}{field.description && <small>{field.description}</small>}</label>;
}
function FormBody({ request, form, onAnswer }: { request: PendingRequest; form: NonNullable<PendingRequest['form']>; onAnswer(answer: RequestAnswer): void }) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const disabled = locked(request);
  const missing = form.fields.some(field => field.required && field.type !== 'boolean' && !String(values[field.name] ?? '').trim());
  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || missing) return;
    const result: Record<string, string | number | boolean> = {};
    for (const field of form.fields) {
      const value = values[field.name];
      if (value === undefined || value === '') continue;
      result[field.name] = field.type === 'number' || field.type === 'integer' ? Number(value) : value;
    }
    onAnswer({ kind: 'form', action: 'accept', values: result });
  }
  return <form onSubmit={submit}>
    <p className="request-text">{form.message}</p>
    {form.url && <p className="request-meta"><a href={form.url} target="_blank" rel="noopener noreferrer">打开链接 <ExternalLink size={12}/></a> 完成后再点「完成」。</p>}
    <fieldset className="request-question" disabled={disabled}>{form.fields.map(field => <FieldInput key={field.name} field={field} value={values[field.name]} onChange={value => setValues(current => ({ ...current, [field.name]: value }))}/>)}</fieldset>
    <div className="request-actions">
      <Button type="submit" variant="primary" size="small" disabled={disabled || missing}>{form.url ? '完成' : '提交'}</Button>
      <Button type="button" size="small" disabled={disabled} onClick={() => onAnswer({ kind: 'form', action: 'decline' })}>拒绝</Button>
      <Button type="button" variant="quiet" size="small" disabled={disabled} onClick={() => onAnswer({ kind: 'form', action: 'cancel' })}>取消</Button>
    </div>
  </form>;
}

function titleOf(request: PendingRequest): { icon: ReactNode; title: string } {
  if (request.approval) return { icon: approvalIcon(request.approval), title: `Agent ${approvalTitle(request.approval)}` };
  if (request.form) return { icon: <ShieldCheck size={15}/>, title: `「${request.form.source}」需要你提供信息` };
  return { icon: <MessageCircleQuestion size={15}/>, title: request.questions && request.questions.length > 1 ? `Agent 有 ${request.questions.length} 个问题` : 'Agent 在问你' };
}

export function RequestCard({ request, onAnswer, onReconcile, onDismiss, onOpenAgent, now = Date.now() }: {
  request: PendingRequest; onAnswer(answer: RequestAnswer): void; onReconcile(): void; onDismiss?: () => void; onOpenAgent?: (id: string) => void; now?: number;
}) {
  const { icon, title } = titleOf(request);
  if (request.status !== 'open') {
    const unsure = request.answer?.status === 'unknown';
    const text = request.status === 'answered'
      ? `已回答${request.answer?.summary ? `「${request.answer.summary}」` : ''}`
      : unsure ? '这个请求已结束，但没能确认你的回答是否生效。' : '这个请求已失效：Agent 不再等待回答。';
    return <Frame icon={icon} title={title} agent={request.agent} onOpenAgent={onOpenAgent} tone="quiet">
      <p className="request-status" data-tone={request.status === 'answered' ? 'done' : unsure ? 'unknown' : undefined} role="status">{text}
        {onDismiss && <button type="button" className="text-button" onClick={onDismiss}>收起</button>}</p>
    </Frame>;
  }
  return <Frame icon={icon} title={title} agent={request.agent} onOpenAgent={onOpenAgent}>
    {request.approval ? <ApprovalBody request={request} approval={request.approval} onAnswer={onAnswer}/>
      : request.form ? <FormBody request={request} form={request.form} onAnswer={onAnswer}/>
      : request.questions ? <QuestionBody request={request} questions={request.questions} now={now} onAnswer={onAnswer}/> : null}
    <Delivery request={request} onReconcile={onReconcile}/>
  </Frame>;
}

/**
 * The requests of one conversation, shown above its composer. While any request is open, only open ones are
 * shown, oldest first, one step apart. Once none is open, the most recently resolved one stays visible alone.
 */
export function RequestStack({ requests, onAnswer, onReconcile, onDismiss, onOpenAgent, now }: {
  requests: PendingRequest[]; onAnswer(id: string, answer: RequestAnswer): void; onReconcile(id: string): void; onDismiss(id: string): void; onOpenAgent?: (id: string) => void; now?: number;
}) {
  const ordered = useMemo(() => {
    const open = requests.filter(request => request.status === 'open').sort((a, b) => a.createdAt - b.createdAt);
    if (open.length) return open;
    const latest = [...requests].sort((a, b) => (b.answer?.updatedAt ?? b.createdAt) - (a.answer?.updatedAt ?? a.createdAt))[0];
    return latest ? [latest] : [];
  }, [requests]);
  const [index, setIndex] = useState(0);
  const open = ordered.filter(request => request.status === 'open').length;
  useEffect(() => { if (index >= ordered.length) setIndex(Math.max(0, ordered.length - 1)); }, [index, ordered.length]);
  const current = ordered[Math.min(index, ordered.length - 1)];
  if (!current) return null;
  return <section className="request-stack" aria-label="等待你处理的请求">
    {ordered.length > 1 && <div className="request-pager">
      <span>{`${open} 个请求等待处理`}</span>
      <span className="request-pager-controls">
        <button type="button" aria-label="上一个请求" disabled={index === 0} onClick={() => setIndex(value => value - 1)}><ChevronLeft size={15}/></button>
        <span aria-live="polite">{Math.min(index, ordered.length - 1) + 1} / {ordered.length}</span>
        <button type="button" aria-label="下一个请求" disabled={index >= ordered.length - 1} onClick={() => setIndex(value => value + 1)}><ChevronRight size={15}/></button>
      </span>
    </div>}
    <RequestCard key={current.id} request={current} now={now} onOpenAgent={onOpenAgent}
      onAnswer={answer => onAnswer(current.id, answer)} onReconcile={() => onReconcile(current.id)} onDismiss={() => onDismiss(current.id)}/>
  </section>;
}

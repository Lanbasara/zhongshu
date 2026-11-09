/**
 * Forms of the schedule panel (ADR 0021): create and edit a native automation. What a task can be configured with
 * follows what the Harness applies: a conversation the Host opens for a run (every run, or the first run and then reused)
 * takes only the workspace and preset, with the Host's default model, effort and permission; a conversation target keeps
 * its own. Zhongshu never opens a conversation before a run (ADR 0021, 2026-11-09).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Sparkles } from 'lucide-react';
import { z } from 'zod';
import { automationResultSchema, type AutomationView } from '../shared/automations.ts';
import { skillCatalogSchema, type SkillOption } from '../shared/content.ts';
import type { WorkbenchConfiguration } from '../shared/workbench.ts';
import { Button } from './ui/controls.tsx';
import { request, RequestError } from './workbench-client.ts';
import { instructionWithSkill, localDate, localTime, timingText, WEEKDAYS } from './schedule-model.ts';

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
type TimingDraft = { kind: 'at' | 'daily' | 'weekly' | 'every'; date: string; time: string; weekdays: number[]; minutes: number };

function timingFrom(draft: TimingDraft) {
  if (draft.kind === 'at') { const [y, m, d] = draft.date.split('-').map(Number); const [hh, mm] = draft.time.split(':').map(Number); return { kind: 'at', at: new Date(y!, m! - 1, d!, hh!, mm!).toISOString() }; }
  if (draft.kind === 'every') return { kind: 'every', seconds: Math.max(1, draft.minutes) * 60 };
  if (draft.kind === 'weekly') return { kind: 'weekly', time: draft.time, timeZone: zone, weekdays: draft.weekdays.length ? draft.weekdays : [1, 2, 3, 4, 5] };
  return { kind: 'daily', time: draft.time, timeZone: zone };
}
function initialTiming(task?: AutomationView): TimingDraft {
  const soon = new Date(Date.now() + 3600_000);
  const base: TimingDraft = { kind: 'daily', date: localDate(soon), time: localTime(soon).slice(0, 3) + '00', weekdays: [1, 2, 3, 4, 5], minutes: 15 };
  if (!task) return base;
  const timing = task.timing;
  if (timing.kind === 'daily') return { ...base, time: timing.time };
  if (timing.kind === 'weekly') return { ...base, kind: 'weekly', time: timing.time, weekdays: timing.weekdays };
  if (timing.kind === 'every') return { ...base, kind: 'every', minutes: Math.round(timing.seconds / 60) };
  const at = new Date(task.scheduledAt); return { ...base, kind: 'at', date: localDate(at), time: localTime(at) };
}

function Field({ label, hint, children, optional }: { label: string; hint?: ReactNode; children: ReactNode; optional?: boolean }) {
  return <div className="sch-field"><span className="sch-label">{label}{optional && <small>可选</small>}</span>{children}{hint && <small className="sch-help">{hint}</small>}</div>;
}
function Segments<T extends string>({ label, value, options, change }: { label: string; value: T; options: readonly (readonly [T, string, boolean?])[]; change(value: T): void }) {
  return <div className="sch-seg sch-seg-fill" role="group" aria-label={label}>
    {options.map(([id, text, disabled]) => <button key={id} type="button" aria-pressed={value === id} disabled={disabled} onClick={() => change(id)}>{text}</button>)}
  </div>;
}

function TimingFields({ draft, change }: { draft: TimingDraft; change(draft: TimingDraft): void }) {
  return <Field label="什么时候" hint={draft.kind === 'every' ? '从现在起，每隔这么久运行一次。' : `按 ${zone} 时间。`}>
    <Segments label="什么时候" value={draft.kind} change={kind => change({ ...draft, kind })} options={[['at', '一次'], ['daily', '每天'], ['weekly', '每周'], ['every', '固定间隔']]}/>
    {draft.kind === 'weekly' && <div className="sch-days" role="group" aria-label="星期">{WEEKDAYS.map((day, index) =>
      <button key={day} type="button" aria-pressed={draft.weekdays.includes(index + 1)}
        onClick={() => change({ ...draft, weekdays: draft.weekdays.includes(index + 1) ? draft.weekdays.filter(value => value !== index + 1) : [...draft.weekdays, index + 1].sort() })}>{day}</button>)}</div>}
    <div className="sch-inline">
      {draft.kind === 'at' && <input type="date" aria-label="日期" value={draft.date} onChange={event => change({ ...draft, date: event.target.value })}/>}
      {draft.kind !== 'every' && <input type="time" aria-label="时间" value={draft.time} onChange={event => change({ ...draft, time: event.target.value })}/>}
      {draft.kind === 'every' && <label className="sch-suffix"><input type="number" aria-label="间隔分钟数" min={1} max={1440} value={draft.minutes} onChange={event => change({ ...draft, minutes: Number(event.target.value) })}/><span>分钟</span></label>}
    </div>
  </Field>;
}

/** The skills of the workspace or conversation the runs will happen in; choosing one names it at the start of the instruction. */
function SkillPicker({ scope, where, csrf, value, change }: { scope?: { workspaceId: string } | { conversationId: string }; where: string; csrf: string; value?: SkillOption; change(skill?: SkillOption): void }) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<SkillOption[]>(); const [failed, setFailed] = useState(false);
  const key = !scope ? '' : 'conversationId' in scope ? `c:${scope.conversationId}` : `w:${scope.workspaceId}`;
  useEffect(() => { setSkills(undefined); setFailed(false); setOpen(false); }, [key]);
  const load = async () => {
    if (!scope) return; setFailed(false);
    try {
      // A DSH workspace lists its skills through the same prepared draft session the new-conversation page uses.
      const value = 'conversationId' in scope ? await request(`/conversations/${encodeURIComponent(scope.conversationId)}/skills`, skillCatalogSchema)
        : await request('/draft-preparation', skillCatalogSchema.extend({ preparationId: z.string() }), { csrf, body: { workspaceId: scope.workspaceId, harnessId: 'dsh' }, timeoutMs: 30_000 });
      setSkills(value.skills);
    } catch { setFailed(true); }
  };
  return <Field label="运行技能" optional hint={`列出${where}里 Agent 能用的技能。中书会在指令开头写上“使用技能 …”，Agent 运行时自己加载它；技能需要允许模型调用。`}>
    <button type="button" className="sch-picker" aria-expanded={open} disabled={!scope} onClick={() => { setOpen(!open); if (!skills) void load(); }}>
      {value ? <span className="sch-picker-value"><Sparkles size={14} aria-hidden="true"/>{value.label}</span> : <span className="sch-picker-empty">不使用技能</span>}
      <ChevronDown size={14} aria-hidden="true"/>
    </button>
    {open && <div className="sch-options" role="listbox" aria-label="技能">
      {!skills && !failed && <p className="sch-help">正在读取技能…</p>}
      {failed && <p className="sch-help">读取失败。<button type="button" className="text-button" onClick={() => void load()}>重试</button></p>}
      {skills && <button type="button" role="option" aria-selected={!value} onClick={() => { change(undefined); setOpen(false); }}><span><b>不使用技能</b></span>{!value && <Check size={14}/>}</button>}
      {skills?.map(skill => <button key={skill.id} type="button" role="option" aria-selected={value?.id === skill.id} onClick={() => { change(skill); setOpen(false); }}>
        <span><b>{skill.label}</b>{skill.description && <small>{skill.description}</small>}</span>{value?.id === skill.id && <Check size={14}/>}</button>)}
      {skills && !skills.length && <p className="sch-help">{where}里还没有可用的技能。工作区技能放在 <code>.dsh/skills/名称/SKILL.md</code>；已安装插件带的技能也会列在这里。</p>}
    </div>}
  </Field>;
}

const targets = {
  conversation: ['回到这段对话', '每次运行都接在这段对话后面，沿用它的配置。'],
  new: ['每次新开一段对话', '每次运行都是一段新对话，适合例行检查。'],
  new_once: ['首次新开，之后回到那段', '所有运行都在同一段对话里，适合持续跟踪。'],
} as const;

export function CreateForm({ configuration, csrf, report, close, reload, conversationId }: {
  configuration?: WorkbenchConfiguration; csrf: string; report(reason: unknown): void; close(): void; reload(): Promise<void>; conversationId?: string;
}) {
  const dsh = configuration?.harnesses.find(item => item.id === 'dsh');
  const presets = dsh?.presets ?? [];
  const [title, setTitle] = useState(''); const [prompt, setPrompt] = useState('');
  const [timing, setTiming] = useState(initialTiming());
  const [target, setTarget] = useState<keyof typeof targets>(conversationId ? 'conversation' : 'new');
  // The settings may arrive after the form opens; until the user picks, the first workspace is the choice shown and used.
  const [picked, setPicked] = useState('');
  const workspace = configuration?.workspaces.some(entry => entry.id === picked) ? picked : configuration?.workspaces[0]?.id ?? '';
  const [preset, setPreset] = useState(dsh?.defaultPresetId ?? presets.find(item => item.available)?.id ?? '');
  const [skill, setSkill] = useState<SkillOption>();
  const [busy, setBusy] = useState(false); const [tried, setTried] = useState(false); const [problem, setProblem] = useState<string>();
  useEffect(() => { setSkill(undefined); }, [target, workspace]);

  const missing = [!title.trim() && '名称', !prompt.trim() && !skill && '指令或技能', target !== 'conversation' && !workspace && '工作区'].filter(Boolean) as string[];
  const submit = async () => {
    setTried(true); setProblem(undefined);
    if (missing.length) return;
    setBusy(true);
    try {
      const body = { harnessId: 'dsh', title: title.trim(), prompt: instructionWithSkill(prompt, skill), timing: timingFrom(timing),
        target: target === 'conversation' && conversationId ? { kind: 'conversation', conversationId }
          : { kind: target, workspaceId: workspace, ...(preset ? { preset } : {}) } };
      await request('/automations', automationResultSchema, { csrf, body, timeoutMs: 60_000 });
      await reload(); close();
    } catch (error) {
      if (error instanceof RequestError && error.code === 'workspace_not_found') setProblem('这个工作区已经不在了，请换一个。');
      else report(error);
    } finally { setBusy(false); }
  };
  const scope = target === 'conversation' && conversationId ? { conversationId } : workspace ? { workspaceId: workspace } : undefined;
  return <form className="sch-form-shell" noValidate onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="sch-panel-body sch-form">
      <Field label="名称"><input aria-invalid={tried && !title.trim() || undefined} maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：收盘后研判"/></Field>
      {target !== 'conversation' && <Field label="工作区" hint="任务在这个工作区里运行，下面的技能也来自这里。">
        <span className="sch-select"><select aria-label="工作区" value={workspace} onChange={event => setPicked(event.target.value)}>
          {configuration?.workspaces.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select><ChevronDown size={14} aria-hidden="true"/></span>
      </Field>}
      <Field label="交给 Agent 的指令"><textarea aria-invalid={tried && !prompt.trim() && !skill || undefined} maxLength={32000} value={prompt} onChange={event => setPrompt(event.target.value)}
        placeholder="先确认今天是否开市；读最近的计划文件，写研判；需要我关注时用一句话通知我。"/></Field>
      <SkillPicker scope={scope} where={target === 'conversation' ? '这段对话' : `「${configuration?.workspaces.find(entry => entry.id === workspace)?.label ?? '工作区'}」`} csrf={csrf} value={skill} change={setSkill}/>
      <TimingFields draft={timing} change={setTiming}/>
      <div className="sch-field" role="radiogroup" aria-label="结果放哪"><span className="sch-label">结果放哪</span>
        {(Object.keys(targets) as (keyof typeof targets)[]).filter(id => id !== 'conversation' || conversationId).map(id =>
          <button key={id} type="button" role="radio" aria-checked={target === id} className="sch-choice" onClick={() => setTarget(id)}>
            <span><b>{targets[id][0]}</b><small>{targets[id][1]}</small></span>{target === id && <Check size={15} aria-hidden="true"/>}</button>)}
      </div>
      <Field label="Agent 配置" hint={target === 'conversation' ? undefined
        : '运行到点时由宿主新开对话，只能选预设；模型、思考深度和权限用宿主默认。要用别的配置，先自己开一段配好的对话，再让任务投递到那里。'}>
        {target === 'conversation' ? <p className="sch-static">沿用这段对话的配置。</p>
          : presets.length ? <Segments label="Agent 预设" value={preset} change={setPreset} options={presets.map(item => [item.id, item.label, !item.available] as const)}/>
          : <p className="sch-static">宿主默认</p>}
      </Field>
      {problem && <p className="sch-notice" role="status">{problem}</p>}
    </div>
    <footer className="sch-panel-actions sch-panel-actions-end">
      {tried && missing.length > 0 && <span className="sch-missing" role="status">还差：{missing.join('、')}</span>}
      <Button variant="quiet" onClick={close}>取消</Button>
      <Button type="submit" variant="primary" disabled={busy}>{busy ? '正在创建…' : '创建'}</Button>
    </footer>
  </form>;
}

export function EditForm({ task, save, cancel }: { task: AutomationView; save(patch: Record<string, unknown>): Promise<void>; cancel(): void }) {
  const [title, setTitle] = useState(task.title); const [prompt, setPrompt] = useState(task.prompt);
  const editableTiming = task.timing.kind !== 'cron' && !(task.timing.kind === 'rrule' && !/COUNT=1/.test(task.timing.rrule));
  const [timing, setTiming] = useState(initialTiming(task)); const [changeTiming, setChangeTiming] = useState(false);
  const [busy, setBusy] = useState(false);
  const empty = !title.trim() || !prompt.trim();
  return <form className="sch-form-shell" noValidate onSubmit={event => {
    event.preventDefault(); if (empty) return; setBusy(true);
    void save({ ...(title !== task.title ? { title } : {}), ...(prompt !== task.prompt ? { prompt } : {}), ...(changeTiming ? { timing: timingFrom(timing) } : {}) }).finally(() => setBusy(false));
  }}>
    <div className="sch-panel-body sch-form">
      <Field label="名称"><input aria-invalid={!title.trim() || undefined} value={title} maxLength={120} onChange={event => setTitle(event.target.value)}/></Field>
      <Field label="交给 Agent 的指令"><textarea aria-invalid={!prompt.trim() || undefined} value={prompt} maxLength={32000} onChange={event => setPrompt(event.target.value)}/></Field>
      {editableTiming ? (changeTiming ? <TimingFields draft={timing} change={setTiming}/>
        : <Field label="时间"><div className="sch-static-row"><span>{timingText(task)}</span><Button size="small" onClick={() => setChangeTiming(true)}>改时间</Button></div></Field>)
        : <p className="schedule-note">这条任务用的是高级规则（{timingText(task)}），时间请在对话里让 Agent 改。</p>}
      <p className="sch-help">结果去哪和 Agent 配置在建好后不能改；要换，就新建一个任务。</p>
    </div>
    <footer className="sch-panel-actions sch-panel-actions-end">
      {empty && <span className="sch-missing" role="status">名称和指令不能为空</span>}
      <Button variant="quiet" onClick={cancel}>取消</Button>
      <Button type="submit" variant="primary" disabled={busy || empty}>{busy ? '正在保存…' : '保存'}</Button>
    </footer>
  </form>;
}

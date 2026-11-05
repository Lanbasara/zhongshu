import { useEffect, useRef, useState } from 'react';
import { ArrowUp, CirclePause, ListOrdered, LoaderCircle, MessageSquareText, Paperclip, SquarePen, Trash2 } from 'lucide-react';
import type { QueueCommand, QueueSummary, QueueView } from '../shared/workbench.ts';
import { Button, IconButton } from './ui/controls.tsx';
import { SkillEditor } from './patterns/composer-extras.tsx';
import type { InputContent } from '../shared/content.ts';
import './input-queue.css';

const labels = {
  waiting: '等待发送', dispatching: '正在发送…', accepted: '已接收，等待执行确认',
  unknown: '发送结果待确认，不会重复发送', held: '等待你选择下一步',
};
const pauses = {
  stopped: '队列已暂停',
  failed: '当前轮执行失败，队列已暂停。',
  missed: '当前任务已结束，这条消息仍在队列中。',
  rejected: '消息未能发送，已保留在队列中。',
  restored: '队列来自恢复的备份，请核对后继续。',
};

export function InputQueue({ queue, target, busy, canResume, onCommand, onRead, onCheck }: {
  queue: QueueSummary; target?: string; busy: boolean; canResume: boolean;
  onCommand(command: QueueCommand): Promise<boolean>;
  onCheck?(): void;
  onRead(entryId: string, version: number, signal: AbortSignal): Promise<QueueView['entries'][number]>;
}) {
  const [edit, setEdit] = useState<{ id: string; version: number; content: InputContent }>();
  const [loading, setLoading] = useState<string>(); const [error, setError] = useState(false);
  const controller = useRef<AbortController>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  async function load(entry: QueueSummary['entries'][number]) {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setLoading(entry.entryId); setError(false);
    try {
      const full = await onRead(entry.entryId, entry.version, current.signal);
      if (!current.signal.aborted) setEdit({ id: full.entryId, version: full.version, content: full.content });
    } catch { if (!current.signal.aborted) setError(true); }
    finally { if (!current.signal.aborted) setLoading(undefined); }
  }
  if (!queue.entries.length) return null;
  const mode = queue.mode;
  const earlyLabel = mode === 'current' ? '追加到本轮' : '尽快发送';
  const pending = queue.entries.some(entry => ['dispatching', 'accepted', 'unknown'].includes(entry.status));
  const multiple = queue.entries.length > 1;
  return <section className="input-queue" aria-label="消息队列">
    {error && <p role="alert">无法读取完整排队消息，请重试；若消息已变化，先刷新对话。</p>}
    {queue.pause ? <div className="input-queue-bar">
      <span role="status"><CirclePause size={14} aria-hidden="true"/>{pauses[queue.pause]}</span>
      <Button variant="quiet" className="input-queue-resume" disabled={busy || pending || !canResume}
        onClick={() => void onCommand({ action: 'resume', version: queue.version })}>继续发送</Button>
    </div> : multiple && <div className="input-queue-bar">
      <span><ListOrdered size={14} aria-hidden="true"/>消息队列 <span className="input-queue-count">{queue.entries.length} 条</span></span>
    </div>}
    <ol role="list">{queue.entries.map((entry, index) => {
      const mutable = entry.status === 'waiting' || entry.status === 'held';
      const nextTurnSkill = mode === 'current' && entry.preview.skills > 0;
      const identity = { entryId: entry.entryId, version: entry.version };
      const materials = [
        ...(entry.preview.images ? [`${entry.preview.images} 张图片`] : []),
        ...(entry.preview.references ? [`${entry.preview.references} 项引用`] : []),
      ].join(' · ');
      return <li key={entry.entryId}>
        <span className="input-queue-marker" aria-hidden="true">{multiple ? index + 1 : <MessageSquareText size={16}/>}</span>
        {edit?.id === entry.entryId && mutable ? <div className="input-queue-edit">
          <SkillEditor editor={{ 'aria-label': '编辑排队消息', rows: 2, maxLength: 16_000, value: edit.content.text, autoFocus: true }}
            spans={edit.content.skills} onEdit={(text, skills) => setEdit({ ...edit, content: { ...edit.content, text, skills: skills.length ? skills : undefined } })}/>
          <div className="input-queue-actions">
            <Button variant="quiet" onClick={() => setEdit(undefined)}>取消编辑</Button>
            <Button variant="secondary" disabled={busy || (!edit.content.text.trim() && !materials)}
              onClick={() => void onCommand({ action: 'edit', entryId: edit.id, version: edit.version, content: edit.content }).then(saved => { if (saved) setEdit(undefined); })}>保存编辑</Button>
          </div>
        </div> : <>
          <div className="input-queue-content">
            <p>{entry.preview.text || materials}</p>
            {materials && entry.preview.text && <span className="input-queue-materials" title={materials}>
              <Paperclip size={13} aria-hidden="true"/><span className="sr-only">{materials}</span>
            </span>}
            {entry.status === 'waiting' && !nextTurnSkill ? <small className="input-queue-status">{labels.waiting}</small> :
              <small className="input-queue-status" role="status">
                {entry.status === 'dispatching' && <LoaderCircle size={12} className="spin" aria-hidden="true"/>}
                {entry.skillUnavailable ? '技能已不可用，请编辑排队消息。' : nextTurnSkill && mutable ? '技能将在下一轮调用。' : labels[entry.status]}
              </small>}
            {entry.status === 'unknown' && onCheck && <Button variant="quiet" disabled={busy} onClick={onCheck}>查询发送结果</Button>}
          </div>
          {mutable && <div className="input-queue-actions">
            <IconButton label={loading === entry.entryId ? '正在读取完整消息' : '编辑'} disabled={busy || !!loading}
              onClick={() => void load(entry)}>{loading === entry.entryId ? <LoaderCircle size={15} className="spin" aria-hidden="true"/> : <SquarePen size={15} aria-hidden="true"/>}</IconButton>
            <IconButton label="删除" disabled={busy}
              onClick={() => void onCommand({ action: 'remove', ...identity })}><Trash2 size={15} aria-hidden="true"/></IconButton>
            {mode && <IconButton label={earlyLabel} tooltip={mode === 'soon' ? '尽快发送，原轮结束时可在下一轮送达' : earlyLabel}
              className="input-queue-send" disabled={!target || busy || pending || nextTurnSkill || queue.pause === 'restored'}
              onClick={() => { if (target) void onCommand({ action: 'send', ...identity, operationId: crypto.randomUUID(), mode, target }); }}><ArrowUp size={17} aria-hidden="true"/></IconButton>}
          </div>}
        </>}
      </li>;
    })}</ol>
  </section>;
}

import { useState } from 'react';
import { ArrowUp, CirclePause, ListOrdered, LoaderCircle, MessageSquareText, Paperclip, SquarePen, Trash2 } from 'lucide-react';
import { skillRequiresNextTurn, type QueueCommand, type QueueView } from '../shared/workbench.ts';
import { Button, IconButton } from './ui/controls.tsx';
import { SkillEditor } from './patterns/composer-extras.tsx';
import type { SkillReference } from '../shared/content.ts';
import './input-queue.css';

const labels = {
  waiting: '等待派发', dispatching: '正在发送', accepted: '已接收，正在核对轮次',
  unknown: '接收结果待核实', held: '等待你选择下一步',
};
const pauses = {
  stopped: '队列已暂停',
  failed: '当前轮执行失败，队列已暂停。',
  missed: '目标轮已结束。消息留在队列中。',
  rejected: '上次派发未被接收。消息留在队列中。',
  restored: '队列来自恢复的备份，请核对后继续。',
};

export function InputQueue({ queue, target, busy, canResume, onCommand }: {
  queue: QueueView; target?: string; busy: boolean; canResume: boolean;
  onCommand(command: QueueCommand): Promise<boolean>;
}) {
  const [edit, setEdit] = useState<{ id: string; version: number; text: string; skills?: SkillReference[] }>();
  if (!queue.entries.length) return null;
  const mode = queue.mode;
  const earlyLabel = mode === 'current' ? '追加到本轮' : '尽快发送';
  const pending = queue.entries.some(entry => ['dispatching', 'accepted', 'unknown'].includes(entry.status));
  const multiple = queue.entries.length > 1;
  return <section className="input-queue" aria-label="消息队列">
    {queue.pause ? <div className="input-queue-bar">
      <span role="status"><CirclePause size={14} aria-hidden="true"/>{pauses[queue.pause]}</span>
      <Button variant="quiet" className="input-queue-resume" disabled={busy || pending || !canResume}
        onClick={() => void onCommand({ action: 'resume', version: queue.version })}>继续派发</Button>
    </div> : multiple && <div className="input-queue-bar">
      <span><ListOrdered size={14} aria-hidden="true"/>消息队列 <span className="input-queue-count">{queue.entries.length} 条</span></span>
    </div>}
    <ol role="list">{queue.entries.map((entry, index) => {
      const mutable = entry.status === 'waiting' || entry.status === 'held';
      const nextTurnSkill = skillRequiresNextTurn(mode, entry.content);
      const identity = { entryId: entry.entryId, version: entry.version };
      const materials = [
        ...(entry.content.images?.length ? [`${entry.content.images.length} 张图片`] : []),
        ...(entry.content.references?.length ? [`${entry.content.references.length} 项引用`] : []),
      ].join(' · ');
      return <li key={entry.entryId}>
        <span className="input-queue-marker" aria-hidden="true">{multiple ? index + 1 : <MessageSquareText size={16}/>}</span>
        {edit?.id === entry.entryId && mutable ? <div className="input-queue-edit">
          <SkillEditor editor={{ 'aria-label': '编辑排队消息', rows: 2, maxLength: 16_000, value: edit.text, autoFocus: true }}
            spans={edit.skills} onEdit={(text, skills) => setEdit({ ...edit, text, skills: skills.length ? skills : undefined })}/>
          <div className="input-queue-actions">
            <Button variant="quiet" onClick={() => setEdit(undefined)}>取消编辑</Button>
            <Button variant="secondary" disabled={busy || (!edit.text.trim() && !materials)}
              onClick={() => void onCommand({ action: 'edit', entryId: edit.id, version: edit.version, content: { ...entry.content, text: edit.text, skills: edit.skills } }).then(saved => { if (saved) setEdit(undefined); })}>保存编辑</Button>
          </div>
        </div> : <>
          <div className="input-queue-content">
            <p title={entry.content.text || undefined}>{entry.content.text || materials}</p>
            {materials && entry.content.text && <span className="input-queue-materials" title={materials}>
              <Paperclip size={13} aria-hidden="true"/><span className="sr-only">{materials}</span>
            </span>}
            {entry.status === 'waiting' && !nextTurnSkill ? <span className="sr-only">{labels.waiting}</span> :
              <small className="input-queue-status" role="status">
                {entry.status === 'dispatching' && <LoaderCircle size={12} className="spin" aria-hidden="true"/>}
                {entry.skillUnavailable ? '技能已不可用，请编辑排队消息。' : nextTurnSkill && mutable ? '技能将在下一轮调用。' : labels[entry.status]}
              </small>}
          </div>
          {mutable && <div className="input-queue-actions">
            <IconButton label="编辑" disabled={busy}
              onClick={() => setEdit({ id: entry.entryId, version: entry.version, text: entry.content.text, skills: entry.content.skills })}><SquarePen size={15} aria-hidden="true"/></IconButton>
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

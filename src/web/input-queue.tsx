import { useState } from 'react';
import type { QueueCommand, QueueView } from '../shared/workbench.ts';

const labels = {
  waiting: '等待派发', dispatching: '正在发送', accepted: '已接收，正在核对轮次',
  unknown: '接收结果待核实', held: '等待你选择下一步',
};
const pauses = {
  stopped: '当前轮已停止，队列已暂停。',
  failed: '当前轮执行失败，队列已暂停。',
  missed: '目标轮已结束。消息留在队列中。',
  rejected: '上次派发未被接收。消息留在队列中。',
  restored: '队列来自恢复的备份，请核对后继续。',
};

export function InputQueue({ queue, target, busy, canResume, onCommand }: {
  queue: QueueView; target?: string; busy: boolean; canResume: boolean;
  onCommand(command: QueueCommand): Promise<boolean>;
}) {
  const [edit, setEdit] = useState<{ id: string; version: number; text: string }>();
  if (!queue.entries.length) return null;
  const mode = queue.mode;
  const earlyLabel = mode === 'current' ? '追加到本轮' : '尽快发送';
  const pending = queue.entries.some(entry => ['dispatching', 'accepted', 'unknown'].includes(entry.status));
  return <section className="input-queue" aria-label="消息队列">
    <div className="input-queue-heading"><strong>消息队列</strong><span>{queue.entries.length} 条</span></div>
    {mode === 'soon' && <p className="input-queue-hint">尽快发送时，原轮若已结束，消息可在下一轮送达。</p>}
    {queue.pause && <div className="input-queue-heading" role="status"><span>{pauses[queue.pause]}</span>
      <button type="button" className="text-button" disabled={busy || pending || !canResume}
        onClick={() => void onCommand({ action: 'resume', version: queue.version })}>继续派发</button></div>}
    <ol>{queue.entries.map(entry => {
      const mutable = entry.status === 'waiting' || entry.status === 'held';
      const identity = { entryId: entry.entryId, version: entry.version };
      return <li key={entry.entryId}>
        {edit?.id === entry.entryId && mutable ? <div className="input-queue-edit">
          <textarea aria-label="编辑排队消息" maxLength={16000} value={edit.text}
            onChange={event => setEdit({ ...edit, text: event.target.value })}/>
          <div className="input-queue-actions">
            <button type="button" className="text-button" disabled={busy || (!edit.text.trim() && !entry.content.images?.length && !entry.content.references?.length)}
              onClick={() => void onCommand({ action: 'edit', entryId: edit.id, version: edit.version, content: { ...entry.content, text: edit.text } }).then(saved => { if (saved) setEdit(undefined); })}>保存编辑</button>
            <button type="button" className="text-button" onClick={() => setEdit(undefined)}>取消编辑</button>
          </div>
        </div> : <div className="input-queue-content">
          {entry.content.text && <p>{entry.content.text}</p>}
          {entry.content.images?.map(image => <small key={image.id}>{image.name}</small>)}
          {!!entry.content.references?.length && <small>{entry.content.references.length} 项引用</small>}
          <small>{labels[entry.status]}</small>
          {mutable && <div className="input-queue-actions">
            <button type="button" className="text-button" disabled={busy}
              onClick={() => setEdit({ id: entry.entryId, version: entry.version, text: entry.content.text })}>编辑</button>
            <button type="button" className="text-button" disabled={busy}
              onClick={() => void onCommand({ action: 'remove', ...identity })}>删除</button>
            {mode && <button type="button" className="text-button" disabled={!target || busy || pending || queue.pause === 'restored'}
              onClick={() => { if (target) void onCommand({ action: 'send', ...identity, operationId: crypto.randomUUID(), mode, target }); }}>{earlyLabel}</button>}
          </div>}
        </div>}
      </li>;
    })}</ol>
  </section>;
}

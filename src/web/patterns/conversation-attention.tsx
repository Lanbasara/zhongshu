import { CircleHelp, Clock, TriangleAlert } from 'lucide-react';
import { Button } from '../ui/controls.tsx';
import './conversation-attention.css';

export type ConversationAttentionTone = 'unknown' | 'blocked' | 'pending';
/**
 * The state hint as data. The verdict (who shows it, when, and in which words) lives in the feature
 * module `src/web/conversation-attention.ts`; a presentation pattern cannot import that layer, so this
 * is the same small shape declared where it is rendered.
 */
export type ConversationAttentionView = {
  tone: ConversationAttentionTone;
  title: string;
  detail?: string;
  action?: 'reconcile';
};

const icons = { unknown: CircleHelp, blocked: TriangleAlert, pending: Clock } as const;

/**
 * One compact hint above the transcript, on the reading axis: what the state is now, the known cause,
 * what stays, and — when the native side can be asked — the same "查询原生结果" action as elsewhere.
 * Low-key by design: a quiet note, not an alert banner. Nothing renders when there is nothing to say.
 */
export function ConversationAttention({ attention, onReconcile }: { attention?: ConversationAttentionView | null; onReconcile(): void }) {
  if (!attention) return null;
  const Icon = icons[attention.tone];
  return <div className="conversation-attention-slot">
    <section className="conversation-attention" data-tone={attention.tone} aria-live="polite">
      <Icon className="conversation-attention-icon" size={15} aria-hidden="true"/>
      <div className="conversation-attention-text">
        <p className="conversation-attention-title">{attention.title}</p>
        {attention.detail && <p className="conversation-attention-detail">{attention.detail}</p>}
      </div>
      {attention.action === 'reconcile' && <Button variant="quiet" size="small" onClick={onReconcile}>查询原生结果</Button>}
    </section>
  </div>;
}

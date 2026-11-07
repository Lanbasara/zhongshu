import { ClipboardList } from 'lucide-react';
import { Button } from '../ui/controls.tsx';
import './plan.css';

/**
 * Plan mode controls. Presentation only: the caller decides whether the Harness offers Plan mode, when it may
 * change, and what turning it on or off does natively.
 */
export function PlanToggle({ active, pending, disabled, onToggle }: { active: boolean; pending?: boolean; disabled?: boolean; onToggle(): void }) {
  const title = disabled ? '本轮运行中，结束后才能切换 Plan' : active ? '关闭 Plan：下一轮直接执行' : '开启 Plan：Agent 先规划，计划交你审核后再执行';
  return <button type="button" className="plan-toggle" aria-pressed={active} data-pending={pending || undefined} disabled={disabled} title={title} onClick={onToggle}>
    <ClipboardList size={15} aria-hidden="true"/><span>Plan</span>{pending && <span className="plan-toggle-pending">切换中</span>}
  </button>;
}

/** What Plan mode does and does not do, shown while it is on. */
export function PlanNotice({ harness }: { harness: 'Codex' | 'DSH' }) {
  return <p className="plan-notice" role="status"><ClipboardList size={14} aria-hidden="true"/>
    <span>Plan 已开启：Agent 先规划，计划交你审核后再执行。{harness === 'DSH' ? '批准计划后 DSH 会自动退出 Plan 并继续。' : '执行时会自动关闭 Plan。'}它不会限制 Agent 的工具，限制仍靠权限与审批。</span></p>;
}

/** A Plan-mode turn proposed a plan and nothing came after it. */
export function PlanReadyCard({ busy, onImplement, onKeepPlanning }: { busy?: boolean; onImplement(): void; onKeepPlanning(): void }) {
  return <section className="plan-ready" aria-label="计划已就绪">
    <div className="plan-ready-head"><span className="plan-ready-icon" aria-hidden="true"><ClipboardList size={15}/></span><strong>计划已就绪</strong></div>
    <p>按这个计划执行吗？执行会关闭 Plan，并让 Agent 开始按计划工作。想调整就继续规划，把意见写在下面的输入框里。</p>
    <div className="plan-ready-actions">
      <Button variant="primary" size="small" disabled={busy} onClick={onImplement}>{busy ? '正在开始…' : '按计划执行'}</Button>
      <Button variant="quiet" size="small" disabled={busy} onClick={onKeepPlanning}>继续规划</Button>
    </div>
  </section>;
}

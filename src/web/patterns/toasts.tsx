import { X } from 'lucide-react';
import { StatusDot, type StatusKind } from '../ui/controls.tsx';
import './overlays.css';

export type ToastView = { id: string; title: string; detail?: string; status?: StatusKind; action?: { label: string; run(): void } };

/** Short-lived notices, newest last. The caller owns timing; the region is polite so screen readers hear each one once. */
export function Toasts({ toasts, onDismiss }: { toasts: ToastView[]; onDismiss(id: string): void }) {
  return <div className="toasts" role="status" aria-live="polite">
    {toasts.map(toast => <div className="toast" key={toast.id}>
      {toast.status && <StatusDot status={toast.status}/>}
      <div className="toast-text"><strong>{toast.title}</strong>{toast.detail && <span>{toast.detail}</span>}</div>
      {toast.action && <button type="button" className="toast-action" onClick={() => { onDismiss(toast.id); toast.action!.run(); }}>{toast.action.label}</button>}
      <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => onDismiss(toast.id)}><X size={14}/></button>
    </div>)}
  </div>;
}

import type { RefObject } from 'react';
import { RefreshCw } from 'lucide-react';
import { ScrollContinuation } from './cursor-window.tsx';
import { Button } from './ui/controls.tsx';

export function DirectoryControls({ label, pending, canNext, next, refresh, marker, refreshAvailable, className }: {
  label: string; pending: boolean; canPrevious: boolean; canNext: boolean;
  previous(): void; next(): void; refresh(): void; marker?: RefObject<HTMLDivElement | null>; refreshAvailable?: boolean;
  className?: string; buttonClassName?: string;
}) {
  return <div ref={marker} className={className}>
    <ScrollContinuation available={canNext} pending={pending && canNext} load={next}/>
    {refreshAvailable && <Button variant="quiet" disabled={pending} onClick={refresh} aria-label={`更新${label}`}><RefreshCw size={14}/>更新目录</Button>}
  </div>;
}

export function DirectoryStart({ canPrevious, previous }: { canPrevious: boolean; previous(): void }) {
  return <ScrollContinuation available={canPrevious} pending={false} load={previous} label="显示上方项目"/>;
}

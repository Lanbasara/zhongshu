export function DirectoryControls({ label, number, pending, canPrevious, canNext, previous, next, first, refresh, className, buttonClassName }: {
  label: string; number: number; pending: boolean; canPrevious: boolean; canNext: boolean;
  previous(): void; next(): void; first(): void; refresh(): void;
  className?: string; buttonClassName?: string;
}) {
  return <nav aria-label={label} className={className}>
    <button type="button" className={buttonClassName} disabled={pending} onClick={refresh}>刷新</button>
    {number > 1 && <button type="button" className={buttonClassName} disabled={pending} onClick={first}>第一页</button>}
    <button type="button" className={buttonClassName} disabled={!canPrevious} onClick={previous}>上一页</button>
    <span aria-live="polite">第 {number} 页</span>
    <button type="button" className={buttonClassName} disabled={!canNext} onClick={next}>下一页</button>
  </nav>;
}

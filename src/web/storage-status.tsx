import { ChevronRight, HardDrive, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { storageSchema, type StorageView } from '../shared/workbench.ts';
import { Button } from './ui/controls.tsx';
import { request } from './workbench-client.ts';

const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
function bytes(value: number): string {
  let amount = value; let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${unit === 0 ? amount : amount.toFixed(amount >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** The application's own storage against its instance budget (ADR 0014). History bodies live in the native Harness. */
export function StorageStatus({ csrf, report, signal }: { csrf: string; report(reason: unknown): void; signal: number }) {
  const [value, setValue] = useState<StorageView>();
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const refresh = useCallback(() => {
    void request('/storage', storageSchema).then(setValue).catch(() => { /* the entry keeps its last known value */ });
  }, []);
  useEffect(() => { const timer = setInterval(refresh, 120_000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { refresh(); }, [signal, refresh]);
  useEffect(() => {
    if (open) { if (!dialog.current?.open) dialog.current?.showModal(); refresh(); }
    else if (dialog.current?.open) dialog.current.close();
  }, [open, refresh]);
  const clear = async () => {
    setClearing(true);
    try { setValue(await request('/storage/clear-cache', storageSchema, { csrf, body: {} })); }
    catch (reason) { report(reason); }
    finally { setClearing(false); }
  };
  const percent = value ? Math.min(100, Math.round(value.used / value.budget * 100)) : undefined;
  const label = !value ? '存储' : value.full ? '存储已满' : value.warning ? `存储接近上限 · ${percent}%` : `存储 · ${percent}%`;
  const state = value?.full ? ' is-full' : value?.warning ? ' is-warning' : '';
  return <>
    <button type="button" className={`sidebar-files storage-entry${state}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <HardDrive size={16}/><span>{label}</span><ChevronRight size={13}/>
    </button>
    <dialog ref={dialog} className="file-picker storage-dialog" aria-labelledby="storage-title" onClose={() => setOpen(false)}>
      <header><h2 id="storage-title">存储</h2><button type="button" aria-label="关闭存储" onClick={() => setOpen(false)}><X size={18}/></button></header>
      {value ? <>
        <p>中书已用 {bytes(value.used)}，预算 {bytes(value.budget)}（{percent}%）。对话历史保存在原生 Harness 中，不计入这里。</p>
        <div className={`storage-meter${state}`} role="meter" aria-label="中书存储用量" aria-valuemin={0} aria-valuemax={value.budget} aria-valuenow={value.used}><span style={{ width: `${percent}%` }}/></div>
        <dl className="storage-breakdown">
          <div><dt>上传与快照图片</dt><dd>{bytes(value.images.owned)}</dd></div>
          <div><dt>可清理的图片缓存</dt><dd>{bytes(value.images.cache)}</dd></div>
          {value.legacy > 0 && <div><dt>旧版历史副本（验证后删除，不计入）</dt><dd>约 {bytes(value.legacy)}</dd></div>}
        </dl>
        {value.full ? <p role="alert">已达到预算上限：暂时不能上传图片或新建对话。阅读和在已有对话里发送文字不受影响。</p>
          : value.warning ? <p role="status">已用超过预算的 80%。</p> : null}
        {value.images.cache > 0 ? <p>图片缓存是原生图片的副本，清理后需要时会重新读取。</p>
          : (value.full || value.warning) && <p>没有可以清理的缓存了。可以删除不再需要的 Codex 对话；仍然不够时，请在实例配置中调高 ZHONGSHU_STORAGE_BUDGET。</p>}
        <Button disabled={clearing || value.images.cache === 0} onClick={() => void clear()}>{clearing ? '正在清理…' : '清理图片缓存'}</Button>
      </> : <p role="status">正在读取存储用量…</p>}
    </dialog>
  </>;
}

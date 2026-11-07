import { useCallback, useEffect, useState } from 'react';
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
export function useStorage() {
  const [value, setValue] = useState<StorageView>();
  const refresh = useCallback(() => {
    void request('/storage', storageSchema).then(setValue).catch(() => { /* keep the last known value */ });
  }, []);
  // Storage barely moves: read on load, every two minutes while visible, and when the storage page opens.
  useEffect(() => {
    refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 120_000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { value, setValue, refresh };
}
export const storageState = (value?: StorageView) => value?.full ? 'full' : value?.warning ? 'warning' : undefined;

export function StoragePanel({ csrf, report, storage }: { csrf: string; report(reason: unknown): void; storage: ReturnType<typeof useStorage> }) {
  const { value, setValue, refresh } = storage;
  const [clearing, setClearing] = useState(false);
  useEffect(() => { refresh(); }, [refresh]);
  const clear = async () => {
    setClearing(true);
    try { setValue(await request('/storage/clear-cache', storageSchema, { csrf, body: {} })); }
    catch (reason) { report(reason); }
    finally { setClearing(false); }
  };
  const percent = value ? Math.min(100, Math.round(value.used / value.budget * 100)) : undefined;
  const state = storageState(value);
  return <section className="settings-section" aria-labelledby="storage-title">
    <h2 id="storage-title">存储</h2>
    <p className="settings-lead">中书自己保存的图片与缓存。对话历史保存在原生 Harness 中，不计入这里。</p>
    {value ? <div className="settings-card">
      <div className="storage-figure"><strong>{bytes(value.used)}</strong><span>/ {bytes(value.budget)} · {percent}%</span></div>
      <div className="storage-meter" data-state={state} role="meter" aria-label="中书存储用量" aria-valuemin={0} aria-valuemax={value.budget} aria-valuenow={value.used}><span style={{ width: `${percent}%` }}/></div>
      <dl className="storage-breakdown">
        <div><dt>上传与快照图片</dt><dd>{bytes(value.images.owned)}</dd></div>
        <div><dt>可清理的图片缓存</dt><dd>{bytes(value.images.cache)}</dd></div>
      </dl>
      {value.full ? <p className="settings-alert" role="alert">已达到预算上限：暂时不能上传图片或新建对话。阅读和在已有对话里发送文字不受影响。</p>
        : value.warning ? <p className="settings-warning" role="status">已用超过预算的 80%。</p> : null}
      {value.images.cache > 0 ? <p className="settings-note">图片缓存是原生图片的副本，清理后需要时会重新读取。</p>
        : (value.full || value.warning) && <p className="settings-note">没有可以清理的缓存了。可以删除不再需要的 Codex 对话；仍然不够时，请在实例配置中调高 ZHONGSHU_STORAGE_BUDGET。</p>}
      <div className="settings-actions"><Button disabled={clearing || value.images.cache === 0} onClick={() => void clear()}>{clearing ? '正在清理…' : '清理图片缓存'}</Button></div>
    </div> : <p className="settings-note" role="status">正在读取存储用量…</p>}
  </section>;
}

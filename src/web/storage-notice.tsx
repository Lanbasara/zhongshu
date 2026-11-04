import { useEffect, useState } from 'react';
import { storageCapacitySchema } from '../shared/workbench.ts';
import { request } from './workbench-client.ts';
import type { z } from 'zod';

export function StorageNotice() {
  const [capacity, setCapacity] = useState<z.infer<typeof storageCapacitySchema> | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let loading = false;
    const refresh = () => {
      if (loading || document.visibilityState !== 'visible') return;
      loading = true;
      void request('/capacity', storageCapacitySchema, { signal: controller.signal })
        .then(value => { if (!controller.signal.aborted) setCapacity(value); }).catch(() => {})
        .finally(() => { loading = false; });
    };
    refresh(); const timer = setInterval(refresh, 30_000); document.addEventListener('visibilitychange', refresh);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  if (!capacity || capacity.status === 'ok') return null;
  const staged = capacity.stagedReservedBytes ?? capacity.stagedBytes;
  const staging = capacity.stagedLimitBytes !== undefined && staged !== undefined && staged >= capacity.stagedLimitBytes * 0.8;
  return <p className="state-notice" role="status">{capacity.status === 'full'
    ? staging ? '正文存档暂存空间已满，已暂停新增工作和上传。已有存档保留；完成存档或扩容后可继续。' : '存储空间不足，已暂停新增工作和上传。已保存的内容仍可阅读；扩容后可继续。'
    : capacity.status === 'unknown' ? '暂时无法核实存储余量，新增工作和上传已暂停。'
      : staging ? '正文存档暂存空间接近容量线，请预留扩容空间。' : '存储空间即将达到容量线，请预留扩容空间。'} {capacity.status !== 'unknown' && <small>已用 {(capacity.usedBytes / 1024 ** 3).toFixed(1)} / {(capacity.quotaBytes / 1024 ** 3).toFixed(1)} GB{staging && `；存档暂存预算 ${Math.ceil(staged! / 1024 ** 2)} / ${Math.ceil(capacity.stagedLimitBytes! / 1024 ** 2)} MB`}</small>}</p>;
}

import { useEffect, useRef, useState } from 'react';
import { pluginEntry, pluginOperation, pluginView, type PluginCommand, type PluginEntry, type PluginHarness, type PluginSourceCommand, type PluginView } from '../shared/plugins.ts';
import { PluginLibrary } from './patterns/plugin-library.tsx';
import { RequestError, request } from './workbench-client.ts';

export function PluginManagement({ csrf, report }: { csrf: string; report(reason: unknown): void }) {
  const [harness, setHarness] = useState<PluginHarness>('codex');
  return <PluginCatalog key={harness} harness={harness} onHarness={setHarness} csrf={csrf} report={report}/>;
}

const sourceErrors: Record<string, string> = {
  invalid_plugin_source: '无法读取这个来源。请检查链接或 Git 引用是否指向有效的公开市场。',
  plugin_source_conflict: '同名市场已存在，或者当前来源数量已达上限。',
  plugin_source_in_use: '这个来源仍有已安装插件。卸载这些插件后即可移除来源。',
  plugin_operation_in_progress: '有一项插件操作尚待确认，请先核对结果。',
};

function PluginCatalog({ harness, onHarness, csrf, report }: {
  harness: PluginHarness; onHarness(value: PluginHarness): void; csrf: string; report(reason: unknown): void;
}) {
  const [view, setView] = useState<PluginView>();
  const [detail, setDetail] = useState<PluginEntry>();
  const [detailId, setDetailId] = useState<string>();
  const [uncertain, setUncertain] = useState<PluginCommand>();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const onReport = useRef(report);
  const path = '/plugins/' + harness;
  useEffect(() => { onReport.current = report; }, [report]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const current = await request(path, pluginView, { signal: controller.signal, timeoutMs: 45_000 });
        if (controller.signal.aborted) return;
        setView(current);
        setUncertain(value => value?.id === current.operation?.id ? undefined : value);
        if (current.operation?.status === 'applying') timer = setTimeout(() => void refresh(), 1800);
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof RequestError && reason.status === 401) onReport.current(reason);
        setError('暂时无法读取插件状态，请刷新。');
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, revision]);

  const selectedEntry = view?.entries.find(entry => entry.id === detailId);
  const detailVersion = selectedEntry?.version;
  const detailEnabled = selectedEntry?.enabled;
  const detailInstalled = selectedEntry?.installed;
  useEffect(() => {
    setDetail(undefined);
    if (!detailId) return;
    const controller = new AbortController();
    void request(path + '/detail?' + new URLSearchParams({ id: detailId }), pluginEntry, {
      signal: controller.signal, timeoutMs: 35_000,
    }).then(value => { if (!controller.signal.aborted) setDetail(value); }).catch(reason => {
      if (!controller.signal.aborted && reason instanceof RequestError && reason.status === 401) onReport.current(reason);
    });
    return () => controller.abort();
  }, [path, detailId, detailVersion, detailEnabled, detailInstalled]);

  async function update(command: PluginCommand | { id: string }, reconcile = false) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const received = await request(path + (reconcile ? '/reconcile' : '/operations'), pluginOperation, {
        csrf, body: command, timeoutMs: 45_000,
      });
      if (mounted.current) {
        setView(current => current && { ...current, operation: received });
        setUncertain(undefined);
      }
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof RequestError && reason.status === 401) onReport.current(reason);
      if (reason instanceof RequestError && [400, 403, 409].includes(reason.status)) {
        setUncertain(undefined);
        setError(reason.status === 403 ? '这个来源或当前状态不允许执行此操作。' : '插件状态已变化，请核对最新结果。');
      } else {
        if (!reconcile && 'pluginId' in command) setUncertain(command);
        setError('暂时无法确认操作结果，请核对同一操作。');
      }
    } finally {
      if (mounted.current) { setBusy(false); setRevision(value => value + 1); }
    }
  }

  async function changeSource(command: PluginSourceCommand): Promise<boolean> {
    if (busy) return false;
    setBusy(true); setSourceError('');
    try {
      const current = await request(path + '/sources', pluginView, { csrf, body: command, timeoutMs: 100_000 });
      if (mounted.current) setView(current);
      return true;
    } catch (reason) {
      if (mounted.current) {
        if (reason instanceof RequestError && reason.status === 401) onReport.current(reason);
        setSourceError(reason instanceof RequestError && Object.hasOwn(sourceErrors, reason.code) ? sourceErrors[reason.code]! :
          '暂时无法确认来源是否已更新。请刷新市场后核对。');
      }
      return false;
    } finally {
      if (mounted.current) { setBusy(false); setRevision(value => value + 1); }
    }
  }

  async function checkUpdates() {
    if (busy || checking) return;
    setChecking(true); setError('');
    try {
      const current = await request(path + '/check-updates', pluginView, { csrf, body: {}, timeoutMs: 100_000 });
      if (mounted.current) setView(current);
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof RequestError && reason.status === 401) onReport.current(reason);
      setError('暂时无法检查更新，请稍后重试。');
    } finally {
      if (mounted.current) setChecking(false);
    }
  }

  return <PluginLibrary harness={harness} onHarness={onHarness} view={view} error={error} sourceError={sourceError}
    busy={busy || checking} checking={checking} uncertain={!!uncertain}
    detail={selectedEntry && detail?.id === selectedEntry.id ? { ...selectedEntry, skills: detail.skills } : undefined}
    onRefresh={() => { setError(''); setSourceError(''); setRevision(value => value + 1); }}
    onDetail={setDetailId} onSource={changeSource}
    onCheckUpdates={harness === 'codex' ? () => void checkUpdates() : undefined}
    onAction={(entry, action, version) => void update({ id: crypto.randomUUID(), pluginId: entry.id, action,
      version: action === 'update' ? entry.update?.version : version, revision: action === 'update' ? entry.update?.revision : undefined })}
    onReconcile={() => { if (view?.operation) void update({ id: view.operation.id }, true); }}
    onRetry={() => { if (uncertain) void update(uncertain); }}/>;
}

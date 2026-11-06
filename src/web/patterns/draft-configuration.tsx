import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Popover } from 'radix-ui';
import { ArrowLeft, Check, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import './draft-configuration.css';

// Presentation inputs only. Catalogs must be validated by the calling feature;
// this component renders text, holds no credentials and performs no requests.
export type DraftConfigurationValue = { modelId: string; permissionId: string; reasoningEffort?: string };
export type DraftConfigurationCatalog = {
  id: 'codex' | 'dsh'; available: boolean; reason?: string; defaultModelId?: string;
  models: { id: string; label: string; reasoningEfforts?: { id: string; label: string }[]; defaultReasoningEffort?: string }[];
  permissions: { id: string; label: string; description: string }[];
};
export type DraftConfigurationProps = {
  catalogs: DraftConfigurationCatalog[];
  harnessId: 'codex' | 'dsh';
  configuration: DraftConfigurationValue;
  disabled?: boolean;
  onPowerChange(id: 'codex' | 'dsh'): void;
  onConfigurationChange(configuration: DraftConfigurationValue): void;
};
const powerLabel = (id: 'codex' | 'dsh') => id === 'codex' ? 'Codex' : 'DSH';
const effortNames: Record<string, string> = { none: '关闭', off: '关闭', minimal: '最少', low: '轻量', medium: '均衡', high: '深入', xhigh: '更深入', max: '最高', ultra: '极致' };
const readableEffort = (id: string, label: string) => effortNames[id.toLowerCase()] ?? label;

/** Caller owns per-Power preferences, persistence and submission boundaries. */
export function DraftConfiguration({ catalogs, harnessId, configuration, disabled = false, onPowerChange, onConfigurationChange }: DraftConfigurationProps) {
  const catalog = catalogs.find(item => item.id === harnessId);
  const model = catalog?.models.find(item => item.id === configuration.modelId);
  const permission = catalog?.permissions.find(item => item.id === configuration.permissionId);
  const efforts = model?.reasoningEfforts ?? [];
  const effortIndex = efforts.findIndex(item => item.id === configuration.reasoningEffort);
  const effort = effortIndex >= 0 ? efforts[effortIndex] : undefined;
  const defaultModel = catalog?.models.find(item => item.id === catalog.defaultModelId);
  const defaultEffort = defaultModel?.reasoningEfforts?.find(item => item.id === defaultModel.defaultReasoningEffort);
  const canReset = !!catalog?.available && !!defaultModel && (!defaultModel.reasoningEfforts?.length || !!defaultEffort);
  const modelUnavailable = !!configuration.modelId && !model;
  const effortUnavailable = !!configuration.reasoningEffort && !effort && !!model;
  const [modelOpen, setModelOpen] = useState(false);
  const [modelList, setModelList] = useState(false);
  const modelHeading = useRef<HTMLButtonElement>(null);
  const modelOptions = useRef<HTMLDivElement>(null);
  const switchedView = useRef(false);
  const descriptionId = useId();
  const errorId = useId();

  useEffect(() => { setModelOpen(false); setModelList(false); }, [harnessId, disabled]);
  useEffect(() => {
    if (!modelOpen || !switchedView.current) return;
    (modelList ? modelOptions.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') : modelHeading.current)?.focus();
    switchedView.current = false;
  }, [modelList, modelOpen]);
  function showModels(value: boolean) { switchedView.current = true; setModelList(value); }
  function setModel(id: string) {
    const selected = catalog?.models.find(item => item.id === id);
    if (disabled || !catalog?.available || !selected) return;
    const nativeDefault = selected.reasoningEfforts?.find(item => item.id === selected.defaultReasoningEffort);
    onConfigurationChange({ modelId: selected.id, permissionId: configuration.permissionId, ...(nativeDefault ? { reasoningEffort: nativeDefault.id } : {}) });
    showModels(false);
  }
  function reset() { if (!disabled && canReset && defaultModel) setModel(defaultModel.id); }
  function setEffort(index: number) {
    const selected = efforts[index];
    if (disabled || !catalog?.available || !model || !selected) return;
    onConfigurationChange({ ...configuration, reasoningEffort: selected.id });
  }
  const effortSummary = effort?.id ?? (efforts.length ? '选择深度' : configuration.reasoningEffort ? '档位不可用' : '');
  const atDefault = canReset && defaultModel?.id === model?.id && configuration.reasoningEffort === defaultEffort?.id;
  return <div className="draft-configuration" aria-label="新对话配置">
    <Popover.Root>
      <Popover.Trigger asChild><button type="button" className="draft-config-trigger draft-power-trigger" aria-label="选择 Agent Power" disabled={disabled} data-invalid={!catalog?.available || undefined}>{powerLabel(harnessId)}<ChevronDown size={11}/></button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="draft-config-menu" side="top" align="start" sideOffset={8} collisionPadding={12} aria-label="Agent Power">
        <span className="draft-config-caption">Agent Power</span>
        {catalogs.map(item => <Popover.Close asChild key={item.id}><button type="button" className="draft-config-option" aria-pressed={item.id === harnessId} disabled={disabled || !item.available} onClick={() => onPowerChange(item.id)}>
          <span>{powerLabel(item.id)}{!item.available && <small>{item.reason ?? '暂不可用'}</small>}</span>{item.id === harnessId && <Check size={13}/>}</button></Popover.Close>)}
        {!catalogs.length && <p className="draft-config-note">尚未连接可用的 Power。</p>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    <Popover.Root open={modelOpen} onOpenChange={open => { setModelOpen(open); setModelList(false); switchedView.current = false; }}>
      <Popover.Trigger asChild><button type="button" className="draft-config-trigger draft-model-trigger" aria-label="模型与思考深度" disabled={disabled} data-invalid={modelUnavailable || effortUnavailable || undefined} title={model?.label ?? (configuration.modelId || '选择模型')}>
        <span className="draft-model-summary">{model?.label ?? (configuration.modelId ? '模型不可用' : '选择模型')}</span>{effortSummary && <span className="draft-effort-summary">{effortSummary}</span>}<ChevronDown size={11}/>
      </button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="draft-model-panel" side="top" align="start" sideOffset={8} collisionPadding={12} aria-label="模型与思考深度">
        {modelList ? <>
          <div className="draft-model-heading"><button type="button" className="draft-config-back" aria-label="返回思考深度" onClick={() => showModels(false)}><ArrowLeft size={15}/></button><span>选择模型</span><small>{powerLabel(harnessId)}</small></div>
          <div className="draft-model-options" ref={modelOptions}>
            <button type="button" className="draft-config-option" disabled={disabled || !canReset} onClick={reset}><span>默认<small>{canReset ? '采用此 Power 的原生默认配置' : '未提供可靠默认，请明确选择'}</small></span>{atDefault && <Check size={13}/>}</button>
            {catalog?.models.map(item => <button type="button" className="draft-config-option" key={item.id} aria-pressed={item.id === model?.id} disabled={disabled || !catalog.available} onClick={() => setModel(item.id)}><span>{item.label}</span>{item.id === model?.id && <Check size={13}/>}</button>)}
            {!catalog?.models.length && <p className="draft-config-note">暂无可用模型。</p>}
          </div>
        </> : <>
          <button className="draft-config-reset" type="button" aria-label="恢复默认模型与深度" title={canReset ? '恢复当前 Power 的原生默认模型与深度' : '原生未提供可靠默认，请明确选择'} disabled={disabled || !canReset} onClick={reset}><RotateCcw size={14}/></button>
          <div className="draft-effort-value">{effort ? readableEffort(effort.id, effort.label) : efforts.length ? '选择深度' : model ? '模型设置' : '选择模型'}</div>
          <button ref={modelHeading} type="button" className="draft-model-link" aria-label="选择模型" onClick={() => showModels(true)} disabled={disabled}><span>{model?.label ?? (configuration.modelId ? '原模型不可用' : '请选择模型')}</span><ChevronRight size={13}/></button>
          {!catalog?.available && <p className="draft-config-note" role="status">{catalog?.reason ?? '当前 Power 不可用'}</p>}
          {(modelUnavailable || effortUnavailable) && <p id={errorId} className="draft-config-error" role="status">原配置已不可用，请重新选择；不会自动替换。</p>}
          {model && efforts.length > 0 && <>
            <div className="draft-effort-slider" data-unselected={effortIndex < 0 || undefined} style={{ '--effort-progress': `${Math.max(0, effortIndex) / Math.max(1, efforts.length - 1) * 100}%` } as CSSProperties}>
              <div className="draft-effort-track"/><div className="draft-effort-dots" aria-hidden="true">{efforts.map(item => <i key={item.id}/>)}</div>
              <input type="range" aria-label="思考深度档位" aria-valuetext={effort ? `${effort.id}：${effort.label}` : '尚未选择，请调节滑杆'} aria-describedby={descriptionId} aria-invalid={effortIndex < 0 || undefined} min={0} max={Math.max(0, efforts.length - 1)} step={1} value={Math.max(0, effortIndex)} disabled={disabled || !catalog?.available} onChange={event => setEffort(Number(event.currentTarget.value))} onPointerUp={event => setEffort(Number(event.currentTarget.value))} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setEffort(Number(event.currentTarget.value)); } }}/>
            </div>
            <div className="draft-effort-captions"><span>更快</span><span>更深入</span></div>
            <p id={descriptionId} className={effort ? 'sr-only' : 'draft-config-note'}>{effort ? effort.label : '请点击或调节滑杆选择深度。'}</p>
          </>}
          {model && !efforts.length && <p className="draft-config-note">此模型没有可选思考深度。</p>}
        </>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    <Popover.Root>
      <Popover.Trigger asChild><button type="button" className="draft-config-trigger draft-permission-trigger" aria-label="执行权限" disabled={disabled} data-invalid={!!configuration.permissionId && !permission || undefined}>{permission?.label ?? (configuration.permissionId ? '权限不可用' : '选择权限')}<ChevronDown size={11}/></button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="draft-config-menu draft-permission-menu" side="top" align="start" sideOffset={8} collisionPadding={12} aria-label="执行权限">
        <span className="draft-config-caption">执行权限</span>
        {catalog?.permissions.map(item => <Popover.Close asChild key={item.id}><button type="button" className="draft-config-option" disabled={disabled || !catalog.available} aria-pressed={item.id === permission?.id} onClick={() => onConfigurationChange({ ...configuration, permissionId: item.id })}><span>{item.label}<small>{item.description}</small></span>{item.id === permission?.id && <Check size={13}/>}</button></Popover.Close>)}
        {!catalog?.permissions.length && <p className="draft-config-note">暂无可用权限配置。</p>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </div>;
}

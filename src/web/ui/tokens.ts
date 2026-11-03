/** Authored design values. theme.css is generated; Motion uses the same timing source. */
export const timing = { response: 140, state: 180, surface: 260, activity: 1000, breathing: 1600, ease: [0.22, 1, 0.36, 1] as const };
export const tokens: Record<string, string> = {
  'font-interface': '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
  'font-reading': '"Songti SC", "STSong", Georgia, serif',
  'font-code': '"SFMono-Regular", Consolas, monospace',
  'type-micro': '10px', 'type-caption': '11px', 'type-code': '13px', 'type-input': '16px', 'type-section': '18px', 'type-display': '28px', 'type-control': '12px', 'type-interface': '14px', 'type-body': '15px', 'type-title': '24px',
  'line-control': '1.4', 'line-body': '1.85',
  'space-1': '4px', 'space-2': '8px', 'space-3': '12px', 'space-4': '16px', 'space-5': '20px', 'space-6': '24px', 'space-8': '32px', 'space-10': '40px',
  'control-compact': '32px', 'control-default': '36px', 'control-touch': '44px',
  'neutral-0': '#ffffff', 'neutral-25': '#fcfcfb', 'neutral-50': '#f5f5f4', 'neutral-100': '#eeeff0',
  'neutral-150': '#e6e7e9', 'neutral-200': '#dcdfe3', 'neutral-300': '#bec4ce', 'neutral-400': '#8a919d',
  'neutral-500': '#727985', 'neutral-600': '#606773', 'neutral-800': '#434b59', 'neutral-900': '#303640',
  'surface': 'var(--zs-neutral-0)', 'canvas': 'var(--zs-neutral-25)', 'sidebar': 'var(--zs-neutral-50)',
  'surface-subtle': 'var(--zs-neutral-50)', 'surface-hover': 'var(--zs-neutral-100)', 'surface-selected': 'var(--zs-neutral-150)',
  'text': 'var(--zs-neutral-900)', 'text-body': '#505660', 'text-secondary': 'var(--zs-neutral-600)', 'text-muted': 'var(--zs-neutral-500)',
  'text-placeholder': 'var(--zs-neutral-400)', 'line': '#e9e9e8', 'border': 'var(--zs-neutral-200)',
  'focus': '#8290a5', 'focus-ring': '#7c8ea41a', 'selection': '#dde3eb',
  'action': 'var(--zs-neutral-800)', 'action-hover': 'var(--zs-neutral-900)', 'action-text': 'var(--zs-neutral-0)',
  'danger': '#a44742', 'danger-surface': '#fcf2f0', 'warning': '#8a6940', 'warning-surface': '#faf6ed', 'success': '#4a735e',
  'radius-control': '7px', 'radius-item': '9px', 'radius-surface': '18px',
  'shadow-input': '0 1px 2px #202b3a04, 0 5px 18px #202b3a05, 0 12px 32px #202b3a03',
  'shadow-overlay': '0 12px 48px #202b3a18, 0 2px 8px #202b3a08', 'scrim': '#20263133',
  'reading-width': '800px', 'header-height': '72px', 'layer-overlay': '40', 'layer-dialog': '50', 'layer-popover': '60',
};
export function themeCss() {
  const values = { ...tokens, 'duration-response': `${timing.response}ms`, 'duration-state': `${timing.state}ms`, 'duration-surface': `${timing.surface}ms`, 'duration-activity': `${timing.activity}ms`, 'duration-breathing': `${timing.breathing}ms`, 'ease': `cubic-bezier(${timing.ease.join(',')})` };
  return `/* Generated from tokens.ts. */\n:root {\n${Object.entries(values).map(([key, value]) => `  --zs-${key}: ${value};`).join('\n')}\n}\n`;
}

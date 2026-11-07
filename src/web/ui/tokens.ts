/**
 * Authored design values ("precision tool": cool white, high contrast, one indigo accent, coloured status).
 * theme.css is generated from this file (`npm run tokens`); Motion reads the same timing source.
 * Components use semantic names only, so a dark theme can later redefine the semantic layer without touching them.
 */
export const timing = { response: 120, state: 180, surface: 260, activity: 800, breathing: 1600, ease: [0.2, 0.8, 0.2, 1] as const };

const palette = {
  'neutral-0': '#ffffff', 'neutral-25': '#fbfbfc', 'neutral-50': '#f7f7f8', 'neutral-100': '#f1f1f3',
  'neutral-150': '#ebebee', 'neutral-200': '#e6e6e9', 'neutral-250': '#d8d8dd', 'neutral-300': '#c4c5ca',
  'neutral-400': '#a1a4aa', 'neutral-500': '#6b6f76', 'neutral-600': '#55595f', 'neutral-700': '#3c3f45',
  'neutral-800': '#26282c', 'neutral-900': '#0f1011',
  'indigo-50': '#eef0fb', 'indigo-200': '#c8ccf1', 'indigo-500': '#5e6ad2', 'indigo-600': '#535fc8', 'indigo-700': '#4852ba',
  'blue-500': '#3b82f6', 'green-600': '#1f9d63', 'red-500': '#e5484d', 'red-700': '#c4373c', 'amber-500': '#f59e0b', 'orange-500': '#e08a1e', 'gray-450': '#8b8f97',
};

const semantic = {
  // Type
  'font-interface': '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  'font-reading': 'var(--zs-font-interface)',
  'font-code': '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
  'type-micro': '11px', 'type-caption': '12px', 'type-control': '13px', 'type-interface': '14px', 'type-body': '15px',
  'type-reading': '15px', 'type-code': '12.5px', 'type-input': '15px', 'type-section': '16px', 'type-title': '20px', 'type-display': '26px',
  'line-control': '1.45', 'line-body': '1.72', 'line-input': '1.6',
  // Space and size
  'space-1': '4px', 'space-2': '8px', 'space-3': '12px', 'space-4': '16px', 'space-5': '20px', 'space-6': '24px', 'space-8': '32px', 'space-10': '40px',
  'control-compact': '28px', 'control-default': '32px', 'control-primary': '36px', 'control-touch': '44px',
  'radius-small': '5px', 'radius-control': '7px', 'radius-item': '10px', 'radius-action': '8px', 'radius-surface': '14px',
  'reading-width': '720px', 'header-height': '48px', 'sidebar-width': '264px',
  // Surfaces
  'surface': 'var(--zs-neutral-0)', 'canvas': 'var(--zs-neutral-0)', 'sidebar': 'var(--zs-neutral-50)',
  'surface-subtle': '#f4f4f5', 'surface-input': 'var(--zs-neutral-0)', 'surface-hover': 'rgba(15,16,17,.045)', 'surface-press': 'rgba(15,16,17,.08)',
  'surface-selected': 'var(--zs-neutral-150)', 'surface-drop': 'var(--zs-indigo-50)', 'surface-inverse': 'var(--zs-neutral-900)',
  // Text
  'text': 'var(--zs-neutral-900)', 'text-primary': 'var(--zs-neutral-900)', 'text-body': 'var(--zs-neutral-700)',
  'text-secondary': 'var(--zs-neutral-700)', 'text-tertiary': 'var(--zs-neutral-500)', 'text-muted': 'var(--zs-neutral-500)',
  'text-placeholder': 'var(--zs-neutral-400)', 'text-inverse': 'var(--zs-neutral-0)',
  // Lines
  'line': 'var(--zs-neutral-200)', 'border': 'var(--zs-neutral-200)', 'border-default': 'var(--zs-neutral-200)',
  'border-strong': 'var(--zs-neutral-250)', 'border-hover': 'var(--zs-neutral-300)', 'border-focus': 'var(--zs-indigo-500)',
  // Accent and actions
  'accent': 'var(--zs-indigo-500)', 'accent-hover': 'var(--zs-indigo-600)', 'accent-press': 'var(--zs-indigo-700)',
  'accent-soft': 'var(--zs-indigo-50)', 'accent-line': 'var(--zs-indigo-200)', 'accent-text': 'var(--zs-indigo-700)',
  'action': 'var(--zs-indigo-500)', 'action-hover': 'var(--zs-indigo-600)', 'action-text': 'var(--zs-neutral-0)',
  'action-primary': 'var(--zs-indigo-500)', 'action-primary-hover': 'var(--zs-indigo-600)', 'action-on-primary': 'var(--zs-neutral-0)',
  'action-disabled': 'var(--zs-neutral-150)', 'action-on-disabled': 'var(--zs-neutral-400)',
  'focus': 'var(--zs-indigo-500)', 'focus-ring': 'rgba(94,106,210,.22)', 'ring-focus': '0 0 0 3px var(--zs-focus-ring)', 'selection': '#dfe2f8',
  // Status (one meaning each; see StatusDot)
  'status-running': 'var(--zs-blue-500)', 'status-unread': 'var(--zs-green-600)', 'status-failed': 'var(--zs-red-500)',
  'status-waiting': 'var(--zs-amber-500)', 'status-unknown': 'var(--zs-orange-500)', 'status-interrupted': 'var(--zs-gray-450)',
  'success': 'var(--zs-green-600)', 'danger': 'var(--zs-red-700)', 'danger-solid': 'var(--zs-red-500)', 'danger-surface': '#fdeeee',
  'warning': '#a86512', 'warning-surface': '#fef6e7',
  // Elevation
  'shadow-input': '0 1px 2px rgba(15,16,17,.04), 0 0 0 1px rgba(15,16,17,.02)',
  'shadow-overlay': '0 0 0 1px rgba(15,16,17,.07), 0 12px 28px -10px rgba(15,16,17,.2), 0 2px 6px rgba(15,16,17,.05)',
  'shadow-modal': '0 0 0 1px rgba(15,16,17,.08), 0 28px 70px -16px rgba(15,16,17,.32)',
  'elevation-control': '0 1px 2px rgba(15,16,17,.05)', 'elevation-input': '0 1px 2px rgba(15,16,17,.04)',
  'elevation-input-focus': '0 0 0 3px var(--zs-focus-ring)', 'elevation-action': '0 1px 2px rgba(15,16,17,.12)', 'elevation-neutral': 'none',
  'scrim': 'rgba(15,16,17,.28)',
  // Layers
  'layer-overlay': '40', 'layer-dialog': '50', 'layer-popover': '60', 'layer-toast': '70',
};

export const tokens: Record<string, string> = { ...palette, ...semantic };

export function themeCss() {
  const values = { ...tokens, 'duration-response': `${timing.response}ms`, 'duration-state': `${timing.state}ms`, 'duration-surface': `${timing.surface}ms`,
    'duration-activity': `${timing.activity}ms`, 'duration-breathing': `${timing.breathing}ms`, 'ease': `cubic-bezier(${timing.ease.join(',')})`,
    'ease-settle': 'cubic-bezier(.65,0,.35,1)' };
  return `/* Generated from tokens.ts. */\n:root {\n${Object.entries(values).map(([key, value]) => `  --zs-${key}: ${value};`).join('\n')}\n}\n` +
    `@media (prefers-reduced-motion: reduce) {\n  :root { --zs-duration-response: 1ms; --zs-duration-state: 1ms; --zs-duration-surface: 1ms; }\n}\n`;
}

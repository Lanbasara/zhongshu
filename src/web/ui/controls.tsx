import type { ButtonHTMLAttributes, ComponentPropsWithRef, ReactNode } from 'react';
import { DropdownMenu, Popover, Tooltip } from 'radix-ui';
import { ChevronDown } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export function Button({ variant = 'secondary', size, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'small' }) {
  return <button type="button" {...props} className={`zs-button zs-button-${variant}${size ? ` zs-button-${size}` : ''} ${className}`}/>;
}
export function IconButton({ label, tooltip = label, shortcut, children, className = '', ...props }: ComponentPropsWithRef<'button'> & { label: string; tooltip?: string; shortcut?: string[]; children: ReactNode }) {
  return <Tooltip.Root><Tooltip.Trigger asChild><button type="button" {...props} aria-label={label} className={`zs-icon ${className}`}>{children}</button></Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content className="zs-tooltip" sideOffset={6} collisionPadding={8}>{tooltip}{shortcut && <Kbd keys={shortcut}/>}</Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}
export function Menu({ label, trigger, children, disabled, align = 'start', className = 'zs-icon' }: { label: string; trigger: ReactNode; children: ReactNode; disabled?: boolean; align?: 'start' | 'end'; className?: string }) {
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className={className} aria-label={label} disabled={disabled}>{trigger}</button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="zs-menu" align={align} sideOffset={6} collisionPadding={12}>{children}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>;
}
export function MenuItem({ children, onSelect, disabled, tone }: { children: ReactNode; onSelect(): void; disabled?: boolean; tone?: 'danger' }) {
  return <DropdownMenu.Item className={`zs-menu-item${tone ? ` is-${tone}` : ''}`} disabled={disabled} onSelect={onSelect}>{children}</DropdownMenu.Item>;
}
export function MenuSeparator() { return <DropdownMenu.Separator className="zs-menu-separator"/>; }
export function Information({ label, summary, children }: { label: string; summary: ReactNode; children: ReactNode }) {
  return <Popover.Root><Popover.Trigger asChild><button className="zs-information-trigger" type="button" aria-label={label}>{summary}<ChevronDown size={12}/></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="zs-popover" side="top" align="start" sideOffset={8} collisionPadding={12}><strong>{label}</strong>{children}</Popover.Content></Popover.Portal></Popover.Root>;
}
/** The "bars" mark confirmed on 2026-11-07; the same drawing as public/icon.svg. */
export function BrandMark({ size = 20 }: { size?: number }) {
  return <svg className="zs-mark" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
    <g transform="skewY(-14) translate(0 3)"><rect x="4" y="6" width="3.6" height="13" rx="1.2"/><rect x="10.2" y="3" width="3.6" height="18" rx="1.2"/>
      <rect x="16.4" y="5" width="3.6" height="15" rx="1.2" className="zs-mark-open"/></g>
  </svg>;
}
export type StatusKind = 'running' | 'waiting' | 'unread' | 'failed' | 'unknown' | 'interrupted' | 'idle';
/** One status, one shape and colour: spinner, solid dot or open ring. Idle renders an empty slot so rows stay aligned. */
export function StatusDot({ status, label }: { status: StatusKind; label?: string }) {
  return <span className="zs-status" data-status={status} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}><i/></span>;
}
export function Kbd({ keys }: { keys: string[] }) {
  return <span className="zs-kbd" aria-hidden="true">{keys.map(key => <kbd key={key}>{key}</kbd>)}</span>;
}
export const modifierKey = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

import type { ButtonHTMLAttributes, ComponentPropsWithRef, ReactNode } from 'react';
import { DropdownMenu, Popover, Tooltip } from 'radix-ui';
import { ChevronDown } from 'lucide-react';

export function Button({ variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' }) {
  return <button type="button" {...props} className={`zs-button zs-button-${variant} ${className}`}/>;
}
export function IconButton({ label, children, className = '', ...props }: ComponentPropsWithRef<'button'> & { label: string; children: ReactNode }) {
  return <Tooltip.Root><Tooltip.Trigger asChild><button type="button" {...props} aria-label={label} className={`zs-icon ${className}`}>{children}</button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="zs-tooltip" sideOffset={7}>{label}</Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}
export function Menu({ label, trigger, children, disabled }: { label: string; trigger: ReactNode; children: ReactNode; disabled?: boolean }) {
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className="zs-icon" aria-label={label} disabled={disabled}>{trigger}</button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="zs-menu" align="start" sideOffset={8} collisionPadding={12}>{children}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>;
}
export function MenuItem({ children, onSelect, disabled }: { children: ReactNode; onSelect(): void; disabled?: boolean }) {
  return <DropdownMenu.Item className="zs-menu-item" disabled={disabled} onSelect={onSelect}>{children}</DropdownMenu.Item>;
}
export function Information({ label, summary, children }: { label: string; summary: ReactNode; children: ReactNode }) {
  return <Popover.Root><Popover.Trigger asChild><button className="zs-information-trigger" type="button" aria-label={label}>{summary}<ChevronDown size={12}/></button></Popover.Trigger><Popover.Portal><Popover.Content className="zs-popover" side="top" align="start" sideOffset={10} collisionPadding={12}><strong>{label}</strong>{children}</Popover.Content></Popover.Portal></Popover.Root>;
}
export function BrandMark() { return <span className="zs-mark" aria-hidden="true"><i/><i/><i/></span>; }

import type { KeyboardEvent } from 'react';

/**
 * Makes a clickable row or card reachable by keyboard: Tab focuses it, Enter or Space activates it (runs its
 * onClick). Spread onto the element next to its onClick: <div onClick={…} {...pressable}>.
 */
export const pressable = {
  role: 'button',
  tabIndex: 0,
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || e.repeat) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.currentTarget.click();
    }
  },
} as const;

/** True when keyboard focus is on a control that handles Enter/Space/Tab itself. */
export function isInteractive(el: Element | null): boolean {
  if (!el || el === document.body) return false;
  return !!el.closest('button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [tabindex]:not([tabindex="-1"])');
}

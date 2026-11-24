import type { ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * Shared pieces of the app's editor look (the Motion builder inspector, Animate › Cleanup, …):
 * a tinted icon tile, and an on/off option as a switch card that says what it does.
 * Styles: `.ed-*` in styles.css.
 */

export function IconTile({ name, size = 14 }: { name: string; size?: number }) {
  return (
    <span className="ed-icon">
      <Icon name={name} size={size} />
    </span>
  );
}

export function SwitchCard(props: { on: boolean; label: ReactNode; hint?: ReactNode; title?: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={`ed-option ${props.on ? 'on' : ''}`}
      aria-pressed={props.on}
      disabled={props.disabled}
      title={props.title}
      onClick={() => props.onChange(!props.on)}
    >
      <span className={`switch ${props.on ? 'on' : ''}`}>
        <span />
      </span>
      <span className="ed-option-text">
        <b>{props.label}</b>
        {props.hint && <span>{props.hint}</span>}
      </span>
    </button>
  );
}

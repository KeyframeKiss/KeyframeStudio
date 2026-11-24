import type { ReactNode } from 'react';
import { Help } from './Help';
import { Icon } from './Icon';

/**
 * Shared pieces of the app's editor look (the Motion builder inspector, Animate › Cleanup, …):
 * a tinted icon tile, and an on/off option as a switch card. Explanations go in a "?" (Help), not on screen.
 * Styles: `.ed-*` in styles.css.
 */

export function IconTile({ name, size = 14 }: { name: string; size?: number }) {
  return (
    <span className="ed-icon">
      <Icon name={name} size={size} />
    </span>
  );
}

export function SwitchCard(props: { on: boolean; label: ReactNode; help?: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className={`ed-option ${props.on ? 'on' : ''} ${props.disabled ? 'off' : ''}`}>
      <button type="button" className="ed-option-btn" aria-pressed={props.on} disabled={props.disabled} onClick={() => props.onChange(!props.on)}>
        <span className={`switch ${props.on ? 'on' : ''}`}>
          <span />
        </span>
        <b>{props.label}</b>
      </button>
      {props.help && <Help text={props.help} />}
    </div>
  );
}

import type { ReactNode } from 'react';
import { Help } from './Help';
import { Icon } from './Icon';

/**
 * The app's shared building blocks (see the UI vision): an icon tile, a switch card, a list row, an empty state and
 * a status chip. Pages are built from these and the field / section components in Page.tsx; numbers are edited
 * with DragNumber (drag to scrub, click to type). Explanations go in a "?" (Help), not on screen.
 * Styles: `.ed-*` in styles.css, all from the design tokens.
 */

/** A tinted square with an icon; `kind` colours it by what the thing is (clip, pose, light, rig…). */
export function IconTile({ name, size = 14, kind }: { name: string; size?: number; kind?: string }) {
  return (
    <span className="ed-icon" style={kind ? ({ ['--kind' as string]: `var(--kind-${kind})` } as React.CSSProperties) : undefined}>
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

/** One thing in a list (a rig, a light, a clip…): its tile, name and sub-line, then its controls on the right. */
export function ListRow(props: { icon: string; kind?: string; title: ReactNode; sub?: ReactNode; off?: boolean; children?: ReactNode }) {
  return (
    <div className={`ed-row ${props.off ? 'off' : ''}`}>
      <IconTile name={props.icon} kind={props.kind} />
      <div className="ed-title">
        <b>{props.title}</b>
        {props.sub != null && <span className="sub">{props.sub}</span>}
      </div>
      <span className="spacer" />
      {props.children}
    </div>
  );
}

/** What will appear here and how to start: a title, a short line, and the first action as a button. */
export function EmptyState(props: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ed-empty">
      <b>{props.title}</b>
      {props.children && <span>{props.children}</span>}
      {props.action}
    </div>
  );
}

/** Something running or taking something over, always with a way out (Stop, Cancel…). */
export function StatusChip(props: { icon?: string; children: ReactNode; action?: ReactNode; title?: string }) {
  return (
    <span className="ed-chip" title={props.title}>
      {props.icon && <Icon name={props.icon} size={12} />}
      {props.children}
      {props.action}
    </span>
  );
}

import { useRef, useState } from 'react';

/**
 * A number you can drag or type: drag sideways to change it (Shift = fine, Ctrl = coarse), click to type, Enter to
 * keep, Esc to cancel; ↑ / ↓ nudge it while it has focus. While dragging, onPreview gets every value and onCommit the
 * last one once — so a drag is one change.
 */
export function DragNumber(props: {
  value: number;
  step: number;
  digits?: number;
  unit?: string;
  label?: string;
  color?: string;
  min?: number;
  max?: number;
  title?: string;
  onPreview?: (v: number, first: boolean) => void;
  onCommit: (v: number) => void;
}) {
  const { value, step, digits = 3, unit = '', label, color, min = -Infinity, max = Infinity } = props;
  const [text, setText] = useState<string | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const drag = useRef<{ x0: number; v0: number; moved: boolean; first: boolean; last: number } | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const round = (v: number) => Number(v.toFixed(Math.max(digits, 0) + 1));
  const shown = live ?? value;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (text !== null || e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x0: e.clientX, v0: value, moved: false, first: true, last: value };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const k = e.shiftKey ? 0.1 : e.ctrlKey ? 10 : 1;
    const v = clamp(round(d.v0 + dx * step * k));
    if (v === d.last) return;
    d.last = v;
    setLive(v);
    props.onPreview?.(v, d.first);
    d.first = false;
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      setText(String(Number(value.toFixed(digits))));
      return;
    }
    setLive(null);
    if (d.last !== d.v0) props.onCommit(d.last);
  };
  const commitText = () => {
    if (text === null) return;
    const n = Number(text.replace(',', '.').replace(/[^\d.eE+\-]/g, ''));
    setText(null);
    if (Number.isFinite(n) && n !== value) props.onCommit(clamp(n));
  };

  return (
    <div
      className={`dragnum ${live !== null ? 'dragging' : ''}`}
      style={color ? ({ '--dn-color': color } as React.CSSProperties) : undefined}
      title={props.title ?? 'Drag sideways to change (Shift fine, Ctrl coarse) · click to type'}
    >
      {label && <span className="dn-label">{label}</span>}
      {text !== null ? (
        <input
          className="dn-input"
          autoFocus
          value={text}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setText(null);
          }}
        />
      ) : (
        <div
          className="dn-value"
          tabIndex={0}
          role="spinbutton"
          aria-valuenow={shown}
          aria-label={label}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setText(String(Number(value.toFixed(digits))));
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const k = (e.shiftKey ? 1 : e.ctrlKey ? 100 : 10) * step;
              props.onCommit(clamp(round(value + (e.key === 'ArrowUp' ? k : -k))));
            }
          }}
        >
          {shown.toFixed(digits)}
          {unit}
        </div>
      )}
    </div>
  );
}

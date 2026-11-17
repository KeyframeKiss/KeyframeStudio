import { useState } from 'react';
import { liveTime, seek, useStore } from '../state/store';
import { formatTime, parseTime } from '../lib/time';
import { useAnimationFrame } from './useAnimationFrame';

export function TimeField() {
  const tl = useStore((s) => (s.tl ? s.tl.fps : null)); // fps only: the time is read per frame below
  const [editing, setEditing] = useState<string | null>(null);
  const [display, setDisplay] = useState('00:00.00  ·  f0');
  useAnimationFrame(() => {
    if (editing === null && tl != null) {
      const txt = formatTime(liveTime(), tl);
      setDisplay((d) => (d === txt ? d : txt));
    }
  });
  return (
    <input
      className="input time"
      value={editing ?? display}
      title="Current time — type 1.5, 0:01.5 or f90 and press Enter"
      disabled={tl == null}
      onFocus={(e) => {
        setEditing(liveTime().toFixed(3));
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setEditing(e.target.value)}
      onBlur={() => setEditing(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const t = parseTime(editing ?? '', tl ?? 60);
          if (t != null) seek(t);
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function NumberField(props: {
  value: number;
  disabled?: boolean;
  width?: number;
  format: (v: number) => string;
  parse: (s: string) => number | null;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className="input mono small"
      style={props.width ? { width: props.width } : undefined}
      disabled={props.disabled}
      value={text ?? props.format(props.value)}
      onFocus={(e) => {
        setText(String(props.value));
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text != null) {
          const v = props.parse(text);
          if (v != null && v !== props.value) props.onCommit(v);
        }
        setText(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(null);
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}

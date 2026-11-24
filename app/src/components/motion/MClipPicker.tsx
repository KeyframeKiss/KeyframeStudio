import { useEffect, useMemo, useState } from 'react';
import { call } from '../../state/store';
import { pressable } from '../../lib/pressable';

export interface MClipItem {
  file: string;
  name: string;
  length: number;
  source?: string;
  sourceType?: string;
  thumb?: string;
  tracks?: number;
}

/** Pick a saved Motion clip (the Motion builder's clip shelf) for the Motion builder. */
export function MClipPicker({ title, onPick, onClose }: { title: string; onPick: (c: MClipItem) => void; onClose: () => void }) {
  const [clips, setClips] = useState<MClipItem[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    call<MClipItem[]>('clips.list').then((c) => setClips(c ?? []));
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    // only character clips carry bone keys
    return (clips ?? []).filter((c) => (c.sourceType ?? 'Char') === 'Char').filter((c) => !s || `${c.name} ${c.source ?? ''}`.toLowerCase().includes(s));
  }, [clips, q]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog mo-pose-picker" onClick={(e) => e.stopPropagation()}>
        <div className="mo-picker-head">
          <h2>{title}</h2>
          <input className="input" autoFocus placeholder="Search motion clips…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="mo-pose-grid">
          {!clips && <div className="empty">Loading motion clips…</div>}
          {clips && !list.length && (
            <div className="empty">{clips.length ? `No character clips match “${q}”.` : 'No motion clips saved yet — open Clips beside the lanes, select keys in the timeline and save them as a clip.'}</div>
          )}
          {list.map((c) => (
            <div {...pressable} key={c.file} className="mo-pose" onClick={() => onPick(c)} title={`${c.name}\n${c.length.toFixed(2)} s · from ${c.source ?? '?'}\nClick to add`}>
              {c.thumb ? <img src={c.thumb} alt="" /> : <span className="mo-pose-ph" />}
              <span className="name">{c.name}</span>
              <span className="sub">{c.length.toFixed(2)} s</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

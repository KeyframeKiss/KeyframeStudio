import { useEffect, useMemo, useState } from 'react';
import { call, displayName } from '../../state/store';
import { pressable } from '../../lib/pressable';

export interface PoseItem {
  path: string;
  name: string;
  nameEn?: string;
  thumb?: string;
  png?: boolean;
  folder?: string;
  favorite?: boolean;
}

const canThumb = !!window.studioEx?.isElectron;

/** Pick a pose from the pose library (for the Motion builder). */
export function PosePicker({ title, onPick, onClose }: { title: string; onPick: (p: PoseItem) => void; onClose: () => void }) {
  const [poses, setPoses] = useState<PoseItem[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    call<PoseItem[]>('pose.list').then((p) => setPoses(p ?? []));
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = (poses ?? []).filter((p) => !s || `${p.name} ${p.nameEn ?? ''} ${p.folder ?? ''}`.toLowerCase().includes(s));
    return all.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || displayName(a).localeCompare(displayName(b)));
  }, [poses, q]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog mo-pose-picker" onClick={(e) => e.stopPropagation()}>
        <div className="mo-picker-head">
          <h2>{title}</h2>
          <input className="input" autoFocus placeholder="Search poses…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="mo-pose-grid">
          {!poses && <div className="empty">Loading poses…</div>}
          {poses && !list.length && <div className="empty">{poses.length ? `No poses match “${q}”.` : 'The pose library is empty — save poses in Pose › Pose library first.'}</div>}
          {list.map((p) => {
            const img = canThumb ? (p.thumb ?? (p.png ? p.path : null)) : null;
            return (
              <div {...pressable} key={p.path} className="mo-pose" onClick={() => onPick(p)} title={`${p.name}${p.nameEn ? `\n${p.nameEn}` : ''}\nClick to add`}>
                {img ? <img src={`sximg://thumb/?p=${encodeURIComponent(img)}`} loading="lazy" alt="" /> : <span className="mo-pose-ph" />}
                <span className="name">{displayName(p)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

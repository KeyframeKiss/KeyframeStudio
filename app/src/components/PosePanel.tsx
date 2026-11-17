import { useCallback, useEffect, useMemo, useState } from 'react';
import { call, displayName, selectedCharacters, toast, useStore } from '../state/store';
import { Icon } from './Icon';

interface PoseFile {
  path: string;
  name: string;
  nameEn?: string;
  sex: number;
  modified: number;
  png?: boolean;
  folder?: string;
}

const canThumb = !!window.studioEx?.isElectron;

export function PosePanel({ wide }: { wide?: boolean }) {
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  const status = useStore((s) => s.status);
  useStore((s) => s.showEnglish);
  const chars = useMemo(() => selectedCharacters(), [selection, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const [poses, setPoses] = useState<PoseFile[]>([]);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [sexFilter, setSexFilter] = useState(true);
  const [copyFrom, setCopyFrom] = useState<number | ''>('');

  const load = useCallback(() => {
    call<PoseFile[]>('pose.list').then((p) => p && setPoses(p.sort((a, b) => b.modified - a.modified)));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load]);

  const [folder, setFolder] = useState<string | null>(null);
  const folders = useMemo(() => [...new Set(poses.map((p) => p.folder ?? ''))].sort(), [poses]);
  const sex = chars.length ? nodes[chars[0]]?.sex : undefined;
  const q = query.trim().toLowerCase();
  const list = poses.filter(
    (p) =>
      (!q || `${p.name} ${p.nameEn ?? ''} ${p.folder ?? ''}`.toLowerCase().includes(q)) &&
      (!sexFilter || sex === undefined || p.sex === sex || p.sex === -1) &&
      (folder === null || (p.folder ?? '') === folder),
  );
  const allChars = Object.values(nodes).filter((n) => n.type === 'Char');

  const need = () => {
    if (!chars.length) {
      toast('Select one or more characters first');
      return false;
    }
    return true;
  };

  return (
    <>
      <div className={wide ? 'pose-head wide' : 'pose-head'} style={{ padding: wide ? '10px 14px' : 8, display: 'grid', gap: 6, borderBottom: '1px solid var(--line-soft)' }}>
        <div style={{ color: chars.length ? 'var(--text-1)' : 'var(--text-3)' }}>
          {chars.length ? `Target: ${chars.map((id) => displayName(nodes[id])).join(', ')}` : 'Select character(s) to pose'}
        </div>
        <button className="btn solid" title="Mirror the pose left ↔ right (FK + IK) · hotkey M" onClick={() => need() && call('pose.mirror', { ids: chars }).then((n) => n && toast('Pose mirrored'))}>
          ⇋ Mirror pose
        </button>
        <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
          <select className="input" style={{ flex: 1, minWidth: 0 }} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value === '' ? '' : Number(e.target.value))} title="Copy the pose of another character onto the selected ones">
            <option value="">Copy pose from…</option>
            {allChars.map((n) => (
              <option key={n.id} value={n.id}>
                {displayName(n)}
              </option>
            ))}
          </select>
          <button className="btn solid" disabled={copyFrom === ''} onClick={() => need() && call('pose.copy', { from: copyFrom, ids: chars }).then((n) => n && toast(`Pose copied to ${n} character(s)`))}>
            Apply
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder="New pose name…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).nextElementSibling?.dispatchEvent(new MouseEvent('click', { bubbles: true }))} />
          <button
            className="btn primary"
            onClick={async () => {
              if (!need()) return;
              const r = await call<PoseFile[]>('pose.save', { id: chars[0], name: name.trim() });
              if (r) {
                setPoses(r.sort((a, b) => b.modified - a.modified));
                setName('');
                toast('Pose saved — it also appears in Studio’s pose list');
              }
            }}
          >
            Save pose
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder="Search poses…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className={`btn ${sexFilter ? 'on' : ''}`} title="Only poses made for the selected character's body type" onClick={() => setSexFilter((s) => !s)}>
            {sex === 0 ? '♂' : '♀'}
          </button>
          <button className="btn icon" title="Reload list" onClick={load}>
            ↻
          </button>
        </div>
        {folders.length > 1 && (
          <select className="input" value={folder ?? '*'} onChange={(e) => setFolder(e.target.value === '*' ? null : e.target.value)}>
            <option value="*">All folders ({poses.length})</option>
            {folders.map((f) => (
              <option key={f} value={f}>
                {f || '(top level)'} ({poses.filter((p) => (p.folder ?? '') === f).length})
              </option>
            ))}
          </select>
        )}
      </div>
      <div className={wide ? `panel-body pose-grid${canThumb && list.some((p) => p.png) ? '' : ' compact'}` : 'panel-body'}>
        {list.map((p) => (
          <div
            key={p.path}
            className={wide ? 'pose-card' : 'model-row'}
            onClick={() => need() && call('pose.load', { ids: chars, path: p.path })}
            title={`${p.name}${p.nameEn ? `\n${p.nameEn}` : ''}\n${new Date(p.modified).toLocaleString()}\nClick to apply to the selected character(s)`}
          >
            {canThumb && p.png ? (
              <img src={`sximg://thumb/?p=${encodeURIComponent(p.path)}`} loading="lazy" alt="" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 4, background: 'var(--bg-0)', flex: 'none' }} />
            ) : (
              <span className="plus">
                <Icon name="play" size={10} />
              </span>
            )}
            <span className="name">
              {displayName(p)}
              {folder === null && p.folder ? <span className="sub"> · {p.folder}</span> : null}
            </span>
            <span className="sub">{p.sex === 0 ? '♂' : p.sex === 1 ? '♀' : ''}</span>
          </div>
        ))}
        {!list.length && (
          <div className="empty">
            <strong>{poses.length ? 'No matching poses' : 'No saved poses yet'}</strong>
            Save the current pose above. Poses are stored in UserData/studio/pose and shared with Studio.
          </div>
        )}
      </div>
    </>
  );
}

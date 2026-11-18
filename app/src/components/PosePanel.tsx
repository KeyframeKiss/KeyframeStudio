import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { call, displayName, selectedCharacters, toast, useStore } from '../state/store';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { StarIcon } from './StarIcon';
import { Icon } from './Icon';
import { PromptDialog, type PromptState } from './PromptDialog';

import { pressable } from '../lib/pressable';
interface PoseFile {
  path: string;
  name: string;
  nameEn?: string;
  sex: number;
  modified: number;
  png?: boolean;
  folder?: string;
  /** cached thumbnail made by Studio EX (UserData/StudioEX/pose-thumbs) */
  thumb?: string;
  favorite?: boolean;
  tags?: string[];
  lastUsed?: number;
}

type Sort = 'recent' | 'newest' | 'name';

const canThumb = !!window.studioEx?.isElectron;
const imgOf = (p: PoseFile) => (canThumb ? (p.thumb ?? (p.png ? p.path : null)) : null);
const lsGet = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

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
  const [sort, setSort] = useState<Sort>(() => (lsGet('studioex.pose.sort', 'recent') as Sort) || 'recent');
  const [favOnly, setFavOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [job, setJob] = useState<{ running: boolean; done: number; total: number } | null>(null);
  const [hoverPreview, setHoverPreview] = useState(() => lsGet('studioex.pose.hoverPreview', '1') === '1');
  const [compare, setCompare] = useState<string[]>([]); // pose paths picked for side-by-side
  const [comparing, setComparing] = useState(false);

  const load = useCallback(() => {
    call<PoseFile[]>('pose.list').then((p) => p && setPoses(p));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load]);

  // Thumbnail job progress (pushed by the plugin)
  useEffect(
    () =>
      bridge.on('pose.thumbs', (d) => {
        const j = d as { running: boolean; done: number; total: number };
        setJob(j.running ? j : null);
        if (!j.running) {
          load();
          toast(j.done < j.total ? `Thumbnails stopped — ${j.done} of ${j.total} made` : `Made ${j.done} pose thumbnails`);
        }
      }),
    [load],
  );

  const [folder, setFolder] = useState<string | null>(null);
  const folders = useMemo(() => [...new Set(poses.map((p) => p.folder ?? ''))].sort(), [poses]);
  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of poses) for (const t of p.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }, [poses]);
  const sex = chars.length ? nodes[chars[0]]?.sex : undefined;
  const q = query.trim().toLowerCase();
  const list = useMemo(() => {
    const r = poses.filter(
      (p) =>
        (!q || `${p.name} ${p.nameEn ?? ''} ${p.folder ?? ''} ${(p.tags ?? []).join(' ')}`.toLowerCase().includes(q)) &&
        (!sexFilter || sex === undefined || p.sex === sex || p.sex === -1) &&
        (folder === null || (p.folder ?? '') === folder) &&
        (!favOnly || p.favorite) &&
        tagFilter.every((t) => p.tags?.includes(t)),
    );
    const key = (p: PoseFile) => (sort === 'recent' ? p.lastUsed || 0 : p.modified);
    return r.sort(
      (a, b) =>
        Number(!!b.favorite) - Number(!!a.favorite) ||
        (sort === 'name' ? displayName(a).localeCompare(displayName(b)) : key(b) - key(a) || b.modified - a.modified),
    );
  }, [poses, q, sexFilter, sex, folder, favOnly, tagFilter, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const allChars = Object.values(nodes).filter((n) => n.type === 'Char');
  const missing = list.filter((p) => !imgOf(p));

  const need = () => {
    if (!chars.length) {
      toast('Select one or more characters first');
      return false;
    }
    return true;
  };

  // ---------------- hover preview: the pose shows on the character while the pointer rests on it ----------------
  const pv = useRef<{ timer: number; end: number; path: string | null }>({ timer: 0, end: 0, path: null });
  const endPreview = useCallback(() => {
    const s = pv.current;
    window.clearTimeout(s.timer);
    window.clearTimeout(s.end);
    if (s.path) bridge.request('pose.previewEnd').catch(() => {});
    s.path = null;
  }, []);
  useEffect(() => endPreview, [endPreview]); // leaving the panel ends it
  const hoverIn = (p: PoseFile) => {
    if (!wide || !hoverPreview || !chars.length || status !== 'open') return;
    const s = pv.current;
    window.clearTimeout(s.timer);
    window.clearTimeout(s.end);
    s.timer = window.setTimeout(() => {
      s.path = p.path;
      bridge.request('pose.preview', { ids: chars, path: p.path }).catch(() => (s.path = null));
    }, 350);
  };
  const hoverOut = () => {
    const s = pv.current;
    window.clearTimeout(s.timer);
    if (s.path) s.end = window.setTimeout(endPreview, 150); // moving to the next card keeps the preview going
  };

  const toggleCompare = (p: PoseFile) => {
    const next = compare.includes(p.path) ? compare.filter((x) => x !== p.path) : [...compare.slice(-1), p.path];
    setCompare(next);
    if (next.length === 2) setComparing(true);
  };

  const apply = (p: PoseFile) => {
    // a hover preview of this pose becomes the real thing (one undo step back to the pose before it)
    const s = pv.current;
    window.clearTimeout(s.timer);
    window.clearTimeout(s.end);
    s.path = null;
    if (!need()) return;
    call('pose.load', { ids: chars, path: p.path }).then((r) => r && setPoses((ps) => ps.map((x) => (x.path === p.path ? { ...x, lastUsed: Date.now() } : x))));
  };

  const setMeta = async (p: PoseFile, patch: { favorite?: boolean; tags?: string[] }) => {
    const ok = await call('pose.setMeta', { path: p.path, ...patch });
    if (ok !== undefined) setPoses((ps) => ps.map((x) => (x.path === p.path ? { ...x, ...patch } : x)));
  };

  const makeThumbs = (files: string[]) => {
    if (!need() || !files.length) return;
    const who = displayName(nodes[chars[0]]);
    const secs = Math.ceil(files.length / 25);
    if (
      files.length > 1 &&
      !window.confirm(
        `Make ${files.length} pose thumbnails?\n\n${who} will flick through the poses in Studio (about ${secs < 60 ? `${secs} s` : `${Math.ceil(secs / 60)} min`}) and is put back in their current pose afterwards. Auto-key is paused meanwhile. You can stop at any time.`,
      )
    )
      return;
    call<number>('pose.thumbs', { id: chars[0], files: files, missingOnly: files.length > 1 }).then((n) => {
      if (n === 0) toast('Those poses already have thumbnails');
      else if (n) setJob({ running: true, done: 0, total: n });
    });
  };

  const openMenu = (e: React.MouseEvent, p: PoseFile) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { header: true, label: displayName(p) },
        { label: 'Apply to selected', action: () => apply(p) },
        { label: compare.includes(p.path) ? 'Remove from comparison' : compare.length ? 'Compare with the other pose' : 'Compare… (pick a second pose)', action: () => toggleCompare(p) },
        { label: p.favorite ? 'Remove from favorites' : 'Add to favorites', action: () => setMeta(p, { favorite: !p.favorite }) },
        {
          label: 'Edit tags…',
          action: () =>
            setPrompt({
              title: `Tags for “${displayName(p)}”`,
              hint: 'Separate tags with commas, e.g. sitting, couple, action',
              value: (p.tags ?? []).join(', '),
              placeholder: 'sitting, couple, …',
              ok: (v) => setMeta(p, { tags: v.split(',').map((t) => t.trim()).filter(Boolean) }),
            }),
        },
        ...(p.png ? [] : [{ label: p.thumb ? 'Redo thumbnail' : 'Make thumbnail', action: () => makeThumbs([p.path]) }]),
      ],
    });
  };

  const showImages = wide && canThumb && list.some((p) => imgOf(p));

  return (
    <>
      <div className={wide ? 'pose-head wide' : 'pose-head'} style={{ padding: wide ? '10px 14px' : 8, display: 'grid', gap: 6, borderBottom: '1px solid var(--line-soft)' }}>
        <div className={wide ? 'pose-actions' : ''} style={wide ? undefined : { display: 'grid', gap: 6 }}>
          <span style={{ color: chars.length ? 'var(--text-1)' : 'var(--text-3)' }}>
            {chars.length ? `Target: ${chars.map((id) => displayName(nodes[id])).join(', ')}` : 'Select character(s) to pose'}
          </span>
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
          <form
            style={{ display: 'flex', gap: 6 }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!need()) return;
              const r = await call<PoseFile[]>('pose.save', { id: chars[0], name: name.trim() });
              if (r) {
                setPoses(r);
                setName('');
                toast('Pose saved — it also appears in Studio’s pose list');
              }
            }}
          >
            <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder="New pose name…" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn primary" type="submit">
              Save pose
            </button>
          </form>
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Search poses and tags…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {wide && (
            <select
              className="input"
              style={{ width: 'auto' }}
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as Sort);
                lsSet('studioex.pose.sort', e.target.value);
              }}
              title="Sort (favorites always first)"
            >
              <option value="recent">Recently used</option>
              <option value="newest">Newest</option>
              <option value="name">Name</option>
            </select>
          )}
          {wide && (
            <button
              className={`btn ${hoverPreview ? 'on' : ''}`}
              title="Preview on hover: rest the pointer on a pose to see it on the selected character; click to keep it, move away to go back"
              onClick={() => {
                lsSet('studioex.pose.hoverPreview', hoverPreview ? '0' : '1');
                if (hoverPreview) endPreview();
                setHoverPreview(!hoverPreview);
              }}
            >
              <Icon name="eye" size={13} /> Preview
            </button>
          )}
          <button className={`btn ${favOnly ? 'on' : ''}`} title="Favorites only" onClick={() => setFavOnly(!favOnly)}>
            <StarIcon filled={favOnly} size={13} />
          </button>
          <button className={`btn ${sexFilter ? 'on' : ''}`} title="Only poses made for the selected character's body type" onClick={() => setSexFilter((s) => !s)}>
            {sex === 0 ? '♂' : '♀'}
          </button>
          {folders.length > 1 && (
            <select className="input" style={{ width: 'auto', maxWidth: 220 }} value={folder ?? '*'} onChange={(e) => setFolder(e.target.value === '*' ? null : e.target.value)}>
              <option value="*">All folders ({poses.length})</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f || '(top level)'} ({poses.filter((p) => (p.folder ?? '') === f).length})
                </option>
              ))}
            </select>
          )}
          {wide &&
            canThumb &&
            (job ? (
              <span className="pose-job">
                <span className="tr-progress" style={{ width: 120 }}>
                  <span style={{ width: `${(100 * job.done) / Math.max(1, job.total)}%` }} />
                </span>
                {job.done}/{job.total}
                <button className="btn small" onClick={() => call('pose.thumbsCancel')}>
                  Stop
                </button>
              </span>
            ) : (
              missing.length > 0 && (
                <button className="btn" onClick={() => makeThumbs(missing.map((p) => p.path))} title="Render a picture of each shown pose without one, on the selected character">
                  <Icon name="camera" size={13} /> Make thumbnails ({missing.length})
                </button>
              )
            ))}
          <button className="btn icon" title="Reload list" onClick={load}>
            ↻
          </button>
        </div>
        {wide && allTags.length > 0 && (
          <div className="face-tagbar">
            {allTags.slice(0, 30).map((t) => (
              <button key={t} className={`face-tag-chip ${tagFilter.includes(t) ? 'on' : ''}`} onClick={() => setTagFilter(tagFilter.includes(t) ? tagFilter.filter((x) => x !== t) : [...tagFilter, t])}>
                {t}
              </button>
            ))}
            {tagFilter.length > 0 && (
              <button className="face-tag-chip clear" onClick={() => setTagFilter([])}>
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {wide && compare.length === 1 && (
        <div className="pose-compare-bar">
          Comparing “{displayName(poses.find((p) => p.path === compare[0]) ?? { name: '…' })}” — Ctrl+click a second pose.
          <button className="btn small" onClick={() => setCompare([])}>
            Cancel
          </button>
        </div>
      )}
      <div className={wide ? `panel-body pose-grid${showImages ? '' : ' compact'}` : 'panel-body'} onPointerLeave={hoverOut}>
        {list.map((p) => {
          const img = imgOf(p);
          return (
            <div {...pressable}
              key={p.path}
              className={wide ? `pose-card${compare.includes(p.path) ? ' comparing' : ''}` : 'model-row'}
              onClick={(e) => (wide && (e.ctrlKey || e.metaKey) ? toggleCompare(p) : apply(p))}
              onPointerEnter={() => hoverIn(p)}
              onPointerLeave={hoverOut}
              onContextMenu={(e) => openMenu(e, p)}
              title={`${p.name}${p.nameEn ? `\n${p.nameEn}` : ''}${p.tags?.length ? `\nTags: ${p.tags.join(', ')}` : ''}\n${new Date(p.modified).toLocaleString()}\nClick to apply · Ctrl+click to compare · right-click for more`}
            >
              {wide && (
                <button
                  className={`face-star ${p.favorite ? 'on' : ''}`}
                  title={p.favorite ? 'Favorite (click to remove)' : 'Add to favorites'}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMeta(p, { favorite: !p.favorite });
                  }}
                >
                  <StarIcon filled={!!p.favorite} />
                </button>
              )}
              {img ? (
                <img src={`sximg://thumb/?p=${encodeURIComponent(img)}`} loading="lazy" alt="" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 4, background: 'var(--bg-0)', flex: 'none' }} />
              ) : (
                <span className="plus">
                  <Icon name="play" size={10} />
                </span>
              )}
              <span className="name">
                {displayName(p)}
                {folder === null && p.folder ? <span className="sub"> · {p.folder}</span> : null}
              </span>
              <span className="sub">
                {p.sex === 0 ? '♂' : p.sex === 1 ? '♀' : ''}
                {wide && p.tags?.length ? ` ${p.tags.join(' · ')}` : ''}
              </span>
            </div>
          );
        })}
        {!list.length && (
          <div className="empty">
            <strong>{poses.length ? 'No matching poses' : 'No saved poses yet'}</strong>
            Save the current pose above. Poses are stored in UserData/studio/pose and shared with Studio.
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {prompt && <PromptDialog p={prompt} onClose={() => setPrompt(null)} />}
      {comparing && compare.length === 2 && (
        <ComparePoses
          poses={compare.map((path) => poses.find((p) => p.path === path)).filter((p): p is PoseFile => !!p)}
          onApply={(p) => {
            apply(p);
            setComparing(false);
            setCompare([]);
          }}
          onSwap={() => setCompare([compare[1], compare[0]])}
          onClose={() => {
            setComparing(false);
            setCompare([]);
          }}
        />
      )}
    </>
  );
}

/** Two poses side by side, large, to choose between them. */
function ComparePoses({ poses, onApply, onSwap, onClose }: { poses: PoseFile[]; onApply: (p: PoseFile) => void; onSwap: () => void; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog pose-compare" onClick={(e) => e.stopPropagation()}>
        <div className="pose-compare-head">
          <h2>Compare poses</h2>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onSwap} title="Swap left and right">
            ⇄ Swap
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="pose-compare-grid">
          {poses.map((p) => {
            const img = imgOf(p);
            return (
              <div key={p.path} className="pose-compare-col">
                <div className="pose-compare-img">
                  {img ? <img src={`sximg://thumb/?p=${encodeURIComponent(img)}`} alt="" /> : <span>No thumbnail yet — right-click the pose › Make thumbnail</span>}
                </div>
                <strong>{displayName(p)}</strong>
                <small>
                  {[p.folder, p.sex === 0 ? 'male' : p.sex === 1 ? 'female' : null, p.tags?.join(', ')].filter(Boolean).join(' · ') || ' '}
                </small>
                <button className="btn primary" onClick={() => onApply(p)}>
                  Apply this pose
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

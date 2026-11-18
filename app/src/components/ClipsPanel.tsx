import { useEffect, useMemo, useState } from 'react';
import { ask } from './Dialogs';
import { call, displayName, editTimeline, liveTime, parseKeyId, toast, useStore } from '../state/store';
import { Slider } from './CharacterPanel';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { TypeIcon } from './Icon';

export interface Clip {
  file: string;
  name: string;
  length: number;
  source: string;
  sourceType: string;
  note: string;
  tracks: number;
  keys: number;
  trackNames: string[];
  modified: number;
  thumb?: string;
}

interface ApplyResult {
  tracks: number;
  created: number;
  keys: number;
  end: number;
  trimmed: boolean;
  skipped: string[];
}

/** The tracks and time range a clip would be saved from: the selected keys, else all keys of the selected tracks. */
export function clipSelection() {
  const { selKeys, selTracks, tracks } = useStore.getState();
  let ids = new Set<number>();
  let t0 = Infinity,
    t1 = -Infinity;
  if (selKeys.size) {
    for (const k of selKeys) {
      const r = parseKeyId(k);
      ids.add(r.track);
      t0 = Math.min(t0, r.t);
      t1 = Math.max(t1, r.t);
    }
  } else if (selTracks.size) {
    ids = new Set(selTracks);
    for (const t of tracks) if (ids.has(t.id)) for (const [kt] of t.keys) (t0 = Math.min(t0, kt)), (t1 = Math.max(t1, kt));
  }
  return { tracks: [...ids], t0, t1, ok: ids.size > 0 && t1 > t0 };
}

const SPEEDS = [0.5, 1, 1.5, 2];
const BLENDS = [0, 0.1, 0.25, 0.5];

/** Animate › Motion clips: save a stretch of animation, drop it in again (any character), blend it. */
export function ClipsPanel({ wide }: { wide?: boolean } = {}) {
  const status = useStore((s) => s.status);
  const selKeys = useStore((s) => s.selKeys);
  const selTracks = useStore((s) => s.selTracks);
  const tracks = useStore((s) => s.tracks);
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  useStore((s) => s.showEnglish);
  const [clips, setClips] = useState<Clip[]>([]);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [mode, setMode] = useState<'replace' | 'add'>('replace');
  const [strength, setStrength] = useState(1);
  const [blend, setBlend] = useState(0.1);
  const [speed, setSpeed] = useState(1);
  const [loops, setLoops] = useState(1);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  useEffect(() => {
    if (status === 'open') call<Clip[]>('clips.list').then((c) => c && setClips(c));
  }, [status]);

  const sel = useMemo(clipSelection, [selKeys, selTracks, tracks]); // eslint-disable-line react-hooks/exhaustive-deps
  const target = selection.length ? nodes[selection[0]] : undefined;

  const save = async () => {
    if (!sel.ok) return toast('Select keys (or tracks) spanning some time first');
    const n = name.trim() || `Clip ${clips.length + 1}`;
    if (clips.some((c) => c.name === n) && !(await ask(`Replace the clip “${n}”?`))) return;
    const r = await call<Clip[]>('clips.save', { name: n, tracks: sel.tracks, t0: sel.t0, t1: sel.t1 });
    if (r) {
      setClips(r);
      setName('');
      toast(`Saved “${n}” (${(sel.t1 - sel.t0).toFixed(2)}s) with a thumbnail of the current view`);
    }
  };

  const apply = async (c: Clip) => {
    if (c.sourceType !== 'Scene' && !target) return toast('Select the character or object to put the clip on');
    const r = await editTimeline<ApplyResult>('clips.apply', { file: c.file, oci: target?.id ?? -1, t: liveTime(), mode, strength, blend, speed, loops });
    if (!r) return;
    const extra = [r.created ? `${r.created} new track${r.created > 1 ? 's' : ''}` : '', r.trimmed ? 'cut at the end of the timeline' : '', r.skipped.length ? `skipped ${r.skipped.length}: ${r.skipped.slice(0, 2).join(', ')}` : '']
      .filter(Boolean)
      .join(' · ');
    toast(`“${c.name}” on ${target ? displayName(target) : 'the scene'}: ${r.tracks} tracks, ${r.keys} keys${extra ? ` (${extra})` : ''} — Ctrl+Z to undo`, r.skipped.length ? 'info' : undefined);
  };

  const q = query.trim().toLowerCase();
  const list = clips.filter((c) => !q || `${c.name} ${c.source} ${c.note} ${c.trackNames.join(' ')}`.toLowerCase().includes(q));
  const span = (c: Clip) => (c.length / speed) * loops;

  return (
    <div className={`panel-body clips ${wide ? 'wide' : ''}`}>
      <div className="section">
        <h3>Save as a clip</h3>
        <div className="hint" style={{ marginTop: 0 }}>
          {sel.ok
            ? `${sel.tracks.length} track${sel.tracks.length > 1 ? 's' : ''}, ${sel.t0.toFixed(2)}–${sel.t1.toFixed(2)}s (${(sel.t1 - sel.t0).toFixed(2)}s).`
            : 'Select keys in the dope sheet (or click track names) — one character or object.'}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder="Name, e.g. Wave hello" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          <button className="btn primary" disabled={!sel.ok} onClick={save}>
            Save
          </button>
        </div>
      </div>

      <div className="section">
        <h3>
          Clips <span className="spacer" />
          <small className="hint" style={{ margin: 0, textTransform: 'none', letterSpacing: 0 }}>
            {clips.length}
          </small>
        </h3>
        {clips.length > 5 && <input className="input" placeholder="Find a clip…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: '100%', marginBottom: 6 }} />}
        {!clips.length && <div className="hint">No clips yet. A clip is a stretch of one object's animation — a wave, a nod, a laugh, a walk cycle — to reuse on any character.</div>}
        <div className="clip-list">
          {list.map((c) => (
            <div key={c.file} className={`clip-item ${open === c.file ? 'open' : ''}`}>
              <div
                className="clip-row"
                role="button"
                tabIndex={0}
                onClick={() => setOpen(open === c.file ? null : c.file)}
                onKeyDown={(e) => e.key === 'Enter' && setOpen(open === c.file ? null : c.file)}
                onDoubleClick={() => apply(c)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { header: true, label: c.name },
                      { label: 'Apply at the playhead', action: () => apply(c) },
                      { label: 'Retake thumbnail from the current view', action: () => call<Clip[]>('clips.thumb', { file: c.file }).then((r) => r && setClips(r)) },
                      { sep: true },
                      { label: 'Delete…', danger: true, action: async () => (await ask(`Delete the clip “${c.name}”?`)) && call<Clip[]>('clips.delete', { file: c.file }).then((r) => r && setClips(r)) },
                    ],
                  });
                }}
                title={`${c.name}\n${c.trackNames.join(', ')}${c.tracks > c.trackNames.length ? ', …' : ''}\nDouble-click to apply · right-click for more`}
              >
                {c.thumb ? <img src={c.thumb} alt="" /> : <span className="clip-ph">{c.name.slice(0, 1)}</span>}
                <span className="clip-text">
                  <b>{c.name}</b>
                  <small>
                    {c.length.toFixed(2)}s · {c.tracks} track{c.tracks > 1 ? 's' : ''} · {c.source}
                  </small>
                </span>
              </div>
              {open === c.file && (
                <div className="clip-apply">
                  <div className="cleanup-row">
                    <span>On</span>
                    {target ? (
                      <span className="clip-target">
                        <TypeIcon type={target.type} sex={target.sex} /> {displayName(target)} <small>at {liveTime().toFixed(2)}s</small>
                      </span>
                    ) : (
                      <span className="hint" style={{ margin: 0 }}>
                        {c.sourceType === 'Scene' ? 'the scene' : 'select a character or object'}
                      </span>
                    )}
                  </div>
                  <div className="cleanup-row">
                    <span>Mode</span>
                    <div className="seg">
                      <button className={mode === 'replace' ? 'on' : ''} onClick={() => setMode('replace')} title="The clip's motion replaces what's there">
                        Replace
                      </button>
                      <button className={mode === 'add' ? 'on' : ''} onClick={() => setMode('add')} title="The clip's movement is added on top of what's there (e.g. a nod over an idle)">
                        Add on top
                      </button>
                    </div>
                  </div>
                  <div className="cleanup-row">
                    <span>Strength</span>
                    <Slider value={strength} min={0} max={1} step={0.05} onChange={setStrength} />
                  </div>
                  <div className="cleanup-row">
                    <span>Blend</span>
                    <div className="seg" title="Ease in and out of the clip over this many seconds">
                      {BLENDS.map((b) => (
                        <button key={b} className={blend === b ? 'on' : ''} onClick={() => setBlend(b)}>
                          {b ? `${b}s` : 'Cut'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="cleanup-row">
                    <span>Speed</span>
                    <div className="seg">
                      {SPEEDS.map((v) => (
                        <button key={v} className={speed === v ? 'on' : ''} onClick={() => setSpeed(v)}>
                          {v}×
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="cleanup-row">
                    <span>Repeat</span>
                    <div className="seg">
                      {[1, 2, 3, 4, 8].map((n) => (
                        <button key={n} className={loops === n ? 'on' : ''} onClick={() => setLoops(n)}>
                          {n}×
                        </button>
                      ))}
                    </div>
                  </div>
                  <button className="btn primary wide" disabled={c.sourceType !== 'Scene' && !target} onClick={() => apply(c)}>
                    Apply ({span(c).toFixed(2)}s)
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

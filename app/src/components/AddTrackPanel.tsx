import { useEffect, useMemo, useState } from 'react';
import type { TrackModel } from '../bridge/types';
import { addTrack, displayName, listModels, useStore } from '../state/store';
import { BoneTracks } from './BoneTracks';
import { Icon, TypeIcon } from './Icon';

import { pressable } from '../lib/pressable';

/** What a property animates, so the list reads by meaning rather than by which mod provides it. */
const KINDS = ['Face', 'Pose', 'Animation', 'Clothes', 'Body and colour', 'Posing strength', 'Physics', 'Camera', 'Effects', 'Other'] as const;
type Kind = (typeof KINDS)[number];
function kindOf(m: TrackModel): Kind {
  const id = m.id;
  const all = `${m.id} ${m.nameEn ?? ''} ${m.name}`;
  if (/^fx\./.test(id)) return 'Effects';
  if (/^camera/i.test(id)) return 'Camera';
  if (/^(character(Neck|Eyes|EyesOpen|Eyebrows|EyebrowsOpen|Mouth|MouthOpen)|tears|blush|shakingEnabled|lastBlendShape|groupBlendShape)/i.test(id)) return 'Face';
  if (/^(guideObject|bone(Pos|Rot|Scale)|character(Left|Right)Hand)/i.test(id)) return 'Pose';
  if (/^(ikPositionWeight|fbbik)/i.test(id)) return 'Posing strength';
  if (/^(charAnimation|objectAnimation|timeScale|objectEnabled)/i.test(id)) return 'Animation';
  if (/^(charClothes|juice)/i.test(id)) return 'Clothes';
  if (/^(dynamicBone|collider)|boob|butt/i.test(id)) return 'Physics';
  if (/skin|tan|bust|hair|eyebrow|nipple|pregnan|week/i.test(all) || /SkinColor|Pregnancy/i.test(m.owner)) return 'Body and colour';
  return 'Other';
}

export function AddTrackPanel() {
  const status = useStore((s) => s.status);
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  const tracks = useStore((s) => s.tracks);
  useStore((s) => s.showEnglish);
  const [models, setModels] = useState<TrackModel[]>([]);
  const [global, setGlobal] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const target = global ? null : selection[0] ?? null;
  const node = target != null ? nodes[target] : undefined;

  useEffect(() => {
    if (status !== 'open') return;
    let alive = true;
    setLoading(true);
    listModels(target).then((m) => {
      if (!alive) return;
      setModels(m);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [target, status, nonce]);

  const existing = useMemo(() => new Set(tracks.filter((t) => t.oci === (target ?? -1)).map((t) => `${t.owner}/${t.model}`)), [tracks, target]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const m = new Map<Kind, TrackModel[]>();
    for (const x of models) {
      if (q && !`${x.name} ${x.nameEn ?? ''} ${x.owner} ${x.id}`.toLowerCase().includes(q)) continue;
      const k = kindOf(x);
      let l = m.get(k);
      if (!l) m.set(k, (l = []));
      l.push(x);
    }
    return KINDS.filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as const);
  }, [models, query]);
  // which groups are open: Face and Pose to start, then as left; all of them while searching
  const [open, setOpenState] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('kf.addTrack.open') || '["Face","Pose","Camera"]'));
    } catch {
      return new Set(['Face', 'Pose', 'Camera']);
    }
  });
  const toggle = (k: string) => {
    const next = new Set(open);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setOpenState(next);
    try {
      localStorage.setItem('kf.addTrack.open', JSON.stringify([...next]));
    } catch {
      /* not remembered; fine */
    }
  };

  return (
    <>
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 26 }}>
          {global ? (
            <span style={{ color: 'var(--text-1)', flex: 1 }}>Scene-wide tracks</span>
          ) : node ? (
            <>
              <TypeIcon type={node.type} sex={node.sex} />
              <span style={{ color: 'var(--text-0)', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(node)}</span>
            </>
          ) : (
            <span style={{ color: 'var(--text-3)', flex: 1 }}>No object selected</span>
          )}
          <div className="seg">
            <button className={!global ? 'on' : ''} onClick={() => setGlobal(false)} title="Tracks for the object selected in Studio">
              Object
            </button>
            <button className={global ? 'on' : ''} onClick={() => setGlobal(true)} title="Scene-wide tracks (camera, lights, environment…)">
              Scene
            </button>
          </div>
          <button className="btn icon" title="Refresh list (e.g. after selecting a bone in Studio)" onClick={() => setNonce((n) => n + 1)}>
            ↻
          </button>
        </div>
        <input className="input search" placeholder="Search properties…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="panel-body">
        {!global && target == null ? (
          <div className="empty">
            <strong>Select an object</strong>
            Pick a character or item in the Scene tab (or in Studio) to see what can be animated.
          </div>
        ) : loading && !models.length ? (
          <div className="empty">Loading…</div>
        ) : (
          <>
          {!global && target != null && node?.type === 'Char' && <BoneTracks oci={target} query={query} />}
          {groups.length === 0 && !(node?.type === 'Char' && !global) ? (
          <div className="empty">
            <strong>Nothing found</strong>
            {query ? 'Try another search.' : 'No animatable properties for this object.'}
          </div>
          ) : (
          groups.map(([kind, list]) => {
            const isOpen = !!query.trim() || open.has(kind);
            const animated = list.filter((m) => existing.has(`${m.owner}/${m.id}`)).length;
            return (
            <div className="model-group" key={kind}>
              <button className="model-group-title model-group-toggle" aria-expanded={isOpen} onClick={() => toggle(kind)}>
                <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={11} />
                <span>{kind}</span>
                <small>{list.length}</small>
                {animated > 0 && <small className="model-group-anim">{animated} animated</small>}
              </button>
              {isOpen && list.map((m, mi) => {
                const has = existing.has(`${m.owner}/${m.id}`);
                return (
                  <div {...pressable}
                    key={`${m.owner}/${m.id}/${mi}`}
                    className="model-row"
                    title={`${m.name}${m.nameEn ? `\n${m.nameEn}` : ''}\n${m.owner} / ${m.id}\nClick: add track + key at playhead`}
                    onClick={() => addTrack(m, target)}
                  >
                    <span className="plus">
                      <Icon name={has ? 'key' : 'plus'} size={has ? 10 : 13} />
                    </span>
                    <span className="name">{displayName(m)}</span>
                    {has && <span className="sub">animated</span>}
                  </div>
                );
              })}
            </div>
            );
          })
          )}
          </>
        )}
      </div>
    </>
  );
}

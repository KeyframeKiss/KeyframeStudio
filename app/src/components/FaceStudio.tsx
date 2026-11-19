import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { ALL_FACE_BONES, FACE_FEATURES, RANGES, isPaired, twinOf, type Channel, type FaceBone } from '../lib/faceBones';
import { showTab, selectedCharacters, toast, useStore } from '../state/store';
import { NumberField } from './TopBar';
import { FacePresets } from './FacePresets';
import { ExpressionControls } from './ExpressionControls';
import { ShapesPanel } from './ShapesPanel';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * Face Studio: fine-tune the face of a character already in the scene.
 * Edits are KKPE bone adjustments (saved with the scene, still editable in KKPE). The close-up on the left
 * is rendered on demand by Studio from a dedicated face camera, refreshed after each change.
 */

type Vec3 = [number, number, number];
interface BoneState {
  name: string;
  pos: Vec3;
  rot: Vec3;
  scale: Vec3;
  edited: boolean;
}

const ANGLES: { label: string; value: number; title: string }[] = [
  { label: 'Side', value: -90, title: 'Profile (character’s right side)' },
  { label: '¾', value: -35, title: 'Three-quarter (right)' },
  { label: 'Front', value: 0, title: 'Front' },
  { label: '¾', value: 35, title: 'Three-quarter (left)' },
  { label: 'Side', value: 90, title: 'Profile (character’s left side)' },
];

/** Parts covering a whole area (head shape, both eyes/brows, cheek base): picked from their tabs, not by pointing. */
// (Eye tilt deforms the whole eye area, so pointing at an eye should give "Eye" instead.)
const BROAD = new Set(['cf_J_FaceBase', 'cf_J_FaceUp_ty', 'cf_J_FaceUp_tz', 'cf_J_FaceLow_tz', 'cf_J_FaceLow_sx', 'cf_J_Eye_tz', 'cf_J_Mayu_ty', 'cf_J_CheekUpBase', 'cf_J_Eye_rz_L', 'cf_J_Eye_rz_R']);

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

/** Face parts listed top to bottom, the way you look at a face. */
const NAV_ORDER = ['head', 'brows', 'eyes', 'lids', 'nose', 'cheeks', 'mouth', 'jaw', 'ears'];

export function FaceStudio() {
  const status = useStore((s) => s.status);
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  const revision = useStore((s) => s.revision);
  const chars = useMemo(() => selectedCharacters(), [selection, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const id = chars[0];

  const [feature, setFeature] = useState(() => lsGet('studioex.face.feature', 'eyes'));
  const lastPart = useRef(FACE_FEATURES.some((f) => f.id === feature) ? feature : 'eyes'); // "Face parts" reopens it
  const [mirror, setMirror] = useState(() => lsGet('studioex.face.mirror', '1') === '1');
  const [side, setSide] = useState<'L' | 'R'>('L');
  const [angle, setAngle] = useState(0);
  const [zoom, setZoom] = useState(1);
  // Free view: pan in face-height units, pitch in degrees (angle is the yaw, also set by the buttons)
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [pitch, setPitch] = useState(0);
  const [plain, setPlain] = useState(() => lsGet('studioex.face.plain', '0') === '1');
  const [bones, setBones] = useState<Record<string, BoneState>>({});
  const [img, setImg] = useState<string | null>(null);
  const [before, setBefore] = useState(false); // hold "Before" to see the original face
  const [hover, setHover] = useState<{ bone: string; x: number; y: number } | null>(null);
  const [cardHover, setCardHover] = useState<string | null>(null); // hovering a part's card highlights it too
  const imageBox = useRef<HTMLDivElement>(null);

  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uniform, setUniform] = useState<Set<string>>(new Set());
  const lastEdit = useRef(-1e9); // "long ago" (performance.now() starts at 0 when the page loads)
  const want = useRef(id);
  want.current = id;

  // ---------------- data ----------------
  const load = useCallback(() => {
    if (id == null || status !== 'open') return;
    const cid = id;
    bridge
      .request<{ bones: BoneState[] }>('face.get', { id: cid, bones: ALL_FACE_BONES })
      .then((r) => {
        if (want.current !== cid || performance.now() - lastEdit.current < 600) return;
        const map: Record<string, BoneState> = {};
        for (const b of r.bones) map[b.name] = b;
        setBones(map);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [id, status]);
  useEffect(load, [load, revision]);

  // ---------------- close-up (on demand, one request in flight) ----------------
  const view = useRef({ busy: false, again: false });
  const recenter = useRef(false);
  const viewArgs = useRef({ angle, zoom, plain, pitch, panX: pan.x, panY: pan.y, original: before });
  viewArgs.current = { angle, zoom, plain, pitch, panX: pan.x, panY: pan.y, original: before };
  const refreshView = useCallback(() => {
    if (id == null || status !== 'open') return;
    const v = view.current;
    if (v.busy) {
      v.again = true;
      return;
    }
    v.busy = true;
    const cid = id;
    const wasRecenter = recenter.current;
    bridge
      .request<string>('face.view', { id: cid, ...viewArgs.current, recenter: recenter.current, size: 640 })
      .then((url) => want.current === cid && setImg(url))
      .catch(() => {})
      .finally(() => {
        if (wasRecenter) recenter.current = false;
        v.busy = false;
        if (v.again) {
          v.again = false;
          refreshView();
        }
      });
  }, [id, status]);
  useEffect(refreshView, [refreshView, angle, zoom, plain, pitch, pan, before, revision]);

  // ---------------- click a face part in the close-up → open its controls ----------------
  const featureOfBone = (name: string) => {
    const base = name.endsWith('_R') ? twinOf(name) : name;
    for (const f of FACE_FEATURES) {
      const b = f.bones.find((x) => x.name === base);
      if (b) return { feature: f, bone: b };
    }
    return null;
  };
  const jumpTo = (name: string) => {
    const hit = featureOfBone(name);
    if (!hit) return;
    setFeature(hit.feature.id);
    lsSet('studioex.face.feature', hit.feature.id);
    if (name.endsWith('_R') && !mirror) setSide('R');
    if (name.endsWith('_L') && !mirror) setSide('L');
    setFlash(hit.bone.name);
    window.setTimeout(() => document.getElementById(`face-card-${hit.bone.name}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
    window.setTimeout(() => setFlash(null), 1200);
  };
  const downAt = useRef<{ x: number; y: number } | null>(null);

  const PICKABLE = useMemo(() => ALL_FACE_BONES.filter((n) => !BROAD.has(n)), []);
  const picking = useRef<{ busy: boolean; next: { u: number; v: number; x: number; y: number } | null }>({ busy: false, next: null });
  const pickAt = (el: Element, cx: number, cy: number) => {
    const r = imgRect(el),
      box = el.getBoundingClientRect();
    const u = (cx - r.left) / r.width,
      v = (cy - r.top) / r.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return setHover(null);
    picking.current.next = { u, v, x: cx - box.left, y: cy - box.top };
    if (picking.current.busy || id == null) return;
    const run = () => {
      const job = picking.current.next;
      picking.current.next = null;
      if (!job) return void (picking.current.busy = false);
      picking.current.busy = true;
      bridge
        .request<{ bone: string } | null>('face.pick', { id, x: job.u, y: job.v, bones: PICKABLE })
        .then((r) => setHover((o) => (r?.bone ? (o?.bone === r.bone ? { ...o, x: job.x, y: job.y } : { bone: r.bone, x: job.x, y: job.y }) : null)))
        .catch(() => setHover(null))
        .finally(run);
    };
    run();
  };

  // ---------------- highlight: a marker on each hovered part (and its twin when mirrored) ----------------
  // Studio says where the part sits in the current picture; refreshed whenever the picture changes.
  const hiBone = hover?.bone ?? cardHover;
  const hiKey = hiBone ? (isPaired(hiBone) && mirror ? [hiBone, twinOf(hiBone)] : [hiBone]).join(',') : '';
  const [anchors, setAnchors] = useState<{ bone: string; x: number; y: number }[]>([]);
  const anchorSeq = useRef(0);
  useEffect(() => {
    const seq = ++anchorSeq.current;
    if (!hiKey || id == null) return void setAnchors([]);
    bridge
      .request<{ bone: string; x: number; y: number }[]>('face.anchors', { id, bones: hiKey.split(',') })
      .then((r) => seq === anchorSeq.current && setAnchors(r ?? []))
      .catch(() => seq === anchorSeq.current && setAnchors([]));
  }, [hiKey, img, id]);

  // ---------------- close-up navigation: drag = move, right-drag = turn, wheel = zoom at cursor ----------------
  const ZMIN = 0.5,
    ZMAX = 6;
  const nav = useRef<{ button: number; x: number; y: number } | null>(null);
  const resetView = () => {
    setPan({ x: 0, y: 0 });
    setPitch(0);
    setZoom(1);
  };
  /** The visible square picture (the <img> box is letterboxed by object-fit: contain). */
  const imgRect = (el: Element) => {
    const r = (el.querySelector('img') ?? el).getBoundingClientRect();
    const side = Math.min(r.width, r.height);
    return { left: r.left + (r.width - side) / 2, top: r.top + (r.height - side) / 2, width: side, height: side };
  };

  // ---------------- edits ----------------
  const pending = useRef(new Map<string, Partial<Record<Channel, Vec3>>>());
  const raf = useRef(0);
  const reloadTimer = useRef(0);
  const send = (bone: string, ch: Channel, vec: Vec3) => {
    if (id == null) return;
    lastEdit.current = performance.now();
    setBones((m) => ({ ...m, [bone]: { ...(m[bone] ?? { name: bone, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], edited: true }), [ch]: vec, edited: true } }));
    pending.current.set(bone, { ...(pending.current.get(bone) ?? {}), [ch]: vec });
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const batch = [...pending.current];
      pending.current.clear();
      Promise.all(batch.map(([b, patch]) => bridge.request('face.set', { id, bone: b, mirror, ...patch }).catch((e) => toast((e as Error).message, 'error')))).then(() => {
        refreshView();
        // pick up the mirrored twin's values once the drag settles
        window.clearTimeout(reloadTimer.current);
        reloadTimer.current = window.setTimeout(() => {
          lastEdit.current = -1e9;
          load();
        }, 650);
      });
    });
  };

  const reset = async (names: string[]) => {
    if (id == null) return;
    await bridge.request('face.reset', { id, bones: names, mirror }).catch((e) => toast((e as Error).message, 'error'));
    lastEdit.current = -1e9;
    load();
    refreshView();
  };

  // ---------------- render ----------------
  if (status !== 'open') return <div className="empty">Waiting for CharaStudio…</div>;
  if (id == null)
    return (
      <div className="empty">
        <strong>Select a character</strong>
        Pick a character in the Scene list or in Studio to adjust their face.
      </div>
    );
  if (error)
    return (
      <div className="empty">
        <strong>Face Studio isn’t available</strong>
        {error}
      </div>
    );

  const isExpr = feature === 'expression';
  const isShapes = feature === 'shapes';
  const feat = FACE_FEATURES.find((f) => f.id === feature) ?? FACE_FEATURES[0];
  const nameFor = (b: FaceBone) => (isPaired(b.name) && !mirror && side === 'R' ? twinOf(b.name) : b.name);
  const editedCount = (fid: string) => FACE_FEATURES.find((f) => f.id === fid)!.bones.filter((b) => bones[b.name]?.edited || (isPaired(b.name) && bones[twinOf(b.name)]?.edited)).length;
  const editedIn = (fid: string) => editedCount(fid) > 0;
  const partsEdited = FACE_FEATURES.reduce((n, f) => n + editedCount(f.id), 0);
  if (!isExpr && !isShapes) lastPart.current = feat.id;
  const go = (f: string) => {
    setFeature(f);
    lsSet('studioex.face.feature', f);
  };
  const hasPairs = feat.bones.some((b) => isPaired(b.name));

  return (
    <div className="face-studio">
      <section className="face-view">
        <div
          className="face-image"
          ref={imageBox}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
            nav.current = { button: e.button, x: e.clientX, y: e.clientY };
            downAt.current = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
          }}
          onPointerMove={(e) => {
            const n = nav.current;
            if (!n) {
              pickAt(e.currentTarget, e.clientX, e.clientY);
              return;
            }
            if (e.buttons === 0) return void (nav.current = null);
            setHover(null);
            const dx = e.clientX - n.x,
              dy = e.clientY - n.y;
            n.x = e.clientX;
            n.y = e.clientY;
            if (n.button === 0) {
              // move: the face follows the cursor (one image height = 1/zoom face heights)
              const h = imgRect(e.currentTarget).height || 1;
              setPan((p) => ({ x: p.x - dx / h / zoom, y: p.y + dy / h / zoom }));
            } else {
              // turn: free yaw/pitch around the head
              setAngle((a) => Math.round((a - dx * 0.4) * 10) / 10);
              setPitch((p) => Math.max(-70, Math.min(70, p + dy * 0.3)));
            }
          }}
          onPointerUp={(e) => {
            nav.current = null;
            const d = downAt.current;
            downAt.current = null;
            if (d && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 5 && hover) jumpTo(hover.bone);
          }}
          onPointerLeave={() => {
            picking.current.next = null;
            setHover(null);
          }}
          onPointerCancel={() => (nav.current = null)}
          onWheel={(e) => {
            // zoom towards the point under the cursor (it stays put)
            const r = imgRect(e.currentTarget);
            const u = (e.clientX - r.left) / r.width - 0.5,
              v = 0.5 - (e.clientY - r.top) / r.height;
            const nz = Math.max(ZMIN, Math.min(ZMAX, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
            if (nz === zoom) return;
            const k = 1 / zoom - 1 / nz;
            setPan((p) => ({ x: p.x + u * k, y: p.y + v * k }));
            setZoom(nz);
          }}
          onDoubleClick={resetView}
        >
          {img ? <img src={img} alt="Face close-up" draggable={false} /> : <div className="empty">Rendering close-up…</div>}
          {anchors.length > 0 &&
            imageBox.current &&
            (() => {
              const r = imgRect(imageBox.current!),
                box = imageBox.current!.getBoundingClientRect();
              return anchors.map((a) => (
                <div key={a.bone} className="face-anchor" style={{ left: r.left - box.left + a.x * r.width, top: r.top - box.top + a.y * r.height }} />
              ));
            })()}
          {hover && (
            <div className="face-pick" style={{ left: hover.x + 14, top: hover.y + 18 }}>
              <span className="face-pick-label">{featureOfBone(hover.bone)?.bone.label ?? hover.bone}</span>
            </div>
          )}
          {before && <div className="face-before-badge">Before</div>}
          <div className="face-nav-hint">Click a part to edit it · Drag to move · Right-drag to turn · Wheel to zoom · Double-click to reset</div>
        </div>
        <div className="face-view-bar">
          <button className="btn solid" onClick={() => showTab('animate', 'face')}>Animate expression</button>
          <div className="seg">
            {ANGLES.map((a) => (
              <button
                key={a.value}
                className={angle === a.value && pitch === 0 ? 'on' : ''}
                title={a.title}
                onClick={() => {
                  setAngle(a.value);
                  setPitch(0);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
          <label className="face-zoom" title="Zoom">
            Zoom
            <input type="range" min={ZMIN} max={ZMAX} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
          </label>
          <button
            className={`btn ${before ? 'on' : ''}`}
            title="Hold to see the face without your adjustments"
            onPointerDown={() => setBefore(true)}
            onPointerUp={() => setBefore(false)}
            onPointerLeave={() => setBefore(false)}
          >
            Before
          </button>
          <button
            className={`btn ${plain ? 'on' : ''}`}
            title="Show only this character's head on a plain backdrop"
            onClick={() => {
              setPlain(!plain);
              lsSet('studioex.face.plain', plain ? '0' : '1');
            }}
          >
            Plain background
          </button>
          <button
            className="btn icon"
            title="Reset the view and re-frame the close-up on the face"
            onClick={() => {
              recenter.current = true;
              resetView();
              refreshView();
            }}
          >
            ↻
          </button>
        </div>
        <ErrorBoundary key={isExpr ? 'expr' : 'face'} name={isExpr ? 'Saved expressions' : 'Saved faces'}>
        <FacePresets
          key={isExpr ? 'expression' : 'face'}
          kind={isExpr ? 'expression' : 'face'}
          ids={chars}
          onApplied={() => {
            lastEdit.current = -1e9;
            load();
            refreshView();
          }}
        />
        </ErrorBoundary>
      </section>

      <section className="face-controls">
        <div className="seg face-modes">
          <button className={isExpr ? 'on' : ''} title="Eyebrows, eyes, mouth, blush, tears and where the character looks" onClick={() => go('expression')}>
            Expression
          </button>
          <button className={!isExpr && !isShapes ? 'on' : ''} title="Move, turn and resize each part of the face (KKPE)" onClick={() => go(lastPart.current)}>
            Face parts
            {partsEdited > 0 && <span className="face-edits" title={`${partsEdited} adjusted part${partsEdited > 1 ? 's' : ''}`}>{partsEdited}</span>}
          </button>
          <button className={isShapes ? 'on' : ''} title="Blendshapes: the mesh shapes expressions are made of (KKPE)" onClick={() => go('shapes')}>
            Shapes
          </button>
        </div>

        {isExpr ? (
          <ExpressionControls ids={chars} onChanged={refreshView} />
        ) : isShapes ? (
          <ShapesPanel id={id} onChanged={refreshView} />
        ) : (
        <div className="face-parts">
        <nav className="face-nav" aria-label="Face parts">
          {NAV_ORDER.map((fid) => {
            const f = FACE_FEATURES.find((x) => x.id === fid);
            if (!f) return null;
            const n = editedCount(f.id);
            return (
              <button key={f.id} className={`face-nav-item ${f.id === feat.id ? 'on' : ''}`} onClick={() => go(f.id)}>
                <span>{f.label}</span>
                {n > 0 && <span className="face-edits" title={`${n} adjusted`}>{n}</span>}
              </button>
            );
          })}
        </nav>
        <div className="face-parts-main">
        <div className="face-options">
          <button
            className={`btn ${mirror ? 'on' : ''}`}
            title="Apply changes to both sides, mirrored"
            onClick={() => {
              setMirror(!mirror);
              lsSet('studioex.face.mirror', mirror ? '0' : '1');
            }}
          >
            ⇋ Mirror left/right
          </button>
          {!mirror && hasPairs && (
            <div className="seg" title="Which side to edit">
              <button className={side === 'L' ? 'on' : ''} onClick={() => setSide('L')}>
                Left
              </button>
              <button className={side === 'R' ? 'on' : ''} onClick={() => setSide('R')}>
                Right
              </button>
            </div>
          )}
          <span style={{ flex: 1 }} />
          <button
            className="btn"
            disabled={!editedIn(feat.id)}
            title={`Reset every ${feat.label.toLowerCase()} adjustment`}
            onClick={() => reset(feat.bones.map((b) => b.name))}
          >
            Reset {feat.label.toLowerCase()}
          </button>
        </div>

        <div className="face-cards">
          {feat.bones.map((b) => {
            const name = nameFor(b);
            const st = bones[name];
            if (!st) return null; // this character doesn't have the bone
            const channels = b.channels ?? (['pos', 'rot', 'scale'] as Channel[]);
            const locked = uniform.has(name) || channels.length === 1;
            return (
              <div
                key={b.name}
                id={`face-card-${b.name}`}
                className={`face-card ${st.edited ? 'edited' : ''} ${flash === b.name ? 'flash' : ''}`}
                onMouseEnter={() => setCardHover(name)}
                onMouseLeave={() => setCardHover((h) => (h === name ? null : h))}
              >
                <div className="face-card-head">
                  <strong>{b.label}</strong>
                  {isPaired(b.name) && <span className="face-tag">{mirror ? 'L + R' : side === 'L' ? 'Left' : 'Right'}</span>}
                  <span style={{ flex: 1 }} />
                  <button className="btn icon" title="Reset this part" disabled={!st.edited} onClick={() => reset([name])}>
                    ↺
                  </button>
                </div>
                {b.hint && <div className="face-hint">{b.hint}</div>}
                {channels.map((ch) => {
                  const r = RANGES[ch];
                  const vec = st[ch];
                  return (
                    <div key={ch} className="face-row">
                      <div className="face-row-label">
                        {r.label}
                        {ch === 'scale' && channels.length > 1 && (
                          <button
                            className={`face-lock ${uniform.has(name) ? 'on' : ''}`}
                            title="Scale all axes together"
                            onClick={() =>
                              setUniform((u) => {
                                const n = new Set(u);
                                if (n.has(name)) n.delete(name);
                                else n.add(name);
                                return n;
                              })
                            }
                          >
                            ⛓
                          </button>
                        )}
                      </div>
                      <div className="face-axes">
                      {ch === 'scale' && locked ? (
                        <Axis axis="" range={r} value={vec[0]} onChange={(v) => send(name, ch, [v, v, v])} />
                      ) : (
                        ([0, 1, 2] as const).map((i) => (
                          <Axis
                            key={i}
                            axis={'XYZ'[i]}
                            range={r}
                            value={vec[i]}
                            onChange={(v) => {
                              const n = [...vec] as Vec3;
                              n[i] = v;
                              send(name, ch, n);
                            }}
                          />
                        ))
                      )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        </div>
        </div>
        )}
      </section>
    </div>
  );
}

function Axis({ axis, range, value, onChange }: { axis: string; range: (typeof RANGES)[Channel]; value: number; onChange: (v: number) => void }) {
  return (
    <div className={`face-axis ax-${axis || 'all'} ${Math.abs(value - range.neutral) > range.step / 2 ? 'changed' : ''}`} title="Double-click the slider to reset">
      {axis && <span className="face-axis-name">{axis}</span>}
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={Math.min(range.max, Math.max(range.min, value))}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(range.neutral)}
      />
      <NumberField
        value={value}
        width={56}
        format={(v) => v.toFixed(range.digits)}
        parse={(t) => {
          const n = Number(t.replace(',', '.'));
          return Number.isFinite(n) ? n : null;
        }}
        onCommit={onChange}
      />
    </div>
  );
}

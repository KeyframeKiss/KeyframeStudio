import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Help } from './Help';
import { bridge } from '../bridge/client';
import type { WireTrack } from '../bridge/types';
import { call, displayName, editTimeline, liveTime, seekNow, selectedCharacters, toast, useStore } from '../state/store';
import { AudioPanel } from './AudioPanel';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { ExpressionControls, type ExpressionField } from './ExpressionControls';
import { Icon } from './Icon';

/**
 * Animate › Face: everything for animating a face in one place — the face close-up, its expression controls
 * (a change is keyed at the playhead), only this character's face tracks underneath, lip-sync and blinks.
 */

/** Timeline's face tracks, top to bottom, and which expression control drives each. */
export const FACE_ROWS: { model: string; label: string; field?: ExpressionField }[] = [
  { model: 'characterEyebrows', label: 'Brows', field: 'eyebrowPtn' },
  { model: 'characterEyes', label: 'Eyes', field: 'eyesPtn' },
  { model: 'characterEyesOpen', label: 'Eyes open', field: 'eyesOpen' },
  { model: 'characterMouth', label: 'Mouth shape', field: 'mouthPtn' },
  { model: 'characterMouthOpen', label: 'Mouth open', field: 'mouthOpen' },
  { model: 'blush', label: 'Blush', field: 'blush' },
  { model: 'tears', label: 'Tears', field: 'tears' },
  { model: 'characterNeck', label: 'Neck', field: 'neckLook' },
];
const FIELD_MODEL = new Map(FACE_ROWS.filter((r) => r.field).map((r) => [r.field!, r.model]));

const faceTrack = (tracks: WireTrack[], oci: number, model: string) => tracks.find((t) => t.oci === oci && t.owner === 'Timeline' && t.model === model);

/** The character's track for a face model, created when missing; its id. */
async function ensureTrack(oci: number, model: string): Promise<number | undefined> {
  const existing = faceTrack(useStore.getState().tracks, oci, model);
  if (existing) return existing.id;
  return call<number>('timeline.addTrack', { owner: 'Timeline', model, oci });
}

/** Key these face models of these characters at the playhead (one undo step). */
export async function keyFace(chars: number[], models: string[]) {
  const ids: number[] = [];
  for (const oci of chars) for (const m of models) {
    const id = await ensureTrack(oci, m);
    if (id != null) ids.push(id);
  }
  if (!ids.length) return 0;
  return (await editTimeline<number>('timeline.addKeys', { tracks: ids, t: liveTime() })) ?? 0;
}

export function FaceAnimation() {
  const status = useStore((s) => s.status);
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  const tracks = useStore((s) => s.tracks);
  const time = useStore((s) => s.tl?.time ?? 0);
  const playing = useStore((s) => !!s.tl?.playing);
  const revision = useStore((s) => s.revision);
  useStore((s) => s.showEnglish);
  const chars = useMemo(() => selectedCharacters(), [selection, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const id = chars[0];
  // one auto-key for everything: the transport's Auto (R) also keys the changes made here
  const autoKey = useStore((s) => s.autoKey);
  const autoNew = useStore((s) => s.autoKeyNew);
  const [img, setImg] = useState<string | null>(null);

  // ---------------- close-up (one request in flight; not while playing) ----------------
  const view = useRef({ busy: false, again: false });
  const want = useRef(id);
  want.current = id;
  const refreshView = useCallback(() => {
    if (id == null || status !== 'open') return;
    const v = view.current;
    if (v.busy) return void (v.again = true);
    v.busy = true;
    const cid = id;
    bridge
      .request<string>('face.view', { id: cid, angle: 0, zoom: 1, size: 480 })
      .then((url) => want.current === cid && setImg(url))
      .catch(() => {})
      .finally(() => {
        v.busy = false;
        if (v.again) {
          v.again = false;
          refreshView();
        }
      });
  }, [id, status]);
  const stepTime = playing ? -1 : Math.round(time * 1000);
  useEffect(() => {
    if (!playing) refreshView();
  }, [refreshView, revision, stepTime, playing]);

  // ---------------- a change → key it at the playhead (after the drag settles) ----------------
  const toKey = useRef(new Set<string>());
  const timer = useRef(0);
  const onChanged = (fields: ExpressionField[]) => {
    refreshView();
    if (!autoKey) return;
    for (const f of fields) {
      const m = FIELD_MODEL.get(f);
      if (m) toKey.current.add(m);
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      // like auto-key in Studio: without "also animate things that aren't animated yet", only existing tracks get keys
      const tr = useStore.getState().tracks;
      const models = [...toKey.current].filter((m) => autoNew || chars.some((c) => faceTrack(tr, c, m)));
      toKey.current.clear();
      if (models.length) keyFace(chars, models);
    }, 300);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // ◆ beside a control whose track has a key at the playhead
  const keyedHere = useMemo(() => {
    const s = new Set<string>();
    if (id == null) return s;
    for (const r of FACE_ROWS) {
      const t = faceTrack(tracks, id, r.model);
      if (t?.keys.some((k) => Math.abs(k[0] - time) < 1e-3) && r.field) s.add(r.field);
    }
    return s;
  }, [tracks, id, time]);

  if (id == null)
    return (
      <div className="empty" style={{ margin: 'auto' }}>
        <strong>Select a character</strong>
        Pick the character whose face you're animating in the Scene list or in Studio.
      </div>
    );

  return (
    <div className="face-anim">
      <div className="face-anim-bar">
        <span className="type-icon type-Char">♀</span>
        <b>{displayName(nodes[id])}</b>
        {chars.length > 1 && <span className="kbd">+{chars.length - 1}</span>}
        <span className="sel-bar-sub">at {time.toFixed(2)}s</span>
        <Help text="Move the playhead, change the face below. With Auto-key on (Auto under the timeline, R) each change is keyed there; otherwise press Key face when it looks right. ◆ beside a control: it has a key at the playhead. Look direction and the Blink / Lip sync switches can't be animated in Timeline." />
        <span style={{ flex: 1 }} />
        <span className={`face-auto ${autoKey ? 'on' : ''}`} title="Auto-key is the Auto button under the timeline (R)">
          <span className="rec-dot" /> {autoKey ? (autoNew ? 'Auto-key: changes are keyed' : 'Auto-key: changes to animated parts are keyed') : 'Auto-key off — press Key face'}
        </span>
        <button
          className="btn primary"
          onClick={async () => {
            const n = await keyFace(chars, FACE_ROWS.map((r) => r.model));
            if (n) toast(`Keyed the whole face at ${liveTime().toFixed(2)}s`);
          }}
          title="Key every face track (brows, eyes, mouth, blush, tears, neck) at the playhead"
        >
          <Icon name="key" size={13} /> Key face
        </button>
      </div>
      <div className="face-anim-main">
        <div className="face-anim-view">{img ? <img src={img} alt="Face close-up" draggable={false} /> : <div className="empty">Rendering close-up…</div>}</div>
        <div className="face-anim-controls">
          <ExpressionControls ids={chars} onChanged={onChanged} watch={stepTime} badge={(f) => (keyedHere.has(f) ? <span className="key-badge" title="Keyed at the playhead">◆</span> : null)} />

          <div className="face-card">
            <AudioPanel parts={['lipsync', 'face']} />
          </div>
        </div>
      </div>
      <FaceLanes id={id} chars={chars} />
    </div>
  );
}

/** Only this character's face tracks over the whole timeline: see the keys, jump to them, key a row. */
function FaceLanes({ id, chars }: { id: number; chars: number[] }) {
  const tracks = useStore((s) => s.tracks);
  const tl = useStore((s) => s.tl);
  const duration = tl?.duration ?? 10;
  const time = tl?.time ?? 0;
  const lane = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  useEffect(() => {
    const el = lane.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const x = (t: number) => (t / Math.max(0.001, duration)) * w;
  const tAt = (clientX: number) => {
    const r = lane.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    seekNow(tAt(e.clientX));
    const move = (ev: PointerEvent) => seekNow(tAt(ev.clientX));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <div className="face-lanes">
      <div className="face-lane-head">
        Face keys
        <Help text="Only this character's face tracks over the whole timeline. Click or drag a row to move the playhead, the key button keys that row at the playhead, right-click a key to delete it. The Timeline tab has the full dope sheet and curves." />
      </div>
      {FACE_ROWS.map((r) => {
        const t = faceTrack(tracks, id, r.model);
        return (
          <div key={r.model} className="face-lane-row">
            <span className="face-lane-label" title={t ? `${t.keys.length} keys` : 'No track yet — the first key creates it'}>
              {r.label}
            </span>
            <button className="btn icon face-lane-key" title={`Key ${r.label.toLowerCase()} at the playhead`} onClick={() => keyFace(chars, [r.model])}>
              <Icon name="key" size={11} />
            </button>
            <div className={`face-lane ${t ? '' : 'empty-lane'}`} ref={r.model === FACE_ROWS[0].model ? lane : undefined} onPointerDown={scrub}>
              {t?.keys.map(([kt]) => (
                <span
                  key={kt}
                  className={`face-key ${Math.abs(kt - time) < 1e-3 ? 'here' : ''}`}
                  style={{ left: x(kt) }}
                  title={`${kt.toFixed(2)}s — click to go there, right-click to delete`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (e.button === 0) seekNow(kt);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        { header: true, label: `${r.label} · ${kt.toFixed(2)}s` },
                        { label: 'Go to this key', action: () => seekNow(kt) },
                        { label: 'Delete key', danger: true, action: () => editTimeline('timeline.deleteKeys', { keys: [{ track: t.id, t: kt }] }) },
                      ],
                    });
                  }}
                />
              ))}
              <span className="face-playhead" style={{ left: x(time) }} />
            </div>
          </div>
        );
      })}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

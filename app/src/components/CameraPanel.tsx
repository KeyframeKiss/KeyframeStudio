import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { bridge } from '../bridge/client';
import { call, liveTime, refreshTimeline, seekNow, toast, useStore } from '../state/store';
import { CameraMoves } from './CameraMoves';
import { CameraModePanel, FrameGuidesPanel } from './CameraToolsCards';
import { Field } from './Page';
import { Slider } from './CharacterPanel';
import { Help } from './Help';
import { Icon } from './Icon';
import { pressable } from '../lib/pressable';

export interface CamState {
  slots: { index: number; used: boolean; fov: number; thumb?: string }[];
  cameras: { id: number; name: string; active: boolean }[];
  active: number;
  fov: number;
  timeline: boolean;
}
/** A camera key on the timeline (from camera.shots). */
export interface CamKey {
  t: number;
  cut: boolean;
  thumb?: string;
}

/** Studio's camera, its saved views and the camera keys — shared by the side column and the shot inspector. */
interface CamStore {
  st: CamState | null;
  keys: CamKey[];
  /** the saved views the camera is at right now (Studio doesn't say; the bridge compares) */
  active: number[];
}
export const useCam = create<CamStore>(() => ({ st: null, keys: [], active: [] }));

export function reloadCam() {
  call<CamState>('camera.get').then((s) => s && useCam.setState({ st: s }));
  call<CamKey[]>('camera.shots').then((k) => k && useCam.setState({ keys: k }));
}

/** Load the camera state while connected, follow scene changes, and poll which saved view the camera is at. */
export function useCamLoader() {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  useEffect(() => {
    if (status === 'open') reloadCam();
  }, [status, revision]);
  useEffect(() => {
    if (status !== 'open') return;
    let alive = true;
    const tick = () =>
      bridge
        .request<number[]>('camera.activeSlot')
        .then((i) => alive && useCam.setState({ active: i }))
        .catch(() => window.clearInterval(timer)); // an older bridge without it: no highlight
    const timer = window.setInterval(tick, 600);
    tick();
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [status]);
}

/** Key Studio's camera at the playhead (or `t`); `cut` makes it jump there. */
export async function keyCamera(cut: boolean, t = liveTime()) {
  const r = await call<{ created: number }>('camera.key', { t, cut });
  if (!r) return false;
  toast(cut ? 'Camera cut keyed — the camera jumps here' : r.created ? 'Camera tracks created and keyed' : 'Camera keyed');
  await refreshTimeline();
  reloadCam();
  return true;
}

/** Drag type for a saved view (dropped on a shot, it becomes that shot's camera). */
export const VIEW_DRAG = 'application/x-kf-view';

/** A collapsible section of the side column; open or closed is remembered. */
export function Fold({ id, title, help, actions, children, start = true }: { id: string; title: string; help?: string; actions?: ReactNode; children: ReactNode; start?: boolean }) {
  const key = `kf.fold.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? start : v === '1';
    } catch {
      return start;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? '0' : '1');
    } catch {
      /* storage blocked */
    }
  };
  return (
    <section className={`fold ${open ? 'open' : ''}`}>
      <header className="fold-head">
        <button className="fold-toggle" aria-expanded={open} onClick={toggle}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
          <b>{title}</b>
        </button>
        {help && <Help text={help} />}
        {actions && <div className="fold-actions">{actions}</div>}
      </header>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}

/** Shoot › Shots & camera, right-hand column: Studio's camera, its saved views, camera keys and moves, and the window tools. */
export function CameraSide() {
  useCamLoader();
  const { st, keys, active } = useCam();
  const fps = useStore((s) => s.tl?.fps ?? 60);
  const [preview, setPreview] = useState<string | null>(null);
  const snap = () => call<string>('camera.snapshot', { width: 360 }).then((p) => p && setPreview(p));

  if (!st) return <div className="empty">Loading cameras…</div>;

  return (
    <div className="cam-side">
      <Fold
        id="cam-view"
        title="Studio's camera"
        help="What Studio's camera sees now, and its lens"
        actions={
          <button className="btn small solid" onClick={snap} title="Show what Studio's camera sees">
            Snapshot
          </button>
        }
      >
        {preview ? <img {...pressable} className="cam-preview" src={preview} alt="Studio's view — press to refresh" onClick={snap} title="Click to refresh" /> : <div {...pressable} className="cam-preview empty-prev" onClick={snap}>Click Snapshot to see Studio's view here</div>}
        <Field label="Field of view">
          <Slider
            value={st.fov}
            min={10}
            max={90}
            step={0.5}
            onChange={(v) => {
              useCam.setState({ st: { ...st, fov: v } });
              bridge.request('camera.setFov', { fov: v }).catch(() => {});
            }}
          />
        </Field>
        {st.cameras.length > 0 && (
          <div>
            <div className="cam-sub">Scene cameras</div>
            {st.cameras.map((c) => (
              <div {...pressable} key={c.id} className={`model-row ${c.active ? 'selected' : ''}`} onClick={() => call<CamState>('camera.view', { id: c.active ? -1 : c.id }).then((r) => r && useCam.setState({ st: r }))}>
                <span className="plus">◉</span>
                <span className="name">{c.name}</span>
                <span className="sub">{c.active ? 'viewing — click to exit' : 'view through'}</span>
              </div>
            ))}
          </div>
        )}
      </Fold>

      <Fold id="cam-views" title="Saved views" help="Studio's views 1–10: click to go there, Save to store the current view. Drag a view onto a shot to give the shot that camera.">
        <div className="cam-slots">
          {st.slots.map((s) => (
            <div key={s.index} className={`cam-slot ${s.used ? '' : 'unused'} ${active.includes(s.index) ? 'active' : ''}`}>
              <button
                className="cam-slot-img"
                draggable={s.used}
                onDragStart={(e) => {
                  e.dataTransfer.setData(VIEW_DRAG, String(s.index));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                title={active.includes(s.index) ? `The camera is at view ${s.index + 1}` : s.used ? `Go to view ${s.index + 1} — or drag it onto a shot` : `View ${s.index + 1} is empty`}
                onClick={() => s.used && call('camera.loadSlot', { index: s.index }).then((ok) => ok && useCam.setState({ active: [...new Set([...useCam.getState().active, s.index])] }))}
              >
                {s.thumb && s.used ? <img src={s.thumb} alt="" draggable={false} /> : null}
                <i>{s.index + 1}</i>
              </button>
              <button
                className="cam-slot-save"
                title="Save Studio's current view into this slot"
                onClick={() => call<CamState>('camera.saveSlot', { index: s.index }).then((r) => r && (useCam.setState({ st: r, active: [...new Set([...useCam.getState().active, s.index])] }), toast(`Saved view ${s.index + 1}`)))}
              >
                Save
              </button>
            </div>
          ))}
        </div>
      </Fold>

      {st.timeline && (
        <Fold id="cam-keys" title="Camera keys" help="Frame the view in Studio, move the playhead, then key. Key camera glides from the previous key; Cut here jumps (an instant switch).">
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn primary" style={{ flex: 1 }} title="Key the main camera at the playhead (smooth move from the previous key)" onClick={() => keyCamera(false)}>
              Key camera
            </button>
            <button className="btn solid" style={{ flex: 1 }} title="Key the camera here and make it jump (no glide from the previous key)" onClick={() => keyCamera(true)}>
              ✂ Cut here
            </button>
          </div>
          <CamKeyList keys={keys} fps={fps} />
        </Fold>
      )}

      {st.timeline && (
        <Fold id="cam-moves" title="Camera moves" start={false} help="Orbit, dolly, zoom, pan, crane or truck from the camera as it is now, at the playhead. A shot set to camera keys has its own, across the shot.">
          <CameraMoves onDone={reloadCam} bare />
        </Fold>
      )}

      <Fold id="cam-mode" title="Camera mode" start={false}>
        <CameraModePanel />
      </Fold>
      <Fold id="cam-guides" title="Frame guides" start={false}>
        <FrameGuidesPanel />
      </Fold>
    </div>
  );
}

/** Camera keys as a list: click one to go there. */
export function CamKeyList({ keys, fps, empty = 'No camera keys yet.' }: { keys: CamKey[]; fps: number; empty?: string }) {
  return (
    <div className="cam-keys">
      {keys.map((s, i) => (
        <div {...pressable} key={s.t} className="model-row" style={{ padding: 4, gap: 8 }} onClick={() => seekNow(s.t)} title="Go to this camera key">
          {s.thumb ? <img src={s.thumb} alt="" className="cam-key-img" /> : <span className="cam-key-img">#{i + 1}</span>}
          <span className="name">
            {s.t.toFixed(2)}s <span className="sub">f{Math.round(s.t * fps)}</span>
          </span>
          <span className="sub" style={{ color: s.cut ? 'var(--accent)' : 'var(--text-3)' }}>{s.cut ? '✂ cut' : 'glide'}</span>
        </div>
      ))}
      {!keys.length && <div className="pn-note">{empty}</div>}
    </div>
  );
}

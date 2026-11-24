import { useEffect } from 'react';
import { create } from 'zustand';
import { bridge } from '../bridge/client';
import { call, liveTime, refreshTimeline, seekNow, toast, useStore } from '../state/store';
import { CameraMoves } from './CameraMoves';
import { CameraModePanel } from './CameraToolsCards';
import { Slider } from './CharacterPanel';
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

/** Studio's camera and the camera keys — shared by Shoot's Camera section, the shot track and the inspector. */
interface CamStore {
  st: CamState | null;
  keys: CamKey[];
}
export const useCam = create<CamStore>(() => ({ st: null, keys: [] }));

export function reloadCam() {
  call<CamState>('camera.get').then((s) => s && useCam.setState({ st: s }));
  call<CamKey[]>('camera.shots').then((k) => k && useCam.setState({ keys: k }));
}

/** Load the camera state while connected, and again whenever the timeline changes. */
export function useCamLoader() {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  useEffect(() => {
    if (status === 'open') reloadCam();
  }, [status, revision]);
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

/** Drag type for an angle (dropped on a shot it becomes the shot's camera; on the empty track, a new shot). */
export const ANGLE_DRAG = 'application/x-kf-angle';

/**
 * Shoot's Camera section (right column): Studio's own camera for work outside shots — its lens, camera keys at the playhead,
 * first person / follow, scene cameras and the camera move presets.
 */
export function CameraMenu() {
  const { st, keys } = useCam();
  const fps = useStore((s) => s.tl?.fps ?? 60);
  if (!st) return <div className="pn-note">Loading the camera…</div>;
  return (
    <div className="cam-menu">
      <div className="cam-menu-row">
        <span>Lens</span>
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
      </div>
      {st.timeline && (
        <>
          <div className="cam-menu-h">Camera keys</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn small primary" style={{ flex: 1 }} title="Key Studio's camera at the playhead (it glides from the previous key)" onClick={() => keyCamera(false)}>
              Key camera
            </button>
            <button className="btn small solid" style={{ flex: 1 }} title="Key it and make it jump there" onClick={() => keyCamera(true)}>
              ✂ Cut here
            </button>
          </div>
          <CamKeyList keys={keys} fps={fps} />
        </>
      )}
      <div className="cam-menu-h">Camera mode</div>
      <CameraModePanel />
      {st.cameras.length > 0 && (
        <>
          <div className="cam-menu-h">Scene cameras</div>
          {st.cameras.map((c) => (
            <div {...pressable} key={c.id} className={`model-row ${c.active ? 'selected' : ''}`} onClick={() => call<CamState>('camera.view', { id: c.active ? -1 : c.id }).then((r) => r && useCam.setState({ st: r }))}>
              <span className="plus">◉</span>
              <span className="name">{c.name}</span>
              <span className="sub">{c.active ? 'viewing — click to exit' : 'view through'}</span>
            </div>
          ))}
        </>
      )}
      {st.timeline && (
        <details className="cam-menu-moves">
          <summary>Camera moves at the playhead</summary>
          <CameraMoves onDone={reloadCam} bare />
        </details>
      )}
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

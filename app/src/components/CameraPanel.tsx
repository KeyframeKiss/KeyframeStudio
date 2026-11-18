import { useCallback, useEffect, useState } from 'react';
import { Help } from './Help';
import { bridge } from '../bridge/client';
import { call, liveTime, refreshTimeline, seekNow, toast, useStore } from '../state/store';
import { CameraMoves } from './CameraMoves';
import { CameraToolsCards } from './CameraToolsCards';
import { Slider } from './CharacterPanel';

import { pressable } from '../lib/pressable';
interface CamState {
  slots: { index: number; used: boolean; fov: number; thumb?: string }[];
  cameras: { id: number; name: string; active: boolean }[];
  active: number;
  fov: number;
  timeline: boolean;
}
interface Shot {
  t: number;
  cut: boolean;
  thumb?: string;
}

export function CameraPanel() {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  const fps = useStore((s) => s.tl?.fps ?? 60);
  const [st, setSt] = useState<CamState | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  // the saved views the camera is at right now (Studio doesn't say; the bridge compares)
  const [active, setActive] = useState<number[]>([]);
  useEffect(() => {
    if (status !== 'open') return;
    let alive = true;
    const tick = () =>
      bridge
        .request<number[]>('camera.activeSlot')
        .then((i) => alive && setActive(i))
        .catch(() => window.clearInterval(timer)); // an older bridge without it: no highlight
    const timer = window.setInterval(tick, 600);
    tick();
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [status]);

  const load = useCallback(() => {
    call<CamState>('camera.get').then((s) => s && setSt(s));
    call<Shot[]>('camera.shots').then((s) => s && setShots(s));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, revision, load]);

  const snap = () => call<string>('camera.snapshot', { width: 360 }).then((p) => p && setPreview(p));

  const key = async (cut: boolean) => {
    const r = await call<{ created: number }>('camera.key', { t: liveTime(), cut });
    if (!r) return;
    toast(cut ? 'Camera cut keyed — the camera jumps here' : r.created ? 'Camera tracks created and keyed' : 'Camera keyed');
    await refreshTimeline();
    load();
  };

  if (!st) return <div className="empty">Loading cameras…</div>;

  return (
    <div className="cam-grid">
      <div className="look-card">
        <div className="look-card-head">
          <div>
            <b>
              View
              <Help text="Studio's camera now" />
            </b>
          </div>
          <button className="btn small solid" onClick={snap} title="Show what Studio's camera sees">
            Snapshot
          </button>
        </div>
        <div className="look-card-body">
          {preview ? <img className="cam-preview" src={preview} alt="" onClick={snap} title="Click to refresh" /> : <div className="cam-preview empty-prev" onClick={snap}>Click Snapshot to see Studio's view here</div>}
          <div className="kv" style={{ marginTop: 8 }}>
            <label>Field of view</label>
            <Slider
              value={st.fov}
              min={10}
              max={90}
              step={0.5}
              onChange={(v) => {
                setSt({ ...st, fov: v });
                bridge.request('camera.setFov', { fov: v }).catch(() => {});
              }}
            />
          </div>
          {st.cameras.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="cam-sub">Scene cameras</div>
              {st.cameras.map((c) => (
                <div {...pressable} key={c.id} className={`model-row ${c.active ? 'selected' : ''}`} onClick={() => call<CamState>('camera.view', { id: c.active ? -1 : c.id }).then((r) => r && setSt(r))}>
                  <span className="plus">◉</span>
                  <span className="name">{c.name}</span>
                  <span className="sub">{c.active ? 'viewing — click to exit' : 'view through'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="look-card">
        <div className="look-card-head">
          <div>
            <b>
              Saved views
              <Help text="Studio's views 1–10: click to go there, Save to store the current view" />
            </b>
          </div>
        </div>
        <div className="look-card-body">
          <div className="cam-slots">
            {st.slots.map((s) => (
              <div key={s.index} className={`cam-slot ${s.used ? '' : 'unused'} ${active.includes(s.index) ? 'active' : ''}`}>
                <button
                  className="cam-slot-img"
                  title={active.includes(s.index) ? `The camera is at view ${s.index + 1}` : s.used ? `Go to view ${s.index + 1}` : `View ${s.index + 1} is empty`}
                  onClick={() => s.used && call('camera.loadSlot', { index: s.index }).then((ok) => ok && setActive((x) => [...new Set([...x, s.index])]))}
                >
                  {s.thumb && s.used ? <img src={s.thumb} alt="" /> : null}
                  <i>{s.index + 1}</i>
                </button>
                <button
                  className="cam-slot-save"
                  title="Save Studio's current view into this slot"
                  onClick={() => call<CamState>('camera.saveSlot', { index: s.index }).then((r) => r && (setSt(r), setActive((x) => [...new Set([...x, s.index])]), toast(`Saved view ${s.index + 1}`)))}
                >
                  Save
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {st.timeline && (
        <div className="look-card">
          <div className="look-card-head">
            <div>
              <b>
                Camera keys
                <Help text="Frame the shot in Studio, move the playhead, then key. Key camera glides from the previous key; Cut here jumps (an instant switch)." />
              </b>
            </div>
          </div>
          <div className="look-card-body">
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn primary" style={{ flex: 1 }} title="Key the main camera at the playhead (smooth move from the previous key)" onClick={() => key(false)}>
                Key camera
              </button>
              <button className="btn solid" style={{ flex: 1 }} title="Key the camera here and make it jump (no glide from the previous key)" onClick={() => key(true)}>
                ✂ Cut here
              </button>
            </div>
            <div className="cam-keys">
              {shots.map((s, i) => (
                <div {...pressable} key={s.t} className="model-row" style={{ padding: 4, gap: 8 }} onClick={() => seekNow(s.t)} title="Go to this camera key">
                  {s.thumb ? <img src={s.thumb} alt="" className="cam-key-img" /> : <span className="cam-key-img">#{i + 1}</span>}
                  <span className="name">
                    {s.t.toFixed(2)}s <span className="sub">f{Math.round(s.t * fps)}</span>
                  </span>
                  <span className="sub" style={{ color: s.cut ? 'var(--accent)' : 'var(--text-3)' }}>{s.cut ? '✂ cut' : 'glide'}</span>
                </div>
              ))}
              {!shots.length && <div className="hint">No camera keys yet.</div>}
            </div>
          </div>
        </div>
      )}

      {st.timeline && <CameraMoves onDone={load} />}
      <CameraToolsCards />
    </div>
  );
}

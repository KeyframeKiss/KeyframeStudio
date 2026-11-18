import { useCallback, useEffect, useState } from 'react';
import { bridge } from '../bridge/client';
import { call, liveTime, refreshTimeline, seekNow, toast, useStore } from '../state/store';
import { CameraMoves } from './CameraMoves';
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
    <div className="panel-body">
      <div className="section">
        <h3>
          Viewport <span className="spacer" />
          <button className="btn" style={{ height: 20, fontSize: 10 }} onClick={snap}>
            Snapshot
          </button>
        </h3>
        {preview ? (
          <img src={preview} alt="" style={{ width: '100%', borderRadius: 6, display: 'block' }} />
        ) : (
          <div className="hint" style={{ marginTop: 0 }}>
            Click Snapshot to preview Studio's current camera here.
          </div>
        )}
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
      </div>

      <div className="section">
        <h3>Saved views (Studio's 1–10)</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 6 }}>
          {st.slots.map((s) => (
            <div key={s.index} style={{ position: 'relative', borderRadius: 6, overflow: 'hidden', background: 'var(--bg-2)', border: '1px solid var(--line)' }}>
              <button
                className="btn"
                style={{ width: '100%', height: 54, padding: 0, borderRadius: 0, display: 'block', opacity: s.used ? 1 : 0.5 }}
                title={s.used ? `Go to view ${s.index + 1}` : `View ${s.index + 1} is empty`}
                onClick={() => s.used && call('camera.loadSlot', { index: s.index })}
              >
                {s.thumb && s.used ? (
                  <img src={s.thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ fontSize: 18, fontWeight: 700, color: s.used ? 'var(--text-1)' : 'var(--text-3)' }}>{s.index + 1}</span>
                )}
              </button>
              <div style={{ display: 'flex', alignItems: 'center', padding: '2px 4px', gap: 4 }}>
                <span className="sub" style={{ flex: 1, color: 'var(--text-3)', fontSize: 10 }}>
                  {s.index + 1} {s.used ? '' : '· empty'}
                </span>
                <button
                  className="btn"
                  style={{ height: 18, fontSize: 10, padding: '0 6px' }}
                  title="Save Studio's current view into this slot"
                  onClick={() => call<CamState>('camera.saveSlot', { index: s.index }).then((r) => r && (setSt(r), toast(`Saved view ${s.index + 1}`)))}
                >
                  Save
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {st.timeline && (
        <div className="section">
          <h3>Camera animation</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn primary" style={{ flex: 1 }} title="Key the main camera at the playhead (smooth move from the previous key)" onClick={() => key(false)}>
              Key camera
            </button>
            <button className="btn solid" style={{ flex: 1 }} title="Key the camera here and make it jump (no glide from the previous key)" onClick={() => key(true)}>
              ✂ Cut here
            </button>
          </div>
          <div className="hint">Frame the shot in Studio, move the playhead, then Key (smooth) or Cut (instant switch).</div>
          <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
            {shots.map((s, i) => (
              <div {...pressable} key={s.t} className="model-row" style={{ padding: 4, gap: 8 }} onClick={() => seekNow(s.t)} title="Go to this camera key">
                {s.thumb ? (
                  <img src={s.thumb} alt="" style={{ width: 64, height: 36, objectFit: 'cover', borderRadius: 4, flex: 'none' }} />
                ) : (
                  <span style={{ width: 64, height: 36, borderRadius: 4, background: 'var(--bg-0)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', flex: 'none' }}>
                    #{i + 1}
                  </span>
                )}
                <span className="name">
                  {s.t.toFixed(2)}s <span className="sub">f{Math.round(s.t * fps)}</span>
                </span>
                <span className="sub" style={{ color: s.cut ? 'var(--accent)' : 'var(--text-3)' }}>{s.cut ? '✂ cut' : 'glide'}</span>
              </div>
            ))}
            {!shots.length && <div className="hint">No camera keys yet.</div>}
          </div>
        </div>
      )}

      {st.timeline && <CameraMoves onDone={load} />}

      {st.cameras.length > 0 && (
        <div className="section">
          <h3>Scene cameras</h3>
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
  );
}

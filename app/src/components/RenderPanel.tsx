import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { call, toast, useStore } from '../state/store';

interface RenderStatus {
  recording: boolean;
  encoding: boolean;
  frame: number;
  frameLimit: number;
  message: string;
  progress: number;
  outputFolder: string;
  framesFolder: string;
  settings: { fps: number; exportFps: number; limit: string; limitNumber: number; format: string; resize: boolean; width: number; height: number; autoEncode: boolean; deleteFrames: boolean; prewarm: number };
  limits: string[];
  formats: string[];
}

const SIZES: { label: string; w?: number; h?: number }[] = [
  { label: 'Window size' },
  { label: '720p', w: 1280, h: 720 },
  { label: '1080p', w: 1920, h: 1080 },
  { label: '1440p', w: 2560, h: 1440 },
  { label: '4K', w: 3840, h: 2160 },
  { label: 'Square', w: 1080, h: 1080 },
  { label: 'Vertical', w: 1080, h: 1920 },
];

/** Render the timeline to a video (or frames) through the installed VideoExport plugin. */
export function RenderPanel() {
  const status = useStore((s) => s.status);
  const hello = useStore((s) => s.hello);
  const tl = useStore((s) => s.tl);
  const [st, setSt] = useState<RenderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef(0);
  const feature = hello?.features?.find((f) => f.id === 'render');

  const load = useCallback(async () => {
    try {
      const r = await bridge.request<RenderStatus>('render.status');
      setSt(r);
      setError(null);
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load]);

  // while recording or encoding, follow progress
  const busy = !!st && (st.recording || st.encoding);
  useEffect(() => {
    if (!busy) return;
    poll.current = window.setInterval(async () => {
      const r = await load();
      if (r && !r.recording && !r.encoding) toast(r.message || 'Render finished');
    }, 1000);
    return () => window.clearInterval(poll.current);
  }, [busy, load]);

  const set = async (patch: Record<string, unknown>) => {
    const r = await call<RenderStatus>('render.set', patch);
    if (r) setSt(r);
  };
  const start = async () => {
    const r = await call<RenderStatus>('render.start', {});
    if (r) {
      setSt(r);
      toast('Rendering — Studio plays the timeline and captures every frame. Leave it alone until it finishes.');
    }
  };

  if (feature && feature.status !== 'ok' && feature.status !== 'untested')
    return (
      <div className="empty">
        <strong>Render needs VideoExport</strong>
        {feature.reason}
      </div>
    );
  if (error) return <div className="empty">{error}</div>;
  if (!st) return <div className="empty">Loading…</div>;
  const s = st.settings;
  const size = s.resize ? SIZES.find((x) => x.w === s.width && x.h === s.height)?.label ?? 'Custom' : 'Window size';
  // VideoExport's number means loops in Timeline mode, seconds in Seconds mode, frames in Frames mode
  const frames = s.limit === 'Timeline' && tl ? Math.round(tl.duration * Math.max(1, s.limitNumber) * s.fps) : s.limit === 'Seconds' ? Math.round(s.limitNumber * s.fps) : s.limit === 'Frames' ? s.limitNumber : null;

  return (
    <div className="panel-body render">
      <div className="section">
        <h3>Render video</h3>
        <div className="cleanup-row">
          <span>Size</span>
          <select className="input" value={size} disabled={busy} onChange={(e) => {
            const p = SIZES.find((x) => x.label === e.target.value);
            if (p) set(p.w ? { resize: true, width: p.w, height: p.h } : { resize: false });
          }}>
            {SIZES.map((x) => (
              <option key={x.label} value={x.label}>
                {x.label}
                {x.w ? ` (${x.w}×${x.h})` : ''}
              </option>
            ))}
            {size === 'Custom' && <option value="Custom">Custom ({s.width}×{s.height})</option>}
          </select>
        </div>
        <div className="cleanup-row">
          <span>Frame rate</span>
          <div className="seg">
            {[24, 30, 60].map((f) => (
              <button key={f} className={s.fps === f ? 'on' : ''} disabled={busy} onClick={() => set({ fps: f })}>
                {f}
              </button>
            ))}
          </div>
        </div>
        <div className="cleanup-row">
          <span>Format</span>
          <div className="seg">
            {st.formats.map((f) => (
              <button key={f} className={s.format === f ? 'on' : ''} disabled={busy} onClick={() => set({ format: f })}>
                {f}
              </button>
            ))}
          </div>
        </div>
        <div className="cleanup-row">
          <span>Length</span>
          <div className="seg">
            <button className={s.limit === 'Timeline' ? 'on' : ''} disabled={busy || !st.limits.includes('Timeline')} onClick={() => set({ limit: 'Timeline', limitNumber: 1 })} title="The whole timeline, once">
              Timeline
            </button>
            <button className={s.limit === 'Seconds' ? 'on' : ''} disabled={busy} onClick={() => set({ limit: 'Seconds', limitNumber: s.limitNumber > 0 ? s.limitNumber : 5 })}>
              Seconds
            </button>
            <button className={s.limit === 'none' ? 'on' : ''} disabled={busy} onClick={() => set({ limit: 'none' })} title="Until you press Stop">
              Until stop
            </button>
          </div>
        </div>
        {s.limit === 'Seconds' && (
          <div className="cleanup-row">
            <span />
            <input className="input mono" type="number" min={0.5} step={0.5} value={s.limitNumber} disabled={busy} onChange={(e) => set({ limitNumber: Number(e.target.value) || 1 })} style={{ width: 80 }} />
            <span className="hint" style={{ margin: 0 }}>
              s
            </span>
          </div>
        )}
        <div className="cleanup-row">
          <span>Warm-up</span>
          <div className="seg" title="Plays the timeline this many times first so hair and clothes physics settle (Timeline length only)">
            {[0, 1, 2, 3].map((n) => (
              <button key={n} className={s.prewarm === n ? 'on' : ''} disabled={busy} onClick={() => set({ prewarm: n })}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <label className="rigs-opt">
          <input type="checkbox" checked={s.autoEncode} disabled={busy} onChange={(e) => set({ autoEncode: e.target.checked })} /> Make the video when done
        </label>
        <label className="rigs-opt" style={{ marginTop: 0 }}>
          <input type="checkbox" checked={s.deleteFrames} disabled={busy} onChange={(e) => set({ deleteFrames: e.target.checked })} /> Delete the frame images afterwards
        </label>
        {busy ? (
          <>
            <div className="render-progress">
              <span style={{ width: `${Math.round((st.frameLimit > 0 ? st.frame / st.frameLimit : st.progress) * 100)}%` }} />
            </div>
            <div className="hint">{st.message || (st.recording ? `Frame ${st.frame}${st.frameLimit > 0 ? ` of ${st.frameLimit}` : ''}` : 'Encoding…')}</div>
            <button className="btn solid wide" onClick={() => call<RenderStatus>('render.stop').then((r) => r && setSt(r))}>
              Stop
            </button>
          </>
        ) : (
          <button className="btn primary wide" onClick={start} title="Studio plays the timeline from the start and captures every frame from the current camera">
            Render{frames ? ` (${frames} frames)` : ''}
          </button>
        )}
      </div>
      <div className="section">
        <h3>Output</h3>
        <div className="hint" style={{ marginTop: 0, wordBreak: 'break-all' }}>
          {st.outputFolder}
        </div>
        {window.studioEx?.openFolder && (
          <button className="btn solid wide" onClick={() => window.studioEx?.openFolder?.(st.outputFolder)}>
            Open output folder
          </button>
        )}
        <div className="hint">Uses VideoExport (Ctrl+E in Studio for its full settings). Renders what Studio's camera sees, at the size above.</div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Help } from './Help';
import { call, liveTime, refreshAudio, seekNow, showTab, toast, useStore } from '../state/store';
import { Slider } from './CharacterPanel';

/**
 * Shoot › Audio: the scene's audio track — the file, where it starts on the timeline, volume — with its
 * waveform laid over the timeline. It plays with the timeline and is saved with the scene.
 */
export function AudioPage() {
  const status = useStore((s) => s.status);
  const audio = useStore((s) => s.audio);
  const [files, setFiles] = useState<{ file: string; size: number }[]>([]);

  // the folder can change any time (files copied in by hand): re-read it when the list is opened
  const loadFiles = () => call<{ file: string; size: number }[]>('audio.files').then((f) => f && setFiles(f));
  useEffect(() => {
    if (status !== 'open') return;
    loadFiles();
    refreshAudio();
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async (fileOrPath: string) => {
    const r = await call('audio.load', { file: fileOrPath, offset: audio?.offset ?? 0 });
    if (!r) return;
    await refreshAudio();
    loadFiles();
    toast('Audio loaded — it plays with the timeline and is saved with the scene');
  };
  const browse = async () => {
    const p = await window.studioEx?.openAudio?.();
    if (p) load(p);
  };
  const setA = async (patch: Record<string, unknown>) => {
    await call('audio.set', patch);
    refreshAudio();
  };

  return (
    <div className="render-page">
      <div className="look-card">
        <div className="look-card-head">
          <div>
            <b>
              Audio track
              <Help text="A WAV that plays with the timeline (Space) and is saved with the scene" />
            </b>
          </div>
          {audio && (
            <button className="btn small" onClick={() => call('audio.clear').then(refreshAudio)} title="Remove the audio from this scene">
              Remove
            </button>
          )}
        </div>
        <div className="look-card-body">
          <div className="audio-file">
            <select className="input" value={audio?.file ?? ''} onMouseDown={loadFiles} onFocus={loadFiles} onChange={(e) => e.target.value && load(e.target.value)}>
              <option value="">{files.length ? '— choose a file from UserData/audio —' : 'No WAV files in UserData/audio yet'}</option>
              {files.map((f) => (
                <option key={f.file} value={f.file}>
                  {f.file}
                </option>
              ))}
            </select>
            {window.studioEx?.openAudio && (
              <button className="btn solid" onClick={browse} title="Pick a WAV anywhere; it's copied into UserData/audio so the scene can find it">
                Browse…
              </button>
            )}
          </div>
          {audio ? <Waveform /> : <div className="audio-empty">Choose a WAV to see its waveform on the timeline.</div>}
        </div>
      </div>

      {audio && (
        <div className="render-grid">
          <div className="look-card">
            <div className="look-card-head">
              <div>
                <b>
                  Timing
                  <Help text="Where the audio starts on the timeline" />
                </b>
              </div>
            </div>
            <div className="look-card-body">
              <div className="cleanup-row">
                <span>Starts at</span>
                <input className="input mono" type="number" step={0.05} value={audio.offset} onChange={(e) => setA({ offset: Number(e.target.value) || 0 })} style={{ width: 90 }} />
                <span className="hint" style={{ margin: 0 }}>
                  s
                </span>
                <button className="btn small solid" onClick={() => setA({ offset: Math.round(liveTime() * 1000) / 1000 })} title="Start the audio at the playhead">
                  At playhead
                </button>
                <button className="btn small" onClick={() => setA({ offset: 0 })}>
                  At 0
                </button>
              </div>
              <AudioFit />
            </div>
          </div>
          <div className="look-card">
            <div className="look-card-head">
              <div>
                <b>
                  Volume
                  <Help text="How loud it plays in Studio while you animate" />
                </b>
              </div>
            </div>
            <div className="look-card-body">
              <div className="cleanup-row">
                <span>Volume</span>
                <Slider value={audio.volume} min={0} max={1} step={0.05} onChange={(v) => setA({ volume: v })} />
              </div>
              <label className="rigs-opt" style={{ margin: 0 }}>
                <input type="checkbox" checked={audio.muted} onChange={(e) => setA({ muted: e.target.checked })} /> Mute while animating
              </label>
            </div>
          </div>
          <div className="look-card">
            <div className="look-card-head">
              <div>
                <b>
                  Lip-sync
                  <Help text="Mouth keys from this audio, with A / I / U / E / O shapes. It's with the face controls (Animate › Face) so you can see and fix the result in one place: select the character who speaks, then Generate lip-sync." />
                </b>
              </div>
              <button className="btn small solid" onClick={() => showTab('animate', 'face')}>
                Animate › Face ›
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Whether the audio fits in the timeline. */
function AudioFit() {
  const audio = useStore((s) => s.audio);
  const tl = useStore((s) => s.tl);
  if (!audio || !tl) return null;
  const end = audio.offset + audio.duration;
  return (
    <div className="hint" style={{ margin: 0 }}>
      {audio.duration.toFixed(1)} s long, plays {audio.offset.toFixed(2)}–{end.toFixed(2)} s.
      {end > tl.duration + 0.01 ? ` The timeline is ${tl.duration.toFixed(1)} s — make it longer to hear the end.` : ''}
    </div>
  );
}

/** The audio's waveform over the whole timeline, with the playhead; click or drag to move the playhead. */
function Waveform() {
  const audio = useStore((s) => s.audio);
  const peaks = useStore((s) => s.audioPeaks);
  const tl = useStore((s) => s.tl);
  const ref = useRef<HTMLCanvasElement>(null);
  const duration = Math.max(0.1, tl?.duration ?? 10);
  const time = tl?.time ?? 0;

  useEffect(() => {
    const c = ref.current;
    if (!c || !audio || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth,
      h = c.clientHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(c);
    // the audio's span on the timeline
    const x0 = (audio.offset / duration) * w,
      x1 = ((audio.offset + audio.duration) / duration) * w;
    g.fillStyle = css.getPropertyValue('--wave-bg') || 'rgba(255,255,255,0.04)';
    g.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    g.fillStyle = css.getPropertyValue('--wave') || '#ff9f2e';
    const mid = h / 2;
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, x1); x++) {
      const t0 = ((x / w) * duration - audio.offset) * peaks.perSecond,
        t1 = (((x + 1) / w) * duration - audio.offset) * peaks.perSecond;
      let p = 0;
      for (let i = Math.max(0, Math.floor(t0)); i < Math.min(peaks.peaks.length, Math.ceil(t1)); i++) p = Math.max(p, peaks.peaks[i]);
      const a = Math.max(1, p * (h / 2 - 2));
      g.fillRect(x, mid - a, 1, a * 2);
    }
  }, [audio, peaks, duration]);

  const seekAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seekNow(Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration)));
  };
  return (
    <div
      className="waveform"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e);
      }}
      onPointerMove={(e) => e.buttons & 1 && seekAt(e)}
      title="Click or drag to move the playhead"
    >
      <canvas ref={ref} />
      <span className="waveform-playhead" style={{ left: `${(time / duration) * 100}%` }} />
      <span className="waveform-scale">
        <span>0 s</span>
        <span>{duration.toFixed(1)} s</span>
      </span>
    </div>
  );
}

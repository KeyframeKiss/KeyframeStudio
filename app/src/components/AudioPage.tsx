import { useEffect, useRef, useState } from 'react';
import { Field, Page, Panel, Section } from './Page';
import { addAudio, call, listenAudio, liveTime, pickAudio, refreshAudio, removeAudio, seekNow, setAudio, showTab, useStore, type AudioClipInfo } from '../state/store';
import { laneRgb, loudest } from '../lib/audioLanes';
import { Slider } from './CharacterPanel';

/**
 * Shoot › Audio: the scene's audio clips — dialogue, music, effects — each with where it starts on the timeline,
 * its volume and mute, over one overview of the timeline. They play with the timeline and are saved with the
 * scene; the same clips are lanes at the top of Animate › Timeline.
 */
export function AudioPage() {
  const status = useStore((s) => s.status);
  const clips = useStore((s) => s.audio);
  const [files, setFiles] = useState<{ file: string; size: number }[]>([]);

  // the folder can change any time (files copied in by hand): re-read it when the list is opened
  const loadFiles = () => call<{ file: string; size: number }[]>('audio.files').then((f) => f && setFiles(f));
  useEffect(() => {
    if (status !== 'open') return;
    loadFiles();
    refreshAudio();
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const playWithAnimation = async () => {
    if (!clips.length) return;
    await listenAudio(null);
    seekNow(Math.max(0, Math.min(...clips.map((c) => c.offset))));
    call('timeline.play');
  };
  const at = () => Math.round(liveTime() * 1000) / 1000;

  return (
    <Page max={1100}>
      <Section
        title="Audio"
        help="WAV clips that play with the timeline (Space) and are saved with the scene — voices, music, effects, as many as you like. They're also lanes at the top of Animate › Timeline, where you can drag them, listen and mute, and you can drop a WAV straight onto the timeline."
        actions={
          <>
            <select
              className="input"
              style={{ width: 230 }}
              value=""
              onMouseDown={loadFiles}
              onFocus={loadFiles}
              onChange={(e) => {
                if (e.target.value) addAudio(e.target.value, at());
                e.target.value = '';
              }}
              title="Add a WAV from UserData/audio, starting at the playhead"
            >
              <option value="">{files.length ? '+ Add from UserData/audio…' : 'No WAV files in UserData/audio yet'}</option>
              {files.map((f) => (
                <option key={f.file} value={f.file}>
                  {f.file}
                </option>
              ))}
            </select>
            {window.studioEx?.openAudio && (
              <button className="btn primary" onClick={() => pickAudio(at()).then((ok) => void (ok && loadFiles()))} title="Pick a WAV anywhere; it's copied into UserData/audio so the scene can find it. It starts at the playhead.">
                + Add a WAV…
              </button>
            )}
          </>
        }
      >
        {clips.length ? <Overview /> : <div className="audio-empty">No audio yet — add a WAV above, or drop one onto Animate › Timeline where it should start.</div>}
        {clips.length > 0 && (
          <div className="audio-transport">
            <button className="btn solid" onClick={playWithAnimation} title="Move the playhead to where the first clip starts and play the timeline">
              ▶ Play with the animation
            </button>
            <span className="pn-note">
              {clips.length} clip{clips.length > 1 ? 's' : ''} · they play in Studio · lip-sync is in{' '}
              <button className="link-btn" onClick={() => showTab('animate', 'face')}>
                Animate › Face
              </button>
            </span>
          </div>
        )}
      </Section>

      {clips.length > 0 && (
        <div className="audio-clips">
          {clips.map((c, i) => (
            <ClipPanel key={c.id} clip={c} index={i} />
          ))}
        </div>
      )}
    </Page>
  );
}

/** One clip: listen, where it starts, volume, mute, swap, remove. */
function ClipPanel({ clip: c, index }: { clip: AudioClipInfo; index: number }) {
  const listen = useStore((s) => (s.audioListen?.id === c.id ? s.audioListen.at : null));
  const tl = useStore((s) => s.tl);
  const end = c.offset + c.duration;
  return (
    <Panel
      className="audio-clip"
      title={
        <span className="audio-clip-name" style={{ ['--lane' as string]: `rgb(${laneRgb(index)})` }} title={c.file}>
          {c.file}
        </span>
      }
      actions={
        <>
          <button className={`btn small ${listen != null ? 'on' : 'solid'}`} onClick={() => listenAudio(listen != null ? null : c.id, 0)} title="Studio plays this clip by itself (the animation doesn't move)">
            {listen != null ? `■ ${listen.toFixed(1)} s` : '▶ Listen'}
          </button>
          {window.studioEx?.openAudio && (
            <button className="btn small" onClick={() => pickAudio(0, c.id)} title="Swap this clip's WAV, keeping where it starts">
              Replace…
            </button>
          )}
          <button className="btn small" onClick={() => removeAudio(c.id)} title="Remove this clip from the scene">
            ✕
          </button>
        </>
      }
    >
      <Field label="Starts at (s)">
        <input className="input mono" type="number" step={0.05} value={c.offset} onChange={(e) => setAudio(c.id, { offset: Number(e.target.value) || 0 })} style={{ width: 76, flex: 'none' }} />
        <button className="btn small solid" onClick={() => setAudio(c.id, { offset: Math.round(liveTime() * 1000) / 1000 })} title="Start this clip at the playhead">
          At playhead
        </button>
        <button className="btn small solid" onClick={() => setAudio(c.id, { offset: 0 })} title="Start this clip at 0 s">
          At 0
        </button>
      </Field>
      <Field label="Volume">
        <Slider value={c.volume} min={0} max={1} step={0.05} onChange={(v) => setAudio(c.id, { volume: v })} />
      </Field>
      <label className="rigs-opt" style={{ margin: 0 }}>
        <input type="checkbox" checked={c.muted} onChange={(e) => setAudio(c.id, { muted: e.target.checked })} /> Mute while animating
      </label>
      <div className="pn-note">
        {c.duration.toFixed(1)} s long, plays {c.offset.toFixed(2)}–{end.toFixed(2)} s.
        {tl && end > tl.duration + 0.01 ? ` The timeline is ${tl.duration.toFixed(1)} s — make it longer to hear the end.` : ''}
      </div>
    </Panel>
  );
}

/** Every clip's waveform on its own row over the whole timeline, with the playhead; click or drag to move it. */
function Overview() {
  const clips = useStore((s) => s.audio);
  const peaks = useStore((s) => s.audioPeaks);
  const listen = useStore((s) => s.audioListen);
  const tl = useStore((s) => s.tl);
  const ref = useRef<HTMLCanvasElement>(null);
  const duration = Math.max(0.1, tl?.duration ?? 10);
  const time = tl?.time ?? 0;
  const rowH = clips.length > 3 ? 26 : clips.length > 1 ? 36 : 70;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth,
      h = c.clientHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    clips.forEach((clip, li) => {
      const pk = peaks[clip.id];
      const y0 = li * rowH;
      const rgb = laneRgb(li);
      const x0 = (clip.offset / duration) * w,
        x1 = ((clip.offset + clip.duration) / duration) * w;
      g.fillStyle = `rgba(${rgb},${clip.muted ? 0.04 : 0.1})`;
      g.fillRect(x0, y0 + 2, Math.max(1, x1 - x0), rowH - 4);
      if (!pk) return;
      g.fillStyle = `rgba(${rgb},${clip.muted ? 0.3 : 0.9})`;
      const mid = y0 + rowH / 2,
        half = (rowH / 2 - 4) / loudest(pk);
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, x1); x++) {
        const t0 = ((x / w) * duration - clip.offset) * pk.perSecond,
          t1 = (((x + 1) / w) * duration - clip.offset) * pk.perSecond;
        let p = 0;
        for (let i = Math.max(0, Math.floor(t0)); i < Math.min(pk.peaks.length, Math.ceil(t1)); i++) p = Math.max(p, pk.peaks[i]);
        const a = Math.max(0.5, p * half);
        g.fillRect(x, mid - a, 1, a * 2);
      }
    });
  }, [clips, peaks, duration, rowH]);

  const seekAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seekNow(Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration)));
  };
  const listening = listen && clips.find((c) => c.id === listen.id);
  return (
    <div
      className="waveform"
      style={{ height: clips.length * rowH + 16 }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e);
      }}
      onPointerMove={(e) => e.buttons & 1 && seekAt(e)}
      title="Click or drag to move the playhead"
    >
      <canvas ref={ref} />
      <span className="waveform-playhead" style={{ left: `${(time / duration) * 100}%` }} />
      {listen && listening && <span className="waveform-listen" style={{ left: `${(Math.min(duration, listening.offset + listen.at) / duration) * 100}%` }} />}
      <span className="waveform-scale">
        <span>0 s</span>
        <span>{duration.toFixed(1)} s</span>
      </span>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { SwitchCard } from './EditorBits';
import { Page, Panel, Section } from './Page';
import { Help } from './Help';
import { DragNumber } from './DragNumber';
import { addAudio, audioName, call, listenAudio, liveTime, pickAudio, refreshAudio, removeAudio, seekNow, setAudio, setAudioDelay, showTab, useStore, type AudioClipInfo } from '../state/store';
import { clipSpan, fadeAt, fileTimeAt, laneRgb, loudest, timelineTimeAt } from '../lib/audioLanes';
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
        {clips.length > 0 && <DelayRow />}
        {clips.length > 0 && (
          <div className="audio-transport">
            <button className="btn solid" onClick={playWithAnimation} title="Move the playhead to where the first clip starts and play the timeline">
              ▶ Play with the animation
            </button>
            <span className="pn-note">
              {clips.length} clip{clips.length > 1 ? 's' : ''} · they play in Studio · lip-sync is in{' '}
              <button className="btn small solid" onClick={() => showTab('animate', 'face')}>
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

/** This PC's output delay: Bluetooth headphones are heard late, so Studio plays the audio early to match the picture. */
function DelayRow() {
  const d = useStore((s) => s.audioDelay);
  const [ms, setMs] = useState(d.output);
  useEffect(() => setMs(d.output), [d.output]);
  const timer = useRef(0);
  const change = (v: number) => {
    setMs(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAudioDelay(v), 200);
  };
  return (
    <div className="audio-delay">
      <span className="audio-delay-label">
        Headphone delay
        <Help text={`If the sound comes late while the timeline plays — lips and audio out of step — set how late. Bluetooth headphones and speakers are typically 150–500 ms; wired ones need 0. Studio then plays the audio that much early, so what you hear matches the picture. Only for playing in Studio on this PC: renders always have the audio exactly in place.${d.mixer ? ` (Studio's own audio buffer adds about ${d.mixer} ms on any output.)` : ''}`} />
      </span>
      <input type="range" min={0} max={800} step={10} value={ms} onChange={(e) => change(Number(e.target.value))} style={{ accentColor: 'var(--accent)' }} />
      <span className="mono audio-delay-ms">{ms} ms</span>
      <div className="seg">
        <button className={ms === 0 ? 'on' : ''} onClick={() => change(0)} title="Wired headphones or speakers">
          Wired
        </button>
        <button className={ms === 250 ? 'on' : ''} onClick={() => change(250)} title="A typical Bluetooth delay — fine-tune with the slider">
          Bluetooth
        </button>
      </div>
    </div>
  );
}

/** A seconds box: drag to scrub (one change per drag), or click and type (commits on Enter or leaving the box). */
export function Secs({ value, onCommit, title, min = 0 }: { value: number; onCommit: (v: number) => void; title?: string; min?: number }) {
  return <DragNumber value={value} step={0.01} digits={2} unit=" s" min={min} width={84} title={title ? `${title} · drag sideways to change, click to type` : undefined} onCommit={(v) => Math.abs(v - value) > 1e-4 && onCommit(Math.max(min, v))} />;
}

const balanceLabel = (p: number) => (Math.abs(p) < 0.01 ? 'Centre' : `${p < 0 ? 'L' : 'R'} ${Math.round(Math.abs(p) * 100)}`);

/** A clip's name: click it to rename (empty = the file's name); Enter keeps it, Esc leaves it as it was. */
function ClipName({ clip: c, index }: { clip: AudioClipInfo; index: number }) {
  const [text, setText] = useState<string | null>(null);
  const lane = { ['--lane' as string]: `rgb(${laneRgb(index)})` };
  const fileName = c.file.replace(/\.wav$/i, '');
  if (text != null)
    return (
      <input
        className="input audio-name-input"
        style={lane}
        autoFocus
        value={text}
        placeholder={fileName}
        maxLength={80}
        aria-label="Name of this audio"
        onFocus={(e) => e.target.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() !== (c.name ?? '').trim()) void setAudio(c.id, { name: text.trim() });
          setText(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setText(null);
        }}
      />
    );
  return (
    <button type="button" className="audio-clip-name" style={lane} title={`${c.name ? `File: ${c.file}\n` : ''}Click to rename`} onClick={() => setText(c.name || fileName)}>
      {audioName(c)}
    </button>
  );
}

/** One clip: listen, where it starts, how it sounds (volume, balance, speed, fades, trims), swap, remove. */
function ClipPanel({ clip: c, index }: { clip: AudioClipInfo; index: number }) {
  const listen = useStore((s) => (s.audioListen?.id === c.id ? s.audioListen.at : null));
  const tl = useStore((s) => s.tl);
  const span = clipSpan(c);
  const end = c.offset + span;
  const set = (patch: Parameters<typeof setAudio>[1]) => setAudio(c.id, patch);
  return (
    <Panel
      className="audio-clip"
      title={
        <ClipName clip={c} index={index} />
      }
      actions={
        <>
          <button className={`btn small ${listen != null ? 'on' : 'solid'}`} onClick={() => listenAudio(listen != null ? null : c.id, c.trimIn)} title="Studio plays this clip by itself, as it will sound (the animation doesn't move)">
            {listen != null ? `■ ${((listen - c.trimIn) / c.speed).toFixed(1)} s` : '▶ Listen'}
          </button>
          {window.studioEx?.openAudio && (
            <button className="btn small solid" onClick={() => pickAudio(0, c.id)} title="Swap this clip's WAV, keeping where it starts and its name">
              Replace…
            </button>
          )}
          <button className="btn icon danger" onClick={() => removeAudio(c.id)} title="Remove this clip from the scene" aria-label="Remove this clip">
            <Icon name="trash" size={13} />
          </button>
        </>
      }
    >
      <div className="ed-groups audio-groups">
        <section className="ed-group">
          <h4>Timing</h4>
          <div className="ed-fields">
            <label>
              Starts at (s)
              <span className="ed-pair">
                <Secs value={c.offset} min={-600} onCommit={(v) => set({ offset: v })} title="Where on the timeline it starts" />
                <button className="btn small solid" onClick={() => set({ offset: Math.round(liveTime() * 1000) / 1000 })} title="Start this clip at the playhead">
                  Playhead
                </button>
                <button className="btn small solid" onClick={() => set({ offset: 0 })} title="Start this clip at 0 s">
                  0
                </button>
              </span>
            </label>
          </div>
          <div className="ed-fields">
            <label>
              Fade in
              <Secs value={c.fadeIn} onCommit={(v) => set({ fadeIn: v })} title="Seconds it takes to fade in" />
            </label>
            <label>
              Fade out
              <Secs value={c.fadeOut} onCommit={(v) => set({ fadeOut: v })} title="Seconds it takes to fade out" />
            </label>
            <label>
              <span className="audio-lbl">
                Trim start
                <Help text="Skip seconds of the file at its start or end: silence, a count-in, a tail." />
              </span>
              <Secs value={c.trimIn} onCommit={(v) => set({ trimIn: v })} title="Seconds skipped at the start of the file" />
            </label>
            <label>
              Trim end
              <Secs value={c.trimOut} onCommit={(v) => set({ trimOut: v })} title="Seconds skipped at the end of the file" />
            </label>
          </div>
        </section>
        <section className="ed-group">
          <h4>Sound</h4>
          <div className="audio-sliders">
            <label>
              <span>Volume</span>
              <Slider value={c.volume} min={0} max={1} step={0.05} onChange={(v) => set({ volume: v })} />
            </label>
            <label>
              <span>Balance · {balanceLabel(c.pan)}</span>
              <Slider value={c.pan} min={-1} max={1} step={0.05} onChange={(v) => set({ pan: Math.abs(v) < 0.03 ? 0 : v })} />
            </label>
            <label>
              <span className="audio-lbl">
                Speed
                <Help text="Faster or slower: the pitch goes up or down with it, like a tape." />
                {Math.abs(c.speed - 1) > 0.001 && (
                  <button className="btn small solid audio-reset" onClick={() => set({ speed: 1 })} title="Normal speed">
                    1×
                  </button>
                )}
              </span>
              <Slider value={c.speed} min={0.25} max={4} step={0.05} onChange={(v) => set({ speed: v })} />
            </label>
          </div>
          <SwitchCard on={c.muted} label="Mute while animating" help="Silent while you work in Studio; renders still include it." onChange={(on) => set({ muted: on })} />
        </section>
      </div>
      <div className="pn-note">
        Plays {c.offset.toFixed(2)}–{end.toFixed(2)} s ({span.toFixed(1)} s{Math.abs(span - c.duration) > 0.01 ? ` of a ${c.duration.toFixed(1)} s file` : ''}).
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
        x1 = ((clip.offset + clipSpan(clip)) / duration) * w;
      g.fillStyle = `rgba(${rgb},${clip.muted ? 0.04 : 0.1})`;
      g.fillRect(x0, y0 + 2, Math.max(1, x1 - x0), rowH - 4);
      if (!pk) return;
      g.fillStyle = `rgba(${rgb},${clip.muted ? 0.3 : 0.9})`;
      const mid = y0 + rowH / 2,
        half = (rowH / 2 - 4) / loudest(pk);
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, x1); x++) {
        const tx = (x / w) * duration;
        const t0 = fileTimeAt(clip, tx) * pk.perSecond,
          t1 = fileTimeAt(clip, ((x + 1) / w) * duration) * pk.perSecond;
        let p = 0;
        for (let i = Math.max(0, Math.floor(t0)); i < Math.min(pk.peaks.length, Math.ceil(t1)); i++) p = Math.max(p, pk.peaks[i]);
        const a = Math.max(0.5, p * half * fadeAt(clip, tx));
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
      {listen && listening && <span className="waveform-listen" style={{ left: `${(Math.min(duration, timelineTimeAt(listening, listen.at)) / duration) * 100}%` }} />}
      <span className="waveform-scale">
        <span>0 s</span>
        <span>{duration.toFixed(1)} s</span>
      </span>
    </div>
  );
}

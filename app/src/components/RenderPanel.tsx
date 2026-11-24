import { useCallback, useEffect, useRef, useState } from 'react';
import { pressable } from '../lib/pressable';
import { Help } from './Help';
import { bridge } from '../bridge/client';
import { call, lsSet, refreshShots, seekNow, setLiveCuts, toast, useStore } from '../state/store';
import { lastVersions, needsVersions, sameSize, SIZES, toWire, useRenderVersions, type RenderVersion } from '../lib/renderVersions';
import { FramingCard } from './RenderFraming';

interface RenderStatus {
  recording: boolean;
  encoding: boolean;
  frame: number;
  frameLimit: number;
  message: string;
  progress: number;
  outputFolder: string;
  framesFolder: string;
  settings: {
    fps: number;
    exportFps: number;
    limit: string;
    limitNumber: number;
    format: string;
    resize: boolean;
    width: number;
    height: number;
    autoEncode: boolean;
    deleteFrames: boolean;
    prewarm: number;
    audio: boolean;
    /** before recording, so physics settle: off, quick (1.5 s), play (the range played through first) */
    warm?: Warm;
    /** MP4: x264 medium, VideoExport's own preset (smaller, slower), or the NVIDIA encoder */
    encode?: Encode;
    /** no supersampling: faster, rougher edges */
    draft?: boolean;
    /** straight to video (frames piped into the encoder as they're rendered) or VideoExport's image files */
    frames?: Frames;
  };
  /** the NVIDIA encoder works here (null while it's being checked) */
  gpuEncode?: boolean | null;
  limits: string[];
  formats: string[];
}
interface QueueState {
  running: boolean;
  done?: number;
  total?: number;
  shot?: string;
  error?: string | null;
  /** "Warm-up 1 of 3" while physics settle before recording, "Adding the audio" after */
  phase?: string | null;
  /** why the audio couldn't be added to the last video */
  audioError?: string | null;
  /** the videos made (named after the shot / version) */
  files?: string[];
}

type Warm = 'off' | 'quick' | 'play';
type Encode = 'balanced' | 'small' | 'gpu';
type Frames = 'direct' | 'files';
/** what straight to video can make; the others go through VideoExport's image files */
const DIRECT_FORMATS = ['MP4', 'WEBM'];
/** The speed choices, kept between sessions (the bridge forgets them when Studio restarts). */
const SPEED_KEY = 'studioex.render.speed';
const speedPrefs = (): { warm?: Warm; encode?: Encode; draft?: boolean; frames?: Frames } => {
  try {
    return JSON.parse(localStorage.getItem(SPEED_KEY) ?? '{}');
  } catch {
    return {};
  }
};

const FORMAT_HINT: Record<string, string> = { MP4: 'Best for sharing', WEBM: 'Web, smaller files', GIF: 'Short loops, no sound', AVI: 'For editing software' };

/** Shoot › Render: make a video of the timeline (or of each shot) through the installed VideoExport plugin. */
export function RenderPanel() {
  const status = useStore((s) => s.status);
  const hello = useStore((s) => s.hello);
  const tl = useStore((s) => s.tl);
  const audioClips = useStore((s) => s.audio.length);
  const shots = useStore((s) => s.shots);
  const [st, setSt] = useState<RenderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useStore((s) => s.renderShotIds);
  const [what, setWhat] = useState<'timeline' | 'shots'>(request ? 'shots' : 'timeline');
  const liveCuts = useStore((st) => st.liveCuts);

  const [included, setIncluded] = useState<string[] | null>(request);
  useEffect(() => {
    if (!request) return;
    setWhat('shots');
    setIncluded(request);
    useStore.setState({ renderShotIds: null });
  }, [request]);
  const isIncluded = (id: string) => included === null || included.includes(id);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const poll = useRef(0);
  const qpoll = useRef(0);
  const feature = hello?.features?.find((f) => f.id === 'render');
  const { versions: savedVersions, setVersions } = useRenderVersions();
  // the header glows once when a render finishes
  const [glow, setGlow] = useState(0);
  const celebrate = () => setGlow(Date.now());
  // what VideoExport captures with: through Screencap, "Window" really means Screencap's own size
  const [capture, setCapture] = useState<{ plugins: string[]; selected: number; screencap: number; screencapSize: [number, number] | null; window: [number, number] } | null>(null);

  const load = useCallback(async () => {
    try {
      let r = await bridge.request<RenderStatus>('render.status');
      // the speed choices made before (the bridge starts from its defaults each time Studio starts)
      const p = speedPrefs();
      if ((p.warm && p.warm !== r.settings.warm) || (p.encode && p.encode !== r.settings.encode) || (p.draft != null && p.draft !== r.settings.draft) || (p.frames && p.frames !== r.settings.frames))
        r = await bridge.request<RenderStatus>('render.set', p);
      setSt(r);
      bridge.request<typeof capture>('render.capture').then(setCapture).catch(() => undefined);
      setError(null);
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, []);
  useEffect(() => {
    if (status !== 'open') return;
    load();
    refreshShots();
  }, [status, load]);

  // while recording or encoding, follow progress
  const busy = !!st && (st.recording || st.encoding);
  useEffect(() => {
    if (!busy) return;
    poll.current = window.setInterval(async () => {
      const r = await load();
      if (r && !r.recording && !r.encoding && !queue?.running) {
        toast(r.message || 'Render finished', 'done');
        celebrate();
      }
    }, 1000);
    return () => window.clearInterval(poll.current);
  }, [busy, load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => window.clearInterval(qpoll.current), []);
  // whether the GPU encoder works is checked once in the background: ask again in a moment
  useEffect(() => {
    if (!st || st.gpuEncode !== null) return;
    const t = window.setTimeout(load, 2500);
    return () => window.clearTimeout(t);
  }, [st, load]);

  const set = async (patch: Record<string, unknown>) => {
    const speed = Object.fromEntries(Object.entries(patch).filter(([k]) => k === 'warm' || k === 'encode' || k === 'draft' || k === 'frames'));
    if (Object.keys(speed).length) lsSet(SPEED_KEY, JSON.stringify({ ...speedPrefs(), ...speed }));
    const r = await call<RenderStatus>('render.set', patch);
    if (r) setSt(r);
  };
  /** Several versions, a framing of their own, or a size other than VideoExport's own setting (remembered versions). */
  const sendVersions = () => {
    const cur = st?.settings;
    return needsVersions(versions) || (!!cur && !sameSize(versions[0], { w: cur.resize ? cur.width : 0, h: cur.resize ? cur.height : 0 }));
  };
  const start = async () => {
    if (what === 'shots') return startQueue();
    const r = await call<RenderStatus>('render.start', { ...speedPrefs(), ...(sendVersions() ? { versions: toWire(versions) } : {}), useShots: shots.length > 0 && liveCuts });
    if (!r) return;
    setSt(r);
    toast('Rendering. Leave Studio alone until it finishes');
    // Keyframe Studio plays the timeline while VideoExport records (VideoExport doesn't play it itself)
    if (r.settings.limit !== 'Animation') {
      const q = await call<QueueState>('render.queueStatus');
      if (q?.running) {
        setQueue(q);
        pollQueue();
      }
    }
  };
  const startQueue = async () => {
    const ids = shots.filter((s) => isIncluded(s.id)).map((s) => s.id);
    if (!ids.length) return toast('Tick at least one shot');
    const r = await call<QueueState>('render.queue', { ...speedPrefs(), ids, ...(sendVersions() ? { versions: toWire(versions) } : {}) });
    if (!r) return;
    setQueue(r);
    pollQueue();
  };
  const pollQueue = () => {
    window.clearInterval(qpoll.current);
    qpoll.current = window.setInterval(async () => {
      const q = await bridge.request<QueueState>('render.queueStatus').catch(() => null);
      if (!q) return;
      setQueue(q);
      load();
      if (!q.running) {
        window.clearInterval(qpoll.current);
        toast(q.error ? `Render stopped: ${q.error}` : (q.total ?? 1) > 1 ? `Rendered ${q.done} of ${q.total} videos` : 'Render finished', q.error ? 'error' : 'done');
        if (!q.error) celebrate();
        if (q.audioError) toast(`The video is fine, but the audio couldn't be added: ${q.audioError}`, 'error');
      }
    }, 1000);
  };
  const stop = () => {
    call('render.queueCancel');
    call<RenderStatus>('render.stop').then((r) => r && setSt(r));
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
  const size = s.resize ? SIZES.find((x) => x.w === s.width && x.h === s.height)?.label ?? 'Custom' : 'Window';
  const viaScreencap = !!capture && capture.selected === capture.screencap && !!capture.screencapSize;
  // with no size picked: Screencap's own size when VideoExport captures through it, else the window
  const native = viaScreencap ? capture!.screencapSize! : capture?.window ?? null;
  const nativeLabel = native ? `${native[0]}×${native[1]}` : '';
  const dims = s.resize ? `${s.width}×${s.height}` : nativeLabel || 'window size';
  // the versions to make: the saved ones, else the one size picked now
  const current: RenderVersion = { label: s.resize ? size : viaScreencap ? 'Screencap' : 'Window', w: s.resize ? s.width : 0, h: s.resize ? s.height : 0, framing: { mode: 'timeline' } };
  // a scene without its own versions starts from the ones used last on this PC
  const versions: RenderVersion[] = savedVersions ?? lastVersions() ?? [current];
  const has = (x: { w?: number; h?: number }) => versions.some((v) => sameSize(v, x));
  const labelOf = (x: { label: string; w?: number }) => (x.w ? x.label : viaScreencap ? 'Screencap' : 'Window');
  /** only this size (its framing kept if it was already a version) */
  const pickOnly = (x: { label: string; w?: number; h?: number }) => {
    const keep = versions.find((v) => sameSize(v, x));
    setVersions([keep ?? { label: labelOf(x), w: x.w ?? 0, h: x.h ?? 0, framing: { mode: 'timeline' } }]);
    set(x.w ? { resize: true, width: x.w, height: x.h } : { resize: false });
  };
  /** add or remove this size as one more version */
  const toggle = (x: { label: string; w?: number; h?: number }) => {
    if (has(x)) {
      if (versions.length === 1) return;
      const rest = versions.filter((v) => !sameSize(v, x));
      setVersions(rest);
      const first = rest[0];
      set(first.w ? { resize: true, width: first.w, height: first.h } : { resize: false });
    } else setVersions([...versions, { label: labelOf(x), w: x.w ?? 0, h: x.h ?? 0, framing: { mode: 'timeline' } }]);
  };
  const picked = shots.filter((x) => isIncluded(x.id));
  // VideoExport's number means loops in Timeline mode, seconds in Seconds mode, frames in Frames mode
  // timed renders start at the playhead (at the very end: from the start)
  const from = tl ? (tl.time >= tl.duration - 0.01 ? 0 : tl.time) : 0;
  const seconds =
    what === 'shots'
      ? picked.reduce((a, x) => a + (x.end - x.start), 0)
      : s.limit === 'Timeline' && tl
        ? tl.duration * Math.max(1, s.limitNumber)
        : s.limit === 'Seconds'
          ? s.limitNumber
          : s.limit === 'none' && tl
            ? tl.duration - from
            : null;
  const frames = seconds != null ? Math.round(seconds * s.fps) : null;
  const running = busy || !!queue?.running;
  const pct = Math.round((st.frameLimit > 0 ? st.frame / st.frameLimit : st.progress) * 100);
  const summary = [
    s.format,
    versions.length > 1 ? `${versions.length} versions (${versions.map((v) => v.label).join(', ')})` : versions[0].w ? `${versions[0].w}×${versions[0].h}` : nativeLabel || dims,
    `${s.fps} fps`,
    what === 'shots' ? `${picked.length} shot${picked.length === 1 ? '' : 's'}, one video each` : s.limit === 'Timeline' ? 'the whole timeline' : `from ${from.toFixed(2)} s`,
    versions.length > 1 || what === 'shots' ? `${(what === 'shots' ? picked.length : 1) * versions.length} video${(what === 'shots' ? picked.length : 1) * versions.length === 1 ? '' : 's'}` : '',
    seconds != null ? `${seconds.toFixed(1)} s` : '',
    frames != null ? `${frames.toLocaleString()} frames` : '',
    s.warm === 'play' ? `${Math.max(1, s.prewarm)} warm-up play${s.prewarm > 1 ? 's' : ''}` : '',
    s.draft ? 'draft' : '',
    s.frames === 'direct' && DIRECT_FORMATS.includes(s.format) && s.autoEncode ? 'straight to video' : '',
    s.autoEncode && s.audio && audioClips > 0 && s.format !== 'GIF' ? `with audio (${audioClips} clip${audioClips > 1 ? 's' : ''})` : '',
  ].filter(Boolean);

  return (
    <div className="render-page">
      {/* what will come out, and the button */}
      <div key={glow} className={`render-hero ${running ? 'running' : ''} ${glow ? 'just-done' : ''}`}>
        <div className="render-hero-text">
          <b>{running ? (queue?.running && queue.shot !== 'Timeline' ? `Rendering ${queue.shot ?? 'shots'} (${(queue.done ?? 0) + 1} of ${queue.total})` : st.encoding ? 'Encoding the video…' : 'Rendering…') : 'Ready to render'}</b>
          <span>{running ? queue?.phase || st.message || (st.recording ? `Frame ${st.frame}${st.frameLimit > 0 ? ` of ${st.frameLimit}` : ''}` : '') : summary.join(' · ')}</span>
          {running && (
            <div className="render-progress">
              <span style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
        {running ? (
          <button className="btn solid render-go" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="btn primary render-go" disabled={what === 'shots' && !picked.length} onClick={start} title="Studio plays the timeline and captures every frame from the current camera — leave it alone until it finishes">
            {what === 'shots' ? (picked.length === 1 ? `Render “${picked[0].name}”` : `Render ${picked.length} shots`) : 'Render'}
          </button>
        )}
      </div>

      <div className="render-grid render-layout">
        <div className="look-card">
          <div className="look-card-head">
            <div>
              <b>
                What to render
                <Help text="The whole timeline, or each shot as its own video" />
              </b>
            </div>
          </div>
          <div className="look-card-body">
            <div className="seg render-what">
              <button className={what === 'timeline' ? 'on' : ''} disabled={running} onClick={() => setWhat('timeline')}>
                Whole timeline
              </button>
              <button className={what === 'shots' ? 'on' : ''} disabled={running || !shots.length} onClick={() => setWhat('shots')} title={shots.length ? 'One video per shot, through its own camera' : 'Add shots in Shots & camera first'}>
                Shots ({shots.length})
              </button>
            </div>
            {what === 'timeline' ? (
              <>
                <div className="cleanup-row" style={{ marginTop: 10 }}>
                  <span>Length</span>
                  <div className="seg">
                    <button className={s.limit === 'Timeline' ? 'on' : ''} disabled={running || !st.limits.includes('Timeline')} onClick={() => set({ limit: 'Timeline', limitNumber: 1 })} title="The whole timeline from the start, once">
                      All of it
                    </button>
                    <button className={s.limit === 'Seconds' ? 'on' : ''} disabled={running} onClick={() => set({ limit: 'Seconds', limitNumber: s.limitNumber > 0 ? s.limitNumber : 5 })} title="Plays the animation from the playhead for as long as you set">
                      From the playhead
                    </button>
                    <button className={s.limit === 'none' ? 'on' : ''} disabled={running} onClick={() => set({ limit: 'none' })} title="Plays the animation from the playhead to the end of the timeline (Stop ends it early)">
                      To the end
                    </button>
                  </div>
                </div>
                {s.limit === 'Seconds' && (
                  <div className="cleanup-row">
                    <span />
                    <input className="input mono" type="number" min={0.5} step={0.5} value={s.limitNumber} disabled={running} onChange={(e) => set({ limitNumber: Number(e.target.value) || 1 })} style={{ width: 80 }} />
                    <span className="hint" style={{ margin: 0 }}>
                      seconds from {from.toFixed(2)} s
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="render-shots">
                {shots.map((x, i) => (
                  <label key={x.id} className="render-shot">
                    <input
                      type="checkbox"
                      checked={isIncluded(x.id)}
                      disabled={running}
                      onChange={(e) => setIncluded(e.target.checked ? [...picked.map((s) => s.id), x.id] : picked.filter((s) => s.id !== x.id).map((s) => s.id))}
                    />
                    {x.thumb ? <img {...pressable} src={x.thumb} alt={`Go to ${x.name}`} onClick={() => seekNow(x.start)} /> : <span className="render-shot-ph">#{i + 1}</span>}
                    <span className="render-shot-text">
                      <b>{x.name}</b>
                      <small>
                        {x.start.toFixed(2)}–{x.end.toFixed(2)}s · {(x.end - x.start).toFixed(2)}s{x.cam ? '' : ' · no camera set'}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className="cleanup-row" style={{ marginTop: 10 }}>
              <span>
                Warm-up
                <Help text="So hair and clothes physics have settled when recording starts. Quick plays the 1.5 s leading into the start (or holds still there). Play through plays the whole range first, in real time: slower, but a looping animation then joins up seamlessly. For shots, each shot warms up on its own." />
              </span>
              <div className="seg">
                {(
                  [
                    ['off', 'Off', 'Start recording straight away'],
                    ['quick', 'Quick', 'Plays the 1.5 s leading into the start (or holds still there) so physics settle'],
                    ['play', 'Play through', 'Plays the whole range first, in real time — for seamless loops'],
                  ] as const
                ).map(([id, label, hint]) => (
                  <button
                    key={id}
                    className={(s.warm ?? 'play') === id ? 'on' : ''}
                    title={hint}
                    disabled={running || (what === 'timeline' && s.limit === 'Animation')}
                    onClick={() => set(id === 'play' ? { warm: id, prewarm: Math.max(1, s.prewarm) } : { warm: id })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="cleanup-row">
              <span>
                Recording
                <Help text="Straight to video sends each frame into the video as it's rendered: no image files on disk and no encoding wait at the end, so it's the fastest. Image files is VideoExport's own way (each frame saved as a picture, then put together) — use it if you want to keep the frames. GIF and AVI always use image files." />
              </span>
              <div className="seg">
                {(
                  [
                    ['direct', 'Straight to video', 'Each frame goes into the video as it renders: no image files, no wait at the end'],
                    ['files', 'Image files', "VideoExport's own way: frames saved as pictures, then put together"],
                  ] as const
                ).map(([id, label, hint]) => {
                  const direct = DIRECT_FORMATS.includes(s.format) && s.autoEncode; // keeping only the frames is image files
                  const can = id === 'files' || direct;
                  const on = id === 'direct' ? s.frames === 'direct' && direct : s.frames !== 'direct' || !direct;
                  const why = !s.autoEncode ? 'Making the video is off: the frames are kept as image files' : `${s.format} always uses image files`;
                  return (
                    <button key={id} className={on ? 'on' : ''} title={can ? hint : why} disabled={running || !can} onClick={() => set({ frames: id })}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="cleanup-row">
              <span>
                Speed
                <Help text="Draft renders without Screencap's supersampling: much faster, with slightly rougher edges — for checking timing. Encoding (MP4): Balanced is quick with about the same file size; Smallest files uses VideoExport's own slower setting; GPU uses the graphics card's encoder (fastest, files a bit larger)." />
              </span>
              <div className="render-speed">
              <label className="render-check" title="No supersampling: much faster, slightly rougher edges">
                <input type="checkbox" checked={!!s.draft} disabled={running} onChange={(e) => set({ draft: e.target.checked })} />
                Draft
              </label>
              {s.format === 'MP4' && (
                <div className="seg">
                  {(
                    [
                      ['balanced', 'Balanced', 'x264, medium: quick, about the same size'],
                      ['small', 'Smallest files', "VideoExport's own encoder setting (slower)"],
                      ['gpu', 'GPU', st.gpuEncode ? "The graphics card's encoder: fastest, files a bit larger" : st.gpuEncode === false ? 'Needs an NVIDIA graphics card' : 'Checking the graphics card…'],
                    ] as const
                  ).map(([id, label, hint]) => (
                    <button key={id} className={(s.encode ?? 'small') === id ? 'on' : ''} title={hint} disabled={running || (id === 'gpu' && !st.gpuEncode)} onClick={() => set({ encode: id })}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
              </div>
            </div>
          </div>
        </div>

        <div className="look-card">
          <div className="look-card-head">
            <div>
              <b>
                Picture
                <Help text="Click a size to render at it. Tick more sizes (the + in a tile's corner) to get one video of each from one render — each can have its own framing below." />
              </b>
            </div>
          </div>
          <div className="look-card-body">
            <div className="render-sizes">
              {SIZES.map((x) => (
                <button key={x.label} className={`render-size ${has(x) ? 'on' : ''}`} disabled={running} onClick={() => pickOnly(x)} title={x.w ? `${x.w}×${x.h} — rendered at this size (another shape is framed, never stretched)` : viaScreencap ? `Screencap's size (${nativeLabel}), set in its own settings` : "Studio's window size"}>
                  <i style={x.w ? { aspectRatio: `${x.w} / ${x.h}` } : { aspectRatio: native ? `${native[0]} / ${native[1]}` : '16 / 10', borderStyle: 'dashed' }} />
                  <b>{x.w ? x.label : viaScreencap ? 'Screencap' : x.label}</b>
                  <small>{x.w ? x.hint : nativeLabel || x.hint}</small>
                  <span
                    className={`render-also ${has(x) ? 'on' : ''}`}
                    role="checkbox"
                    aria-checked={has(x)}
                    title={has(x) ? (versions.length > 1 ? 'Don’t make this version' : 'The only version') : 'Also make this size — one video each'}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!running) toggle(x);
                    }}
                  >
                    {has(x) ? '✓' : '+'}
                  </span>
                </button>
              ))}
              {size === 'Custom' && (
                <button className="render-size on" disabled>
                  <i style={{ aspectRatio: `${s.width} / ${s.height}` }} />
                  <b>Custom</b>
                  <small>
                    {s.width}×{s.height}
                  </small>
                </button>
              )}
            </div>
            <div className="render-versions-hint">
              {versions.length > 1 ? `${versions.length} versions — one video each. ` : ''}Click a size to use just that one; tick <b>+</b> on more sizes to get a video of each from one render.
            </div>
            <div className="cleanup-row" style={{ marginTop: 10 }}>
              <span>Frame rate</span>
              <div className="seg">
                {[24, 30, 60].map((f) => (
                  <button key={f} className={s.fps === f ? 'on' : ''} disabled={running} onClick={() => set({ fps: f })}>
                    {f} fps
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <FramingCard versions={versions} setVersions={setVersions} running={running} native={native} />

        <div className="look-card">
          <div className="look-card-head">
            <div>
              <b>
                File
                <Help text="Format and what happens to the frames" />
              </b>
            </div>
          </div>
          <div className="look-card-body">
            <div className="render-formats">
              {st.formats.map((f) => (
                <button key={f} className={`render-size ${s.format === f ? 'on' : ''}`} disabled={running} onClick={() => set({ format: f })}>
                  <b>{f}</b>
                  <small>{FORMAT_HINT[f] ?? ''}</small>
                </button>
              ))}
            </div>
            {shots.length > 0 && what === 'timeline' && (
              <label className="rigs-opt" style={{ marginTop: 10 }} title="The same switch as Shoot › Shots: the render follows the shots — their cameras, cuts and transitions (shots with camera keys play their keys). Off: the timeline's own camera.">
                <input type="checkbox" checked={liveCuts} disabled={running} onChange={(e) => setLiveCuts(e.target.checked)} /> Play the edit ({shots.length} shot{shots.length === 1 ? '' : 's'}): their cameras, cuts and transitions
              </label>
            )}
            <label className="rigs-opt" style={{ marginTop: shots.length > 0 && what === 'timeline' ? 0 : 10 }}>
              <input type="checkbox" checked={s.autoEncode} disabled={running} onChange={(e) => set({ autoEncode: e.target.checked })} /> Make the video when done
            </label>
            <label className="rigs-opt" style={{ marginTop: 0 }}>
              <input type="checkbox" checked={s.deleteFrames} disabled={running || !s.autoEncode} onChange={(e) => set({ deleteFrames: e.target.checked })} /> Delete the frame images afterwards
            </label>
            <label className="rigs-opt" style={{ marginTop: 0 }} title="The scene's audio clips are mixed into the finished video, each where it plays on the timeline, with its volume, balance, speed, fades and trims">
              <input type="checkbox" checked={s.audio} disabled={running || !s.autoEncode || s.format === 'GIF'} onChange={(e) => set({ audio: e.target.checked })} /> Include the audio
              {s.format === 'GIF' ? ' (GIFs have no sound)' : audioClips ? ` (${audioClips} clip${audioClips > 1 ? 's' : ''})` : ' (no audio in this scene)'}
            </label>
          </div>
        </div>

        <div className="look-card">
          <div className="look-card-head">
            <div>
              <b>
                Output
                <Help text="Where the videos go. Renders what Studio's camera sees (shots: each through its own camera). More options in VideoExport's own window (Ctrl+E in Studio)." />
              </b>
            </div>
            {window.studioEx?.openFolder && (
              <button className="btn small solid" onClick={() => window.studioEx?.openFolder?.(st.outputFolder)}>
                Open folder
              </button>
            )}
          </div>
          <div className="look-card-body">
            <code className="render-path">{st.outputFolder}</code>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Help } from './Help';
import { bridge } from '../bridge/client';
import { call, refreshShots, seekNow, toast, useStore } from '../state/store';
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
  settings: { fps: number; exportFps: number; limit: string; limitNumber: number; format: string; resize: boolean; width: number; height: number; autoEncode: boolean; deleteFrames: boolean; prewarm: number; audio: boolean };
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
  // what VideoExport captures with: through Screencap, "Window" really means Screencap's own size
  const [capture, setCapture] = useState<{ plugins: string[]; selected: number; screencap: number; screencapSize: [number, number] | null; window: [number, number] } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await bridge.request<RenderStatus>('render.status');
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
      if (r && !r.recording && !r.encoding && !queue?.running) toast(r.message || 'Render finished');
    }, 1000);
    return () => window.clearInterval(poll.current);
  }, [busy, load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => window.clearInterval(qpoll.current), []);

  const set = async (patch: Record<string, unknown>) => {
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
    const r = await call<RenderStatus>('render.start', sendVersions() ? { versions: toWire(versions) } : {});
    if (!r) return;
    setSt(r);
    toast('Rendering — Studio plays the animation and captures every frame. Leave it alone until it finishes.');
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
    const r = await call<QueueState>('render.queue', sendVersions() ? { ids, versions: toWire(versions) } : { ids });
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
        toast(q.error ? `Render stopped: ${q.error}` : (q.total ?? 1) > 1 ? `Rendered ${q.done} of ${q.total} videos` : 'Render finished');
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
    s.prewarm ? `${s.prewarm} warm-up play${s.prewarm > 1 ? 's' : ''}` : '',
    s.autoEncode && s.audio && audioClips > 0 && s.format !== 'GIF' ? `with audio (${audioClips} clip${audioClips > 1 ? 's' : ''})` : '',
  ].filter(Boolean);

  return (
    <div className="render-page">
      {/* what will come out, and the button */}
      <div className={`render-hero ${running ? 'running' : ''}`}>
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
                    {x.thumb ? <img src={x.thumb} alt="" onClick={() => seekNow(x.start)} /> : <span className="render-shot-ph">#{i + 1}</span>}
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
                <Help text="Plays what's about to be recorded this many times first (in real time), so hair and clothes physics have settled when recording starts. For shots, each shot warms up on its own." />
              </span>
              <div className="seg" title="Plays it this many times before recording so hair and clothes physics settle">
                {[0, 1, 2, 3].map((n) => (
                  <button key={n} className={s.prewarm === n ? 'on' : ''} disabled={running || (what === 'timeline' && s.limit === 'Animation')} onClick={() => set({ prewarm: n })}>
                    {n}
                  </button>
                ))}
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
            <label className="rigs-opt" style={{ marginTop: 10 }}>
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

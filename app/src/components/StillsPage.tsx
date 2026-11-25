import { useCallback, useEffect, useState } from 'react';
import { bridge } from '../bridge/client';
import { toast, useStore } from '../state/store';
import { Help } from './Help';
import { DragNumber } from './DragNumber';
import { Switch } from './LookPanel';
import { FramingCard } from './RenderFraming';
import { lastVersions, sameSize, toWire, useRenderVersions, type RenderVersion } from '../lib/renderVersions';

const STILL_NOTE = 'stills.versions',
  STILL_LAST = 'kf.stills.versions';

// Shoot › Output › Pictures: pictures of Studio's camera — supersampled, PNG / JPG, transparent background (Screencap),
// one at a time or one per saved view / shot. Screencap (BepisPlugins) takes them when installed.

interface Status {
  screencap: boolean;
  useScreencap: boolean;
  folder: string;
  screen: [number, number];
  batch: { running: boolean; done: number; total: number; current: string | null; error: string | null; results: Shot[] };
}
interface Shot {
  path: string;
  folder: string;
  provider: string;
  width: number;
  height: number;
  thumb: string | null;
}

const SIZES: { label: string; w?: number; h?: number; hint: string }[] = [
  { label: 'Window', hint: "Studio's window size" },
  { label: '1080p', w: 1920, h: 1080, hint: 'Full HD' },
  { label: '1440p', w: 2560, h: 1440, hint: 'QHD' },
  { label: '4K', w: 3840, h: 2160, hint: 'UHD' },
  { label: 'Square', w: 2048, h: 2048, hint: 'Social posts' },
  { label: 'Portrait', w: 1600, h: 2000, hint: '4:5 posts' },
  { label: 'Vertical', w: 1080, h: 1920, hint: 'Phones, stories' },
  { label: 'Wallpaper', w: 3440, h: 1440, hint: 'Ultrawide' },
];
const QUALITY = [
  { n: 1, label: 'Draft', hint: 'Rendered once at the size' },
  { n: 2, label: 'Good', hint: 'Rendered 2× larger, scaled down: smooth edges' },
  { n: 3, label: 'Best', hint: '3× — very smooth, slower' },
  { n: 4, label: 'Max', hint: '4× — for small sizes; big sizes may run out of memory' },
];
const KEY = 'kf.stills';

function prefs() {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<{ size: string; supersample: number; transparent: boolean; format: string; quality: number; samples: number; lens: boolean; fstop: number; bits16: boolean; focus2: number; tilt: number; rtshade: boolean }>;
  } catch {
    return {};
  }
}

export function StillsPage() {
  const status = useStore((s) => s.status);
  const [st, setSt] = useState<Status | null>(null);
  const [size, setSize] = useState(prefs().size ?? '1080p');
  const [ss, setSs] = useState(prefs().supersample ?? 2);
  const [transparent, setTransparent] = useState(prefs().transparent ?? false);
  const [format, setFormat] = useState(prefs().format ?? 'png');
  const [quality, setQuality] = useState(prefs().quality ?? 95);
  // quality stills: many renders averaged, a real lens, 16 bits
  const [samples, setSamples] = useState(prefs().samples ?? 1);
  const [lens, setLens] = useState(prefs().lens ?? false);
  const [fstop, setFstop] = useState(prefs().fstop ?? 2.8);
  const [bits16, setBits16] = useState(prefs().bits16 ?? false);
  const [focus2, setFocus2] = useState(prefs().focus2 ?? 0);
  const [tilt, setTilt] = useState(prefs().tilt ?? 0);
  const [rtshade, setRtshade] = useState(prefs().rtshade ?? false);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<Shot[]>([]);
  // the header glows once when pictures are saved
  const [glow, setGlow] = useState(0);
  const { versions: savedVersions, setVersions } = useRenderVersions(STILL_NOTE, STILL_LAST);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ size, supersample: ss, transparent, format, quality, samples, lens, fstop, bits16, focus2, tilt, rtshade }));
    } catch {
      /* private mode */
    }
  }, [size, ss, transparent, format, quality, samples, lens, fstop, bits16, focus2, tilt, rtshade]);

  const load = useCallback(() => {
    bridge.request<Status>('still.status').then(setSt).catch(() => setSt(null));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load]);
  // batches report when they're done
  useEffect(
    () =>
      bridge.on('still.batchDone', (d) => {
        const s = d as Status;
        setSt(s);
        setBusy(false);
        setRecent((r) => [...s.batch.results, ...r].slice(0, 24));
        toast(s.batch.error ? `Pictures taken, with a problem: ${s.batch.error}` : `${s.batch.results.length} picture${s.batch.results.length === 1 ? '' : 's'} saved`, s.batch.error ? 'error' : 'done');
        if (!s.batch.error) setGlow(Date.now());
      }),
    [],
  );
  // progress while a batch runs
  useEffect(() => {
    if (!st?.batch.running) return;
    const t = setInterval(load, 500);
    return () => clearInterval(t);
  }, [st?.batch.running, load]);

  if (!st) return <div className="fx-empty">{status === 'open' ? 'Reading…' : 'Connect to CharaStudio to take pictures.'}</div>;

  const def = SIZES.find((x) => x.label === size) ?? SIZES[0];
  const [w, h] = def.w ? [def.w, def.h!] : st.screen;
  const fine = samples > 1 || lens || rtshade || (bits16 && format === 'png');
  const opts = { width: w, height: h, supersample: ss, transparent: transparent && format === 'png' && !fine, format, quality, samples, lens, fstop, bits16: bits16 && format === 'png', focus2: lens ? focus2 : 0, tilt: lens ? tilt : 0, rtshade };
  // versions: one picture each (its size and framing); a scene without its own starts from the ones used last
  const current: RenderVersion = { label: def.label, w: def.w ?? 0, h: def.h ?? 0, framing: { mode: 'timeline' } };
  const versions: RenderVersion[] = savedVersions ?? lastVersions(STILL_LAST) ?? [current];
  const has = (x: { w?: number; h?: number }) => versions.some((v) => sameSize(v, x));
  const pickOnly = (x: (typeof SIZES)[number]) => {
    const keep = versions.find((v) => sameSize(v, x));
    setVersions([keep ?? { label: x.label, w: x.w ?? 0, h: x.h ?? 0, framing: { mode: 'timeline' } }]);
    setSize(x.label);
  };
  const toggle = (x: (typeof SIZES)[number]) => {
    if (has(x)) {
      if (versions.length > 1) setVersions(versions.filter((v) => !sameSize(v, x)));
    } else setVersions([...versions, { label: x.label, w: x.w ?? 0, h: x.h ?? 0, framing: { mode: 'timeline' } }]);
  };
  const sizeOf = (v: RenderVersion) => (v.w ? `${v.w}×${v.h}` : `${st.screen[0]}×${st.screen[1]}`);
  const withVersions = { ...opts, versions: toWire(versions) };
  const canTransparent = st.screencap;
  const running = busy || st.batch.running;
  const provider = !fine && st.screencap && (st.useScreencap || opts.transparent) ? 'Screencap' : 'Keyframe Studio';

  const take = async () => {
    setBusy(true);
    try {
      // many renders take a while: wait longer than for a plain picture
      const got = await bridge.request<Shot | Shot[]>('still.capture', withVersions, fine ? 300000 : 10000);
      const shots = Array.isArray(got) ? got : [got];
      setRecent((x) => [...shots, ...x].slice(0, 24));
      toast(shots.length === 1 ? `Saved ${shots[0].path.replace(/^.*[\\/]/, '')} (${shots[0].width}×${shots[0].height})` : `Saved ${shots.length} pictures (${versions.map((v) => v.label).join(', ')})`, 'done');
      setGlow(Date.now());
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const batch = async (kind: 'views' | 'shots') => {
    setBusy(true);
    try {
      setSt(await bridge.request<Status>('still.batch', { kind, ...withVersions }));
    } catch (e) {
      setBusy(false);
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="render-page">
      <div key={glow} className={`render-hero ${running ? 'running' : ''} ${glow ? 'just-done' : ''}`}>
        <div className="render-hero-text">
          <b>{st.batch.running ? `Taking pictures… ${st.batch.done + 1} of ${st.batch.total}` : 'Still pictures'}</b>
          <span>
            {st.batch.running
              ? st.batch.current
              : [versions.length > 1 ? `${versions.length} versions (${versions.map((v) => v.label).join(', ')}) — one picture each` : sizeOf(versions[0]), ss > 1 ? `${ss}× supersampled` : 'no supersampling', opts.transparent ? 'transparent PNG' : format.toUpperCase(), `by ${provider}`].join(' · ')}
          </span>
          {st.batch.running && (
            <div className="render-progress">
              <span style={{ width: `${(100 * st.batch.done) / Math.max(1, st.batch.total)}%` }} />
            </div>
          )}
        </div>
        <div className="still-actions">
          <button className="btn solid" disabled={running} onClick={() => batch('views')} title="One picture from each saved view (Shoot › Shots & camera); your view is put back afterwards">
            Each saved view
          </button>
          <button className="btn solid" disabled={running} onClick={() => batch('shots')} title="One picture per shot, at its start through its camera; camera and playhead are put back afterwards">
            Each shot
          </button>
          <button className="btn primary render-go" disabled={running} onClick={take} title="A picture of what Studio's camera sees now (no menus, no guides)">
            Take picture
          </button>
        </div>
      </div>

      <div className="render-grid stills-layout">
        <div className="look-card">
          <div className="look-card-head">
            <div>
              <b>
                Size
                <Help text="The picture's size in pixels. Its shape can differ from Studio's window — turn on a matching frame in Shoot › Shots & camera › Frame guides to see what will be in it." />
              </b>
            </div>
          </div>
          <div className="look-card-body">
            <div className="render-sizes">
              {SIZES.map((x) => (
                <button key={x.label} className={`render-size ${has(x) ? 'on' : ''}`} disabled={running} onClick={() => pickOnly(x)} title={x.w ? `${x.w}×${x.h}` : `${st.screen[0]}×${st.screen[1]}`}>
                  <i style={x.w ? { aspectRatio: `${x.w} / ${x.h}` } : { aspectRatio: `${st.screen[0]} / ${st.screen[1]}`, borderStyle: 'dashed' }} />
                  <b>{x.label}</b>
                  <small>{x.hint}</small>
                  <span
                    className={`render-also ${has(x) ? 'on' : ''}`}
                    role="checkbox"
                    aria-checked={has(x)}
                    title={has(x) ? (versions.length > 1 ? 'Don’t make this version' : 'The only version') : 'Also take this size — one picture each'}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!running) toggle(x);
                    }}
                  >
                    {has(x) ? '✓' : '+'}
                  </span>
                </button>
              ))}
            </div>
            <div className="render-versions-hint">
              {versions.length > 1 ? `${versions.length} versions — one picture each. ` : ''}Click a size to use just that one; tick <b>+</b> on more sizes to get a picture of each with one press.
            </div>
            <div className="cleanup-row" style={{ marginTop: 10 }}>
              <span>
                Quality <Help text="Supersampling: render bigger, then scale down — smoother edges, hair and lines." />
              </span>
              <div className="seg">
                {QUALITY.map((q) => (
                  <button key={q.n} className={ss === q.n ? 'on' : ''} disabled={running} onClick={() => setSs(q.n)} title={q.hint}>
                    {q.label}
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
                Quality
                <Help text="Smooth: the picture is rendered many times, each nudged within its pixels, and averaged — clean edges, hair and effects, no flicker in fine detail. Real lens: each render also moves the camera across a lens opening while the focus distance stays sharp, for true depth of field (it focuses where Look › Picture › Depth of field says — a character's eyes, the view centre or a fixed distance — even with that effect off). Everything stays still while it renders. Takes a few seconds." />
              </b>
            </div>
          </div>
          <div className="look-card-body">
            <div className="cleanup-row">
              <span>Smooth</span>
              <div className="seg">
                {[
                  { n: 1, label: 'Off', hint: 'One render' },
                  { n: 16, label: '16', hint: '16 renders averaged: quick' },
                  { n: 64, label: '64', hint: '64 renders averaged: clean' },
                  { n: 256, label: '256', hint: '256 renders averaged: the smoothest lens blur' },
                ].map((q) => (
                  <button key={q.n} className={samples === q.n ? 'on' : ''} disabled={running} onClick={() => setSamples(q.n)} title={q.hint}>
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="cleanup-row">
              <span>
                Real lens blur <Help text="True depth of field from the lens itself: out-of-focus things blur by how far they are from the focus, with round highlights, and nothing bleeds around edges. Our own depth of field steps aside while it renders. Uses at least 64 renders." />
              </span>
              <Switch on={lens} onChange={setLens} />
            </div>
            {lens && (
              <div className="cleanup-row">
                <span>
                  Aperture (f-stop) <Help text="Like a camera: lower = a wider opening and more blur (f/1.4 dreamy, f/2.8 portrait, f/8 mostly sharp)" />
                </span>
                <DragNumber value={fstop} step={0.05} digits={1} min={0.7} max={32} width={70} onCommit={(v) => setFstop(Math.max(0.7, Math.min(32, v)))} />
              </div>
            )}
            {lens && (
              <div className="cleanup-row">
                <span>
                  Also sharp at <Help text="A second distance kept sharp, in metres (0 = none): two renders through the lens, joined where each is sharper — focus stacking, e.g. a face and a hand held out toward the camera" />
                </span>
                <DragNumber value={focus2} step={0.01} digits={2} min={0} max={100} width={70} onCommit={(v) => setFocus2(Math.max(0, Math.min(100, v)))} />
              </div>
            )}
            {lens && (
              <div className="cleanup-row">
                <span>
                  Tilt focus <Help text="Tilts the sharp plane, in degrees, like a tilt lens: above 0 the top of the frame is focused further away (a floor running into the distance stays sharp), below 0 nearer. Large tilts with a wide aperture give the miniature look" />
                </span>
                <DragNumber value={tilt} step={0.1} digits={1} min={-45} max={45} width={70} onCommit={(v) => setTilt(Math.max(-45, Math.min(45, v)))} />
              </div>
            )}
            <div className="cleanup-row">
              <span>
                Ray-traced shade <Help text="Soft shade where things meet, from the scene's real shapes rather than what's on screen: under a chin, inside a hand, where a body sits on a sofa, also from things out of view. Uses Look › Picture › Ambient occlusion's radius, strength and colour (and takes its place for the picture). Needs a few seconds more; best with Smooth on." />
              </span>
              <Switch on={rtshade} onChange={setRtshade} />
            </div>
            <div className="cleanup-row">
              <span>
                16 bits per colour <Help text="PNG with 65,536 levels per colour instead of 256: smooth gradients that hold up to heavy editing afterwards. Bigger files." />
              </span>
              <Switch on={bits16 && format === 'png'} onChange={(v) => (format === 'png' ? setBits16(v) : toast('16-bit pictures are PNG only', 'error'))} />
            </div>
          </div>
        </div>

        <div className="look-card">
          <div className="look-card-head">
            <div>
              <b>
                File
                <Help text="PNG keeps every detail (and transparency); JPG is much smaller." />
              </b>
            </div>
          </div>
          <div className="look-card-body">
            <div className="cleanup-row">
              <span>Format</span>
              <div className="seg">
                {['png', 'jpg'].map((f) => (
                  <button key={f} className={format === f ? 'on' : ''} disabled={running} onClick={() => setFormat(f)}>
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            {format === 'jpg' && (
              <div className="cleanup-row">
                <span>JPG quality</span>
                <DragNumber value={quality} step={0.25} digits={0} min={50} max={100} width={70} onCommit={(v) => setQuality(Math.round(v))} />
              </div>
            )}
            <div className="cleanup-row">
              <span>
                Transparent background{' '}
                <Help text={canTransparent ? 'Leaves out the background (map and sky): cut-out characters with soft edges, ready to put on something else. Uses Screencap. PNG only.' : 'Needs Screencap (Screenshot Manager, part of BepisPlugins).'} />
              </span>
              <Switch on={transparent && format === 'png' && canTransparent} onChange={(v) => (canTransparent ? setTransparent(v) : toast('Transparent pictures need Screencap (BepisPlugins)', 'error'))} />
            </div>
            {st.screencap && (
              <div className="cleanup-row">
                <span>
                  Use Screencap <Help text="Screencap is installed: it takes the pictures (always for transparent ones). Off uses Keyframe Studio's own capture for normal pictures." />
                </span>
                <Switch on={st.useScreencap} onChange={(v) => bridge.request<Status>('still.set', { useScreencap: v }).then(setSt)} />
              </div>
            )}
          </div>
        </div>

        <FramingCard versions={versions} setVersions={setVersions} running={running} native={st.screen} />

        <div className="look-card wide">
          <div className="look-card-head">
            <div>
              <b>
                Pictures
                <Help text="Saved in UserData\cap, next to Screencap's own screenshots." />
              </b>
            </div>
            {window.studioEx?.openFolder && (
              <button className="btn small solid" onClick={() => window.studioEx?.openFolder?.(st.folder)}>
                Open folder
              </button>
            )}
          </div>
          <div className="look-card-body">
            {recent.length === 0 ? (
              <div className="hint">Pictures you take show up here.</div>
            ) : (
              <div className="still-grid">
                {recent.map((r) => (
                  <figure key={r.path} className="still" title={r.path}>
                    {r.thumb ? <img src={r.thumb} alt="" /> : <span />}
                    <figcaption>
                      {r.path.replace(/^.*[\\/]/, '')}
                      <small>
                        {r.width}×{r.height} · {r.provider}
                      </small>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

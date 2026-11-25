import { useCallback, useEffect, useRef, useState } from 'react';
import { call, toast } from '../state/store';
import { curveFn, formatCurve, IDENTITY, isIdentity, parseCurve, type Pt } from '../lib/toneCurve';
import { ParamRow, type Param, type Value } from './EffectsPage';
import { Help } from './Help';
import { Icon } from './Icon';
import { Switch } from './LookPanel';

/**
 * Look › Picture › Grading (Keyframe Studio): curves, colour by colour, split toning and film — one at a time. The
 * bridge bakes it all into a colour table; numbers are keyable (◆), curves are saved with the scene.
 */

const BANDS = [
  { id: 'red', label: 'Red', hue: 0 },
  { id: 'orange', label: 'Orange', hue: 30 },
  { id: 'yellow', label: 'Yellow', hue: 60 },
  { id: 'green', label: 'Green', hue: 120 },
  { id: 'aqua', label: 'Aqua', hue: 180 },
  { id: 'blue', label: 'Blue', hue: 240 },
  { id: 'purple', label: 'Purple', hue: 270 },
  { id: 'magenta', label: 'Magenta', hue: 300 },
] as const;

const CURVES = [
  { id: 'curveAll', label: 'All', color: '#e8e8ea' },
  { id: 'curveRed', label: 'Red', color: '#ff6b5e' },
  { id: 'curveGreen', label: 'Green', color: '#5fdc6f' },
  { id: 'curveBlue', label: 'Blue', color: '#6f9bff' },
] as const;

type Tab = 'curves' | 'colours' | 'split' | 'film';
const TABS: { id: Tab; label: string }[] = [
  { id: 'curves', label: 'Curves' },
  { id: 'colours', label: 'Colour by colour' },
  { id: 'split', label: 'Split toning' },
  { id: 'film', label: 'Film' },
];

const f = (key: string, label: string, min: number, max: number, step: number, help?: string): Param => ({ key, label, kind: 'float', min, max, step, help });
const SPLIT: Param[] = [
  f('shadowHue', 'Shadows colour', 0, 360, 1, 'A hue in degrees: 0 red, 30 orange, 60 yellow, 120 green, 180 aqua, 220 blue, 280 purple'),
  f('shadowAmount', 'Shadows amount', 0, 1, 0.01),
  f('highlightHue', 'Highlights colour', 0, 360, 1),
  f('highlightAmount', 'Highlights amount', 0, 1, 0.01),
  f('balance', 'Balance', -1, 1, 0.01, 'Where shadows end and highlights begin: below 0 more is highlight, above 0 more is shadow'),
];
const FILM: Param[] = [
  f('bleach', 'Bleach bypass', 0, 1, 0.01, 'The look of skipping the bleach when developing film: less colour, more contrast, silvery'),
  f('density', 'Density', 0, 1, 0.01, 'Rich colours get deeper and darker, like slide film'),
];

const remember = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const store = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* not remembered; fine */
  }
};

/** What Grading is doing, in a few words (for the Picture list). */
export function gradingSummary(v: Record<string, Value> | undefined): string {
  if (!v?.on) return 'Off';
  const parts: string[] = [];
  if (CURVES.some((c) => !isIdentity(v[c.id] as string))) parts.push('curves');
  const n = BANDS.filter((b) => ['Hue', 'Sat', 'Lum'].some((k) => Math.abs(Number(v[b.id + k] ?? 0)) > 1e-3)).length;
  if (n) parts.push(`${n} colour${n === 1 ? '' : 's'}`);
  if (Number(v.shadowAmount) > 0 || Number(v.highlightAmount) > 0) parts.push('split toning');
  if (Number(v.bleach) > 0) parts.push('bleach');
  if (Number(v.density) > 0) parts.push('density');
  return parts.length ? parts.join(', ') : 'On, nothing changed';
}

export function GradingCard() {
  const [v, setV] = useState<Record<string, Value> | null>(null);
  const [tab, setTabState] = useState<Tab>(() => remember('kf.grading.tab', 'curves') as Tab);
  const [band, setBandState] = useState(() => remember('kf.grading.band', 'red'));
  const [ch, setChState] = useState(() => remember('kf.grading.curve', 'curveAll'));
  const setTab = (t: Tab) => (setTabState(t), store('kf.grading.tab', t));
  const setBand = (b: string) => (setBandState(b), store('kf.grading.band', b));
  const setCh = (c: string) => (setChState(c), store('kf.grading.curve', c));

  const load = useCallback(() => {
    call<{ effects: Record<string, Record<string, Value>> }>('fx.get').then((r) => r?.effects?.grading && setV(r.effects.grading));
  }, []);
  useEffect(() => {
    load();
    const on = () => load();
    window.addEventListener('kf:picture-changed', on);
    window.addEventListener('kf:history', on);
    return () => {
      window.removeEventListener('kf:picture-changed', on);
      window.removeEventListener('kf:history', on);
    };
  }, [load]);

  // changes go out at most once a frame (a drag is many), merged
  const pending = useRef<Record<string, Value>>({});
  const raf = useRef(0);
  const set = (patch: Record<string, Value>) => {
    setV((cur) => (cur ? { ...cur, ...patch } : cur));
    Object.assign(pending.current, patch);
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const values = pending.current;
      pending.current = {};
      call('fx.set', { effect: 'grading', values }).then(() => window.dispatchEvent(new Event('kf:picture-edited')));
    });
  };

  if (!v) return null;
  const on = v.on === true;
  const bandDef = BANDS.find((b) => b.id === band) ?? BANDS[0];
  const changedBand = (id: string) => ['Hue', 'Sat', 'Lum'].some((k) => Math.abs(Number(v[id + k] ?? 0)) > 1e-3);
  const curve = CURVES.find((c) => c.id === ch) ?? CURVES[0];
  const reset = () =>
    call('fx.reset', { effect: 'grading' })
      .then(load)
      .then(() => window.dispatchEvent(new Event('kf:picture-edited')))
      .catch((e) => toast((e as Error).message, 'error'));

  return (
    <div className={`look-card fx-card grading ${on ? '' : 'off'}`}>
      <div className="look-card-head">
        <div>
          <b>
            Grading
            <Help text="Like a photo editor's colour panel: tone curves, each colour on its own, a colour for the shadows and one for the highlights, and film looks. Applied to the finished picture after Colour correction; saved with the scene, undoable, and the numbers can be keyed (◆)." />
          </b>
          <small className="src-tag">Keyframe Studio</small>
        </div>
        <button className="btn icon" title="Back to no grading" onClick={reset}>
          <Icon name="undo" size={13} />
        </button>
        <Switch on={on} onChange={(x) => set({ on: x })} />
      </div>
      <div className="look-card-body">
        <div className="seg grading-tabs" role="tablist" aria-label="Grading">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'curves' && (
          <div className="grading-curves">
            <div className="seg" role="group" aria-label="Channel">
              {CURVES.map((c) => (
                <button key={c.id} className={ch === c.id ? 'on' : ''} onClick={() => setCh(c.id)} title={isIdentity(v[c.id] as string) ? 'Unchanged' : 'Changed'}>
                  <span className="grading-dot" style={{ background: c.color, opacity: isIdentity(v[c.id] as string) ? 0.35 : 1 }} />
                  {c.label}
                </button>
              ))}
            </div>
            <ToneCurve value={(v[curve.id] as string) || IDENTITY} color={curve.color} onChange={(s) => set({ [curve.id]: s, on: true })} />
            <div className="grading-curve-foot">
              <small>Drag a point · click the line to add one · double-click a point to remove it</small>
              <button className="btn small solid" disabled={isIdentity(v[curve.id] as string)} onClick={() => set({ [curve.id]: IDENTITY })}>
                Straighten
              </button>
            </div>
          </div>
        )}

        {tab === 'colours' && (
          <>
            <div className="grading-bands" role="radiogroup" aria-label="Colour">
              {BANDS.map((b) => (
                <button
                  key={b.id}
                  role="radio"
                  aria-checked={band === b.id}
                  className={`grading-band ${band === b.id ? 'on' : ''}`}
                  title={b.label + (changedBand(b.id) ? ' (changed)' : '')}
                  onClick={() => setBand(b.id)}
                >
                  <span className="grading-swatch" style={{ background: `hsl(${b.hue} 85% 55%)` }} />
                  {changedBand(b.id) && <span className="grading-changed" />}
                </button>
              ))}
            </div>
            <div className="grading-band-name">
              <b>{bandDef.label}</b>
              <button className="btn small solid" disabled={!changedBand(bandDef.id)} onClick={() => set({ [bandDef.id + 'Hue']: 0, [bandDef.id + 'Sat']: 0, [bandDef.id + 'Lum']: 0 })}>
                Reset {bandDef.label.toLowerCase()}
              </button>
            </div>
            {[f(bandDef.id + 'Hue', 'Hue', -1, 1, 0.01, 'Shifts this colour toward its neighbours (up to 30°)'), f(bandDef.id + 'Sat', 'Saturation', -1, 1, 0.01), f(bandDef.id + 'Lum', 'Lightness', -1, 1, 0.01, 'Lighter or darker, only where this colour is (greys stay put)')].map((p) => (
              <ParamRow key={p.key} effect="grading" p={p} v={v[p.key] ?? 0} onSet={(x) => set({ ...x, on: true })} />
            ))}
          </>
        )}

        {tab === 'split' && SPLIT.map((p) => <ParamRow key={p.key} effect="grading" p={p} v={v[p.key] ?? 0} onSet={(x) => set({ ...x, on: true })} />)}
        {tab === 'film' && FILM.map((p) => <ParamRow key={p.key} effect="grading" p={p} v={v[p.key] ?? 0} onSet={(x) => set({ ...x, on: true })} />)}
      </div>
    </div>
  );
}

/** A tone curve to drag: points on a square, the curve through them as the bridge bakes it. */
function ToneCurve({ value, color, onChange }: { value: string; color: string; onChange: (s: string) => void }) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const pts = parseCurve(value);
  const fn = curveFn(pts);
  const S = 256;
  const toPt = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };
  const path = Array.from({ length: 65 }, (_, i) => {
    const x = i / 64;
    return `${i ? 'L' : 'M'}${(x * S).toFixed(1)},${((1 - fn(x)) * S).toFixed(1)}`;
  }).join(' ');
  const move = (e: React.PointerEvent) => {
    if (drag == null) return;
    const [x, y] = toPt(e);
    const next = pts.map((p) => [...p] as Pt);
    const last = next.length - 1;
    // ends stay at the edges; inner points stay between their neighbours
    const nx = drag === 0 ? 0 : drag === last ? 1 : Math.min(next[drag + 1][0] - 0.01, Math.max(next[drag - 1][0] + 0.01, x));
    next[drag] = [nx, y];
    onChange(formatCurve(next));
  };
  return (
    <svg
      ref={svg}
      className="tone-curve"
      viewBox={`0 0 ${S} ${S}`}
      onPointerMove={move}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
      onPointerDown={(e) => {
        if ((e.target as Element).tagName === 'circle') return;
        // a click on the square: a new point there, on the curve's height near the line
        const [x, y] = toPt(e);
        if (Math.abs(fn(x) - y) > 0.08) return;
        const next = [...pts, [x, fn(x)] as Pt].sort((a, b) => a[0] - b[0]);
        onChange(formatCurve(next));
        setDrag(next.findIndex((p) => p[0] === x));
        svg.current?.setPointerCapture(e.pointerId);
      }}
    >
      <rect x={0} y={0} width={S} height={S} className="tone-curve-bg" />
      {[0.25, 0.5, 0.75].map((g) => (
        <g key={g}>
          <line x1={g * S} y1={0} x2={g * S} y2={S} className="tone-curve-grid" />
          <line x1={0} y1={g * S} x2={S} y2={g * S} className="tone-curve-grid" />
        </g>
      ))}
      <line x1={0} y1={S} x2={S} y2={0} className="tone-curve-diag" />
      <path d={path} fill="none" stroke={color} strokeWidth={2} />
      {pts.map((p, i) => (
        <circle
          key={i}
          cx={p[0] * S}
          cy={(1 - p[1]) * S}
          r={drag === i ? 7 : 5.5}
          fill={color}
          stroke="#0d0f12"
          strokeWidth={1.5}
          style={{ cursor: 'grab' }}
          onPointerDown={(e) => {
            e.stopPropagation();
            setDrag(i);
            svg.current?.setPointerCapture(e.pointerId);
          }}
          onDoubleClick={() => {
            if (i === 0 || i === pts.length - 1) return;
            onChange(formatCurve(pts.filter((_, j) => j !== i)));
          }}
        />
      ))}
    </svg>
  );
}

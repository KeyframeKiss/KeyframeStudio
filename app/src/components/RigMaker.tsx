import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { call, displayName, studioSelect, toast, useStore } from '../state/store';
import { ask } from './Dialogs';
import { DragNumber } from './DragNumber';
import { Help } from './Help';
import { Icon } from './Icon';
import { ColorInput, Switch } from './LookPanel';
import { NumberBox } from './MaterialEditor';
import { AimRows } from './ProjectorsPanel';
import type { useAim } from './ProjectorsPanel';

/**
 * The lighting maker: a rig's lights around the character, seen from above (where around, how far) and as height
 * and distance — drag a light and it moves in Studio as you drag; the picked light's place and settings beside it in
 * metres and degrees. Lights are dropped in by kind, and the whole rig saves as a reusable rig.
 *
 * A rig keeps each light as az (degrees around from straight in front, + = the character's right), el (degrees above
 * what it aims at), dist (× the character's height) and aim (head or chest); shown here in metres from the floor.
 */

export interface Spec {
  id: number;
  name: string;
  type: 'spot' | 'point' | 'directional';
  az: number;
  el: number;
  dist: number;
  aim: 'head' | 'chest';
  color: number[];
  intensity: number;
  range: number;
  angle: number;
  shadow: boolean;
  enabled: boolean;
}
interface RigState {
  folder: number;
  name: string;
  height: number;
  head: number;
  chest: number;
  lights: Spec[];
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const rgb = (c?: number[]) => `rgb(${(c ?? [1, 1, 1]).slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')})`;
const KINDS: { id: Spec['type']; label: string; help: string }[] = [
  { id: 'spot', label: 'Spot', help: 'A cone of light, like a stage or key light' },
  { id: 'point', label: 'Point', help: 'Shines every way from where it is, like a bulb' },
  { id: 'directional', label: 'Sun', help: 'Parallel light from one direction, like the sun; only its direction counts' },
];
/** Starting places for dropped lights: key, fill, rim, then around. */
const DROPS = [
  { name: 'Key', az: 40, el: 30, dist: 1.6, color: [1, 0.92, 0.82], intensity: 1.6 },
  { name: 'Fill', az: -50, el: 10, dist: 1.4, color: [0.78, 0.86, 1], intensity: 0.7 },
  { name: 'Rim', az: 160, el: 35, dist: 1.5, color: [1, 1, 1], intensity: 1.5 },
  { name: 'Back', az: -150, el: 30, dist: 1.5, color: [1, 1, 1], intensity: 1.2 },
  { name: 'Top', az: 0, el: 70, dist: 1.2, color: [1, 1, 1], intensity: 0.8 },
];

export function RigMaker(props: { target: number | null; folder: number; light: number | null; aim: ReturnType<typeof useAim>; onPickLight: (id: number | null) => void; onRemoved: () => void }) {
  const { target, folder } = props;
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  const nodes = useStore((s) => s.nodes);
  const [rig, setRig] = useState<RigState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const lastEdit = useRef(-1e9);

  const load = useCallback(() => {
    if (target == null || status !== 'open') return;
    bridge
      .request<RigState>('light.rigGet', { id: target, folder })
      .then((r) => {
        if (performance.now() - lastEdit.current < 900) return;
        setRig(r);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message));
  }, [target, folder, status]);
  useEffect(load, [load, revision]);
  // lights moved in Studio show here too (paused while editing here)
  useEffect(() => {
    const h = window.setInterval(load, 1000);
    window.addEventListener('kf:history', load);
    return () => {
      window.clearInterval(h);
      window.removeEventListener('kf:history', load);
    };
  }, [load]);

  // edits: shown at once, sent once a frame per light; a drag is one undo step
  const pending = useRef(new Map<number, Partial<Spec>>());
  const frame = useRef(0);
  const drag = useRef('');
  const edit = (id: number, patch: Partial<Spec>, gesture?: string) => {
    lastEdit.current = performance.now();
    setRig((r) => r && { ...r, lights: r.lights.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
    pending.current.set(id, { ...(pending.current.get(id) ?? {}), ...patch });
    const key = gesture ?? `${id}-${Object.keys(patch).join(',')}-${Math.floor(performance.now() / 1500)}`;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const batch = [...pending.current.entries()];
      pending.current.clear();
      for (const [light, spec] of batch) bridge.request('light.rigPlace', { id: target, light, spec, drag: key }).catch((e) => toast((e as Error).message, 'error'));
    });
  };

  if (target == null) return <div className="pn-note">Select the character this rig lights, in the Scene list or in Studio.</div>;
  if (err) return <div className="pn-note">{err}</div>;
  if (!rig) return null;

  const H = rig.height;
  const aimY = (l: Spec) => (l.aim === 'chest' ? rig.chest : rig.head);
  const horiz = (l: Spec) => l.dist * Math.cos(rad(l.el)) * H;
  const high = (l: Spec) => aimY(l) + l.dist * Math.sin(rad(l.el)) * H;
  /** az / el / dist for a light at this horizontal distance and height above the floor */
  const place = (l: Spec, hz: number, height: number, aim = l.aim) => {
    const v = height - (aim === 'chest' ? rig.chest : rig.head);
    const h = Math.max(0.05, hz);
    return { dist: Math.max(0.05, Math.hypot(h, v) / H), el: deg(Math.atan2(v, h)) };
  };
  const sel = rig.lights.find((l) => l.id === props.light) ?? rig.lights[0] ?? null;

  const add = async (type: Spec['type']) => {
    const used = new Set(rig.lights.map((l) => l.name));
    const d = DROPS.find((x) => !used.has(x.name)) ?? { ...DROPS[0], name: `Light ${rig.lights.length + 1}`, az: (rig.lights.length * 67) % 360 - 180 };
    const spec = { role: d.name, name: d.name, type, az: d.az, el: d.el, dist: d.dist, aim: 'head', color: d.color, intensity: d.intensity, range: 3, angle: 45, shadow: false };
    try {
      const r = await bridge.request<{ light: number }>('light.rigAdd', { id: target, folder, spec });
      lastEdit.current = -1e9;
      load();
      props.onPickLight(r.light);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const retype = async (l: Spec, type: Spec['type']) => {
    if (l.type === type) return;
    try {
      const r = await bridge.request<{ light: number }>('light.rigRetype', { id: target, light: l.id, type });
      lastEdit.current = -1e9;
      load();
      props.onPickLight(r.light);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const removeLight = async (l: Spec) => {
    if (!(await ask(`Remove “${l.name}” from the rig? This can't be undone, like deleting in Studio.`))) return;
    if (await call('light.remove', { id: l.id })) {
      lastEdit.current = -1e9;
      load();
      props.onPickLight(null);
    }
  };
  const removeRig = async () => {
    if (!(await ask(`Remove the “${rig.name}” rig and its ${rig.lights.length} light${rig.lights.length === 1 ? '' : 's'} from the scene? This can't be undone, like deleting in Studio.`))) return;
    if (await call('light.removeRig', { folder })) (toast(`Removed the ${rig.name} rig`), props.onRemoved());
  };
  const on = rig.lights.some((l) => l.enabled);

  return (
    <>
      <div className={`look-card fx-card ${on ? '' : 'off'}`}>
        <div className="look-card-head">
          <div>
            <b>{rig.name}</b>
            <small>
              Around {displayName(nodes[target])}, {rig.lights.length} light{rig.lights.length === 1 ? '' : 's'}
            </small>
          </div>
          <span className="lm-add">
            <span>Add</span>
            {KINDS.map((k) => (
              <button key={k.id} className="btn small solid" title={k.help} onClick={() => add(k.id)}>
                <Icon name="plus" size={11} /> {k.label}
              </button>
            ))}
          </span>
          <button className="btn icon" title="Select the rig's folder in Studio" onClick={() => studioSelect([folder])}>
            <Icon name="target" size={13} />
          </button>
          <Switch on={on} onChange={(v) => call('light.setRigEnabled', { folder, enabled: v }).then(() => ((lastEdit.current = -1e9), load()))} />
          <button className="btn small solid danger" onClick={removeRig}>
            <Icon name="trash" size={12} />
            Remove
          </button>
        </div>
        <div className="look-card-body">
          <Stage rig={rig} sel={sel?.id ?? null} horiz={horiz} high={high} place={place} onPick={(id) => props.onPickLight(id)} onEdit={edit} drag={drag} />
        </div>
      </div>

      {sel && (
        <div className={`look-card fx-card ${sel.enabled ? '' : 'off'}`}>
          <div className="look-card-head">
            <div>
              <input className="input lm-name" value={sel.name} title="Its name" onChange={(e) => edit(sel.id, { name: e.target.value }, `${sel.id}-name`)} />
            </div>
            <button className="btn icon" title="Select it in Studio to move or turn it with the handles" onClick={() => studioSelect([sel.id])}>
              <Icon name="target" size={13} />
            </button>
            <Switch on={sel.enabled} onChange={(enabled) => edit(sel.id, { enabled })} />
            <button className="btn small solid danger" onClick={() => removeLight(sel)}>
              <Icon name="trash" size={12} />
              Remove
            </button>
          </div>
          <div className="look-card-body">
            <div className="fx-row">
              <label>Kind</label>
              <span>
                <span className="seg">
                  {KINDS.map((k) => (
                    <button key={k.id} className={sel.type === k.id ? 'on' : ''} title={k.help} onClick={() => retype(sel, k.id)}>
                      {k.label}
                    </button>
                  ))}
                </span>
              </span>
              <span className="fx-tools" />
            </div>
            <div className="fx-row">
              <label>
                Points at
                <Help text="Where it aims; it stays where it is when you change this" />
              </label>
              <span>
                <span className="seg">
                  {(['head', 'chest'] as const).map((a) => (
                    <button key={a} className={sel.aim === a ? 'on' : ''} onClick={() => edit(sel.id, { aim: a, ...place(sel, horiz(sel), high(sel), a) })}>
                      {a === 'head' ? 'Head' : 'Chest'}
                    </button>
                  ))}
                </span>
              </span>
              <span className="fx-tools" />
            </div>
            <div className="fx-row">
              <label>
                Place
                <Help text="Around: degrees from straight in front of the character (+ their right, ± 180 behind). Distance: metres from the character along the floor. Height: metres above the floor. Drag a number sideways or click to type." />
              </label>
              <span className="lm-place">
                <DragNumber label="Around" value={Math.round(sel.az * 10) / 10} step={1} digits={0} unit="°" onPreview={(az) => edit(sel.id, { az }, `${sel.id}-az`)} onCommit={(az) => edit(sel.id, { az }, `${sel.id}-az`)} />
                <DragNumber
                  label="Distance"
                  value={horiz(sel)}
                  step={0.01}
                  digits={2}
                  unit=" m"
                  min={0.05}
                  onPreview={(hz) => edit(sel.id, place(sel, hz, high(sel)), `${sel.id}-hz`)}
                  onCommit={(hz) => edit(sel.id, place(sel, hz, high(sel)), `${sel.id}-hz`)}
                />
                <DragNumber
                  label="Height"
                  value={high(sel)}
                  step={0.01}
                  digits={2}
                  unit=" m"
                  onPreview={(y) => edit(sel.id, place(sel, horiz(sel), y), `${sel.id}-y`)}
                  onCommit={(y) => edit(sel.id, place(sel, horiz(sel), y), `${sel.id}-y`)}
                />
              </span>
              <span className="fx-tools" />
            </div>
            <div className="fx-row">
              <label>Colour</label>
              <span>
                <ColorInput value={sel.color} onChange={(c) => edit(sel.id, { color: [c[0], c[1], c[2]] }, `${sel.id}-color`)} />
              </span>
              <span className="fx-tools" />
            </div>
            <NumRow label="Strength" value={sel.intensity} min={0} max={3} step={0.01} onChange={(intensity) => edit(sel.id, { intensity }, `${sel.id}-i`)} />
            {sel.type !== 'directional' && (
              <NumRow label="Reach" help="How far it shines, in metres" value={sel.range * H} min={0.1} max={30} step={0.1} onChange={(m) => edit(sel.id, { range: m / H }, `${sel.id}-r`)} />
            )}
            {sel.type === 'spot' && <NumRow label="Cone" help="The beam's width in degrees" value={sel.angle} min={1} max={179} step={1} onChange={(angle) => edit(sel.id, { angle }, `${sel.id}-a`)} />}
            <div className="fx-row">
              <label>Shadows</label>
              <span>
                <Switch on={sel.shadow} onChange={(shadow) => edit(sel.id, { shadow })} />
              </span>
              <span className="fx-tools" />
            </div>
            {props.aim.st?.lights.some((l) => l.id === sel.id) && (
              <>
                <div className="ct-label">Follow</div>
                <AimRows lightId={sel.id} aim={props.aim} />
              </>
            )}
          </div>
        </div>
      )}

      <SaveRig folder={folder} target={target} name={rig.name} />
    </>
  );
}

function NumRow({ label, help, value, min, max, step, onChange }: { label: string; help?: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div className="fx-row">
      <label>
        {label}
        {help && <Help text={help} />}
      </label>
      <span className="fx-slider">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <NumberBox value={Number(value.toFixed(3))} step={step} min={min} onChange={onChange} />
      </span>
      <span className="fx-tools" />
    </div>
  );
}

function SaveRig({ folder, target, name }: { folder: number; target: number; name: string }) {
  const [v, setV] = useState('');
  return (
    <div className="look-card fx-card">
      <div className="look-card-head">
        <div>
          <b>Save as a rig</b>
          <small>Fits any character later, under Lighting rigs</small>
        </div>
        <Help text="Saves where each light is around the character (by their height and the way they face), its kind, colour, strength, reach, cone and shadows, as a rig in UserData/StudioEX/light-rigs." />
        <input className="input" style={{ width: 180 }} placeholder={name} value={v} onChange={(e) => setV(e.target.value)} />
        <button
          className="btn small solid"
          onClick={async () => {
            const r = await call('light.saveRig', { name: v.trim() || name, id: target, folder });
            if (r) (toast(`Saved the rig “${v.trim() || name}”`, 'done'), setV(''));
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- the stage

const TOP = { w: 320, h: 320, cx: 160, cy: 160, r: 145 };
const SIDE = { w: 300, h: 320, x0: 260, floor: 300 };

function Stage(props: {
  rig: RigState;
  sel: number | null;
  horiz: (l: Spec) => number;
  high: (l: Spec) => number;
  place: (l: Spec, hz: number, height: number) => { dist: number; el: number };
  onPick: (id: number) => void;
  onEdit: (id: number, patch: Partial<Spec>, gesture?: string) => void;
  drag: React.MutableRefObject<string>;
}) {
  const { rig, horiz, high } = props;
  // one scale for both views (metres → px), room for the farthest and highest light
  const far = Math.max(2.5, ...rig.lights.map((l) => horiz(l) + 0.4));
  const tall = Math.max(rig.head * 1.45, ...rig.lights.map((l) => high(l) + 0.3));
  const [scale, setScale] = useState(() => Math.min(TOP.r / far, 270 / far, 280 / tall));
  // grow to fit, never shrink under the pointer mid-drag
  const want = Math.min(TOP.r / far, 270 / far, 280 / tall);
  useEffect(() => {
    if (!props.drag.current && Math.abs(want - scale) / scale > 0.05) setScale(want);
  }, [want]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = scale;

  const top = (l: Spec) => {
    const r = horiz(l) * s;
    return { x: TOP.cx - Math.sin(rad(l.az)) * r, y: TOP.cy + Math.cos(rad(l.az)) * r };
  };
  const side = (l: Spec) => ({ x: SIDE.x0 - horiz(l) * s, y: SIDE.floor - high(l) * s });

  const svgPoint = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const m = svg.getScreenCTM();
    if (!m) return null;
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    return p.matrixTransform(m.inverse());
  };
  const start = (e: React.PointerEvent, l: Spec, view: 'top' | 'side') => {
    e.stopPropagation();
    (e.currentTarget.closest('svg') as SVGSVGElement).setPointerCapture(e.pointerId);
    props.onPick(l.id);
    props.drag.current = `${view}:${l.id}:${Date.now()}`;
  };
  const move = (e: React.PointerEvent<SVGSVGElement>, view: 'top' | 'side') => {
    const d = props.drag.current;
    if (!d || !d.startsWith(view)) return;
    const id = Number(d.split(':')[1]);
    const l = rig.lights.find((x) => x.id === id);
    const p = svgPoint(e);
    if (!l || !p) return;
    if (view === 'top') {
      const dx = p.x - TOP.cx;
      const dy = p.y - TOP.cy;
      const hz = Math.max(0.1, Math.hypot(dx, dy) / s);
      // Shift: only around (keeps the distance)
      const az = deg(Math.atan2(-dx, dy));
      props.onEdit(id, e.shiftKey ? { az } : { az, ...props.place(l, hz, high(l)) }, d);
    } else {
      const hz = Math.max(0.1, (SIDE.x0 - p.x) / s);
      const y = (SIDE.floor - p.y) / s;
      props.onEdit(id, e.shiftKey ? props.place(l, horiz(l), y) : props.place(l, hz, y), d);
    }
  };
  const end = () => {
    props.drag.current = '';
  };

  const rings = [1, 2, 3, 4, 5].filter((m) => m * s < TOP.r + 4);
  const headY = SIDE.floor - rig.head * s;
  return (
    <div className="lm-stage">
      <figure>
        <svg viewBox={`0 0 ${TOP.w} ${TOP.h}`} className="lm-svg" onPointerMove={(e) => move(e, 'top')} onPointerUp={end} onPointerCancel={end}>
          <rect width={TOP.w} height={TOP.h} className="lm-bg" />
          {rings.map((m) => (
            <g key={m}>
              <circle cx={TOP.cx} cy={TOP.cy} r={m * s} className="rig-ring" />
              <text x={TOP.cx + 3} y={TOP.cy - m * s - 3} className="lm-tick">
                {m} m
              </text>
            </g>
          ))}
          <line x1={TOP.cx} y1={TOP.cy} x2={TOP.cx} y2={TOP.cy + TOP.r} className="lm-front" />
          {rig.lights.map((l) => {
            const p = top(l);
            if (l.type !== 'spot') return <circle key={`g${l.id}`} cx={p.x} cy={p.y} r={22} fill={rgb(l.color)} opacity={l.enabled ? 0.18 : 0.05} />;
            const a = Math.atan2(TOP.cy - p.y, TOP.cx - p.x);
            const half = rad(Math.min(40, Math.max(6, l.angle / 2)));
            const len = Math.hypot(TOP.cx - p.x, TOP.cy - p.y) + 26;
            return (
              <path
                key={`g${l.id}`}
                d={`M${p.x},${p.y} L${p.x + Math.cos(a - half) * len},${p.y + Math.sin(a - half) * len} L${p.x + Math.cos(a + half) * len},${p.y + Math.sin(a + half) * len} Z`}
                fill={rgb(l.color)}
                opacity={l.enabled ? 0.16 : 0.05}
              />
            );
          })}
          <ellipse cx={TOP.cx} cy={TOP.cy - 1} rx={26} ry={11} className="rig-body" />
          <circle cx={TOP.cx} cy={TOP.cy} r={11} className="rig-head" />
          <path d={`M${TOP.cx - 5},${TOP.cy + 9} L${TOP.cx},${TOP.cy + 17} L${TOP.cx + 5},${TOP.cy + 9} Z`} className="rig-nose" />
          {rig.lights.map((l) => {
            const p = top(l);
            return (
              <g key={l.id} className={`lm-lamp ${props.sel === l.id ? 'on' : ''} ${l.enabled ? '' : 'off'}`} onPointerDown={(e) => start(e, l, 'top')}>
                <circle cx={p.x} cy={p.y} r={11} fill={rgb(l.color)} />
                <text x={p.x} y={p.y + 3.5}>
                  {(l.name || '?').slice(0, 1)}
                </text>
              </g>
            );
          })}
        </svg>
        <figcaption>From above: drag a light around the character (Shift keeps its distance)</figcaption>
      </figure>
      <figure>
        <svg viewBox={`0 0 ${SIDE.w} ${SIDE.h}`} className="lm-svg" onPointerMove={(e) => move(e, 'side')} onPointerUp={end} onPointerCancel={end}>
          <rect width={SIDE.w} height={SIDE.h} className="lm-bg" />
          {[0.5, 1, 1.5, 2, 2.5, 3].filter((m) => m * s < SIDE.floor - 6).map((m) => (
            <g key={m}>
              <line x1={8} x2={SIDE.w - 8} y1={SIDE.floor - m * s} y2={SIDE.floor - m * s} className="lm-grid" />
              <text x={10} y={SIDE.floor - m * s - 3} className="lm-tick">
                {m} m
              </text>
            </g>
          ))}
          <line x1={8} x2={SIDE.w - 8} y1={SIDE.floor} y2={SIDE.floor} className="rig-ground" />
          {/* the character, as tall as they are */}
          <line x1={SIDE.x0} y1={SIDE.floor} x2={SIDE.x0} y2={headY + 9} className="lm-figure" />
          <circle cx={SIDE.x0} cy={headY} r={9} className="rig-head" />
          {rig.lights.map((l) => {
            const p = side(l);
            const ay = SIDE.floor - (l.aim === 'chest' ? rig.chest : rig.head) * s;
            return <line key={`r${l.id}`} x1={p.x} y1={p.y} x2={SIDE.x0} y2={ay} stroke={rgb(l.color)} className="rig-ray" opacity={l.enabled ? 1 : 0.3} />;
          })}
          {rig.lights.map((l) => {
            const p = side(l);
            return (
              <g key={l.id} className={`lm-lamp ${props.sel === l.id ? 'on' : ''} ${l.enabled ? '' : 'off'}`} onPointerDown={(e) => start(e, l, 'side')}>
                <line x1={p.x} y1={p.y} x2={p.x} y2={SIDE.floor} className="lm-stand" />
                <circle cx={p.x} cy={p.y} r={10} fill={rgb(l.color)} />
                <text x={p.x} y={p.y + 3.5}>
                  {(l.name || '?').slice(0, 1)}
                </text>
              </g>
            );
          })}
        </svg>
        <figcaption>Height and distance: drag up, down, nearer or farther (Shift keeps its distance)</figcaption>
      </figure>
    </div>
  );
}

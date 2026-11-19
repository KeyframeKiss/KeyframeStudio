import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { call, displayName, liveTime, refreshTimeline, setNodeVisible, showTab, toast, useStore } from '../state/store';
import { Help } from './Help';
import { Icon } from './Icon';
import { ColorInput, Switch } from './LookPanel';
import { NumberBox } from './MaterialEditor';
import { Popover } from './Shell';
import { Col, Columns, Page, Section } from './Page';

// ---------------------------------------------------------------------------
// Look › Effects: xukmi FX items when that mod is installed (it's what many scenes use), then Keyframe Studio's
// own effects on Studio's camera — the same kinds of effect without needing any mod. Ours are saved with the
// scene, undoable, and every value can be animated.
// ---------------------------------------------------------------------------

type Value = number | boolean | number[];
type Fx = Record<string, Record<string, Value>>;
interface FxState {
  effects: Fx;
  focusNow: number;
  ready: boolean;
  error: string | null;
  camera: boolean;
}
interface XukmiItem {
  id: number;
  name: string;
  effect: string;
  visible: boolean;
}
interface XukmiCatalog {
  group: number;
  category: number;
  no: number;
  name: string;
  categoryName: string;
}
interface Xukmi {
  installed: boolean;
  items: XukmiItem[];
  catalog: XukmiCatalog[];
}

interface Param {
  key: string;
  label: string;
  kind: 'float' | 'color' | 'bool' | 'choice' | 'chara';
  options?: { v: number; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  help?: string;
  advanced?: boolean;
  /** colour whose alpha is a strength (shown as a slider) */
  alpha?: string;
}
interface EffectDef {
  id: string;
  title: string;
  help: string;
  /** xukmi effects (shader names) doing the same job — on together they double up */
  xukmi: string[];
  /** Studio's own effect of the same kind (look.get effects key) */
  studio?: string;
  params: Param[];
}

const EFFECTS: EffectDef[] = [
  {
    id: 'fog',
    title: 'Two-tone fog',
    help: 'Fog that fades from one colour close by to another far away — warm haze in front, cool depth behind. Works on depth, so it wraps around characters and props.',
    xukmi: ['TwoToneFog'],
    studio: 'fog',
    params: [
      { key: 'near', label: 'Near colour', kind: 'color', alpha: 'Near strength' },
      { key: 'far', label: 'Far colour', kind: 'color', alpha: 'Far strength' },
      { key: 'density', label: 'Density', kind: 'float', min: 0, max: 0.5, step: 0.001, help: 'How quickly it thickens with distance' },
      { key: 'start', label: 'Starts at', kind: 'float', min: 0, max: 20, step: 0.05, help: 'Clear space in front of the camera (metres)' },
      { key: 'split', label: 'Colour change', kind: 'float', min: 0, max: 1, step: 0.01, help: 'How deep into the fog the near colour turns into the far one' },
      { key: 'softness', label: 'Change softness', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'height', label: 'Ground height', kind: 'float', min: -5, max: 10, step: 0.05, advanced: true, help: 'Fog thins out above this height' },
      { key: 'heightFalloff', label: 'Thins with height', kind: 'float', min: 0, max: 3, step: 0.01, advanced: true, help: '0 = same everywhere; higher = settles low like mist' },
      { key: 'sky', label: 'Fog the sky', kind: 'bool', advanced: true },
      { key: 'skyDistance', label: 'Sky distance', kind: 'float', min: 5, max: 300, step: 1, advanced: true, help: 'How far away the sky counts as' },
    ],
  },
  {
    id: 'grade',
    title: 'Colour correction',
    help: 'Exposure, white balance, contrast and saturation on the final picture, after Studio’s own colour grade (LUT).',
    xukmi: ['ColorCorrection'],
    params: [
      { key: 'exposure', label: 'Exposure', kind: 'float', min: -3, max: 3, step: 0.01, help: 'In stops: +1 = twice as bright' },
      { key: 'contrast', label: 'Contrast', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'saturation', label: 'Saturation', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'vibrance', label: 'Vibrance', kind: 'float', min: -1, max: 1, step: 0.01, help: 'Saturates dull colours more than vivid ones (skin stays natural)' },
      { key: 'temperature', label: 'Temperature', kind: 'float', min: -1, max: 1, step: 0.01, help: 'Cool (blue) ← → warm (orange)' },
      { key: 'tint', label: 'Tint', kind: 'float', min: -1, max: 1, step: 0.01, help: 'Green ← → magenta' },
      { key: 'brightness', label: 'Brightness', kind: 'float', min: -1, max: 1, step: 0.01 },
      { key: 'amount', label: 'Mix', kind: 'float', min: 0, max: 1, step: 0.01, help: 'How much of the correction to use' },
      { key: 'filter', label: 'Colour filter', kind: 'color', advanced: true, help: 'Multiplies the picture (white = none)' },
      { key: 'lift', label: 'Shadows (lift)', kind: 'color', advanced: true, help: 'Tints the darks (black = none)' },
      { key: 'gamma', label: 'Midtones (gamma)', kind: 'color', advanced: true, help: 'Tints the middle tones (white = none)' },
      { key: 'gain', label: 'Highlights (gain)', kind: 'color', advanced: true, help: 'Tints the brights (white = none)' },
    ],
  },
  {
    id: 'dof',
    title: 'Depth of field',
    help: 'Bokeh blur: what is in focus stays sharp, the rest melts into round highlights — in front and behind. Focus can follow a character’s eyes as they move, or the centre of the view. Looks the same in stills at any size.',
    xukmi: ['DepthOfFieldHighBokeh', 'DepthOfFieldHigh', 'DepthOfFieldHighBox', 'DepthOfFieldMidBokeh', 'DepthOfFieldMid', 'DepthOfFieldMidBox', 'DepthOfFieldLowBokeh', 'DepthOfFieldLow', 'DepthOfFieldLowBox'],
    studio: 'dof',
    params: [
      {
        key: 'autoFocus',
        label: 'Focus on',
        kind: 'choice',
        options: [
          { v: 2, label: 'Eyes' },
          { v: 1, label: 'View centre' },
          { v: 0, label: 'Fixed' },
        ],
        help: 'Eyes: a character’s eyes, wherever they move. View centre: what Studio’s camera turns around. Fixed: the distance below (animate it for focus pulls).',
      },
      { key: 'chara', label: 'Character', kind: 'chara' },
      { key: 'focus', label: 'Focus distance', kind: 'float', min: 0.1, max: 30, step: 0.01, help: 'Metres from the camera. Follows the eyes / view centre unless focus is Fixed.' },
      { key: 'blur', label: 'Blur', kind: 'float', min: 0, max: 1, step: 0.01, help: 'How quickly things leave focus — like opening the lens wider' },
      { key: 'maxBlur', label: 'Biggest blur', kind: 'float', min: 0.002, max: 0.05, step: 0.001, help: 'The size of the blur far from focus' },
      { key: 'near', label: 'Blur in front too', kind: 'bool' },
    ],
  },
  {
    id: 'sharpen',
    title: 'Sharpen',
    help: 'Contrast-adaptive sharpening: crisper detail without halos around edges that are already sharp.',
    xukmi: ['Sharpness', 'ContrastAdaptiveSharpness'],
    params: [{ key: 'amount', label: 'Amount', kind: 'float', min: 0, max: 1, step: 0.01 }],
  },
  {
    id: 'vignette',
    title: 'Vignette',
    help: 'Darkens (or tints) the corners to draw the eye to the middle.',
    xukmi: ['Vignette'],
    studio: 'vignette',
    params: [
      { key: 'intensity', label: 'Intensity', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'smoothness', label: 'Softness', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'roundness', label: 'Roundness', kind: 'float', min: 0, max: 1, step: 0.01, help: '1 = a circle; 0 = follows the frame’s shape' },
      { key: 'color', label: 'Colour', kind: 'color' },
    ],
  },
  {
    id: 'aberration',
    title: 'Chromatic aberration',
    help: 'Coloured fringes towards the edges, like a real lens.',
    xukmi: ['ChromaticAberration'],
    params: [{ key: 'amount', label: 'Amount', kind: 'float', min: 0, max: 2, step: 0.01 }],
  },
  {
    id: 'grain',
    title: 'Film grain',
    help: 'Fine moving noise, strongest in the midtones, like film. Hides banding in gradients.',
    xukmi: [],
    params: [
      { key: 'amount', label: 'Amount', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'size', label: 'Size', kind: 'float', min: 1, max: 3, step: 0.05 },
    ],
  },
];

const XUKMI_NAMES: Record<string, string> = {
  TwoToneFog: 'Two-tone fog',
  ColorCorrection: 'Colour correction',
  ContrastAdaptiveSharpness: 'Sharpening (CAS)',
  Sharpness: 'Sharpening',
  ChromaticAberration: 'Chromatic aberration',
};
const xukmiLabel = (e: string) => XUKMI_NAMES[e] ?? e.replace(/([a-z])([A-Z])/g, '$1 $2');

export function EffectsPage() {
  const status = useStore((s) => s.status);
  const [fx, setFx] = useState<FxState | null>(null);
  const [xk, setXk] = useState<Xukmi | null>(null);
  const [studioFx, setStudioFx] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    bridge
      .request<FxState>('fx.get')
      .then((s) => {
        setFx(s);
        setErr('');
      })
      .catch((e) => setErr((e as Error).message));
    call<Xukmi>('fx.xukmi').then((x) => x && setXk(x));
    call<{ effects: Record<string, unknown> }>('look.get').then((l) => l && setStudioFx(l.effects));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load]);
  useEffect(() => {
    const h = () => load();
    window.addEventListener('kf:history', h);
    window.addEventListener('focus', h);
    const off = bridge.on('fx.changed', (d) => setFx(d as FxState));
    return () => {
      window.removeEventListener('kf:history', h);
      window.removeEventListener('focus', h);
      off?.();
    };
  }, [load]);

  // live edits: one request per frame per effect, replies ignored while still dragging
  const pending = useRef(new Map<string, Record<string, Value>>());
  const frame = useRef(0);
  const set = (effect: string, values: Record<string, Value>) => {
    setFx((s) => s && { ...s, effects: { ...s.effects, [effect]: { ...s.effects[effect], ...values } } });
    pending.current.set(effect, { ...(pending.current.get(effect) ?? {}), ...values });
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const batch = [...pending.current.entries()];
      pending.current.clear();
      for (const [effect, vals] of batch) bridge.request('fx.set', { effect, values: vals }).catch((e) => toast((e as Error).message, 'error'));
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  if (status !== 'open') return <div className="fx-empty">Connect to CharaStudio to use effects.</div>;
  if (err) return <div className="fx-empty">{err}</div>;
  if (!fx) return <div className="fx-empty">Reading effects…</div>;

  const xkVisible = (names: string[]) => (xk?.items ?? []).filter((i) => i.visible && names.includes(i.effect));
  const studioOn = (k?: string) => !!k && !!studioFx && studioFx[k] === true;

  const card = (id: string) => {
    const def = EFFECTS.find((d) => d.id === id)!;
    return (
      <EffectCard
        key={def.id}
        def={def}
        values={fx.effects[def.id]}
        onSet={(v) => set(def.id, v)}
        onReset={() => bridge.request('fx.reset', { effect: def.id }).then(load)}
        doubles={[...xkVisible(def.xukmi).map((i) => `xukmi's ${xukmiLabel(i.effect)} (${i.name})`), ...(studioOn(def.studio) ? [`Studio's own ${def.studio === 'dof' ? 'depth of field' : def.studio}`] : [])]}
      />
    );
  };

  return (
    <Page>
      {xk?.installed && <XukmiSection xk={xk} reload={load} />}
      <Section
        title="Keyframe Studio effects"
        help="Built in — no mod needed. They run after Studio's own effects, are saved with the scene, Ctrl+Z undoes them, and ◆ beside a value adds a Timeline track for it."
        actions={
          <button className="btn" onClick={() => bridge.request('fx.reset').then(load)} title="Turn every built-in effect off and back to its starting values">
            Reset all
          </button>
        }
      >
        {!fx.ready && <div className="fx-warn">Effects can't run: {fx.error ?? 'the shaders didn’t load'}</div>}
        {/* by kind, balanced by height: atmosphere · colour · lens */}
        <Columns>
          <Col label="Atmosphere">
            {card('fog')}
            {card('dof')}
          </Col>
          <Col label="Colour & detail">
            {card('grade')}
            {card('sharpen')}
          </Col>
          <Col label="Lens">
            {card('vignette')}
            {card('aberration')}
            {card('grain')}
          </Col>
        </Columns>
      </Section>
    </Page>
  );
}

function XukmiSection({ xk, reload }: { xk: Xukmi; reload: () => void }) {
  const fxCatalog = xk.catalog.filter((c) => /fx/i.test(c.categoryName) || !c.categoryName);
  const others = xk.catalog.filter((c) => !fxCatalog.includes(c));
  const add = async (c: XukmiCatalog) => {
    try {
      await bridge.request('fx.addXukmi', { group: c.group, category: c.category, no: c.no });
      toast(`Added xukmi ${c.name}`);
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const edit = async (id: number) => {
    await call('scene.select', { ids: [id] });
    showTab('look', 'materials');
  };
  return (
    <Section
      title="xukmi FX in this scene"
      help="xukmi FX Shaders is installed. Its effects are items in the scene; their values are material settings, so Edit opens them in Materials. Hiding one turns it off."
      actions={
        <Popover
          align="right"
          placement="down"
          width={280}
          trigger={(open, toggle) => (
            <button className={`btn ${open ? 'on' : ''}`} onClick={toggle}>
              <Icon name="plus" size={13} /> Add xukmi effect
            </button>
          )}
        >
          {(close) => (
            <div className="layout-menu fx-add-menu">
              {[
                ['Effects', fxCatalog],
                ['Projectors, blur', others],
              ].map(([title, list]) =>
                (list as XukmiCatalog[]).length ? (
                  <div key={title as string}>
                    <div className="layout-menu-h">{title as string}</div>
                    {(list as XukmiCatalog[]).map((c) => (
                      <button key={`${c.group}.${c.category}.${c.no}`} className="menu-item" onClick={() => (close(), add(c))}>
                        {c.name}
                        {c.categoryName && title !== 'Effects' && <small> · {c.categoryName}</small>}
                      </button>
                    ))}
                  </div>
                ) : null,
              )}
            </div>
          )}
        </Popover>
      }
    >
      {xk.items.length === 0 ? (
        <div className="fx-none">None in this scene. Add one, or use the built-in effects below.</div>
      ) : (
        <div className="fx-xk-list">
          {xk.items.map((i) => (
            <div key={i.id} className={`fx-xk ${i.visible ? '' : 'off'}`}>
              <Switch
                on={i.visible}
                onChange={(v) => {
                  setNodeVisible(i.id, v);
                  setTimeout(reload, 300);
                }}
              />
              <span className="fx-xk-name">
                <b>{xukmiLabel(i.effect)}</b>
                <small>{i.name}</small>
              </span>
              <button className="btn" onClick={() => edit(i.id)} title="Select it and open its values in Look › Materials">
                Edit
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function EffectCard({ def, values, onSet, onReset, doubles }: { def: EffectDef; values: Record<string, Value>; onSet: (v: Record<string, Value>) => void; onReset: () => void; doubles: string[] }) {
  const [more, setMore] = useState(false);
  const on = values.on === true;
  const shown = (p: Param) => !(p.kind === 'chara' && Math.round(values.autoFocus as number) !== 2);
  const basic = def.params.filter((p) => !p.advanced && shown(p));
  const advanced = def.params.filter((p) => p.advanced);
  return (
    <div className={`look-card fx-card ${on ? '' : 'off'}`}>
      <div className="look-card-head">
        <div>
          <b>
            {def.title}
            <Help text={def.help} />
          </b>
        </div>
        <button className="btn icon" title="Back to the starting values" onClick={onReset}>
          <Icon name="undo" size={13} />
        </button>
        <Switch on={on} onChange={(v) => onSet({ on: v })} />
      </div>
      <div className="look-card-body">
        {on && doubles.length > 0 && (
          <div className="fx-warn" title="Both apply on top of each other">
            Also on: {doubles.join(', ')}
          </div>
        )}
        {basic.map((p) => (
          <ParamRow key={p.key} effect={def.id} p={p} v={values[p.key]} onSet={onSet} />
        ))}
        {advanced.length > 0 && (
          <>
            <button className="fx-more" onClick={() => setMore((m) => !m)}>
              <Icon name={more ? 'chevronDown' : 'chevronRight'} size={12} /> More
            </button>
            {more && advanced.map((p) => <ParamRow key={p.key} effect={def.id} p={p} v={values[p.key]} onSet={onSet} />)}
          </>
        )}
      </div>
    </div>
  );
}

function ParamRow({ effect, p, v, onSet }: { effect: string; p: Param; v: Value; onSet: (v: Record<string, Value>) => void }) {
  const hasTimeline = useStore((s) => !!s.tl);
  const nodes = useStore((s) => s.nodes);
  const animate = async () => {
    try {
      await bridge.request('timeline.addTrack', { owner: 'Keyframe Studio', model: `fx.${effect}.${p.key}`, keyAt: liveTime() });
      await refreshTimeline();
      toast(`Track added and keyed at the playhead: ${p.label}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const tools = (
    <span className="fx-tools">
      {hasTimeline && p.kind !== 'bool' ? (
        <button className="btn icon" title="Animate: add a Timeline track for this value, keyed at the playhead" onClick={animate}>
          <Icon name="key" size={13} />
        </button>
      ) : (
        <span style={{ width: 24 }} />
      )}
    </span>
  );
  if (p.kind === 'choice')
    return (
      <div className="fx-row">
        <label>
          {p.label}
          {p.help && <Help text={p.help} />}
        </label>
        <div className="seg">
          {p.options!.map((o) => (
            <button key={o.v} className={Math.round(v as number) === o.v ? 'on' : ''} onClick={() => onSet({ [p.key]: o.v })}>
              {o.label}
            </button>
          ))}
        </div>
        <span />
      </div>
    );
  if (p.kind === 'chara') {
    const charas = Object.values(nodes).filter((n) => n.type === 'Char');
    // nothing picked (or that character is gone): the plugin focuses on the first character in the scene
    const cur = charas.some((c) => c.id === (v as number)) ? (v as number) : -1;
    return (
      <div className="fx-row">
        <label>{p.label}</label>
        <select className="input" value={cur} onChange={(e) => onSet({ [p.key]: Number(e.target.value) })}>
          {cur < 0 && <option value={-1}>{charas[0] ? `${displayName(charas[0])} (first)` : '—'}</option>}
          {charas.map((c) => (
            <option key={c.id} value={c.id}>
              {displayName(c)}
            </option>
          ))}
        </select>
        <span />
      </div>
    );
  }
  if (p.kind === 'bool')
    return (
      <div className="fx-row">
        <label>
          {p.label}
          {p.help && <Help text={p.help} />}
        </label>
        <span>
          <Switch on={v === true} onChange={(x) => onSet({ [p.key]: x })} />
        </span>
        {tools}
      </div>
    );
  if (p.kind === 'color') {
    const c = v as number[];
    return (
      <>
        <div className="fx-row">
          <label>
            {p.label}
            {p.help && <Help text={p.help} />}
          </label>
          <span>
            <ColorInput value={c} onChange={(x) => onSet({ [p.key]: [x[0], x[1], x[2], c[3] ?? 1] })} />
          </span>
          {tools}
        </div>
        {p.alpha && (
          <div className="fx-row">
            <label>{p.alpha}</label>
            <span className="fx-slider">
              <input type="range" min={0} max={1} step={0.01} value={c[3] ?? 1} onChange={(e) => onSet({ [p.key]: [c[0], c[1], c[2], Number(e.target.value)] })} />
              <NumberBox value={c[3] ?? 1} step={0.01} min={0} max={1} onChange={(a) => onSet({ [p.key]: [c[0], c[1], c[2], a] })} />
            </span>
            <span className="fx-tools" />
          </div>
        )}
      </>
    );
  }
  const n = v as number;
  return (
    <div className="fx-row">
      <label>
        {p.label}
        {p.help && <Help text={p.help} />}
      </label>
      <span className="fx-slider">
        <input type="range" min={p.min} max={p.max} step={p.step} value={n} onChange={(e) => onSet({ [p.key]: Number(e.target.value) })} />
        <NumberBox value={n} step={p.step ?? 0.01} onChange={(x) => onSet({ [p.key]: x })} />
      </span>
      {tools}
    </div>
  );
}

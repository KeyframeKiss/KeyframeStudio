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

export type Value = number | boolean | number[] | string;
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

export interface Param {
  key: string;
  label: string;
  kind: 'float' | 'color' | 'bool' | 'choice' | 'chara' | 'lut';
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
      { key: 'kelvin', label: 'White balance', kind: 'float', min: 2000, max: 12000, step: 50, help: 'In kelvin, like a camera: the light the picture was taken under is made neutral. Lower (3200 K, tungsten) cools the picture, higher warms it; 6500 K changes nothing' },
      { key: 'temperature', label: 'Warmth', kind: 'float', min: -1, max: 1, step: 0.01, advanced: true, help: 'A simple push: cool (blue) ← → warm (orange), on top of the white balance' },
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
      { key: 'natural', label: 'Lens falloff', kind: 'float', min: 0, max: 1, step: 0.01, help: 'A real lens’s darkening towards the edges (cos⁴): stronger with wider lenses, follows the camera’s field of view. Works with or without the shaped vignette above (set its Intensity to 0 for only this)' },
    ],
  },
  {
    id: 'bloom',
    title: 'Bloom',
    help: 'Bright areas glow: a soft threshold, then a glow built from several sizes — tight around highlights and wide across the frame.',
    xukmi: ['Bloom'],
    studio: 'bloom',
    params: [
      { key: 'intensity', label: 'Intensity', kind: 'float', min: 0, max: 3, step: 0.01 },
      { key: 'threshold', label: 'Threshold', kind: 'float', min: 0, max: 2, step: 0.01, help: 'How bright something must be to glow (1 = white)' },
      { key: 'softness', label: 'Softness', kind: 'float', min: 0, max: 1, step: 0.01, help: 'A gentle start instead of a hard cut at the threshold' },
      { key: 'spread', label: 'Spread', kind: 'float', min: 0, max: 1, step: 0.01, help: 'How far the glow reaches' },
      { key: 'wide', label: 'Wide glow', kind: 'float', min: 0, max: 1, step: 0.01, help: 'Low: tight halos around highlights. High: a wide haze across the frame' },
      { key: 'saturation', label: 'Saturation', kind: 'float', min: 0, max: 2, step: 0.01, advanced: true, help: '0 = a white glow, 1 = the colour of what glows' },
      { key: 'tint', label: 'Tint', kind: 'color', advanced: true },
    ],
  },
  {
    id: 'ao',
    title: 'Ambient occlusion',
    help: 'Soft shade where things meet: under the chin, between fingers, where feet meet the floor. Measured in metres around each point, so it looks the same at any distance and in stills.',
    xukmi: [],
    studio: 'ssao',
    params: [
      { key: 'intensity', label: 'Intensity', kind: 'float', min: 0, max: 3, step: 0.01 },
      { key: 'radius', label: 'Radius', kind: 'float', min: 0.02, max: 2, step: 0.01, help: 'How far around each point it looks, in metres: small = contact shadows, large = broad shade' },
      { key: 'color', label: 'Shade colour', kind: 'color', help: 'Black = plain darkening; a deep blue or brown can look more natural' },
      { key: 'contrast', label: 'Contrast', kind: 'float', min: 0.3, max: 3, step: 0.01, advanced: true },
      { key: 'fade', label: 'Fades by', kind: 'float', min: 0, max: 50, step: 0.5, advanced: true, help: 'Metres from the camera by which it has faded out (0 = never)' },
    ],
  },
  {
    id: 'lut',
    title: 'LUT files',
    help: 'Colour looks from LUT files: .cube (from Resolve, Photoshop or LUT packs) or PNG strips, put in UserData/StudioEX/luts. Two slots: one after the other, or mixed. Each can change everything, only the light, or only the colour.',
    xukmi: [],
    params: [
      { key: 'a', label: 'First LUT', kind: 'lut' },
      { key: 'aAmount', label: 'Strength', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'aMode', label: 'Changes', kind: 'choice', options: [{ v: 0, label: 'Everything' }, { v: 1, label: 'Light only' }, { v: 2, label: 'Colour only' }], help: 'Light only: its brightness and contrast, your colours. Colour only: its colours, your light' },
      { key: 'b', label: 'Second LUT', kind: 'lut' },
      { key: 'bAmount', label: 'Strength', kind: 'float', min: 0, max: 1, step: 0.01, help: 'After the first: how much of it. Mixed: 0 = only the first, 1 = only the second' },
      { key: 'bMode', label: 'Changes', kind: 'choice', options: [{ v: 0, label: 'Everything' }, { v: 1, label: 'Light only' }, { v: 2, label: 'Colour only' }] },
      { key: 'combine', label: 'Together', kind: 'choice', options: [{ v: 0, label: 'One after the other' }, { v: 1, label: 'Mixed' }] },
    ],
  },
  {
    id: 'distortion',
    title: 'Lens distortion',
    help: 'Barrel (wide lenses bulge out) or pincushion (long lenses pinch in). Refitted so the frame stays filled.',
    xukmi: [],
    params: [
      { key: 'amount', label: 'Amount', kind: 'float', min: -0.5, max: 0.5, step: 0.005, help: 'Above 0: barrel. Below 0: pincushion' },
      { key: 'fit', label: 'Fill the frame', kind: 'bool', help: 'Zooms just enough that no edge is left empty' },
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

/** Keyframe Studio's effects (and xukmi FX). With `only`: just those cards, tagged, for Look › Picture; 'xukmi' = its items. */
export function EffectsPage({ only }: { only?: string[] } = {}) {
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
    window.addEventListener('kf:picture-changed', h);
    window.addEventListener('focus', h);
    const off = bridge.on('fx.changed', (d) => setFx(d as FxState));
    return () => {
      window.removeEventListener('kf:history', h);
      window.removeEventListener('kf:picture-changed', h);
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
      for (const [effect, vals] of batch)
        bridge
          .request('fx.set', { effect, values: vals })
          .then(() => window.dispatchEvent(new Event('kf:picture-edited')))
          .catch((e) => toast((e as Error).message, 'error'));
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
        tag={only ? 'Keyframe Studio' : undefined}
      />
    );
  };

  if (only)
    return (
      <>
        {!fx.ready && only.some((id) => id !== 'xukmi') && <div className="fx-warn">Effects can't run: {fx.error ?? 'the shaders didn’t load'}</div>}
        {only.map((id) => (id === 'xukmi' ? (xk?.installed ? <XukmiSection key="xukmi" xk={xk} reload={load} /> : null) : card(id)))}
      </>
    );

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

function EffectCard({ def, values, onSet, onReset, doubles, tag }: { def: EffectDef; values: Record<string, Value>; onSet: (v: Record<string, Value>) => void; onReset: () => void; doubles: string[]; tag?: string }) {
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
          {tag && <small className="src-tag">{tag}</small>}
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

export function ParamRow({ effect, p, v, onSet }: { effect: string; p: Param; v: Value; onSet: (v: Record<string, Value>) => void }) {
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
  if (p.kind === 'lut') return <LutRow p={p} v={(v as string) ?? ''} onSet={onSet} />;
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

/** A LUT file from UserData/StudioEX/luts (refreshed when opened), the folder a click away. */
function LutRow({ p, v, onSet }: { p: Param; v: string; onSet: (v: Record<string, Value>) => void }) {
  const [files, setFiles] = useState<{ name: string; size: number; error: string | null }[]>([]);
  const [folder, setFolder] = useState('');
  const load = useCallback(() => {
    call<{ folder: string; files: { name: string; size: number; error: string | null }[] }>('fx.luts').then((r) => {
      if (!r) return;
      setFiles(r.files);
      setFolder(r.folder);
    });
  }, []);
  useEffect(load, [load]);
  const missing = !!v && !files.some((f) => f.name === v);
  return (
    <div className="fx-row">
      <label>
        {p.label}
        {p.help && <Help text={p.help} />}
      </label>
      <span className="fx-lut">
        <select className="input" value={v} onFocus={load} onChange={(e) => onSet({ [p.key]: e.target.value })}>
          <option value="">None</option>
          {missing && <option value={v}>{v} (not found)</option>}
          {files.map((f) => (
            <option key={f.name} value={f.name} disabled={!!f.error} title={f.error ?? `${f.size}³`}>
              {f.name.replace(/\.(cube|png)$/i, '')}
              {f.error ? ' (can’t read)' : ''}
            </option>
          ))}
        </select>
        {window.studioEx?.openFolder && folder && (
          <button className="btn icon" title={`Open the LUT folder: put .cube or PNG LUTs here\n${folder}`} onClick={() => window.studioEx?.openFolder?.(folder)}>
            <Icon name="folder" size={13} />
          </button>
        )}
      </span>
      <span />
    </div>
  );
}

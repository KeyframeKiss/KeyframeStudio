import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { call, displayName, liveTime, refreshTimeline, setNodeVisible, toast, useStore } from '../state/store';
import { Slider } from './CharacterPanel';
import { Help } from './Help';
import { Icon } from './Icon';
import { ColorInput, Switch } from './LookPanel';
import { Popover } from './Shell';
import { Section } from './Page';
import { IconTile, SwitchCard } from './EditorBits';

// Look › Lighting: projectors (light / shadow shapes on characters and the set) and lights that aim at a character.

interface ProjValues {
  shape: string;
  mode: string;
  target: string;
  color: number[];
  angle: number;
  range: number;
  soft: number;
  falloff: number;
  count: number;
  spin: number;
}
interface Proj {
  id: number;
  name: string;
  visible: boolean;
  values: ProjValues;
}
interface XukmiCatalog {
  group: number;
  category: number;
  no: number;
  name: string;
  categoryName: string;
}

const SHAPES: { id: string; label: string }[] = [
  { id: 'circle', label: 'Soft circle' },
  { id: 'ring', label: 'Ring' },
  { id: 'heart', label: 'Heart' },
  { id: 'star', label: 'Star' },
  { id: 'blinds', label: 'Blinds' },
  { id: 'window', label: 'Window' },
  { id: 'leaves', label: 'Leaf dapple' },
];
const MODES = [
  { id: 'light', label: 'Light', help: 'Adds light: a glow or a coloured spot' },
  { id: 'shadow', label: 'Shadow', help: 'Darkens / tints: blinds, window and leaf shadows' },
  { id: 'paint', label: 'Paint', help: 'Covers with the colour: graphic shapes' },
];
const TARGETS = [
  { id: 'all', label: 'Everything' },
  { id: 'chars', label: 'Characters' },
  { id: 'set', label: 'Set only' },
];
const COUNTED: Record<string, string> = { star: 'Points', blinds: 'Slats', window: 'Panes', leaves: 'Leaf size' };
const STARTERS: Record<string, Partial<ProjValues>> = {
  circle: { mode: 'light', color: [1, 0.85, 0.6, 0.8] },
  ring: { mode: 'light', color: [0.6, 0.8, 1, 0.8] },
  heart: { mode: 'light', color: [1, 0.45, 0.6, 0.85] },
  star: { mode: 'light', color: [1, 0.9, 0.5, 0.85], count: 5 },
  blinds: { mode: 'shadow', color: [0.25, 0.22, 0.3, 0.75], count: 8, angle: 45 },
  window: { mode: 'shadow', color: [0.2, 0.2, 0.3, 0.7], count: 6, angle: 45 },
  leaves: { mode: 'shadow', color: [0.15, 0.25, 0.15, 0.7], count: 6, angle: 50 },
};

export function ProjectorsPanel({ onChanged }: { onChanged?: () => void } = {}) {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  const [items, setItems] = useState<Proj[] | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [xk, setXk] = useState<XukmiCatalog[]>([]);

  const load = useCallback(() => {
    call<{ items: Proj[] }>('proj.list').then((r) => r && setItems(r.items));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load, revision]);
  useEffect(() => {
    if (status === 'open') call<{ installed: boolean; catalog: XukmiCatalog[] }>('fx.xukmi').then((r) => setXk(r?.installed ? r.catalog.filter((c) => /projector/i.test(c.categoryName) || /projector/i.test(c.name)) : []));
  }, [status]);
  useEffect(() => {
    const h = () => load();
    window.addEventListener('kf:history', h);
    return () => window.removeEventListener('kf:history', h);
  }, [load]);

  const add = async (shape: string) => {
    try {
      await bridge.request('proj.add', { values: { shape, ...STARTERS[shape] } });
      toast('Projector added. Move it with Studio’s handles');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const addXukmi = async (c: XukmiCatalog) => {
    try {
      await bridge.request('fx.addXukmi', { group: c.group, category: c.category, no: c.no });
      toast(`Added xukmi ${c.name} — its colours are in Look › Materials`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // live edits, one request per frame per projector
  const pending = useRef(new Map<number, Partial<ProjValues>>());
  const frame = useRef(0);
  const set = (id: number, v: Partial<ProjValues>) => {
    setItems((list) => list && list.map((p) => (p.id === id ? { ...p, values: { ...p.values, ...v } } : p)));
    pending.current.set(id, { ...(pending.current.get(id) ?? {}), ...v });
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const batch = [...pending.current.entries()];
      pending.current.clear();
      for (const [pid, values] of batch) bridge.request('proj.set', { id: pid, values }).catch((e) => toast((e as Error).message, 'error'));
    });
  };

  const cur = items?.find((x) => x.id === pick) ?? items?.[0] ?? null;
  return (
    <Section
      title="Projectors"
      help="Shapes of light or shadow cast onto characters and the set — window light, blinds, leaf shadows, a heart spot. Each one is a folder in the scene: move and turn it with Studio's handles, animate it like any object, delete it like any object. Saved with the scene."
      actions={
        <Popover
          align="right"
          placement="down"
          width={300}
          trigger={(open, toggle) => (
            <button className={`btn ${open ? 'on' : ''}`} onClick={toggle} disabled={status !== 'open'}>
              <Icon name="plus" size={13} /> Add projector
            </button>
          )}
        >
          {(close) => (
            <div className="layout-menu fx-add-menu">
              <div className="layout-menu-h">Keyframe Studio</div>
              <div className="pj-shape-grid">
                {SHAPES.map((s) => (
                  <button key={s.id} className="btn" onClick={() => (close(), add(s.id))}>
                    {s.label}
                  </button>
                ))}
              </div>
              {xk.length > 0 && (
                <>
                  <div className="layout-menu-h">xukmi FX</div>
                  {xk.map((c) => (
                    <button key={`${c.group}.${c.category}.${c.no}`} className="menu-item" onClick={() => (close(), addXukmi(c))}>
                      {c.name}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </Popover>
      }
    >
      {!items ? null : items.length === 0 ? (
        <div className="pn-note">No projectors in this scene — add one: window light, blinds, leaf shadows, a heart spot…</div>
      ) : (
        <>
          {/* several: one line each, the picked one's settings below (not a stack of full cards) */}
          {items.length > 1 && (
            <div className="pj-list">
              {items.map((p) => (
                <div key={p.id} className={`pj-item ${cur?.id === p.id ? 'on' : ''}`}>
                  <Switch on={p.visible} onChange={(on) => setNodeVisible(p.id, on)} />
                  <button className="pj-pick" aria-pressed={cur?.id === p.id} onClick={() => setPick(p.id)}>
                    <span>{p.name.replace(/^Projector · /, '')}</span>
                    <small>
                      {SHAPES.find((x) => x.id === p.values.shape)?.label ?? p.values.shape} · {MODES.find((x) => x.id === p.values.mode)?.label ?? p.values.mode}
                    </small>
                  </button>
                  <span className="pj-swatch" style={{ background: `rgb(${p.values.color.slice(0, 3).map((c) => Math.round(Math.min(1, c) * 255)).join(',')})` }} />
                </div>
              ))}
            </div>
          )}
        <div className="fx-cards">
          {(cur ? [cur] : []).map((p) => (
            <ProjectorCard
              key={p.id}
              p={p}
              onSet={(v) => set(p.id, v)}
              onRemove={() =>
                call<{ items: Proj[] }>('proj.remove', { id: p.id }).then((r) => {
                  if (!r) return;
                  setItems(r.items);
                  onChanged?.();
                  toast(`Removed ${p.name.replace(/^Projector · /, "")}, Ctrl+Z to undo`);
                })
              }
            />
          ))}
        </div>
        </>
      )}
    </Section>
  );
}

/** ◆ — a Timeline track for this projector value, keyed at the playhead. */
function Anim({ id, model, what }: { id: number; model: string; what?: string }) {
  const hasTimeline = useStore((s) => !!s.tl);
  if (!hasTimeline) return <span />;
  return (
    <button
      className="btn icon pj-key"
      title={`Animate ${what ?? 'this'}: add a Timeline track for this projector, keyed at the playhead`}
      onClick={async () => {
        try {
          await bridge.request('timeline.addTrack', { owner: 'Keyframe Studio', model: `proj.${model}`, oci: id, keyAt: liveTime() });
          await refreshTimeline();
          toast('Track added and keyed');
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      }}
    >
      <Icon name="key" size={13} />
    </button>
  );
}

function Chips<T extends { id: string; label: string; help?: string }>({ list, value, onPick }: { list: T[]; value: string; onPick: (id: string) => void }) {
  return (
    <div className="seg pj-seg">
      {list.map((x) => (
        <button key={x.id} className={value === x.id ? 'on' : ''} onClick={() => onPick(x.id)} title={x.help}>
          {x.label}
        </button>
      ))}
    </div>
  );
}

function ProjectorCard({ p, onSet, onRemove }: { p: Proj; onSet: (v: Partial<ProjValues>) => void; onRemove: () => void }) {
  const v = p.values;
  const [more, setMore] = useState(false);
  return (
    <div className={`look-card fx-card ${p.visible ? '' : 'off'}`}>
      <div className="look-card-head">
        <div>
          <b title={p.name}>{p.name}</b>
        </div>
        <button className="btn icon" title="Select it in Studio to move / turn it with the handles" onClick={() => call('scene.select', { ids: [p.id] })}>
          <Icon name="target" size={13} />
        </button>
        <Switch on={p.visible} onChange={(on) => setNodeVisible(p.id, on)} />
        <button className="btn small solid danger" title="Remove this projector (Ctrl+Z brings it back)" onClick={onRemove}>
          <Icon name="trash" size={12} />
          Remove
        </button>
      </div>
      <div className="look-card-body">
        <Chips list={SHAPES} value={v.shape} onPick={(shape) => onSet({ shape })} />
        <Chips list={MODES} value={v.mode} onPick={(mode) => onSet({ mode })} />
        <div className="fx-row">
          <label>Colour</label>
          <span>
            <ColorInput value={v.color} onChange={(c) => onSet({ color: [c[0], c[1], c[2], v.color[3]] })} />
          </span>
          <Anim id={p.id} model="color" what="colour and strength" />
        </div>
        <div className="ct-row">
          <label>Strength</label>
          <Slider value={v.color[3]} min={0} max={1} step={0.01} onChange={(a) => onSet({ color: [v.color[0], v.color[1], v.color[2], a] })} />
        </div>
        <div className="ct-row">
          <label>
            Size
            <Help text="The beam's angle: wider covers more" />
          </label>
          <Slider value={v.angle} min={2} max={120} step={1} onChange={(angle) => onSet({ angle })} />
            <Anim id={p.id} model="angle" />
        </div>
        <div className="ct-row">
          <label>Softness</label>
          <Slider value={v.soft} min={0} max={1} step={0.01} onChange={(soft) => onSet({ soft })} />
            <Anim id={p.id} model="soft" />
        </div>
        {COUNTED[v.shape] && (
          <div className="ct-row">
            <label>{COUNTED[v.shape]}</label>
            <Slider value={v.count} min={2} max={24} step={1} onChange={(count) => onSet({ count })} />
            <Anim id={p.id} model="count" />
          </div>
        )}
        <div className="ct-row">
          <label>Turn</label>
          <Slider value={v.spin} min={-180} max={180} step={1} onChange={(spin) => onSet({ spin })} />
            <Anim id={p.id} model="spin" />
        </div>
        <button className="fx-more" onClick={() => setMore((m) => !m)}>
          <Icon name={more ? 'chevronDown' : 'chevronRight'} size={12} /> More
        </button>
        {more && (
          <>
            <div className="ct-label">Falls on</div>
            <Chips list={TARGETS} value={v.target} onPick={(target) => onSet({ target })} />
            <div className="ct-row">
              <label>
                Reach
                <Help text="How far it shines (metres)" />
              </label>
              <Slider value={v.range} min={0.5} max={40} step={0.5} onChange={(range) => onSet({ range })} />
            <Anim id={p.id} model="range" />
            </div>
            <div className="ct-row">
              <label>
                Fades with distance
                <Help text="0 = as strong far away as close by" />
              </label>
              <Slider value={v.falloff} min={0} max={1} step={0.01} onChange={(falloff) => onSet({ falloff })} />
            <Anim id={p.id} model="falloff" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aim lights
// ---------------------------------------------------------------------------

interface AimLight {
  id: number;
  name: string;
  type: string;
  target: number;
  bone: string;
  speed: number;
  provider: string;
}
interface AimState {
  lights: AimLight[];
  bones: string[];
  lightManager: boolean;
  useLightManager: boolean;
}
const BONE_LABEL: Record<string, string> = { body: 'Body', head: 'Head', chest: 'Chest', hips: 'Hips' };

export function AimLightsPanel() {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  const nodes = useStore((s) => s.nodes);
  const charas = Object.values(nodes).filter((n) => n.type === 'Char');
  const [st, setSt] = useState<AimState | null>(null);
  const load = useCallback(() => {
    call<AimState>('aim.list').then((r) => r && setSt(r));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load, revision]);
  const set = async (args: Record<string, unknown>) => {
    if (typeof args.id === 'number')
      setSt((s) => s && { ...s, lights: s.lights.map((l) => (l.id === args.id ? ({ ...l, ...args } as AimLight) : l)) });
    try {
      setSt(await bridge.request<AimState>('aim.set', args));
    } catch (e) {
      toast((e as Error).message, 'error');
      load();
    }
  };
  if (!st) return null;
  return (
    <Section
      title="Aim lights"
      help="A spot or directional light keeps pointing at a character while they move — a key light that follows the face. Turning it off puts the light back where it was."
      actions={
        st.lightManager && (
          <SwitchCard
            on={st.useLightManager}
            label="Use LightManager"
            help="LightManager is installed: it does the aiming for spot lights, saved in its own format. Off: Keyframe Studio aims every light."
            onChange={(v) => set({ useLightManager: v })}
          />
        )
      }
    >
      {st.lights.length === 0 ? (
        <div className="pn-note">No spot or directional lights in the scene. Add one in Studio, or apply a lighting rig above.</div>
      ) : (
        <div className="aim-list">
          {st.lights.map((l) => (
            <div key={l.id} className={`aim-row ${l.target >= 0 ? 'on' : ''}`}>
              <div className="ed-head">
                <IconTile name="target" />
                <div className="ed-title">
                  <b>{l.name}</b>
                  <span className="sub">
                    {l.type === 'Spot' ? 'Spot light' : l.type === 'Directional' ? 'Directional light' : l.type}
                    {l.target >= 0 && l.provider ? ` · ${l.provider}` : ''}
                  </span>
                </div>
              </div>
              <div className="ed-fields">
                <label>
                  Aim at
                  <select className="input" value={l.target} onChange={(e) => set({ id: l.id, target: Number(e.target.value) })}>
                    <option value={-1}>Not aimed</option>
                    {charas.map((c) => (
                      <option key={c.id} value={c.id}>
                        {displayName(c)}
                      </option>
                    ))}
                  </select>
                </label>
                {l.target >= 0 && (
                  <>
                    <label>
                      Part
                      <div className="seg">
                        {st.bones.map((b) => (
                          <button key={b} className={l.bone === b ? 'on' : ''} onClick={() => set({ id: l.id, bone: b })}>
                            {BONE_LABEL[b] ?? b}
                          </button>
                        ))}
                      </div>
                    </label>
                    <label className="aim-speed">
                      <span>
                        Turn speed
                        <Help text="How quickly the light turns to follow: low is a slow, smooth follow; high snaps to the part." />
                      </span>
                      <Slider value={l.speed} min={0.5} max={20} step={0.5} onChange={(speed) => set({ id: l.id, speed })} />
                    </label>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

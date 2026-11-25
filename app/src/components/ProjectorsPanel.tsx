import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { call, displayName, liveTime, refreshTimeline, setNodeVisible, toast, useStore } from '../state/store';
import { Slider } from './CharacterPanel';
import { Help } from './Help';
import { Icon } from './Icon';
import { ColorInput, Switch } from './LookPanel';
import { SwitchCard } from './EditorBits';

// Look › Lighting parts: projectors (light / shadow shapes on characters and the set) and lights that aim at a character.

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

/** The projectors in the scene (for the Lighting list), refreshed with the scene and undo. */
export function useProjectors() {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  const [items, setItems] = useState<Proj[] | null>(null);
  const load = useCallback(() => {
    call<{ items: Proj[] }>('proj.list').then((r) => r && setItems(r.items));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load, revision]);
  useEffect(() => {
    window.addEventListener('kf:history', load);
    window.addEventListener('kf:lighting-changed', load);
    return () => {
      window.removeEventListener('kf:history', load);
      window.removeEventListener('kf:lighting-changed', load);
    };
  }, [load]);
  return { items, setItems, load };
}

export const shapeLabel = (id: string) => SHAPES.find((x) => x.id === id)?.label ?? id;
export const modeLabel = (id: string) => MODES.find((x) => x.id === id)?.label ?? id;
export type { Proj };

/** Add a projector: Keyframe Studio's shapes (and xukmi FX's projectors when installed). */
export function ProjectorAdd({ onAdded }: { onAdded: (id: number) => void }) {
  const status = useStore((s) => s.status);
  const [xk, setXk] = useState<XukmiCatalog[]>([]);
  useEffect(() => {
    if (status === 'open') call<{ installed: boolean; catalog: XukmiCatalog[] }>('fx.xukmi').then((r) => setXk(r?.installed ? r.catalog.filter((c) => /projector/i.test(c.categoryName) || /projector/i.test(c.name)) : []));
  }, [status]);
  const add = async (shape: string) => {
    try {
      const id = await bridge.request<number>('proj.add', { values: { shape, ...STARTERS[shape] } });
      toast('Projector added. Move it with Studio’s handles');
      window.dispatchEvent(new Event('kf:lighting-changed'));
      onAdded(id);
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
  return (
    <div className="look-card fx-card">
      <div className="look-card-head">
        <div>
          <b>Add a projector</b>
        </div>
      </div>
      <div className="look-card-body">
        <div className="pj-shape-grid lt-shapes">
          {SHAPES.map((s) => (
            <button key={s.id} className="btn solid" disabled={status !== 'open'} onClick={() => add(s.id)} title={MODES.find((m) => m.id === STARTERS[s.id]?.mode)?.help}>
              {s.label}
            </button>
          ))}
        </div>
        {xk.length > 0 && (
          <>
            <div className="ct-label">xukmi FX</div>
            <div className="pj-shape-grid lt-shapes">
              {xk.map((c) => (
                <button key={`${c.group}.${c.category}.${c.no}`} className="btn solid" title={c.name} onClick={() => addXukmi(c)}>
                  {c.name.replace(/^Projector\s+/i, '')}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** One projector's settings, edited live (one request per frame). */
export function ProjectorEditor({ id, onRemoved }: { id: number; onRemoved: () => void }) {
  const { items, setItems } = useProjectors();
  const pending = useRef<Partial<ProjValues> | null>(null);
  const frame = useRef(0);
  const set = (v: Partial<ProjValues>) => {
    setItems((list) => list && list.map((p) => (p.id === id ? { ...p, values: { ...p.values, ...v } } : p)));
    pending.current = { ...(pending.current ?? {}), ...v };
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const values = pending.current;
      pending.current = null;
      if (values) bridge.request('proj.set', { id, values }).catch((e) => toast((e as Error).message, 'error'));
    });
  };
  const p = items?.find((x) => x.id === id);
  if (!p) return null;
  return (
    <ProjectorCard
      p={p}
      onSet={set}
      onRemove={() =>
        call<{ items: Proj[] }>('proj.remove', { id }).then((r) => {
          if (!r) return;
          setItems(r.items);
          window.dispatchEvent(new Event('kf:lighting-changed'));
          toast(`Removed ${p.name.replace(/^Projector · /, '')}, Ctrl+Z to undo`);
          onRemoved();
        })
      }
    />
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

export function ProjectorCard({ p, onSet, onRemove }: { p: Proj; onSet: (v: Partial<ProjValues>) => void; onRemove: () => void }) {
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

/** Aim lights: the scene's aim state (which lights follow a character), for the Lighting list and editor. */
export function useAim() {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  const [st, setSt] = useState<AimState | null>(null);
  const load = useCallback(() => {
    call<AimState>('aim.list').then((r) => r && setSt(r));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load, revision]);
  const set = async (args: Record<string, unknown>) => {
    if (typeof args.id === 'number') setSt((s) => s && { ...s, lights: s.lights.map((l) => (l.id === args.id ? ({ ...l, ...args } as AimLight) : l)) });
    try {
      setSt(await bridge.request<AimState>('aim.set', args));
    } catch (e) {
      toast((e as Error).message, 'error');
      load();
    }
  };
  return { st, set };
}
export type { AimState };

/** A spot or directional light keeps pointing at a character: who, which part, how quickly it turns. */
export function AimRows({ lightId, aim }: { lightId: number; aim: ReturnType<typeof useAim> }) {
  const nodes = useStore((s) => s.nodes);
  const charas = Object.values(nodes).filter((n) => n.type === 'Char');
  const { st, set } = aim;
  const l = st?.lights.find((x) => x.id === lightId);
  if (!st || !l) return null;
  return (
    <>
      <div className="fx-row">
        <label>
          Aim at
          <Help text="The light keeps pointing at a character while they move — a key light that follows the face. Not aimed puts it back where it was." />
        </label>
        <select className="input" value={l.target} onChange={(e) => set({ id: l.id, target: Number(e.target.value) })}>
          <option value={-1}>Not aimed</option>
          {charas.map((c) => (
            <option key={c.id} value={c.id}>
              {displayName(c)}
            </option>
          ))}
        </select>
        <span />
      </div>
      {l.target >= 0 && (
        <>
          <div className="fx-row">
            <label>Part</label>
            <div className="seg">
              {st.bones.map((b) => (
                <button key={b} className={l.bone === b ? 'on' : ''} onClick={() => set({ id: l.id, bone: b })}>
                  {BONE_LABEL[b] ?? b}
                </button>
              ))}
            </div>
            <span />
          </div>
          <div className="ct-row">
            <label>
              Turn speed
              <Help text="How quickly the light turns to follow: low is a slow, smooth follow; high snaps to the part." />
            </label>
            <Slider value={l.speed} min={0.5} max={20} step={0.5} onChange={(speed) => set({ id: l.id, speed })} />
          </div>
        </>
      )}
      {st.lightManager && (
        <SwitchCard
          on={st.useLightManager}
          label="Use LightManager"
          help="LightManager is installed: it does the aiming for spot lights, saved in its own format. Off: Keyframe Studio aims every light."
          onChange={(v) => set({ useLightManager: v })}
        />
      )}
    </>
  );
}

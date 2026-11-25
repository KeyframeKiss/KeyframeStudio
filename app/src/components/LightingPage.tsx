import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { call, displayName, selectedCharacters, setNodeVisible, studioSelect, toast, useStore } from '../state/store';
import { ask } from './Dialogs';
import { ParamRow, type Param, type Value } from './EffectsPage';
import { Help } from './Help';
import { Icon } from './Icon';
import { ColorInput, LookPanel, Switch } from './LookPanel';
import { NumberBox } from './MaterialEditor';
import { Page } from './Page';
import { AimRows, ProjectorAdd, ProjectorEditor, modeLabel, shapeLabel, useAim, useProjectors } from './ProjectorsPanel';
import { RigDiagram, type DiagramLight } from './RigDiagram';

/**
 * Look › Lighting, laid out like Picture: a short list of everything that lights the scene (Studio's two lights,
 * lights on characters, the lights, rigs and projectors added, and what can be added), each with a switch and a few
 * words of what it's set to; the picked one's settings beside it. A light has one home here: colour, strength,
 * reach, shadows, whether it lights characters and what it aims at.
 */

type RGBA = [number, number, number, number];
interface Rig {
  name: string;
  note?: string;
  builtin: boolean;
  file?: string;
  lights: DiagramLight[];
}
interface SceneRig {
  folder: number;
  name: string;
  lights: number;
  enabled: boolean;
}
interface CharaLit {
  id: number;
  name: string;
  type: string;
  lightsChara: boolean;
  byUs: boolean;
}
interface StudioLights {
  charaColor: RGBA;
  charaIntensity: number;
  mapColor: RGBA;
  mapIntensity: number;
}
interface LightState {
  kind: string;
  color: RGBA;
  intensity: number;
  range: number;
  spotAngle: number;
  shadow: boolean;
  enable: boolean;
  hasRange: boolean;
  hasSpot: boolean;
}

const rgb = (c: number[] | undefined) => `rgb(${(c ?? [1, 1, 1]).slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')})`;
const n2 = (v: number | undefined) => (typeof v === 'number' ? v.toFixed(2) : '');
const lightKind = (t: string) => (t === 'Spot' ? 'Spot light' : t === 'Directional' ? 'Sun light' : t === 'Point' ? 'Point light' : 'Light');

/** The character the lighting goes around: the selected one, else the only one in the scene. */
function useTarget() {
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  return useMemo(() => {
    const sel = selectedCharacters();
    if (sel.length) return sel[0];
    const all = Object.values(nodes).filter((n) => n.type === 'Char');
    return all.length === 1 ? all[0].id : null;
  }, [selection, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
}

const pickKey = 'kf.lighting.pick';
function readPick() {
  try {
    return localStorage.getItem(pickKey) || 'studio:chara';
  } catch {
    return 'studio:chara';
  }
}

export function LightingPage() {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  const nodes = useStore((s) => s.nodes);
  const selection = useStore((s) => s.studioSelection);
  useStore((s) => s.showEnglish);

  const [pick, setPickState] = useState(readPick);
  const setPick = (p: string) => {
    setPickState(p);
    try {
      localStorage.setItem(pickKey, p);
    } catch {
      /* not remembered; fine */
    }
  };

  const [studio, setStudio] = useState<StudioLights | null>(null);
  const [cl, setCl] = useState<Record<string, Value> | null>(null);
  const [rigs, setRigs] = useState<SceneRig[]>([]);
  const [lit, setLit] = useState<CharaLit[]>([]);
  const projs = useProjectors();
  const aim = useAim();

  const load = useCallback(() => {
    call<{ lights: StudioLights }>('look.get').then((l) => l && setStudio(l.lights));
    bridge
      .request<{ effects: Record<string, Record<string, Value>> }>('fx.get')
      .then((r) => setCl(r?.effects?.charaLight ?? null))
      .catch(() => setCl(null));
    call<SceneRig[]>('light.sceneRigs').then((r) => r && setRigs(r));
    call<CharaLit[]>('light.charaList').then((r) => r && setLit(r));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, revision, nodes, load]);
  useEffect(() => {
    let t = 0;
    const later = () => {
      window.clearTimeout(t);
      t = window.setTimeout(load, 350);
    };
    const evs = ['kf:history', 'kf:picture-changed', 'kf:lighting-changed', 'studioex:look-changed', 'kf:picture-edited'];
    for (const ev of evs) window.addEventListener(ev, later);
    const off = bridge.on('fx.changed', (d) => {
      const e = (d as { effects?: Record<string, Record<string, Value>> })?.effects?.charaLight;
      if (e) setCl(e);
    });
    return () => {
      window.clearTimeout(t);
      for (const ev of evs) window.removeEventListener(ev, later);
      off();
    };
  }, [load]);
  const changed = () => window.dispatchEvent(new Event('kf:lighting-changed'));

  // what's in the scene: rigs (their lights under them), lights on their own, projectors
  const inRig = new Map<number, number>();
  for (const r of rigs) for (const c of nodes[r.folder]?.children ?? []) inRig.set(c, r.folder);
  const lights = Object.values(nodes).filter((n) => n.type === 'Light');
  const loose = lights.filter((n) => !inRig.has(n.id));
  const litBy = new Map(lit.map((l) => [l.id, l]));
  const aimOf = (id: number) => aim.st?.lights.find((l) => l.id === id);
  const mapOnly = lights.filter((n) => litBy.get(n.id)?.lightsChara === false).map((n) => n.id);
  const ours = cl?.on === true;

  // something picked in Studio or the Scene list: show it here
  const lastSel = useRef('');
  useEffect(() => {
    const key = selection.join(',');
    if (key === lastSel.current) return;
    lastSel.current = key;
    if (selection.length !== 1) return;
    const id = selection[0];
    if (nodes[id]?.type === 'Light') setPick(`light:${id}`);
    else if (rigs.some((r) => r.folder === id)) setPick(`rig:${id}`);
    else if (projs.items?.some((p) => p.id === id)) setPick(`proj:${id}`);
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  const lightSum = (id: number) => {
    const l = litBy.get(id);
    const a = aimOf(id);
    return [l ? lightKind(l.type) : 'Light', l?.lightsChara ? 'lights characters' : 'map only', a && a.target >= 0 ? `aims at ${displayName(nodes[a.target])}` : '']
      .filter(Boolean)
      .join(' · ');
  };

  // the picked entry (falls back to Studio's character light when it's gone)
  const [kind, rawId] = pick.split(':');
  const pid = Number(rawId);
  const exists =
    (kind === 'studio' && (rawId === 'chara' || rawId === 'map')) ||
    kind === 'chara' ||
    kind === 'rigs' ||
    kind === 'projectors' ||
    (kind === 'light' && nodes[pid]?.type === 'Light') ||
    (kind === 'rig' && rigs.some((r) => r.folder === pid)) ||
    (kind === 'proj' && (projs.items == null || projs.items.some((p) => p.id === pid)));
  const cur = exists ? pick : 'studio:chara';

  const row = (p: { id: string; name: string; sum: string; on: boolean; swatch?: number[]; child?: boolean; toggle?: (v: boolean) => void; title?: string }) => (
    <div key={p.id} className={`pic-item ${cur === p.id ? 'on' : ''} ${p.on ? 'active' : ''} ${p.child ? 'lt-child' : ''}`}>
      <button className="pic-item-btn" aria-pressed={cur === p.id} onClick={() => setPick(p.id)} title={p.title}>
        <span className={`pic-dot ${p.on ? 'on' : ''}`} />
        <span className="pic-item-name">{p.name}</span>
        <small className="pic-item-sum">{p.sum}</small>
      </button>
      {p.swatch && <span className="pj-swatch" style={{ background: rgb(p.swatch) }} />}
      {p.toggle && <Switch on={p.on} onChange={p.toggle} />}
    </div>
  );

  const setRigOn = (folder: number, enabled: boolean) => call<SceneRig[]>('light.setRigEnabled', { folder, enabled }).then((x) => x && setRigs(x));
  const setCharaOn = (on: boolean) =>
    call<{ effects: Record<string, Record<string, Value>> }>('fx.set', { effect: 'charaLight', values: { on } }).then((r) => r?.effects?.charaLight && setCl(r.effects.charaLight));

  // hold to see the scene without the rigs, release to bring them back
  const [comparing, setComparing] = useState(false);
  const compare = async (on: boolean) => {
    const live = rigs.filter((r) => r.enabled);
    if (on && !live.length) return;
    setComparing(on);
    for (const r of on ? live : rigs.filter((x) => x.enabled || comparing)) await call('light.setRigEnabled', { folder: r.folder, enabled: !on });
    if (!on) load();
  };

  const added = rigs.length + loose.length + (projs.items?.length ?? 0);

  return (
    <Page max={1400}>
      <div className="look-page-bar">
        <span style={{ flex: 1 }} />
        {mapOnly.length > 0 && (
          <button
            className="btn solid"
            title="Studio adds lights that light the map only. These will light the characters too (one undo step)"
            onClick={() => call<CharaLit[]>('light.lightsChara', { ids: mapOnly, on: true }).then((r) => r && setLit(r))}
          >
            Let {mapOnly.length === 1 ? 'this light' : `all ${mapOnly.length} lights`} light characters
          </button>
        )}
        {rigs.some((r) => r.enabled) && (
          <button className={`btn solid ${comparing ? 'on' : ''}`} onPointerDown={() => compare(true)} onPointerUp={() => compare(false)} onPointerLeave={() => comparing && compare(false)}>
            Hold to compare without rigs
          </button>
        )}
        <Help text="Everything here shows in Studio right away, is undoable (Ctrl+Z) and is saved with the scene. Pick an entry to edit it; selecting a light, rig or projector in Studio picks it here too." />
      </div>

      <div className="pic2">
        <nav className="pic-list" aria-label="Lighting">
          <section>
            <h3 className="pic-list-group">Studio’s lights</h3>
            {row({ id: 'studio:chara', name: 'Character light', sum: studio ? `Strength ${n2(studio.charaIntensity)}` : '', on: (studio?.charaIntensity ?? 1) > 0, swatch: studio?.charaColor })}
            {row({ id: 'studio:map', name: 'Map light', sum: studio ? `Strength ${n2(studio.mapIntensity)}` : '', on: (studio?.mapIntensity ?? 1) > 0, swatch: studio?.mapColor })}
          </section>
          {cl && (
            <section>
              <h3 className="pic-list-group">Characters</h3>
              {row({
                id: 'chara',
                name: 'Lights on characters',
                sum: ours ? `Keyframe Studio${Number(cl.base ?? 1) < 1 ? `, built-in light ${n2(Number(cl.base))}` : ''}` : 'Drawn by the shaders',
                on: ours,
                toggle: setCharaOn,
                title: 'Scene lights on characters: drawn by Keyframe Studio (any shader) or by the shaders',
              })}
            </section>
          )}
          <section>
            <h3 className="pic-list-group">In this scene</h3>
            {added === 0 && <div className="lt-empty">Nothing added yet</div>}
            {rigs.map((r) => (
              <div key={`r${r.folder}`}>
                {row({ id: `rig:${r.folder}`, name: r.name, sum: `Rig · ${r.lights} light${r.lights === 1 ? '' : 's'}`, on: r.enabled, toggle: (v) => setRigOn(r.folder, v) })}
                {(nodes[r.folder]?.children ?? [])
                  .filter((c) => nodes[c]?.type === 'Light')
                  .map((c) => (
                    row({ id: `light:${c}`, name: displayName(nodes[c]), sum: lightSum(c), on: nodes[c].visible && r.enabled, child: true, toggle: (v) => setNodeVisible(c, v) })
                  ))}
              </div>
            ))}
            {loose.map((n) => (
              row({ id: `light:${n.id}`, name: displayName(n), sum: lightSum(n.id), on: n.visible, toggle: (v) => setNodeVisible(n.id, v) })
            ))}
            {(projs.items ?? []).map((p) => (
              row({ id: `proj:${p.id}`, name: p.name.replace(/^Projector · /, ''), sum: `Projector · ${shapeLabel(p.values.shape)}, ${modeLabel(p.values.mode).toLowerCase()}`, on: p.visible, swatch: p.values.color, toggle: (v) => (setNodeVisible(p.id, v), projs.setItems((l) => l && l.map((x) => (x.id === p.id ? { ...x, visible: v } : x)))) })
            ))}
          </section>
          <section>
            <h3 className="pic-list-group">Add</h3>
            {row({ id: 'rigs', name: 'Lighting rigs', sum: 'Ready-made setups around a character', on: false })}
            {row({ id: 'projectors', name: 'Projector', sum: 'Window light, blinds, leaf shadows, shapes', on: false })}
          </section>
        </nav>

        <section className="pic-editor" aria-label="Settings">
          {cur === 'studio:chara' && (
            <Editor title="Character light" help="Studio's built-in light for characters. It follows the camera; turn it with Pitch and Yaw.">
              <LookPanel key="sc" cards={['charaLight']} />
            </Editor>
          )}
          {cur === 'studio:map' && (
            <Editor title="Map light" help="Studio's built-in light for the stage and items.">
              <LookPanel key="sm" cards={['mapLight']} />
            </Editor>
          )}
          {cur === 'chara' && cl && (
            <Editor
              title="Lights on characters"
              help="Studio's character shaders show only its character light: lights added to the scene never reach them. Keyframe Studio draws those lights onto characters itself — any shader, soft or with a toon edge — or the shaders do, if they take extra lights (Az Standard)."
            >
              <CharaLightsCard v={cl} onSet={(values) => call<{ effects: Record<string, Record<string, Value>> }>('fx.set', { effect: 'charaLight', values }).then((r) => r?.effects?.charaLight && setCl(r.effects.charaLight))} />
            </Editor>
          )}
          {kind === 'light' && cur === pick && (
            <Editor title={displayName(nodes[pid])} help={lightSum(pid)}>
              <LightEditor
                key={pid}
                id={pid}
                lit={litBy.get(pid)}
                aim={aim}
                inRig={inRig.get(pid)}
                onLit={(r) => setLit(r)}
                onGoRig={(f) => setPick(`rig:${f}`)}
                onRemoved={() => (setPick('studio:chara'), changed())}
              />
            </Editor>
          )}
          {kind === 'rig' && cur === pick && (
            <Editor title={rigs.find((r) => r.folder === pid)?.name ?? 'Rig'} help="A rig is a folder of lights placed around a character. Switch it off to compare; each light in it has its own settings.">
              <RigCard rig={rigs.find((r) => r.folder === pid)!} onSet={setRigOn} onPick={(id) => setPick(`light:${id}`)} onRemoved={(x) => (setRigs(x), setPick('rigs'), changed())} />
            </Editor>
          )}
          {kind === 'proj' && cur === pick && (
            <Editor title="Projector" help="A shape of light or shadow cast onto characters and the set. It's a folder in the scene: move and turn it with Studio's handles, animate it like any object.">
              <ProjectorEditor key={pid} id={pid} onRemoved={() => setPick('projectors')} />
            </Editor>
          )}
          {cur === 'rigs' && (
            <Editor title="Lighting rigs" help="Ready-made light setups placed around the character in one click. The picture shows each light from above and from the side, in its colour; spot lights show their beam.">
              <RigGallery onApplied={(folder) => (changed(), folder != null && setPick(`rig:${folder}`))} />
            </Editor>
          )}
          {cur === 'projectors' && (
            <Editor title="Projectors" help="Shapes of light or shadow cast onto characters and the set — window light, blinds, leaf shadows, a heart spot. Saved with the scene.">
              <ProjectorAdd onAdded={(id) => (projs.load(), setPick(`proj:${id}`))} />
            </Editor>
          )}
        </section>
      </div>
    </Page>
  );
}

function Editor({ title, help, children }: { title: string; help: string; children: React.ReactNode }) {
  return (
    <>
      <header className="pic-editor-head">
        <h2>{title}</h2>
        <p>{help}</p>
      </header>
      <div className="pic-editor-cards">{children}</div>
    </>
  );
}

// ---------------------------------------------------------------------------- one light

/** Number row like the effects': a slider and a number to drag or type. */
function NumRow({ label, help, value, min, max, step, onChange }: { label: string; help?: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div className="fx-row">
      <label>
        {label}
        {help && <Help text={help} />}
      </label>
      <span className="fx-slider">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <NumberBox value={value} step={step} min={min} onChange={onChange} />
      </span>
      <span className="fx-tools" />
    </div>
  );
}

function LightEditor(props: {
  id: number;
  lit?: CharaLit;
  aim: ReturnType<typeof useAim>;
  inRig?: number;
  onLit: (r: CharaLit[]) => void;
  onGoRig: (folder: number) => void;
  onRemoved: () => void;
}) {
  const { id } = props;
  const revision = useStore((s) => s.revision);
  const node = useStore((s) => s.nodes[id]);
  const [st, setSt] = useState<LightState | null>(null);
  const lastEdit = useRef(-1e9);
  useEffect(() => {
    bridge
      .request<{ light?: LightState }>('object.get', { id })
      .then((r) => performance.now() - lastEdit.current > 800 && setSt(r.light ?? null))
      .catch(() => setSt(null));
  }, [id, revision]);

  // drags: shown at once, sent at most once a frame
  const pending = useRef<Partial<LightState> | null>(null);
  const raf = useRef(0);
  const send = (patch: Partial<LightState>) => {
    lastEdit.current = performance.now();
    setSt((s) => (s ? { ...s, ...patch } : s));
    pending.current = { ...(pending.current ?? {}), ...patch };
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const p = pending.current;
      pending.current = null;
      if (p) bridge.request('object.set', { ids: [id], light: p }).catch((e) => toast((e as Error).message, 'error'));
    });
  };
  const remove = async () => {
    const name = displayName(node);
    if (!(await ask(`Remove “${name}” from the scene? This can't be undone, like deleting in Studio.`))) return;
    if (await call('light.remove', { id })) {
      toast(`Removed ${name}`);
      props.onRemoved();
    }
  };
  const aimed = props.aim.st?.lights.some((l) => l.id === id);
  if (!node) return null;
  return (
    <div className={`look-card fx-card ${node.visible ? '' : 'off'}`}>
      <div className="look-card-head">
        <div>
          <b>{displayName(node)}</b>
          <small>{st ? lightKind(st.kind) : ''}</small>
        </div>
        <button className="btn icon" title="Select it in Studio to move or turn it with the handles" onClick={() => studioSelect([id])}>
          <Icon name="target" size={13} />
        </button>
        <Switch on={node.visible} onChange={(v) => setNodeVisible(id, v)} />
        <button className="btn small solid danger" onClick={remove}>
          <Icon name="trash" size={12} />
          Remove
        </button>
      </div>
      <div className="look-card-body">
        {st && (
          <>
            <div className="fx-row">
              <label>Colour</label>
              <span>
                <ColorInput value={st.color} onChange={(c) => send({ color: c })} />
              </span>
              <span className="fx-tools" />
            </div>
            <NumRow label="Strength" value={st.intensity} min={0} max={2} step={0.01} onChange={(intensity) => send({ intensity })} />
            {st.hasRange && <NumRow label="Reach" help="How far it shines, in metres" value={st.range} min={0.1} max={50} step={0.1} onChange={(range) => send({ range })} />}
            {st.hasSpot && <NumRow label="Cone" help="The beam's width in degrees" value={st.spotAngle} min={1} max={179} step={1} onChange={(spotAngle) => send({ spotAngle })} />}
            <div className="fx-row">
              <label>
                Shadows
                <Help text="It casts shadows (on the set; characters drawn by Keyframe Studio's character lights don't take shadows from it)" />
              </label>
              <span>
                <Switch on={st.shadow} onChange={(shadow) => send({ shadow })} />
              </span>
              <span className="fx-tools" />
            </div>
          </>
        )}
        {props.lit && (
          <div className="fx-row">
            <label>
              Lights characters
              <Help text="Studio makes the lights you add light the map, never a character. On: it lights characters too, like any 3D program — drawn as set under Lights on characters." />
            </label>
            <span>
              <Switch on={props.lit.lightsChara} onChange={(on) => call<CharaLit[]>('light.lightsChara', { ids: [id], on }).then((r) => r && props.onLit(r))} />
            </span>
            <span className="fx-tools" />
          </div>
        )}
        {aimed && (
          <>
            <div className="ct-label">Aim</div>
            <AimRows lightId={id} aim={props.aim} />
          </>
        )}
        {props.inRig != null && (
          <div className="ct-foot">
            <button className="btn small solid" onClick={() => props.onGoRig(props.inRig!)}>
              Part of a rig: open the rig
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- lights on characters

const CL_PARAMS: Param[] = [
  {
    key: 'base',
    label: 'Built-in light',
    kind: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    help: "Anime shaders always draw characters fully lit, whatever the lights do. 1 keeps that look; lower it and the characters get darker until, at 0, only lights light them — Studio's character light and the scene's lights, like in any 3D program. A little (0.1–0.2) works as soft ambient light.",
  },
  { key: 'strength', label: 'Strength', kind: 'float', min: 0, max: 3, step: 0.01, help: 'How strongly scene lights show on characters' },
  { key: 'toon', label: 'Toon edge', kind: 'bool', help: 'A clean edge between lit and unlit, like anime shading. Off: soft, like a regular light' },
  { key: 'softness', label: 'Edge softness', kind: 'float', min: 0.005, max: 0.5, step: 0.005, help: 'How soft the toon edge is' },
];

function CharaLightsCard({ v, onSet }: { v: Record<string, Value>; onSet: (values: Record<string, Value>) => void }) {
  const target = useTarget();
  const nodes = useStore((s) => s.nodes);
  const ours = v.on === true;
  const swap = async (to: 'az' | 'original') => {
    if (target == null) return;
    const r = await call<{ changed: number; kept: number }>('me.shaderSwap', { id: target, to });
    if (r) toast(to === 'az' ? `${r.changed} material${r.changed === 1 ? '' : 's'} on Az Standard${r.kept ? `, ${r.kept} kept as they were` : ''} (Ctrl+Z to undo)` : `${r.changed} material${r.changed === 1 ? '' : 's'} back to the original shader`, 'done');
  };
  return (
    <>
      <div className="look-card fx-card">
        <div className="look-card-head">
          <div>
            <b>Scene lights on characters</b>
            <small>{ours ? 'Any shader, soft or with a toon edge' : 'Only shaders that take extra lights show them'}</small>
          </div>
        </div>
        <div className="look-card-body">
          <div className="fx-row">
            <label>Drawn by</label>
            <span>
              <span className="seg">
                <button className={ours ? 'on' : ''} onClick={() => onSet({ on: true })} title="Keyframe Studio draws scene lights onto characters: works with every shader, keeps the anime look">
                  Keyframe Studio
                </button>
                <button className={!ours ? 'on' : ''} onClick={() => onSet({ on: false })} title="Scene lights reach characters the usual way: only shaders made for extra lights (Az Standard) show them">
                  The shaders
                </button>
              </span>
            </span>
            <span className="fx-tools" />
          </div>
          {ours &&
            CL_PARAMS.filter((p) => p.key !== 'softness' || v.toon === true).map((p) => <ParamRow key={p.key} effect="charaLight" p={p} v={v[p.key] ?? 0} onSet={onSet} />)}
        </div>
      </div>
      {target != null && (
        <div className="look-card fx-card">
          <div className="look-card-head">
            <div>
              <b>{displayName(nodes[target])}’s shaders</b>
              <small>Az Standard takes scene lights like any 3D program</small>
            </div>
            <Help text="Az Standard shaders (Acezen) take scene lights the way any 3D program does — a more realistic look than the anime shaders. Switches each material to its Az match (skin, hair, eyes, clothes, accessories) through MaterialEditor, saved with the scene; nose, mouth, glasses and outlines stay. One undo step; Back to original puts the original shaders back." />
            <button className="btn small solid" onClick={() => swap('az')}>
              Use Az Standard
            </button>
            <button className="btn small solid" onClick={() => swap('original')}>
              Back to original
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------- rigs

function RigCard({ rig, onSet, onPick, onRemoved }: { rig: SceneRig; onSet: (folder: number, on: boolean) => void; onPick: (id: number) => void; onRemoved: (rigs: SceneRig[]) => void }) {
  const nodes = useStore((s) => s.nodes);
  if (!rig) return null;
  const kids = (nodes[rig.folder]?.children ?? []).filter((c) => nodes[c]?.type === 'Light');
  const remove = async () => {
    if (!(await ask(`Remove the “${rig.name}” rig and its ${rig.lights} light${rig.lights === 1 ? '' : 's'} from the scene? This can't be undone, like deleting in Studio.`))) return;
    const x = await call<SceneRig[]>('light.removeRig', { folder: rig.folder });
    if (x) (onRemoved(x), toast(`Removed the ${rig.name} rig`));
  };
  return (
    <div className={`look-card fx-card ${rig.enabled ? '' : 'off'}`}>
      <div className="look-card-head">
        <div>
          <b>{rig.name}</b>
          <small>
            Rig, {rig.lights} light{rig.lights === 1 ? '' : 's'}
          </small>
        </div>
        <button className="btn icon" title="Select its folder in Studio" onClick={() => studioSelect([rig.folder])}>
          <Icon name="target" size={13} />
        </button>
        <Switch on={rig.enabled} onChange={(v) => onSet(rig.folder, v)} />
        <button className="btn small solid danger" onClick={remove}>
          <Icon name="trash" size={12} />
          Remove
        </button>
      </div>
      <div className="look-card-body">
        <div className="ct-label">Its lights</div>
        <div className="lt-kids">
          {kids.map((c) => (
            <button key={c} className="btn small solid" onClick={() => onPick(c)}>
              {displayName(nodes[c])}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

let charaOnlyPref = true;

/** Ready-made rigs (each with a diagram) and saved ones, applied around the target character. */
function RigGallery({ onApplied }: { onApplied: (folder: number | null) => void }) {
  const status = useStore((s) => s.status);
  const nodes = useStore((s) => s.nodes);
  const target = useTarget();
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [saveName, setSaveName] = useState('');
  const [charaOnly, setCharaOnly] = useState(charaOnlyPref);
  useEffect(() => {
    if (status === 'open') call<Rig[]>('light.rigs').then((r) => r && setRigs(r));
  }, [status]);
  const apply = async (rig: Rig) => {
    if (target == null) return toast('Select the character to light');
    const r = await call<{ folder: number; lights: number }>('light.applyRig', { id: target, rig: rig.name, charaOnly });
    if (r) toast(`${rig.name} placed around ${displayName(nodes[target])}, Ctrl+Z to undo`);
    onApplied(r?.folder ?? null);
  };
  return (
    <>
      <div className="look-card fx-card">
        <div className="look-card-head">
          <div>
            <b>{target != null ? `Around ${displayName(nodes[target])}` : 'Select a character to light'}</b>
            <small>Fitted to their height and the way they face</small>
          </div>
          <Help text="Rigs are placed around this character. With several characters, select the one to light in the Scene list or in Studio." />
        </div>
        <div className="look-card-body">
          <div className="fx-row">
            <label>
              Light characters only
              <Help text="Rig lights affect characters only, so the set keeps its own lighting. Off: they light the set too." />
            </label>
            <span>
              <Switch
                on={charaOnly}
                onChange={(v) => {
                  charaOnlyPref = v;
                  setCharaOnly(v);
                }}
              />
            </span>
            <span className="fx-tools" />
          </div>
        </div>
      </div>
      <div className="rig-grid">
        {rigs.map((r) => (
          <div key={r.file ?? r.name} className="rig-card">
            <RigDiagram lights={r.lights} id={r.file ?? r.name} />
            <div className="rig-card-body">
              <div className="rig-card-title">
                <b>{r.name}</b>
                {r.note && <Help text={r.note} />}
                <span className="spacer" />
                {!r.builtin && (
                  <button
                    className="btn icon danger"
                    title="Delete this saved rig"
                    onClick={async () => (await ask(`Delete the saved rig “${r.name}”?`)) && call<Rig[]>('light.deleteRig', { file: r.file }).then((x) => x && setRigs(x))}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                )}
                <button className="btn small solid" disabled={target == null} onClick={() => apply(r)}>
                  Apply
                </button>
              </div>
              <div className="rig-legend">
                {r.lights.map((l, i) => (
                  <span key={i}>
                    <i style={{ background: rgb(l.color) }} />
                    {l.role}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
        <div className="rig-card rig-card-new">
          <div className="rig-card-body">
            <div className="rig-card-title">
              <b>Save as a rig</b>
              <Help text="Arrange lights in Studio around the character, then save: the rig remembers where they are relative to the character, so it fits any character later." />
            </div>
            <div className="ed-pair">
              <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder="Rig name…" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
              <button
                className="btn small solid"
                disabled={!saveName.trim() || target == null}
                onClick={async () => {
                  const r = await call<Rig[]>('light.saveRig', { name: saveName.trim(), id: target });
                  if (r) {
                    setRigs(r);
                    setSaveName('');
                    toast('Rig saved');
                  }
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

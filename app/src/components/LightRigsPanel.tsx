import { useCallback, useEffect, useMemo, useState } from 'react';
import { Section } from './Page';
import { ask } from './Dialogs';
import { Help } from './Help';
import { Icon } from './Icon';
import { IconTile, SwitchCard } from './EditorBits';
import { RigDiagram, type DiagramLight } from './RigDiagram';
import { call, displayName, selectedCharacters, setNodeVisible, toast, useStore } from '../state/store';
import { AimLightsPanel, ProjectorsPanel } from './ProjectorsPanel';
import { ParamRow, type Param, type Value } from './EffectsPage';
import { bridge } from '../bridge/client';

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
interface SceneProj {
  id: number;
  name: string;
  visible: boolean;
}

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

let charaOnlyPref = true;

/**
 * Look › Lighting, top of the page: who the lighting goes around, and everything added so far (rigs, projectors,
 * single lights), each with on / off, select, and Remove.
 */
export function LightingScene({ refreshKey }: { refreshKey: number }) {
  const status = useStore((s) => s.status);
  const nodes = useStore((s) => s.nodes);
  useStore((s) => s.showEnglish);
  const target = useTarget();
  const [rigs, setRigs] = useState<SceneRig[]>([]);
  const [projs, setProjs] = useState<SceneProj[]>([]);
  const [comparing, setComparing] = useState(false);
  // which lights reach characters (Studio's Add › Light ones light only the map unless switched)
  const [charaLit, setCharaLit] = useState<Record<number, boolean>>({});
  const takeChara = (l: { id: number; lightsChara: boolean }[] | undefined) => l && setCharaLit(Object.fromEntries(l.map((x) => [x.id, x.lightsChara])));

  const load = useCallback(() => {
    call<SceneRig[]>('light.sceneRigs').then((r) => r && setRigs(r));
    call<{ items: SceneProj[] }>('proj.list').then((r) => r && setProjs(r.items));
    call<{ id: number; lightsChara: boolean }[]>('light.charaList').then(takeChara);
  }, []);
  const setLitChara = (ids: number[], on: boolean) => call<{ id: number; lightsChara: boolean }[]>('light.lightsChara', { ids, on }).then(takeChara);
  const mapOnly = Object.values(nodes).filter((n) => n.type === 'Light' && charaLit[n.id] === false).map((n) => n.id);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load, nodes, refreshKey]);

  // lights that aren't part of a rig
  const inRigs = new Set(rigs.flatMap((r) => nodes[r.folder]?.children ?? []));
  const loose = Object.values(nodes).filter((n) => n.type === 'Light' && !inRigs.has(n.id));
  const count = rigs.length + projs.length + loose.length;

  const removeRig = async (r: SceneRig) => {
    if (!(await ask(`Remove the “${r.name}” rig and its ${r.lights} light${r.lights === 1 ? '' : 's'} from the scene? This can't be undone, like deleting in Studio.`))) return;
    const x = await call<SceneRig[]>('light.removeRig', { folder: r.folder });
    if (x) (setRigs(x), toast(`Removed the ${r.name} rig`));
  };
  const removeLight = async (id: number) => {
    const name = displayName(nodes[id]);
    if (!(await ask(`Remove “${name}” from the scene? This can't be undone, like deleting in Studio.`))) return;
    if (await call('light.remove', { id })) toast(`Removed ${name}`);
  };
  const removeProj = async (p: SceneProj) => {
    const r = await call<{ items: SceneProj[] }>('proj.remove', { id: p.id });
    if (r) (setProjs(r.items), toast(`Removed ${p.name.replace(/^Projector · /, "")}, Ctrl+Z to undo`));
  };

  // hold to see the scene without the rigs, release to bring them back
  const compare = async (on: boolean) => {
    const live = rigs.filter((r) => r.enabled);
    if (on && !live.length) return;
    setComparing(on);
    for (const r of on ? live : rigs.filter((x) => x.enabled || comparing)) await call('light.setRigEnabled', { folder: r.folder, enabled: !on });
    if (!on) load();
  };

  return (
    <>
      <header className="ed-head ed-scope">
        <IconTile name="bolt" />
        <div className="ed-title">
          <b>
            {target != null ? `Around ${displayName(nodes[target])}` : 'Select a character to light'}
            <Help text="Rigs are placed around this character, fitted to their height and the way they face. With several characters, select the one to light in the Scene list or in Studio." />
          </b>
        </div>
        <div className="ed-pair">
          <CharaOnlySwitch />
        </div>
      </header>

      <Section title="In this scene" help="Everything lighting-related in the scene: rigs you applied, projectors, and single lights. Switch them off to compare, select one to move it with Studio's handles, or remove it.">
        {count === 0 ? (
          <div className="pn-note">No rigs, projectors or lights added yet.</div>
        ) : (
          <div className="ls-list">
            {rigs.map((r) => (
              <div key={`r${r.folder}`} className={`ls-row ${r.enabled ? '' : 'off'}`}>
                <IconTile name="bolt" />
                <div className="ed-title">
                  <b>{r.name}</b>
                  <span className="sub">
                    Rig, {r.lights} light{r.lights === 1 ? '' : 's'}
                  </span>
                </div>
                <span className="spacer" />
                <button className="btn icon" title="Select its folder in Studio" onClick={() => call('scene.select', { ids: [r.folder] })}>
                  <Icon name="target" size={13} />
                </button>
                <button className={`switch ${r.enabled ? 'on' : ''}`} aria-pressed={r.enabled} title={r.enabled ? 'On' : 'Off'} onClick={() => call<SceneRig[]>('light.setRigEnabled', { folder: r.folder, enabled: !r.enabled }).then((x) => x && setRigs(x))}>
                  <span />
                </button>
                <button className="btn small solid danger" onClick={() => removeRig(r)}>
                  <Icon name="trash" size={12} />
                  Remove
                </button>
              </div>
            ))}
            {projs.map((p) => (
              <div key={`p${p.id}`} className={`ls-row proj ${p.visible ? '' : 'off'}`}>
                <IconTile name="sparkle" />
                <div className="ed-title">
                  <b>{p.name.replace(/^Projector · /, '')}</b>
                  <span className="sub">Projector</span>
                </div>
                <span className="spacer" />
                <button className="btn icon" title="Select it in Studio to move or turn it with the handles" onClick={() => call('scene.select', { ids: [p.id] })}>
                  <Icon name="target" size={13} />
                </button>
                <button className={`switch ${p.visible ? 'on' : ''}`} aria-pressed={p.visible} title={p.visible ? 'On' : 'Off'} onClick={() => (setNodeVisible(p.id, !p.visible), setProjs((l) => l.map((x) => (x.id === p.id ? { ...x, visible: !p.visible } : x))))}>
                  <span />
                </button>
                <button className="btn small solid danger" onClick={() => removeProj(p)}>
                  <Icon name="trash" size={12} />
                  Remove
                </button>
              </div>
            ))}
            {loose.map((n) => (
              <div key={`l${n.id}`} className={`ls-row light ${n.visible ? '' : 'off'}`}>
                <IconTile name="bolt" />
                <div className="ed-title">
                  <b>{displayName(n)}</b>
                  <span className="sub">Light</span>
                </div>
                <span className="spacer" />
                {n.id in charaLit && (
                  <button
                    className={`btn chip ${charaLit[n.id] ? 'on' : ''}`}
                    aria-pressed={charaLit[n.id]}
                    title={charaLit[n.id] ? 'It lights the characters too. Click: the map only' : 'It lights the map only (how Studio adds lights). Click: light the characters too'}
                    onClick={() => setLitChara([n.id], !charaLit[n.id])}
                  >
                    Characters
                  </button>
                )}
                <button className="btn icon" title="Select it in Studio to move or turn it with the handles" onClick={() => call('scene.select', { ids: [n.id] })}>
                  <Icon name="target" size={13} />
                </button>
                <button className={`switch ${n.visible ? 'on' : ''}`} aria-pressed={n.visible} title={n.visible ? 'On' : 'Off'} onClick={() => setNodeVisible(n.id, !n.visible)}>
                  <span />
                </button>
                <button className="btn small solid danger" onClick={() => removeLight(n.id)}>
                  <Icon name="trash" size={12} />
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        {mapOnly.length > 0 && (
          <div className="tool-actions" style={{ marginTop: 10 }}>
            <button className="btn solid" title="Studio adds lights that light the map only. These will light the characters too (one undo step)" onClick={() => setLitChara(mapOnly, true)}>
              Let {mapOnly.length === 1 ? 'this light' : `all ${mapOnly.length} lights`} light the characters
            </button>
            <Help text="Studio makes the lights you add light the map, never a character: only its built-in character light reaches them. Switch a light's Characters on to light them too, like any 3D program. New lights from Studio's Add › Light do this already (Mod settings › Keyframe Studio Bridge › Lights). Characters show it best with shaders made for extra lights (xukmi Vanilla Plus)." />
          </div>
        )}
        {rigs.some((r) => r.enabled) && (
          <div className="tool-actions" style={{ marginTop: 10 }}>
            <button className={`btn solid ${comparing ? 'on' : ''}`} onPointerDown={() => compare(true)} onPointerUp={() => compare(false)} onPointerLeave={() => comparing && compare(false)}>
              Hold to compare without rigs
            </button>
          </div>
        )}
      </Section>
    </>
  );
}

const CL_PARAMS: Param[] = [
  { key: 'strength', label: 'Strength', kind: 'float', min: 0, max: 3, step: 0.01, help: 'How strongly lights show on characters' },
  { key: 'toon', label: 'Toon edge', kind: 'bool', help: 'A clean edge between lit and unlit, like anime shading. Off: soft, like a regular light' },
  { key: 'softness', label: 'Edge softness', kind: 'float', min: 0.005, max: 0.5, step: 0.005, help: 'How soft the toon edge is' },
  {
    key: 'base',
    label: 'Built-in light',
    kind: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    help: "Anime shaders always draw characters fully lit, whatever the lights do. 1 keeps that look; lower it and the characters get darker until, at 0, only lights light them — Studio's character light and the scene's lights, like in any 3D program. A little (0.1–0.2) works as soft ambient light.",
  },
];

/**
 * Lights on characters. Studio's character shaders draw only its built-in character light, so a light added to the
 * scene never shows on them. Keyframe Studio draws those lights onto characters itself (any shader, soft or with a
 * toon edge, keyable); or, for characters on shaders that take extra lights (Az Standard), the shaders do it.
 */
export function CharacterLights() {
  const status = useStore((s) => s.status);
  const target = useTarget();
  const nodes = useStore((s) => s.nodes);
  const [v, setV] = useState<Record<string, Value> | null>(null);
  const load = useCallback(() => {
    call<{ effects: Record<string, Record<string, Value>> }>('fx.get').then((r) => r?.effects?.charaLight && setV(r.effects.charaLight));
  }, []);
  useEffect(() => {
    if (status !== 'open') return;
    load();
    const on = () => load();
    window.addEventListener('kf:picture-changed', on);
    window.addEventListener('kf:history', on);
    const off = bridge.on('fx.changed', (d) => {
      const e = (d as { effects?: Record<string, Record<string, Value>> })?.effects?.charaLight;
      if (e) setV(e);
    });
    return () => {
      window.removeEventListener('kf:picture-changed', on);
      window.removeEventListener('kf:history', on);
      off();
    };
  }, [status, load]);
  const set = (values: Record<string, Value>) =>
    call<{ effects: Record<string, Record<string, Value>> }>('fx.set', { effect: 'charaLight', values }).then((r) => r?.effects?.charaLight && setV(r.effects.charaLight));
  const swap = async (to: 'az' | 'original') => {
    if (target == null) return;
    const r = await call<{ changed: number; kept: number }>('me.shaderSwap', { id: target, to });
    if (r) toast(to === 'az' ? `${r.changed} material${r.changed === 1 ? '' : 's'} on Az Standard${r.kept ? `, ${r.kept} kept as they were` : ''} (Ctrl+Z to undo)` : `${r.changed} material${r.changed === 1 ? '' : 's'} back to the original shader`, 'done');
  };
  if (!v) return null;
  const ours = v.on === true;
  return (
    <Section
      title="Lights on characters"
      help="Studio's character shaders show only its built-in character light: lights added to the scene never reach them. Keyframe Studio can draw those lights onto characters itself — any shader, soft or with a toon edge, in videos and stills. Or put a character on Az Standard shaders, which take scene lights the usual way. Lights reach characters when their Characters switch (In this scene) is on."
    >
      <div className="cleanup-row">
        <span>Drawn by</span>
        <div>
          <div className="seg">
          <button className={ours ? 'on' : ''} onClick={() => set({ on: true })} title="Keyframe Studio draws scene lights onto characters: works with every shader, keeps the anime look">
            Keyframe Studio
          </button>
          <button className={!ours ? 'on' : ''} onClick={() => set({ on: false })} title="Scene lights reach characters the usual way: only shaders made for extra lights (Az Standard) show them">
            The shaders
          </button>
          </div>
        </div>
      </div>
      {ours && CL_PARAMS.filter((p) => p.key !== 'softness' || v.toon === true).map((p) => <ParamRow key={p.key} effect="charaLight" p={p} v={v[p.key] ?? 0} onSet={set} />)}
      {target != null && (
        <div className="cleanup-row">
          <span>
            {displayName(nodes[target])}’s shaders{' '}
            <Help text="Az Standard shaders (Acezen) take scene lights the way any 3D program does — a more realistic look than the anime shaders. Switches each material to its Az match (skin, hair, eyes, clothes, accessories) through MaterialEditor, saved with the scene; nose, mouth, glasses and outlines stay. One undo step; Back puts the original shaders back." />
          </span>
          <span className="tool-actions">
            <button className="btn small solid" onClick={() => swap('az')}>
              Use Az Standard
            </button>
            <button className="btn small solid" onClick={() => swap('original')}>
              Back to original
            </button>
          </span>
        </div>
      )}
    </Section>
  );
}

function CharaOnlySwitch() {
  const [on, setOn] = useState(charaOnlyPref);
  return (
    <SwitchCard
      on={on}
      label="Light characters only"
      help="Rig lights affect characters only, so the set keeps its own lighting. Off: they light the set too."
      onChange={(v) => {
        charaOnlyPref = v;
        setOn(v);
      }}
    />
  );
}

/** Lighting rigs: ready-made setups, each with a diagram; saved rigs of your own. */
export function LightRigsPanel({ onChanged }: { onChanged: () => void }) {
  const status = useStore((s) => s.status);
  const nodes = useStore((s) => s.nodes);
  useStore((s) => s.showEnglish);
  const target = useTarget();
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [saveName, setSaveName] = useState('');

  useEffect(() => {
    if (status === 'open') call<Rig[]>('light.rigs').then((r) => r && setRigs(r));
  }, [status]);

  const apply = async (rig: Rig) => {
    if (target == null) return toast('Select the character to light');
    const r = await call<{ lights: number }>('light.applyRig', { id: target, rig: rig.name, charaOnly: charaOnlyPref });
    if (r) toast(`${rig.name} placed around ${displayName(nodes[target])}, Ctrl+Z to undo`);
    onChanged();
  };

  return (
    <Section title="Lighting rigs" help="Ready-made light setups placed around the character in one click. The picture shows each light from above and from the side, in its colour; spot lights show their beam.">
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
                    <i style={{ background: `rgb(${(l.color ?? [1, 1, 1]).slice(0, 3).map((v) => Math.round(v * 255)).join(',')})` }} />
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
    </Section>
  );
}

/** Look › Lighting: who it goes around and what's in the scene, then rigs, projectors and aimed lights. */
export function LightingPage() {
  const [key, setKey] = useState(0);
  const changed = () => setKey((k) => k + 1);
  return (
    <>
      <LightingScene refreshKey={key} />
      <CharacterLights />
      <LightRigsPanel onChanged={changed} />
      <ProjectorsPanel onChanged={changed} />
      <AimLightsPanel />
    </>
  );
}

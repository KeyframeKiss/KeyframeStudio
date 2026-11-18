import { useCallback, useEffect, useMemo, useState } from 'react';
import { Help } from './Help';
import { ask } from './Dialogs';
import { call, displayName, selectedCharacters, toast, useStore } from '../state/store';

interface RigLight {
  role: string;
  type: string;
}
interface Rig {
  name: string;
  note?: string;
  builtin: boolean;
  file?: string;
  lights: RigLight[];
}
interface SceneRig {
  folder: number;
  name: string;
  lights: number;
  enabled: boolean;
}

/** Lighting rigs: lights placed around the selected character in one click; switch off to compare, remove, save. */
export function LightRigsPanel() {
  const status = useStore((s) => s.status);
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  useStore((s) => s.showEnglish);
  const chars = useMemo(() => selectedCharacters(), [selection, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [inScene, setInScene] = useState<SceneRig[]>([]);
  const [charaOnly, setCharaOnly] = useState(true);
  const [saveName, setSaveName] = useState('');
  const [comparing, setComparing] = useState(false);

  const load = useCallback(() => {
    call<Rig[]>('light.rigs').then((r) => r && setRigs(r));
    call<SceneRig[]>('light.sceneRigs').then((r) => r && setInScene(r));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load, nodes]);

  const apply = async (rig: Rig) => {
    if (!chars.length) return toast('Select the character to light');
    const r = await call<{ lights: number }>('light.applyRig', { id: chars[0], rig: rig.name, charaOnly });
    if (r) toast(`${rig.name} rig placed around ${displayName(nodes[chars[0]])} (${r.lights} light${r.lights > 1 ? 's' : ''}) — Ctrl+Z to undo`);
    load();
  };

  // hold to see the scene without any rig, release to bring them back
  const compare = async (on: boolean) => {
    const live = inScene.filter((r) => r.enabled);
    if (on && !live.length) return;
    setComparing(on);
    for (const r of on ? live : inScene.filter((x) => x.enabled || comparing)) await call('light.setRigEnabled', { folder: r.folder, enabled: !on });
    if (!on) load();
  };

  return (
    <div className="panel-body rigs">
      <div className="section">
        <h3>
          Lighting rigs
          <Help text="Ready-made light setups placed around the selected character, fitted to their height and the way they face. Apply adds the lights to the scene (undoable); “Light characters only” keeps them off the stage." />
        </h3>
        <div className="hint" style={{ marginTop: 0 }}>
          {chars.length ? `Around ${displayName(nodes[chars[0]])}.` : 'Select a character to light.'}
        </div>
        <label className="rigs-opt" title="Rig lights affect characters only, so the map keeps its own lighting">
          <input type="checkbox" checked={charaOnly} onChange={(e) => setCharaOnly(e.target.checked)} /> Light characters only
        </label>
        <div className="rig-list">
          {rigs.map((r) => (
            <div key={r.file ?? r.name} className="rig-card">
              <div>
                <b>{r.name}</b>
                <small>{r.note || `${r.lights.length} light${r.lights.length > 1 ? 's' : ''}`}</small>
                <small className="rig-roles">{r.lights.map((l) => `${l.role} (${l.type})`).join(' · ')}</small>
              </div>
              <div className="rig-actions">
                <button className="btn solid" disabled={!chars.length} onClick={() => apply(r)}>
                  Apply
                </button>
                {!r.builtin && (
                  <button className="btn small" title="Delete this saved rig" onClick={async () => (await ask(`Delete the saved rig “${r.name}”?`)) && call<Rig[]>('light.deleteRig', { file: r.file }).then((x) => x && setRigs(x))}>
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h3>In this scene</h3>
        {!inScene.length && <div className="hint" style={{ marginTop: 0 }}>No rigs yet.</div>}
        {inScene.map((r) => (
          <div key={r.folder} className="rig-scene">
            <label title="Switch this rig's lights on or off">
              <input type="checkbox" checked={r.enabled} onChange={(e) => call<SceneRig[]>('light.setRigEnabled', { folder: r.folder, enabled: e.target.checked }).then((x) => x && setInScene(x))} />
              <span>{r.name}</span>
              <small>{r.lights} lights</small>
            </label>
            <button className="btn small" title="Delete this rig's lights from the scene" onClick={async () => (await ask(`Remove the “${r.name}” rig and its lights from the scene? (Not undoable — like deleting in Studio.)`)) && call<SceneRig[]>('light.removeRig', { folder: r.folder }).then((x) => x && setInScene(x))}>
              Remove
            </button>
          </div>
        ))}
        {inScene.some((r) => r.enabled) && (
          <button className={`btn solid wide ${comparing ? 'on' : ''}`} onPointerDown={() => compare(true)} onPointerUp={() => compare(false)} onPointerLeave={() => comparing && compare(false)} title="Hold to see the scene without the rigs">
            Hold to compare without rigs
          </button>
        )}
      </div>

      <div className="section">
        <h3>
          Save as a rig
          <Help text="Arrange lights in Studio around the selected character, then save: the rig remembers where they are relative to the character, so it fits any character later." />
        </h3>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder="Rig name…" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
          <button
            className="btn primary"
            disabled={!saveName.trim() || !chars.length}
            onClick={async () => {
              const r = await call<Rig[]>('light.saveRig', { name: saveName.trim(), id: chars[0] });
              if (r) {
                setRigs(r);
                setSaveName('');
                toast('Saved — every light in the scene, relative to the selected character');
              }
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

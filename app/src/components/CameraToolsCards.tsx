import { useCallback, useEffect, useState } from 'react';
import { bridge } from '../bridge/client';
import { displayName, toast, useStore } from '../state/store';
import { Slider } from './CharacterPanel';
import { Help } from './Help';
import { Switch } from './LookPanel';

// Shoot › Shots & camera: first-person view, follow a body part, framing guides over Studio's window.
// RealPOV / LockOnPlugin do the first two when they're installed (switchable); ours otherwise.

interface Tools {
  pov: { on: boolean; id: number; fov: number; hideHead: boolean; useTheirs: boolean; provider: string; theirsInstalled: boolean };
  follow: { on: boolean; id: number; bone: string; speed: number; useTheirs: boolean; provider: string; theirsInstalled: boolean; bones: string[] };
  guides: { thirds: boolean; center: boolean; safe: boolean; aspect: number; dim: number };
}

const BONE_LABEL: Record<string, string> = { head: 'Head', eyes: 'Eyes', chest: 'Chest', hips: 'Hips', handL: 'Left hand', handR: 'Right hand', feet: 'Feet' };
const ASPECTS: { label: string; v: number | 'render' }[] = [
  { label: 'Off', v: 0 },
  { label: 'Render size', v: 'render' },
  { label: '16:9', v: 16 / 9 },
  { label: '9:16', v: 9 / 16 },
  { label: '1:1', v: 1 },
  { label: '4:5', v: 4 / 5 },
  { label: '2.39:1', v: 2.39 },
];

export function CameraToolsCards() {
  const status = useStore((s) => s.status);
  const nodes = useStore((s) => s.nodes);
  const selection = useStore((s) => s.studioSelection);
  const [t, setT] = useState<Tools | null>(null);
  const [renderAspect, setRenderAspect] = useState(0);
  const [aspectPick, setAspectPick] = useState<string>('Off');
  const charas = Object.values(nodes).filter((n) => n.type === 'Char');
  const selChara = selection.find((id) => nodes[id]?.type === 'Char');
  const [who, setWho] = useState<number | null>(null);
  const chara = who != null && nodes[who] ? who : (selChara ?? charas[0]?.id ?? null);

  const load = useCallback(() => {
    bridge.request<Tools>('camtools.get').then(setT).catch(() => setT(null));
    bridge
      .request<{ settings: { resize: boolean; width: number; height: number } }>('render.status')
      .then((r) => setRenderAspect(r.settings.resize && r.settings.height ? r.settings.width / r.settings.height : 0))
      .catch(() => setRenderAspect(0));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load]);

  const set = async (patch: Partial<{ [K in keyof Tools]: Partial<Tools[K]> }>) => {
    try {
      setT(await bridge.request<Tools>('camtools.set', patch));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (!t) return null;
  const who2 = (on: boolean) => (on ? { id: chara ?? -1 } : {});
  const picker = (
    <select className="input" value={chara ?? ''} onChange={(e) => setWho(Number(e.target.value))} title="The character the camera uses">
      {charas.map((c) => (
        <option key={c.id} value={c.id}>
          {displayName(c)}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <div className="look-card">
        <div className="look-card-head">
          <div>
            <b>
              First person
              <Help text="See through a character's eyes: the camera sits at the eyes and turns with the head (keyed head and neck motion included). Turning it off puts Studio's camera back where it was." />
            </b>
          </div>
          <Switch on={t.pov.on} onChange={(v) => (charas.length ? set({ pov: { on: v, ...who2(v) } }) : toast('No character in the scene', 'error'))} />
        </div>
        <div className="look-card-body ct-body">
          <div className="ct-row">
            <label>Character</label>
            {picker}
          </div>
          <div className="ct-row">
            <label>Field of view</label>
            <Slider value={t.pov.fov} min={30} max={110} step={1} onChange={(v) => set({ pov: { fov: v } })} />
          </div>
          <div className="ct-row">
            <label>
              Hide the head
              <Help text="Hair and accessories won't block the view." />
            </label>
            <Switch on={t.pov.hideHead} onChange={(v) => set({ pov: { hideHead: v } })} />
          </div>
          {t.pov.theirsInstalled && (
            <div className="ct-row">
              <label>
                Use RealPOV
                <Help text="RealPOV is installed: let it do first person (mouse-look works in Studio's window). Off uses Keyframe Studio's, which follows the head exactly — better for animated shots." />
              </label>
              <Switch on={t.pov.useTheirs} onChange={(v) => set({ pov: { useTheirs: v } })} />
            </div>
          )}
          <div className="ct-foot">{t.pov.on ? `On · ${t.pov.provider}` : `Off · would use ${t.pov.provider}`}</div>
        </div>
      </div>

      <div className="look-card">
        <div className="look-card-head">
          <div>
            <b>
              Follow
              <Help text="The camera keeps a body part in the centre while it moves — you can still orbit and zoom around it in Studio's window." />
            </b>
          </div>
          <Switch on={t.follow.on} onChange={(v) => (charas.length ? set({ follow: { on: v, ...who2(v) } }) : toast('No character in the scene', 'error'))} />
        </div>
        <div className="look-card-body ct-body">
          <div className="ct-row">
            <label>Character</label>
            {picker}
          </div>
          <div className="ct-chips">
            {t.follow.bones.map((b) => (
              <button key={b} className={`btn chip ${t.follow.bone === b ? 'on' : ''}`} onClick={() => set({ follow: { bone: b } })}>
                {BONE_LABEL[b] ?? b}
              </button>
            ))}
          </div>
          {t.follow.provider !== 'LockOnPlugin' && (
            <div className="ct-row">
              <label>
                Smoothness
                <Help text="Low = lags behind softly; high = sticks tight." />
              </label>
              <Slider value={t.follow.speed} min={1} max={30} step={0.5} onChange={(v) => set({ follow: { speed: v } })} />
            </div>
          )}
          {t.follow.theirsInstalled && (
            <div className="ct-row">
              <label>
                Use LockOnPlugin
                <Help text="LockOnPlugin is installed: let it follow (its hotkeys keep working). Off uses Keyframe Studio's." />
              </label>
              <Switch on={t.follow.useTheirs} onChange={(v) => set({ follow: { useTheirs: v } })} />
            </div>
          )}
          <div className="ct-foot">{t.follow.on ? `On · ${t.follow.provider}` : `Off · would use ${t.follow.provider}`}</div>
        </div>
      </div>

      <div className="look-card">
        <div className="look-card-head">
          <div>
            <b>
              Frame guides
              <Help text="Drawn over Studio's window only — never in renders or snapshots, and hidden while recording." />
            </b>
          </div>
        </div>
        <div className="look-card-body ct-body">
          <div className="ct-row">
            <label>Thirds</label>
            <Switch on={t.guides.thirds} onChange={(v) => set({ guides: { thirds: v } })} />
          </div>
          <div className="ct-row">
            <label>Centre</label>
            <Switch on={t.guides.center} onChange={(v) => set({ guides: { center: v } })} />
          </div>
          <div className="ct-row">
            <label>
              Safe areas
              <Help text="Inner frames at 90% and 80%: keep faces and text inside for screens that crop the edges." />
            </label>
            <Switch on={t.guides.safe} onChange={(v) => set({ guides: { safe: v } })} />
          </div>
          <div className="ct-label">Frame</div>
          <div className="ct-chips">
            {ASPECTS.map((a) => {
              const v = a.v === 'render' ? renderAspect : a.v;
              const on = aspectPick === a.label || (aspectPick === 'Off' && a.v === 0 && !t.guides.aspect);
              return (
                <button
                  key={a.label}
                  className={`btn chip ${on ? 'on' : ''}`}
                  disabled={a.v === 'render' && !renderAspect}
                  title={a.v === 'render' ? (renderAspect ? 'The size set in Shoot › Render' : 'Render uses the window size') : undefined}
                  onClick={() => {
                    setAspectPick(a.label);
                    set({ guides: { aspect: v } });
                  }}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
          {t.guides.aspect > 0 && (
            <div className="ct-row">
              <label>Dim outside</label>
              <Slider value={t.guides.dim} min={0} max={1} step={0.05} onChange={(v) => set({ guides: { dim: v } })} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

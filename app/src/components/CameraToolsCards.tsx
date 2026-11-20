import { useEffect } from 'react';
import { create } from 'zustand';
import { bridge } from '../bridge/client';
import { displayName, toast, useStore } from '../state/store';
import { Slider } from './CharacterPanel';
import { ColorInput, Switch } from './LookPanel';
import { Field, Panel } from './Page';

// Shoot › Shots & camera: what the camera is doing (free / first person / follow) and the frame guides over
// Studio's window. RealPOV / LockOnPlugin do first person and follow when they're installed (switchable).

interface Tools {
  pov: { on: boolean; id: number; fov: number; hideHead: boolean; useTheirs: boolean; provider: string; theirsInstalled: boolean };
  follow: { on: boolean; id: number; bone: string; speed: number; useTheirs: boolean; provider: string; theirsInstalled: boolean; bones: string[] };
  guides: { thirds: boolean; center: boolean; safe: boolean; golden: boolean; diagonals: boolean; spiral: number; aspect: number; dim: number; color: number[] };
}
type Patch = Partial<{ [K in keyof Tools]: Partial<Tools[K]> }>;

const BONE_LABEL: Record<string, string> = { head: 'Head', eyes: 'Eyes', chest: 'Chest', hips: 'Hips', handL: 'Left hand', handR: 'Right hand', feet: 'Feet' };
// guide colours that read well on light or dark scenes
const GUIDE_COLORS: { label: string; c: [number, number, number] }[] = [
  { label: 'White', c: [1, 1, 1] },
  { label: 'Black', c: [0, 0, 0] },
  { label: 'Yellow', c: [1, 0.83, 0.3] },
  { label: 'Cyan', c: [0.22, 0.85, 1] },
  { label: 'Magenta', c: [1, 0.31, 0.85] },
  { label: 'Green', c: [0.49, 1, 0.42] },
];
const GUIDE_KEY = 'kf.guideColor';
const savedGuideColor = (): number[] | null => {
  try {
    const v = JSON.parse(localStorage.getItem(GUIDE_KEY) ?? 'null');
    return Array.isArray(v) && v.length === 4 ? v : null;
  } catch {
    return null;
  }
};
const ASPECTS: { label: string; v: number | 'render' }[] = [
  { label: 'Off', v: 0 },
  { label: 'Render size', v: 'render' },
  { label: '16:9', v: 16 / 9 },
  { label: '9:16', v: 9 / 16 },
  { label: '1:1', v: 1 },
  { label: '4:5', v: 4 / 5 },
  { label: '2.39:1', v: 2.39 },
];

// ---------------------------------------------------------------------------
// Shared state for both panels: shown at once, sent at most once a frame (sliders); replies only land when
// nothing newer is waiting.
// ---------------------------------------------------------------------------

interface CamToolsState {
  t: Tools | null;
  renderAspect: number;
  aspectPick: string;
  who: number | null;
}
const useCamTools = create<CamToolsState>(() => ({ t: null, renderAspect: 0, aspectPick: 'Off', who: null }));
let pending: Record<string, Record<string, unknown>> = {};
let frame = 0;
let inflight = 0;

function loadCamTools() {
  bridge
    .request<Tools>('camtools.get')
    .then(async (r) => {
      // the colour you picked last time (Studio forgets it when it restarts)
      const saved = savedGuideColor();
      if (saved && saved.some((x, i) => Math.abs(x - (r.guides.color?.[i] ?? 0)) > 1e-3)) r = await bridge.request<Tools>('camtools.set', { guides: { color: saved } });
      useCamTools.setState({ t: r });
    })
    .catch(() => useCamTools.setState({ t: null }));
  bridge
    .request<{ settings: { resize: boolean; width: number; height: number } }>('render.status')
    .then((r) => useCamTools.setState({ renderAspect: r.settings.resize && r.settings.height ? r.settings.width / r.settings.height : 0 }))
    .catch(() => useCamTools.setState({ renderAspect: 0 }));
}

function setCamTools(patch: Patch) {
  const cur = useCamTools.getState().t;
  if (cur) {
    const next = { ...cur } as unknown as Record<string, object>;
    for (const [k, v] of Object.entries(patch)) next[k] = { ...(cur as unknown as Record<string, object>)[k], ...v };
    useCamTools.setState({ t: next as unknown as Tools });
  }
  for (const [k, v] of Object.entries(patch)) pending[k] = { ...(pending[k] ?? {}), ...(v as object) };
  if (frame) return;
  frame = requestAnimationFrame(async () => {
    frame = 0;
    const p = pending;
    pending = {};
    inflight++;
    try {
      const r = await bridge.request<Tools>('camtools.set', p);
      if (--inflight === 0 && !frame) useCamTools.setState({ t: r });
    } catch (e) {
      inflight--;
      toast((e as Error).message, 'error');
      loadCamTools();
    }
  });
}

function useLoadedCamTools() {
  const status = useStore((s) => s.status);
  useEffect(() => {
    if (status === 'open') loadCamTools();
  }, [status]);
  return useCamTools();
}

// ---------------------------------------------------------------------------
// Camera mode: one choice (they can't both be on)
// ---------------------------------------------------------------------------

export function CameraModePanel() {
  const { t, who } = useLoadedCamTools();
  const nodes = useStore((s) => s.nodes);
  const selection = useStore((s) => s.studioSelection);
  if (!t) return null;
  const charas = Object.values(nodes).filter((n) => n.type === 'Char');
  const chara = who != null && nodes[who] ? who : (selection.find((id) => nodes[id]?.type === 'Char') ?? charas[0]?.id ?? null);
  const mode: 'free' | 'pov' | 'follow' = t.pov.on ? 'pov' : t.follow.on ? 'follow' : 'free';
  const pick = (m: typeof mode) => {
    if (m === mode) return;
    if (m !== 'free' && chara == null) return toast('No character in the scene', 'error');
    if (m === 'free') setCamTools({ pov: { on: false }, follow: { on: false } });
    else if (m === 'pov') setCamTools({ follow: { on: false }, pov: { on: true, id: chara! } });
    else setCamTools({ pov: { on: false }, follow: { on: true, id: chara! } });
  };
  const using = mode === 'pov' ? t.pov.id : mode === 'follow' ? t.follow.id : chara;
  const provider = mode === 'pov' ? t.pov.provider : mode === 'follow' ? t.follow.provider : null;

  return (
    <Panel title="Camera mode" help="What Studio's camera does. Free: you move it (orbit with the mouse in Studio). First person: through a character's eyes, turning with the head. Follow: keeps a body part centred while you still orbit around it.">
      <div className="seg cm-modes">
        {(
          [
            ['free', 'Free'],
            ['pov', 'First person'],
            ['follow', 'Follow'],
          ] as const
        ).map(([m, label]) => (
          <button key={m} className={mode === m ? 'on' : ''} onClick={() => pick(m)}>
            {label}
          </button>
        ))}
      </div>
      {mode === 'free' ? (
        <div className="pn-note">Studio's own camera. Saved views and camera keys work in any mode.</div>
      ) : (
        <>
          <Field label="Character">
            <select
              className="input"
              value={using != null && nodes[using] ? using : ''}
              onChange={(e) => {
                const id = Number(e.target.value);
                useCamTools.setState({ who: id });
                setCamTools({ [mode]: { id } } as Patch);
              }}
            >
              {charas.map((c) => (
                <option key={c.id} value={c.id}>
                  {displayName(c)}
                </option>
              ))}
            </select>
          </Field>
          {mode === 'pov' && (
            <>
              <Field label="Field of view">
                <Slider value={t.pov.fov} min={30} max={110} step={1} onChange={(v) => setCamTools({ pov: { fov: v } })} />
              </Field>
              <Field label="Hide the head" help="Hair and accessories won't block the view.">
                <Switch on={t.pov.hideHead} onChange={(v) => setCamTools({ pov: { hideHead: v } })} />
              </Field>
              {t.pov.theirsInstalled && (
                <Field label="Use RealPOV" help="RealPOV is installed: let it do first person (mouse-look works in Studio's window). Off uses Keyframe Studio's, which follows the head exactly — better for animated shots.">
                  <Switch on={t.pov.useTheirs} onChange={(v) => setCamTools({ pov: { useTheirs: v } })} />
                </Field>
              )}
            </>
          )}
          {mode === 'follow' && (
            <>
              <Field label="Keep centred">
                <div className="ct-chips" style={{ margin: 0 }}>
                  {t.follow.bones.map((b) => (
                    <button key={b} className={`btn chip ${t.follow.bone === b ? 'on' : ''}`} onClick={() => setCamTools({ follow: { bone: b } })}>
                      {BONE_LABEL[b] ?? b}
                    </button>
                  ))}
                </div>
              </Field>
              {t.follow.provider !== 'LockOnPlugin' && (
                <Field label="Smoothness" help="Low = lags behind softly; high = sticks tight.">
                  <Slider value={t.follow.speed} min={1} max={30} step={0.5} onChange={(v) => setCamTools({ follow: { speed: v } })} />
                </Field>
              )}
              {t.follow.theirsInstalled && (
                <Field label="Use LockOnPlugin" help="LockOnPlugin is installed: let it follow (its hotkeys keep working). Off uses Keyframe Studio's.">
                  <Switch on={t.follow.useTheirs} onChange={(v) => setCamTools({ follow: { useTheirs: v } })} />
                </Field>
              )}
            </>
          )}
          {provider && <div className="pn-note">Done by {provider}</div>}
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Frame guides
// ---------------------------------------------------------------------------

export function FrameGuidesPanel() {
  const { t, renderAspect, aspectPick } = useLoadedCamTools();
  if (!t) return null;
  const g = t.guides;
  const setColor = (color: number[]) => {
    try {
      localStorage.setItem(GUIDE_KEY, JSON.stringify(color));
    } catch {
      /* private mode */
    }
    setCamTools({ guides: { color } });
  };
  const toggles = [
    ['thirds', 'Thirds', 'Rule of thirds'],
    ['center', 'Centre', 'A cross at the centre'],
    ['safe', 'Safe areas', 'Inner frames at 90% and 80%: keep faces and text inside for screens that crop the edges'],
    ['golden', 'Golden ratio', 'Lines at 38% and 62%: a slightly tighter, calmer alternative to thirds'],
    ['diagonals', 'Diagonals', 'Corner-to-corner lines and their square-on partners: lead the eye along them'],
  ] as const;
  // the golden spiral winds into one of four corners; each press turns it, the last press hides it
  const SPIRAL = ['↗ top right', '↖ top left', '↘ bottom right', '↙ bottom left'];
  return (
    <Panel title="Frame guides" help="Drawn over Studio's window only — never in renders, snapshots or stills, and hidden while recording.">
      <Field label="Show">
        <div className="ct-chips" style={{ margin: 0 }}>
          {toggles.map(([k, label, hint]) => (
            <button key={k} className={`btn chip ${g[k] ? 'on' : ''}`} title={hint} onClick={() => setCamTools({ guides: { [k]: !g[k] } })}>
              {label}
            </button>
          ))}
          <button
            className={`btn chip ${(g.spiral ?? -1) >= 0 ? 'on' : ''}`}
            title={`Golden spiral — press again to turn it to the next corner${(g.spiral ?? -1) >= 0 ? ` (now ${SPIRAL[g.spiral]})` : ''}`}
            onClick={() => setCamTools({ guides: { spiral: (g.spiral ?? -1) >= 3 ? -1 : (g.spiral ?? -1) + 1 } })}
          >
            Spiral{(g.spiral ?? -1) >= 0 ? ` ${SPIRAL[g.spiral].slice(0, 1)}` : ''}
          </button>
        </div>
      </Field>
      <Field label="Frame" help="The shape of the picture, with the outside dimmed. Render size = the size set in Shoot › Render.">
        <div className="ct-chips" style={{ margin: 0 }}>
          {ASPECTS.map((a) => {
            const v = a.v === 'render' ? renderAspect : a.v;
            const on = aspectPick === a.label || (aspectPick === 'Off' && a.v === 0 && !g.aspect);
            return (
              <button
                key={a.label}
                className={`btn chip ${on ? 'on' : ''}`}
                disabled={a.v === 'render' && !renderAspect}
                title={a.v === 'render' ? (renderAspect ? 'The size set in Shoot › Render' : 'Render uses the window size') : undefined}
                onClick={() => {
                  useCamTools.setState({ aspectPick: a.label });
                  setCamTools({ guides: { aspect: v } });
                }}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      </Field>
      {g.aspect > 0 && (
        <Field label="Dim outside">
          <Slider value={g.dim} min={0} max={1} step={0.05} onChange={(v) => setCamTools({ guides: { dim: v } })} />
        </Field>
      )}
      <Field label="Colour">
        <div className="ct-swatches" style={{ margin: 0 }}>
          {GUIDE_COLORS.map((c) => (
            <button
              key={c.label}
              className={`ct-swatch ${c.c.every((x, i) => Math.abs(x - g.color[i]) < 0.01) ? 'on' : ''}`}
              title={c.label}
              style={{ background: `rgb(${c.c.map((x) => Math.round(x * 255)).join(',')})` }}
              onClick={() => setColor([...c.c, g.color[3]])}
            />
          ))}
          <ColorInput value={g.color} onChange={(c) => setColor([c[0], c[1], c[2], g.color[3]])} />
        </div>
      </Field>
      <Field label="Strength">
        <Slider value={g.color[3]} min={0.1} max={1} step={0.05} onChange={(a) => setColor([g.color[0], g.color[1], g.color[2], a])} />
      </Field>
    </Panel>
  );
}

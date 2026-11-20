import { useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { toast, useStore } from '../state/store';
import { Help } from './Help';
import { Icon } from './Icon';
import { Popover } from './Shell';
import { NumberField } from './TopBar';

type V3 = [number, number, number];

interface Target {
  kind: 'bone' | 'ik' | 'object' | 'accessory';
  id: number;
  index: number;
  label: string;
  pos: V3;
  rot: V3;
  scale: V3;
  canMove: boolean;
  canRotate: boolean;
  canScale: boolean;
}

interface GizmoState {
  overlays: { on: boolean; skeleton: boolean; ik: boolean; accessories: boolean; highlight: boolean; lights: boolean; cameras: boolean; focus: boolean; allCharacters: boolean; labels: boolean };
  gizmo: { on: boolean; world: boolean; snapMove: number; snapRot: number; snapScale: number; mode: number };
  pick: { characters: boolean; accessories: boolean; items: boolean; lights: boolean; cameras: boolean };
  target: Target | null;
  dragging: boolean;
}

type Patch = { overlays?: Partial<GizmoState['overlays']>; gizmo?: Partial<GizmoState['gizmo']>; pick?: Partial<GizmoState['pick']> };

const SAVED = 'kf.viewportOverlays';
function saved(): Patch | null {
  try {
    return JSON.parse(localStorage.getItem(SAVED) ?? 'null');
  } catch {
    return null;
  }
}
function remember(st: GizmoState) {
  try {
    const { mode: _m, ...gizmo } = st.gizmo; // Studio's own Move / Rotate / Scale mode isn't ours to restore
    localStorage.setItem(SAVED, JSON.stringify({ overlays: st.overlays, gizmo, pick: st.pick }));
  } catch {
    /* settings only */
  }
}

const KIND: Record<Target['kind'], string> = { bone: 'Bone', ik: 'IK target', object: 'Object', accessory: 'Accessory' };

/**
 * Overlays and handles in Studio's own view: the skeleton with clickable joints, IK targets, a selection outline,
 * lights and scene cameras — and move / rotate / scale handles that pose bones and place things right there.
 */
export function ViewportOverlays() {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  const [st, setSt] = useState<GizmoState | null>(null);
  const restored = useRef(false);

  // on connect: put back the last choices (Studio forgets them when it restarts), then follow along
  useEffect(() => {
    if (status !== 'open') {
      restored.current = false;
      return;
    }
    const s = saved();
    const first = !restored.current && s ? bridge.request<GizmoState>('gizmo.set', s) : bridge.request<GizmoState>('gizmo.get');
    restored.current = true;
    first.then(setSt).catch(() => setSt(null));
  }, [status, revision]);
  useEffect(() => bridge.on('gizmo.target', (t) => setSt((s) => (s ? { ...s, target: (t as Target) ?? null } : s))), []);
  // Move / Rotate / Scale switched in Studio's view (click the handles' middle, or its mode chips)
  useEffect(() => bridge.on('gizmo.changed', (d) => setSt(d as GizmoState)), []);

  if (!st) return null;
  const set = (patch: Patch) => {
    const next: GizmoState = {
      ...st,
      overlays: { ...st.overlays, ...patch.overlays },
      gizmo: { ...st.gizmo, ...patch.gizmo },
      pick: { ...st.pick, ...patch.pick },
    };
    setSt(next);
    remember(next);
    bridge
      .request<GizmoState>('gizmo.set', patch)
      .then(setSt)
      .catch((e) => toast((e as Error).message, 'error'));
  };
  const o = st.overlays;
  const g = st.gizmo;
  const t = st.target;

  const check = (label: string, on: boolean, change: (v: boolean) => void, hint?: string) => (
    <label className="vo-check" title={hint}>
      <input type="checkbox" checked={on} onChange={(e) => change(e.target.checked)} />
      {label}
    </label>
  );

  return (
    <div className="group">
      <button
        className={`btn ${o.on ? 'on' : ''}`}
        title="Overlays in Studio's view: the skeleton (click a joint to pose it), IK targets, a selection outline, lights and cameras. Never shown in renders or stills."
        onClick={() => set({ overlays: { on: !o.on } })}
      >
        <Icon name="skeleton" size={14} /> Overlays
      </button>
      <button
        className={`btn ${g.on ? 'on' : ''}`}
        title={`Handles in Studio's view — drag to move, rotate or scale${t ? ` (${t.label})` : ''}. They replace Studio's own while on. Ctrl snaps, Shift for fine control.`}
        onClick={() => set({ gizmo: { on: !g.on } })}
      >
        <Icon name="gizmo" size={14} /> Handles{g.on && t ? <span className="vo-target">{t.label}</span> : null}
      </button>
      <Popover
        align="right"
        width={300}
        trigger={(open, toggle) => (
          <button className={`btn icon ${open ? 'on' : ''}`} title="Overlay & handle options" onClick={toggle}>
            <Icon name="chevronDown" size={12} />
          </button>
        )}
      >
        <div className="vo-pop">
          {t && <TargetCard t={t} onChange={(next) => setSt({ ...st, target: next })} />}

          <div className="menu-label">
            Handles
            <Help text="Drag the coloured rings to turn a bone (the white ring turns it toward you), the arrows to move, the cubes to scale; drag the middle to move freely. Only the part you touch changes: a turned bone puts just its part in FK (an IK limb hands over), a moved IK target puts just its limb in IK — the rest keeps its pose. An arrow pointing at you fades out (it would be too short to move with). Click the handles' middle to step Move → Rotate → Scale, or rest the pointer on it and pick from the three chips that come out. Each drag is one undo, FK / IK switches included. Ctrl snaps to the steps below; Shift moves a quarter as far." />
          </div>
          <div className="seg">
            {(['Move', 'Rotate', 'Scale'] as const).map((m, i) => (
              <button key={m} className={g.mode === i ? 'on' : ''} onClick={() => set({ gizmo: { mode: i, on: true } })}>
                {m}
              </button>
            ))}
          </div>
          <div className="seg">
            <button className={!g.world ? 'on' : ''} onClick={() => set({ gizmo: { world: false } })} title="Handles along the object's own axes">
              Local
            </button>
            <button className={g.world ? 'on' : ''} onClick={() => set({ gizmo: { world: true } })} title="Handles along the scene's axes">
              World
            </button>
          </div>
          <div className="vo-snaps">
            <span>Ctrl snaps</span>
            <NumberField value={g.snapMove} width={66} format={(v) => `${+v.toFixed(3)} m`} parse={num} onCommit={(v) => set({ gizmo: { snapMove: v } })} />
            <NumberField value={g.snapRot} width={54} format={(v) => `${+v.toFixed(1)}°`} parse={num} onCommit={(v) => set({ gizmo: { snapRot: v } })} />
            <NumberField value={g.snapScale} width={54} format={(v) => `×${+v.toFixed(2)}`} parse={num} onCommit={(v) => set({ gizmo: { snapScale: v } })} />
          </div>

          <div className="menu-sep" />
          <div className="menu-label">
            Overlays
            <Help text="Drawn over Studio's view, on top of its effects so they stay sharp — never in renders, stills or videos. Blue joints are posed by FK; yellow diamonds are IK targets (solid when IK drives that limb; a hollow diamond around a joint — click its edge). Teal squares are accessories: click one to move, turn or scale it (saved with the outfit). The green reticle is where the depth of field focuses: drag it onto what should be sharp — drop it on the eyes to keep following them. Hover anything for its name." />
          </div>
          <div className="vo-grid">
            {check('Skeleton', o.skeleton, (v) => set({ overlays: { skeleton: v, on: true } }))}
            {check('IK targets', o.ik, (v) => set({ overlays: { ik: v, on: true } }))}
            {check('Selection outline', o.highlight, (v) => set({ overlays: { highlight: v, on: true } }))}
            {check('Lights', o.lights, (v) => set({ overlays: { lights: v, on: true } }))}
            {check('Cameras', o.cameras, (v) => set({ overlays: { cameras: v, on: true } }))}
            {check('Accessories', o.accessories, (v) => set({ overlays: { accessories: v, on: true } }))}
            {check('Focus point', o.focus, (v) => set({ overlays: { focus: v, on: true } }), 'Where depth of field is focused (Look › Effects); drag it to refocus')}
            {check('Names on hover', o.labels, (v) => set({ overlays: { labels: v } }))}
          </div>
          {check('Every character, not just the selected', o.allCharacters, (v) => set({ overlays: { allCharacters: v } }))}

          <div className="menu-sep" />
          <div className="menu-label">
            Click to select
            <Help text="Click in Studio's view to select what's under the pointer — the nearest joint, IK target, accessory, light or camera, else the smallest item there. Where things overlap (a wrist joint and its IK target), click the same spot again for the next one; the name tag says what's next. Dragging still turns the camera. Click empty space to let go of a bone." />
          </div>
          <div className="ct-chips" style={{ margin: 0 }}>
            {(['characters', 'accessories', 'items', 'lights', 'cameras'] as const).map((k) => (
              <button key={k} className={`btn chip ${st.pick[k] ? 'on' : ''}`} onClick={() => set({ pick: { [k]: !st.pick[k] } })}>
                {k[0].toUpperCase() + k.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </Popover>
    </div>
  );
}

function num(s: string): number | null {
  const n = Number(s.replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The handles' target, with its values to type in. */
function TargetCard({ t, onChange }: { t: Target; onChange: (t: Target) => void }) {
  const send = (patch: Partial<Pick<Target, 'pos' | 'rot' | 'scale'>>) =>
    bridge
      .request<Target>('gizmo.value', patch)
      .then((r) => r && onChange(r))
      .catch((e) => toast((e as Error).message, 'error'));
  const row = (label: string, key: 'pos' | 'rot' | 'scale', digits: number) => (
    <div className="vo-row">
      <span>{label}</span>
      {t[key].map((v, i) => (
        <NumberField
          key={i}
          value={v}
          width={62}
          format={(x) => (key === 'rot' ? normDeg(x) : x).toFixed(digits)}
          parse={(s) => {
            const n = Number(s.replace(',', '.'));
            return Number.isFinite(n) ? n : null;
          }}
          onCommit={(x) => {
            const next = [...t[key]] as V3;
            next[i] = x;
            send({ [key]: next });
          }}
        />
      ))}
    </div>
  );
  return (
    <div className="vo-card">
      <div className="vo-card-head">
        <b>{t.label}</b>
        <small>{KIND[t.kind]}</small>
      </div>
      <div className="vo-axes">
        <span />
        <i className="x">X</i>
        <i className="y">Y</i>
        <i className="z">Z</i>
      </div>
      {t.canMove && row('Move', 'pos', t.kind === 'accessory' ? 1 : 3)}
      {t.canRotate && row('Turn', 'rot', 1)}
      {t.canScale && row('Scale', 'scale', 2)}
    </div>
  );
}

/** 350° shows as -10°: a bone turned a little either way reads as a small number. */
const normDeg = (d: number) => {
  const x = ((d % 360) + 360) % 360;
  return x > 180 ? x - 360 : x;
};

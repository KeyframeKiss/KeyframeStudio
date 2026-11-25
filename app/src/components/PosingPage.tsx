import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, useStore } from '../state/store';
import { Section } from './Page';
import { Help } from './Help';
import { Icon } from './Icon';
import { EmptyState, SwitchCard } from './EditorBits';
import { DragNumber } from './DragNumber';
import { Slider } from './CharacterPanel';
import { Vec } from './AbmxSection';
import { boneLabel } from '../lib/boneNames';
import { keyPoseWithFace, keyWholePose, setKeyPoseWithFace } from '../lib/keyPose';

/**
 * Character › Posing: how each part of the selected character is posed, in plain words, and KKPE's advanced posing
 * (target strength and bend goals, joint correction, copy to the other side, physics, every bone by number).
 * Bridge: posing.* (Api/PosingApi.cs); bones by number reuse face.get / face.set / face.reset.
 */

type Mode = 'ik' | 'fk' | 'anim';
type Limb = 'body' | 'legR' | 'legL' | 'armR' | 'armL';
interface IkRow {
  key: string;
  label: string;
  kind: 'effector' | 'bend';
  limb: Limb;
  pos?: number;
  rot?: number | null;
  bend?: number;
  edited: boolean;
}
interface BustRow {
  id: string;
  label: string;
  enabled: boolean;
  gravity: number[];
  force: number[];
  edited: boolean;
}
interface DynRow {
  path: string;
  name: string;
  label: string | null;
  enabled: boolean;
  weight: number;
  damping: number;
  elasticity: number;
  stiffness: number;
  inertia: number;
  radius: number;
  gravity: number[];
  force: number[];
  edited: boolean;
}
interface Posing {
  limbs: { limb: Limb; mode: Mode }[];
  fkExtras: { part: string; on: boolean }[];
  fk: boolean;
  ik: boolean;
  kkpe: 'ok' | 'missing' | 'notAttached' | 'off';
  ikWeights: IkRow[];
  joints: { crotch: boolean; ankleL: boolean; ankleR: boolean; optimizeIK: boolean } | null;
  bust: BustRow[];
  dyn: DynRow[];
}

const LIMB_LABEL: Record<Limb, string> = { body: 'Body (hips)', armL: 'Left arm', armR: 'Right arm', legL: 'Left leg', legR: 'Right leg' };
const LIMB_ORDER: Limb[] = ['armL', 'armR', 'body', 'legL', 'legR'];
const EXTRA_LABEL: Record<string, string> = { neck: 'Neck', handL: 'Left fingers', handR: 'Right fingers', hair: 'Hair', chest: 'Bust', skirt: 'Skirt' };
const MODE_WORD: Record<Mode, string> = { ik: 'Target', fk: 'Joints', anim: 'Animation' };
type View = 'pose' | 'strength' | 'physics' | 'bones';
const VIEWS: { id: View; label: string; hint: string }[] = [
  { id: 'pose', label: 'Pose', hint: 'How each part is posed, copy a side, key the whole pose' },
  { id: 'strength', label: 'Strength and joints', hint: 'Target strength, bend goals and joint correction (KKPE)' },
  { id: 'physics', label: 'Physics', hint: 'Bust and buttocks, hair, skirt and accessories (KKPE)' },
  { id: 'bones', label: 'Every bone', hint: 'Any bone by number (KKPE)' },
];

export function PosingPage({ id }: { id: number }) {
  const [p, setP] = useState<Posing | null>(null);
  const [withFace, setWithFace] = useState(keyPoseWithFace);
  // one view at a time instead of six sections in one scroll; remembered
  const [view, setViewState] = useState<View>(() => {
    try {
      const v = localStorage.getItem('kf.posing.view') as View | null;
      return v && VIEWS.some((x) => x.id === v) ? v : 'pose';
    } catch {
      return 'pose';
    }
  });
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem('kf.posing.view', v);
    } catch {
      /* not remembered; fine */
    }
  };
  const status = useStore((s) => s.status);
  const load = useCallback(() => call<Posing>('posing.get', { id }).then((r) => r && setP(r)), [id]);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load]);
  const revision = useStore((s) => s.revision);
  useEffect(() => {
    if (status === 'open') load();
  }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = () => load();
    window.addEventListener('kf:history', h);
    window.addEventListener('focus', h);
    // grabbing a ring or a target in Studio's view switches a part too: look again now and then while it's open
    const tick = window.setInterval(() => document.visibilityState === 'visible' && load(), 2500);
    return () => {
      window.removeEventListener('kf:history', h);
      window.removeEventListener('focus', h);
      window.clearInterval(tick);
    };
  }, [load]);

  // sliders send at most once a frame per value; the page updates at once (the bridge's answer isn't awaited)
  const pending = useRef(new Map<string, () => void>());
  const frame = useRef(0);
  const send = (key: string, run: () => void) => {
    pending.current.set(key, run);
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const all = [...pending.current.values()];
      pending.current.clear();
      all.forEach((f) => f());
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  if (!p) return <div className="empty">Loading the pose…</div>;
  const modeOf = (l: Limb) => p.limbs.find((x) => x.limb === l)?.mode ?? 'anim';
  const setMode = (limb: Limb | null, mode: Mode) => call<Posing>('posing.mode', limb ? { id, limb, mode } : { id, mode }).then((r) => r && setP(r));
  const setExtra = (part: string, on: boolean) => call<Posing>('posing.mode', { id, part, mode: on ? 'fk' : 'off' }).then((r) => r && setP(r));
  const kkpe = p.kkpe === 'ok';
  const toggleFace = () => {
    setKeyPoseWithFace(!withFace);
    setWithFace(!withFace);
  };

  const patchIk = (key: string, v: Partial<IkRow>) => setP((s) => (s ? { ...s, ikWeights: s.ikWeights.map((r) => (r.key === key ? { ...r, ...v, edited: true } : r)) } : s));
  const setIk = (key: string, v: { pos?: number; rot?: number; bend?: number }) => {
    patchIk(key, v);
    send(`ik|${key}|${Object.keys(v).join()}`, () => call('posing.ik', { id, key, ...v }));
  };
  const resetIk = (key: string) => call<IkRow[]>('posing.ik', { id, key, reset: true }).then((r) => r && setP((s) => (s ? { ...s, ikWeights: r } : s)));

  return (
    <div className="posing">
      <div className="seg posing-views" role="tablist" aria-label="Posing">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? 'on' : ''} title={v.hint} onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </div>
      {view === 'pose' && (
      <Section
        title="How each part is posed"
        help="Joints (FK): you turn each joint yourself — exact bends. Target (IK): you place the hand, foot or hips and the joints follow — quick for touching things. Animation: the character's animation moves it. Switching keeps the pose on screen (nothing jumps). In Studio's view you can also just grab a joint's rings (that part goes to Joints) or a yellow target (that limb goes to Target)."
        actions={
          <>
            <button className="btn solid" onClick={() => setMode(null, 'anim')} title="FK and IK off: the character's animation moves everything again">
              Let the animation play
            </button>
            <button className="btn primary" onClick={() => keyWholePose([id], withFace).then(load)} title="Key the whole pose exactly as it is, at the playhead: place, every joint and target (tracks made where missing). A pose only the animation holds is taken over by joints first. One undo step.">
              <Icon name="key" size={12} /> Key the whole pose
            </button>
          </>
        }
      >
        <div className="posing-modes">
          <div className="posing-figure-box">
            <BodyFigure mode={modeOf} />
            <div className="posing-legend">
              {(['fk', 'ik', 'anim'] as Mode[]).map((m) => (
                <span key={m}>
                  <span className={`posing-dot ${m}`} /> {MODE_WORD[m]}
                </span>
              ))}
            </div>
          </div>
          <div className="posing-limbs">
            {LIMB_ORDER.map((l) => (
              <div key={l} className="posing-limb">
                <span className={`posing-dot ${modeOf(l)}`} />
                <b>{LIMB_LABEL[l]}</b>
                <span className="spacer" />
                {modeOf(l) === 'anim' && <span className="posing-anim">Animation</span>}
                <div className="seg">
                  <button className={modeOf(l) === 'fk' ? 'on' : ''} onClick={() => modeOf(l) !== 'fk' && setMode(l, 'fk')} title="Pose it joint by joint (FK), starting from the pose on screen — also how to turn a target-posed limb into joints">
                    Joints
                  </button>
                  <button className={modeOf(l) === 'ik' ? 'on' : ''} onClick={() => modeOf(l) !== 'ik' && setMode(l, 'ik')} title="Pose it by placing its end (IK), starting from the pose on screen">
                    Target
                  </button>
                </div>
              </div>
            ))}
            <div className="posing-keyface">
              <SwitchCard on={withFace} label="Key the face with the pose" help="Key the whole pose also keys eyes, brows, mouth, blush, tears and where the neck looks." onChange={toggleFace} />
            </div>
            <div className="posing-extras">
              <span className="posing-extras-label">
                Also by joints
                <Help text="Parts that are only ever posed by their joints: on, they hold the pose you give them; off, the animation moves them." />
              </span>
              <div className="ct-chips">
                {p.fkExtras.map((x) => (
                  <button key={x.part} className={`btn chip ${x.on ? 'on' : ''}`} aria-pressed={x.on} onClick={() => setExtra(x.part, !x.on)}>
                    {EXTRA_LABEL[x.part] ?? x.part}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </Section>
      )}

      {view !== 'pose' && view !== 'bones' && !kkpe && <KkpeMissing state={p.kkpe} id={id} reload={load} />}
      {kkpe && (
        <>
          {view === 'pose' && (
          <Section title="Copy to the other side" help="Mirror one side's arm, hand (fingers) or leg onto the other — joints and target both. One undo step.">
            <div className="posing-copy">
              {(['arm', 'hand', 'leg'] as const).map((w) => (
                <div key={w} className="posing-copy-row">
                  <b>{w === 'arm' ? 'Arm' : w === 'hand' ? 'Fingers' : 'Leg'}</b>
                  <button className="btn solid" onClick={() => call('posing.copy', { id, what: w, from: 'L' }).then(load)}>
                    Left → right
                  </button>
                  <button className="btn solid" onClick={() => call('posing.copy', { id, what: w, from: 'R' }).then(load)}>
                    Right → left
                  </button>
                </div>
              ))}
            </div>
          </Section>
          )}

          {view === 'strength' && (
          <Section
            title="Target strength"
            help="How firmly each part follows its target while that limb is posed by a target (IK): 1 = exactly, lower = the animation or joints pull it away. Elbows and knees: how firmly they point toward their bend goal (the target beside the elbow or knee in Studio's view) — raise it when a knee caves in or an elbow flips. Keyable: + Track › KKPE."
          >
            <div className="posing-groups">
              {(['armL', 'armR', 'body', 'legL', 'legR'] as Limb[]).map((l) => {
                const rows = p.ikWeights.filter((r) => r.limb === l);
                if (!rows.length) return null;
                const active = modeOf(l) === 'ik';
                return (
                  <section key={l} className={`posing-card ${active ? '' : 'idle'}`}>
                    <header>
                      <b>{LIMB_LABEL[l]}</b>
                    </header>
                    {!active ? (
                      <div className="posing-idle">
                        Posed by {modeOf(l) === 'fk' ? 'its joints' : 'the animation'}.{' '}
                        <button className="btn small solid" onClick={() => setMode(l, 'ik')}>
                          Use a target
                        </button>
                      </div>
                    ) : rows.map((r) => (
                      <div key={r.key} className="posing-row ik">
                        <span className="posing-row-label">{r.kind === 'bend' ? `${r.label} bend` : r.label}</span>
                        <button className="btn icon" disabled={!r.edited} title="Back to how it was" onClick={() => resetIk(r.key)}>
                          <Icon name="undo" size={12} />
                        </button>
                        <div className="posing-row-controls">
                          {r.kind === 'bend' ? (
                            <Slider value={r.bend ?? 0} min={0} max={1} step={0.01} onChange={(v) => setIk(r.key, { bend: v })} />
                          ) : (
                            <>
                              <Slider value={r.pos ?? 0} min={0} max={1} step={0.01} onChange={(v) => setIk(r.key, { pos: v })} />
                              {r.rot != null && (
                                <div className="posing-sub">
                                  <small>Turn</small>
                                  <Slider value={r.rot} min={0} max={1} step={0.01} onChange={(v) => setIk(r.key, { rot: v })} />
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </section>
                );
              })}
            </div>
          </Section>
          )}

          {view === 'strength' && p.joints && (
            <Section title="Joint correction" help="KKPE fixes the mesh where joints bend far: the crotch when the thighs spread or lift, the ankles when feet point. Saved with the character.">
              <div className="ed-options">
                <SwitchCard on={p.joints.crotch} label="Crotch" onChange={(v) => call('posing.joints', { id, crotch: v }).then(load)} />
                <SwitchCard on={p.joints.ankleL} label="Left ankle" onChange={(v) => call('posing.joints', { id, ankleL: v }).then(load)} />
                <SwitchCard on={p.joints.ankleR} label="Right ankle" onChange={(v) => call('posing.joints', { id, ankleR: v }).then(load)} />
                <SwitchCard
                  on={p.joints.optimizeIK}
                  label="Steadier targets"
                  help="KKPE's Optimize IK: a stiffer spine and less body pull, so hands and feet reach their targets without dragging the hips around. On by default."
                  onChange={(v) => call('posing.joints', { id, optimizeIK: v }).then(load)}
                />
              </div>
            </Section>
          )}

          {view === 'physics' && <PhysicsSection id={id} p={p} setP={setP} send={send} reload={load} />}
        </>
      )}

      {view === 'bones' && (p.kkpe !== 'missing' ? <BonesSection id={id} /> : <KkpeMissing state={p.kkpe} id={id} reload={load} />)}
    </div>
  );
}

/** The character from the front, each part coloured by how it's posed (their right is on your left). */
function BodyFigure({ mode }: { mode: (l: Limb) => Mode }) {
  const c = (l: Limb) => `var(--posing-${mode(l)})`;
  return (
    <svg className="posing-figure" viewBox="0 0 120 200" role="img" aria-label="How each part is posed">
      <circle cx="60" cy="22" r="13" fill="var(--bg-3)" stroke="var(--line)" />
      <rect x="44" y="40" width="32" height="58" rx="9" fill={c('body')} opacity="0.9" />
      <rect x="22" y="42" width="14" height="62" rx="7" fill={c('armR')} transform="rotate(10 29 42)" />
      <rect x="84" y="42" width="14" height="62" rx="7" fill={c('armL')} transform="rotate(-10 91 42)" />
      <rect x="45" y="100" width="14" height="82" rx="7" fill={c('legR')} />
      <rect x="61" y="100" width="14" height="82" rx="7" fill={c('legL')} />
      <text x="22" y="196" className="posing-figure-side">R</text>
      <text x="92" y="196" className="posing-figure-side">L</text>
    </svg>
  );
}

function KkpeMissing({ state, id, reload }: { state: Posing['kkpe']; id: number; reload: () => void }) {
  if (state === 'off')
    return (
      <EmptyState
        title="KKPE is switched off for this character"
        action={
          <button className="btn primary" onClick={() => call('posing.kkpeOn', { id }).then(reload)}>
            Turn it on
          </button>
        }
      >
        Its Disable button was pressed. Target strength, joint correction, copying a side and physics need it on.
      </EmptyState>
    );
  if (state === 'notAttached') return <EmptyState title="KKPE hasn't picked this character up yet">Select the character once in Studio, then come back.</EmptyState>;
  return (
    <EmptyState title="Advanced posing needs KKPE">
      Target strength, bend goals, joint correction, copying a side, physics and every bone by number come from KKPE (KK Pose Editor). Install it, then restart CharaStudio.
    </EmptyState>
  );
}

// ------------------------------------------------------------------ physics

function Xyz({ v, step, onChange }: { v: number[]; step: number; onChange: (v: number[]) => void }) {
  return (
    <div className="posing-xyz">
      {[0, 1, 2].map((i) => (
        <DragNumber
          key={i}
          label={'XYZ'[i]}
          color={['var(--axis-x)', 'var(--axis-y)', 'var(--axis-z)'][i]}
          value={v[i] ?? 0}
          step={step}
          digits={4}
          onCommit={(n) => onChange(v.map((x, j) => (j === i ? n : x)))}
        />
      ))}
    </div>
  );
}

function PhysicsSection({ id, p, setP, send, reload }: { id: number; p: Posing; setP: React.Dispatch<React.SetStateAction<Posing | null>>; send: (k: string, f: () => void) => void; reload: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  if (!p.bust.length && !p.dyn.length) return null;
  const bust = (which: string, v: Record<string, unknown>) => call<BustRow[]>('posing.bust', { id, which, ...v }).then((r) => r && setP((s) => (s ? { ...s, bust: r } : s)));
  const dynLocal = (path: string, v: Partial<DynRow>) => setP((s) => (s ? { ...s, dyn: s.dyn.map((d) => (d.path === path ? { ...d, ...v, edited: true } : d)) } : s));
  const dyn = (path: string, v: Partial<DynRow>) => {
    dynLocal(path, v);
    send(`dyn|${path}|${Object.keys(v).join()}`, () => call('posing.dyn', { id, path, ...v }));
  };
  const words = q.trim().toLowerCase();
  const nice = (d: DynRow) => d.label || boneLabel(d.name);
  const list = p.dyn.filter((d) => !words || `${nice(d)} ${d.name}`.toLowerCase().includes(words));
  const kindOf = (d: DynRow) => (/hair/i.test(d.name) ? 'Hair' : /_sk_|skirt/i.test(d.name) ? 'Skirt' : /acs|acce/i.test(d.path) ? 'Accessories' : 'Other');
  const kinds = ['Hair', 'Skirt', 'Accessories', 'Other'].map((k) => ({ k, rows: list.filter((d) => kindOf(d) === k) })).filter((g) => g.rows.length);
  const cur = p.dyn.find((d) => d.path === open) ?? list[0] ?? null;
  return (
    <Section title="Physics" help="Bust and buttock softness (gravity and force), and the swaying parts — hair, skirt, accessories — each with its own stiffness and weight. Through KKPE; saved with the character; keyable with + Track › KKPE.">
      {p.bust.length > 0 && (
        <div className="posing-groups">
          {p.bust.map((b) => (
            <section key={b.id} className="posing-card">
              <header>
                <b>{b.label}</b>
                <span className="spacer" />
                <button className="btn icon" disabled={!b.edited} title="Back to the game's values" onClick={() => bust(b.id, { reset: true })}>
                  <Icon name="undo" size={12} />
                </button>
              </header>
              <SwitchCard on={b.enabled} label="Moves (physics on)" onChange={(v) => bust(b.id, { enabled: v })} />
              <div className="posing-row stacked">
                <span className="posing-row-label">Gravity</span>
                <Xyz v={b.gravity} step={0.0005} onChange={(v) => bust(b.id, { gravity: v })} />
              </div>
              <div className="posing-row stacked">
                <span className="posing-row-label">Force</span>
                <Xyz v={b.force} step={0.0005} onChange={(v) => bust(b.id, { force: v })} />
              </div>
            </section>
          ))}
        </div>
      )}
      {p.dyn.length > 0 && (
        <div className="posing-dyn2">
          <div className="posing-dyn-list">
            <div className="body-bar">
              <input className="input search" placeholder={`Find a swaying part (${p.dyn.length}: hair, skirt…)`} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {kinds.map((g) => (
              <div key={g.k}>
                <div className="body-subhead">
                  {g.k} <small>{g.rows.length}</small>
                </div>
                {g.rows.map((d) => (
                  <div key={d.path} className={`posing-dyn-item ${cur?.path === d.path ? 'on' : ''}`}>
                    <button className={`switch ${d.enabled ? 'on' : ''}`} aria-pressed={d.enabled} title={d.enabled ? 'Physics on' : 'Physics off'} onClick={() => dyn(d.path, { enabled: !d.enabled })}>
                      <span />
                    </button>
                    <button className="posing-dyn-pick" aria-pressed={cur?.path === d.path} title={`${d.name}\n${d.path}`} onClick={() => setOpen(d.path)}>
                      <span className="posing-dyn-name">{nice(d)}</span>
                      <small className={d.edited ? 'changed' : ''}>
                        weight {d.weight.toFixed(2)} · stiffness {d.stiffness.toFixed(2)}
                      </small>
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {cur && (
            <div className="posing-card posing-dyn-editor">
              <header>
                <b>{nice(cur)}</b>
                <span className="spacer" />
                <button className="btn small solid" disabled={!cur.edited} onClick={() => call('posing.dyn', { id, path: cur.path, reset: true }).then(reload)}>
                  Reset
                </button>
              </header>
              <small className="posing-dyn-raw">{cur.name}</small>
              <SwitchCard on={cur.enabled} label="Sways (physics on)" onChange={(v) => dyn(cur.path, { enabled: v })} />
              {(['weight', 'stiffness'] as const).map((k) => (
                <div key={k} className="posing-row">
                  <span className="posing-row-label">{k === 'weight' ? 'Weight' : 'Stiffness'}</span>
                  <div className="posing-row-controls">
                    <Slider value={cur[k]} min={0} max={1} step={0.01} onChange={(v) => dyn(cur.path, { [k]: v })} />
                  </div>
                </div>
              ))}
              <details className="face-more">
                <summary>Bounce, drag, size, gravity and force</summary>
                {(['elasticity', 'damping', 'inertia', 'radius'] as const).map((k) => (
                  <div key={k} className="posing-row">
                    <span className="posing-row-label">{{ elasticity: 'Bounce', damping: 'Drag', inertia: 'Inertia', radius: 'Size' }[k]}</span>
                    <div className="posing-row-controls">
                      <Slider value={cur[k]} min={0} max={1} step={0.01} onChange={(v) => dyn(cur.path, { [k]: v })} />
                    </div>
                  </div>
                ))}
                <div className="posing-row stacked">
                  <span className="posing-row-label">Gravity</span>
                  <Xyz v={cur.gravity} step={0.001} onChange={(v) => dyn(cur.path, { gravity: v })} />
                </div>
                <div className="posing-row stacked">
                  <span className="posing-row-label">Force</span>
                  <Xyz v={cur.force} step={0.001} onChange={(v) => dyn(cur.path, { force: v })} />
                </div>
              </details>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ every bone by number

interface BoneRow {
  name: string;
  label: string | null;
  depth: number;
  edited: boolean;
  fk: boolean;
}
interface BoneVals {
  name: string;
  pos: [number, number, number];
  rot: [number, number, number];
  scale: [number, number, number];
  edited: boolean;
}

function BonesSection({ id }: { id: number }) {
  const [bones, setBones] = useState<BoneRow[] | null>(null);
  const [q, setQ] = useState('');
  const [editedOnly, setEditedOnly] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [vals, setVals] = useState<BoneVals | null>(null);
  const [mirror, setMirror] = useState(false);
  const loadList = useCallback(() => call<BoneRow[]>('posing.bones', { id }).then((r) => r && setBones(r)), [id]);
  const loadBone = useCallback((name: string) => call<{ bones: BoneVals[] }>('face.get', { id, bones: [name] }).then((r) => setVals(r?.bones[0] ?? null)), [id]);
  useEffect(() => {
    loadList();
  }, [loadList]);
  useEffect(() => {
    if (sel) loadBone(sel);
  }, [sel, loadBone]);
  useEffect(() => {
    const h = () => {
      loadList();
      if (sel) loadBone(sel);
    };
    window.addEventListener('kf:history', h);
    return () => window.removeEventListener('kf:history', h);
  }, [loadList, loadBone, sel]);

  const words = q.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!bones) return [];
    return bones.filter((b) => (!editedOnly || b.edited) && (!words || b.name.toLowerCase().includes(words) || (b.label || boneLabel(b.name)).toLowerCase().includes(words)));
  }, [bones, words, editedOnly]);
  const LIMIT = 200;
  const set = (ch: 'pos' | 'rot' | 'scale', v: [number, number, number]) => {
    if (!sel) return;
    setVals((s) => (s ? { ...s, [ch]: v, edited: true } : s));
    call<BoneVals>('face.set', { id, bone: sel, [ch]: v, mirror }).then((r) => {
      if (r) setBones((list) => list?.map((b) => (b.name === sel ? { ...b, edited: true } : b)) ?? list);
    });
  };
  const selRow = bones?.find((b) => b.name === sel);

  return (
    <Section
      title="Every bone"
      help="Any bone of the character by number — fingers, spine pieces, hair roots, accessories' bones — as an offset on top of the pose (KKPE's bone editor). Saved with the character. A bone posed by FK takes its turn from its FK joint: turn it with the rings in Studio's view."
    >
      <div className="body-bar">
        <input className="input search" placeholder={bones ? `Find a bone (${bones.length})…` : 'Loading bones…'} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={`btn chip ${editedOnly ? 'on' : ''}`} aria-pressed={editedOnly} onClick={() => setEditedOnly(!editedOnly)}>
          Changed only
        </button>
      </div>
      <div className="posing-bones">
        <div className="posing-bone-list" role="listbox" aria-label="Bones">
          {shown.slice(0, LIMIT).map((b) => (
            <button key={b.name} role="option" aria-selected={sel === b.name} className={`posing-bone ${sel === b.name ? 'on' : ''}`} style={{ paddingLeft: 8 + Math.min(b.depth, 14) * (words ? 0 : 8) }} onClick={() => setSel(b.name)}>
              <span>{b.label || boneLabel(b.name)}</span>
              <small>{b.name}</small>
              {b.fk && <span className="posing-tag">FK</span>}
              {b.edited && <span className="body-dot" />}
            </button>
          ))}
          {shown.length > LIMIT && <div className="pn-note">{shown.length - LIMIT} more — narrow the search.</div>}
          {bones && !shown.length && <div className="pn-note">No bone matches.</div>}
        </div>
        <div className="posing-bone-edit">
          {!sel || !vals ? (
            <EmptyState title="Pick a bone">Its position, turn and size, as offsets on the pose.</EmptyState>
          ) : (
            <>
              <div className="posing-bone-title">
                <b>{selRow?.label || boneLabel(sel)}</b>
                <small>{sel}</small>
              </div>
              <div className="body-edit">
                <Vec label="Move" v={vals.pos} step={0.001} onChange={(v) => set('pos', v)} />
                {selRow?.fk ? <div className="pn-note">Turned by its FK joint — use the rings in Studio's view.</div> : <Vec label="Turn" v={vals.rot} step={0.5} onChange={(v) => set('rot', v)} />}
                <Vec label="Size" v={vals.scale} step={0.01} onChange={(v) => set('scale', v)} />
                <div className="body-edit-last">
                  {/_[LR]$/.test(sel) && <SwitchCard on={mirror} label="Both sides" onChange={setMirror} />}
                  <span className="spacer" />
                  <button
                    className="btn small solid"
                    disabled={!vals.edited}
                    onClick={() =>
                      call('face.reset', { id, bones: [sel], mirror }).then(() => {
                        loadBone(sel);
                        loadList();
                      })
                    }
                  >
                    Reset
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Section>
  );
}

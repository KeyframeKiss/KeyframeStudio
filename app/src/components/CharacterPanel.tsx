import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pressable } from '../lib/pressable';
import { bridge } from '../bridge/client';
import { displayName, selectedCharacters, showTab, toast, useStore } from '../state/store';
import { Icon } from './Icon';
import { AnimationBrowser } from './AnimationBrowser';
import { applyAnimation } from '../lib/animation';

type Named = { name: string; nameEn?: string };
export interface CharaState {
  id: number;
  name: string;
  sex: number;
  coordinate: number;
  coordinates: string[];
  clothes: (Named & { slot: number; label: string; state: number; present: boolean })[];
  shoesType: number;
  accessories: (Named & { slot: number; parent: string; visible: boolean })[];
  face: {
    eyebrowPtn: number;
    eyebrowCount: number;
    eyesPtn: number;
    eyesOptions: Named[];
    mouthPtn: number;
    mouthCount: number;
    eyesOpen: number;
    mouthOpen: number;
    blink: boolean;
    lipSync: boolean;
    eyesLook: number;
    eyesLookOptions: string[];
    neckLook: number;
    neckLookOptions: string[];
    tears: number;
    blush: number;
    nipples: number;
  };
  hands: { ptn: number; options: (Named & { no: number })[] }[];
  anime: Named & { group: number; category: number; no: number; speed: number; option1: number; option2: number };
  kinematics: { fk: boolean; ik: boolean; fkParts: { name: string; on: boolean }[]; ikParts: { name: string; on: boolean }[] };
  abmx: boolean;
}

const CLOTH_STATES = ['On', 'Shift', 'Shift 2', 'Off'];

export type CharaSection = 'anim' | 'pose' | 'face' | 'outfit' | 'abmx';

/**
 * The selected character's animation, posing (with hands), expression, clothes and body sliders. `sections`
 * picks which (Pose's side panel: animation, posing, body; Pose › Outfit: clothes). `bare`: the name row is
 * shown by the panel around it.
 */
export function CharacterPanel({ bare, sections = ['anim', 'pose', 'face', 'outfit', 'abmx'] }: { bare?: boolean; sections?: CharaSection[] } = {}) {
  const has = (x: CharaSection) => sections.includes(x);
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  useStore((s) => s.showEnglish);
  const chars = useMemo(() => selectedCharacters(), [selection, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const primary = chars[0];
  const [state, setState] = useState<CharaState | null>(null);
  const [browse, setBrowse] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const d = { anim: true, face: false, outfit: true, pose: true, abmx: false };
    try {
      return { ...d, ...JSON.parse(localStorage.getItem('kf.charSections') ?? '{}') };
    } catch {
      return d;
    }
  });

  const retry = useRef(0);
  const want = useRef<number | undefined>(primary);
  want.current = primary;
  const refresh = useCallback(() => {
    window.clearTimeout(retry.current);
    if (primary == null) return setState(null);
    const id = primary;
    bridge
      .request<CharaState>('chara.get', { id })
      .then((s) => {
        if (want.current !== id) return; // selection changed meanwhile: a late reply must not win
        return s ? setState(s) : Promise.reject(new Error('empty'));
      })
      .catch(() => {
        // Studio may be busy (scene loading, ghost rebuild) or the socket reconnecting: keep the
        // last good state and try again shortly instead of showing "No character selected".
        retry.current = window.setTimeout(refresh, 1000);
      });
  }, [primary]);
  useEffect(() => () => window.clearTimeout(retry.current), []);

  const revision = useStore((s) => s.revision);
  const connected = useStore((s) => s.status === 'open');
  useEffect(refresh, [refresh, revision, connected]);

  // Coalesce rapid slider changes: send at most once per frame, refresh state afterwards.
  const pending = useRef<Record<string, unknown>>({});
  const raf = useRef(0);
  const refreshTimer = useRef(0);
  const apply = (patch: Record<string, unknown>, optimistic?: (s: CharaState) => CharaState) => {
    if (!chars.length) return;
    if (optimistic && state) setState(optimistic(state));
    Object.assign(pending.current, patch);
    if (raf.current) return;
    raf.current = requestAnimationFrame(async () => {
      raf.current = 0;
      const p = pending.current;
      pending.current = {};
      try {
        await bridge.request('chara.set', { ids: chars, ...p });
      } catch (e) {
        toast((e as Error).message, 'error');
      }
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(refresh, 250);
    });
  };

  if (primary == null) {
    return (
      <div className="panel-body">
        <div className="empty">
          <strong>No character selected</strong>
          Select a character in the Scene list or in Studio. With several characters selected, changes apply to all of them.
        </div>
      </div>
    );
  }
  // Never show (or edit with) the previous character's values under the new character's name.
  if (!state || state.id !== primary) {
    return (
      <div className="panel-body">
        <div className="empty">
          <strong>Loading character…</strong>
        </div>
      </div>
    );
  }

  const f = state.face;
  const tog = (id: string) =>
    setOpen((o) => {
      const n = { ...o, [id]: !o[id] };
      try {
        localStorage.setItem('kf.charSections', JSON.stringify(n));
      } catch {
        /* storage unavailable */
      }
      return n;
    });

  return (
    <div className="panel-body">
      {!bare && (
        <div className="section" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`type-icon type-Char`}>{state.sex === 0 ? '♂' : '♀'}</span>
          <b style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(nodes[primary] ?? { name: state.name })}</b>
          {chars.length > 1 && <span className="kbd">+{chars.length - 1} more</span>}
        </div>
      )}

      {has('anim') && (
      <CollapsibleSection open={!!open.anim} onToggle={() => tog('anim')} title="Animation">
        <div className="kv">
          <label>Clip</label>
          <button className="btn solid" style={{ justifyContent: 'flex-start', overflow: 'hidden' }} onClick={() => setBrowse(true)} title="Browse all animations">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName(state.anime) || 'None'}</span>
          </button>
          <label>Speed</label>
          <Slider value={state.anime.speed} min={0} max={3} step={0.01} onChange={(v) => apply({ animeSpeed: v }, (s) => ({ ...s, anime: { ...s.anime, speed: v } }))} />
          <label>Option 1</label>
          <Slider value={state.anime.option1} min={0} max={1} step={0.01} onChange={(v) => apply({ option1: v }, (s) => ({ ...s, anime: { ...s.anime, option1: v } }))} />
          <label>Option 2</label>
          <Slider value={state.anime.option2} min={0} max={1} step={0.01} onChange={(v) => apply({ option2: v }, (s) => ({ ...s, anime: { ...s.anime, option2: v } }))} />
        </div>
        <button className="btn solid" style={{ marginTop: 8, width: '100%' }} onClick={() => apply({ restartAnime: true })}>
          Restart animation
        </button>
      </CollapsibleSection>
      )}

      {has('pose') && (
      <CollapsibleSection
        open={!!open.pose}
        onToggle={() => tog('pose')}
        title="Posing & hands"
        extra={
          <button className="btn" style={{ height: 20, fontSize: 10 }} title="How each part is posed, target strength, joint correction, copy a side, physics, every bone: Character › Posing" onClick={() => showTab('pose', 'posing')}>
            Posing ›
          </button>
        }
      >
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <Toggle label="FK" on={state.kinematics.fk} onChange={(v) => apply({ fk: v })} />
          <Toggle label="IK" on={state.kinematics.ik} onChange={(v) => apply({ ik: v })} />
        </div>
        {state.kinematics.fk && (
          <Chips label="FK parts" items={state.kinematics.fkParts} onToggle={(i, on) => apply({ fkPart: { index: i, on } })} />
        )}
        {state.kinematics.ik && (
          <Chips label="IK parts" items={state.kinematics.ikParts} onToggle={(i, on) => apply({ ikPart: { index: i, on } })} />
        )}
        <div className="kv" style={{ marginTop: 10 }}>
          <label>Left hand</label>
          <Picker value={state.hands[0].ptn} options={state.hands[0].options.map((o) => displayName(o) || `#${o.no}`)} values={state.hands[0].options.map((o) => o.no)} onChange={(v) => apply({ handLeft: v })} />
          <label>Right hand</label>
          <Picker value={state.hands[1].ptn} options={state.hands[1].options.map((o) => displayName(o) || `#${o.no}`)} values={state.hands[1].options.map((o) => o.no)} onChange={(v) => apply({ handRight: v })} />
        </div>
      </CollapsibleSection>
      )}

      {has('face') && (
      <CollapsibleSection
        open={!!open.face}
        onToggle={() => tog('face')}
        title="Expression"
        extra={
          <button className="btn" style={{ height: 20, fontSize: 10 }} title="Every face part and shape: Character › Face shape" onClick={() => showTab('pose', 'face')}>
            Face shape ›
          </button>
        }
      >
        <div className="kv">
          <label>Eyebrows</label>
          <Stepper value={f.eyebrowPtn} count={f.eyebrowCount} onChange={(v) => apply({ eyebrowPtn: v }, (s) => ({ ...s, face: { ...s.face, eyebrowPtn: v } }))} />
          <label>Eyes</label>
          <Picker value={f.eyesPtn} options={f.eyesOptions.map((o, i) => displayName(o) || `#${i}`)} onChange={(v) => apply({ eyesPtn: v }, (s) => ({ ...s, face: { ...s.face, eyesPtn: v } }))} />
          <label>Mouth</label>
          <Stepper value={f.mouthPtn} count={f.mouthCount} onChange={(v) => apply({ mouthPtn: v }, (s) => ({ ...s, face: { ...s.face, mouthPtn: v } }))} />
          <label>Eyes open</label>
          <Slider value={f.eyesOpen} min={0} max={1} step={0.01} onChange={(v) => apply({ eyesOpen: v }, (s) => ({ ...s, face: { ...s.face, eyesOpen: v } }))} />
          <label>Mouth open</label>
          <Slider value={f.mouthOpen} min={0} max={1} step={0.01} onChange={(v) => apply({ mouthOpen: v }, (s) => ({ ...s, face: { ...s.face, mouthOpen: v } }))} />
          <label>Blush</label>
          <Slider value={f.blush} min={0} max={1} step={0.01} onChange={(v) => apply({ blush: v }, (s) => ({ ...s, face: { ...s.face, blush: v } }))} />
          <label>Tears</label>
          <Seg value={f.tears} options={['0', '1', '2', '3']} onChange={(v) => apply({ tears: v }, (s) => ({ ...s, face: { ...s.face, tears: v } }))} />
          <label>Eyes look</label>
          <Picker value={f.eyesLook} options={f.eyesLookOptions} onChange={(v) => apply({ eyesLook: v }, (s) => ({ ...s, face: { ...s.face, eyesLook: v } }))} />
          <label>Neck look</label>
          <Picker value={f.neckLook} options={f.neckLookOptions} onChange={(v) => apply({ neckLook: v }, (s) => ({ ...s, face: { ...s.face, neckLook: v } }))} />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <Toggle label="Blink" on={f.blink} onChange={(v) => apply({ blink: v }, (s) => ({ ...s, face: { ...s.face, blink: v } }))} />
          <Toggle label="Lip sync" on={f.lipSync} onChange={(v) => apply({ lipSync: v }, (s) => ({ ...s, face: { ...s.face, lipSync: v } }))} />
        </div>
      </CollapsibleSection>
      )}

      {has('outfit') && (
      <CollapsibleSection open={!!open.outfit} onToggle={() => tog('outfit')}
        title="Clothes"
        extra={
          <span style={{ display: 'flex', gap: 2 }}>
            <button className="btn" style={{ height: 20, fontSize: 10 }} onClick={() => apply({ clothesAll: 0 })}>
              All on
            </button>
            <button className="btn" style={{ height: 20, fontSize: 10 }} onClick={() => apply({ clothesAll: 3 })}>
              All off
            </button>
          </span>
        }
      >
        <div className="kv">
          <label>Outfit</label>
          <Picker value={state.coordinate} options={state.coordinates} onChange={(v) => apply({ coordinate: v })} />
          <label>Shoes</label>
          <Seg value={state.shoesType} options={['Indoor', 'Outdoor']} onChange={(v) => apply({ shoesType: v })} />
          <label>Nipples</label>
          <Slider value={f.nipples} min={0} max={1} step={0.01} onChange={(v) => apply({ nipples: v }, (s) => ({ ...s, face: { ...s.face, nipples: v } }))} />
        </div>
        <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
          {state.clothes
            .filter((c) => c.present)
            .map((c) => (
              <div key={c.slot} style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 6 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${c.label}: ${c.name}`}>
                  <span style={{ color: 'var(--text-3)' }}>{c.label}</span> {displayName(c)}
                </span>
                <Seg
                  value={c.state}
                  options={CLOTH_STATES}
                  small
                  onChange={(v) => apply({ clothes: { slot: c.slot, state: v } }, (s) => ({ ...s, clothes: s.clothes.map((x) => (x.slot === c.slot ? { ...x, state: v } : x)) }))}
                />
              </div>
            ))}
        </div>
      </CollapsibleSection>
      )}

      {has('abmx') && state.abmx && (
        <div className="cp-link-row">
          <span>Body sliders</span>
          <button className="btn solid" style={{ height: 22, fontSize: 11 }} title="Size, length and shape of each body part (ABMX): Character › Body" onClick={() => showTab('pose', 'body')}>
            Body ›
          </button>
        </div>
      )}

      {browse && (
        <AnimationBrowser
          current={state.anime}
          onClose={() => setBrowse(false)}
          onPick={async (g, c, n) => {
            if (await applyAnimation(chars, g, c, n)) refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------- small controls ----------------

export function CollapsibleSection({ title, children, extra, open, onToggle }: { title: string; children: React.ReactNode; extra?: React.ReactNode; open: boolean; onToggle: () => void }) {
  return (
    <div className="section">
      <h3 {...pressable} aria-expanded={open} style={{ cursor: 'pointer' }} onClick={onToggle}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} /> {title}
        <span className="spacer" />
        <span onClick={(e) => e.stopPropagation()}>{extra}</span>
      </h3>
      {open && children}
    </div>
  );
}

export function Slider({ value, min, max, step, onChange }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1, accentColor: 'var(--accent)' }} />
      <span className="value" style={{ minWidth: 38, flex: 'none', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11 }}>
        {value.toFixed(2)}
      </span>
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`btn solid ${on ? 'on' : ''}`} style={{ flex: 1 }} onClick={() => onChange(!on)}>
      <Icon name={on ? 'check' : 'plus'} size={12} /> {label}
    </button>
  );
}

function Chips({ label, items, onToggle }: { label: string; items: { name: string; on: boolean }[]; onToggle: (i: number, on: boolean) => void }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div className="hint" style={{ marginTop: 0, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {items.map((it, i) => (
          <button key={i} className={`btn solid ${it.on ? 'on' : ''}`} style={{ height: 22, fontSize: 11 }} onClick={() => onToggle(i, !it.on)}>
            {it.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function Seg({ value, options, onChange, small }: { value: number; options: string[]; onChange: (v: number) => void; small?: boolean }) {
  return (
    <div className="seg" style={small ? { padding: 1 } : undefined}>
      {options.map((o, i) => (
        <button key={i} className={value === i ? 'on' : ''} style={small ? { padding: '1px 6px', fontSize: 10 } : undefined} onClick={() => onChange(i)}>
          {o}
        </button>
      ))}
    </div>
  );
}

function Stepper({ value, count, onChange }: { value: number; count: number; onChange: (v: number) => void }) {
  const wrap = (v: number) => ((v % count) + count) % count;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <button className="btn solid icon" onClick={() => onChange(wrap(value - 1))}>
        ‹
      </button>
      <input
        className="input mono"
        style={{ width: 52, textAlign: 'center' }}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= 0 && n < count) onChange(n);
        }}
      />
      <button className="btn solid icon" onClick={() => onChange(wrap(value + 1))}>
        ›
      </button>
      <span className="hint" style={{ margin: 0 }}>
        / {count}
      </span>
    </div>
  );
}

export function Picker({ value, options, values, onChange }: { value: number; options: string[]; values?: number[]; onChange: (v: number) => void }) {
  const vals = values ?? options.map((_, i) => i);
  return (
    <select className="input" value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%' }}>
      {options.map((o, i) => (
        <option key={vals[i]} value={vals[i]}>
          {o}
        </option>
      ))}
    </select>
  );
}

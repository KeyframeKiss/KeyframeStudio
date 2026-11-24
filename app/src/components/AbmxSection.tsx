import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { toast } from '../state/store';
import { Help } from './Help';
import { Icon } from './Icon';
import { EmptyState } from './EditorBits';
import { REGIONS, boneBase, boneKind, boneLabel, boneRegion, boneSide } from '../lib/boneNames';

import { pressable } from '../lib/pressable';
interface Mod {
  bone: string;
  location: number;
  perCoordinate: boolean;
  scale: [number, number, number];
  length: number;
  position: [number, number, number];
  rotation: [number, number, number];
}

/** One character's ABMX modifiers: loaded, edited live (batched per frame), added and reset. */
function useAbmx(id: number) {
  const [mods, setMods] = useState<Mod[]>([]);
  const [bones, setBones] = useState<string[]>([]);

  const want = useRef(id);
  want.current = id;
  const load = useCallback(
    (all = false) =>
      bridge
        .request<{ modifiers: Mod[]; bones?: string[] }>('abmx.get', { id, all })
        .then((r) => {
          if (want.current !== id) return; // character changed meanwhile
          setMods(r.modifiers);
          if (r.bones) setBones(r.bones);
        })
        .catch((e) => toast((e as Error).message, 'error')),
    [id],
  );
  useEffect(() => {
    load(true);
  }, [load]);

  // Per-bone pending patches, flushed once per frame: live while dragging, and editing a second
  // bone right after the first never drops the first one's change.
  const pending = useRef(new Map<string, { bone: string; location: number; patch: Partial<Mod> }>());
  const raf = useRef(0);
  const send = (m: Mod, patch: Partial<Mod>) => {
    setMods((list) => list.map((x) => (x.bone === m.bone && x.location === m.location ? { ...x, ...patch } : x)));
    const key = `${m.bone}|${m.location}`;
    const cur = pending.current.get(key);
    pending.current.set(key, { bone: m.bone, location: m.location, patch: { ...(cur?.patch ?? {}), ...patch } });
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const batch = [...pending.current.values()];
      pending.current.clear();
      for (const b of batch)
        bridge.request('abmx.set', { id, bone: b.bone, location: b.location, ...b.patch }).catch((e) => toast((e as Error).message, 'error'));
    });
  };
  const add = async (bone: string) => {
    await bridge.request('abmx.set', { id, bone, location: 1, scale: [1, 1, 1] }).catch((e) => toast((e as Error).message, 'error'));
    await load();
  };
  const reset = async (m: Mod) => {
    await bridge.request('abmx.set', { id, bone: m.bone, location: m.location, reset: true }).catch((e) => toast((e as Error).message, 'error'));
    await load();
  };
  return { mods, bones, send, add, reset };
}

/** Edit ABMX bone modifiers of one character (compact list, for a side panel). */
export function AbmxSection({ id }: { id: number }) {
  const { mods, bones, send, add: addBone, reset } = useAbmx(id);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const add = async (bone: string) => {
    await addBone(bone);
    setOpen(`${bone}|1`);
    setQuery('');
  };

  const q = query.trim().toLowerCase();
  const suggestions = q ? bones.filter((b) => b.toLowerCase().includes(q) && !mods.some((m) => m.bone === b)).slice(0, 12) : [];

  return (
    <div>
      <input className="input search" placeholder="Add bone (e.g. cf_j_arm00_L)…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {suggestions.length > 0 && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 6, marginTop: 4, maxHeight: 180, overflow: 'auto' }}>
          {suggestions.map((b) => (
            <div {...pressable} key={b} className="model-row" onClick={() => add(b)}>
              <span className="plus">+</span>
              <span className="name">{b}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        {mods.map((m) => {
          const key = `${m.bone}|${m.location}`;
          const isOpen = open === key;
          return (
            <div key={key} style={{ borderBottom: '1px solid var(--line-soft)' }}>
              <div {...pressable} className="tree-row" style={{ paddingLeft: 0 }} onClick={() => setOpen(isOpen ? null : key)}>
                <span className="chev">{isOpen ? '▾' : '▸'}</span>
                <span className="name" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                  {m.bone}
                </span>
                {m.location > 1 && <span className="sub">acc {m.location - 2}</span>}
              </div>
              {isOpen && (
                <div style={{ padding: '4px 0 10px 20px', display: 'grid', gap: 6 }}>
                  <Vec label="Scale" v={m.scale} step={0.01} onChange={(v) => send(m, { scale: v })} />
                  <Vec label="Position" v={m.position} step={0.001} onChange={(v) => send(m, { position: v })} />
                  <Vec label="Rotation" v={m.rotation} step={0.5} onChange={(v) => send(m, { rotation: v })} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 54, color: 'var(--text-2)' }}>Length</span>
                    <Num v={m.length} step={0.01} onChange={(v) => send(m, { length: v })} />
                    <span className="spacer" style={{ flex: 1 }} />
                    <button
                      className="btn solid"
                      style={{ height: 22, fontSize: 11 }}
                      onClick={() => reset(m)}
                    >
                      Reset
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!mods.length && <div className="hint">No bone modifiers yet. Search a bone above to add one.</div>}
      </div>
    </div>
  );
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
const changed = (m: Mod) => !near(m.length, 1) || m.scale.some((v) => !near(v, 1)) || m.position.some((v) => !near(v, 0)) || m.rotation.some((v) => !near(v, 0));

/**
 * Character › Body: the character's body sliders (ABMX) grouped by body region, with readable names (the bone's own
 * name underneath). Search filters the list and offers bones to add; a row opens to its scale, position, rotation
 * and length (drag to scrub, click to type).
 */
/** One row per body part: left and right together; a joint and a shape bone of the same name told apart. */
function pairUp(list: Mod[]) {
  const rows = new Map<string, { key: string; label: string; location: number; mods: Mod[] }>();
  const bases = new Map<string, Set<string>>();
  for (const m of list) {
    const base = boneBase(m.bone);
    const kinds = bases.get(base) ?? new Set<string>();
    kinds.add(boneKind(m.bone));
    bases.set(base, kinds);
  }
  for (const m of list) {
    const base = boneBase(m.bone);
    const kind = boneKind(m.bone);
    const label = (bases.get(base)?.size ?? 0) > 1 && kind ? `${base} · ${kind}` : base;
    const key = `${label}|${m.location}|${m.bone.replace(/_[LR]$/, '')}`;
    const row = rows.get(key) ?? { key, label, location: m.location, mods: [] };
    row.mods.push(m);
    rows.set(key, row);
  }
  for (const r of rows.values()) r.mods.sort((a, b) => boneSide(a.bone).localeCompare(boneSide(b.bone)));
  // still two rows with one name ("Lower face" from …FaceLow_sx and …FaceLow_tz): add the bone's own tag
  const seen = new Map<string, number>();
  for (const r of rows.values()) seen.set(r.label, (seen.get(r.label) ?? 0) + 1);
  for (const r of rows.values()) {
    if ((seen.get(r.label) ?? 0) < 2) continue;
    const tag = r.mods[0].bone.replace(/_[LR]$/, '').split('_').pop() ?? '';
    if (tag && !r.label.toLowerCase().includes(tag.toLowerCase())) r.label += ` · ${tag}`;
  }
  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

export function BodySliders({ id }: { id: number }) {
  const { mods, bones, send, add, reset } = useAbmx(id);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const hit = (b: string) => b.toLowerCase().includes(q) || boneLabel(b).toLowerCase().includes(q);
  const shown = q ? mods.filter((m) => hit(m.bone)) : mods;
  const addable = q ? bones.filter((b) => hit(b) && !mods.some((m) => m.bone === b)).slice(0, 8) : [];
  const groups = REGIONS.map((r) => ({ region: r, rows: pairUp(shown.filter((m) => boneRegion(m.bone, m.location) === r)) })).filter((g) => g.rows.length);
  // a dot only says something when some sliders are still at no change
  const dots = mods.some((m) => !changed(m));

  return (
    <div className="body-page">
      <div className="body-bar">
        <input className="input search" placeholder="Find a body part or bone (bust, thigh, cf_j_arm00_L)…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="body-count">
          {mods.length} slider{mods.length === 1 ? '' : 's'}
          {q && ` · ${shown.length} shown`}
        </span>
        <Help text="ABMX body sliders: each bone's size, position, rotation and length, on top of the character card. Saved with the character in the scene. Search to find one; bones the character has no slider for yet can be added from the search." />
      </div>
      {addable.length > 0 && (
        <div className="body-add">
          <span className="body-add-label">Add</span>
          {addable.map((b) => (
            <button
              key={b}
              className="btn small solid"
              title={b}
              onClick={async () => {
                await add(b);
                setOpen(`${b}|1`);
              }}
            >
              <Icon name="plus" size={11} /> {boneLabel(b)}
            </button>
          ))}
        </div>
      )}
      {groups.length === 0 ? (
        <EmptyState title={q ? 'Nothing matches' : 'No body sliders yet'}>{q ? 'Try another word, or add the bone from the list above.' : 'Search a body part above to add a slider for it.'}</EmptyState>
      ) : (
        <div className="body-groups">
          {groups.map((g) => (
            <section key={g.region} className="body-group">
              <header>
                <b>{g.region}</b>
                <small>{g.rows.length}</small>
              </header>
              {g.rows.map((row) => {
                const isOpen = open === row.key;
                const sides = row.mods.length > 1;
                return (
                  <div key={row.key} className={`body-row ${isOpen ? 'open' : ''}`}>
                    <button className="body-row-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : row.key)}>
                      <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                      <span className="body-name">
                        <b>
                          {row.label}
                          {sides && <span className="body-sides">L · R</span>}
                        </b>
                        <small>
                          {row.mods.map((m) => m.bone).join(' · ')}
                          {row.location > 1 && ` · accessory ${row.location - 2}`}
                        </small>
                      </span>
                      {dots && row.mods.some(changed) && <span className="body-dot" title="Changed from the card's shape" />}
                    </button>
                    {isOpen &&
                      row.mods.map((m) => (
                        <div key={m.bone} className="body-edit">
                          {sides && <span className="body-edit-side">{boneSide(m.bone) === 'L' ? 'Left' : 'Right'}</span>}
                          <Vec label="Scale" v={m.scale} step={0.01} onChange={(v) => send(m, { scale: v })} />
                          <Vec label="Position" v={m.position} step={0.001} onChange={(v) => send(m, { position: v })} />
                          <Vec label="Rotation" v={m.rotation} step={0.5} onChange={(v) => send(m, { rotation: v })} />
                          <div className="body-edit-last">
                            <span className="body-edit-label">Length</span>
                            <Num v={m.length} step={0.01} onChange={(v) => send(m, { length: v })} />
                            <span className="spacer" />
                            <button className="btn small solid" onClick={() => reset(m)} title={`${m.bone} back to no change`}>
                              Reset
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export function Vec({ label, v, step, onChange }: { label: string; v: [number, number, number]; step: number; onChange: (v: [number, number, number]) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 54, color: 'var(--text-2)' }}>{label}</span>
      {[0, 1, 2].map((i) => (
        <Num
          key={i}
          v={v[i]}
          step={step}
          color={['var(--axis-x)', 'var(--axis-y)', 'var(--axis-z)'][i]}
          onChange={(n) => {
            const next = [...v] as [number, number, number];
            next[i] = n;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

/** Number field with drag-to-scrub on the label (hold Shift for fine). */
export function Num({ v, step, onChange, color }: { v: number; step: number; onChange: (n: number) => void; color?: string }) {
  const [text, setText] = useState<string | null>(null);
  const startDrag = (e: React.PointerEvent) => {
    if (text !== null) return;
    const x0 = e.clientX;
    const v0 = v;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 2) moved = true;
      if (moved) onChange(Math.round((v0 + dx * step * (ev.shiftKey ? 0.1 : 1)) / (step / 10)) * (step / 10));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) setText(String(v));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return text !== null ? (
    <input
      className="input mono"
      autoFocus
      style={{ width: 64, height: 22, padding: '0 4px' }}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = Number(text);
        if (Number.isFinite(n)) onChange(n);
        setText(null);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  ) : (
    <span
      onPointerDown={startDrag}
      title="Drag to change · click to type · Shift = fine"
      style={{ width: 64, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, background: 'var(--bg-2)', border: '1px solid var(--line)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'ew-resize', borderBottom: color ? `2px solid ${color}` : undefined }}
    >
      {v.toFixed(3)}
    </span>
  );
}

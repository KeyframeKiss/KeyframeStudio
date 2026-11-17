import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { toast } from '../state/store';

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

/** Edit ABMX bone modifiers of one character. */
export function AbmxSection({ id }: { id: number }) {
  const [mods, setMods] = useState<Mod[]>([]);
  const [bones, setBones] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);

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
                      onClick={async () => {
                        await bridge.request('abmx.set', { id, bone: m.bone, location: m.location, reset: true });
                        load();
                      }}
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

export function Vec({ label, v, step, onChange }: { label: string; v: [number, number, number]; step: number; onChange: (v: [number, number, number]) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 54, color: 'var(--text-2)' }}>{label}</span>
      {[0, 1, 2].map((i) => (
        <Num
          key={i}
          v={v[i]}
          step={step}
          color={['#ff6b6b', '#5ee08a', '#5aa9ff'][i]}
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

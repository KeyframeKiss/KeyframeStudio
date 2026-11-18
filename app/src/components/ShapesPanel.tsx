import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { toast, useStore } from '../state/store';

import { pressable } from '../lib/pressable';
/**
 * Face Studio › Shapes: KKPE blendshape weights of the head meshes (face, eyebrows, eyelines, teeth, eyes…).
 * These are the mesh shapes the expression system blends (smiles, eye shapes, mouth shapes); KKPE keeps an
 * edited weight on top of the expression, saved with the scene.
 */

interface Shape {
  i: number;
  name: string;
  weight: number;
  edited?: boolean;
  original?: number;
}
interface ShapeSet {
  key: string;
  name: string;
  label: string;
  shapes: Shape[];
}

// Koikatsu shape names are romanised Japanese: "kuti_face.f00_uresi_s_op" = mouth · happy, small, open.
const WORDS: Record<string, string> = {
  def: 'Default', egao: 'Smile', bisyou: 'Faint smile', uresi: 'Happy', doki: 'Excited', ikari: 'Angry', ikari02: 'Angry 2',
  sinken: 'Serious', sinken02: 'Serious 2', sinken03: 'Serious 3', kanasi: 'Sad', odoro: 'Surprised', nemui: 'Sleepy',
  kurusi: 'Pained', tere: 'Shy', aseri: 'Flustered', keno: 'Disgusted', kisu: 'Kiss', name: 'Licking', nameru: 'Licking',
  aegi: 'Panting', taegi: 'Gasping', kuwae: 'Mouth full', mogu: 'Chewing', sitadasi: 'Tongue out', huku: 'Puffed cheeks',
  winkL: 'Wink left', winkR: 'Wink right', wink: 'Wink', tozi: 'Closed', toji: 'Closed', hitomi: 'Pupil', gyu: 'Squeezed',
  op: 'open', cl: 'closed', s: 'small', ss: 'smaller', l: 'large', ll: 'larger', up: 'up', dw: 'down', L: 'left', R: 'right',
};
const pretty = (n: string) => {
  const rest = n.replace(/^[^.]*\./, '');
  // drop variant ids like f00 / y00 / mayu00 (but keep known words such as sinken02)
  const parts = rest.split('_').filter((t) => WORDS[t] !== undefined || !/^[a-z]{1,4}\d+$/i.test(t));
  const out = parts.map((t) => WORDS[t] ?? WORDS[t.toLowerCase()] ?? t);
  return out.length ? out[0] + (out.length > 1 ? ` · ${out.slice(1).join(' ')}` : '') : rest;
};
const groupOf = (n: string) => (n.includes('.') ? n.slice(0, n.indexOf('.')).replace(/_/g, ' ') : '');
/** Shapes in their groups (eyes, mouth…), keeping the original order. */const byGroup = <T extends { name: string }>(list: T[]): [string, T[]][] => {  const m = new Map<string, T[]>();  for (const x of list) {    const g = groupOf(x.name);    m.set(g, [...(m.get(g) ?? []), x]);  }  return [...m.entries()];};
const GROUP_NAMES: Record<string, string> = {
  'eye face': 'Eyes', 'kuti face': 'Mouth', 'kuti yaeba': 'Mouth (fangs)', 'kuti ha': 'Mouth (teeth)', 'kuti sita': 'Mouth (tongue)',
  mayuge: 'Brows', tooth: 'Teeth', 'eye line': 'Eyelines', 'eye siroL': 'Eye whites', 'eye siroR': 'Eye whites', 'eye naL': 'Eye highlights',
};
/** Friendlier mesh names and the order they're listed in (face first). */
const MESHES: Record<string, [string, number]> = {
  cf_O_face: ['Face', 0], cf_O_mayuge: ['Eyebrows', 1], cf_O_eyeline: ['Eyelines', 2], cf_O_eyeline_low: ['Lower eyelines', 3],
  cf_Ohitomi_L: ['Left eye', 4], cf_Ohitomi_R: ['Right eye', 5], cf_O_tooth: ['Teeth', 6], cf_O_canine: ['Fangs', 7], o_tang: ['Tongue', 8],
  cf_O_noseline: ['Nose line', 9],
};
const meshLabel = (s: ShapeSet) => MESHES[s.name]?.[0] ?? s.label;
const meshOrder = (s: ShapeSet) => MESHES[s.name]?.[1] ?? 50;

export function ShapesPanel({ id, onChanged }: { id: number; onChanged: () => void }) {
  const revision = useStore((s) => s.revision);
  const [sets, setSets] = useState<ShapeSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const lastEdit = useRef(-1e9);

  const load = useCallback(() => {
    bridge
      .request<ShapeSet[]>('face.shapes', { id })
      .then((r) => {
        if (performance.now() - lastEdit.current < 700) return;
        const sorted = [...r].sort((a, b) => meshOrder(a) - meshOrder(b));
        setSets(sorted);
        setError(null);
        setOpen((o) => (Object.keys(o).length ? o : sorted.length ? { [sorted[0].key]: true } : o));
      })
      .catch((e) => setError((e as Error).message));
  }, [id]);
  useEffect(load, [load, revision]);

  // one request per frame per shape while dragging
  const pending = useRef(new Map<string, { key: string; i: number; weight: number }>());
  const raf = useRef(0);
  const setWeight = (set: ShapeSet, sh: Shape, w: number) => {
    lastEdit.current = performance.now();
    setSets((ss) => ss && ss.map((x) => (x.key !== set.key ? x : { ...x, shapes: x.shapes.map((y) => (y.i === sh.i ? { ...y, weight: w, edited: true, original: y.original ?? y.weight } : y)) })));
    pending.current.set(`${set.key}|${sh.i}`, { key: set.key, i: sh.i, weight: w });
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const batch = [...pending.current.values()];
      pending.current.clear();
      Promise.all(batch.map((b) => bridge.request('face.setShape', { id, ...b }))).then(onChanged, (e) => toast((e as Error).message, 'error'));
    });
  };
  const reset = async (key?: string, i?: number) => {
    await bridge.request('face.resetShapes', { id, ...(key ? { key } : {}), ...(i != null ? { i } : {}) }).catch((e) => toast((e as Error).message, 'error'));
    lastEdit.current = -1e9;
    load();
    onChanged();
  };

  const q = query.trim().toLowerCase();
  const view = useMemo(
    () =>
      (sets ?? []).map((set) => ({
        ...set,
        shown: set.shapes.filter((sh) => (!onlyChanged || sh.edited) && (!q || sh.name.toLowerCase().includes(q) || pretty(sh.name).toLowerCase().includes(q))),
        changed: set.shapes.filter((sh) => sh.edited).length,
      })),
    [sets, q, onlyChanged],
  );
  const totalChanged = view.reduce((n, s) => n + s.changed, 0);

  if (error) return <div className="empty">{error}</div>;
  if (!sets) return <div className="empty">Loading shapes…</div>;

  return (
    <>
      <div className="face-options">
        <input className="input search" style={{ flex: 1 }} placeholder="Search shapes…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className={`btn ${onlyChanged ? 'on' : ''}`} onClick={() => setOnlyChanged(!onlyChanged)} title="Show only shapes you changed">
          Changed {totalChanged || ''}
        </button>
        <button className="btn" disabled={!totalChanged} onClick={() => reset()} title="Reset every changed shape">
          Reset all
        </button>
      </div>
      <div className="face-hint" style={{ margin: '0 0 4px' }}>
        Mesh shapes the expressions are made of. A changed value stays on top of the current expression and is saved with the scene (KKPE).
      </div>
      <div className="face-cards">
        {view.map((set) => {
          const isOpen = open[set.key] || !!q || onlyChanged;
          return (
            <div key={set.key} className={`face-card ${set.changed ? 'edited' : ''}`}>
              <div {...pressable} className="face-card-head" style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => ({ ...o, [set.key]: !o[set.key] }))}>
                <span className={`chev ${isOpen ? 'open' : ''}`} style={{ color: 'var(--text-3)' }}>
                  ▸
                </span>
                <strong>{meshLabel(set)}</strong>
                <span className="face-tag">
                  {set.shapes.length} shapes{set.changed ? ` · ${set.changed} changed` : ''}
                </span>
                <span style={{ flex: 1 }} />
                {set.changed > 0 && (
                  <button
                    className="btn icon"
                    title={`Reset ${meshLabel(set).toLowerCase()} shapes`}
                    onClick={(e) => {
                      e.stopPropagation();
                      reset(set.key);
                    }}
                  >
                    ↺
                  </button>
                )}
              </div>
              {isOpen &&
                byGroup(set.shown).map(([g, list]) => (
                  <div key={g}>
                    {g && <div className="shape-group">{GROUP_NAMES[g] ?? g}</div>}
                    <div className="shape-grid">
                      {list.map((sh) => (
                        <div key={sh.i} className={`shape-row face-axis ${sh.edited ? 'changed' : ''}`} title={sh.name}>
                          <span className="shape-name">{pretty(sh.name)}</span>
                          <input type="range" min={0} max={100} step={1} value={sh.weight} onChange={(e) => setWeight(set, sh, Number(e.target.value))} onDoubleClick={() => sh.edited && reset(set.key, sh.i)} />
                          <span className="mono shape-val">{Math.round(sh.weight)}</span>
                          <button className="btn icon" style={{ visibility: sh.edited ? 'visible' : 'hidden' }} title="Back to the expression's value" onClick={() => reset(set.key, sh.i)}>
                            ↺
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              {isOpen && !set.shown.length && <div className="face-hint">No shapes match.</div>}
            </div>
          );
        })}
      </div>
    </>
  );
}

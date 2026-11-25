import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { toast } from '../state/store';
import { Help } from './Help';
import { Icon } from './Icon';
import { EmptyState, SwitchCard } from './EditorBits';
import { DragNumber } from './DragNumber';
import { REGIONS, boneBase, boneKind, boneLabel, boneRegion, boneSide, type Region } from '../lib/boneNames';

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

  // Pending patches, flushed once per frame as one request: live while dragging, both sides of a part in one undo
  // step, and editing a second bone right after the first never drops the first one's change.
  const pending = useRef(new Map<string, { bone: string; location: number; patch: Partial<Mod> }>());
  const raf = useRef(0);
  const apply = (changes: { m: Mod; patch: Partial<Mod> }[]) => {
    setMods((list) =>
      list.map((x) => {
        const c = changes.find((c) => c.m.bone === x.bone && c.m.location === x.location);
        return c ? { ...x, ...c.patch } : x;
      }),
    );
    for (const { m, patch } of changes) {
      const key = `${m.bone}|${m.location}`;
      const cur = pending.current.get(key);
      pending.current.set(key, { bone: m.bone, location: m.location, patch: { ...(cur?.patch ?? {}), ...patch } });
    }
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const items = [...pending.current.values()].map((b) => ({ bone: b.bone, location: b.location, ...b.patch }));
      pending.current.clear();
      if (items.length) bridge.request('abmx.set', { id, items }).catch((e) => toast((e as Error).message, 'error'));
    });
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const add = async (bone: string) => {
    await bridge.request('abmx.set', { id, bone, location: 1, scale: [1, 1, 1] }).catch((e) => toast((e as Error).message, 'error'));
    await load();
  };
  /** Back to no change, all in one undo step. */
  const resetMany = async (list: Mod[]) => {
    if (!list.length) return;
    await bridge.request('abmx.set', { id, items: list.map((m) => ({ bone: m.bone, location: m.location, reset: true })) }).catch((e) => toast((e as Error).message, 'error'));
    await load();
  };
  return { mods, bones, apply, add, resetMany };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
const changed = (m: Mod) => !near(m.length, 1) || m.scale.some((v) => !near(v, 1)) || m.position.some((v) => !near(v, 0)) || m.rotation.some((v) => !near(v, 0));

/** One row per body part: left and right together; a joint and a shape bone of the same name told apart. */
function pairUp(list: Mod[]) {
  const rows = new Map<string, Row>();
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
    const row = rows.get(key) ?? { key, label, location: m.location, region: boneRegion(m.bone, m.location), mods: [] };
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

interface Row {
  key: string;
  label: string;
  location: number;
  region: Region;
  mods: Mod[];
}

/** The same change on the other side: positions flip across the body (X), turns flip around Y and Z. */
function mirrored(p: Partial<Mod>): Partial<Mod> {
  const o: Partial<Mod> = {};
  if (p.scale) o.scale = [...p.scale];
  if (p.length != null) o.length = p.length;
  if (p.position) o.position = [-p.position[0], p.position[1], p.position[2]];
  if (p.rotation) o.rotation = [p.rotation[0], -p.rotation[1], -p.rotation[2]];
  return o;
}
const whole = (m: Mod): Partial<Mod> => ({ scale: m.scale, length: m.length, position: m.position, rotation: m.rotation });
const sameMod = (a: Partial<Mod>, b: Partial<Mod>) =>
  near(a.length ?? 1, b.length ?? 1) && [0, 1, 2].every((i) => near(a.scale![i], b.scale![i]) && near(a.position![i], b.position![i]) && near(a.rotation![i], b.rotation![i]));

const mean = (v: number[]) => (v[0] + v[1] + v[2]) / 3;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** "×1.10", or "×0.60–1.02" when the three axes differ. */
function sizeText(m: Mod) {
  const lo = Math.min(...m.scale);
  const hi = Math.max(...m.scale);
  return hi - lo < 0.005 ? `×${m.scale[0].toFixed(2)}` : `×${lo.toFixed(2)}–${hi.toFixed(2)}`;
}
/** What else than size is changed, in words. */
function extras(m: Mod) {
  const out: string[] = [];
  if (m.position.some((v) => !near(v, 0))) out.push('moved');
  if (m.rotation.some((v) => !near(v, 0))) out.push('turned');
  if (!near(m.length, 1)) out.push(m.length > 1 ? 'longer' : 'shorter');
  return out;
}

const store = {
  get: (k: string, d: string) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* not saved; fine */
    }
  },
};

/** The regions a person can point at on the figure. */
const FIGURE: Region[] = ['Head & neck', 'Bust', 'Torso & hips', 'Arms & hands', 'Legs & feet'];

/** The character from the front; each region is a button. Their right is on your left. */
function RegionFigure({ region, counts, onPick }: { region: Region | null; counts: Map<Region, number>; onPick: (r: Region) => void }) {
  const cls = (r: Region) => `body-fig-part ${region === r ? 'on' : ''} ${counts.get(r) ? '' : 'none'}`;
  const props = (r: Region) => ({
    className: cls(r),
    role: 'button',
    tabIndex: 0,
    'aria-label': r,
    'aria-pressed': region === r,
    onClick: () => onPick(r),
    onKeyDown: (e: React.KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(r)),
  });
  return (
    <svg className="body-fig" viewBox="0 0 120 200" aria-label="Pick a body region">
      <g {...props('Head & neck')}>
        <title>Head & neck</title>
        <circle cx="60" cy="20" r="13" />
        <rect x="55" y="31" width="10" height="9" rx="3" />
      </g>
      <g {...props('Bust')}>
        <title>Bust</title>
        <rect x="44" y="41" width="32" height="27" rx="9" />
      </g>
      <g {...props('Torso & hips')}>
        <title>Torso & hips</title>
        <rect x="45" y="70" width="30" height="30" rx="8" />
      </g>
      <g {...props('Arms & hands')}>
        <title>Arms & hands</title>
        <rect x="24" y="42" width="14" height="62" rx="7" transform="rotate(10 31 42)" />
        <rect x="82" y="42" width="14" height="62" rx="7" transform="rotate(-10 89 42)" />
      </g>
      <g {...props('Legs & feet')}>
        <title>Legs & feet</title>
        <rect x="45" y="102" width="14" height="82" rx="7" />
        <rect x="61" y="102" width="14" height="82" rx="7" />
      </g>
      <text x="20" y="196" className="posing-figure-side">R</text>
      <text x="94" y="196" className="posing-figure-side">L</text>
    </svg>
  );
}

/**
 * Character › Body: the character's body sliders (ABMX). Left, where to look: a figure and the regions, with search
 * and "Changed only". Middle, the region's parts, one short line each with their size. Right, the picked part's
 * editor: one Size for the common case, the three axes and length under it, moving and turning folded away. Left and
 * right sides change together (mirrored) unless switched off. Every change is one undo step.
 */
export function BodySliders({ id }: { id: number }) {
  const { mods, bones, apply, add, resetMany } = useAbmx(id);
  const [query, setQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [region, setRegion] = useState<Region | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [both, setBothState] = useState(() => store.get('kf.body.both', '1') === '1');
  const [side, setSide] = useState<'L' | 'R'>('L');
  const [more, setMoreState] = useState(() => store.get('kf.body.more', '0') === '1');
  const setBoth = (v: boolean) => (setBothState(v), store.set('kf.body.both', v ? '1' : '0'));
  const setMore = (v: boolean) => (setMoreState(v), store.set('kf.body.more', v ? '1' : '0'));
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const hit = (b: string) => b.toLowerCase().includes(q) || boneLabel(b).toLowerCase().includes(q);
  const all = useMemo(() => pairUp(mods), [mods]);
  const filtered = all.filter((r) => (!changedOnly || r.mods.some(changed)) && (!q || r.mods.some((m) => hit(m.bone)) || r.label.toLowerCase().includes(q)));
  const counts = new Map<Region, number>();
  for (const r of filtered) counts.set(r.region, (counts.get(r.region) ?? 0) + 1);
  const regions = REGIONS.filter((r) => FIGURE.includes(r) || counts.get(r));
  // the region shown: the one picked, else the first with something in it
  const current: Region | null = q ? null : region && (counts.get(region) || FIGURE.includes(region)) ? region : (regions.find((r) => counts.get(r)) ?? null);
  // sub-headings where a list mixes things: regions in search results, one per accessory in Accessories
  const groupOf = (r: Row) => (q ? r.region : current === 'Accessories' ? `Accessory slot ${r.location - 1}` : '');
  const rows = (q ? filtered : filtered.filter((r) => r.region === current))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (q ? REGIONS.indexOf(a.r.region) - REGIONS.indexOf(b.r.region) : a.r.location - b.r.location) || a.i - b.i)
    .map((x) => x.r);
  const addable = q ? bones.filter((b) => hit(b) && !mods.some((m) => m.bone === b)).slice(0, 10) : [];
  const row = rows.find((r) => r.key === pick) ?? all.find((r) => r.key === pick) ?? rows[0] ?? null;

  useEffect(() => {
    if (row?.mods.length === 1) setSide(boneSide(row.mods[0].bone) === 'R' ? 'R' : 'L');
  }, [row?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickRegion = (r: Region) => {
    setRegion(r);
    setQuery('');
    setPick(null);
  };
  const moveInList = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = Math.max(0, rows.findIndex((r) => r.key === row?.key));
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    setPick(next.key);
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(next.key)}"]`)?.focus();
  };

  return (
    <div className="body-page">
      <div className="body-bar">
        <input className="input search" placeholder="Find a body part or bone (bust, thigh, cf_j_arm00_L)…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className={`btn chip ${changedOnly ? 'on' : ''}`} aria-pressed={changedOnly} onClick={() => setChangedOnly(!changedOnly)} title="Only parts changed from no change">
          Changed only
        </button>
        <span className="body-count">
          {all.length} part{all.length === 1 ? '' : 's'}
        </span>
        <Help text="ABMX body sliders: each body part's size, length, position and turn, on top of the character card. Saved with the character in the scene. Pick a region on the figure, then a part; left and right change together unless you switch that off. Parts without a slider yet can be added by searching. Every change is one undo step." />
      </div>

      <div className="body3">
        <nav className="body-nav" aria-label="Body regions">
          <RegionFigure region={current} counts={counts} onPick={pickRegion} />
          <div className="body-regions">
            {regions.map((r) => (
              <button key={r} className={`body-region ${current === r ? 'on' : ''}`} aria-current={current === r || undefined} onClick={() => pickRegion(r)}>
                <span>{r}</span>
                <small>{counts.get(r) ?? 0}</small>
              </button>
            ))}
          </div>
        </nav>

        <section className="body-list" aria-label="Parts">
          <header className="body-list-head">
            <b>{q ? `Matches for “${query.trim()}”` : (current ?? 'Body')}</b>
            <small>{rows.length}</small>
            <span className="spacer" />
            {!q && rows.some((r) => r.mods.some(changed)) && (
              <button
                className="btn small solid"
                title={`Every part of ${current} back to no change (one undo step)`}
                onClick={() => resetMany(rows.flatMap((r) => r.mods))}
              >
                Reset region
              </button>
            )}
          </header>
          {addable.length > 0 && (
            <div className="body-add">
              <span className="body-add-label">Add a slider</span>
              {addable.map((b) => (
                <button
                  key={b}
                  className="btn small solid"
                  title={b}
                  onClick={async () => {
                    await add(b);
                    setQuery('');
                    setRegion(boneRegion(b, 1));
                  }}
                >
                  <Icon name="plus" size={11} /> {boneLabel(b)}
                </button>
              ))}
            </div>
          )}
          {rows.length === 0 ? (
            <EmptyState title={q ? 'Nothing matches' : changedOnly ? 'Nothing changed here' : 'No sliders here yet'}>
              {q ? 'Try another word, or add a slider from the list above.' : changedOnly ? 'Switch off Changed only to see every part.' : 'Search a body part above to add a slider for it.'}
            </EmptyState>
          ) : (
            <div className="body-items" ref={listRef} onKeyDown={moveInList}>
              {rows.map((r, i) => {
                const m = r.mods[0];
                const group = groupOf(r);
                const head = group && (i === 0 || groupOf(rows[i - 1]) !== group);
                const on = r.key === row?.key;
                const ch = r.mods.some(changed);
                const ex = extras(m);
                return [
                  head && (
                    <div key={`h:${group}`} className="body-subhead" role="presentation">
                      {group}
                    </div>
                  ),
                  <button key={r.key} data-key={r.key} className={`body-item ${on ? 'on' : ''}`} aria-pressed={on} title={r.mods.map((x) => x.bone).join(' · ')} onClick={() => setPick(r.key)}>
                    <span className="body-item-name">{r.label}</span>
                    {r.mods.length > 1 && <span className="body-item-sides">L·R</span>}
                    {r.location > 1 && q && <span className="body-item-sides">slot {r.location - 1}</span>}
                    {ex.length > 0 && <span className="body-item-extra">{ex.join(', ')}</span>}
                    <span className={`body-item-size ${ch ? 'changed' : ''}`}>{sizeText(m)}</span>
                  </button>,
                ];
              })}
            </div>
          )}
        </section>

        <section className="body-editor" aria-label="Edit the part">
          {row ? (
            <PartEditor key={row.key} row={row} both={both} setBoth={setBoth} side={side} setSide={setSide} more={more} setMore={setMore} apply={apply} reset={resetMany} />
          ) : (
            <div className="body-editor-empty">Pick a part to change it.</div>
          )}
        </section>
      </div>
    </div>
  );
}

function PartEditor(props: {
  row: Row;
  both: boolean;
  setBoth: (v: boolean) => void;
  side: 'L' | 'R';
  setSide: (s: 'L' | 'R') => void;
  more: boolean;
  setMore: (v: boolean) => void;
  apply: (changes: { m: Mod; patch: Partial<Mod> }[]) => void;
  reset: (mods: Mod[]) => void;
}) {
  const { row, both, side, apply } = props;
  const paired = row.mods.length > 1;
  const m = paired ? (row.mods.find((x) => boneSide(x.bone) === side) ?? row.mods[0]) : row.mods[0];
  const other = paired ? row.mods.find((x) => x !== m) : undefined;
  const together = paired && both;
  const differ = together && other ? !sameMod(mirrored(whole(m)), whole(other)) : false;

  const set = (patch: Partial<Mod>) => apply(together && other ? [{ m, patch }, { m: other, patch: mirrored(patch) }] : [{ m, patch }]);
  const size = mean(m.scale);
  const setSize = (n: number) => set({ scale: (Math.abs(size) < 1e-6 ? [n, n, n] : m.scale.map((v) => r4((v * n) / size))) as [number, number, number] });
  const axis = (v: [number, number, number], i: number, n: number) => {
    const next = [...v] as [number, number, number];
    next[i] = n;
    return next;
  };
  const AX = ['X', 'Y', 'Z'];
  const AXC = ['var(--axis-x)', 'var(--axis-y)', 'var(--axis-z)'];

  return (
    <div className="body-ed">
      <header className="body-ed-head">
        <b>{row.label}</b>
        <small>{(together ? row.mods : [m]).map((x) => x.bone).join(' · ')}</small>
      </header>

      {paired && (
        <div className="body-ed-sides">
          <SwitchCard on={props.both} label="Both sides together" help="Change the left and right as one, mirrored: same size and length, positions and turns flipped to the other side." onChange={props.setBoth} />
          {!props.both && (
            <div className="seg" role="group" aria-label="Side">
              {(['L', 'R'] as const).map((s) => (
                <button key={s} className={side === s ? 'on' : ''} onClick={() => props.setSide(s)}>
                  {s === 'L' ? 'Left' : 'Right'}
                </button>
              ))}
            </div>
          )}
          {differ && (
            <div className="body-ed-differ">
              <span>The two sides differ. Changes apply to both from here.</span>
              <button className="btn small solid" title={`Copy the ${side === 'L' ? 'left' : 'right'} side's values to the other side, mirrored`} onClick={() => other && apply([{ m: other, patch: mirrored(whole(m)) }])}>
                Match the {side === 'L' ? 'right' : 'left'} to this side
              </button>
            </div>
          )}
        </div>
      )}

      <div className="body-ed-field">
        <span className="body-ed-label">Size</span>
        <input
          type="range"
          className="body-ed-range"
          min={0}
          max={2}
          step={0.01}
          value={Math.min(2, Math.max(0, size))}
          aria-label="Size"
          onChange={(e) => setSize(Number(e.target.value))}
        />
        <DragNumber value={size} step={0.005} digits={2} width={64} title="Size: all three axes together, keeping their proportions" onPreview={setSize} onCommit={setSize} />
      </div>
      <div className="body-ed-field">
        <span className="body-ed-label">Shape</span>
        <div className="body-ed-xyz">
          {[0, 1, 2].map((i) => (
            <DragNumber key={i} label={AX[i]} color={AXC[i]} value={m.scale[i]} step={0.005} digits={2} onPreview={(n) => set({ scale: axis(m.scale, i, n) })} onCommit={(n) => set({ scale: axis(m.scale, i, n) })} />
          ))}
        </div>
      </div>
      <div className="body-ed-field">
        <span className="body-ed-label">Length</span>
        <DragNumber value={m.length} step={0.005} digits={2} width={64} title="Length of the bone: stretches what hangs from it" onPreview={(n) => set({ length: n })} onCommit={(n) => set({ length: n })} />
      </div>

      <details className="body-ed-more" open={props.more} onToggle={(e) => props.setMore((e.target as HTMLDetailsElement).open)}>
        <summary>
          Move and turn
          {extras(m).filter((x) => x === 'moved' || x === 'turned').length > 0 && <span className="body-item-extra">{extras(m).filter((x) => x === 'moved' || x === 'turned').join(', ')}</span>}
        </summary>
        <div className="body-ed-field">
          <span className="body-ed-label">Position</span>
          <div className="body-ed-xyz">
            {[0, 1, 2].map((i) => (
              <DragNumber key={i} label={AX[i]} color={AXC[i]} value={m.position[i]} step={0.0005} digits={3} onPreview={(n) => set({ position: axis(m.position, i, n) })} onCommit={(n) => set({ position: axis(m.position, i, n) })} />
            ))}
          </div>
        </div>
        <div className="body-ed-field">
          <span className="body-ed-label">Turn</span>
          <div className="body-ed-xyz">
            {[0, 1, 2].map((i) => (
              <DragNumber key={i} label={AX[i]} color={AXC[i]} value={m.rotation[i]} step={0.25} digits={1} unit="°" onPreview={(n) => set({ rotation: axis(m.rotation, i, n) })} onCommit={(n) => set({ rotation: axis(m.rotation, i, n) })} />
            ))}
          </div>
        </div>
      </details>

      <footer className="body-ed-foot">
        <button className="btn solid" title="Back to no change (one undo step)" onClick={() => props.reset(together ? row.mods : [m])} disabled={!(together ? row.mods : [m]).some(changed)}>
          Reset {together ? 'both sides' : paired ? (side === 'L' ? 'left' : 'right') : ''}
        </button>
      </footer>
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

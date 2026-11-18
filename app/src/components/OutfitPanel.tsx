import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, displayName, selectedCharacters, toast, useStore } from '../state/store';
import { Icon } from './Icon';
import { StarIcon } from './StarIcon';

type Named = { name: string; nameEn?: string };
interface CharaState {
  name?: string;
  coordinate: number;
  coordinates: string[];
  shoesType: number;
  clothes: (Named & { slot: number; label: string; state: number; present: boolean })[];
  accessories: (Named & { slot: number; parent: string; visible: boolean })[];
}
interface OutfitData {
  coordinate: number;
  shoesType: number;
  clothes: number[];
  accessories: boolean[];
  from: string;
}
interface Outfit {
  file: string;
  name: string;
  favorite?: boolean;
  lastUsed?: number;
  created?: number;
  data: OutfitData;
}

/** Where an accessory hangs, by its attach point (KK parent keys like a_n_hair_pony, a_n_hand_L). */
const AREAS: [string, RegExp][] = [
  ['Hair & head', /hair|head|megane|ear|mouth|nose|face|tooth/i],
  ['Upper body', /neck|bust|chest|back|shoulder|mune|nip/i],
  ['Arms & hands', /arm|elbow|wrist|hand|finger|ind|naka|ring|kosi|elbo/i],
  ['Lower body', /waist|kokan|ana|leg|knee|ankle|foot|shoe|hip|dan/i],
];
const areaOf = (parent: string) => AREAS.find(([, re]) => re.test(parent))?.[0] ?? 'Other';

/** Saved outfits, accessories by body area (solo, group switches) and hold-to-peek for clipping checks. */
export function OutfitPanel() {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  useStore((s) => s.showEnglish);
  const chars = useMemo(() => selectedCharacters(), [selection, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const primary = chars[0];
  const [st, setSt] = useState<CharaState | null>(null);
  const [outfits, setOutfits] = useState<Outfit[]>([]);
  const [saveName, setSaveName] = useState('');
  const [query, setQuery] = useState('');
  const [solo, setSolo] = useState<{ slot: number; before: boolean[] } | null>(null);
  const peek = useRef<{ kind: 'acc' | 'clothes'; before: boolean[] | number[] } | null>(null);

  const load = useCallback(() => {
    if (primary == null) return setSt(null);
    call<CharaState>('chara.get', { id: primary }).then((s) => s && setSt(s));
  }, [primary]);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load, revision]);
  useEffect(() => {
    if (status === 'open') call<Outfit[]>('store.list', { kind: 'outfits' }).then((r) => r && setOutfits(r));
  }, [status]);
  useEffect(() => setSolo(null), [primary]);

  const set = async (args: Record<string, unknown>, ids = [primary]) => {
    const r = await call<CharaState>('chara.set', { ids, ...args });
    if (r && ids.length === 1 && ids[0] === primary) setSt(r);
    else load();
    return r;
  };
  const visArray = (s: CharaState, f: (a: CharaState['accessories'][number]) => boolean) => {
    const n = Math.max(0, ...s.accessories.map((a) => a.slot + 1));
    const out = new Array<boolean>(n).fill(true);
    for (const a of s.accessories) out[a.slot] = f(a);
    return out;
  };
  const charName = displayName(primary != null ? nodes[primary] : undefined);

  // ---------------- saved outfits ----------------
  const save = async () => {
    if (!st || !saveName.trim()) return;
    const data: OutfitData = {
      coordinate: st.coordinate,
      shoesType: st.shoesType,
      clothes: [...st.clothes].sort((a, b) => a.slot - b.slot).map((c) => c.state),
      accessories: visArray(st, (a) => a.visible),
      from: charName,
    };
    const r = await call<Outfit[]>('store.save', { kind: 'outfits', name: saveName.trim(), data });
    if (r) {
      setOutfits(r);
      setSaveName('');
      toast(`Saved outfit “${saveName.trim()}”`);
    }
  };
  const apply = async (o: Outfit) => {
    if (!chars.length) return toast('Select the character(s) to dress');
    // accessory slots differ per character: their on/off only carries over to the character it was saved from
    const sameChar = chars.length === 1 && o.data.from === charName;
    const r = await set(
      { coordinate: o.data.coordinate, shoesType: o.data.shoesType, clothesStates: o.data.clothes, ...(sameChar ? { accessoriesVisible: o.data.accessories } : {}), undoLabel: 'Apply outfit' },
      chars,
    );
    if (!r) return;
    call<Outfit[]>('store.update', { kind: 'outfits', file: o.file, used: true }).then((x) => x && setOutfits(x));
    toast(`${o.name} applied${chars.length > 1 ? ` to ${chars.length} characters` : ''}${sameChar ? '' : ' (accessories left as they are — saved from another character)'} — Ctrl+Z to undo`);
  };
  const list = [...outfits].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || a.name.localeCompare(b.name));

  // ---------------- accessories ----------------
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const m = new Map<string, CharaState['accessories']>();
    for (const a of st?.accessories ?? []) {
      if (q && !`${a.name} ${a.nameEn ?? ''} ${a.parent}`.toLowerCase().includes(q)) continue;
      const k = areaOf(a.parent);
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    return [...AREAS.map(([k]) => k), 'Other'].filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as const);
  }, [st, query]);

  const setGroup = (items: CharaState['accessories'], on: boolean) => st && set({ accessoriesVisible: visArray(st, (a) => (items.includes(a) ? on : a.visible)), undoLabel: on ? 'Show accessories' : 'Hide accessories' });
  const soloOn = async (slot: number) => {
    if (!st) return;
    const before = visArray(st, (a) => a.visible);
    if (await set({ accessoriesVisible: visArray(st, (a) => a.slot === slot), undoLabel: 'Solo accessory' })) setSolo({ slot, before });
  };
  const soloOff = async () => {
    if (!solo) return;
    await set({ accessoriesVisible: solo.before, undoLabel: 'Restore accessories' });
    setSolo(null);
  };

  // ---------------- peek (hold): nothing goes in the undo history ----------------
  const peekStart = async (kind: 'acc' | 'clothes') => {
    if (!st || peek.current) return;
    if (kind === 'acc') {
      peek.current = { kind, before: visArray(st, (a) => a.visible) };
      await call('chara.set', { ids: [primary], accessoriesAll: false, noUndo: true });
    } else {
      peek.current = { kind, before: [...st.clothes].sort((a, b) => a.slot - b.slot).map((c) => c.state) };
      await call('chara.set', { ids: [primary], clothesAll: 3, noUndo: true });
    }
  };
  const peekEnd = async () => {
    const p = peek.current;
    if (!p) return;
    peek.current = null;
    await call('chara.set', { ids: [primary], ...(p.kind === 'acc' ? { accessoriesVisible: p.before } : { clothesStates: p.before }), noUndo: true });
    load();
  };

  if (primary == null) return <div className="empty">Select a character to dress.</div>;
  if (!st) return <div className="empty">Loading…</div>;

  return (
    <div className="panel-body outfit">
      <div className="section">
        <h3>Saved outfits</h3>
        {!list.length && <div className="hint" style={{ marginTop: 0 }}>Save what {charName} is wearing to switch back to it later, or dress others the same way.</div>}
        <div className="outfit-list">
          {list.map((o) => (
            <div key={o.file} className="outfit-item">
              <button className={`row-star ${o.favorite ? 'on' : ''}`} style={{ opacity: 1 }} title={o.favorite ? 'Favorite' : 'Add to favorites'} onClick={() => call<Outfit[]>('store.update', { kind: 'outfits', file: o.file, favorite: !o.favorite }).then((r) => r && setOutfits(r))}>
                <StarIcon filled={!!o.favorite} size={12} />
              </button>
              <div className="outfit-info">
                <b>{o.name}</b>
                <small>
                  {st.coordinates[o.data.coordinate] ?? `Outfit ${o.data.coordinate + 1}`} · {o.data.clothes.filter((x) => x === 0).length} items fully on{o.data.from ? ` · from ${o.data.from}` : ''}
                </small>
              </div>
              <button className="btn solid small" onClick={() => apply(o)}>
                Apply
              </button>
              <button className="btn small" title="Delete this saved outfit" onClick={() => window.confirm(`Delete the saved outfit “${o.name}”?`) && call<Outfit[]>('store.delete', { kind: 'outfits', file: o.file }).then((r) => r && setOutfits(r))}>
                ✕
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder="Save current outfit as…" value={saveName} onChange={(e) => setSaveName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          <button className="btn primary" disabled={!saveName.trim()} onClick={save}>
            Save
          </button>
        </div>
        <div className="hint">Saves the outfit set, what's on or half-off, shoes and which accessories are shown.</div>
      </div>

      <div className="section">
        <h3>Check clipping</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn solid" style={{ flex: 1 }} onPointerDown={() => peekStart('acc')} onPointerUp={peekEnd} onPointerLeave={peekEnd} title="Hold to hide every accessory">
            Hold: no accessories
          </button>
          <button className="btn solid" style={{ flex: 1 }} onPointerDown={() => peekStart('clothes')} onPointerUp={peekEnd} onPointerLeave={peekEnd} title="Hold to take all clothes off">
            Hold: no clothes
          </button>
        </div>
      </div>

      <div className="section">
        <h3>
          Accessories <span className="spacer" />
          {solo && (
            <button className="btn small on" onClick={soloOff} title="Show the accessories that were visible before">
              End solo
            </button>
          )}
        </h3>
        <input className="input" placeholder="Find an accessory…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
        {groups.map(([area, items]) => {
          const anyOn = items.some((a) => a.visible);
          return (
            <div key={area} className="outfit-group">
              <div className="outfit-group-head">
                <button className={`toggle eye ${anyOn ? '' : 'off'}`} style={{ opacity: 1 }} title={anyOn ? `Hide all ${area.toLowerCase()} accessories` : `Show all ${area.toLowerCase()} accessories`} onClick={() => setGroup(items, !anyOn)}>
                  <Icon name={anyOn ? 'eye' : 'eyeOff'} size={13} />
                </button>
                <b>{area}</b>
                <small>{items.length}</small>
              </div>
              {items.map((a) => (
                <div key={a.slot} className={`outfit-acc ${a.visible ? '' : 'hidden'}`}>
                  <button className={`toggle eye ${a.visible ? '' : 'off'}`} style={{ opacity: 1 }} onClick={() => set({ accessory: { slot: a.slot, visible: !a.visible } })} title={a.visible ? 'Hide' : 'Show'}>
                    <Icon name={a.visible ? 'eye' : 'eyeOff'} size={13} />
                  </button>
                  <span className="name" title={`Slot ${a.slot + 1} · ${a.parent}`}>
                    {displayName(a) || '(unnamed)'}
                  </span>
                  <button className={`btn small ${solo?.slot === a.slot ? 'on' : ''}`} onClick={() => (solo?.slot === a.slot ? soloOff() : soloOn(a.slot))} title="Show only this accessory">
                    Solo
                  </button>
                </div>
              ))}
            </div>
          );
        })}
        {!st.accessories.length && <div className="hint">No accessories in this outfit.</div>}
      </div>
    </div>
  );
}

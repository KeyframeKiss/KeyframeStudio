import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { useLibMeta } from '../lib/libmeta';
import { call, displayName, toast, useStore } from '../state/store';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { StarIcon } from './StarIcon';
import { Help } from './Help';

interface Item {
  g: number;
  c: number;
  n: number;
  key: string;
  name: string;
  nameEn?: string | null;
  group: string;
  groupEn?: string | null;
  category: string;
  categoryEn?: string | null;
  /** 1 = has a picture, -1 = can't have one (lights, effects, helpers), 0 = not made yet */
  thumb: number;
}
interface Catalog {
  folder: string;
  items: Item[];
}
type Show = 'all' | 'fav' | 'recent';

const TILE_W = 132,
  TILE_H = 156;
let cached: Catalog | null = null;

const nameOf = (i: Item) => displayName({ name: i.name || `#${i.n}`, nameEn: i.nameEn ?? undefined });
const groupOf = (i: Item) => displayName({ name: i.group, nameEn: i.groupEn ?? undefined });
const catOf = (i: Item) => displayName({ name: i.category, nameEn: i.categoryEn ?? undefined });

/**
 * Library › Objects: every item Studio can add — its own and every mod's — by group and category, with a picture
 * of each (made on demand as they come into view, then cached), search, favourites and recent. Double-click adds.
 */
export function ItemLibrary() {
  const status = useStore((s) => s.status);
  useStore((s) => s.showEnglish);
  const lib = useLibMeta('items');
  const [cat, setCat] = useState<Catalog | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, number>>({});
  const [bust, setBust] = useState<Record<string, number>>({});
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [group, setGroup] = useState<number | null>(null);
  const [category, setCategory] = useState<number | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [job, setJob] = useState<{ queued: number } | null>(null);

  const load = useCallback(async (fresh = false) => {
    if (cached && !fresh) return setCat(cached);
    try {
      const c = await bridge.request<Catalog>('items.catalog');
      cached = c;
      setCat(c);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load]);
  // pictures arrive one by one
  useEffect(
    () =>
      bridge.on('items.thumb', (d) => {
        const { key, ok, queued } = d as { key: string; ok: boolean; queued: number };
        setThumbs((t) => ({ ...t, [key]: ok ? 1 : -1 }));
        setBust((b) => ({ ...b, [key]: Date.now() }));
        setJob((j) => (j ? { queued } : j));
        if (cached) {
          const it = cached.items.find((x) => x.key === key);
          if (it) it.thumb = ok ? 1 : -1;
        }
      }),
    [],
  );

  const items = cat?.items ?? [];
  const groups = useMemo(() => {
    const m = new Map<number, { name: string; count: number; cats: Map<number, { name: string; count: number }> }>();
    for (const i of items) {
      let g = m.get(i.g);
      if (!g) m.set(i.g, (g = { name: groupOf(i), count: 0, cats: new Map() }));
      g.count++;
      const c = g.cats.get(i.c);
      if (c) c.count++;
      else g.cats.set(i.c, { name: catOf(i), count: 1 });
    }
    return [...m].sort((a, b) => a[0] - b[0]);
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = items.filter((i) => {
      if (group != null && i.g !== group) return false;
      if (category != null && i.c !== category) return false;
      if (show === 'fav' && !lib.get(i.key).favorite) return false;
      if (show === 'recent' && !lib.get(i.key).lastUsed) return false;
      if (words.length) {
        const hay = `${i.name} ${i.nameEn ?? ''} ${i.group} ${i.groupEn ?? ''} ${i.category} ${i.categoryEn ?? ''}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    if (show === 'recent') list = [...list].sort((a, b) => (lib.get(b.key).lastUsed ?? 0) - (lib.get(a.key).lastUsed ?? 0));
    return list;
  }, [items, q, group, category, show, lib.meta]); // eslint-disable-line react-hooks/exhaustive-deps

  const thumbOf = (i: Item) => thumbs[i.key] ?? i.thumb;
  const add = async (i: Item) => {
    const id = await call<number>('items.add', { group: i.g, category: i.c, no: i.n });
    if (id == null) return;
    lib.markUsed(i.key);
    toast(`Added ${nameOf(i)}`);
  };

  // ---------------- the grid: only the rows on screen ----------------
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, w: 800, h: 600 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, [cat]);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setView((v) => ({ ...v, top: 0 }));
  }, [q, group, category, show]);
  const cols = Math.max(1, Math.floor((view.w - 8) / TILE_W));
  const rows = Math.ceil(shown.length / cols);
  const r0 = Math.max(0, Math.floor(view.top / TILE_H) - 2),
    r1 = Math.min(rows, Math.ceil((view.top + view.h) / TILE_H) + 2);
  const visible = shown.slice(r0 * cols, r1 * cols);

  // ask for the pictures of what's on screen (most recent view first)
  const asked = useRef(new Set<string>());
  useEffect(() => {
    const want = visible.filter((i) => thumbOf(i) === 0 && !asked.current.has(i.key)).map((i) => i.key);
    if (!want.length) return;
    const t = window.setTimeout(() => {
      want.forEach((k) => asked.current.add(k));
      bridge.request('items.thumbs', { keys: want }).catch(() => undefined);
    }, 150);
    return () => window.clearTimeout(t);
  }, [r0, r1, shown, thumbs]); // eslint-disable-line react-hooks/exhaustive-deps

  // English names for what's on screen (the catalog only carries names already translated)
  const named = useRef(new Set<string>());
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const want = visible.filter((i) => !i.nameEn && !named.current.has(i.key) && /[^ -~]/.test(i.name)).map((i) => i.key);
    if (!want.length) return;
    const t = window.setTimeout(() => {
      want.forEach((k) => named.current.add(k));
      bridge
        .request<Record<string, string>>('items.names', { keys: want })
        .then((r) => {
          if (!Object.keys(r).length) return;
          for (const it of cached?.items ?? []) if (r[it.key]) it.nameEn = r[it.key];
          setNames((n) => ({ ...n, ...r }));
        })
        .catch(() => undefined);
    }, 200);
    return () => window.clearTimeout(t);
  }, [r0, r1, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  void names;

  const missing = useMemo(() => shown.filter((i) => thumbOf(i) === 0).length, [shown, thumbs]); // eslint-disable-line react-hooks/exhaustive-deps
  const makeAll = async () => {
    const r = await call<{ queued: number }>('items.thumbsAll', { group: group ?? -1, category: category ?? -1 });
    if (r) setJob(r);
  };
  const cancelAll = async () => {
    await call('items.thumbsCancel');
    asked.current.clear();
    setJob(null);
  };
  useEffect(() => {
    if (job && job.queued === 0) setJob(null);
  }, [job]);

  if (error)
    return (
      <div className="empty">
        <strong>Couldn't read Studio's items</strong>
        {error}
        <button className="btn" onClick={() => load(true)}>
          Try again
        </button>
      </div>
    );
  if (!cat) return <div className="empty">Reading Studio's items…</div>;

  const sel = picked ? items.find((i) => i.key === picked) : undefined;
  const url = (i: Item) => `sximg://thumb/?p=${encodeURIComponent(`${cat.folder}\\${i.key}.jpg`)}${bust[i.key] ? `&v=${bust[i.key]}` : ''}`;

  return (
    <div className={`items-lib ${sel ? 'with-side' : ''}`}>
      <aside className="items-side">
        <input className="input" placeholder={`Search ${items.length.toLocaleString()} objects…`} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg items-show">
          {(['all', 'fav', 'recent'] as Show[]).map((s) => (
            <button key={s} className={show === s ? 'on' : ''} onClick={() => setShow(s)}>
              {s === 'all' ? 'All' : s === 'fav' ? '★ Starred' : 'Recent'}
            </button>
          ))}
        </div>
        <div className="items-tree">
          <button className={`items-node ${group == null ? 'on' : ''}`} onClick={() => (setGroup(null), setCategory(null))}>
            <span>Everything</span>
            <small>{items.length.toLocaleString()}</small>
          </button>
          {groups.map(([g, gi]) => (
            <div key={g}>
              <button
                className={`items-node ${group === g && category == null ? 'on' : ''}`}
                onClick={() => {
                  setGroup(g);
                  setCategory(null);
                  setOpen((o) => new Set(o).add(g));
                }}
              >
                <i
                  className="items-twist"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen((o) => {
                      const n = new Set(o);
                      if (n.has(g)) n.delete(g);
                      else n.add(g);
                      return n;
                    });
                  }}
                >
                  {open.has(g) ? '▾' : '▸'}
                </i>
                <span title={gi.name}>{gi.name || `Group ${g}`}</span>
                <small>{gi.count.toLocaleString()}</small>
              </button>
              {open.has(g) &&
                [...gi.cats].map(([c, ci]) => (
                  <button key={c} className={`items-node sub ${group === g && category === c ? 'on' : ''}`} onClick={() => (setGroup(g), setCategory(c))}>
                    <span title={ci.name}>{ci.name || `Category ${c}`}</span>
                    <small>{ci.count.toLocaleString()}</small>
                  </button>
                ))}
            </div>
          ))}
        </div>
      </aside>

      <section className="items-main">
        <div className="items-bar">
          <b>{shown.length.toLocaleString()}</b>
          <span className="pn-note">
            {group != null ? groups.find(([g]) => g === group)?.[1].name : 'objects'}
            {category != null ? ` › ${groups.find(([g]) => g === group)?.[1].cats.get(category)?.name ?? ''}` : ''}
          </span>
          <Help text="Pictures are made as items come into view (Studio loads each one on its own, out of sight, and lets it go again) and kept, so each is made once. Lights, effects and helper objects have nothing to picture. Double-click an object, or select it and press Add, to put it in the scene." />
          <span style={{ flex: 1 }} />
          {job ? (
            <>
              <span className="pn-note">Making pictures… {job.queued.toLocaleString()} to go</span>
              <button className="btn small" onClick={cancelAll}>
                Stop
              </button>
            </>
          ) : (
            missing > 0 && (
              <button className="btn small solid" onClick={makeAll} title="Make every missing picture here in the background (it pauses while the timeline plays or a render runs)">
                Make all {missing.toLocaleString()} pictures
              </button>
            )
          )}
          <button className="btn small" onClick={() => load(true)} title="Read Studio's item lists again (after adding mods)">
            Refresh
          </button>
        </div>

        <div className="items-scroll" ref={scroller} onScroll={(e) => setView((v) => ({ ...v, top: (e.target as HTMLDivElement).scrollTop }))}>
          {!shown.length && <div className="empty">{show === 'fav' ? 'No favourites yet — star objects to keep them here.' : show === 'recent' ? 'Objects you add show up here.' : 'Nothing matches.'}</div>}
          <div style={{ height: rows * TILE_H, position: 'relative' }}>
            {visible.map((i, k) => {
              const idx = r0 * cols + k;
              const t = thumbOf(i);
              const fav = !!lib.get(i.key).favorite;
              return (
                <div
                  key={i.key}
                  className={`items-tile ${picked === i.key ? 'on' : ''}`}
                  style={{ left: (idx % cols) * TILE_W, top: Math.floor(idx / cols) * TILE_H, width: TILE_W - 8, height: TILE_H - 8 }}
                  onClick={() => setPicked(i.key)}
                  onDoubleClick={() => add(i)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPicked(i.key);
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        { header: true, label: nameOf(i) },
                        { label: 'Add to the scene', action: () => add(i) },
                        { label: fav ? 'Remove from favourites' : 'Add to favourites', action: () => lib.toggleFavorite(i.key) },
                        { label: 'Show its category', action: () => (setGroup(i.g), setCategory(i.c), setOpen((o) => new Set(o).add(i.g)), setQ('')) },
                      ],
                    });
                  }}
                  title={`${nameOf(i)}\n${groupOf(i)} › ${catOf(i)}\nDouble-click to add`}
                >
                  <div className="items-pic">
                    {t === 1 ? <img src={url(i)} alt="" loading="lazy" draggable={false} /> : t === -1 ? <span className="items-nopic">no picture</span> : <span className="items-wait" />}
                  </div>
                  <span className="items-name">{nameOf(i)}</span>
                  <button
                    className={`items-star ${fav ? 'on' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      lib.toggleFavorite(i.key);
                    }}
                    title={fav ? 'Remove from favourites' : 'Add to favourites'}
                  >
                    <StarIcon filled={fav} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

      </section>
      {sel && (
        <ItemSidebar
          item={sel}
          small={thumbOf(sel) === 1 ? url(sel) : null}
          noPicture={thumbOf(sel) === -1}
          fav={!!lib.get(sel.key).favorite}
          onFav={() => lib.toggleFavorite(sel.key)}
          onAdd={() => add(sel)}
          onCategory={() => (setGroup(sel.g), setCategory(sel.c), setOpen((o) => new Set(o).add(sel.g)), setQ(''))}
          onClose={() => setPicked(null)}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

const VIEWS: { id: string; label: string }[] = [
  { id: 'front', label: 'Front' },
  { id: 'side', label: 'Side' },
  { id: 'back', label: 'Back' },
  { id: 'top', label: 'Above' },
];

/** The selected object, big: a sharp picture from the side you pick, its names, star, add. */
function ItemSidebar({ item, small, noPicture, fav, onFav, onAdd, onCategory, onClose }: { item: Item; small: string | null; noPicture: boolean; fav: boolean; onFav: () => void; onAdd: () => void; onCategory: () => void; onClose: () => void }) {
  const [view, setView] = useState('front');
  const [big, setBig] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const id = `${item.key}-${view}`;
  useEffect(() => setView('front'), [item.key]);
  useEffect(() => {
    if (noPicture || id in big) return;
    let live = true;
    setBusy(true);
    bridge
      .request<string | null>('items.preview', { key: item.key, view })
      .then((p) => live && setBig((m) => ({ ...m, [id]: p })))
      .catch(() => live && setBig((m) => ({ ...m, [id]: null })))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [id, noPicture]); // eslint-disable-line react-hooks/exhaustive-deps
  const path = big[id];
  const src = path ? `sximg://thumb/?p=${encodeURIComponent(path)}` : view === 'front' ? small : null;
  return (
    <aside className="items-side-detail">
      <div className="items-side-head">
        <b title={nameOf(item)}>{nameOf(item)}</b>
        <button className="btn small solid" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="items-big">
        {noPicture ? <span className="items-nopic">Nothing to picture (a light, effect or helper)</span> : src ? <img src={src} alt="" draggable={false} /> : <span className="items-wait" />}
        {busy && src && <span className="items-wait corner" />}
      </div>
      {!noPicture && (
        <div className="seg items-views">
          {VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? 'on' : ''} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
      )}
      <div className="items-side-text">
        {item.nameEn && item.name !== item.nameEn && <small title="Original name">{item.name}</small>}
        <button className="link-btn" onClick={onCategory} title="Show everything in this category">
          {groupOf(item)} › {catOf(item)}
        </button>
      </div>
      <div className="items-side-actions">
        <button className="btn primary" onClick={onAdd}>
          Add to the scene
        </button>
        <button className={`btn solid ${fav ? 'on' : ''}`} onClick={onFav} title={fav ? 'Remove from starred' : 'Star it'}>
          <StarIcon filled={fav} /> {fav ? 'Starred' : 'Star'}
        </button>
      </div>
      <small className="pn-note">Double-clicking a tile adds it too.</small>
    </aside>
  );
}

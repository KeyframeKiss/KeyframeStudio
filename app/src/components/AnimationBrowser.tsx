import { useEffect, useMemo, useState } from 'react';
import { Help } from './Help';
import { parseTags, useLibMeta } from '../lib/libmeta';
import { pressable } from '../lib/pressable';
import { call, displayName, useStore } from '../state/store';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { PromptDialog, type PromptState } from './PromptDialog';
import { StarIcon } from './StarIcon';

type Named = { name: string; nameEn?: string };
type Clip = Named & { no: number };
interface Group extends Named {
  id: number;
  categories: (Named & { id: number; clips: Clip[] })[];
}
type Hit = { g: Group; c: Group['categories'][number]; clip: Clip; key: string };

let cache: Group[] | null = null;
const FAV = -100,
  RECENT = -101;
const clipKey = (g: number, c: number, no: number) => `${g}/${c}/${no}`;

export function AnimationBrowser({
  current,
  onPick,
  onClose,
  embedded,
  title = 'Animations',
}: {
  current: { group: number; category: number; no: number };
  onPick: (group: number, category: number, no: number) => void;
  onClose: () => void;
  /** the heading (e.g. who the clip goes on) */
  title?: string;
  /** Render inline (Pose workspace) instead of as a dialog. */
  embedded?: boolean;
}) {
  useStore((s) => s.showEnglish);
  const lib = useLibMeta('animations');
  const [groups, setGroups] = useState<Group[] | null>(cache);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState(current.group);
  const [category, setCategory] = useState(current.category);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);

  // Show the cached catalog at once, but refresh it (new English names from auto-translate, reconnects).
  const status = useStore((s) => s.status);
  const translating = useStore((s) => !!s.translateJob);
  useEffect(() => {
    if (status !== 'open' || translating) return;
    call<Group[]>('chara.animations').then((g) => {
      if (!g) return;
      cache = g;
      setGroups(g);
    });
  }, [status, translating]);

  // Embedded in the Pose workspace the current clip arrives after mount: follow it until the user browses.
  useEffect(() => {
    if (group < 0 && group !== FAV && group !== RECENT && current.group >= 0) {
      setGroup(current.group);
      setCategory(current.category);
    }
  }, [current.group, current.category]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e: KeyboardEvent) => !embedded && e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  /** every clip by key, for favorites / recent */
  const index = useMemo(() => {
    const m = new Map<string, Hit>();
    for (const g of groups ?? []) for (const c of g.categories) for (const clip of c.clips) m.set(clipKey(g.id, c.id, clip.no), { g, c, clip, key: clipKey(g.id, c.id, clip.no) });
    return m;
  }, [groups]);

  const q = query.trim().toLowerCase();
  const matches = (n: Named) => `${n.name} ${n.nameEn ?? ''}`.toLowerCase().includes(q);

  const results = useMemo(() => {
    if (!groups || !q) return null;
    const out: Hit[] = [];
    for (const h of index.values()) if (matches(h.clip) || matches(h.c) || (lib.meta[h.key]?.tags ?? []).some((t) => t.toLowerCase().includes(q))) out.push(h);
    return out.slice(0, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, q, index, lib.meta]);

  const favorites = useMemo(
    () =>
      Object.entries(lib.meta)
        .filter(([, m]) => m.favorite)
        .map(([k]) => index.get(k))
        .filter((h): h is Hit => !!h)
        .sort((a, b) => displayName(a.clip).localeCompare(displayName(b.clip))),
    [lib.meta, index],
  );
  const recent = useMemo(
    () =>
      Object.entries(lib.meta)
        .filter(([, m]) => m.lastUsed)
        .sort((a, b) => (b[1].lastUsed ?? 0) - (a[1].lastUsed ?? 0))
        .map(([k]) => index.get(k))
        .filter((h): h is Hit => !!h)
        .slice(0, 40),
    [lib.meta, index],
  );

  const special = group === FAV || group === RECENT;
  const g = special ? undefined : (groups?.find((x) => x.id === group) ?? groups?.[0]);
  const c = g?.categories.find((x) => x.id === category) ?? g?.categories[0];
  const isCurrent = (gi: number, ci: number, no: number) => gi === current.group && ci === current.category && no === current.no;

  const pick = (gi: number, ci: number, no: number) => {
    onPick(gi, ci, no);
    lib.markUsed(clipKey(gi, ci, no));
  };

  const openMenu = (e: React.MouseEvent, h: Hit) => {
    e.preventDefault();
    const m = lib.get(h.key);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { header: true, label: displayName(h.clip) },
        { label: 'Apply', action: () => pick(h.g.id, h.c.id, h.clip.no) },
        { label: m.favorite ? 'Remove from favorites' : 'Add to favorites', action: () => lib.toggleFavorite(h.key) },
        {
          label: 'Edit tags…',
          action: () =>
            setPrompt({
              title: `Tags for “${displayName(h.clip)}”`,
              hint: 'Separate tags with commas, e.g. idle, dance, sitting',
              value: (m.tags ?? []).join(', '),
              placeholder: 'idle, dance, …',
              ok: (v) => lib.setTags(h.key, parseTags(v)),
            }),
        },
      ],
    });
  };

  /** A clip row: star, name, where it lives (for lists that mix categories), tags. */
  const row = (h: Hit, showPath?: boolean) => {
    const m = lib.get(h.key);
    return (
      <div
        {...pressable}
        key={h.key}
        className={`tree-row anim-row ${isCurrent(h.g.id, h.c.id, h.clip.no) ? 'selected' : ''}`}
        style={{ paddingLeft: 4 }}
        onClick={() => pick(h.g.id, h.c.id, h.clip.no)}
        onDoubleClick={onClose}
        onContextMenu={(e) => openMenu(e, h)}
        title={`${h.clip.name}${h.clip.nameEn ? `\n${h.clip.nameEn}` : ''}${m.tags?.length ? `\nTags: ${m.tags.join(', ')}` : ''}\nClick to apply · right-click for more`}
      >
        <button
          className={`row-star ${m.favorite ? 'on' : ''}`}
          tabIndex={-1}
          title={m.favorite ? 'Favorite (click to remove)' : 'Add to favorites'}
          onClick={(e) => {
            e.stopPropagation();
            lib.toggleFavorite(h.key);
          }}
        >
          <StarIcon filled={!!m.favorite} size={12} />
        </button>
        <span className="name">{displayName(h.clip)}</span>
        <span className="sub">
          {m.tags?.length ? m.tags.join(' · ') : ''}
          {showPath ? `${m.tags?.length ? ' — ' : ''}${displayName(h.g)} › ${displayName(h.c)}` : ''}
        </span>
      </div>
    );
  };

  return (
    <div className={embedded ? 'page' : 'overlay'} onClick={embedded ? undefined : onClose}>
      <div className={embedded ? 'page-inner' : 'dialog'} style={embedded ? undefined : { width: 'min(980px, calc(100vw - 32px))', height: 'min(640px, calc(100vh - 64px))', display: 'flex', flexDirection: 'column', padding: 0 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
          <h2 style={{ margin: 0, flex: 'none', display: 'flex', alignItems: 'center' }}>
            {title}
            <Help text="Click a clip to put it on the character (it plays at once; FK / IK that would hold the body still are switched off) · double-click to apply and close · ★ to keep a favorite · right-click for tags. Ctrl+Z undoes it." />
          </h2>
          <input className="input" autoFocus placeholder="Search every animation (incl. mods) and your tags…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1 }} />
          {!embedded && (
            <button className="btn" onClick={onClose}>
              Close
            </button>
          )}
        </div>
        {!groups ? (
          <div className="empty">Loading catalog…</div>
        ) : results ? (
          <div className="panel-body" style={{ padding: 8 }}>
            {results.map((h) => (
              row(h, true)
            ))}
            {!results.length && <div className="empty">No animations match “{query}”.</div>}
          </div>
        ) : (
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: special ? 'minmax(140px, 200px) minmax(0, 1fr)' : 'minmax(140px, 200px) minmax(160px, 240px) minmax(0, 1fr)', minHeight: 0 }}>
            <div className="panel-body" style={{ borderRight: '1px solid var(--line)' }}>
              <div {...pressable} className={`tree-row ${group === FAV ? 'selected' : ''}`} style={{ paddingLeft: 10 }} onClick={() => setGroup(FAV)}>
                <StarIcon filled size={12} />
                <span className="name">Favorites</span>
                <span className="sub">{favorites.length}</span>
              </div>
              <div {...pressable} className={`tree-row ${group === RECENT ? 'selected' : ''}`} style={{ paddingLeft: 10 }} onClick={() => setGroup(RECENT)}>
                <span className="name">Recently used</span>
                <span className="sub">{recent.length}</span>
              </div>
              <div className="anim-sep" />
              {groups.map((x) => (
                <div
                  {...pressable}
                  key={x.id}
                  className={`tree-row ${x.id === g?.id ? 'selected' : ''}`}
                  style={{ paddingLeft: 10 }}
                  onClick={() => {
                    setGroup(x.id);
                    setCategory(x.categories[0]?.id ?? 0);
                  }}
                >
                  <span className="name">{displayName(x)}</span>
                </div>
              ))}
            </div>
            {!special && (
              <div className="panel-body" style={{ borderRight: '1px solid var(--line)' }}>
                {g?.categories.map((x) => (
                  <div {...pressable} key={x.id} className={`tree-row ${x.id === c?.id ? 'selected' : ''}`} style={{ paddingLeft: 10 }} onClick={() => setCategory(x.id)}>
                    <span className="name">{displayName(x)}</span>
                    <span className="sub">{x.clips.length}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="panel-body">
              {group === FAV &&
                (favorites.length ? favorites.map((h) => row(h, true)) : <div className="empty">Star an animation to keep it here.</div>)}
              {group === RECENT && (recent.length ? recent.map((h) => row(h, true)) : <div className="empty">Animations you apply show up here.</div>)}
              {!special && g && c && c.clips.map((clip) => row({ g, c, clip, key: clipKey(g.id, c.id, clip.no) }))}
            </div>
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {prompt && <PromptDialog p={prompt} onClose={() => setPrompt(null)} />}
    </div>
  );
}

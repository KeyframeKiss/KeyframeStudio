import { useEffect, useMemo, useState } from 'react';
import { ask } from './Dialogs';
import { bridge } from '../bridge/client';
import { parseTags, useLibMeta } from '../lib/libmeta';
import { pressable } from '../lib/pressable';
import { call, selectedCharacters, toast, useStore } from '../state/store';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { PromptDialog, type PromptState } from './PromptDialog';
import { StarIcon } from './StarIcon';

interface Card {
  path: string;
  rel: string;
  sex: number;
  folder: string;
  modified: number;
  name?: string;
}
type Show = 'all' | 'fav' | 'recent';

const canThumb = !!window.studioEx?.isElectron;
const thumbUrl = (p: string) => `sximg://thumb/?p=${encodeURIComponent(p)}`;
const fileName = (c: Card) => c.rel.split(/[\\/]/).pop()!.replace(/\.png$/i, '');

/** Character cards from UserData/chara: add to the scene or swap onto the selected character. */
export function CharacterLibrary() {
  const status = useStore((s) => s.status);
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  const chars = useMemo(() => selectedCharacters(), [selection, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const lib = useLibMeta('characters');
  const [cards, setCards] = useState<Card[]>([]);
  const [query, setQuery] = useState('');
  const [sex, setSex] = useState<-1 | 0 | 1>(-1);
  const [show, setShow] = useState<Show>('all');
  const [folder, setFolder] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);

  useEffect(() => {
    if (status === 'open') call<Card[]>('cards.list').then((c) => c && setCards(c));
  }, [status]);
  // names arrive in the background as Studio reads the cards
  useEffect(
    () =>
      bridge.on('cards.names', (d) => {
        const names = d as Record<string, string>;
        setCards((cs) => cs.map((c) => (c.path in names ? { ...c, name: names[c.path] } : c)));
      }),
    [],
  );

  const keyOf = (c: Card) => c.rel.replace(/\\/g, '/');
  const label = (c: Card) => c.name || fileName(c);
  const folders = useMemo(() => [...new Set(cards.map((c) => c.folder))].sort(), [cards]);
  const q = query.trim().toLowerCase();
  const list = cards
    .filter((c) => {
      const m = lib.get(keyOf(c));
      return (
        (sex === -1 || c.sex === sex) &&
        (folder === null || c.folder === folder) &&
        (!q || `${label(c)} ${c.rel} ${(m.tags ?? []).join(' ')}`.toLowerCase().includes(q)) &&
        (show !== 'fav' || m.favorite) &&
        (show !== 'recent' || m.lastUsed) &&
        tagFilter.every((t) => m.tags?.includes(t))
      );
    })
    .sort((a, b) => {
      const ma = lib.get(keyOf(a)),
        mb = lib.get(keyOf(b));
      if (show === 'recent') return (mb.lastUsed ?? 0) - (ma.lastUsed ?? 0);
      return Number(!!mb.favorite) - Number(!!ma.favorite) || b.modified - a.modified;
    });

  const add = async (c: Card) => {
    const id = await call<number>('cards.add', { path: c.path });
    if (id == null) return;
    lib.markUsed(keyOf(c));
    toast(`${label(c)} added to the scene — Ctrl+Z to remove`);
  };
  const swap = async (c: Card) => {
    if (chars.length !== 1) return toast('Select one character to swap');
    if (!(await ask(`Swap the selected character for ${label(c)}? The pose and animation stay; this can't be undone.`))) return;
    if (await call('cards.swap', { id: chars[0], path: c.path })) {
      lib.markUsed(keyOf(c));
      toast(`Now ${label(c)}`);
    }
  };
  const openMenu = (e: React.MouseEvent, c: Card) => {
    e.preventDefault();
    const m = lib.get(keyOf(c));
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { header: true, label: label(c) },
        { label: 'Add to scene', action: () => add(c) },
        { label: 'Swap the selected character for this one…', action: () => swap(c) },
        { label: m.favorite ? 'Remove from favorites' : 'Add to favorites', action: () => lib.toggleFavorite(keyOf(c)) },
        {
          label: 'Edit tags…',
          action: () =>
            setPrompt({
              title: `Tags for ${label(c)}`,
              hint: 'Separate tags with commas, e.g. main cast, school, extra',
              value: (m.tags ?? []).join(', '),
              placeholder: 'main cast, …',
              ok: (v) => lib.setTags(keyOf(c), parseTags(v)),
            }),
        },
      ],
    });
  };

  const reading = cards.filter((c) => c.name === undefined).length;
  return (
    <div className="page">
      <div className="page-inner">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Characters</h2>
          <input className="input" autoFocus placeholder="Search names, files, tags…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 240 }} />
          <div className="seg">
            {(
              [
                [-1, 'All'],
                [1, '♀'],
                [0, '♂'],
              ] as const
            ).map(([v, l]) => (
              <button key={v} className={sex === v ? 'on' : ''} onClick={() => setSex(v)}>
                {l}
              </button>
            ))}
          </div>
          <div className="seg">
            <button className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>
              All
            </button>
            <button className={show === 'fav' ? 'on' : ''} onClick={() => setShow('fav')}>
              <StarIcon filled={show === 'fav'} size={12} /> Favorites
            </button>
            <button className={show === 'recent' ? 'on' : ''} onClick={() => setShow('recent')}>
              Recent
            </button>
          </div>
          {folders.length > 1 && (
            <select className="input" style={{ width: 'auto' }} value={folder ?? '*'} onChange={(e) => setFolder(e.target.value === '*' ? null : e.target.value)}>
              <option value="*">All folders</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
          <span style={{ flex: 1 }} />
          <span className="hint" style={{ margin: 0 }}>
            {list.length} of {cards.length}
            {reading ? ` · reading names… ${cards.length - reading}/${cards.length}` : ''}
          </span>
        </div>
        {lib.allTags.length > 0 && (
          <div className="face-tagbar" style={{ padding: '8px 16px 0' }}>
            {lib.allTags.slice(0, 30).map((t) => (
              <button key={t} className={`face-tag-chip ${tagFilter.includes(t) ? 'on' : ''}`} onClick={() => setTagFilter(tagFilter.includes(t) ? tagFilter.filter((x) => x !== t) : [...tagFilter, t])}>
                {t}
              </button>
            ))}
          </div>
        )}
        <div className="panel-body" style={{ padding: 12 }}>
          <div className="card-grid">
            {list.map((c) => {
              const m = lib.get(keyOf(c));
              return (
                <div {...pressable} key={c.path} className="char-card star-host" onDoubleClick={() => add(c)} onClick={() => undefined} onContextMenu={(e) => openMenu(e, c)} title={`${label(c)}\n${c.rel}${m.tags?.length ? `\nTags: ${m.tags.join(', ')}` : ''}\nDouble-click to add · right-click for more`}>
                  <button className={`face-star ${m.favorite ? 'on' : ''}`} tabIndex={-1} onClick={(e) => { e.stopPropagation(); lib.toggleFavorite(keyOf(c)); }} title={m.favorite ? 'Favorite' : 'Add to favorites'}>
                    <StarIcon filled={!!m.favorite} />
                  </button>
                  <div className="char-card-img">
                    {canThumb ? <img src={thumbUrl(c.path)} loading="lazy" alt="" onError={(e) => ((e.currentTarget.style.display = 'none'), e.currentTarget.parentElement?.setAttribute('data-ph', c.sex ? '♀' : '♂'))} /> : <span>{c.sex ? '♀' : '♂'}</span>}
                  </div>
                  <div className="char-card-name">
                    <b>{label(c)}</b>
                    <small>{c.folder.replace(/^(female|male)[\\/]?/, '') || (c.sex ? 'female' : 'male')}</small>
                  </div>
                  <div className="char-card-actions">
                    <button className="btn small solid" onClick={(e) => { e.stopPropagation(); add(c); }}>
                      Add
                    </button>
                    {chars.length === 1 && (
                      <button className="btn small" onClick={(e) => { e.stopPropagation(); swap(c); }} title="Swap the selected character for this card">
                        Swap
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {!list.length && <div className="empty">{cards.length ? 'No characters match.' : 'No character cards in UserData/chara.'}</div>}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {prompt && <PromptDialog p={prompt} onClose={() => setPrompt(null)} />}
    </div>
  );
}

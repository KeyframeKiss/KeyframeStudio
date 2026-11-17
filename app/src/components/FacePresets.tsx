import { useCallback, useEffect, useMemo, useState } from 'react';
import { bridge } from '../bridge/client';
import { ALL_FACE_BONES, FACE_FEATURES, twinOf } from '../lib/faceBones';
import { toast, useStore } from '../state/store';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Popover } from './Shell';

/**
 * Saved faces: store the current face adjustments under a name (with a thumbnail) and switch between them
 * with one click. A saved face holds offsets, so it can be applied to any character, fully or partly.
 * Built to stay usable with hundreds of faces: search, sort, favorites, tags, a large gallery, and the
 * whole strip can be collapsed.
 */

interface SavedFace {
  file: string;
  name: string;
  bones: string[];
  tags: string[];
  favorite: boolean;
  from: string;
  created: number;
  lastUsed: number;
  modified: number;
  thumb?: string;
}

type Sort = 'recent' | 'newest' | 'name';

/** Fill in fields an older plugin build or a hand-edited file may not have. */
function normalize(list: unknown): SavedFace[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((f) => f && typeof f === 'object' && typeof (f as SavedFace).file === 'string')
    .map((f: Partial<SavedFace>) => ({
      file: f.file!,
      name: typeof f.name === 'string' ? f.name : f.file!,
      bones: Array.isArray(f.bones) ? f.bones : [],
      tags: Array.isArray(f.tags) ? f.tags.filter((t) => typeof t === 'string') : [],
      favorite: !!f.favorite,
      from: typeof f.from === 'string' ? f.from : '',
      created: Number(f.created) || Number(f.modified) || 0,
      lastUsed: Number(f.lastUsed) || 0,
      modified: Number(f.modified) || 0,
      thumb: f.thumb,
    }));
}

const lsGet = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

/** Both sides of every bone in the chosen features. */
function scopeFor(features: string[]) {
  const names = FACE_FEATURES.filter((f) => features.includes(f.id)).flatMap((f) => f.bones.map((b) => b.name));
  return [...new Set(names.flatMap((n) => [n, twinOf(n)]))];
}

const featuresOf = (f: SavedFace) =>
  FACE_FEATURES.filter((ft) => ft.bones.some((b) => f.bones.includes(b.name) || f.bones.includes(twinOf(b.name)))).map((ft) => ft.label);

interface PromptState {
  title: string;
  hint?: string;
  value: string;
  placeholder?: string;
  ok: (v: string) => void;
}

export function FacePresets({ ids, onApplied }: { ids: number[]; onApplied: () => void }) {
  const status = useStore((s) => s.status);
  const [list, setList] = useState<SavedFace[]>([]);
  const [collapsed, setCollapsed] = useState(() => lsGet('studioex.face.presetsCollapsed', '0') === '1');
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [gallery, setGallery] = useState(false);

  // filters (shared by the strip and the gallery)
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>(() => (lsGet('studioex.face.sort', 'recent') as Sort) || 'recent');
  const [favOnly, setFavOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState<string[]>([]);

  // apply options
  const [strength, setStrength] = useState(() => Number(lsGet('studioex.face.strength', '1')));
  const [parts, setParts] = useState<string[]>(() => {
    try {
      const v = JSON.parse(lsGet('studioex.face.parts', 'null'));
      return Array.isArray(v) ? v : FACE_FEATURES.map((f) => f.id);
    } catch {
      return FACE_FEATURES.map((f) => f.id);
    }
  });
  const [clear, setClear] = useState(() => lsGet('studioex.face.clear', '1') === '1');
  const allParts = parts.length === FACE_FEATURES.length;

  const load = useCallback(() => {
    if (status !== 'open') return;
    bridge
      .request<SavedFace[]>('face.presets')
      .then((r) => setList(normalize(r)))
      .catch(() => {});
  }, [status]);
  useEffect(load, [load]);

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of list) for (const t of f.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }, [list]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const r = list.filter(
      (f) =>
        (!favOnly || f.favorite) &&
        tagFilter.every((t) => f.tags.includes(t)) &&
        (!q || f.name.toLowerCase().includes(q) || f.tags.some((t) => t.toLowerCase().includes(q)) || f.from.toLowerCase().includes(q)),
    );
    const key = (f: SavedFace) => (sort === 'recent' ? f.lastUsed || f.created : sort === 'newest' ? f.created : 0);
    return r.sort((a, b) => Number(b.favorite) - Number(a.favorite) || (sort === 'name' ? a.name.localeCompare(b.name) : key(b) - key(a)));
  }, [list, query, sort, favOnly, tagFilter]);

  // ---------------- actions ----------------
  const apply = async (f: SavedFace) => {
    if (!ids.length) return toast('Select a character first');
    try {
      await bridge.request('face.applyPreset', { ids, file: f.file, bones: scopeFor(parts), strength, clear });
      setActive(f.file);
      onApplied();
      setList((l) => l.map((x) => (x.file === f.file ? { ...x, lastUsed: Date.now() } : x)));
      toast(`${f.name} applied${ids.length > 1 ? ` to ${ids.length} characters` : ''}${allParts ? '' : ' (selected parts)'} — Ctrl+Z to undo`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const original = async () => {
    if (!ids.length) return;
    try {
      for (const id of ids) await bridge.request('face.reset', { id, bones: scopeFor(parts), mirror: false });
      setActive('');
      onApplied();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const save = async (n: string, overwrite = false) => {
    const nm = n.trim();
    if (!nm || !ids.length) return;
    if (!overwrite && list.some((p) => p.name.toLowerCase() === nm.toLowerCase()) && !window.confirm(`Replace the saved face “${nm}”?`)) return;
    try {
      setList(normalize(await bridge.request<SavedFace[]>('face.savePreset', { id: ids[0], name: nm, bones: ALL_FACE_BONES })));
      setSaving(false);
      setName('');
      toast(`Saved “${nm}”`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const update = async (f: SavedFace, patch: { name?: string; tags?: string[]; favorite?: boolean }) => {
    try {
      setList(normalize(await bridge.request<SavedFace[]>('face.updatePreset', { file: f.file, ...patch })));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const remove = async (files: string[], label: string) => {
    if (!window.confirm(`Delete ${label}? Characters that already use ${files.length > 1 ? 'them' : 'it'} keep their face.`)) return false;
    try {
      setList(normalize(await bridge.request<SavedFace[]>('face.deletePreset', { files })));
      if (active && files.includes(active)) setActive(null);
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    }
  };

  const openMenu = (e: React.MouseEvent, f: SavedFace) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { header: true, label: f.name },
        { label: 'Apply', action: () => apply(f) },
        { label: f.favorite ? 'Remove from favorites' : 'Add to favorites', action: () => update(f, { favorite: !f.favorite }) },
        { label: 'Rename…', action: () => setPrompt({ title: 'Rename saved face', value: f.name, ok: (v) => update(f, { name: v }) }) },
        {
          label: 'Edit tags…',
          action: () =>
            setPrompt({
              title: `Tags for “${f.name}”`,
              hint: 'Separate tags with commas, e.g. anime, soft, OC Rin',
              value: f.tags.join(', '),
              placeholder: 'anime, soft, …',
              ok: (v) => update(f, { tags: v.split(',').map((t) => t.trim()).filter(Boolean) }),
            }),
        },
        { label: 'Overwrite with current face…', action: () => window.confirm(`Replace “${f.name}” with the current face (and thumbnail)?`) && save(f.name, true) },
        { sep: true },
        { label: 'Delete…', danger: true, action: () => remove([f.file], `“${f.name}”`) },
      ],
    });
  };

  const toggleCollapsed = () => {
    setCollapsed(!collapsed);
    lsSet('studioex.face.presetsCollapsed', collapsed ? '0' : '1');
  };

  const filtersActive = !!query || favOnly || tagFilter.length > 0;
  const filters = (
    <FaceFilters
      query={query}
      setQuery={setQuery}
      sort={sort}
      setSort={(s) => {
        setSort(s);
        lsSet('studioex.face.sort', s);
      }}
      favOnly={favOnly}
      setFavOnly={setFavOnly}
      allTags={allTags}
      tagFilter={tagFilter}
      setTagFilter={setTagFilter}
    />
  );

  return (
    <div className={`face-presets ${collapsed ? 'collapsed' : ''}`}>
      <div className="face-presets-head">
        <button className="face-collapse" onClick={toggleCollapsed} title={collapsed ? 'Show saved faces' : 'Hide saved faces'}>
          <span className={`chev ${collapsed ? '' : 'open'}`}>▸</span>
          <strong>Saved faces</strong>
          <span className="face-count">{list.length}</span>
        </button>
        {!collapsed && (
          <>
            <span className="face-presets-sub">{ids.length > 1 ? `applies to ${ids.length} characters` : ''}</span>
            <span style={{ flex: 1 }} />
            {list.length > 0 && (
              <button className="btn small" onClick={() => setGallery(true)} title="Browse every saved face in a large gallery">
                Browse all
              </button>
            )}
            <Popover
              align="right"
              width={300}
              trigger={(open, toggle) => (
                <button className={`btn small ${open || !allParts || strength < 1 || !clear ? 'on' : ''}`} onClick={toggle} title="What a saved face changes when applied">
                  Apply options ▾
                </button>
              )}
            >
              <ApplyOptions
                parts={parts}
                setParts={(n) => {
                  setParts(n);
                  lsSet('studioex.face.parts', JSON.stringify(n));
                }}
                strength={strength}
                setStrength={(v) => {
                  setStrength(v);
                  lsSet('studioex.face.strength', String(v));
                }}
                clear={clear}
                setClear={(v) => {
                  setClear(v);
                  lsSet('studioex.face.clear', v ? '1' : '0');
                }}
              />
            </Popover>
          </>
        )}
      </div>

      {!collapsed && (
        <>
          {list.length > 6 && filters}
          <div className="face-preset-row">
            {saving ? (
              <form
                className="face-preset face-preset-save"
                onSubmit={(e) => {
                  e.preventDefault();
                  save(name);
                }}
              >
                <input className="input" autoFocus placeholder="Name…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSaving(false)} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn primary small" type="submit" disabled={!name.trim()}>
                    Save
                  </button>
                  <button className="btn small" type="button" onClick={() => setSaving(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button className="face-preset face-preset-new" title="Save the current face of the selected character" onClick={() => setSaving(true)} disabled={!ids.length}>
                <span className="face-preset-plus">+</span>
                <span className="face-preset-name">Save current</span>
              </button>
            )}
            <button className={`face-preset ${active === '' ? 'active' : ''}`} title="Back to the character’s own face (the chosen parts)" onClick={original} disabled={!ids.length}>
              <span className="face-preset-thumb face-preset-orig">↺</span>
              <span className="face-preset-name">Original</span>
            </button>
            {shown.map((f) => (
              <FaceCard key={f.file} f={f} active={active === f.file} onClick={() => apply(f)} onMenu={(e) => openMenu(e, f)} onStar={() => update(f, { favorite: !f.favorite })} />
            ))}
            {!list.length && !saving && <span className="face-presets-empty">Adjust a face, then “Save current” to keep it here.</span>}
            {list.length > 0 && !shown.length && <span className="face-presets-empty">No saved face matches{filtersActive ? ' these filters' : ''}.</span>}
          </div>
        </>
      )}

      {gallery && (
        <FaceGallery
          list={list}
          shown={shown}
          filters={filters}
          active={active}
          onApply={apply}
          onMenu={openMenu}
          onStar={(f) => update(f, { favorite: !f.favorite })}
          onDelete={(files) => remove(files, `${files.length} saved face${files.length > 1 ? 's' : ''}`)}
          onClose={() => setGallery(false)}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {prompt && <PromptDialog p={prompt} onClose={() => setPrompt(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function FaceCard({ f, active, big, selected, onClick, onMenu, onStar }: { f: SavedFace; active: boolean; big?: boolean; selected?: boolean; onClick: () => void; onMenu: (e: React.MouseEvent) => void; onStar: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`face-preset ${big ? 'big' : ''} ${active ? 'active' : ''} ${selected ? 'selected' : ''}`}
      title={`${f.name}${f.tags.length ? `\nTags: ${f.tags.join(', ')}` : ''}\nChanges: ${featuresOf(f).join(', ') || '—'}${f.from ? `\nSaved from: ${f.from}` : ''}\nClick to apply · right-click for more`}
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}
      onContextMenu={onMenu}
    >
      <button
        className={`face-star ${f.favorite ? 'on' : ''}`}
        title={f.favorite ? 'Favorite (click to remove)' : 'Add to favorites'}
        onClick={(e) => {
          e.stopPropagation();
          onStar();
        }}
      >
        {f.favorite ? '★' : '☆'}
      </button>
      {f.thumb ? <img className="face-preset-thumb" src={f.thumb} alt="" draggable={false} /> : <span className="face-preset-thumb">{f.name.slice(0, 1)}</span>}
      <span className="face-preset-name">{f.name}</span>
      {big && f.tags.length > 0 && <span className="face-preset-tags">{f.tags.join(' · ')}</span>}
    </div>
  );
}

function FaceFilters(p: {
  query: string;
  setQuery: (v: string) => void;
  sort: Sort;
  setSort: (s: Sort) => void;
  favOnly: boolean;
  setFavOnly: (v: boolean) => void;
  allTags: string[];
  tagFilter: string[];
  setTagFilter: (v: string[]) => void;
}) {
  return (
    <div className="face-filters">
      <input className="input search" placeholder="Search names and tags…" value={p.query} onChange={(e) => p.setQuery(e.target.value)} />
      <select className="input" value={p.sort} onChange={(e) => p.setSort(e.target.value as Sort)} title="Sort (favorites always first)">
        <option value="recent">Recently used</option>
        <option value="newest">Newest</option>
        <option value="name">Name</option>
      </select>
      <button className={`btn ${p.favOnly ? 'on' : ''}`} onClick={() => p.setFavOnly(!p.favOnly)} title="Show favorites only">
        ★
      </button>
      {p.allTags.length > 0 && (
        <div className="face-tagbar">
          {p.allTags.slice(0, 24).map((t) => (
            <button
              key={t}
              className={`face-tag-chip ${p.tagFilter.includes(t) ? 'on' : ''}`}
              onClick={() => p.setTagFilter(p.tagFilter.includes(t) ? p.tagFilter.filter((x) => x !== t) : [...p.tagFilter, t])}
            >
              {t}
            </button>
          ))}
          {p.tagFilter.length > 0 && (
            <button className="face-tag-chip clear" onClick={() => p.setTagFilter([])}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ApplyOptions(p: { parts: string[]; setParts: (v: string[]) => void; strength: number; setStrength: (v: number) => void; clear: boolean; setClear: (v: boolean) => void }) {
  return (
    <div className="face-apply-opts">
      <div className="hint" style={{ margin: 0 }}>
        Parts to apply
      </div>
      <div className="face-apply-parts">
        {FACE_FEATURES.map((f) => (
          <button key={f.id} className={`face-feature ${p.parts.includes(f.id) ? 'on' : ''}`} onClick={() => p.setParts(p.parts.includes(f.id) ? p.parts.filter((x) => x !== f.id) : [...p.parts, f.id])}>
            {f.label}
          </button>
        ))}
      </div>
      <label className="face-apply-row">
        Strength
        <input type="range" min={0} max={1} step={0.05} value={p.strength} onChange={(e) => p.setStrength(Number(e.target.value))} />
        <span className="mono">{Math.round(p.strength * 100)}%</span>
      </label>
      <label className="face-apply-row" title="Parts the saved face doesn't change go back to default, so switching faces is clean">
        <input type="checkbox" checked={p.clear} onChange={(e) => p.setClear(e.target.checked)} />
        Replace (reset parts the saved face doesn’t change)
      </label>
    </div>
  );
}

function FaceGallery(p: {
  list: SavedFace[];
  shown: SavedFace[];
  filters: React.ReactNode;
  active: string | null;
  onApply: (f: SavedFace) => void;
  onMenu: (e: React.MouseEvent, f: SavedFace) => void;
  onStar: (f: SavedFace) => void;
  onDelete: (files: string[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [p]);
  return (
    <div className="overlay" onClick={p.onClose}>
      <div className="dialog face-gallery" onClick={(e) => e.stopPropagation()}>
        <div className="face-gallery-head">
          <h2>Saved faces</h2>
          <span className="face-count">
            {p.shown.length} of {p.list.length}
          </span>
          <span style={{ flex: 1 }} />
          {selecting ? (
            <>
              <button className="btn" onClick={() => setSel(new Set(p.shown.map((f) => f.file)))}>
                Select all shown
              </button>
              <button
                className="btn danger"
                disabled={!sel.size}
                onClick={async () => {
                  if (await p.onDelete([...sel])) {
                    setSel(new Set());
                    setSelecting(false);
                  }
                }}
              >
                Delete {sel.size || ''}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setSelecting(false);
                  setSel(new Set());
                }}
              >
                Done
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setSelecting(true)} title="Pick several faces to delete">
              Select…
            </button>
          )}
          <button className="btn icon" onClick={p.onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        {p.filters}
        <div className="face-gallery-grid">
          {p.shown.map((f) => (
            <FaceCard
              key={f.file}
              f={f}
              big
              active={p.active === f.file}
              selected={sel.has(f.file)}
              onClick={() => {
                if (!selecting) return p.onApply(f);
                setSel((s) => {
                  const n = new Set(s);
                  if (n.has(f.file)) n.delete(f.file);
                  else n.add(f.file);
                  return n;
                });
              }}
              onMenu={(e) => p.onMenu(e, f)}
              onStar={() => p.onStar(f)}
            />
          ))}
          {!p.shown.length && <div className="empty">No saved face matches these filters.</div>}
        </div>
        <div className="hint" style={{ margin: 0 }}>
          Click a face to apply it (the gallery stays open so you can compare) · right-click for rename, tags and more · ★ keeps a face at the front.
        </div>
      </div>
    </div>
  );
}

function PromptDialog({ p, onClose }: { p: PromptState; onClose: () => void }) {
  const [v, setV] = useState(p.value);
  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="dialog"
        style={{ width: 400 }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
          p.ok(v);
        }}
      >
        <h2>{p.title}</h2>
        {p.hint && <p className="hint">{p.hint}</p>}
        <input className="input" autoFocus value={v} placeholder={p.placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onClose()} style={{ width: '100%', marginBottom: 12 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit">
            OK
          </button>
        </div>
      </form>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Help } from './Help';
import { ask } from './Dialogs';
import { parseTags, useLibMeta } from '../lib/libmeta';
import { call, toast, useStore } from '../state/store';
import { bridge } from '../bridge/client';
import { PromptDialog, type PromptState } from './PromptDialog';
import { StarIcon } from './StarIcon';
import { Slider } from './CharacterPanel';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon } from './Icon';

import { pressable } from '../lib/pressable';
interface Preset {
  file: string;
  name: string;
  note: string;
  builtin: boolean;
  groups: string[];
  thumb?: string;
}

const GROUPS = [
  { id: 'effects', label: 'Effects' },
  { id: 'toon', label: 'Toon' },
  { id: 'lights', label: 'Lights' },
  { id: 'materials', label: 'Materials' },
  { id: 'fx', label: 'Built-in effects' },
  { id: 'projectors', label: 'Projectors' },
  { id: 'xukmi', label: 'xukmi FX' },
] as const;

/** Tell every look view to re-read the scene's look after a preset/reset. */
export const lookChanged = () => window.dispatchEvent(new CustomEvent('studioex:look-changed'));

/** Look preset gallery: apply (all or some groups, any strength), save, overwrite, delete. */
export function LookPresets({ wide }: { wide?: boolean }) {
  const status = useStore((s) => s.status);
  const rules = useStore((s) => s.lookRules);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [strength, setStrength] = useState(1);
  const [groups, setGroups] = useState<Set<string>>(new Set(['effects', 'toon', 'lights', 'materials', 'fx', 'projectors', 'xukmi']));
  const [saveName, setSaveName] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Preset | null>(null);
  const [query, setQuery] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const lib = useLibMeta('looks');

  useEffect(() => {
    if (status === 'open') call<Preset[]>('look.presets').then((p) => p && setPresets(p));
  }, [status]);

  const apply = async (p: Preset) => {
    const ids = useStore.getState().studioSelection;
    const r = await call('look.applyPreset', { file: p.file, groups: [...groups], strength, ids });
    if (r) {
      lookChanged();
      lib.markUsed(p.file);
      toast(`Applied “${p.name}”${strength < 1 ? ` at ${Math.round(strength * 100)}%` : ''} — Ctrl+Z to undo`);
      // A look without a picture (the built-in starters) gets one the first time it's applied in full.
      if (!p.thumb && strength >= 1 && groups.size === GROUPS.length)
        window.setTimeout(() => {
          bridge
            .request<Preset[]>('look.thumb', { file: p.file })
            .then((l) => l && setPresets(l))
            .catch(() => {});
        }, 900);
    }
  };

  const save = async (name: string) => {
    if (!name.trim()) return toast('Name the look first');
    const r = await call<Preset[]>('look.savePreset', { name: name.trim(), groups: [...groups], materials: rules });
    if (r) {
      setPresets(r);
      setSaveName('');
      toast(`Saved look “${name.trim()}” with a thumbnail of the current view`);
    }
  };

  const q = query.trim().toLowerCase();
  // favorites first, then most recently used, then the saved order
  const list = presets
    .filter((p) => {
      const m = lib.get(p.file);
      return (!q || `${p.name} ${p.note} ${(m.tags ?? []).join(' ')}`.toLowerCase().includes(q)) && (!favOnly || m.favorite) && tagFilter.every((t) => m.tags?.includes(t));
    })
    .map((p, i) => ({ p, i, m: lib.get(p.file) }))
    .sort((a, b) => Number(!!b.m.favorite) - Number(!!a.m.favorite) || (b.m.lastUsed ?? 0) - (a.m.lastUsed ?? 0) || a.i - b.i)
    .map((x) => x.p);

  return (
    <div className={wide ? 'look-gallery wide' : 'look-gallery'}>
      <div className="look-gallery-bar">
        {wide && <input className="input" placeholder="Search looks and tags…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 200 }} />}
        <button className={`btn ${favOnly ? 'on' : ''}`} style={{ height: 24 }} title="Favorites only" onClick={() => setFavOnly(!favOnly)}>
          <StarIcon filled={favOnly} size={12} />
        </button>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {GROUPS.map((g) => (
            <button
              key={g.id}
              className={`btn solid ${groups.has(g.id) ? 'on' : ''}`}
              style={{ height: 24, fontSize: 11, padding: '0 9px' }}
              title={`Include ${g.label.toLowerCase()} when applying or saving`}
              onClick={() =>
                setGroups((s) => {
                  const n = new Set(s);
                  if (n.has(g.id)) n.delete(g.id);
                  else n.add(g.id);
                  return n;
                })
              }
            >
              {g.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 200, flex: wide ? '0 0 260px' : 1 }} title="Blend from the current look toward the preset">
          <span className="hint" style={{ margin: 0 }}>
            Strength
          </span>
          <div style={{ flex: 1 }}>
            <Slider value={strength} min={0} max={1} step={0.05} onChange={setStrength} />
          </div>
        </div>
        {wide && <span className="spacer" style={{ flex: 1 }} />}
        <Help text="Click a look to apply it (the parts lit up above, at the strength set). Looks get a thumbnail of the current view when saved — the starters the first time you apply one in full. Right-click a look to retake its thumbnail, tag it or overwrite it with the current settings." />
        <button className="btn" title="Back to Studio's default look (undoable)" onClick={() => call('look.resetDefault').then((r) => r && lookChanged())}>
          Reset to default
        </button>
      </div>

      {wide && lib.allTags.length > 0 && (
        <div className="face-tagbar">
          {lib.allTags.slice(0, 30).map((t) => (
            <button key={t} className={`face-tag-chip ${tagFilter.includes(t) ? 'on' : ''}`} onClick={() => setTagFilter(tagFilter.includes(t) ? tagFilter.filter((x) => x !== t) : [...tagFilter, t])}>
              {t}
            </button>
          ))}
          {tagFilter.length > 0 && (
            <button className="face-tag-chip clear" onClick={() => setTagFilter([])}>
              Clear
            </button>
          )}
        </div>
      )}
      <div className="look-grid">
        {list.map((p) => (
          <div {...pressable}
            key={p.file}
            className="look-card star-host"
            onClick={() => apply(p)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setMenu({
                x: ev.clientX,
                y: ev.clientY,
                items: [
                  { label: p.name, header: true },
                  { label: 'Apply', action: () => apply(p) },
                  { label: lib.get(p.file).favorite ? 'Remove from favorites' : 'Add to favorites', action: () => lib.toggleFavorite(p.file) },
                  {
                    label: 'Edit tags…',
                    action: () =>
                      setPrompt({
                        title: `Tags for “${p.name}”`,
                        hint: 'Separate tags with commas, e.g. night, warm, portrait',
                        value: (lib.get(p.file).tags ?? []).join(', '),
                        placeholder: 'night, warm, …',
                        ok: (v) => lib.setTags(p.file, parseTags(v)),
                      }),
                  },
                  {
                    label: p.thumb ? 'Retake thumbnail from the current view' : 'Take thumbnail from the current view',
                    action: () => call<Preset[]>('look.thumb', { file: p.file }).then((l) => l && (setPresets(l), toast(`New thumbnail for “${p.name}”`))),
                  },
                  { label: 'Overwrite with current look…', action: async () => (await ask(`Replace “${p.name}” (settings and thumbnail) with the current look? This can't be undone.`)) && save(p.name) },
                  { sep: true },
                  { label: 'Delete…', danger: true, action: () => setConfirmDelete(p) },
                ],
              });
            }}
            title={`${p.name}${p.note ? '\n' + p.note : ''}\nContains: ${p.groups.join(', ')}\nClick to apply · right-click for more`}
          >
            <button
              className={`face-star ${lib.get(p.file).favorite ? 'on' : ''}`}
              tabIndex={-1}
              title={lib.get(p.file).favorite ? 'Favorite (click to remove)' : 'Add to favorites'}
              onClick={(ev) => {
                ev.stopPropagation();
                lib.toggleFavorite(p.file);
              }}
            >
              <StarIcon filled={!!lib.get(p.file).favorite} />
            </button>
            {p.thumb ? <img src={p.thumb} alt="" /> : <div className="look-card-ph" title="Apply it once (all parts, full strength) to capture a preview">
                {p.name.slice(0, 1)}
                <small>preview after first use</small>
              </div>}
            <div className="look-card-name">
              {p.name}
              {wide && p.note && <div className="look-card-note">{p.note}</div>}
            </div>
          </div>
        ))}
        <div className="look-card look-card-new">
          <div className="look-card-ph">
            <Icon name="plus" size={22} />
          </div>
          <div style={{ padding: 6, display: 'flex', gap: 4 }}>
            <input className="input" style={{ flex: 1, minWidth: 0, height: 24 }} placeholder="Save current look as…" value={saveName} onChange={(ev) => setSaveName(ev.target.value)} onKeyDown={(ev) => ev.key === 'Enter' && save(saveName)} />
            <button className="btn primary" style={{ height: 24 }} onClick={() => save(saveName)}>
              Save
            </button>
          </div>
        </div>
      </div>
      {rules.length > 0 && (
        <div className="hint">
          {rules.length} material tweak{rules.length > 1 ? 's' : ''} will be saved with the next look.{' '}
          <a style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => useStore.setState({ lookRules: [] })}>
            Clear
          </a>
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {prompt && <PromptDialog p={prompt} onClose={() => setPrompt(null)} />}
      {confirmDelete && (
        <div className="overlay" onClick={() => setConfirmDelete(null)}>
          <div className="dialog" style={{ width: 380 }} onClick={(ev) => ev.stopPropagation()}>
            <h2>Delete look?</h2>
            <p style={{ color: 'var(--text-1)' }}>“{confirmDelete.name}” will be removed from UserData/StudioEX/looks. Scenes that already use it are not affected.</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  const p = confirmDelete;
                  setConfirmDelete(null);
                  call<Preset[]>('look.deletePreset', { file: p.file }).then((r) => r && setPresets(r));
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

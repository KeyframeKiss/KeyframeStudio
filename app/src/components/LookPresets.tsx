import { useEffect, useRef, useState } from 'react';
import { Help } from './Help';
import { ask } from './Dialogs';
import { parseTags, useLibMeta } from '../lib/libmeta';
import { call, toast, useStore } from '../state/store';
import { bridge } from '../bridge/client';
import { PromptDialog, type PromptState } from './PromptDialog';
import { StarIcon } from './StarIcon';
import { Slider } from './CharacterPanel';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Popover } from './Shell';
import { Icon } from './Icon';
import { SwitchCard } from './EditorBits';

import { pressable } from '../lib/pressable';
interface Preset {
  file: string;
  name: string;
  note: string;
  builtin: boolean;
  /** Colours standing in for a picture until it has one: light, mid-tone, shadow. */
  swatch?: string[];
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
/** A look without a picture: a gradient of its colours, lit from the top left like a scene. */
const AUTO_KEY = 'kf.looks.autoPicture';
const lsBool = (k: string, d: boolean) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : v === '1';
  } catch {
    return d;
  }
};
const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function swatchStyle(sw?: string[]): React.CSSProperties | undefined {
  if (!sw || sw.length < 2) return undefined;
  const [a, b, c = b] = sw;
  return {
    background: `radial-gradient(120% 90% at 18% 12%, ${a}cc 0%, transparent 55%), linear-gradient(135deg, ${a} 0%, ${b} 48%, ${c} 100%)`,
  };
}

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
  // a look without a picture gets one the first time it's applied in full (can be switched off)
  const [autoPic, setAutoPicState] = useState(() => lsBool(AUTO_KEY, true));
  const setAutoPic = (on: boolean) => {
    setAutoPicState(on);
    try {
      localStorage.setItem(AUTO_KEY, on ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };
  // retaking every picture from the current scene: how far along, and whether to stop
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const stopBatch = useRef(false);

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
      if (autoPic && !p.thumb && strength >= 1 && groups.size === GROUPS.length)
        window.setTimeout(() => {
          bridge
            .request<Preset[]>('look.thumb', { file: p.file })
            .then((l) => l && setPresets(l))
            .catch(() => {});
        }, 900);
    }
  };

  const clearPicture = (p: Preset) =>
    call<Preset[]>('look.clearThumb', { file: p.file }).then((l) => l && (setPresets(l), toast(`“${p.name}” shows its colours again`)));

  const clearAll = async () => {
    if (!(await ask('Remove the pictures of all looks? Each shows its colours until it gets a new picture.'))) return;
    const l = await call<Preset[]>('look.clearThumb', { all: true });
    if (l) (setPresets(l), toast('Pictures removed'));
  };

  // apply each look in full, take its picture of the current view, then undo them all so the scene keeps its own look
  const retakeAll = async () => {
    const all = presets;
    if (!all.length || batch) return;
    if (!(await ask(`Retake the pictures of all ${all.length} looks from the current view? Each look is applied for a moment; your scene's own look comes back afterwards.`))) return;
    stopBatch.current = false;
    let applied = 0;
    let latest: Preset[] | undefined;
    setBatch({ done: 0, total: all.length });
    try {
      for (const p of all) {
        if (stopBatch.current) break;
        if (!(await call('look.applyPreset', { file: p.file, groups: GROUPS.map((g) => g.id), strength: 1, ids: useStore.getState().studioSelection }))) break;
        applied++;
        await wait(900);
        latest = (await call<Preset[]>('look.thumb', { file: p.file })) ?? latest;
        setBatch({ done: applied, total: all.length });
      }
    } finally {
      for (let i = 0; i < applied; i++) await call('undo');
      lookChanged();
      if (latest) setPresets(latest);
      setBatch(null);
      toast(stopBatch.current ? `Stopped after ${applied} picture${applied === 1 ? '' : 's'}; the scene's look is back` : 'New pictures from this scene; its own look is back');
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
        <Help text="Click a look to apply it (the parts lit up above, at the strength set). Looks get a picture of the current view when saved, and the built-in ones the first time you apply one in full. Right-click a look to retake or remove its picture, tag it or overwrite it with the current settings." />
        {batch ? (
          <button className="btn solid" onClick={() => (stopBatch.current = true)} title="Stop; the scene's own look comes back">
            Taking pictures {batch.done}/{batch.total}… Stop
          </button>
        ) : (
          <Popover
            align="right"
            placement="down"
            width={300}
            trigger={(open, toggle) => (
              <button className={`btn solid ${open ? 'on' : ''}`} onClick={toggle} disabled={status !== 'open'}>
                <Icon name="camera" size={13} /> Pictures
              </button>
            )}
          >
            {(close) => (
              <div className="layout-menu look-pic-menu">
                <button className="menu-item" onClick={() => (close(), void retakeAll())}>
                  Retake all from this scene…
                </button>
                <button className="menu-item danger" onClick={() => (close(), void clearAll())}>
                  Remove all pictures…
                </button>
                <div className="menu-sep" />
                <SwitchCard on={autoPic} label="Picture on first use" help="A look without a picture gets one of the current view the first time you apply it in full. Off: it keeps its colours until you take one." onChange={setAutoPic} />
              </div>
            )}
          </Popover>
        )}
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
                    label: p.thumb ? 'Retake picture from the current view' : 'Take picture from the current view',
                    action: () => call<Preset[]>('look.thumb', { file: p.file }).then((l) => l && (setPresets(l), toast(`New picture for “${p.name}”`))),
                  },
                  ...(p.thumb ? [{ label: 'Remove picture (show its colours)', action: () => void clearPicture(p) }] : []),
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
            {p.thumb ? <img src={p.thumb} alt="" /> : <div className="look-card-ph look-swatch" style={swatchStyle(p.swatch)} />}
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

import { useEffect, useState } from 'react';
import { call, toast, useStore } from '../state/store';
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
] as const;

/** Tell every look view to re-read the scene's look after a preset/reset. */
export const lookChanged = () => window.dispatchEvent(new CustomEvent('studioex:look-changed'));

/** Look preset gallery: apply (all or some groups, any strength), save, overwrite, delete. */
export function LookPresets({ wide }: { wide?: boolean }) {
  const status = useStore((s) => s.status);
  const rules = useStore((s) => s.lookRules);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [strength, setStrength] = useState(1);
  const [groups, setGroups] = useState<Set<string>>(new Set(['effects', 'toon', 'lights', 'materials']));
  const [saveName, setSaveName] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Preset | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (status === 'open') call<Preset[]>('look.presets').then((p) => p && setPresets(p));
  }, [status]);

  const apply = async (p: Preset) => {
    const ids = useStore.getState().studioSelection;
    const r = await call('look.applyPreset', { file: p.file, groups: [...groups], strength, ids });
    if (r) {
      lookChanged();
      toast(`Applied “${p.name}”${strength < 1 ? ` at ${Math.round(strength * 100)}%` : ''} — Ctrl+Z to undo`);
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
  const list = presets.filter((p) => !q || `${p.name} ${p.note}`.toLowerCase().includes(q));

  return (
    <div className={wide ? 'look-gallery wide' : 'look-gallery'}>
      <div className="look-gallery-bar">
        {wide && <input className="input" placeholder="Search looks…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 200 }} />}
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
        <button className="btn" title="Back to Studio's default look (undoable)" onClick={() => call('look.resetDefault').then((r) => r && lookChanged())}>
          Reset to default
        </button>
      </div>

      <div className="look-grid">
        {list.map((p) => (
          <div {...pressable}
            key={p.file}
            className="look-card"
            onClick={() => apply(p)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setMenu({
                x: ev.clientX,
                y: ev.clientY,
                items: [
                  { label: p.name, header: true },
                  { label: 'Apply', action: () => apply(p) },
                  { label: 'Overwrite with current look…', action: () => window.confirm(`Replace “${p.name}” (settings and thumbnail) with the current look? This can't be undone.`) && save(p.name) },
                  { sep: true },
                  { label: 'Delete…', danger: true, action: () => setConfirmDelete(p) },
                ],
              });
            }}
            title={`${p.name}${p.note ? '\n' + p.note : ''}\nContains: ${p.groups.join(', ')}\nClick to apply · right-click for more`}
          >
            {p.thumb ? <img src={p.thumb} alt="" /> : <div className="look-card-ph">{p.name.slice(0, 1)}</div>}
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
      <div className="hint">Saved looks remember a thumbnail of the current view. Right-click a look to overwrite it with the current settings (also refreshes its thumbnail).</div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
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

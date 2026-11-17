import { useEffect, useMemo, useState } from 'react';
import { bridge } from '../bridge/client';
import { call, toast, useStore } from '../state/store';

interface Entry {
  section: string;
  key: string;
  kind: 'bool' | 'enum' | 'flags' | 'int' | 'float' | 'string' | 'shortcut' | 'color' | 'text';
  type: string;
  value: string;
  default: string;
  description: string;
  options?: string[];
  min?: number;
  max?: number;
  label?: string;
  advanced?: boolean;
  readOnly?: boolean;
  order?: number;
}
interface PluginCfg {
  guid: string;
  name: string;
  version: string;
  entries: Entry[];
}

/** Every BepInEx plugin setting, searchable — replaces the in-game F1 configuration window. */
export function ModSettings() {
  const [plugins, setPlugins] = useState<PluginCfg[] | null>(null);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const status = useStore((s) => s.status);
  useEffect(() => {
    if (status === 'open') call<PluginCfg[]>('config.list').then((p) => p && setPlugins(p));
  }, [status]);

  const q = query.trim().toLowerCase();
  const matchEntry = (p: PluginCfg, e: Entry) =>
    (advanced || !e.advanced) &&
    (!onlyChanged || e.value !== e.default) &&
    (!q || `${p.name} ${e.section} ${e.key} ${e.label ?? ''} ${e.description}`.toLowerCase().includes(q));

  const filtered = useMemo(
    () => (plugins ?? []).map((p) => ({ ...p, entries: p.entries.filter((e) => matchEntry(p, e)) })).filter((p) => p.entries.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plugins, q, onlyChanged, advanced],
  );
  const shown = q || onlyChanged ? filtered : filtered.filter((p) => p.guid === (sel ?? filtered[0]?.guid));

  const update = (guid: string, e: Entry, next: Entry) =>
    setPlugins((ps) => ps && ps.map((p) => (p.guid !== guid ? p : { ...p, entries: p.entries.map((x) => (x.section === e.section && x.key === e.key ? next : x)) })));

  const save = async (p: PluginCfg, e: Entry, value: string) => {
    try {
      const r = await bridge.request<Entry>('config.set', { guid: p.guid, section: e.section, key: e.key, value });
      update(p.guid, e, r);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const reset = async (p: PluginCfg, e: Entry) => {
    const r = await call<Entry>('config.reset', { guid: p.guid, section: e.section, key: e.key });
    if (r) update(p.guid, e, r);
  };

  const total = plugins?.reduce((n, p) => n + p.entries.length, 0) ?? 0;

  return (
    <div className="page">
      <div className="page-inner">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
          <h2 style={{ margin: 0 }}>Mod settings</h2>
          <input className="input" autoFocus placeholder={`Search ${total} settings in ${plugins?.length ?? 0} plugins…`} value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, maxWidth: 420 }} />
          <button className={`btn ${onlyChanged ? 'on' : ''}`} onClick={() => setOnlyChanged((v) => !v)} title="Only settings that differ from their default">
            Changed only
          </button>
          <button className={`btn ${advanced ? 'on' : ''}`} onClick={() => setAdvanced((v) => !v)} title="Show settings plugins mark as advanced">
            Advanced
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          <span className="hint" style={{ margin: 0 }}>
            Saved instantly to BepInEx/config
          </span>
        </div>
        {!plugins ? (
          <div className="empty">Loading settings…</div>
        ) : (
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: q || onlyChanged ? '1fr' : '260px 1fr', minHeight: 0 }}>
            {!(q || onlyChanged) && (
              <div className="panel-body" style={{ borderRight: '1px solid var(--line)' }}>
                {filtered.map((p) => (
                  <div key={p.guid} className={`tree-row ${p.guid === (sel ?? filtered[0]?.guid) ? 'selected' : ''}`} style={{ paddingLeft: 10 }} onClick={() => setSel(p.guid)} title={`${p.guid} v${p.version}`}>
                    <span className="name">{p.name}</span>
                    <span className="sub">{p.entries.length}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="panel-body" style={{ padding: '4px 0' }}>
              {shown.map((p) => (
                <div key={p.guid}>
                  <div className="model-group-title" style={{ fontSize: 12, color: 'var(--text-0)', textTransform: 'none', letterSpacing: 0, padding: '10px 16px 6px' }}>
                    {p.name} <span className="sub" style={{ color: 'var(--text-3)', fontWeight: 400 }}>v{p.version}</span>
                  </div>
                  {groupBySection(p.entries).map(([section, entries]) => (
                    <div key={section} style={{ padding: '0 16px 8px' }}>
                      <div className="hint" style={{ margin: '6px 0 4px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>
                        {section}
                      </div>
                      {entries.map((e) => (
                        <SettingRow key={e.section + '/' + e.key} e={e} onSave={(v) => save(p, e, v)} onReset={() => reset(p, e)} />
                      ))}
                    </div>
                  ))}
                </div>
              ))}
              {!shown.length && <div className="empty">No settings match.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function groupBySection(entries: Entry[]): [string, Entry[]][] {
  const m = new Map<string, Entry[]>();
  for (const e of [...entries].sort((a, b) => (b.order ?? 0) - (a.order ?? 0))) {
    const l = m.get(e.section) ?? [];
    l.push(e);
    m.set(e.section, l);
  }
  return [...m.entries()];
}

function SettingRow({ e, onSave, onReset }: { e: Entry; onSave: (v: string) => void; onReset: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const changed = e.value !== e.default;
  const commitText = () => {
    if (draft !== null && draft !== e.value) onSave(draft);
    setDraft(null);
  };
  let control: React.ReactNode;
  if (e.readOnly) control = <span className="value">{e.value}</span>;
  else if (e.kind === 'bool')
    control = (
      <button className={`btn solid ${e.value === 'true' ? 'on' : ''}`} onClick={() => onSave(e.value === 'true' ? 'false' : 'true')}>
        {e.value === 'true' ? 'On' : 'Off'}
      </button>
    );
  else if (e.options && e.kind !== 'flags')
    control = (
      <select className="input" value={e.value} onChange={(ev) => onSave(ev.target.value)}>
        {e.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  else if ((e.kind === 'int' || e.kind === 'float') && e.min !== undefined && e.max !== undefined)
    control = (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="range"
          min={e.min}
          max={e.max}
          step={e.kind === 'int' ? 1 : (e.max - e.min) / 200}
          value={Number(draft ?? e.value)}
          style={{ flex: 1, accentColor: 'var(--accent)' }}
          onChange={(ev) => setDraft(ev.target.value)}
          onPointerUp={commitText}
          onKeyUp={commitText}
        />
        <input className="input mono" style={{ width: 80 }} value={draft ?? e.value} onChange={(ev) => setDraft(ev.target.value)} onBlur={commitText} onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()} />
      </div>
    );
  else if (e.kind === 'color')
    control = (
      <input
        type="color"
        value={'#' + e.value.slice(0, 6).toLowerCase()}
        onChange={(ev) => onSave(ev.target.value.slice(1).toUpperCase() + (e.value.length >= 8 ? e.value.slice(6, 8) : 'FF'))}
        style={{ width: 60, height: 26, background: 'none', border: 0 }}
      />
    );
  else
    control = (
      <input
        className="input mono"
        style={{ width: '100%' }}
        value={draft ?? e.value}
        placeholder={e.kind === 'shortcut' ? 'e.g. LeftControl + T' : ''}
        onChange={(ev) => setDraft(ev.target.value)}
        onBlur={commitText}
        onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()}
      />
    );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(220px, 1.3fr) 28px', gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <div title={e.description} style={{ minWidth: 0 }}>
        <div style={{ color: changed ? 'var(--accent)' : 'var(--text-0)' }}>{e.label ?? e.key}</div>
        {e.description && <div className="hint" style={{ margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.description}</div>}
      </div>
      <div style={{ minWidth: 0 }}>{control}</div>
      {changed && !e.readOnly ? (
        <button className="btn icon" title={`Reset to default (${e.default})`} onClick={onReset}>
          ↺
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

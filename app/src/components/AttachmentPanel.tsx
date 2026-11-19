import { useEffect, useId, useState } from 'react';
import { bridge } from '../bridge/client';
import { displayName, useStore } from '../state/store';
import { TypeIcon } from './Icon';
import { Vec } from './AbmxSection';

const targetTypes: Record<string, string> = { Char: 'Characters', Item: 'Items', Folder: 'Folders', Light: 'Lights', Camera: 'Cameras' };
type Vector = [number, number, number];
interface Link {
  key: number;
  label: string;
  enabled: boolean;
  managed: boolean;
  position: Vector;
  rotation: Vector;
}
interface AttachmentState { instance: number; links: Link[] }

export function AttachmentPanel({ id, focusSearch = false }: { id: number; focusSearch?: boolean }) {
  const nodes = useStore(s => s.nodes);
  const connected = useStore(s => s.status === 'open');
  const hello = useStore(s => s.hello);
  const feature = hello?.features?.find(f => f.id === 'attachments');
  const available = connected && (feature?.status === 'ok' || feature?.status === 'untested');
  const [state, setState] = useState<AttachmentState>();
  const group = useId();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [parent, setParent] = useState('');
  const [bone, setBone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<number>).detail === id) setReload(r => r + 1);
    };
    window.addEventListener('kf:attachment-dialog-closed', refresh);
    return () => window.removeEventListener('kf:attachment-dialog-closed', refresh);
  }, [id]);
  useEffect(() => {
    let active = true;
    if (available) {
      setState(undefined);
      setError('');
      bridge.request<AttachmentState>('attachment.get', { id }).then(s => {
        if (active) setState(s);
      }).catch(e => active && setError(e.message));
    }
    return () => { active = false; };
  }, [id, available, reload]);

  async function change(command: string, args: Record<string, unknown>) {
    if (!state || busy) return;
    setBusy(true);
    setError('');
    try {
      setState(await bridge.request<AttachmentState>(command, { id, instance: state.instance, ...args }));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (!available) {
    let message = 'Start CharaStudio and wait for the editor to connect.';
    if (connected && !hello) message = 'Waiting for CharaStudio to report its installed plugins.';
    if (connected && hello && !feature) message = 'Update the Keyframe Studio bridge. Close CharaStudio, copy KKStudioEX.Bridge.dll from the release into BepInEx/plugins/KKStudioEX in your game folder, then start CharaStudio again.';
    if (connected && feature) message = feature.reason ?? 'Check NodesConstraints in Settings → About & diagnostics.';
    return <p role="status">{message}</p>;
  }
  const candidates = Object.values(nodes).filter(n => n.id >= 0 && n.id !== id && targetTypes[n.type]);
  const terms = query.trim().toLowerCase().split(/\s+/);
  const matches = candidates.filter(n => {
    const name = [displayName(n), n.name, targetTypes[n.type]].join(' ').toLowerCase();
    return (!filter || n.type === filter) && terms.every(term => name.includes(term));
  }).sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true }) || a.id - b.id);
  const selected = matches.find(n => String(n.id) === parent);
  const choose = (next: string) => { setParent(next); setBone(''); };
  return <div className="section">
    {error && <p role="alert">{error}</p>}
    {!state && !error && <p>Loading attachment…</p>}
    {state && <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
      {!state.links.length && <>
        <div className="attachment-picker">
          <label className="attachment-search">Find a target
            <input className="input" type="search" placeholder="Search scene objects…" autoFocus={focusSearch}
              value={query} onChange={e => { setQuery(e.target.value); choose(''); }} />
          </label>
          <div className="attachment-filters" role="group" aria-label="Filter targets by type">
            {['', ...Object.keys(targetTypes).filter(type => candidates.some(n => n.type === type) || type === filter)].map(type =>
              <button key={type} className="btn small" aria-pressed={filter === type}
                onClick={() => { setFilter(type); choose(''); }}>{targetTypes[type] ?? 'All'}</button>)}
          </div>
          <span className="hint" role="status">{matches.length} {matches.length === 1 ? 'target' : 'targets'}</span>
          {matches.length > 0 ? <div className="attachment-targets" role="radiogroup" aria-label="Scene targets">
            {matches.map(n => <label key={n.id}>
              <input type="radio" name={group} checked={selected?.id === n.id} onChange={() => choose(String(n.id))} />
              <TypeIcon type={n.type} sex={n.sex} /><span>{displayName(n)}</span><small>#{n.id}</small>
            </label>)}
          </div> : <div className="attachment-empty">{candidates.length ? <>
            No matching targets. <button className="btn small" onClick={() => { setQuery(''); setFilter(''); choose(''); }}>Clear filters</button>
          </> : 'Add another scene object to use as a target.'}</div>}
          {selected?.type === 'Char' && <div>
            <b>Joint</b>
            <div className="attachment-filters" role="group" aria-label="Character joint">
              {['', 'Right hand', 'Left hand', 'Head', 'Chest', 'Hips'].map(joint =>
                <button key={joint} className="btn small" aria-pressed={bone === joint} onClick={() => setBone(joint)}>{joint || 'Character root'}</button>)}
            </div>
          </div>}
          <button className="btn primary" disabled={!selected} title="Keep the prop in its current position and rotation"
            onClick={() => selected && change('attachment.create', { parent: selected.id, bone })}>
            {selected ? `Attach to ${displayName(selected)}${bone ? ' / ' + bone : ''}` : 'Choose a target to attach'}
          </button>
        </div>
      </>}
      {state.links.map(link => <div key={link.key}>
        <strong>{link.label}</strong>
        {link.managed ? <>
          <Grip key={JSON.stringify([link.position, link.rotation])} link={link} apply={(action, value) => change('attachment.edit', { key: link.key, action, value })} />
          <button className="btn" onClick={() => change('attachment.edit', { key: link.key, action: 'enabled', value: !link.enabled })}>{link.enabled ? 'Pause link' : 'Resume link'}</button>
          <button className="btn" onClick={() => change('attachment.edit', { key: link.key, action: 'detach' })}>Detach</button>
        </> : <p className="hint">Manage this link in NodesConstraints.</p>}
      </div>)}
    </fieldset>}
    <button className="btn small" disabled={busy} onClick={() => setReload(r => r + 1)}>Refresh attachments</button>
  </div>;
}

function Grip({ link, apply }: { link: Link; apply: (action: string, value: Vector) => void }) {
  return <>{(['position', 'rotation'] as const).map(kind =>
    <Offset key={kind} kind={kind} initial={link[kind]} apply={v => apply(kind, v)} />)}</>;
}

function Offset({ kind, initial, apply }: { kind: 'position' | 'rotation'; initial: Vector; apply: (v: Vector) => void }) {
  const [value, setValue] = useState(initial);
  return <div>
    <Vec label={kind === 'position' ? 'Grip position' : 'Grip rotation'} v={value} step={kind === 'position' ? 0.01 : 0.5} onChange={setValue} />
    <button className="btn small" disabled={value.every((n, i) => n === initial[i])} onClick={() => apply(value)}>Apply {kind}</button>
  </div>;
}

import { useEffect, useMemo, useState } from 'react';
import { call, setWorkspace, toast, useStore } from '../state/store';

interface SceneFile {
  path: string;
  rel: string;
  size: number;
  modified: number;
}

const canThumb = !!window.studioEx?.isElectron;
const thumbUrl = (p: string) => `sximg://thumb/?p=${encodeURIComponent(p)}`;

export function SceneBrowser() {
  const [scenes, setScenes] = useState<SceneFile[]>([]);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; run: () => void } | null>(null);
  const close = () => setWorkspace('animate');

  const load = () => call<SceneFile[]>('scene.list').then((s) => s && setScenes(s.sort((a, b) => b.modified - a.modified)));
  // (Re)load once Studio is connected: the app often starts on this page before the bridge is up.
  const status = useStore((s) => s.status);
  useEffect(() => {
    if (status === 'open') load();
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const folders = useMemo(() => {
    const set = new Set<string>();
    scenes.forEach((s) => {
      const i = s.rel.lastIndexOf('\\');
      set.add(i > 0 ? s.rel.slice(0, i) : '');
    });
    return [...set].sort();
  }, [scenes]);
  const [folder, setFolder] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const list = scenes.filter((s) => (!q || s.rel.toLowerCase().includes(q)) && (folder === null || (s.rel.lastIndexOf('\\') > 0 ? s.rel.slice(0, s.rel.lastIndexOf('\\')) : '') === folder));
  const selected = scenes.find((s) => s.path === sel);

  const ask = (text: string, run: () => void) => setConfirm({ text, run });

  const loadScene = (s: SceneFile) =>
    ask(`Load “${s.rel}”? The current scene is replaced — unsaved changes are lost.`, async () => {
      if ((await call('scene.load', { path: s.path })) !== undefined) {
        toast('Loading scene…');
        close();
      }
    });

  return (
    <div className="page">
      <div className="page-inner">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
          <h2 style={{ margin: 0 }}>Scenes</h2>
          <input className="input" autoFocus placeholder="Search scenes…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 260 }} />
          {folders.length > 1 && (
            <select className="input" value={folder ?? '*'} onChange={(e) => setFolder(e.target.value === '*' ? null : e.target.value)}>
              <option value="*">All folders</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f || '(root)'}
                </option>
              ))}
            </select>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          <button
            className="btn solid"
            onClick={() =>
              ask('Start a new, empty scene? Unsaved changes are lost.', async () => {
                if ((await call('scene.new')) !== undefined) close();
              })
            }
          >
            New scene
          </button>
          <button
            className="btn primary"
            title="Save the current scene as a new file (same as Studio's Save)"
            onClick={async () => {
              if ((await call('scene.save')) !== undefined) {
                toast('Scene saved');
                window.setTimeout(load, 1500);
              }
            }}
          >
            Save current
          </button>
        </div>
        <div className="panel-body" style={{ padding: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10 }}>
            {list.map((s) => (
              <div
                key={s.path}
                onClick={() => setSel(s.path)}
                onDoubleClick={() => loadScene(s)}
                style={{
                  borderRadius: 8,
                  overflow: 'hidden',
                  cursor: 'pointer',
                  background: 'var(--bg-2)',
                  border: `2px solid ${sel === s.path ? 'var(--accent)' : 'transparent'}`,
                }}
                title={`${s.rel}\n${(s.size / 1024 / 1024).toFixed(1)} MB · ${new Date(s.modified).toLocaleString()}\nDouble-click to load`}
              >
                <div style={{ aspectRatio: '16 / 9', background: 'var(--bg-0)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
                  {canThumb ? <img src={thumbUrl(s.path)} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" /> : 'PNG'}
                </div>
                <div style={{ padding: '6px 8px' }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-0)' }}>{s.rel.replace(/\.png$/i, '')}</div>
                  <div className="sub" style={{ color: 'var(--text-3)', fontSize: 10 }}>
                    {new Date(s.modified).toLocaleDateString()} · {(s.size / 1024 / 1024).toFixed(1)} MB
                  </div>
                </div>
              </div>
            ))}
          </div>
          {!list.length && <div className="empty">No scenes found in UserData/studio/scene.</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 16px', borderTop: '1px solid var(--line)' }}>
          <span style={{ color: 'var(--text-2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected ? selected.rel : `${list.length} scenes`}</span>
          <button
            className="btn solid"
            disabled={!selected}
            title="Add this scene's objects to the current scene"
            onClick={async () => {
              if (selected && (await call('scene.import', { path: selected.path })) !== undefined) {
                toast('Scene imported');
                close();
              }
            }}
          >
            Import (merge)
          </button>
          <button className="btn primary" disabled={!selected} onClick={() => selected && loadScene(selected)}>
            Load
          </button>
        </div>
      </div>
      {confirm && (
        <div className="overlay" onClick={(e) => { e.stopPropagation(); setConfirm(null); }}>
          <div className="dialog" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
            <h2>Are you sure?</h2>
            <p style={{ color: 'var(--text-1)', lineHeight: 1.6 }}>{confirm.text}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                autoFocus
                onClick={() => {
                  const run = confirm.run;
                  setConfirm(null);
                  run();
                }}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

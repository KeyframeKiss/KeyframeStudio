import { useEffect, useState } from 'react';
import { bridge } from '../bridge/client';
import { toast, useStore } from '../state/store';
import { Icon } from './Icon';
import { Popover } from './Shell';
import { NumberField } from './TopBar';

interface VpState {
  paths: boolean;
  pathsCamera: boolean;
  ghosts: boolean;
  ghostsAuto: boolean;
  ghostCount: number;
  ghostMode: 'keys' | 'step';
  ghostStep: number;
  ghostOpacity: number;
}

/** Motion paths + onion skin toggles for Studio's 3D viewport. */
export function ViewportControls() {
  const status = useStore((s) => s.status);
  const pending = useStore((s) => s.pending);
  const revision = useStore((s) => s.revision);
  const [st, setSt] = useState<VpState | null>(null);

  // Re-read on every scene/timeline refresh: the plugin's state can change outside this window.
  useEffect(() => {
    if (status !== 'open') return;
    bridge.request<VpState>('viewport.get').then(setSt).catch(() => setSt(null));
  }, [status, revision]);

  if (!st) return null;
  const set = (patch: Partial<VpState>) => {
    setSt({ ...st, ...patch });
    bridge
      .request<VpState>('viewport.set', patch)
      .then(setSt)
      .catch((e) => toast((e as Error).message, 'error'));
  };

  return (
    <div className="group">
      <button className={`btn ${st.paths ? 'on' : ''}`} title="Motion paths in Studio's viewport for the selected objects" onClick={() => set({ paths: !st.paths })}>
        <Icon name="paths" size={14} /> Paths
      </button>
      <button
        className={`btn ${st.ghosts ? 'on' : ''}`}
        title={`Onion skin: translucent copies at neighbouring keys (blue = before, orange = after)${pending ? ' — paused while you have unkeyed changes' : ''}`}
        onClick={() => set({ ghosts: !st.ghosts })}
      >
        <Icon name="ghost" size={14} /> Ghosts{st.ghosts && pending > 0 ? ' ⏸' : ''}
      </button>
      <Popover
        align="right"
        width={280}
        trigger={(open, toggle) => (
          <button className={`btn icon ${open ? 'on' : ''}`} title="Path & ghost options" onClick={toggle}>
            <Icon name="chevronDown" size={12} />
          </button>
        )}
      >
        <div style={{ display: 'grid', gap: 10, padding: 6 }}>
          <div className="menu-label" style={{ padding: 0 }}>
            Motion paths
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={st.pathsCamera} onChange={(e) => set({ pathsCamera: e.target.checked })} />
            Include camera target path
          </label>
          <div className="menu-sep" />
          <div className="menu-label" style={{ padding: 0 }}>
            Onion skin
          </div>
          <div className="seg">
            <button className={st.ghostMode === 'keys' ? 'on' : ''} onClick={() => set({ ghostMode: 'keys' })}>
              At keys
            </button>
            <button className={st.ghostMode === 'step' ? 'on' : ''} onClick={() => set({ ghostMode: 'step' })}>
              Every…
            </button>
          </div>
          {st.ghostMode === 'step' && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              Step
              <NumberField
                value={st.ghostStep}
                width={70}
                format={(v) => v.toFixed(2)}
                parse={(t) => {
                  const n = Number(t.replace(',', '.').replace(/s$/i, ''));
                  return Number.isFinite(n) && n > 0 ? Math.max(0.02, n) : null;
                }}
                onCommit={(v) => set({ ghostStep: v })}
              />
              s
            </label>
          )}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            Each side
            <input type="range" min={1} max={5} value={st.ghostCount} onChange={(e) => set({ ghostCount: Number(e.target.value) })} style={{ flex: 1, accentColor: 'var(--accent)' }} />
            <b>{st.ghostCount}</b>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            Opacity
            <input type="range" min={0.05} max={0.8} step={0.01} value={st.ghostOpacity} onChange={(e) => set({ ghostOpacity: Number(e.target.value) })} style={{ flex: 1, accentColor: 'var(--accent)' }} />
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={st.ghostsAuto} onChange={(e) => set({ ghostsAuto: e.target.checked })} />
            Update automatically
          </label>
          <button
            className="btn solid"
            onClick={() =>
              bridge
                .request('viewport.refreshGhosts')
                .then(() => toast('Ghosts updated'))
                .catch((e) => toast((e as Error).message, 'error'))
            }
          >
            Update ghosts now
          </button>
          <div className="hint" style={{ margin: 0 }}>
            Ghosts are built by briefly jumping to other times (a quick flicker in Studio). They wait while you have unkeyed changes so your pose is never reset.
          </div>
        </div>
      </Popover>
    </div>
  );
}

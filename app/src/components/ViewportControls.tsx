import { useEffect } from 'react';
import { create } from 'zustand';
import { bridge } from '../bridge/client';
import { toast, useStore } from '../state/store';
import { Help } from './Help';
import { Icon } from './Icon';
import { NumberField } from './TopBar';

interface VpState {
  paths: boolean;
  pathsCamera: boolean;
  pathsBody: boolean;
  pathsBones: string;
  pathsDrawn: number;
  pathsBaking: boolean;
  /** why nothing is drawn (empty when paths show) */
  pathsNote: string;
  ghosts: boolean;
  ghostsAuto: boolean;
  ghostCount: number;
  ghostMode: 'keys' | 'step';
  ghostStep: number;
  ghostOpacity: number;
}

/** Motion paths + onion skin in Studio's view: one shared state for the toggles and the options. */
const useVp = create<{ st: VpState | null }>(() => ({ st: null }));

function setVp(patch: Partial<VpState>) {
  const st = useVp.getState().st;
  if (!st) return;
  useVp.setState({ st: { ...st, ...patch } });
  bridge
    .request<VpState>('viewport.set', patch)
    .then((s) => useVp.setState({ st: s }))
    .catch((e) => toast((e as Error).message, 'error'));
}

const read = () =>
  bridge
    .request<VpState>('viewport.get')
    .then((s) => useVp.setState({ st: s }))
    .catch(() => useVp.setState({ st: null }));

/** Keeps the shared state in step with Studio (mount once). */
export function PathsGhostsSync() {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  const st = useVp((s) => s.st);
  // re-read on every scene/timeline refresh: the plugin's state can change outside this window
  useEffect(() => {
    if (status === 'open') read();
  }, [status, revision]);
  // body paths are traced in the background: Studio says when they're drawn
  useEffect(() => bridge.on('viewport.changed', (d) => useVp.setState({ st: d as VpState })), []);
  // while paths are on but empty, re-read now and then (selection changes in Studio don't bump the revision)
  const empty = !!st?.paths && !!st.pathsNote;
  useEffect(() => {
    if (!empty || status !== 'open') return;
    const h = window.setInterval(read, 1500);
    return () => window.clearInterval(h);
  }, [empty, status]);
  return null;
}

/** The Paths and Ghosts toggles (icons; the names are in the tooltips). */
export function PathsGhostsToggles() {
  const st = useVp((s) => s.st);
  const pending = useStore((s) => s.pending);
  if (!st) return null;
  const empty = !!st.paths && !!st.pathsNote;
  return (
    <>
      <button
        className={`btn icon ${st.paths ? 'on' : ''} ${empty ? 'paths-empty' : ''}`}
        title={empty ? `Motion paths — ${st.pathsNote}` : "Motion paths: where the selection travels over the timeline, drawn in Studio's view (dots at keys)"}
        aria-pressed={st.paths}
        onClick={() => {
          const on = !st.paths;
          setVp({ paths: on });
          // say right away when there'll be nothing to see
          if (on)
            window.setTimeout(
              () =>
                bridge
                  .request<VpState>('viewport.get')
                  .then((v) => {
                    useVp.setState({ st: v });
                    if (v.pathsNote && !v.pathsBaking) toast(`Paths: ${v.pathsNote}`, 'info');
                  })
                  .catch(() => {}),
              700,
            );
        }}
      >
        <Icon name="paths" size={15} />
        {empty && !st.pathsBaking && <span className="paths-dot" />}
      </button>
      <button
        className={`btn icon ${st.ghosts ? 'on' : ''}`}
        title={`Ghosts (onion skin): see-through copies at neighbouring keys — blue before, orange after${st.ghosts && pending ? ' — paused while you have unkeyed changes' : ''}`}
        aria-pressed={st.ghosts}
        onClick={() => setVp({ ghosts: !st.ghosts })}
      >
        <Icon name="ghost" size={15} />
      </button>
    </>
  );
}

/** Paths and ghosts settings (in the view options popover). */
export function PathsGhostsOptions() {
  const st = useVp((s) => s.st);
  if (!st) return <div className="hint">Not connected to Studio.</div>;
  const set = setVp;
  return (
    <div style={{ display: 'grid', gap: 10, padding: 6 }}>
      <label className="vo-check" style={{ fontWeight: 600 }}>
        <input type="checkbox" checked={st.paths} onChange={(e) => set({ paths: e.target.checked })} />
        Motion paths
        <Help text="Lines in Studio's view showing where things travel over the timeline, with dots at keys. Objects, items, IK targets and the camera target follow their position keys. For characters, the hands, feet and head are traced by quickly stepping through the timeline once (a short flicker in Studio) whenever the animation changes; it waits while you have unkeyed changes." />
      </label>
      {st.paths && st.pathsNote && <div className="paths-note">{st.pathsNote}</div>}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={st.pathsBody} onChange={(e) => set({ pathsBody: e.target.checked })} />
        Characters' body
      </label>
      {st.pathsBody && (
        <div className="seg" style={{ marginLeft: 22 }}>
          {(['hands', 'feet', 'head'] as const).map((b) => {
            const on = st.pathsBones.split(',').includes(b);
            return (
              <button
                key={b}
                className={on ? 'on' : ''}
                onClick={() =>
                  set({
                    pathsBones: (['hands', 'feet', 'head'] as const).filter((x) => (x === b ? !on : st.pathsBones.split(',').includes(x))).join(','),
                  })
                }
              >
                {b[0].toUpperCase() + b.slice(1)}
              </button>
            );
          })}
        </div>
      )}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={st.pathsCamera} onChange={(e) => set({ pathsCamera: e.target.checked })} />
        Camera target
      </label>
      <div className="menu-sep" />
      <label className="vo-check" style={{ fontWeight: 600 }}>
        <input type="checkbox" checked={st.ghosts} onChange={(e) => set({ ghosts: e.target.checked })} />
        Ghosts (onion skin)
        <Help text="Translucent copies of the selection at neighbouring keys (blue before, orange after). They're built by briefly jumping to other times (a quick flicker in Studio) and wait while you have unkeyed changes so your pose is never reset." />
      </label>
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
    </div>
  );
}

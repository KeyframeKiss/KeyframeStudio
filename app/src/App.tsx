import { useEffect } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { DialogHost } from './components/Dialogs';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PreviewPanel } from './components/PreviewPanel';
import { AnimationsOverlay } from './components/AnimationsOverlay';
import { RecordingBadge } from './components/QuickActions';
import { MessagesButton, ToastItem } from './components/Messages';
import { CameraTakeoverChip, toggleGuides } from './components/CameraToolsCards';
import { Header, MiniHeader, TransportBar } from './components/Shell';
import { DopeSheet } from './components/DopeSheet';
import { SHORTCUTS } from './components/shortcuts';
import { Disconnected, AnimateWorkspace, LibraryWorkspace, LookWorkspace, PoseWorkspace, SettingsWorkspace, ShootWorkspace } from './components/Workspaces';
import { PRESETS, toFlat } from './lib/curve';
import { isInteractive } from './lib/pressable';
import { startAutoTranslate } from './lib/translate';
import { startUpdateChecks } from './lib/updates';
import { installStudioHotkeys } from './lib/studioHotkeys';
import {
  applyCurveToSelected,
  copySelected,
  deleteSelectedKeys,
  duplicateSelectedToPlayhead,
  initBridge,
  jumpKey,
  keyAllOfSelectedObjects,
  keyChanged,
  keySelected,
  lsSet,
  openLibrary,
  pasteAtPlayhead,
  redo,
  resetPose,
  seek,
  selectAllKeys,
  selectKeys,
  setAutoKey,
  setWorkspace,
  stepFrames,
  togglePlay,
  undo,
  useStore,
  useTlInfo,
  type Workspace,
  setMiniMode,
} from './state/store';
import { bridge } from './bridge/client';

const WS_KEYS: Record<string, Workspace> = { '1': 'animate', '2': 'pose', '3': 'look', '4': 'shoot', '5': 'library' };

// development builds: the app's state for test scripts over the debugging connection (not in release builds)
if (import.meta.env.DEV) (window as unknown as { __kfStore: typeof useStore }).__kfStore = useStore;

export function App() {
  const status = useStore((s) => s.status);
  const hello = useStore((s) => s.hello);
  const tl = useTlInfo();
  const toasts = useStore((s) => s.toasts);
  const miniMode = useStore((s) => s.miniMode);
  const workspace = useStore((s) => s.workspace);
  const helpOpen = useStore((s) => s.helpOpen);
  const nodeCount = useStore((s) => Object.values(s.nodes).filter((n) => n.type !== 'node').length);
  const trackCount = useStore((s) => s.tracks.length);
  const keyCount = useStore((s) => s.tracks.reduce((n, t) => n + t.keys.length, 0));
  const pending = useStore((s) => s.pending);
  const autoKey = useStore((s) => s.autoKey);
  const poseStale = useStore((s) => s.poseStale);

  const translateJob = useStore((s) => s.translateJob);
  const previewOpen = useStore((s) => s.previewOpen);

  useEffect(() => {
    initBridge();
    startAutoTranslate();
    startUpdateChecks();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // Global, even while typing
      if (ctrl && k === 'k') {
        e.preventDefault();
        useStore.setState({ paletteOpen: !st.paletteOpen });
        return;
      }
      // mini mode on/off, from anywhere
      if (ctrl && e.shiftKey && k === 'm') {
        e.preventDefault();
        setMiniMode(!st.miniMode);
        return;
      }
      if (st.paletteOpen) return;
      if (ctrl && WS_KEYS[k]) {
        e.preventDefault();
        setWorkspace(WS_KEYS[k]);
        return;
      }
      if (k === 'f1' && !ctrl) {
        e.preventDefault();
        useStore.setState({ helpOpen: false });
        openLibrary('help');
        return;
      }
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      // Help overlay open: only its own keys (Esc / ?) — never delete keys etc. behind it.
      if (document.querySelector('.overlay, dialog[open]') && !st.helpOpen) return;
      if (st.helpOpen && k !== 'escape' && e.key !== '?') return;
      // Holding a key: only stepping/zooming should repeat; K, Delete, Ctrl+Z… would spam edits.
      // Keyboard navigation: a control reached with the keyboard handles its own Enter/Space. (After a mouse
      // click focus stays on the button but isn't "visible", so Space still plays.) Tab moves focus, except
      // with the pointer over the timeline, where it switches Dope sheet ↔ Graph.
      if ((k === ' ' || k === 'enter') && !ctrl && isInteractive(el) && el.matches(':focus-visible')) return;
      if (k === 'tab' && (ctrl || e.altKey || !document.querySelector('.center:hover'))) return;
      if (e.repeat && !k.startsWith('arrow') && k !== '+' && k !== '-' && k !== '=') {
        e.preventDefault();
        return;
      }
      const editsSelection = ctrl ? ['a', 'c', 'v', 'd', 'g'].includes(k)
        : ['delete', 'backspace', 'k', 'i', 'tab', 'f', '+', '=', '-'].includes(k) || /^[1-5]$/.test(k);
      if (editsSelection) {
        const sheet = document.querySelector('[data-timeline-editor]');
        const inspector = el?.closest?.('[data-group="keys"]');
        const otherPanel = el?.closest?.('.panel, .shoot-top');
        if (!inspector && (!sheet || otherPanel)) return;
      }
      let handled = true;
      if (ctrl && k === 'z' && !e.shiftKey) undo();
      else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) redo();
      else if (ctrl && k === 'o') openLibrary('scenes');
      else if (ctrl && k === ',') openLibrary('settings');
      else if ((st.workspace === 'library' || st.workspace === 'settings') && !st.miniMode) handled = false; // timeline keys only where there's a timeline
      else if (k === ' ') togglePlay();
      else if (ctrl && k === 'c') copySelected();
      else if (ctrl && k === 'v') pasteAtPlayhead();
      else if (ctrl && k === 'd') duplicateSelectedToPlayhead();
      else if (ctrl && k === 'a') selectAllKeys();
      else if (ctrl && k === 'g') window.dispatchEvent(new CustomEvent('studioex:group'));
      else if (ctrl) handled = false;
      else if (k === 'tab') {
        const v = st.centerView === 'dope' ? 'graph' : 'dope';
        useStore.setState({ centerView: v });
        lsSet('studioex.view', v);
      } else if (k === 'arrowleft') e.shiftKey ? jumpKey(-1) : stepFrames(-1);
      else if (k === 'arrowright') e.shiftKey ? jumpKey(1) : stepFrames(1);
      else if (k === 'home') seek(0);
      else if (k === 'end') seek(st.tl?.duration ?? 0);
      else if ((k === 'k' || k === 'i') && e.shiftKey) keyAllOfSelectedObjects();
      else if (k === 'k' || k === 'i') {
        if (st.selTracks.size || st.selKeys.size) keySelected();
        else keyChanged();
      } else if (k === 'enter' && e.shiftKey) keyChanged();
      else if (k === 'r') setAutoKey(!st.autoKey);
      else if (k === 'g') toggleGuides();
      else if (k === 'm') {
        const ids = st.studioSelection.filter((id) => st.nodes[id]?.type === 'Char');
        if (ids.length) bridge.request('pose.mirror', { ids }).catch(() => {});
      } else if (k === 'delete' || k === 'backspace') deleteSelectedKeys();
      else if (k === 'escape') {
        selectKeys([]);
        useStore.setState({ selTracks: new Set(), helpOpen: false });
      } else if (k === 'f' && e.shiftKey) window.dispatchEvent(new CustomEvent('studioex:zoom', { detail: 'duration' }));
      else if (k === 'f') window.dispatchEvent(new CustomEvent('studioex:frame'));
      else if (k === '=' || k === '+') window.dispatchEvent(new CustomEvent('studioex:zoom', { detail: 'in' }));
      else if (k === '-' || k === '_') window.dispatchEvent(new CustomEvent('studioex:zoom', { detail: 'out' }));
      else if (k === '?' || (k === '/' && e.shiftKey)) useStore.setState({ helpOpen: !st.helpOpen });
      else if (/^[1-5]$/.test(k)) {
        const p = PRESETS.find((x) => x.hotkey === k);
        if (p) applyCurveToSelected(toFlat(p.curve));
      } else handled = false;
      if (handled) e.preventDefault();
    };
    const onKeyEvt = () => keySelected();
    window.addEventListener('keydown', onKey);
    window.addEventListener('studioex:key', onKeyEvt);
    const offStudioKeys = installStudioHotkeys();
    return () => {
      offStudioKeys();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('studioex:key', onKeyEvt);
    };
  }, []);

  const toastStack = (
  <div className="toasts">
    {poseStale && pending > 0 && (
      <div className="toast notice" role="status">
        <div>
          <b>Your key edits aren’t on the pose yet.</b> Studio is keeping your {pending} unkeyed change{pending > 1 ? 's' : ''} instead of overwriting {pending > 1 ? 'them' : 'it'}.
        </div>
        <div className="toast-actions">
          <button className="btn primary" onClick={keyChanged} title="Key the changes at the playhead, then show the edits (Shift+Enter)">
            Key changes
          </button>
          <button className="btn solid" onClick={resetPose} title="Discard the unkeyed changes: the pose goes back to what the keys say">
            Reset pose to keys
          </button>
        </div>
      </div>
    )}
    {toasts.map((t) => (
      <ToastItem key={t.id} t={t} />
    ))}
  </div>
  );

  // Mini mode: just the timeline and its transport, in a small window kept on top of other windows
  if (miniMode)
    return (
      <div className="shell mini">
        <MiniHeader />
        <main className="ws-center mini-center">
          {status === 'open' ? (
            <ErrorBoundary name="The timeline">
              <DopeSheet compact />
            </ErrorBoundary>
          ) : (
            <Disconnected />
          )}
        </main>
        {status === 'open' && <TransportBar />}
        {toastStack}
        <CommandPalette />
        <DialogHost />
      </div>
    );

  return (
    <div className="shell">
      <Header />
      <ErrorBoundary key={workspace} name={`The ${workspace[0].toUpperCase() + workspace.slice(1)} workspace`}>
        {status !== 'open' && workspace !== 'library' && workspace !== 'settings' ? (
          <main style={{ position: 'relative', flex: 1 }}><Disconnected /></main>
        ) : (
          <>
            {workspace === 'animate' && <AnimateWorkspace />}
            {workspace === 'pose' && <PoseWorkspace />}
            {workspace === 'look' && <LookWorkspace />}
            {workspace === 'shoot' && <ShootWorkspace />}
          </>
        )}
        {workspace === 'library' && <LibraryWorkspace />}
        {workspace === 'settings' && <SettingsWorkspace />}
      </ErrorBoundary>

      <footer className="statusbar">
        {status === 'open' ? (
          <>
            <span>
              <b>{nodeCount}</b> objects · <b>{trackCount}</b> tracks · <b>{keyCount}</b> keys
            </span>
            {tl.has && (
              <span>
                {tl.duration.toFixed(2)}s @ {tl.fps} fps
              </span>
            )}
            {autoKey && <span style={{ color: 'var(--playhead)' }}>● Auto-key on</span>}
            {pending > 0 && !autoKey && <span style={{ color: 'var(--accent)' }}>{pending} unkeyed change{pending > 1 ? 's' : ''}</span>}
            <RecordingBadge />
            {hello && !hello.translator && <span>AutoTranslator not detected</span>}
            {translateJob && (
              <span className="sb-job" title="Translating Japanese names — Settings › Translations">
                Translating {translateJob.done}/{translateJob.total} · {translateJob.engine}
                <span className="sb-progress">
                  <span style={{ width: `${(100 * translateJob.done) / Math.max(1, translateJob.total)}%` }} />
                </span>
              </span>
            )}
          </>
        ) : (
          <span>{status === 'connecting' ? 'Connecting to CharaStudio…' : 'Waiting for CharaStudio'}</span>
        )}
        <div className="spacer" />
        <CameraTakeoverChip />
        <MessagesButton />
        <span>
          <span className="kbd">Ctrl K</span> actions · <span className="kbd">?</span> shortcuts
        </span>
      </footer>

      {toastStack}

      <CommandPalette />
      <DialogHost />
      {previewOpen && <PreviewPanel />}

      <AnimationsOverlay />
      {helpOpen && (
        <div className="overlay" onClick={() => useStore.setState({ helpOpen: false })}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Keyboard &amp; mouse</h2>
            <div className="shortcut-grid">
              {SHORTCUTS.map(([k, d]) => (
                <div key={k}>
                  <span>{d}</span>
                  <span className="kbd">{k}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

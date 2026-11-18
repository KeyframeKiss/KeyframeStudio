import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './Icon';
import { NumberField, TimeField } from './TopBar';
import { ViewportControls } from './ViewportControls';
import {
  jumpKey,
  keyChanged,
  lsSet,
  openLibrary,
  redo,
  seek,
  setAutoKey,
  setSettings,
  setTimelineUiVisible,
  setWorkspace,
  stepFrames,
  togglePlay,
  undo,
  useStore,
  useTlInfo,
  type Workspace,
} from '../state/store';
import { parseTime } from '../lib/time';

const WORKSPACES: { id: Workspace; label: string; icon: string; hint: string }[] = [
  { id: 'animate', label: 'Animate', icon: 'animate', hint: 'Timeline, keys and curves (Ctrl+1)' },
  { id: 'pose', label: 'Pose', icon: 'pose', hint: 'Characters, poses and animations (Ctrl+2)' },
  { id: 'look', label: 'Look', icon: 'look', hint: 'Lighting, effects, shaders and look presets (Ctrl+3)' },
  { id: 'library', label: 'Library', icon: 'library', hint: 'Scenes, translations, mod settings (Ctrl+4)' },
];

export function Header() {
  const workspace = useStore((s) => s.workspace);
  const status = useStore((s) => s.status);
  const hello = useStore((s) => s.hello);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    window.studioEx?.getAlwaysOnTop().then(setPinned);
  }, []);

  return (
    <header className="header">
      <div className="brand" title={hello ? `Keyframe Studio · bridge v${hello.plugin}` : 'Keyframe Studio'}>
        <img className="brand-logo" src="brand/logo.png" alt="Keyframe Studio" draggable={false} />
      </div>
      <nav className="ws-tabs">
        {WORKSPACES.map((w) => (
          <button key={w.id} className={`ws-tab ${workspace === w.id ? 'active' : ''}`} onClick={() => setWorkspace(w.id)} title={w.hint}>
            <Icon name={w.icon} size={15} />
            {w.label}
          </button>
        ))}
      </nav>
      <div className="spacer" />
      <button className="palette-trigger" onClick={() => useStore.setState({ paletteOpen: true })} title="Search every action (Ctrl+K)">
        <Icon name="search" size={13} />
        <span>Search actions…</span>
        <span className="kbd">Ctrl K</span>
      </button>
      <div className="group">
        <button className="btn icon" title="Undo (Ctrl+Z)" onClick={undo} disabled={status !== 'open'}>
          <Icon name="undo" />
        </button>
        <button className="btn icon" title="Redo (Ctrl+Y)" onClick={redo} disabled={status !== 'open'}>
          <Icon name="redo" />
        </button>
      </div>
      <span className={`conn ${status}`} title={status === 'open' ? 'Connected to CharaStudio' : status === 'connecting' ? 'Connecting…' : 'Waiting for CharaStudio'}>
        <span className={`status-dot ${status}`} />
        {status === 'open' ? 'Studio' : status === 'connecting' ? 'Connecting' : 'Offline'}
      </span>
      {window.studioEx?.isElectron && (
        <button className={`btn icon ${pinned ? 'on' : ''}`} title="Keep this window on top of Studio" onClick={() => window.studioEx!.setAlwaysOnTop(!pinned).then(setPinned)}>
          <Icon name="pin" />
        </button>
      )}
      <button className="btn icon" title="Mod settings (Ctrl+,)" onClick={() => openLibrary('settings')}>
        <Icon name="settings" />
      </button>
      <button className="btn icon" title="Keyboard shortcuts (?)" onClick={() => useStore.setState({ helpOpen: true })}>
        <Icon name="help" />
      </button>
    </header>
  );
}

/** Small anchored popover (click outside / Esc closes). */
export function Popover({
  trigger,
  children,
  align = 'left',
  width = 260,
  placement = 'up',
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: ReactNode;
  align?: 'left' | 'right';
  width?: number;
  placement?: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The menu is position:fixed (so no panel's overflow can clip it); place it from the trigger's
  // on-screen rect, flipping up/down if there isn't room, and keep it inside the window.
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - 16);
    const h = menuRef.current?.offsetHeight ?? 0;
    let up = placement === 'up';
    if (h) {
      if (up && r.top - 6 - h < 8 && vh - r.bottom > r.top) up = false;
      else if (!up && r.bottom + 6 + h > vh - 8 && r.top > vh - r.bottom) up = true;
    }
    let left = align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    setPos({
      left,
      width: w,
      maxHeight: (up ? r.top : vh - r.bottom) - 14,
      overflowY: 'auto',
      ...(up ? { bottom: vh - r.top + 6 } : { top: r.bottom + 6 }),
    });
  };

  useLayoutEffect(() => {
    if (!open) return setPos(null);
    place();
    // second pass once the menu has a measured height (for flipping)
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && (ref.current?.contains(t) || menuRef.current?.contains(t))) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const reflow = () => place();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('resize', reflow);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', reflow);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div ref={menuRef} className="menu popover" style={pos ?? { visibility: 'hidden', left: 0, top: 0, width }}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Everything for playing and keying, under the timeline (Animate workspace). */
export function TransportBar() {
  const status = useStore((s) => s.status);
  const tl = useTlInfo();
  const pending = useStore((s) => s.pending);
  const autoKey = useStore((s) => s.autoKey);
  const autoKeyNew = useStore((s) => s.autoKeyNew);
  const snap = useStore((s) => s.snap);
  const disabled = status !== 'open' || !tl.has;

  return (
    <div className="transport">
      <div className="group">
        <button className="btn icon" title="Go to start (Home)" onClick={() => seek(0)} disabled={disabled}>
          <Icon name="toStart" />
        </button>
        <button className="btn icon" title="Previous key (Shift+←)" onClick={() => jumpKey(-1)} disabled={disabled}>
          <Icon name="prevKey" />
        </button>
        <button className="btn icon" title="Previous frame (←)" onClick={() => stepFrames(-1)} disabled={disabled}>
          <Icon name="prevFrame" />
        </button>
        <button className={`btn play ${tl?.playing ? 'on' : ''}`} title="Play / Pause (Space)" onClick={togglePlay} disabled={disabled}>
          <Icon name={tl?.playing ? 'pause' : 'play'} />
        </button>
        <button className="btn icon" title="Next frame (→)" onClick={() => stepFrames(1)} disabled={disabled}>
          <Icon name="nextFrame" />
        </button>
        <button className="btn icon" title="Next key (Shift+→)" onClick={() => jumpKey(1)} disabled={disabled}>
          <Icon name="nextKey" />
        </button>
      </div>
      <TimeField />
      <Popover
        trigger={(open, toggle) => (
          <button className={`btn chip ${open ? 'on' : ''}`} onClick={toggle} disabled={disabled} title="Length, frame rate, playback speed">
            {(tl?.duration ?? 0).toFixed(2)}s · {tl?.fps ?? 60} fps{tl.has && tl.speed !== 1 ? ` · ${tl.speed.toFixed(2)}×` : ''}
            <Icon name="chevronDown" size={11} />
          </button>
        )}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr', gap: 8, alignItems: 'center', padding: 6 }}>
          <span className="hint" style={{ margin: 0 }}>Length</span>
          <NumberField value={tl?.duration ?? 10} format={(v) => v.toFixed(2) + 's'} parse={(s) => parseTime(s.replace(/s$/, ''), tl?.fps ?? 60)} onCommit={(v) => v > 0 && setSettings({ duration: Math.min(3600, v) })} />
          <span className="hint" style={{ margin: 0 }}>Frame rate</span>
          <NumberField value={tl?.fps ?? 60} format={(v) => `${v} fps`} parse={(s) => Math.round(Number(s.replace(/fps/i, ''))) || null} onCommit={(v) => setSettings({ fps: Math.max(1, Math.min(240, Math.round(v))) })} />
          <span className="hint" style={{ margin: 0 }}>Speed</span>
          <NumberField
            value={tl?.speed ?? 1}
            format={(v) => v.toFixed(2) + '×'}
            parse={(s) => {
              const n = Number(s.replace('×', ''));
              return Number.isFinite(n) ? n : null;
            }}
            onCommit={(v) => v > 0 && setSettings({ speed: Math.min(10, v) })}
          />
        </div>
      </Popover>

      <div className="spacer" />

      <ViewportControls />
      <span className="sep" />
      <button className={`btn icon ${snap ? 'on' : ''}`} title="Snap keys to frames (Alt while dragging bypasses)" onClick={() => useStore.setState({ snap: !snap })}>
        <Icon name="magnet" />
      </button>
      <Popover
        align="right"
        width={240}
        trigger={(open, toggle) => (
          <button className={`btn icon ${open ? 'on' : ''}`} onClick={toggle} title="More timeline options">
            <Icon name="more" />
          </button>
        )}
      >
        <TimelineMoreMenu />
      </Popover>
      <span className="sep" />
      <button className={`btn solid ${pending > 0 ? 'attention' : ''}`} onClick={keyChanged} disabled={disabled} title={`Key everything you changed in Studio (Shift+Enter)${autoKeyNew ? ' — creates tracks for moved bones/objects' : ''}`}>
        Key changes{pending > 0 ? <span className="badge">{pending}</span> : null}
      </button>
      <button className={`btn ${autoKey ? 'rec' : 'solid'}`} onClick={() => setAutoKey(!autoKey)} disabled={disabled} title="Auto-key (R): finished moves in Studio are keyed at the playhead. Right-click: toggle creating new tracks." onContextMenu={(e) => { e.preventDefault(); setAutoKey(autoKey, !autoKeyNew); }}>
        <span className="rec-dot" /> Auto
      </button>
      <button className="btn primary" onClick={() => window.dispatchEvent(new CustomEvent('studioex:key'))} disabled={disabled} title="Key selected tracks at playhead (K)">
        <Icon name="key" size={13} /> Key
      </button>
    </div>
  );
}

function TimelineMoreMenu() {
  const showEnglish = useStore((s) => s.showEnglish);
  const tl = useTlInfo();
  const autoKeyNew = useStore((s) => s.autoKeyNew);
  const autoKey = useStore((s) => s.autoKey);
  const Row = ({ on, label, hint, onClick }: { on: boolean; label: string; hint?: string; onClick: () => void }) => (
    <div className="menu-item" onClick={onClick} title={hint}>
      <span style={{ width: 14, display: 'inline-flex' }}>{on ? <Icon name="check" size={13} /> : null}</span>
      {label}
    </div>
  );
  return (
    <div>
      <Row on={showEnglish} label="English names" hint="Show AutoTranslator translations" onClick={() => { useStore.setState({ showEnglish: !showEnglish }); lsSet('studioex.english', showEnglish ? '0' : '1'); }} />
      <Row on={autoKeyNew} label="Auto-key creates new tracks" hint="Moving an un-animated bone/object creates its track" onClick={() => setAutoKey(autoKey, !autoKeyNew)} />
      <Row on={!!tl?.uiVisible} label="Show Timeline's own window" hint="The original Timeline UI inside Studio" onClick={() => tl.has && setTimelineUiVisible(!tl.uiVisible)} />
    </div>
  );
}

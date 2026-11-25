import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pressable } from '../lib/pressable';
import { Help } from './Help';
import { Icon } from './Icon';
import { NumberField, TimeField } from './TopBar';
import { ViewCluster } from './ViewCluster';
import { PathsGhostsSync } from './ViewportControls';
import { OverlaySync } from './ViewportOverlays';
import { call, saveOverOn, saveSceneFile, setSaveOver, toast, jumpKey, keyChanged, lsSet, openLibrary, redo, seek, setAutoKey, setSettings, setTimelineUiVisible, setWorkspace, stepFrames, togglePlay, undo, useStore, useTlInfo, type Workspace, setMiniMode } from '../state/store';
import { parseTime } from '../lib/time';

import { applyLayout, deleteLayout, resetLayout, saveLayout, savedLayouts, setCompact, setPanelSizes, useCompact, usePanelSizes } from '../lib/layout';
import { toggleCleanStudio, useStudioUi } from '../state/studioUi';
import { UpdateNotices } from './Updates';
const WORKSPACES: { id: Workspace; label: string; icon: string; hint: string }[] = [
  { id: 'animate', label: 'Animate', icon: 'animate', hint: 'Timeline, keys and curves (Ctrl+1)' },
  { id: 'pose', label: 'Character', icon: 'pose', hint: 'Poses, animations, face shape, outfit and body of the selected character (Ctrl+2)' },
  { id: 'look', label: 'Look', icon: 'look', hint: 'Lighting, effects, shaders and look presets (Ctrl+3)' },
  { id: 'shoot', label: 'Shoot', icon: 'camera', hint: 'Camera, shots, audio and rendering (Ctrl+4)' },
  { id: 'library', label: 'Library', icon: 'library', hint: 'Scenes, characters, quick actions (Ctrl+5)' },
];

export function Header() {
  const workspace = useStore((s) => s.workspace);
  const status = useStore((s) => s.status);
  const sceneName = useStore((s) => s.sceneName);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    window.studioEx?.getAlwaysOnTop().then(setPinned);
  }, []);

  return (
    <header className="header">
      <Popover placement="down" trigger={(_, toggle) => (
        <button className="brand scene-trigger" onClick={toggle} title={`Scene menu · ${sceneName ?? 'Current scene'}`}>
          <img className="brand-logo" src="brand/logo.png" alt="Keyframe Studio" draggable={false} />
          <span>{sceneName ?? 'Scene'} ▾</span>
        </button>
      )}>
        {(close) => <div className="layout-menu">
          <b>{sceneName ?? 'Current scene'}</b>
          <button className="menu-item" onClick={() => { close(); useStore.setState({ sceneFilter: 'recent' }); openLibrary('scenes'); }}>Open recent</button>
          <SaveItems close={close} />
        </div>}
      </Popover>
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
      <CleanStudioButton />
      <UpdateNotices />
      <span className={`conn ${status}`} title={status === 'open' ? 'Connected to CharaStudio' : status === 'connecting' ? 'Connecting…' : 'Waiting for CharaStudio'}>
        <span className={`status-dot ${status}`} />
        {status === 'open' ? 'Studio' : status === 'connecting' ? 'Connecting' : 'Offline'}
      </span>
      {pinned && (
        <button className="btn icon on" title="On top of Studio — click to stop" onClick={() => window.studioEx?.setAlwaysOnTop(false).then(setPinned)}>
          <Icon name="pin" />
        </button>
      )}
      <button className="btn icon" title="Mini mode: just the timeline, in a small window kept on top (Ctrl+Shift+M)" onClick={() => setMiniMode(true)}>
        <Icon name="tracks" />
      </button>
      <button className="btn icon" title="Help & guide (F1)" aria-label="Help & guide" onClick={() => openLibrary('help')}>
        <Icon name="help" />
      </button>
      <AppMenu pinned={pinned} setPinned={setPinned} />
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
  openEvent,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  /** content, or a function of `close` for menus whose items should close it */
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'left' | 'right';
  width?: number;
  placement?: 'up' | 'down';
  /** a window event that opens it (e.g. from a context menu elsewhere) */
  openEvent?: string;
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

  useEffect(() => {
    if (!openEvent) return;
    const on = () => setOpen(true);
    window.addEventListener(openEvent, on);
    return () => window.removeEventListener(openEvent, on);
  }, [openEvent]);

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
      // a menu opened from inside this one (e.g. Length · fps in the transport's ··· menu) keeps this one open
      if (t instanceof Element && t.closest('.menu.popover')) return;
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
      {/* drawn at the top of the page: a menu inside another one (which animates in with a transform) would be
          placed and clipped inside it otherwise */}
      {open &&
        createPortal(
          <div ref={menuRef} className="menu popover" style={pos ?? { visibility: 'hidden', left: 0, top: 0, width }}>
            {typeof children === 'function' ? children(() => setOpen(false)) : children}
          </div>,
          document.body,
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

  const bar = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(0);
  const compact = barWidth < 1150; // below this the length chip and the View group fold into ···
  const narrow = barWidth < 660;
  useLayoutEffect(() => {
    const el = bar.current!;
    const update = () => setBarWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const navigation = (
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
      <button className="btn icon" title="Next frame (→)" onClick={() => stepFrames(1)} disabled={disabled}>
        <Icon name="nextFrame" />
      </button>
      <button className="btn icon" title="Next key (Shift+→)" onClick={() => jumpKey(1)} disabled={disabled}>
        <Icon name="nextKey" />
      </button>
    </div>
  );
  const settings = (
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
  );
  const viewOptions = <ViewCluster />;
  const snapKeys = useStore((s) => s.snapKeys);
  const setSnapKeys = (v: 'track' | 'all' | 'none') => {
    useStore.setState({ snapKeys: v, snap: true });
    lsSet('studioex.snapKeys', v);
  };
  const snapButton = (
    <div className="split-btn">
    <button className={`btn icon ${snap ? 'on' : ''}`} title="Snap: dragging keys, scrubbing or moving audio lands on nearby keys, the playhead, ruler ticks and clip edges (an orange tag shows what), otherwise on whole frames. Hold Alt while dragging to place freely." aria-pressed={snap} onClick={() => useStore.setState({ snap: !snap })}>
      <Icon name="magnet" />
    </button>
    <Popover
      align="right"
      width={250}
      trigger={(open, toggle) => (
        <button className={`btn icon split-btn-more ${open ? 'on' : snap ? 'on' : ''}`} onClick={toggle} title="What snapping lands on">
          <Icon name="chevronDown" size={11} />
        </button>
      )}
    >
      <div className="layout-menu">
        <div className="layout-menu-h">Snap to keys on…</div>
        {(
          [
            ['track', 'This track only', 'Dragging keys: other keys on the same tracks. Scrubbing: keys on the selected tracks.'],
            ['all', 'All tracks', 'Any key on any track'],
            ['none', 'No keys', 'Just the playhead, ruler ticks, clip edges and frames'],
          ] as const
        ).map(([v, label, hint]) => (
          <label key={v} title={hint}>
            <input type="radio" name="snapKeys" checked={snapKeys === v} onChange={() => setSnapKeys(v)} /> {label}
          </label>
        ))}
        <small className="hint" style={{ margin: '4px 0 0' }}>Always: the playhead, ruler ticks, clip edges, whole frames. Hold Alt to place freely.</small>
      </div>
    </Popover>
    </div>
  );
  const changed = (
    <button className={`btn solid ${pending > 0 ? 'attention' : ''}`} onClick={keyChanged} disabled={disabled} title={`Key everything you changed in Studio (Shift+Enter)${autoKeyNew ? ' — creates tracks for moved bones/objects' : ''}`}>
      Key changes{pending > 0 ? <span className="badge">{pending}</span> : null}
    </button>
  );

  return (
    <div ref={bar} className={`transport ${compact ? 'compact-transport' : ''}`}>
      <PathsGhostsSync />
      <OverlaySync />
      <button className={`btn play ${tl?.playing ? 'on' : ''}`} title="Play / Pause (Space)" onClick={togglePlay} disabled={disabled}>
        <Icon name={tl?.playing ? 'pause' : 'play'} />
      </button>
      {!narrow && navigation}
      <TimeField />
      {!compact && settings}
      <div className="spacer" />
      {!compact && viewOptions}
      {!compact && <span className="sep" />}
      {!narrow && snapButton}
      {!narrow && changed}
      <div className="split-btn">
        <button className={`btn ${autoKey ? 'rec' : 'solid'}`} onClick={() => setAutoKey(!autoKey)} disabled={disabled} title="Auto-key (R): whatever you change — in Studio, or in the Face tab — is keyed at the playhead">
          <span className="rec-dot" /> Auto
        </button>
        <Popover
          align="right"
          width={270}
          trigger={(open, toggle) => (
            <button className={`btn ${open ? 'on' : autoKey ? 'rec' : 'solid'} split-btn-more`} onClick={toggle} disabled={disabled} title="Auto-key options">
              <Icon name="chevronDown" size={11} />
            </button>
          )}
        >
          <div className="layout-menu">
            <div className="layout-menu-h">
              Auto-key
              <Help text="Whatever you change — in Studio, or in Animate › Face — is keyed at the playhead. Without the second option, only things that already have a track get keys. To key your changes once without auto-key, use Key changes (Shift+Enter)." />
            </div>
            <label>
              <input type="checkbox" checked={autoKey} onChange={(e) => setAutoKey(e.target.checked)} /> On (R)
            </label>
            <label title="Moving a bone or object that has no track yet — or changing a face part with no track — creates its track">
              <input type="checkbox" checked={autoKeyNew} onChange={(e) => setAutoKey(autoKey, e.target.checked)} /> Also animate things that aren't animated yet
            </label>
          </div>
        </Popover>
      </div>
      <button className="btn primary" onClick={() => window.dispatchEvent(new CustomEvent('studioex:key'))} disabled={disabled} title="Key selected tracks at playhead (K)">
        <Icon name="key" size={13} /> Key
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
        <div className="transport-menu">
          {narrow && navigation}
          {compact && <>{settings}{viewOptions}</>}
          {narrow && <>{snapButton}{changed}</>}
          <TimelineMoreMenu />
        </div>
      </Popover>
    </div>
  );
}

/** Save over the open scene (Ctrl+S, when set), save as a new file (Ctrl+Shift+S), the Ctrl+S setting, backups. */
function SaveItems({ close }: { close: () => void }) {
  const status = useStore((s) => s.status);
  const sceneName = useStore((s) => s.sceneName);
  const canOver = useStore((s) => !!s.hello?.commands.includes('scene.backups'));
  const [over, setOver] = useState(saveOverOn);
  useEffect(() => {
    const on = () => setOver(saveOverOn());
    window.addEventListener('kf:save-mode', on);
    return () => window.removeEventListener('kf:save-mode', on);
  }, []);
  const off = status !== 'open';
  const openBackups = async () => {
    const dir = await call<string>('scene.backupFolder');
    const r = dir ? await window.studioEx?.openFolder?.(dir) : 'no';
    if (r) toast('No backups yet: they appear the first time Ctrl+S saves over a scene');
  };
  return (
    <>
      {canOver && sceneName && (
        <button className="menu-item" disabled={off} onClick={() => { close(); void saveSceneFile('over'); }} title="Replace the open scene's file; its old version is kept in backups">
          Save over {sceneName} {over && <span className="kbd">Ctrl S</span>}
        </button>
      )}
      <button className="menu-item" disabled={off} onClick={() => { close(); void saveSceneFile('new'); }} title="A new file, like Studio's Save">
        Save as new scene file <span className="kbd">{over && canOver ? 'Ctrl Shift S' : 'Ctrl S'}</span>
      </button>
      {canOver && (
        <>
          <div {...pressable} role="menuitemcheckbox" aria-checked={over} className="menu-item" onClick={() => setSaveOver(!over)} title="Studio's Save always makes a new file. With this on, Ctrl+S replaces the open scene's file; the version it replaces is copied to UserData/StudioEX/scene-backups (the last 10 of each scene). A new scene still gets a new file.">
            <span style={{ width: 14, display: 'inline-flex' }}>{over ? <Icon name="check" size={13} /> : null}</span>
            Ctrl+S saves over the open scene
          </div>
          <button className="menu-item" onClick={() => { close(); void openBackups(); }}>Open scene backups</button>
        </>
      )}
    </>
  );
}

function TimelineMoreMenu() {
  const showEnglish = useStore((s) => s.showEnglish);
  const tl = useTlInfo();
  const Row = ({ on, label, hint, onClick }: { on: boolean; label: string; hint?: string; onClick: () => void }) => (
    <div {...pressable} role="menuitemcheckbox" aria-checked={on} className="menu-item" onClick={onClick} title={hint}>
      <span style={{ width: 14, display: 'inline-flex' }}>{on ? <Icon name="check" size={13} /> : null}</span>
      {label}
    </div>
  );
  return (
    <div>
      <Row on={showEnglish} label="English names" hint="Show AutoTranslator translations" onClick={() => { useStore.setState({ showEnglish: !showEnglish }); lsSet('studioex.english', showEnglish ? '0' : '1'); }} />
      <Row on={!!tl?.uiVisible} label="Show Timeline's own window" hint="The original Timeline UI inside Studio" onClick={() => tl.has && setTimelineUiVisible(!tl.uiVisible)} />
    </div>
  );
}

/** The one header menu: settings, help, window and layout. */
/** Hide / show CharaStudio's menus (Settings › Studio window has the details). */
function CleanStudioButton() {
  const ui = useStudioUi((s) => s.ui);
  if (!ui) return null;
  return (
    <button className={`btn icon ${ui.clean ? 'on' : ''}`} onClick={toggleCleanStudio} title={ui.clean ? "Studio's menus are hidden — click to bring them back" : "Clean Studio window: hide Studio's menus so it's just the picture"}>
      <Icon name={ui.clean ? 'eyeOff' : 'eye'} />
    </button>
  );
}

function AppMenu({ pinned, setPinned }: { pinned: boolean; setPinned: (v: boolean) => void }) {
  const ws = useStore((s) => s.workspace);
  const compact = useCompact();
  const sz = usePanelSizes(ws);
  const [list, setList] = useState(savedLayouts);
  const [name, setName] = useState('');
  const hasSides = ws !== 'library' && ws !== 'settings';
  return (
    <Popover
      align="right"
      placement="down"
      width={260}
      trigger={(open, toggle) => (
        <button
          className={`btn icon ${open || ws === 'settings' ? 'on' : ''}`}
          title="Menu: settings, shortcuts, keep on top, layout"
          onClick={() => {
            setList(savedLayouts());
            toggle();
          }}
        >
          <Icon name="settings" />
        </button>
      )}
    >
      {(close) => (
        <div className="layout-menu">
          <button className="menu-item" onClick={() => (close(), openLibrary('settings'))}>
            <Icon name="settings" size={13} /> Settings <span className="kbd">Ctrl ,</span>
          </button>
          <button className="menu-item" onClick={() => (close(), openLibrary('help'))}>
            <Icon name="book" size={13} /> Help &amp; guide <span className="kbd">F1</span>
          </button>
          <button className="menu-item" onClick={() => (close(), useStore.setState({ helpOpen: true }))}>
            <Icon name="keyboard" size={13} /> Keyboard shortcuts <span className="kbd">?</span>
          </button>
          <button className="menu-item" onClick={() => (close(), openLibrary('about'))}>
            <Icon name="pulse" size={13} /> About &amp; diagnostics
          </button>
          <div className="menu-sep" />
          <div className="layout-menu-h">Window</div>
          <button className="menu-item" onClick={() => (close(), setMiniMode(true))}>
            <Icon name="tracks" size={13} /> Mini mode — just the timeline, on top <span className="kbd">Ctrl Shift M</span>
          </button>
          {window.studioEx?.isElectron && (
            <label title="Keep this window on top of CharaStudio">
              <input type="checkbox" checked={pinned} onChange={(e) => window.studioEx!.setAlwaysOnTop(e.target.checked).then(setPinned)} /> Keep on top of Studio
            </label>
          )}
          <label>
            <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} /> Compact (smaller text and spacing)
          </label>
          {hasSides && (
            <>
              <label>
                <input type="checkbox" checked={!sz.leftHidden} onChange={(e) => setPanelSizes(ws, { leftHidden: !e.target.checked })} /> Left panel
              </label>
              <label>
                <input type="checkbox" checked={!sz.rightHidden} onChange={(e) => setPanelSizes(ws, { rightHidden: !e.target.checked })} /> Right panel
              </label>
            </>
          )}
          <div className="layout-menu-h">
            Saved layouts
            <Help text="Drag a side panel's edge to resize it (double-click to hide it). A saved layout remembers panel sizes, compact mode and the window's size and position." />
          </div>
          {list.map((l) => (
            <div key={l.name} className="layout-item">
              <button className="btn small solid" style={{ flex: 1, justifyContent: 'flex-start' }} onClick={() => applyLayout(l)} title={l.bounds ? 'Panels, tabs, compact mode and window position' : 'Panels, tabs and compact mode'}>
                {l.name}
              </button>
              <button
                className="btn small"
                title="Delete"
                onClick={() => {
                  deleteLayout(l.name);
                  setList(savedLayouts());
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <input className="input" style={{ flex: 1, minWidth: 0, height: 24 }} placeholder="Save current as…" value={name} onChange={(e) => setName(e.target.value)} />
            <button
              className="btn small primary"
              disabled={!name.trim()}
              onClick={async () => {
                await saveLayout(name.trim());
                setName('');
                setList(savedLayouts());
              }}
            >
              Save
            </button>
          </div>
          <button className="btn small" style={{ marginTop: 6 }} onClick={resetLayout}>
            Reset layout to default
          </button>
        </div>
      )}
    </Popover>
  );
}

/** Mini mode's title bar: what's open, whether Studio is there, and the way back. Drag it to move the window. */
export function MiniHeader() {
  const status = useStore((s) => s.status);
  const sceneName = useStore((s) => s.sceneName);
  return (
    <header className="header mini-header">
      <b className="mini-title">Keyframe Studio</b>
      <span className="mini-scene" title={sceneName ?? ''}>
        {sceneName ? sceneName.replace(/\.png$/i, '') : 'Untitled scene'}
      </span>
      <span className={`status-dot ${status}`} title={status === 'open' ? 'Connected to CharaStudio' : 'Waiting for CharaStudio'} />
      <span style={{ flex: 1 }} />
      <button className="btn small solid" onClick={() => setMiniMode(false)} title="Back to the full window (Ctrl+Shift+M)">
        <Icon name="fit" size={13} /> Full window
      </button>
    </header>
  );
}

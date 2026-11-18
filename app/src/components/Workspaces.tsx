import { useEffect, useState, useSyncExternalStore } from 'react';
import { bridge } from '../bridge/client';
import { call, displayName, selectedCharacters, toast, useStore, type LibraryPage } from '../state/store';
import { Group, SelectionHeader, Stack } from './InspectorStack';
import { AudioPanel } from './AudioPanel';
import { ShotsPanel } from './ShotsPanel';
import { CharacterLibrary } from './CharacterLibrary';
import { QuickActionsPage } from './QuickActions';
import { columns, leftCss, rightCss, setPanelSizes, usePanelSizes } from '../lib/layout';
import { CleanupPanel } from './CleanupPanel';
import { AnimationBrowser } from './AnimationBrowser';
import { CameraPanel } from './CameraPanel';
import { CharacterPanel } from './CharacterPanel';
import { DopeSheet } from './DopeSheet';
import { Icon } from './Icon';
import { Inspector } from './Inspector';
import { RenderPanel } from './RenderPanel';
import { OutfitPanel } from './OutfitPanel';
import { LightRigsPanel } from './LightRigsPanel';
import { LookPanel } from './LookPanel';
import { LookPresets } from './LookPresets';
import { ModSettings } from './ModSettings';
import { ObjectPanel } from './ObjectPanel';
import { Outliner } from './Outliner';
import { PosePanel } from './PosePanel';
import { SceneBrowser } from './SceneBrowser';
import { TransportBar } from './Shell';
import { TranslatePanel } from './TranslatePanel';
import { FaceStudio } from './FaceStudio';
import { ErrorBoundary } from './ErrorBoundary';
import { SHORTCUTS } from './shortcuts';
import { DiagnosticsPage } from './DiagnosticsPage';

function Disconnected() {
  const status = useStore((s) => s.status);
  const hello = useStore((s) => s.hello);
  if (status === 'open' && (!hello || hello.timeline)) return null;
  return (
    <div className="disconnected">
      <div className="card">
        {status === 'open' ? (
          <>
            <h2>Timeline plugin missing</h2>
            Keyframe Studio edits Timeline animations — install Timeline (part of the HSPE/KKPE packs).
          </>
        ) : (
          <>
            <span className={`status-dot ${status === 'connecting' ? 'connecting' : ''}`} style={{ display: 'inline-block' }} />
            <h2>Waiting for CharaStudio…</h2>
            Start <code>CharaStudio.exe</code> with <code>KKStudioEX.Bridge</code> in <code>BepInEx/plugins</code>. Keyframe Studio connects automatically.
          </>
        )}
      </div>
    </div>
  );
}

/** The scene outliner: the left column of every 3-panel workspace. */
function ScenePanel() {
  return (
    <aside className="panel left">
      <div className="panel-title">Scene</div>
      <Outliner />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Animate: scene | dope sheet / graph + transport | keys, cleanup, selected object
// ---------------------------------------------------------------------------
export function AnimateWorkspace() {
  const sizes = usePanelSizes('animate');
  return (
    <div className="ws ws-3" style={{ gridTemplateColumns: columns(sizes) }}>
      <Splitters ws="animate" />
      <ScenePanel />
      <main className="ws-center">
        <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
          <DopeSheet />
          <Disconnected />
        </div>
        <TransportBar />
      </main>
      <AnimateInspector />
    </div>
  );
}

function AnimateInspector() {
  const keys = useStore((s) => s.selKeys.size);
  const tracks = useStore((s) => s.selTracks.size);
  const first = useStore((s) => s.studioSelection[0]);
  const node = useStore((s) => (first != null ? s.nodes[first] : undefined));
  useStore((s) => s.showEnglish);
  return (
    <Stack>
      {keys > 0 || tracks > 0 ? (
        <Group ws="animate" id="keys" icon="key" title={keys ? `Keyframe${keys > 1 ? `s (${keys})` : ''}` : `Track${tracks > 1 ? `s (${tracks})` : ''}`}>
          <Inspector />
        </Group>
      ) : (
        <Group ws="animate" id="tips" title="Quick start">
          <Inspector />
        </Group>
      )}
      <Group ws="animate" id="cleanup" icon="sliders" title="Cleanup" defaultOpen={false}>
        <CleanupPanel />
      </Group>
      {node && (
        <Group
          ws="animate"
          id="object"
          icon="target"
          title={
            <>
              Object <span className="group-sub">{displayName(node)}</span>
            </>
          }
          defaultOpen={false}
        >
          <ObjectPanel bare />
        </Group>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Pose: scene | pose library / animations / face studio | selected character
// ---------------------------------------------------------------------------
export function PoseWorkspace() {
  const sizes = usePanelSizes('pose');
  const [center, setCenter] = useState<'poses' | 'anims' | 'face'>(() => (localStorage.getItem('studioex.pose.center') as 'poses' | 'anims' | 'face') || 'poses');
  // The command palette can open a tab directly.
  useEffect(() => {
    const on = (e: Event) => pick((e as CustomEvent).detail);
    window.addEventListener('studioex:pose-tab', on);
    return () => window.removeEventListener('studioex:pose-tab', on);
  }, []);
  const pick = (c: 'poses' | 'anims' | 'face') => {
    setCenter(c);
    try {
      localStorage.setItem('studioex.pose.center', c);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="ws ws-3" style={{ gridTemplateColumns: columns(sizes) }}>
      <Splitters ws="pose" />
      <ScenePanel />
      <main className="ws-center">
        <div className="center-tabs">
          <button className={`ws-subtab ${center === 'poses' ? 'active' : ''}`} onClick={() => pick('poses')}>
            <Icon name="pose" size={14} /> Pose library
          </button>
          <button className={`ws-subtab ${center === 'anims' ? 'active' : ''}`} onClick={() => pick('anims')}>
            <Icon name="animate" size={14} /> Animations
          </button>
          <button className={`ws-subtab ${center === 'face' ? 'active' : ''}`} onClick={() => pick('face')}>
            <Icon name="target" size={14} /> Face Studio
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <ErrorBoundary key={center} name={center === 'face' ? 'Face Studio' : center === 'anims' ? 'Animations' : 'Pose library'}>
            {center === 'poses' ? <PosePanel wide /> : center === 'anims' ? <AnimationLibrary /> : <FaceStudio />}
          </ErrorBoundary>
          <Disconnected />
        </div>
      </main>
      <PoseInspector />
    </div>
  );
}

function PoseInspector() {
  const any = useStore((s) => s.studioSelection.length > 0);
  const isChar = useStore((s) => s.studioSelection.length > 0 && s.nodes[s.studioSelection[0]]?.type === 'Char');
  return (
    <Stack>
      <SelectionHeader empty="Select a character in the Scene list or in Studio. With several selected, changes apply to all of them." />
      {isChar && (
        <Group ws="pose" id="character" icon="pose" title="Character">
          <CharacterPanel bare />
        </Group>
      )}
      {isChar && (
        <Group ws="pose" id="outfits" icon="look" title="Saved outfits & accessories" defaultOpen={false}>
          <OutfitPanel />
        </Group>
      )}
      {any && (
        <Group ws="pose" id={isChar ? 'object' : 'object-item'} icon="target" title="Transform" defaultOpen={!isChar}>
          <ObjectPanel bare />
        </Group>
      )}
    </Stack>
  );
}

/** Inline animation browser that applies to the selected characters. */
function AnimationLibrary() {
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  const chars = selectedCharacters();
  const [current, setCurrent] = useState({ group: -1, category: -1, no: -1 });
  const primary = chars[0];
  useEffect(() => {
    if (primary == null) return;
    bridge
      .request<{ anime: { group: number; category: number; no: number } }>('chara.get', { id: primary })
      .then((c) => setCurrent(c.anime))
      .catch(() => {});
  }, [primary, selection.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="hint" style={{ padding: '8px 16px', margin: 0, borderBottom: '1px solid var(--line-soft)' }}>
        {chars.length ? `Applies to: ${chars.map((id) => displayName(nodes[id])).join(', ')}` : 'Select one or more characters to apply animations.'}
      </div>
      <AnimationBrowser
        embedded
        current={current}
        onClose={() => {}}
        onPick={async (g, c, n) => {
          if (!chars.length) return toast('Select a character first');
          await call('chara.loadAnime', { ids: chars, group: g, category: c, no: n });
          setCurrent({ group: g, category: c, no: n });
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Look: scene (for material targets) | preset gallery | look controls + lighting rigs
// ---------------------------------------------------------------------------
export function LookWorkspace() {
  const sizes = usePanelSizes('look');
  return (
    <div className="ws ws-3" style={{ gridTemplateColumns: columns(sizes) }}>
      <Splitters ws="look" />
      <ScenePanel />
      <main className="ws-center" style={{ position: 'relative' }}>
        <div className="page">
          <div className="page-inner" style={{ padding: 16, overflow: 'auto' }}>
            <h2 className="page-title">Looks</h2>
            <LookPresets wide />
          </div>
        </div>
        <Disconnected />
      </main>
      <Stack>
        <Group ws="look" id="look" icon="look" title="Look settings">
          <LookPanel showPresets={false} />
        </Group>
        <Group ws="look" id="rigs" icon="bolt" title="Lighting rigs" defaultOpen={false}>
          <LightRigsPanel />
        </Group>
      </Stack>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shoot: scene | shots + camera over the timeline | render + audio
// ---------------------------------------------------------------------------
const SHOOT_KEY = 'kf.shoot.top';
let shootTop = (() => {
  try {
    return Number(localStorage.getItem(SHOOT_KEY)) || 0.48;
  } catch {
    return 0.48;
  }
})();
const shootSubs = new Set<() => void>();
const subscribeShoot = (l: () => void) => {
  shootSubs.add(l);
  return () => {
    shootSubs.delete(l);
  };
};
const setShootTop = (v: number) => {
  shootTop = Math.max(0.2, Math.min(0.8, v));
  try {
    localStorage.setItem(SHOOT_KEY, String(shootTop));
  } catch {
    /* storage unavailable */
  }
  shootSubs.forEach((l) => l());
};

export function ShootWorkspace() {
  const sizes = usePanelSizes('shoot');
  const top = useSyncExternalStore(subscribeShoot, () => shootTop);
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const box = el.parentElement!.getBoundingClientRect();
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setShootTop((ev.clientY - box.top) / box.height);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div className="ws ws-3" style={{ gridTemplateColumns: columns(sizes) }}>
      <Splitters ws="shoot" />
      <ScenePanel />
      <main className="ws-center" style={{ position: 'relative' }}>
        <div className="shoot-top" style={{ flexBasis: `${top * 100}%` }}>
          <section className="shoot-col">
            <ShotsPanel />
          </section>
          <section className="shoot-col">
            <CameraPanel />
          </section>
        </div>
        <div className="shoot-split" onPointerDown={drag} onDoubleClick={() => setShootTop(0.48)} title="Drag to resize · double-click to reset" />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
          <DopeSheet />
        </div>
        <TransportBar />
        <Disconnected />
      </main>
      <Stack>
        <Group ws="shoot" id="render" icon="record" title="Render">
          <RenderPanel />
        </Group>
        <Group ws="shoot" id="audio" icon="pulse" title="Audio & lip-sync">
          <AudioPanel />
        </Group>
      </Stack>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library (content) and Settings (the app): a page list on the left
// ---------------------------------------------------------------------------
interface PageDef {
  id: LibraryPage;
  label: string;
  icon: string;
  hint: string;
}
const LIBRARY_PAGES: PageDef[] = [
  { id: 'scenes', label: 'Scenes', icon: 'scenes', hint: 'Load, import, save scenes' },
  { id: 'characters', label: 'Characters', icon: 'pose', hint: 'Cards: add or swap characters' },
  { id: 'macros', label: 'Quick actions', icon: 'bolt', hint: 'Record and replay steps' },
];
const SETTINGS_PAGES: PageDef[] = [
  { id: 'settings', label: 'Mod settings', icon: 'settings', hint: 'Every plugin option' },
  { id: 'translate', label: 'Translations', icon: 'translate', hint: 'Fix Japanese → English names' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', hint: 'Keyboard & mouse' },
  { id: 'about', label: 'About & diagnostics', icon: 'pulse', hint: 'Versions, mods, bug reports' },
];

function PageNav({ title, pages, page, onPick }: { title: string; pages: PageDef[]; page: LibraryPage; onPick: (p: LibraryPage) => void }) {
  return (
    <aside className="panel left lib-nav">
      <div className="lib-nav-title">{title}</div>
      {pages.map((p) => (
        <button key={p.id} className={`lib-nav-item ${page === p.id ? 'active' : ''}`} onClick={() => onPick(p.id)}>
          <Icon name={p.icon} size={16} />
          <span>
            <b>{p.label}</b>
            <small>{p.hint}</small>
          </span>
        </button>
      ))}
    </aside>
  );
}

export function LibraryWorkspace() {
  const page = useStore((s) => s.libraryPage);
  return (
    <div className="ws ws-lib">
      <PageNav title="Library" pages={LIBRARY_PAGES} page={page} onPick={(p) => useStore.setState({ libraryPage: p })} />
      <main className="ws-center" style={{ position: 'relative' }}>
        {page === 'scenes' && <SceneBrowser />}
        {page === 'characters' && <CharacterLibrary />}
        {page === 'macros' && <QuickActionsPage />}
        {page !== 'macros' && <Disconnected />}
      </main>
    </div>
  );
}

export function SettingsWorkspace() {
  const page = useStore((s) => s.settingsPage);
  return (
    <div className="ws ws-lib">
      <PageNav title="Settings" pages={SETTINGS_PAGES} page={page} onPick={(p) => useStore.setState({ settingsPage: p })} />
      <main className="ws-center" style={{ position: 'relative' }}>
        {page === 'translate' && (
          <div className="page">
            <div className="page-inner narrow" style={{ padding: 16 }}>
              <h2 className="page-title">Translations</h2>
              <TranslatePanel />
            </div>
          </div>
        )}
        {page === 'settings' && <ModSettings />}
        {page === 'about' && <DiagnosticsPage />}
        {page === 'shortcuts' && (
          <div className="page">
            <div className="page-inner narrow" style={{ padding: 20, overflow: 'auto' }}>
              <h2 className="page-title">Keyboard &amp; mouse</h2>
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
        {page === 'settings' && <Disconnected />}
      </main>
    </div>
  );
}

/** Drag handles on the side panels' inner edges: drag to resize, double-click to hide or bring back. */
function Splitters({ ws }: { ws: string }) {
  const sz = usePanelSizes(ws);
  const drag = (side: 'left' | 'right') => (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX,
      // start from the width actually shown (a narrow window caps it)
      w0 = (el.parentElement?.querySelector(side === 'left' ? 'aside.left' : 'aside.right') as HTMLElement | null)?.offsetWidth ?? (side === 'left' ? sz.left : sz.right);
    if (side === 'left' ? sz.leftHidden : sz.rightHidden) setPanelSizes(ws, side === 'left' ? { leftHidden: false } : { rightHidden: false });
    const move = (ev: PointerEvent) => setPanelSizes(ws, side === 'left' ? { left: w0 + (ev.clientX - x0) } : { right: w0 - (ev.clientX - x0) });
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <>
      <div
        className={`ws-split ${sz.leftHidden ? 'hidden' : ''}`}
        style={{ left: `calc(${leftCss(sz)} - 3px)` }}
        onPointerDown={drag('left')}
        onDoubleClick={() => setPanelSizes(ws, { leftHidden: !sz.leftHidden })}
        title="Drag to resize · double-click to hide/show the panel"
      />
      <div
        className={`ws-split ${sz.rightHidden ? 'hidden' : ''}`}
        style={{ right: `calc(${rightCss(sz)} - 3px)` }}
        onPointerDown={drag('right')}
        onDoubleClick={() => setPanelSizes(ws, { rightHidden: !sz.rightHidden })}
        title="Drag to resize · double-click to hide/show the panel"
      />
    </>
  );
}

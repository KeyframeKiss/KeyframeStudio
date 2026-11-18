import { useEffect, useState, useSyncExternalStore } from 'react';
import { bridge } from '../bridge/client';
import { call, displayName, selectedCharacters, showTab, toast, useStore, type LibraryPage } from '../state/store';
import { FaceAnimation } from './FaceAnimation';
import { Group, SelectionHeader, Stack } from './InspectorStack';
import { AudioPanel } from './AudioPanel';
import { ShotsPanel } from './ShotsPanel';
import { TemplatesPanel } from './TemplatesPanel';
import { CharacterLibrary } from './CharacterLibrary';
import { QuickActionsPage } from './QuickActions';
import { columns, leftCss, rightCss, setPanelSizes, usePanelSizes } from '../lib/layout';
import { CleanupPanel } from './CleanupPanel';
import { ClipsPanel } from './ClipsPanel';
import { AnimationBrowser } from './AnimationBrowser';
import { CameraPanel } from './CameraPanel';
import { CharacterPanel } from './CharacterPanel';
import { DopeSheet } from './DopeSheet';
import { Icon } from './Icon';
import { Inspector, useGettingStarted } from './Inspector';
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
// Center sub-tabs (like Pose's): the big tools of a workspace, one at a time, at full width
// ---------------------------------------------------------------------------
interface SubTab {
  id: string;
  label: string;
  icon: string;
  hint?: string;
}

/** The workspace's current sub-tab: remembered, and switchable from elsewhere with showTab(ws, tab). */
function useCenterTab(ws: string, tabs: SubTab[], legacyKey?: string): [string, (id: string) => void] {
  const key = `kf.center.${ws}`;
  const valid = (t: string | null | undefined) => (t && tabs.some((x) => x.id === t) ? t : null);
  const [tab, setTab] = useState(() => {
    try {
      return valid(localStorage.getItem(key)) ?? valid(legacyKey ? localStorage.getItem(legacyKey) : null) ?? tabs[0].id;
    } catch {
      return tabs[0].id;
    }
  });
  const pick = (id: string) => {
    setTab(id);
    try {
      localStorage.setItem(key, id);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ ws: string; tab: string }>).detail;
      if (d.ws === ws && valid(d.tab)) setTab(d.tab);
    };
    window.addEventListener('kf:center-tab', on);
    return () => window.removeEventListener('kf:center-tab', on);
  }, [ws]); // eslint-disable-line react-hooks/exhaustive-deps
  return [tab, pick];
}

function CenterTabBar({ tabs, tab, pick, extra }: { tabs: SubTab[]; tab: string; pick: (id: string) => void; extra?: React.ReactNode }) {
  return (
    <div className="center-tabs">
      {tabs.map((t) => (
        <button key={t.id} className={`ws-subtab ${tab === t.id ? 'active' : ''}`} onClick={() => pick(t.id)} title={t.hint}>
          <Icon name={t.icon} size={14} /> {t.label}
        </button>
      ))}
      {extra && (
        <>
          <span style={{ flex: 1 }} />
          {extra}
        </>
      )}
    </div>
  );
}

/** A scrolling page inside a sub-tab, centred and not wider than `max`. */
function SubPage({ max = 760, children }: { max?: number; children: React.ReactNode }) {
  return (
    <div className="subpage">
      <div className="subpage-inner" style={{ maxWidth: max }}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Animate: scene | Timeline / Face / Motion clips + transport | keys, cleanup, selected object
// ---------------------------------------------------------------------------
const ANIMATE_TABS: SubTab[] = [
  { id: 'timeline', label: 'Timeline', icon: 'tracks', hint: 'Dope sheet and graph editor (Tab switches)' },
  { id: 'face', label: 'Face', icon: 'target', hint: 'Animate a face: expressions keyed at the playhead, lip-sync, blinks' },
  { id: 'clips', label: 'Motion clips', icon: 'scissors', hint: 'Save a stretch of animation and reuse it on any character' },
];

export function AnimateWorkspace() {
  const sizes = usePanelSizes('animate');
  const [tab, pick] = useCenterTab('animate', ANIMATE_TABS);
  return (
    <div className="ws ws-3" style={{ gridTemplateColumns: columns(sizes) }}>
      <Splitters ws="animate" />
      <ScenePanel />
      <main className="ws-center">
        <CenterTabBar tabs={ANIMATE_TABS} tab={tab} pick={pick} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <ErrorBoundary key={tab} name={ANIMATE_TABS.find((t) => t.id === tab)?.label ?? tab}>
            {tab === 'timeline' && <DopeSheet />}
            {tab === 'face' && <FaceAnimation />}
            {tab === 'clips' && (
              <SubPage max={1100}>
                <ClipsPanel wide />
              </SubPage>
            )}
          </ErrorBoundary>
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
  const started = useGettingStarted();
  useStore((s) => s.showEnglish);
  return (
    <Stack>
      {keys > 0 || tracks > 0 ? (
        <Group ws="animate" id="keys" icon="key" title={keys ? `Keyframe${keys > 1 ? `s (${keys})` : ''}` : `Track${tracks > 1 ? `s (${tracks})` : ''}`}>
          <Inspector />
        </Group>
      ) : (
        <Group ws="animate" id="tips" title={started.done ? 'Shortcuts' : 'Getting started'}>
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
// Pose: scene | Pose library / Animations / Face Studio / Outfit | the selected character's basics
// ---------------------------------------------------------------------------
const POSE_TABS: SubTab[] = [
  { id: 'poses', label: 'Pose library', icon: 'pose' },
  { id: 'anims', label: 'Animations', icon: 'animate' },
  { id: 'face', label: 'Face Studio', icon: 'target', hint: 'Face shape, expressions, mesh shapes' },
  { id: 'outfit', label: 'Outfit', icon: 'look', hint: 'Clothes, saved outfits, accessories' },
];

export function PoseWorkspace() {
  const sizes = usePanelSizes('pose');
  const [tab, pick] = useCenterTab('pose', POSE_TABS, 'studioex.pose.center');
  return (
    <div className="ws ws-3" style={{ gridTemplateColumns: columns(sizes) }}>
      <Splitters ws="pose" />
      <ScenePanel />
      <main className="ws-center">
        <CenterTabBar tabs={POSE_TABS} tab={tab} pick={pick} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <ErrorBoundary key={tab} name={POSE_TABS.find((t) => t.id === tab)?.label ?? tab}>
            {tab === 'poses' && <PosePanel wide />}
            {tab === 'anims' && <AnimationLibrary />}
            {tab === 'face' && <FaceStudio />}
            {tab === 'outfit' && <OutfitPage />}
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
          <CharacterPanel bare sections={['anim', 'pose', 'abmx']} />
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

/** Pose › Outfit: what the character wears (clothes and their states), saved outfits, accessories. */
function OutfitPage() {
  const isChar = useStore((s) => s.studioSelection.length > 0 && s.nodes[s.studioSelection[0]]?.type === 'Char');
  if (!isChar)
    return (
      <div className="empty" style={{ margin: 'auto' }}>
        <strong>Select a character</strong>
        Pick a character in the Scene list or in Studio to change what they wear.
      </div>
    );
  return (
    <div className="subpage">
      <div className="outfit-page">
        <div className="outfit-col">
          <CharacterPanel bare sections={['outfit']} />
        </div>
        <div className="outfit-col">
          <OutfitPanel />
        </div>
      </div>
    </div>
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
// Look: scene (for material targets) | Presets / Settings / Lighting (no side panel: everything is wide)
// ---------------------------------------------------------------------------
const LOOK_TABS: SubTab[] = [
  { id: 'presets', label: 'Presets', icon: 'look', hint: 'Saved looks: apply all or some parts, at any strength' },
  { id: 'settings', label: 'Settings', icon: 'sliders', hint: 'Color grade, bloom, depth of field, fog, toon shading, lights, materials' },
  { id: 'lighting', label: 'Lighting rigs', icon: 'bolt', hint: 'Light setups placed around a character' },
];

export function LookWorkspace() {
  const sizes = usePanelSizes('look');
  const [tab, pick] = useCenterTab('look', LOOK_TABS);
  return (
    <div className="ws ws-3" style={{ gridTemplateColumns: `${leftCss(sizes)} minmax(0, 1fr)` }}>
      <Splitters ws="look" right={false} />
      <ScenePanel />
      <main className="ws-center" style={{ position: 'relative' }}>
        <CenterTabBar tabs={LOOK_TABS} tab={tab} pick={pick} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <ErrorBoundary key={tab} name={LOOK_TABS.find((t) => t.id === tab)?.label ?? tab}>
            {tab === 'presets' && (
              <div className="subpage">
                <div className="subpage-inner" style={{ maxWidth: 'none', padding: 16 }}>
                  <LookPresets wide />
                </div>
              </div>
            )}
            {tab === 'settings' && (
              <div className="subpage look-wide">
                <LookPanel showPresets={false} />
              </div>
            )}
            {tab === 'lighting' && (
              <SubPage max={640}>
                <LightRigsPanel />
              </SubPage>
            )}
          </ErrorBoundary>
          <Disconnected />
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shoot: scene | Shots & camera (over the timeline) / Render / Templates | audio track
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

const SHOOT_TABS: SubTab[] = [
  { id: 'shots', label: 'Shots & camera', icon: 'camera', hint: 'Shots, saved views, camera keys and moves, over the timeline' },
  { id: 'render', label: 'Render', icon: 'record', hint: 'Make a video with VideoExport' },
  { id: 'templates', label: 'Templates', icon: 'library', hint: "A scene's staging, reused in another scene" },
];

export function ShootWorkspace() {
  const sizes = usePanelSizes('shoot');
  const [tab, pick] = useCenterTab('shoot', SHOOT_TABS);
  return (
    <div className="ws ws-3" style={{ gridTemplateColumns: columns(sizes) }}>
      <Splitters ws="shoot" />
      <ScenePanel />
      <main className="ws-center" style={{ position: 'relative' }}>
        <CenterTabBar tabs={SHOOT_TABS} tab={tab} pick={pick} />
        <ErrorBoundary key={tab} name={SHOOT_TABS.find((t) => t.id === tab)?.label ?? tab}>
          {tab === 'shots' && <ShotsAndCamera />}
          {tab === 'render' && (
            <SubPage max={620}>
              <RenderPanel />
            </SubPage>
          )}
          {tab === 'templates' && (
            <SubPage max={620}>
              <TemplatesPanel />
            </SubPage>
          )}
        </ErrorBoundary>
        <Disconnected />
      </main>
      <Stack>
        <Group ws="shoot" id="audio" icon="pulse" title="Audio track">
          <AudioPanel parts={['track']} />
          <div className="section">
            <button className="btn solid wide" style={{ width: '100%', justifyContent: 'center' }} onClick={() => showTab('animate', 'face')} title="Lip-sync and blinks are with the face controls">
              Lip-sync in Animate › Face ›
            </button>
          </div>
        </Group>
      </Stack>
    </div>
  );
}

function ShotsAndCamera() {
  const top = useSyncExternalStore(subscribeShoot, () => shootTop);
  const noShots = useStore((s) => s.shots.length === 0);
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
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className={`shoot-top ${noShots ? 'no-shots' : ''}`} style={{ flexBasis: `${top * 100}%` }}>
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
function Splitters({ ws, right = true }: { ws: string; right?: boolean }) {
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
      {right && (
      <div
        className={`ws-split ${sz.rightHidden ? 'hidden' : ''}`}
        style={{ right: `calc(${rightCss(sz)} - 3px)` }}
        onPointerDown={drag('right')}
        onDoubleClick={() => setPanelSizes(ws, { rightHidden: !sz.rightHidden })}
        title="Drag to resize · double-click to hide/show the panel"
      />
      )}
    </>
  );
}

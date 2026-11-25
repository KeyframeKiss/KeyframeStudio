import { useEffect, useState, useSyncExternalStore } from 'react';
import { bridge } from '../bridge/client';
import { openLibrary, showTab, workingShot, renderShots, displayName, selectedCharacters, setOutputMode, useStore, type LibraryPage } from '../state/store';
import { EmptyState } from './EditorBits';
import { BodySliders } from './AbmxSection';
import { PosingPage } from './PosingPage';
import { FaceAnimation } from './FaceAnimation';
import { Group, SelectionHeader, Stack } from './InspectorStack';
import { AudioPage } from './AudioPage';
import { ShotsPage } from './shots/ShotsPage';
import { TemplatesPanel } from './TemplatesPanel';
import { CharacterLibrary } from './CharacterLibrary';
import { QuickActionsPage } from './QuickActions';
import { columns, leftCss, rightCss, setPanelSizes, usePanelSizes } from '../lib/layout';
import { CleanupPanel } from './CleanupPanel';
import { ClipsPanel } from './ClipsPanel';
import { AnimationBrowser } from './AnimationBrowser';
import { applyAnimation } from '../lib/animation';
import { MotionPage } from './motion/MotionPage';
import { CharacterAnimationPanel } from './CharacterAnimation';
import { CharacterPanel } from './CharacterPanel';
import { DopeSheet } from './DopeSheet';
import { Icon } from './Icon';
import { Inspector, useGettingStarted } from './Inspector';
import { RenderPanel } from './RenderPanel';
import { OutfitPanel } from './OutfitPanel';
import { LightingPage } from './LightingPage';
import { LookPanel, Switch } from './LookPanel';
import { FrameGuidesPanel, toggleGuides, useGuidesShowing } from './CameraToolsCards';
import { CameraMenu, useCamLoader } from './CameraPanel';
import { PicturePage } from './PicturePage';
import { MaterialEditorPage } from './MaterialEditor';
import { ItemLibrary } from './ItemLibrary';
import { Col, Columns, Page, Section } from './Page';
import { StillsPage } from './StillsPage';
import { StudioWindowPage } from './StudioWindowPage';
import { LookPresets } from './LookPresets';
import { ModSettings } from './ModSettings';
import { AttachmentPanel } from './AttachmentPanel';
import { ObjectPanel } from './ObjectPanel';
import { Outliner } from './Outliner';
import { PosePanel } from './PosePanel';
import { SceneBrowser } from './SceneBrowser';
import { TransportBar } from './Shell';
import { TranslatePanel } from './TranslatePanel';
import { FaceStudio } from './FaceStudio';
import { ErrorBoundary } from './ErrorBoundary';
import { ShortcutList } from './ShortcutList';
import { DiagnosticsPage } from './DiagnosticsPage';
import { HelpGuide } from './HelpGuide';
import { AppearancePage } from './AppearancePage';

export function Disconnected() {
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
            Start <code>CharaStudio.exe</code>. Keyframe Studio connects by itself once its bridge plugin is in Koikatsu — first time here? Set it up in one click.
          </>
        )}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
          {status !== 'open' && window.studioEx?.setup && (
            <button className="btn primary" onClick={() => openLibrary('about')}>
              Set up the bridge
            </button>
          )}
          <button className="btn solid" onClick={() => openLibrary('about')}>Open diagnostics</button>
        </div>
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
// Animate: scene | Timeline / Motion builder (+ clip shelf) / Face / Cleanup + transport | keys, selected object
// ---------------------------------------------------------------------------
const ANIMATE_TABS: SubTab[] = [
  { id: 'timeline', label: 'Timeline', icon: 'tracks', hint: 'Dope sheet and graph editor (Tab switches)' },
  { id: 'motion', label: 'Motion builder', icon: 'animate', hint: 'Line up Studio clips and poses on a character, blend them, and get keys' },
  { id: 'face', label: 'Face', icon: 'target', hint: 'Animate a face: expressions keyed at the playhead, lip-sync, blinks' },
  { id: 'cleanup', label: 'Cleanup', icon: 'sliders', hint: 'Lock a foot or hand, smooth, retime, loop, and find sudden moves or sliding feet' },
];

export function AnimateWorkspace() {
  const shot = useStore(workingShot);
  const loop = useStore((s) => s.loopShot);
  const canRender = useStore((s) => s.hello?.features?.some((f) => f.id === 'render' && f.status !== 'off'));
  const sizes = usePanelSizes('animate');
  const [tab, pick] = useCenterTab('animate', ANIMATE_TABS);
  return (
    <div className="ws ws-3" style={{ gridTemplateColumns: columns(sizes) }}>
      <Splitters ws="animate" />
      <ScenePanel />
      <main className="ws-center">
        <CenterTabBar tabs={ANIMATE_TABS} tab={tab} pick={pick} />
        {shot && <div className="working-shot">
          <b title={shot.name}>{shot.name}</b><span>{shot.start.toFixed(2)}–{shot.end.toFixed(2)} s</span>
          <button className={`btn small ${loop ? 'on' : ''}`} aria-pressed={loop} onClick={() => useStore.setState({ loopShot: !loop })}>Loop shot</button>
          {canRender && <button className="btn small" onClick={() => renderShots([shot.id])}>Render this shot</button>}
          <button className="btn small" onClick={() => {
            useStore.setState({ workingShotId: null, frameFullTimeline: true, loopShot: false });
            showTab('animate', 'timeline');
          }}>Show full timeline</button>
        </div>}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <ErrorBoundary key={tab} name={ANIMATE_TABS.find((t) => t.id === tab)?.label ?? tab}>
            {tab === 'timeline' && <DopeSheet />}
            {tab === 'motion' && <MotionWithShelf />}
            {tab === 'face' && <FaceAnimation />}
            {tab === 'cleanup' && (
              <SubPage max={1100}>
                <CleanupPanel />
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
      {node?.type === 'Char' && (
        <Group
          ws="animate"
          id="charanim"
          icon="animate"
          title={
            <>
              Character animation <span className="group-sub">{displayName(node)}</span>
            </>
          }
        >
          <CharacterAnimationPanel id={node.id} />
        </Group>
      )}
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
          pinned
        >
          <ObjectPanel bare />
        </Group>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Character (internally 'pose'): scene | Poses / Animations / Face shape / Outfit / Body | the selected character's state
// ---------------------------------------------------------------------------
const POSE_TABS: SubTab[] = [
  { id: 'poses', label: 'Poses', icon: 'pose', hint: 'The pose library: apply, save, mirror, copy between characters' },
  { id: 'posing', label: 'Posing', icon: 'target', hint: 'How each part is posed (joints or a target), target strength, joint correction, copy a side, physics, every bone' },
  { id: 'anims', label: 'Animations', icon: 'animate', hint: "Studio's animations for the selected character" },
  { id: 'face', label: 'Face shape', icon: 'target', hint: 'Face parts, saved faces and expressions, mesh shapes' },
  { id: 'outfit', label: 'Outfit', icon: 'look', hint: 'Clothes, saved outfits, accessories' },
  { id: 'body', label: 'Body', icon: 'sliders', hint: 'Body sliders (ABMX): every bone’s size and position' },
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
            {tab === 'body' && <BodyPage />}
            {tab === 'posing' && <PosingTab />}
          </ErrorBoundary>
          <Disconnected />
        </div>
      </main>
      <PoseInspector />
    </div>
  );
}

function PoseInspector() {
  const item = useStore(s => s.studioSelection.length === 1 && s.nodes[s.studioSelection[0]]?.type === 'Item' ? s.studioSelection[0] : null);
  const any = useStore((s) => s.studioSelection.length > 0);
  const isChar = useStore((s) => s.studioSelection.length > 0 && s.nodes[s.studioSelection[0]]?.type === 'Char');
  return (
    <Stack>
      <SelectionHeader empty="Select a character in the Scene list or in Studio. With several selected, changes apply to all of them." />
      {isChar && (
        <Group ws="pose" id="character" icon="pose" title="Character">
          <CharacterPanel bare sections={['anim', 'pose']} />
        </Group>
      )}
      {item !== null && <Group ws="pose" id="attachment" icon="target" title="Attachment">
        <AttachmentPanel key={item} id={item} />
      </Group>}
      {any && (
        <Group ws="pose" id={isChar ? 'object' : 'object-item'} icon="target" title="Transform" defaultOpen={!isChar} pinned>
          <ObjectPanel bare />
        </Group>
      )}
    </Stack>
  );
}

/** Character › Body: the selected character's body sliders (ABMX), on a page of their own. */
function BodyPage() {
  const id = useStore((s) => (s.studioSelection.length > 0 && s.nodes[s.studioSelection[0]]?.type === 'Char' ? s.studioSelection[0] : null));
  if (id == null)
    return (
      <div className="pg">
        <div className="pg-inner" style={{ maxWidth: 760 }}>
          <EmptyState title="Select a character">Pick the character whose body to adjust, in the Scene list or in Studio.</EmptyState>
        </div>
      </div>
    );
  return (
    <SubPage max={1400}>
      <BodySliders key={id} id={id} />
    </SubPage>
  );
}

/** Character › Posing for the selected character. */
function PosingTab() {
  const id = useStore((s) => (s.studioSelection.length > 0 && s.nodes[s.studioSelection[0]]?.type === 'Char' ? s.studioSelection[0] : null));
  if (id == null)
    return (
      <div className="pg">
        <div className="pg-inner" style={{ maxWidth: 760 }}>
          <EmptyState title="Select a character">Pick the character to pose, in the Scene list or in Studio.</EmptyState>
        </div>
      </div>
    );
  return (
    <SubPage max={1300}>
      <PosingPage key={id} id={id} />
    </SubPage>
  );
}

/** Character › Outfit: what the character wears (clothes and their states), saved outfits, accessories. */
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
    <Page max={1100}>
      <Columns>
        <Col label="What they wear">
          <div className="outfit-col">
            <CharacterPanel bare sections={['outfit']} />
          </div>
        </Col>
        <Col label="Outfits & accessories">
          <div className="outfit-col">
            <OutfitPanel />
          </div>
        </Col>
      </Columns>
    </Page>
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
          if (await applyAnimation(chars, g, c, n)) setCurrent({ group: g, category: c, no: n });
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
  { id: 'picture', label: 'Picture', icon: 'sparkle', hint: "Colour, lens, atmosphere and character shading: Studio's settings and Keyframe Studio's effects together" },
  { id: 'lighting', label: 'Lighting', icon: 'bolt', hint: "Studio's two lights, lighting rigs around a character, projectors (window light, blinds, leaf shadows), lights that aim at a character" },
  { id: 'materials', label: 'Materials', icon: 'grid', hint: 'MaterialEditor: one material at a time, or one value across every material of a shader' },
];

/** Look › Materials: one material at a time (MaterialEditor), or one value across every material of a shader. */
function MaterialsTab() {
  const [mode, setMode] = useState<'one' | 'shader'>(() => {
    try {
      return localStorage.getItem('kf.materials.mode') === 'shader' ? 'shader' : 'one';
    } catch {
      return 'one';
    }
  });
  const pick = (m: 'one' | 'shader') => {
    setMode(m);
    try {
      localStorage.setItem('kf.materials.mode', m);
    } catch {
      /* a convenience only */
    }
  };
  return (
    <div className="subpage" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="output-mode">
        <div className="seg" role="tablist" aria-label="How to edit materials">
          <button role="tab" aria-selected={mode === 'one'} className={mode === 'one' ? 'on' : ''} onClick={() => pick('one')}>
            One material
          </button>
          <button role="tab" aria-selected={mode === 'shader'} className={mode === 'shader' ? 'on' : ''} onClick={() => pick('shader')}>
            By shader
          </button>
        </div>
      </div>
      {mode === 'one' ? (
        <MaterialEditorPage />
      ) : (
        <Page max={1100}>
          <Section title="Materials by shader" help="One value across every material of the same shader on the selected characters or items, through MaterialEditor (saved like MaterialEditor edits).">
            <LookPanel cards={['materials']} />
          </Section>
        </Page>
      )}
    </div>
  );
}

export function LookWorkspace() {
  const sizes = usePanelSizes('look');
  const [tab, pick] = useCenterTab('look', LOOK_TABS);
  return (
    <div className="ws ws-3" style={{ gridTemplateColumns: columns(sizes) }}>
      <Splitters ws="look" />
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
            {tab === 'picture' && (
              <div className="subpage">
                <PicturePage />
              </div>
            )}
            {tab === 'materials' && <MaterialsTab />}
            {tab === 'lighting' && (
              <div className="subpage">
                <LightingPage />
              </div>
            )}
          </ErrorBoundary>
          <Disconnected />
        </div>
      </main>
      <ObjectInspector ws="look" />
    </div>
  );
}

/** Shoot's right column: frame guides and Studio's camera always at hand, the selected object below. */
function ShootInspector() {
  useCamLoader();
  const guidesOn = useGuidesShowing();
  const first = useStore((s) => s.studioSelection[0]);
  const node = useStore((s) => (first != null ? s.nodes[first] : undefined));
  useStore((s) => s.showEnglish);
  return (
    <Stack>
      <Group
        ws="shoot"
        id="guides"
        icon="grid"
        title="Frame guides"
        extra={<Switch on={guidesOn} onChange={() => toggleGuides()} />}
      >
        <FrameGuidesPanel bare />
      </Group>
      <Group ws="shoot" id="camera" icon="camera" title="Camera">
        <CameraMenu />
      </Group>
      {node && (
        <Group
          ws="shoot"
          id="object"
          icon="target"
          title={
            <>
              Object <span className="group-sub">{displayName(node)}</span>
            </>
          }
          defaultOpen={false}
          pinned
        >
          <ObjectPanel bare />
        </Group>
      )}
    </Stack>
  );
}

/** The right column in Look: the selected object (a light, a camera, an item…), always at hand. */
function ObjectInspector({ ws }: { ws: string }) {
  const first = useStore((s) => s.studioSelection[0]);
  const node = useStore((s) => (first != null ? s.nodes[first] : undefined));
  useStore((s) => s.showEnglish);
  return (
    <Stack>
      {node ? (
        <Group
          ws={ws}
          id="object"
          icon="target"
          title={
            <>
              Object <span className="group-sub">{displayName(node)}</span>
            </>
          }
        >
          <ObjectPanel bare />
        </Group>
      ) : (
        <EmptyState title="Nothing selected">Select a light, camera or item in the Scene list or in Studio to move and adjust it here.</EmptyState>
      )}
    </Stack>
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
  { id: 'audio', label: 'Audio', icon: 'pulse', hint: 'The audio track that plays with the timeline' },
  { id: 'output', label: 'Output', icon: 'record', hint: 'Videos (VideoExport) and pictures: sizes, versions, the queue' },
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
          {tab === 'audio' && <AudioPage />}
          {tab === 'output' && <OutputPage />}
        </ErrorBoundary>
        <Disconnected />
      </main>
      <ShootInspector />
    </div>
  );
}

/** Animate › Motion builder, with its motion clip shelf on the right when open (save, apply and manage clips). */
function MotionWithShelf() {
  const shelf = useStore((s) => s.clipShelf);
  return (
    <div className="mo-split">
      <div className="mo-split-main">
        <MotionPage />
      </div>
      {shelf && (
        <aside className="mo-shelf" aria-label="Motion clips">
          <ClipsPanel />
        </aside>
      )}
    </div>
  );
}

/** Shoot › Output: a video (VideoExport) or pictures, one tab with the mode on top. */
function OutputPage() {
  const mode = useStore((s) => s.outputMode);
  return (
    <div className="subpage">
      <div className="output-mode">
        <div className="seg" role="tablist" aria-label="What to make">
          <button role="tab" aria-selected={mode === 'video'} className={mode === 'video' ? 'on' : ''} onClick={() => setOutputMode('video')}>
            <Icon name="record" size={13} /> Video
          </button>
          <button role="tab" aria-selected={mode === 'pictures'} className={mode === 'pictures' ? 'on' : ''} onClick={() => setOutputMode('pictures')}>
            <Icon name="camera" size={13} /> Pictures
          </button>
        </div>
      </div>
      {mode === 'video' ? <RenderPanel /> : <StillsPage />}
    </div>
  );
}

function ShotsAndCamera() {
  const top = useSyncExternalStore(subscribeShoot, () => shootTop);
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const box = el.parentElement!.getBoundingClientRect();
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setShootTop((ev.clientY - box.top) / box.height);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  };
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="shoot-top" style={{ flexBasis: `${top * 100}%` }}>
        <ShotsPage />
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
  { id: 'items', label: 'Objects', icon: 'grid', hint: 'Every item and mod, with pictures' },
  { id: 'templates', label: 'Templates', icon: 'library', hint: "A scene's staging, reused in another scene" },
];
const SETTINGS_PAGES: PageDef[] = [
  { id: 'help', label: 'Help & guide', icon: 'book', hint: 'Getting started, good habits, fixes' },
  { id: 'appearance', label: 'Appearance', icon: 'look', hint: 'Dark or light theme, accent colour' },
  { id: 'settings', label: 'Mod settings', icon: 'settings', hint: 'Every plugin option' },
  { id: 'studio', label: 'Studio window', icon: 'eyeOff', hint: "Hide Studio's menus: just the picture" },
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
        {page === 'items' && <ItemLibrary />}
        {page === 'templates' && <TemplatesPanel />}
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
        {page === 'help' && <HelpGuide />}
        {page === 'appearance' && <AppearancePage />}
        {page === 'studio' && <StudioWindowPage />}
        {page === 'shortcuts' && (
          <div className="page">
            <div className="page-inner narrow" style={{ padding: 20, overflow: 'auto' }}>
              <h2 className="page-title">Keyboard &amp; mouse</h2>
              <ShortcutList />
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
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
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

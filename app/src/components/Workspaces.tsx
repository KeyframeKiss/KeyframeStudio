import { useEffect, useState, type ReactNode } from 'react';
import { bridge } from '../bridge/client';
import { call, displayName, selectedCharacters, toast, useStore, type LibraryPage } from '../state/store';
import { AddTrackPanel } from './AddTrackPanel';
import { AnimationBrowser } from './AnimationBrowser';
import { CameraPanel } from './CameraPanel';
import { CharacterPanel } from './CharacterPanel';
import { DopeSheet } from './DopeSheet';
import { Icon } from './Icon';
import { Inspector } from './Inspector';
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

/** Panel with a compact tab strip; remembers its tab per workspace. */
function TabbedPanel({ id, tabs, side }: { id: string; tabs: { id: string; label: string; icon?: string; render: () => ReactNode }[]; side: 'left' | 'right' }) {
  const key = `studioex.tab.${id}`;
  const [tab, setTab] = useState(() => {
    try {
      return localStorage.getItem(key) || tabs[0].id;
    } catch {
      return tabs[0].id;
    }
  });
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  // Other parts of the app can bring a tab forward (e.g. "Add animation track…").
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ panel: string; tab: string }>).detail;
      if (d.panel === id) setTab(d.tab);
    };
    window.addEventListener('studioex:tab', on);
    return () => window.removeEventListener('studioex:tab', on);
  }, [id]);
  return (
    <aside className={`panel ${side}`}>
      {tabs.length > 1 && (
        <div className="panel-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`panel-tab ${t.id === current.id ? 'active' : ''}`}
              onClick={() => {
                setTab(t.id);
                try {
                  localStorage.setItem(key, t.id);
                } catch {
                  /* ignore */
                }
              }}
            >
              {t.icon && <Icon name={t.icon} size={13} />}
              {t.label}
            </button>
          ))}
        </div>
      )}
      {tabs.length === 1 && <div className="panel-title">{current.label}</div>}
      {current.render()}
    </aside>
  );
}

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
            Studio EX edits Timeline animations — install Timeline (part of the HSPE/KKPE packs).
          </>
        ) : (
          <>
            <span className={`status-dot ${status === 'connecting' ? 'connecting' : ''}`} style={{ display: 'inline-block' }} />
            <h2>Waiting for CharaStudio…</h2>
            Start <code>CharaStudio.exe</code> with <code>KKStudioEX.Bridge</code> in <code>BepInEx/plugins</code>. Studio EX connects automatically.
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Animate: scene + tracks | timeline + transport | key inspector
// ---------------------------------------------------------------------------
export function AnimateWorkspace() {
  return (
    <div className="ws ws-3">
      <TabbedPanel
        id="animate.left"
        side="left"
        tabs={[
          { id: 'scene', label: 'Scene', render: () => <Outliner /> },
          { id: 'tracks', label: 'Add track', render: () => <AddTrackPanel /> },
          { id: 'camera', label: 'Camera', render: () => <CameraPanel /> },
        ]}
      />
      <main className="ws-center">
        <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
          <DopeSheet />
          <Disconnected />
        </div>
        <TransportBar />
      </main>
      <TabbedPanel
        id="animate.right"
        side="right"
        tabs={[
          { id: 'inspector', label: 'Inspector', render: () => <Inspector /> },
          { id: 'object', label: 'Transform', render: () => <ObjectPanel /> },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pose: scene | pose library / animations | character + transform
// ---------------------------------------------------------------------------
export function PoseWorkspace() {
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
    <div className="ws ws-3">
      <TabbedPanel id="pose.left" side="left" tabs={[{ id: 'scene', label: 'Scene', render: () => <Outliner /> }]} />
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
      <TabbedPanel
        id="pose.right"
        side="right"
        tabs={[
          { id: 'character', label: 'Character', render: () => <CharacterPanel /> },
          { id: 'object', label: 'Transform', render: () => <ObjectPanel /> },
        ]}
      />
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
// Look: scene (for material targets) | preset gallery | look controls
// ---------------------------------------------------------------------------
export function LookWorkspace() {
  return (
    <div className="ws ws-3">
      <TabbedPanel id="look.left" side="left" tabs={[{ id: 'scene', label: 'Scene', render: () => <Outliner /> }]} />
      <main className="ws-center" style={{ position: 'relative' }}>
        <div className="page">
          <div className="page-inner" style={{ padding: 16, overflow: 'auto' }}>
            <h2 className="page-title">Looks</h2>
            <LookPresets wide />
          </div>
        </div>
        <Disconnected />
      </main>
      <TabbedPanel id="look.right" side="right" tabs={[{ id: 'look', label: 'Look settings', render: () => <LookPanel showPresets={false} /> }]} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library: scenes, translations, mod settings, shortcuts
// ---------------------------------------------------------------------------
const PAGES: { id: LibraryPage; label: string; icon: string; hint: string }[] = [
  { id: 'scenes', label: 'Scenes', icon: 'scenes', hint: 'Load, import, save scenes' },
  { id: 'translate', label: 'Translations', icon: 'translate', hint: 'Fix Japanese → English names' },
  { id: 'settings', label: 'Mod settings', icon: 'settings', hint: 'Every plugin option' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', hint: 'Keyboard & mouse' },
];

export function LibraryWorkspace() {
  const page = useStore((s) => s.libraryPage);
  return (
    <div className="ws ws-lib">
      <aside className="panel left lib-nav">
        {PAGES.map((p) => (
          <button key={p.id} className={`lib-nav-item ${page === p.id ? 'active' : ''}`} onClick={() => useStore.setState({ libraryPage: p.id })}>
            <Icon name={p.icon} size={16} />
            <span>
              <b>{p.label}</b>
              <small>{p.hint}</small>
            </span>
          </button>
        ))}
      </aside>
      <main className="ws-center" style={{ position: 'relative' }}>
        {page === 'scenes' && <SceneBrowser />}
        {page === 'translate' && (
          <div className="page">
            <div className="page-inner narrow" style={{ padding: 16 }}>
              <h2 className="page-title">Translations</h2>
              <TranslatePanel />
            </div>
          </div>
        )}
        {page === 'settings' && <ModSettings />}
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
        {page !== 'shortcuts' && page !== 'translate' && <Disconnected />}
      </main>
    </div>
  );
}

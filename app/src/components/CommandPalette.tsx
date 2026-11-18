import { useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import {
  call,
  copySelected,
  deleteSelectedKeys,
  displayName,
  duplicateSelectedToPlayhead,
  keyAllOfSelectedObjects,
  keyChanged,
  keySelected,
  lsSet,
  openLibrary,
  pasteAtPlayhead,
  redo,
  seek,
  selectAllKeys,
  selectedCharacters,
  setAutoKey,
  setTimelineUiVisible,
  setWorkspace,
  showPanel,
  showTab,
  stop,
  studioSelect,
  toast,
  togglePlay,
  undo,
  useStore,
} from '../state/store';
import { applyCurveToSelected } from '../state/store';
import { PRESETS, toFlat } from '../lib/curve';
import { Icon } from './Icon';
import { lookChanged } from './LookPresets';

import { isRecording, macros } from '../lib/macros';
import { runMacro } from './QuickActions';
interface Cmd {
  id: string;
  title: string;
  group: string;
  kbd?: string;
  keywords?: string;
  run: () => unknown;
}

const RECENT_KEY = 'studioex.palette.recent';

function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  if (!open) return null;
  return <PaletteInner />;
}

function PaletteInner() {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [looks, setLooks] = useState<{ file: string; name: string }[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const nodes = useStore((s) => s.nodes);
  const close = () => useStore.setState({ paletteOpen: false });

  useEffect(() => {
    call<{ file: string; name: string }[]>('look.presets').then((l) => l && setLooks(l));
  }, []);

  const commands = useMemo<Cmd[]>(() => {
    const st = useStore.getState();
    const c: Cmd[] = [
      { id: 'ws.animate', group: 'Workspace', title: 'Go to Animate', kbd: 'Ctrl 1', run: () => setWorkspace('animate') },
      { id: 'ws.pose', group: 'Workspace', title: 'Go to Pose', kbd: 'Ctrl 2', run: () => setWorkspace('pose') },
      { id: 'ws.look', group: 'Workspace', title: 'Go to Look', kbd: 'Ctrl 3', run: () => setWorkspace('look') },
      { id: 'ws.shoot', group: 'Workspace', title: 'Go to Shoot', kbd: 'Ctrl 4', keywords: 'camera shots audio render video export', run: () => setWorkspace('shoot') },
      { id: 'ws.library', group: 'Workspace', title: 'Go to Library', kbd: 'Ctrl 5', run: () => setWorkspace('library') },
      { id: 'shoot.render', group: 'Shoot', title: 'Render video', keywords: 'export mp4 webm gif videoexport', run: () => showTab('shoot', 'render') },
      { id: 'shoot.audio', group: 'Shoot', title: 'Audio track', keywords: 'wav sound voice music', run: () => showTab('shoot', 'audio') },
      { id: 'anim.face', group: 'Keys', title: 'Animate the face (expressions, lip-sync, blinks)', keywords: 'face mouth eyes brows lip sync blink expression vowels', run: () => showTab('animate', 'face') },
      { id: 'anim.track', group: 'Keys', title: 'Add animation track…', keywords: 'property animate new track', run: () => { if (useStore.getState().workspace !== 'shoot') setWorkspace('animate'); window.setTimeout(() => window.dispatchEvent(new CustomEvent('kf:add-track')), 50); } },
      { id: 'anim.clips', group: 'Keys', title: 'Motion clips (save / apply)', keywords: 'clip reuse segment wave nod walk cycle library', run: () => showTab('animate', 'clips') },
      { id: 'shoot.templates', group: 'Shoot', title: 'Production templates', keywords: 'template staging setup reuse scene', run: () => showTab('shoot', 'templates') },
      { id: 'anim.cleanup', group: 'Keys', title: 'Clean up keys (smooth, retime, loop)', keywords: 'smooth retime loop pops sliding', run: () => showPanel('animate', 'cleanup') },
      { id: 'lib.scenes', group: 'Scenes', title: 'Open scene browser', kbd: 'Ctrl O', keywords: 'load import', run: () => openLibrary('scenes') },
      { id: 'scene.save', group: 'Scenes', title: 'Save scene (new file)', run: () => call('scene.save').then((r) => r !== undefined && toast('Scene saved')) },
      { id: 'lib.translate', group: 'Settings', title: 'Fix translations', keywords: 'english japanese names', run: () => openLibrary('translate') },
      { id: 'lib.settings', group: 'Settings', title: 'Mod settings', kbd: 'Ctrl ,', keywords: 'config plugins options', run: () => openLibrary('settings') },
      { id: 'lib.shortcuts', group: 'Settings', title: 'Keyboard shortcuts', kbd: '?', run: () => openLibrary('shortcuts') },
      { id: 'play', group: 'Playback', title: 'Play / pause', kbd: 'Space', run: togglePlay },
      { id: 'stop', group: 'Playback', title: 'Stop (back to start)', run: stop },
      { id: 'start', group: 'Playback', title: 'Go to start', kbd: 'Home', run: () => seek(0) },
      { id: 'key.selected', group: 'Keys', title: 'Key selected tracks at playhead', kbd: 'K', run: keySelected },
      { id: 'key.changed', group: 'Keys', title: 'Key everything changed in Studio', kbd: 'Shift Enter', keywords: 'pending', run: keyChanged },
      { id: 'key.object', group: 'Keys', title: 'Key all tracks of selected object', kbd: 'Shift K', run: keyAllOfSelectedObjects },
      { id: 'autokey', group: 'Keys', title: `${st.autoKey ? 'Turn off' : 'Turn on'} auto-key`, kbd: 'R', keywords: 'record', run: () => setAutoKey(!useStore.getState().autoKey) },
      { id: 'keys.all', group: 'Keys', title: 'Select all visible keys', kbd: 'Ctrl A', run: selectAllKeys },
      { id: 'keys.copy', group: 'Keys', title: 'Copy selected keys', kbd: 'Ctrl C', run: copySelected },
      { id: 'keys.paste', group: 'Keys', title: 'Paste keys at playhead', kbd: 'Ctrl V', run: pasteAtPlayhead },
      { id: 'keys.dup', group: 'Keys', title: 'Duplicate keys to playhead', kbd: 'Ctrl D', run: duplicateSelectedToPlayhead },
      { id: 'keys.delete', group: 'Keys', title: 'Delete selected keys', kbd: 'Del', run: deleteSelectedKeys },
      ...PRESETS.slice(0, 5).map((p) => ({ id: 'ease.' + p.id, group: 'Easing', title: `Set easing: ${p.label}`, kbd: p.hotkey, run: () => applyCurveToSelected(toFlat(p.curve)) })),
      { id: 'undo', group: 'Edit', title: 'Undo', kbd: 'Ctrl Z', run: undo },
      { id: 'redo', group: 'Edit', title: 'Redo', kbd: 'Ctrl Y', run: redo },
      { id: 'view.graph', group: 'View', title: 'Toggle dope sheet / graph editor', kbd: 'Tab', run: () => { const v = useStore.getState().centerView === 'dope' ? 'graph' : 'dope'; useStore.setState({ centerView: v, workspace: 'animate' }); lsSet('studioex.view', v); } },
      { id: 'pose.face', group: 'Pose', title: 'Face Studio', keywords: 'face eyes nose mouth brows kkpe adjust', run: () => showTab('pose', 'face') },
      { id: 'pose.outfit', group: 'Pose', title: 'Outfit (clothes, saved outfits, accessories)', keywords: 'clothes coordinate accessories outfit', run: () => showTab('pose', 'outfit') },
      { id: 'look.settings', group: 'Look', title: 'Look settings', keywords: 'bloom lut toon fog vignette dof', run: () => showTab('look', 'settings') },
      { id: 'look.lighting', group: 'Look', title: 'Lighting rigs', keywords: 'lights rig three point rembrandt', run: () => showTab('look', 'lighting') },
      { id: 'view.preview', group: 'View', title: 'Live preview (experimental)', keywords: 'stream viewport camera render', run: () => useStore.setState((s) => ({ previewOpen: !s.previewOpen })) },
      { id: 'view.frame', group: 'View', title: 'Frame all keys', kbd: 'F', run: () => window.dispatchEvent(new CustomEvent('studioex:frame')) },
      { id: 'view.length', group: 'View', title: 'Show whole timeline length', kbd: 'Shift F', run: () => window.dispatchEvent(new CustomEvent('studioex:zoom', { detail: 'duration' })) },
      { id: 'view.english', group: 'View', title: `${st.showEnglish ? 'Show original (Japanese) names' : 'Show English names'}`, run: () => { const v = !useStore.getState().showEnglish; useStore.setState({ showEnglish: v }); lsSet('studioex.english', v ? '1' : '0'); } },
      { id: 'view.legacy', group: 'View', title: "Toggle Timeline's own window in Studio", run: () => { const tl = useStore.getState().tl; if (tl) setTimelineUiVisible(!tl.uiVisible); } },
      { id: 'vp.paths', group: 'Viewport', title: 'Toggle motion paths', run: () => bridge.request<{ paths: boolean }>('viewport.get').then((v) => bridge.request('viewport.set', { paths: !v.paths })).then(() => useStore.setState((s) => ({ revision: s.revision + 1 }))) },
      { id: 'vp.ghosts', group: 'Viewport', title: 'Toggle ghosts (onion skin)', run: () => bridge.request<{ ghosts: boolean }>('viewport.get').then((v) => bridge.request('viewport.set', { ghosts: !v.ghosts })).then(() => useStore.setState((s) => ({ revision: s.revision + 1 }))) },
      { id: 'pose.mirror', group: 'Pose', title: 'Mirror pose of selected characters', kbd: 'M', run: () => { const ids = selectedCharacters(); if (!ids.length) return toast('Select a character first'); call('pose.mirror', { ids }); } },
      { id: 'look.reset', group: 'Look', title: "Reset look to Studio's default", run: () => call('look.resetDefault').then(lookChanged) },
      { id: 'folder.new', group: 'Tracks', title: 'New folder from selected tracks', kbd: 'Ctrl G', run: () => window.dispatchEvent(new CustomEvent('studioex:group')) },
      { id: 'macro.record', group: 'Quick actions', title: isRecording() ? 'Stop recording the quick action' : 'Record a quick action', keywords: 'macro automate repeat', run: () => openLibrary('macros') },
      ...macros().map((m) => ({ id: 'macro.run.' + m.name, group: 'Quick actions', title: `Run: ${m.name}`, keywords: 'macro quick action', run: () => runMacro(m) })),
      ...looks.map((l) => ({ id: 'look.apply.' + l.file, group: 'Apply look', title: l.name, keywords: 'preset look', run: () => call('look.applyPreset', { file: l.file, strength: 1, ids: useStore.getState().studioSelection }).then((r) => { if (r) { lookChanged(); toast(`Applied “${l.name}”`); } }) })),
      ...Object.values(nodes)
        .filter((n) => n.type !== 'node')
        .map((n) => ({ id: 'select.' + n.id, group: 'Select', title: displayName(n), keywords: `${n.name} ${n.nameEn ?? ''} ${n.type}`, run: () => studioSelect([n.id]) })),
    ];
    return c;
  }, [looks, nodes]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      const r = recent();
      const byId = new Map(commands.map((c) => [c.id, c]));
      const rec = r.map((id) => byId.get(id)).filter(Boolean) as Cmd[];
      return [...rec.map((c) => ({ ...c, group: 'Recent' })), ...commands.filter((c) => c.group !== 'Select' && c.group !== 'Apply look' && !r.includes(c.id))].slice(0, 60);
    }
    const tokens = q.split(/\s+/);
    return commands
      .map((c) => {
        const hay = `${c.title} ${c.group} ${c.keywords ?? ''}`.toLowerCase();
        if (!tokens.every((t) => hay.includes(t))) return null;
        const title = c.title.toLowerCase();
        const score = (title.startsWith(q) ? 0 : title.includes(q) ? 1 : 2) + (c.group === 'Select' ? 0.5 : 0);
        return { c, score };
      })
      .filter(Boolean)
      .sort((a, b) => a!.score - b!.score)
      .slice(0, 60)
      .map((x) => x!.c);
  }, [query, commands]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const run = (c: Cmd) => {
    close();
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify([c.id, ...recent().filter((x) => x !== c.id)].slice(0, 6)));
    } catch {
      /* ignore */
    }
    c.run();
  };

  let lastGroup = '';
  return (
    <div className="overlay palette-overlay" onClick={close}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" size={15} />
          <input
            autoFocus
            placeholder="Type an action, a look, or an object name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter' && results[index]) run(results[index]);
              else if (e.key === 'Escape') close();
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list" ref={listRef}>
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id + i}>
                {header && <div className="palette-group">{header}</div>}
                <div data-i={i} className={`palette-item ${i === index ? 'active' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => run(c)}>
                  <span>{c.title}</span>
                  {c.kbd && <span className="kbd">{c.kbd}</span>}
                </div>
              </div>
            );
          })}
          {!results.length && <div className="empty">Nothing matches “{query}”.</div>}
        </div>
      </div>
    </div>
  );
}

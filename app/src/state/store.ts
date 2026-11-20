import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { bridge, type ConnectionStatus } from '../bridge/client';
import type { Hello, KeyRef, SceneData, SceneNode, TimelineData, TimelineState, TrackModel, WireGroup, WireTrack } from '../bridge/types';
import { log } from '../lib/log';
import { perfRecord } from '../lib/perf';
import { snapToFrame } from '../lib/time';

export type KeyId = string;
export const keyId = (track: number, t: number): KeyId => `${track}|${t}`;
export const parseKeyId = (id: KeyId): KeyRef => {
  const i = id.indexOf('|');
  return { track: Number(id.slice(0, i)), t: Number(id.slice(i + 1)) };
};

export interface Shot {
  id: string;
  name: string;
  start: number;
  end: number;
  notes: string;
  cam?: unknown;
  thumb?: string;
}

/** One audio clip on the timeline (the scene can have several). */
export interface AudioClipInfo {
  id: number;
  file: string;
  offset: number;
  volume: number;
  muted: boolean;
  /** Length of the file (seconds). */
  duration: number;
  /** -1 left … 1 right */
  pan: number;
  /** Playback speed; the pitch follows. */
  speed: number;
  fadeIn: number;
  fadeOut: number;
  /** Seconds of the file skipped at its start / end. */
  trimIn: number;
  trimOut: number;
  /** Seconds it plays on the timeline. */
  span: number;
}
export type AudioPatch = Partial<Pick<AudioClipInfo, 'offset' | 'volume' | 'muted' | 'pan' | 'speed' | 'fadeIn' | 'fadeOut' | 'trimIn' | 'trimOut'>>;
export interface AudioPeaks {
  perSecond: number;
  peaks: number[];
}

export interface Toast {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

export interface AppState {
  status: ConnectionStatus;
  hello: Hello | null;

  nodes: Record<number, SceneNode>;
  roots: number[];
  studioSelection: number[];

  tl: TimelineState | null;
  tickAt: number;
  tracks: WireTrack[];
  groups: WireGroup[];

  selKeys: Set<KeyId>;
  selTracks: Set<number>;
  filter: 'selected' | 'all';
  search: string;
  collapsed: Set<number>;
  snap: boolean;
  showEnglish: boolean;
  clipboard: { refs: KeyRef[]; base: number } | null;

  toasts: Toast[];

  centerView: 'dope' | 'graph';
  leftTab: 'scene' | 'tracks' | 'poses' | 'camera';
  rightTab: 'inspector' | 'object' | 'character' | 'look' | 'translate';
  sceneBrowser: boolean;
  translateQuery: string;
  /** Bumped on every timeline/scene refresh so panels can re-fetch derived data. */
  revision: number;

  autoKey: boolean;
  autoKeyNew: boolean;
  /** Changes in Studio since the last seek/key that aren't keyed yet. */
  pending: number;
  /** The scene's audio track (dialogue/music synced to Timeline) and its waveform, if any. */
  /** The scene's audio clips, in the order they were added. */
  audio: AudioClipInfo[];
  /** Shot sequencer: the scene's shots (time ranges with their own camera). */
  shots: Shot[];
  workingShotId: string | null;
  frameFullTimeline: boolean;
  loopShot: boolean;
  renderShotIds: string[] | null;
  sceneName: string | null;
  sceneFilter: 'all' | 'fav' | 'recent';
  /** Waveform per clip id. */
  audioPeaks: Record<number, AudioPeaks>;
  /** While Studio plays one clip by itself (Listen): which, and seconds into it; null otherwise. */
  audioListen: { id: number; at: number } | null;
  /** This PC's audio output delay (ms) and Unity's own mixer delay (ms). */
  audioDelay: { output: number; mixer: number };
  /** Key edits were made but Studio held them back to protect the unkeyed changes (the pose doesn't show them yet). */
  poseStale: boolean;
  groupMode: 'objects' | 'folders';
  settingsOpen: boolean;

  workspace: Workspace;
  /** the workspace before Settings was opened (the gear button goes back to it) */
  lastWorkspace: Workspace;
  libraryPage: LibraryPage;
  settingsPage: LibraryPage;
  paletteOpen: boolean;
  helpOpen: boolean;
  /** Experimental live preview window (roadmap Phase 3 spike). */
  previewOpen: boolean;
  /** Material tweaks queued to be saved with the next look preset. */
  lookRules: { shader: string; prop: string; type: 'float' | 'color'; value: number | number[]; parts?: string[] }[];
  /** Running batch translation (Settings › Translations), shown as progress in the status bar. */
  translateJob: { done: number; total: number; engine: string } | null;
}

export type Workspace = 'animate' | 'pose' | 'look' | 'shoot' | 'library' | 'settings';
/** Library pages (content) and Settings pages (the app): both open through openLibrary(). */
export type LibraryPage = 'scenes' | 'characters' | 'macros' | 'translate' | 'settings' | 'studio' | 'shortcuts' | 'about';
const SETTINGS_PAGES: LibraryPage[] = ['settings', 'studio', 'translate', 'shortcuts', 'about'];
export const isSettingsPage = (p: LibraryPage) => SETTINGS_PAGES.includes(p);
const WORKSPACES: Workspace[] = ['animate', 'pose', 'look', 'shoot', 'library', 'settings'];

export function setWorkspace(w: Workspace) {
  const cur = get().workspace;
  set({ workspace: w, ...(w === 'animate' ? {} : { loopShot: false }), ...(w === 'settings' && cur !== 'settings' ? { lastWorkspace: cur } : {}) });
  if (w !== 'settings') lsSet('studioex.workspace', w);
}

/** Open a Library page (scenes, characters, quick actions) or a Settings page (mod settings, translations…). */
export function openLibrary(page: LibraryPage) {
  if (isSettingsPage(page)) {
    setWorkspace('settings');
    set({ settingsPage: page });
  } else {
    setWorkspace('library');
    set({ libraryPage: page });
  }
}

export const useStore = create<AppState>(() => ({
  status: 'closed',
  hello: null,
  nodes: {},
  roots: [],
  studioSelection: [],
  tl: null,
  tickAt: 0,
  tracks: [],
  groups: [],
  selKeys: new Set(),
  selTracks: new Set(),
  filter: (lsGet('studioex.filter') as 'selected' | 'all') || 'selected',
  search: '',
  collapsed: new Set(),
  snap: true,
  showEnglish: lsGet('studioex.english') !== '0',
  clipboard: null,
  toasts: [],
  centerView: (lsGet('studioex.view') as 'dope' | 'graph') || 'dope',
  leftTab: 'scene',
  rightTab: 'inspector',
  sceneBrowser: false,
  translateQuery: '',
  translateJob: null,
  revision: 0,
  autoKey: false,
  autoKeyNew: lsGet('studioex.autoKeyNew') !== '0',
  pending: 0,
  poseStale: false,
  audio: [],
  audioPeaks: {},
  audioListen: null,
  audioDelay: { output: 0, mixer: 0 },
  shots: [], workingShotId: null, frameFullTimeline: false, loopShot: false, renderShotIds: null, sceneName: null, sceneFilter: 'all',
  groupMode: (lsGet('studioex.groupMode') as 'objects' | 'folders') || 'objects',
  settingsOpen: false,
  workspace: WORKSPACES.includes(lsGet('studioex.workspace') as Workspace) && lsGet('studioex.workspace') !== 'settings' ? (lsGet('studioex.workspace') as Workspace) : 'animate',
  lastWorkspace: 'animate',
  libraryPage: 'scenes',
  settingsPage: 'settings',
  paletteOpen: false,
  helpOpen: false,
  previewOpen: false,
  lookRules: [],
}));

// ---------------------------------------------------------------------------
// Key what changed / auto-key
// ---------------------------------------------------------------------------
export function workingShot(s: AppState) {
  return s.shots.find((shot) => shot.id === s.workingShotId);
}

export function renderShots(ids: string[]) {
  set({ renderShotIds: ids, loopShot: false });
  showTab('shoot', 'render');
}

export async function saveSceneFile() {
  const result = await call<boolean | string>('scene.save', { returnName: true });
  if (typeof result === 'string') toast(`Saved ${result}`);
  else if (result === true) toast('Save requested in CharaStudio');
  return result;
}

/** Re-read the scene's shots. */
export async function refreshShots() {
  const s = await bridge.request<Shot[]>('shots.get').catch(() => null);
  set({ shots: s ?? [] });
}

type AudioGet = { clips: AudioClipInfo[]; previewing: boolean; previewId: number; previewAt: number; outputDelay?: number; mixerDelay?: number };
let listenTimer = 0;
const stopListenTimer = () => {
  window.clearInterval(listenTimer);
  listenTimer = 0;
};
/** Listen: Studio plays one clip by itself (the animation doesn't move), from `from` seconds into it; null stops. */
export async function listenAudio(id: number | null, from = 0) {
  stopListenTimer();
  const r = await call<AudioGet>('audio.preview', id == null ? { on: false } : { on: true, id, from: Math.max(0, from) });
  const now = r?.previewing ? { id: r.previewId, at: r.previewAt } : null;
  set({ audioListen: now });
  if (!now) return;
  listenTimer = window.setInterval(async () => {
    const g = await bridge.request<AudioGet>('audio.get').catch(() => null);
    set({ audioListen: g?.previewing ? { id: g.previewId, at: g.previewAt } : null });
    if (!g?.previewing) stopListenTimer();
  }, 100);
}

/** Add a WAV to the timeline (a file in UserData/audio, or any path — Studio copies it there). */
export async function addAudio(fileOrPath: string, offset = 0) {
  const r = await call('audio.add', { file: fileOrPath, offset });
  if (!r) return false;
  await refreshAudio();
  toast('Audio added — it plays with the timeline and is saved with the scene');
  return true;
}
/** Swap one clip's file, keeping where it starts. */
export async function replaceAudio(id: number, fileOrPath: string) {
  const r = await call('audio.load', { id, file: fileOrPath });
  if (r) await refreshAudio();
  return !!r;
}
/** Pick a WAV with the file dialog: add it (at `offset`), or swap clip `replace`'s file. */
export async function pickAudio(offset = 0, replace?: number) {
  const p = await window.studioEx?.openAudio?.();
  if (!p) return false;
  return replace != null ? replaceAudio(replace, p) : addAudio(p, offset);
}
export async function setAudio(id: number, patch: AudioPatch) {
  // optimistic: no jump back while the bridge answers
  set({ audio: get().audio.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  await call('audio.set', { id, ...patch });
  await refreshAudio();
}
/** Play the audio this much early while the timeline plays (headphones heard late); this PC only, not in renders. */
export async function setAudioDelay(ms: number) {
  set({ audioDelay: { ...get().audioDelay, output: ms } });
  await call('audio.setDelay', { ms: Math.round(ms) });
}
export async function removeAudio(id: number) {
  if (get().audioListen?.id === id) stopListenTimer();
  await call('audio.remove', { id });
  await refreshAudio();
}

/** Which file each clip's waveform was read from, so a swapped file is read again. */
const peaksFile = new Map<number, string>();
/** Re-read the scene's audio clips (and the waveform of any clip that's new or changed file). */
export async function refreshAudio() {
  const a = await bridge.request<AudioGet>('audio.get').catch(() => null);
  const clips = a?.clips ?? [];
  const listen = a?.previewing ? { id: a.previewId, at: a.previewAt } : null;
  if (!listen) stopListenTimer();
  set({ audio: clips, audioListen: listen, audioDelay: { output: a?.outputDelay ?? 0, mixer: a?.mixerDelay ?? 0 } });
  const peaks = { ...get().audioPeaks };
  for (const id of Object.keys(peaks).map(Number)) if (!clips.some((c) => c.id === id)) delete peaks[id];
  for (const c of clips) {
    if (peaks[c.id] && peaksFile.get(c.id) === c.file) continue;
    const p = await bridge.request<AudioPeaks>('audio.peaks', { id: c.id, perSecond: 100 }).catch(() => null);
    if (p) {
      peaks[c.id] = { perSecond: p.perSecond, peaks: p.peaks };
      peaksFile.set(c.id, c.file);
    }
  }
  set({ audioPeaks: peaks });
}

/** Throw away the unkeyed changes in Studio: the pose goes back to the keys (and shows held-back key edits). */
export async function resetPose() {
  const r = await call<boolean>('timeline.resetPose');
  if (r === undefined) return;
  set({ pending: 0, poseStale: false });
  toast('Pose reset to the keys');
}

export async function keyChanged() {
  const n = await call<number>('timeline.keyChanged', { includeNew: get().autoKeyNew });
  if (n === undefined) return;
  if (n === 0) toast('Nothing changed since the last key — move something in Studio first');
  else toast(`Keyed ${n} change${n > 1 ? 's' : ''}`);
  set({ pending: 0 });
  await refreshTimeline();
}

export async function setAutoKey(on: boolean, newTracks = get().autoKeyNew) {
  const r = await call<{ on: boolean; newTracks: boolean }>('timeline.setAutoKey', { on, newTracks });
  if (r) {
    set({ autoKey: r.on, autoKeyNew: r.newTracks });
    lsSet('studioex.autoKeyNew', r.newTracks ? '1' : '0');
    toast(r.on ? 'Auto-key ON — anything you move in Studio is keyed at the playhead' : 'Auto-key off');
  }
}

// ---------------------------------------------------------------------------
// Timeline folders
// ---------------------------------------------------------------------------
export async function createFolder(name: string, trackIds: number[]) {
  if (!trackIds.length) return toast('Select tracks first (click track names, Ctrl/Shift for several)');
  await call('timeline.groupCreate', { name, tracks: trackIds });
  await refreshTimeline();
}
export async function moveToFolder(trackIds: number[], group: number) {
  await call('timeline.groupMove', { tracks: trackIds, group });
  await refreshTimeline();
}
export async function renameFolder(group: number, name: string) {
  await call('timeline.groupRename', { group, name });
  await refreshTimeline();
}
export async function ungroupFolder(group: number) {
  await call('timeline.groupDelete', { group });
  await refreshTimeline();
}
export function setFolderExpanded(group: number, expanded: boolean) {
  set((s) => ({ groups: s.groups.map((g) => (g.id === group ? { ...g, expanded } : g)) }));
  call('timeline.groupExpand', { group, expanded });
}

/** Characters among the objects selected in Studio. */
/**
 * Timeline settings without the fast-changing playhead time. Subscribing to `s.tl` directly re-renders on
 * every tick (30 Hz while playing) — use this in components that only show settings / play state.
 */
export function useTlInfo() {
  return useStore(
    useShallow((s) => ({
      has: !!s.tl,
      duration: s.tl?.duration ?? 0,
      fps: s.tl?.fps ?? 60,
      speed: s.tl?.speed ?? 1,
      playing: !!s.tl?.playing,
      uiVisible: !!s.tl?.uiVisible,
    })),
  );
}

export function selectedCharacters(): number[] {
  const { studioSelection, nodes } = get();
  return studioSelection.filter((id) => nodes[id]?.type === 'Char');
}

/** Open the Translate tab focused on a specific string. */
export function editTranslation(text: string) {
  set({ translateQuery: text });
  openLibrary('translate');
}

/** Switch workspace and bring one of its center sub-tabs forward (e.g. Animate › Face). */
export function showTab(workspace: Workspace, tab: string) {
  let stored = false;
  try {
    localStorage.setItem(`kf.center.${workspace}`, tab);
    stored = true;
  } catch {
    /* ignore */
  }
  const alreadyMounted = get().workspace === workspace;
  setWorkspace(workspace);
  const selectTab = () => window.dispatchEvent(new CustomEvent('kf:center-tab', { detail: { ws: workspace, tab } }));
  if (alreadyMounted) selectTab();
  else if (!stored) requestAnimationFrame(selectTab);
}

/** Switch workspace and open (and scroll to) one of its side-panel groups. */
export function showPanel(workspace: Workspace, group: string) {
  try {
    localStorage.setItem(`kf.group.${workspace}.${group}`, '1');
  } catch {
    /* ignore */
  }
  setWorkspace(workspace);
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('kf:reveal-group', { detail: { ws: workspace, id: group } })));
}

const set = useStore.setState;
const get = useStore.getState;

function lsGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
export function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
let toastId = 1;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = toastId++;
  if (kind === 'error') log('error', text, 'ui');
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 5000 : 2500);
}

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  try {
    return await bridge.request<T>(cmd, args);
  } catch (e) {
    toast((e as Error).message, 'error');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Live time (extrapolated between ticks so the playhead moves smoothly)
// ---------------------------------------------------------------------------
export function liveTime(): number {
  const { tl, tickAt } = get();
  if (!tl) return 0;
  if (!tl.playing || tl.duration <= 0) return tl.time;
  // Ticks come at ~30 Hz; never extrapolate more than a short gap (stalled/lagging connection).
  const dt = Math.min(0.5, (performance.now() - tickAt) / 1000);
  const t = tl.time + dt * tl.speed;
  return ((t % tl.duration) + tl.duration) % tl.duration;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
let tlInFlight = false;
let tlQueued = false;
let pendingReselect: KeyRef[] | null = null;
let lastTimelineError = '';

let tlRetries = 0;

/** Auto-key, unkeyed-change count and held-back edits as the plugin has them (they outlive app restarts). */
function syncTimelineFlags(attempt = 0) {
  Promise.all([bridge.request<{ on: boolean }>('timeline.setAutoKey', {}), bridge.request<{ pending?: number; poseStale?: boolean }>('timeline.state')])
    .then(([ak, st]) => set({ autoKey: ak.on, pending: st.pending ?? 0, poseStale: !!st.poseStale }))
    .catch(() => {
      if (attempt < 60 && get().status === 'open') window.setTimeout(() => syncTimelineFlags(attempt + 1), 1500);
    });
}
export async function refreshTimeline() {
  if (tlInFlight) {
    tlQueued = true;
    return;
  }
  tlInFlight = true;
  try {
    const t0 = performance.now();
    const data = await bridge.request<TimelineData>('timeline.get');
    const t1 = performance.now();
    const { groups, tracks, ...state } = data;
    set((s) => ({ tl: state, tickAt: performance.now(), tracks, groups, revision: s.revision + 1 }));
    reconcileSelection();
    perfRecord('timelineFetch', t1 - t0); // request + JSON parse
    perfRecord('timelineApply', performance.now() - t1); // store update + React render
    lastTimelineError = '';
    tlRetries = 0;
  } catch (e) {
    // Disconnects are covered by the status UI; anything else must be visible, not an empty sheet.
    const msg = (e as Error).message;
    // Studio is still starting (Timeline loads a few seconds after the bridge): try again quietly.
    if (/not loaded yet/i.test(msg) && get().status === 'open' && tlRetries++ < 60) {
      window.setTimeout(() => {
        if (get().status === 'open') refreshTimeline();
      }, 1500);
      return;
    }
    if (get().status === 'open' && msg !== lastTimelineError && !/not connected|disconnected/i.test(msg)) {
      lastTimelineError = msg;
      toast(`Couldn't read the timeline from Studio: ${msg}`, 'error');
    }
  } finally {
    tlInFlight = false;
    if (tlQueued) {
      tlQueued = false;
      refreshTimeline();
    }
  }
}

function reconcileSelection() {
  const { tracks, selKeys, selTracks } = get();
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const next = new Set<KeyId>();
  const findNear = (r: KeyRef) => {
    const tr = byId.get(r.track);
    if (!tr) return;
    let best: number | undefined;
    for (const k of tr.keys) if (Math.abs(k[0] - r.t) < 1e-3 && (best === undefined || Math.abs(k[0] - r.t) < Math.abs(best - r.t))) best = k[0];
    if (best !== undefined) next.add(keyId(r.track, best));
  };
  if (pendingReselect) {
    pendingReselect.forEach(findNear);
    pendingReselect = null;
  } else {
    selKeys.forEach((id) => findNear(parseKeyId(id)));
  }
  const nextTracks = new Set([...selTracks].filter((id) => byId.has(id)));
  set({ selKeys: next, selTracks: nextTracks });
}

export async function refreshScene() {
  try {
    const data = await bridge.request<SceneData>('scene.get');
    const nodes: Record<number, SceneNode> = {};
    for (const n of data.nodes) {
      if (n.type.startsWith('Char')) n.type = 'Char'; // older bridge builds sent CharFemale/CharMale
      nodes[n.id] = n;
    }
    set((s) => ({ nodes, sceneName: data.fileName ?? null, roots: data.roots, studioSelection: data.selected, revision: s.revision + 1 }));
  } catch {
    /* ignore */
  }
}

let refreshTimer: number | undefined;
function scheduleTimelineRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(refreshTimeline, 40);
}
let sceneTimer: number | undefined;
function scheduleSceneRefresh() {
  window.clearTimeout(sceneTimer);
  sceneTimer = window.setTimeout(refreshScene, 80);
}

let bridgeStarted = false;
export function initBridge() {
  if (bridgeStarted) return;
  bridgeStarted = true;
  bridge.on('$status', async (s) => {
    // only the moments it connects and drops (not every reconnect attempt while Studio is closed)
    if (s !== get().status && (s === 'open' || get().status === 'open')) log('info', s === 'open' ? 'bridge connected' : 'bridge connection lost', 'bridge');
    set({ status: s as ConnectionStatus });
    // Offline: stop extrapolating the playhead (and the canvases redrawing every frame for it).
    if (s !== 'open') {
      import('./studioUi').then((m) => m.useStudioUi.setState({ ui: null }));
      set({ workingShotId: null, frameFullTimeline: false, loopShot: false, renderShotIds: null, sceneName: null });
      const tl = get().tl;
      if (tl?.playing) set({ tl: { ...tl, playing: false, time: liveTime() } });
    }
    if (s === 'open') {
      const hello = await call<Hello>('hello');
      set({ hello: hello ?? null });
      if (hello) {
        log('info', `connected to bridge ${hello.plugin} (Unity ${hello.unity})`, 'bridge');
        for (const f of hello.features ?? []) if (f.status === 'off' || f.status === 'untested') log(f.status === 'off' ? 'warn' : 'info', `${f.label}: ${f.reason}`, 'compat');
      }
      // Plugin state survives app restarts; read auto-key back instead of assuming off.
      // ...and unkeyed changes / held-back edits (only their changes are pushed as events). Quiet: while Studio
      // is still starting Timeline isn't loaded yet; the timeline refresh below retries and these follow it.
      if (hello?.timeline) syncTimelineFlags();
      if (hello?.commands.includes('audio.get')) refreshAudio();
      if (hello?.commands.includes('shots.get')) refreshShots();
      if (hello?.commands.includes('ui.get')) import('./studioUi').then((m) => m.syncStudioUi());
      refreshScene();
      if (hello?.timeline) refreshTimeline();
      else if (hello) toast(hello.features?.find((f) => f.id === 'timeline')?.reason ?? 'Timeline plugin not found in this Studio install', 'error');
    }
  });
  bridge.on('timeline.tick', (d) => {
    const tick = d as TimelineState;
    const state = get();
    const shot = workingShot(state);
    if (state.loopShot && shot && tick.playing && !state.pending &&
        (tick.time >= Math.min(shot.end, tick.duration) || tick.time < shot.start)) {
      if (shot.start < tick.duration) bridge.send('timeline.seek', { t: shot.start });
    }
    // While scrubbing, ticks echoing *earlier* seeks arrive after the newer optimistic position:
    // keep our time for a moment so the playhead doesn't jump backwards.
    if (!tick.playing && performance.now() - lastLocalSeek < 250) {
      const cur = get().tl;
      if (cur) {
        set({ tl: { ...cur, ...tick, time: cur.time }, tickAt: performance.now() });
        return;
      }
    }
    set({ tl: { ...(get().tl ?? {}), ...tick }, tickAt: performance.now() });
  });
  bridge.on('timeline.changed', scheduleTimelineRefresh);
  bridge.on('scene.changed', scheduleSceneRefresh);
  // clips added, swapped or removed anywhere (a template, a scene load, another window)
  let audioTimer = 0;
  bridge.on('audio.changed', () => {
    window.clearTimeout(audioTimer);
    audioTimer = window.setTimeout(refreshAudio, 80);
  });
  bridge.on('scene.file', (name) => set({ sceneName: typeof name === 'string' ? name : null }));
  bridge.on('scene.reset', () => {
    set({ workingShotId: null, frameFullTimeline: false, loopShot: false, renderShotIds: null, sceneName: null, shots: [] });
    set({ selKeys: new Set(), selTracks: new Set(), clipboard: null });
    window.setTimeout(() => {
      refreshAudio(); // a loaded scene may bring its own audio and shots
      refreshShots();
    }, 1500);
    window.dispatchEvent(new CustomEvent('studioex:scene-reset'));
    scheduleSceneRefresh();
    scheduleTimelineRefresh();
  });
  bridge.on('selection', (ids) => set({ studioSelection: ids as number[] }));
  bridge.on('timeline.pending', (n) => set({ pending: n as number }));
  bridge.on('timeline.poseStale', (v) => set({ poseStale: !!v }));
  bridge.on('autokey', (n) => {
    set({ pending: 0 });
    toast(`Auto-keyed ${n} change${(n as number) > 1 ? 's' : ''}`);
    scheduleTimelineRefresh();
  });
  bridge.connect();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
export function togglePlay() {
  const tl = get().tl;
  if (!tl) return;
  call(tl.playing ? 'timeline.pause' : 'timeline.play');
}

export function stop() {
  call('timeline.stop');
}

let seekRaf = 0;
let seekTarget = 0;
/** Optimistic, rAF-throttled seek — safe to call on every mouse move while scrubbing. */
let lastLocalSeek = 0;

export function seek(t: number) {
  const tl = get().tl;
  if (!tl) return;
  lastLocalSeek = performance.now();
  seekTarget = Math.max(0, Math.min(tl.duration, t));
  set({ tl: { ...tl, time: seekTarget }, tickAt: performance.now() });
  if (!seekRaf)
    seekRaf = requestAnimationFrame(() => {
      seekRaf = 0;
      bridge.send('timeline.seek', { t: seekTarget });
    });
}

/** Seek and wait until Studio has applied the pose (needed before capturing values). */
export async function seekNow(t: number) {
  const tl = get().tl;
  if (!tl) return;
  const target = Math.max(0, Math.min(tl.duration, t));
  set({ tl: { ...tl, time: target }, tickAt: performance.now() });
  await call('timeline.seek', { t: target });
}

export function stepFrames(n: number) {
  const tl = get().tl;
  if (!tl) return;
  seek(snapToFrame(liveTime(), tl.fps) + n / tl.fps);
}

export function jumpKey(dir: 1 | -1) {
  const now = liveTime();
  const times = new Set<number>();
  for (const tr of visibleTracks()) for (const k of tr.keys) times.add(k[0]);
  const sorted = [...times].sort((a, b) => a - b);
  const target = dir > 0 ? sorted.find((t) => t > now + 1e-4) : [...sorted].reverse().find((t) => t < now - 1e-4);
  if (target !== undefined) seek(target);
}

export function setSettings(s: Partial<Pick<TimelineState, 'duration' | 'fps' | 'speed'>>) {
  call<TimelineState>('timeline.setSettings', s).then((st) => st && set({ tl: { ...get().tl!, ...st } }));
}

// ---------------------------------------------------------------------------
// Filtering — which tracks are on screen
// ---------------------------------------------------------------------------
export function displayName(n: { name: string; nameEn?: string; alias?: string } | undefined): string {
  if (!n) return '';
  if (n.alias) return n.alias;
  return get().showEnglish && n.nameEn ? n.nameEn : n.name;
}

export function visibleTracks(): WireTrack[] {
  const { tracks, filter, studioSelection, search, nodes } = get();
  const q = search.trim().toLowerCase();
  const sel = new Set(studioSelection);
  return tracks.filter((t) => {
    if (filter === 'selected' && studioSelection.length > 0 && t.oci !== -1 && !sel.has(t.oci)) return false;
    if (q) {
      const hay = `${t.name} ${t.nameEn ?? ''} ${t.alias} ${t.owner} ${nodes[t.oci]?.name ?? ''} ${nodes[t.oci]?.nameEn ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
export function selectKeys(ids: Iterable<KeyId>, mode: 'replace' | 'add' | 'toggle' = 'replace') {
  const cur = get().selKeys;
  const next = mode === 'replace' ? new Set<KeyId>() : new Set(cur);
  for (const id of ids) {
    if (mode === 'toggle' && next.has(id)) next.delete(id);
    else next.add(id);
  }
  set({ selKeys: next });
}

export function selectTracks(ids: Iterable<number>, mode: 'replace' | 'add' | 'toggle' = 'replace') {
  const cur = get().selTracks;
  const next = mode === 'replace' ? new Set<number>() : new Set(cur);
  for (const id of ids) {
    if (mode === 'toggle' && next.has(id)) next.delete(id);
    else next.add(id);
  }
  set({ selTracks: next });
}

export function selectAllKeys() {
  const ids: KeyId[] = [];
  for (const tr of visibleTracks()) for (const k of tr.keys) ids.push(keyId(tr.id, k[0]));
  selectKeys(ids);
}

export function selectedKeyRefs(): KeyRef[] {
  return [...get().selKeys].map(parseKeyId);
}

export function studioSelect(ids: number[], additive = false) {
  call<number[]>('scene.select', { ids, additive }).then((sel) => sel && set({ studioSelection: sel }));
}

// ---------------------------------------------------------------------------
// Edits (all undoable on the plugin side)
// ---------------------------------------------------------------------------
async function edit<T>(cmd: string, args: Record<string, unknown>, reselect?: KeyRef[]) {
  const r = await call<T>(cmd, args);
  if (r !== undefined && reselect) pendingReselect = reselect;
  await refreshTimeline();
  return r;
}
/** For panels: run an undoable timeline command, refresh, and re-select the given keys afterwards. */
export const editTimeline = edit;

export function moveSelectedKeys(dt: number) {
  const refs = selectedKeyRefs();
  if (!refs.length || dt === 0) return;
  // Keep the whole selection inside the timeline (not just the key under the mouse).
  let lo = Infinity, hi = -Infinity;
  for (const r of refs) {
    if (r.t < lo) lo = r.t;
    if (r.t > hi) hi = r.t;
  }
  dt = Math.max(dt, -lo);
  const dur = get().tl?.duration;
  if (dur && dur > 0) dt = Math.min(dt, dur - hi);
  if (Math.abs(dt) < 1e-6) return;
  // Optimistic: shift locally so the drag doesn't snap back while waiting.
  const moved = new Set(get().selKeys);
  set((s) => ({
    tracks: s.tracks.map((tr) => ({
      ...tr,
      // kept sorted by time: the dope sheet only scans the visible range with a binary search
      keys: tr.keys.map((k) => (moved.has(keyId(tr.id, k[0])) ? ([k[0] + dt, ...k.slice(1)] as typeof k) : k)).sort((a, b) => a[0] - b[0]),
    })),
    selKeys: new Set(refs.map((r) => keyId(r.track, r.t + dt))),
  }));
  edit('timeline.moveKeys', { keys: refs, dt }, refs.map((r) => ({ track: r.track, t: r.t + dt })));
}

export function deleteSelectedKeys() {
  const refs = selectedKeyRefs();
  if (!refs.length) return;
  edit('timeline.deleteKeys', { keys: refs });
  set({ selKeys: new Set() });
}

/** Tracks the user means: explicitly selected rows + rows owning selected keys. */
export function targetTracks(): number[] {
  const { selTracks, selKeys } = get();
  const ids = new Set(selTracks);
  selKeys.forEach((k) => ids.add(parseKeyId(k).track));
  return [...ids];
}

export async function keyTracks(trackIds: number[], t = liveTime()) {
  if (!trackIds.length) {
    toast('Select one or more tracks (click a track name) to key them');
    return;
  }
  const tl = get().tl;
  const at = tl && get().snap ? snapToFrame(t, tl.fps) : t;
  await edit('timeline.addKeys', { tracks: trackIds, t: at }, trackIds.map((track) => ({ track, t: at })));
}

export function keySelected() {
  return keyTracks(targetTracks());
}

/** Key every visible track of the objects selected in Studio. */
export function keyAllOfSelectedObjects() {
  const sel = new Set(get().studioSelection);
  const ids = get().tracks.filter((t) => sel.has(t.oci)).map((t) => t.id);
  if (!ids.length) {
    toast('The selected object has no tracks yet — add one with + Track above the dope sheet');
    return;
  }
  return keyTracks(ids);
}

export function applyCurveToSelected(flat: number[]) {
  const refs = selectedKeyRefs();
  if (!refs.length) return;
  return edit('timeline.setCurve', { keys: refs, curve: flat }, refs);
}

export function copySelected() {
  const refs = selectedKeyRefs();
  if (!refs.length) return;
  set({ clipboard: { refs, base: Math.min(...refs.map((r) => r.t)) } });
  toast(`Copied ${refs.length} key${refs.length > 1 ? 's' : ''}`);
}

export async function pasteAtPlayhead() {
  const clip = get().clipboard;
  const tl = get().tl;
  if (!clip || !tl) return;
  const at = get().snap ? snapToFrame(liveTime(), tl.fps) : liveTime();
  const dt = at - clip.base;
  await edit('timeline.copyKeys', { keys: clip.refs, dt }, clip.refs.map((r) => ({ track: r.track, t: r.t + dt })));
}

export async function duplicateSelectedToPlayhead() {
  copySelected();
  await pasteAtPlayhead();
}

// Undo covers timeline, character, ABMX and object edits (one shared history in the plugin).
export async function undo() {
  const r = await call<string | false>('undo');
  if (r === false) toast('Nothing to undo');
  else if (r) toast(`Undid: ${r}`);
  window.dispatchEvent(new Event('kf:history'));
  await Promise.all([refreshTimeline(), refreshScene()]);
}
export async function redo() {
  const r = await call<string | false>('redo');
  if (r === false) toast('Nothing to redo');
  else if (r) toast(`Redid: ${r}`);
  window.dispatchEvent(new Event('kf:history'));
  await Promise.all([refreshTimeline(), refreshScene()]);
}

export function setTrackProps(track: number, props: { enabled?: boolean; alias?: string; color?: number[] }) {
  return edit('timeline.setTrack', { track, ...props });
}

export function removeTracks(ids: number[]) {
  if (!ids.length) return;
  set({ selTracks: new Set() });
  return edit('timeline.removeTracks', { tracks: ids });
}

export async function listModels(oci: number | null): Promise<TrackModel[]> {
  return (await call<TrackModel[]>('timeline.models', oci == null ? {} : { oci })) ?? [];
}

export async function addTrack(model: TrackModel, oci: number | null, keyNow = true) {
  const tl = get().tl;
  const args: Record<string, unknown> = { owner: model.owner, model: model.id };
  if (oci != null) args.oci = oci;
  if (keyNow && tl) args.keyAt = get().snap ? snapToFrame(liveTime(), tl.fps) : liveTime();
  const id = await edit<number>('timeline.addTrack', args);
  if (id !== undefined) {
    selectTracks([id]);
    toast(`Added track “${displayName(model)}”`);
  }
  return id;
}

export function getKeyInfo(ref: KeyRef) {
  return bridge.request<import('../bridge/types').KeyInfo>('timeline.keyInfo', { track: ref.track, t: ref.t });
}

export function setTimelineUiVisible(visible: boolean) {
  call<TimelineState>('timeline.setUiVisible', { visible }).then((st) => st && set({ tl: { ...get().tl!, ...st } }));
}

export function setNodeVisible(id: number, visible: boolean) {
  call('scene.setVisible', { id, visible }).then(scheduleSceneRefresh);
}

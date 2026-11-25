import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onThemeChange, tokenColor, tokenRgba } from '../lib/theme';
import type { WireTrack } from '../bridge/types';
import { curveKind, PRESETS, toFlat } from '../lib/curve';
import { niceStep, snapToFrame } from '../lib/time';
import { moveShot, snapTime, trimShot } from '../lib/shots';
import {
  applyCurveToSelected,
  copySelected,
  deleteSelectedKeys,
  displayName,
  keyId,
  keyTracks,
  liveTime,
  lsSet,
  moveSelectedKeys,
  parseKeyId,
  pasteAtPlayhead,
  removeTracks,
  seek,
  seekNow,
  selectKeys,
  selectTracks,
  setTrackProps,
  setTracksEnabled,
  studioSelect,
  keyAllOfSelectedObjects,
  showTab,
  workingShot,
  saveShots,
  type Shot,
  useStore,
  visibleTracks,
  listenAudio,
  addAudio,
  pickAudio,
  removeAudio,
  setAudio,
  audioName,
  type KeyId,
  setTrackKinds,
  trackKind,
  TRACK_KINDS,
  type TrackKind,
} from '../state/store';
import { Icon, TypeIcon } from './Icon';
import { keyWholePose } from '../lib/keyPose';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { PromptDialog, type PromptState } from './PromptDialog';
import { GraphEditor } from './GraphEditor';
import { TimeScrollbar, VScrollbar } from './Scrollbars';
import { Popover } from './Shell';
import { AddTrackPanel } from './AddTrackPanel';

const HSCROLL_H = 14;
import { createFolder, editTranslation, moveToFolder, renameFolder, setFolderExpanded, toast, ungroupFolder } from '../state/store';
import type { WireGroup } from '../bridge/types';

import { pressable } from '../lib/pressable';
import { clipSpan, fadeAt, fileTimeAt, laneRgb, loudest, timelineTimeAt } from '../lib/audioLanes';
import { perfRecord } from '../lib/perf';
// Row height is user-adjustable (S/M/L); module-level so the rAF draw loop always reads the latest.
const ROW_SIZES = { S: 18, M: 24, L: 32 } as const;
type RowSize = keyof typeof ROW_SIZES;
let rowSize: RowSize = ((): RowSize => {
  try {
    const v = localStorage.getItem('studioex.rowSize');
    return v === 'S' || v === 'L' ? v : 'M';
  } catch {
    return 'M';
  }
})();
let ROW_H: number = ROW_SIZES[rowSize];
let followPlayhead = true;
const RULER_H = 28;
/** The shots' band along the top of the ruler: drag a shot to move it, its edge to trim it. */
const SHOT_BAND = 6;
/** The system's "reduce animations" setting: no key pops then. */
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
/** How long a new key's ring takes to fade (ms). */
const POP_MS = 380;

/** One audio lane per clip, under the ruler. */
const AUDIO_H = 36;
/** Top of the track rows: the ruler, plus the audio lanes. */
const headH = () => RULER_H + useStore.getState().audio.length * AUDIO_H;
/** The clip whose lane is at y (canvas or names column), if any. */
const laneAt = (y: number) => {
  const clips = useStore.getState().audio;
  const i = Math.floor((y - RULER_H) / AUDIO_H);
  return y >= RULER_H && i >= 0 && i < clips.length ? { clip: clips[i], index: i } : null;
};
const PAD = 14;
const KEY_HIT = 7;

/** Index of the first key at or after time t (keys sorted by time); keys.length if none. */
function firstKeyAtOrAfter(keys: WireTrack['keys'], t: number) {
  let lo = 0,
    hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function firstAtOrAfter(ts: number[], t: number) {
  let lo = 0,
    hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/** Merged key times of a summary (object/folder) row, for a given selection and drag offset. */
const summaryCache = new WeakMap<object, { sel: Set<string>; drag: number; ts: number[]; sels: boolean[] }>();

type Row =
  | { kind: 'obj'; key: string; oci: number; label: string; type: string; sex?: number; tracks: WireTrack[] }
  | { kind: 'grp'; key: string; gid: number; label: string; depth: number; expanded: boolean; tracks: WireTrack[] }
  | { kind: 'track'; key: string; track: WireTrack; depth?: number; showObject?: boolean };

interface View {
  t0: number;
  pps: number; // pixels per second
}

type Interaction =
  | { mode: 'none' }
  | { mode: 'scrub' }
  | { mode: 'pan'; startX: number; startT0: number }
  | { mode: 'box'; ta: number; ca: number; x1: number; y1: number; additive: boolean; toggle: boolean }
  | { mode: 'drag'; startX: number; grabT: number; dt: number; active: boolean; clickedId: KeyId; collapseOnClick: boolean }
  | { mode: 'audio'; id: number; startX: number; startOffset: number; offset: number; active: boolean }
  | { mode: 'shot'; id: string; kind: 'move' | 'start' | 'end'; startX: number; orig: Shot[]; moved: boolean; label: string };

/**
 * Timeline's own folder tree. Folders that contain no visible track (after the Selected/search filter)
 * are hidden; collapsed folders still show a summary of everything inside them.
 */
function buildFolderRows(vis: WireTrack[], groups: WireGroup[]): Row[] {
  const visible = new Set(vis.map((t) => t.id));
  const kidsGroups = new Map<number, WireGroup[]>();
  const kidsTracks = new Map<number, WireTrack[]>();
  for (const g of groups) {
    const l = kidsGroups.get(g.parent) ?? [];
    l.push(g);
    kidsGroups.set(g.parent, l);
  }
  for (const t of useStore.getState().tracks) {
    if (!visible.has(t.id)) continue;
    const l = kidsTracks.get(t.group) ?? [];
    l.push(t);
    kidsTracks.set(t.group, l);
  }
  const deep = (gid: number): WireTrack[] => [...(kidsTracks.get(gid) ?? []), ...(kidsGroups.get(gid) ?? []).flatMap((g) => deep(g.id))];
  const out: Row[] = [];
  const walk = (parent: number, depth: number) => {
    type Item = { order: number; g?: WireGroup; t?: WireTrack };
    const items: Item[] = [
      ...(kidsGroups.get(parent) ?? []).map((g) => ({ order: g.order ?? 0, g })),
      ...(kidsTracks.get(parent) ?? []).map((t) => ({ order: t.order ?? 0, t })),
    ].sort((a, b) => a.order - b.order);
    for (const it of items) {
      if (it.g) {
        const inside = deep(it.g.id);
        if (!inside.length) continue;
        out.push({ kind: 'grp', key: `g${it.g.id}`, gid: it.g.id, label: it.g.name, depth, expanded: it.g.expanded, tracks: inside });
        if (it.g.expanded) walk(it.g.id, depth + 1);
      } else if (it.t) out.push({ kind: 'track', key: `t${it.t.id}`, track: it.t, depth, showObject: true });
    }
  };
  walk(-1, 0);
  return out;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function DopeSheet({ compact = false }: { compact?: boolean } = {}) {
  const shot = useStore(workingShot);
  const full = useStore((s) => s.frameFullTimeline);
  const tracks = useStore((s) => s.tracks);
  const nodes = useStore((s) => s.nodes);
  const filter = useStore((s) => s.filter);
  const studioSelection = useStore((s) => s.studioSelection);
  const search = useStore((s) => s.search);
  const collapsed = useStore((s) => s.collapsed);
  const selTracks = useStore((s) => s.selTracks);
  const hasTl = useStore((s) => !!s.tl);
  const showEnglish = useStore((s) => s.showEnglish);
  const centerView = useStore((s) => s.centerView);
  const groupMode = useStore((s) => s.groupMode);
  const groups = useStore((s) => s.groups);
  const trackKinds = useStore((s) => s.trackKinds);
  const [renamingGroup, setRenamingGroup] = useState<number | null>(null);
  // a folder just made from the toolbar opens straight into naming it
  useEffect(() => {
    const on = (e: Event) => setRenamingGroup((e as CustomEvent<number>).detail);
    window.addEventListener('kf:rename-folder', on);
    return () => window.removeEventListener('kf:rename-folder', on);
  }, []);
  // Ctrl+F: the track search
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f' || e.shiftKey || e.altKey) return;
      const el = document.getElementById('track-search') as HTMLInputElement | null;
      if (!el) return;
      e.preventDefault();
      el.focus();
      el.select();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  // dragging tracks into / out of folders
  const [dropOn, setDropOn] = useState<number | null>(null); // folder id, or -1 for "out of folders"
  const dragIds = (e: React.DragEvent): number[] | null => {
    if (!e.dataTransfer.types.includes('application/x-kf-tracks')) return null;
    try {
      return JSON.parse(e.dataTransfer.getData('application/x-kf-tracks') || '[]');
    } catch {
      return [];
    }
  };
  const dropZone = (gid: number) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-kf-tracks')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropOn !== gid) setDropOn(gid);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOn((d) => (d === gid ? null : d));
    },
    onDrop: (e: React.DragEvent) => {
      const ids = dragIds(e);
      setDropOn(null);
      if (!ids?.length) return;
      e.preventDefault();
      e.stopPropagation();
      moveToFolder(ids, gid).then(() => {
        const g = useStore.getState().groups.find((x) => x.id === gid);
        toast(gid === -1 ? `Moved ${ids.length} track${ids.length > 1 ? 's' : ''} out of folders` : `Moved ${ids.length} track${ids.length > 1 ? 's' : ''} into “${g?.name ?? 'folder'}”`);
      });
    },
  });

  const [nameW, setNameW] = useState(() => Number(localStorage.getItem('studioex.nameW')) || 250);
  const [scrollY, setScrollY] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [viewH, setViewH] = useState(0); // mirrors size.current.h so the names column re-renders on resize

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const view = useRef<View>({ t0: 0, pps: 80 });
  const inter = useRef<Interaction>({ mode: 'none' });
  const dirty = useRef(true);
  // the key under the pointer (row and time), drawn a little bigger
  const hover = useRef<{ row: number; t: number } | null>(null);
  // keys that just appeared (key id → when), drawn with a short ring
  const pops = useRef(new Map<string, number>());
  const seenKeys = useRef<Set<string> | null>(null);
  useEffect(() => {
    const now = new Set<string>();
    for (const tr of tracks) for (const k of tr.keys) now.add(keyId(tr.id, k[0]));
    const before = seenKeys.current;
    seenKeys.current = now;
    if (!before || reducedMotion()) return;
    const born: string[] = [];
    for (const id of now) if (!before.has(id)) born.push(id);
    // a few keys keyed by hand pop; bulk writes (lip-sync, pasting a clip) don't flash the whole sheet
    if (born.length === 0 || born.length > 40) return;
    const t = performance.now();
    for (const id of born) pops.current.set(id, t);
    dirty.current = true;
  }, [tracks]);
  // redraw when the audio track or its waveform changes
  const audioPeaks = useStore((s) => s.audioPeaks);
  const audioInfo = useStore((s) => s.audio);
  const shotsList = useStore((s) => s.shots);
  const selShot = useStore((s) => s.selShotId);
  const audioListen = useStore((s) => s.audioListen);
  useEffect(() => {
    dirty.current = true;
  }, [audioPeaks, audioInfo, shotsList, selShot, audioListen]);
  const HEAD = RULER_H + audioInfo.length * AUDIO_H;
  const fitted = useRef(false);
  const lastAnchor = useRef<number | null>(null);

  // ---------------- rows ----------------
  const rows = useMemo<Row[]>(() => {
    const vis = visibleTracks();
    if (groupMode === 'folders') return buildFolderRows(vis, groups);
    const byObj = new Map<number, WireTrack[]>();
    for (const t of vis) {
      let list = byObj.get(t.oci);
      if (!list) byObj.set(t.oci, (list = []));
      list.push(t);
    }
    const out: Row[] = [];
    for (const [oci, list] of byObj) {
      const node = nodes[oci];
      out.push({
        kind: 'obj',
        key: `o${oci}`,
        oci,
        label: oci === -1 ? 'Scene (global)' : node ? displayName(node) : `Object #${oci}`,
        type: oci === -1 ? 'Folder' : node?.type ?? 'node',
        sex: node?.sex,
        tracks: list,
      });
      if (!collapsed.has(oci)) for (const t of list) out.push({ kind: 'track', key: `t${t.id}`, track: t });
    }
    return out;
  }, [tracks, nodes, filter, studioSelection, search, collapsed, showEnglish, groupMode, groups, trackKinds]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const contentH = rows.length * ROW_H;
  const maxScroll = Math.max(0, contentH - (viewH - HEAD) + ROW_H);

  useEffect(() => {
    dirty.current = true;
  });

  const clampScroll = useCallback(
    (y: number) => Math.max(0, Math.min(Math.max(0, rowsRef.current.length * ROW_H - (size.current.h - headH() - HSCROLL_H) + ROW_H), y)),
    [],
  );

  // ---------- zoom ----------
  /** Zoom around the playhead when it's on screen, otherwise around the view centre. */
  const zoomBy = useCallback((factor: number) => {
    autoView.current = false;
    const v = view.current;
    const w = size.current.w;
    const px = PAD + (liveTime() - v.t0) * v.pps;
    const ax = px >= PAD && px <= w ? px : PAD + (w - PAD) / 2;
    const tAt = v.t0 + (ax - PAD) / v.pps;
    v.pps = Math.max(2, Math.min(4000, v.pps * factor));
    v.t0 = tAt - (ax - PAD) / v.pps;
    dirty.current = true;
  }, []);
  const fitDuration = useCallback(() => {
    const dur = Math.max(0.5, useStore.getState().tl?.duration ?? 10);
    view.current.pps = Math.max(2, (size.current.w - PAD * 2 - 14) / dur);
    view.current.t0 = 0;
    dirty.current = true;
  }, []);
  const setRowSize = (s: RowSize) => {
    rowSize = s;
    ROW_H = ROW_SIZES[s];
    lsSet('studioex.rowSize', s);
    setRowSizeState(s);
    setScrollY((y) => clampScroll(y));
    dirty.current = true;
  };
  const [rowSizeState, setRowSizeState] = useState<RowSize>(rowSize);
  const [follow, setFollow] = useState(followPlayhead);
  useEffect(() => {
    const onZoom = (e: Event) => {
      if (useStore.getState().centerView === 'graph') return; // the graph editor handles it
      const d = (e as CustomEvent<string>).detail;
      if (d === 'in') zoomBy(1.25);
      else if (d === 'out') zoomBy(0.8);
      else if (d === 'duration') fitDuration();
    };
    window.addEventListener('studioex:zoom', onZoom);
    return () => window.removeEventListener('studioex:zoom', onZoom);
  }, [zoomBy, fitDuration]);
  useEffect(() => {
    setScrollY((y) => clampScroll(y));
  }, [rows.length, clampScroll]);
  const scrollRef = useRef(scrollY);
  scrollRef.current = scrollY;

  // ---------------- coordinate helpers ----------------
  const xOf = (t: number) => PAD + (t - view.current.t0) * view.current.pps;
  const tOf = (x: number) => view.current.t0 + (x - PAD) / view.current.pps;
  /** The shot in the ruler's shot band at x, and which part: an edge (to trim) or the middle (to move). */
  const shotHit = (x: number): { shot: Shot; kind: 'move' | 'start' | 'end' } | null => {
    const list = useStore.getState().shots;
    for (const sh of list) {
      const a = xOf(sh.start),
        b = xOf(sh.end);
      if (x < a - 3 || x > b + 3) continue;
      const wide = b - a > 18;
      return { shot: sh, kind: wide && x - a < 6 ? 'start' : wide && b - x < 6 ? 'end' : 'move' };
    }
    return null;
  };
  const rowIndexAt = (y: number) => Math.floor((y - headH() + scrollRef.current) / ROW_H);

  /** True until the user zooms/pans; while true the view auto-fits on resize. */
  const autoView = useRef(true);
  const frameAll = useCallback((automatic = true) => {
    const st = useStore.getState();
    const dur = st.tl?.duration ?? 10;
    let lo = Infinity;
    let hi = -Infinity;
    const sel = st.selKeys;
    const useSel = sel.size > 1;
    for (const tr of visibleTracks())
      for (const k of tr.keys) {
        if (useSel && !sel.has(keyId(tr.id, k[0]))) continue;
        lo = Math.min(lo, k[0]);
        hi = Math.max(hi, k[0]);
      }
    if (!Number.isFinite(lo) || hi - lo < 0.05) {
      lo = 0;
      hi = Math.max(dur, 0.5);
    }
    if (automatic && full) { lo = 0; hi = Math.max(0.5, dur); }
    if (shot) { lo = shot.start; hi = shot.end; }
    const w = Math.max(1, size.current.w - PAD * 2 - 20);
    view.current.pps = w / (hi - lo);
    view.current.t0 = lo;
    dirty.current = true;
  }, [shot?.id, shot?.start, shot?.end, full]);

  useEffect(() => {
    if (shot || full) { autoView.current = true; frameAll(); }
  }, [frameAll]);

  useEffect(() => {
    const onFrame = () => useStore.getState().centerView !== 'graph' && frameAll(false);
    window.addEventListener('studioex:frame', onFrame);
    return () => window.removeEventListener('studioex:frame', onFrame);
  }, [frameAll]);

  useEffect(() => {
    if (!fitted.current && hasTl && size.current.w > 0) {
      fitted.current = true;
      frameAll();
    }
  }, [hasTl, frameAll]);

  // ---------------- canvas sizing ----------------
  useEffect(() => {
    const wrap = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      size.current = { w: r.width, h: r.height };
      setViewH(r.height);
      const c = canvasRef.current;
      if (!c) return; // unmounting
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
      // Keep re-fitting while the layout settles (workspace switch, window resize) until the user
      // zooms or pans themselves.
      if (useStore.getState().tl && (!fitted.current || autoView.current) && r.width > 50) {
        fitted.current = true;
        frameAll();
      }
      dirty.current = true;
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [frameAll]);

  // ---------------- drawing ----------------
  useEffect(() => {
    let raf = 0;
    const readColors = () => ({
      text0: cssVar('--text-0'),
      bg0: cssVar('--bg-0'),
      bg1: cssVar('--bg-1'),
      bg2: cssVar('--bg-2'),
      line: cssVar('--line'),
      lineSoft: cssVar('--line-soft'),
      text1: cssVar('--text-1'),
      text2: cssVar('--text-2'),
      text3: cssVar('--text-3'),
      accent: cssVar('--accent'),
      accent2: cssVar('--accent-2'),
      playhead: cssVar('--playhead'),
    });
    let colors = readColors();
    // a new theme or accent: new colours, drawn at once
    const offTheme = onThemeChange(() => {
      colors = readColors();
      dirty.current = true;
    });

    let drawnTime: number | undefined;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const st = useStore.getState();
      const playing = !!st.tl?.playing;
      // a seek from anywhere (Home, the frame/key buttons, another panel) moves the playhead too
      const timeMoved = st.tl?.time !== drawnTime;
      if (!dirty.current && !playing && !timeMoved && inter.current.mode === 'none' && pops.current.size === 0) return;
      drawnTime = st.tl?.time;
      dirty.current = false;
      const perfT0 = performance.now();

      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext('2d')!;
      const dpr = window.devicePixelRatio || 1;
      const { w, h } = size.current;
      const v = view.current;
      const fps = st.tl?.fps ?? 60;
      const duration = st.tl?.duration ?? 10;
      const now = liveTime();

      // follow playhead while playing
      if (playing && followPlayhead && inter.current.mode === 'none') {
        const px = xOf(now);
        if (px > w - 30 || px < PAD) {
          v.t0 = now - 10 / v.pps;
        }
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colors.bg0;
      ctx.fillRect(0, 0, w, h);

      const rowsNow = rowsRef.current;
      const sy = scrollRef.current;
      const head = headH();
      const first = Math.max(0, Math.floor(sy / ROW_H));
      const last = Math.min(rowsNow.length - 1, Math.ceil((sy + h - head) / ROW_H));
      const selKeys = st.selKeys;
      const selTr = st.selTracks;
      const drag = inter.current.mode === 'drag' && inter.current.active ? inter.current.dt : 0;

      // rows background
      for (let i = first; i <= last; i++) {
        const row = rowsNow[i];
        const y = head + i * ROW_H - sy;
        if (row.kind !== 'track') {
          ctx.fillStyle = colors.bg2;
          ctx.fillRect(0, y, w, ROW_H);
        } else if (selTr.has(row.track.id)) {
          ctx.fillStyle = tokenRgba('--accent-2', 0.1);
          ctx.fillRect(0, y, w, ROW_H);
        }
        ctx.fillStyle = colors.lineSoft;
        ctx.fillRect(0, y + ROW_H - 1, w, 1);
      }

      // beyond-duration shade
      const xEnd = xOf(duration);
      if (xEnd < w) {
        ctx.fillStyle = tokenRgba('--shade', 0.35);
        ctx.fillRect(Math.max(0, xEnd), RULER_H, w - xEnd, h - RULER_H);
      }
      const xStart = xOf(0);
      if (xStart > 0) {
        ctx.fillStyle = tokenRgba('--shade', 0.35);
        ctx.fillRect(0, RULER_H, xStart, h - RULER_H);
      }

      // grid
      const major = niceStep(v.pps, 72, fps);
      const minor = v.pps / fps >= 7 ? 1 / fps : major / 5;
      const tA = tOf(0);
      const tB = tOf(w);
      if (minor * v.pps >= 5) {
        ctx.fillStyle = tokenRgba('--ink', 0.025);
        for (let t = Math.ceil(tA / minor) * minor, gi = 0; t <= tB && gi < 2000; t += minor, gi++) ctx.fillRect(Math.round(xOf(t)), RULER_H, 1, h - RULER_H);
      }
      ctx.fillStyle = tokenRgba('--ink', 0.06);
      for (let t = Math.ceil(tA / major) * major, gi = 0; t <= tB && gi < 2000; t += major, gi++) ctx.fillRect(Math.round(xOf(t)), RULER_H, 1, h - RULER_H);

      // keys
      const drawKey = (x: number, y: number, r: number, kind: string, selected: boolean, dim: boolean) => {
        ctx.beginPath();
        if (kind === 'step') ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
        else if (kind === 'ease' || kind === 'custom') ctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
        else {
          ctx.moveTo(x, y - r);
          ctx.lineTo(x + r, y);
          ctx.lineTo(x, y + r);
          ctx.lineTo(x - r, y);
          ctx.closePath();
        }
        ctx.fillStyle = selected ? colors.accent : dim ? colors.text3 : colors.text0;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = selected ? tokenColor('--glint') : tokenRgba('--bg-0', 0.85); // a rim in the ground colour keeps dense keys apart in either theme
        ctx.stroke();
      };

      // Only keys inside the visible time range are looked at (keys are sorted by time; selected keys may be
      // shifted by a drag, so the range is widened by it), and selection lookups (string keys) are skipped
      // entirely when nothing is selected — large scenes otherwise allocate per key per frame while playing.
      const anySel = selKeys.size > 0;
      const isSel = (id: number, t: number) => anySel && selKeys.has(keyId(id, t));
      const hv = hover.current;
      const tNow = performance.now();
      for (const [id, at] of pops.current) if (tNow - at > POP_MS) pops.current.delete(id);
      const anyPop = pops.current.size > 0;
      /** a soft halo behind a selected key */
      const halo = (x: number, y: number, r: number) => {
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, Math.PI * 2);
        ctx.fillStyle = tokenRgba('--accent', 0.18);
        ctx.fill();
      };
      /** a ring that grows and fades around a key that just appeared */
      const ring = (x: number, y: number, age: number) => {
        const p = age / POP_MS;
        ctx.beginPath();
        ctx.arc(x, y, 6 + p * 9, 0, Math.PI * 2);
        ctx.strokeStyle = tokenRgba('--accent', (1 - p) * 0.9);
        ctx.lineWidth = 2 * (1 - p) + 0.5;
        ctx.stroke();
      };
      const tLo = tOf(-10) - Math.abs(drag),
        tHi = tOf(w + 10) + Math.abs(drag);
      for (let i = first; i <= last; i++) {
        const row = rowsNow[i];
        const cy = head + i * ROW_H - sy + ROW_H / 2;
        if (row.kind === 'track') {
          const tr = row.track;
          const keys = tr.keys;
          const dim = !tr.enabled;
          if (!keys.length) continue;
          // one key either side of the window, so segment bars crossing the edges still draw
          const k0 = Math.max(0, firstKeyAtOrAfter(keys, tLo) - 1);
          const k1 = Math.min(keys.length - 1, firstKeyAtOrAfter(keys, tHi));
          // segment bars
          ctx.fillStyle = dim ? tokenRgba('--ink', 0.04) : tokenRgba('--ink', 0.09);
          let prevSel = isSel(tr.id, keys[k0][0]);
          for (let k = k0; k < k1; k++) {
            const nextSel = isSel(tr.id, keys[k + 1][0]);
            const xa = xOf(keys[k][0] + (prevSel ? drag : 0));
            const xb = xOf(keys[k + 1][0] + (nextSel ? drag : 0));
            prevSel = nextSel;
            if (xb < 0 || xa > w) continue;
            ctx.fillRect(xa, cy - 2, xb - xa, 4);
          }
          for (let k = k0; k <= k1; k++) {
            const key = keys[k];
            const sel = isSel(tr.id, key[0]);
            const x = xOf(key[0] + (sel ? drag : 0));
            if (x < -10 || x > w + 10) continue;
            const kind = curveKind(key[1]);
            // while dragging, a faint ghost stays where the key was
            if (sel && drag !== 0) {
              ctx.globalAlpha = 0.28;
              drawKey(xOf(key[0]), cy, 5.5, kind, false, true);
              ctx.globalAlpha = 1;
            }
            const hot = !!hv && hv.row === i && Math.abs(hv.t - key[0]) < 1e-4 && drag === 0;
            if (sel) halo(x, cy, 5.5);
            drawKey(x, cy, hot ? 7 : 5.5, kind, sel, dim && !hot);
            if (anyPop) {
              const at = pops.current.get(keyId(tr.id, key[0]));
              if (at !== undefined) ring(x, cy, tNow - at);
            }
          }
        } else {
          // summary keys: merged once per (row, selection, drag), then reused every frame
          let sum = summaryCache.get(row);
          if (!sum || sum.sel !== selKeys || sum.drag !== drag) {
            const times = new Map<number, boolean>();
            for (const tr of row.tracks)
              for (const k of tr.keys) {
                const sel = isSel(tr.id, k[0]);
                const t = Math.round((k[0] + (sel ? drag : 0)) * 10000) / 10000;
                times.set(t, (times.get(t) ?? false) || sel);
              }
            const ts = [...times.keys()].sort((a, b) => a - b);
            sum = { sel: selKeys, drag, ts, sels: ts.map((t) => times.get(t)!) };
            summaryCache.set(row, sum);
          }
          const { ts, sels } = sum;
          for (let k = Math.max(0, firstAtOrAfter(ts, tLo)); k < ts.length && ts[k] <= tHi; k++) {
            const x = xOf(ts[k]);
            if (x < -10 || x > w + 10) continue;
            const hot = !!hv && hv.row === i && Math.abs(hv.t - ts[k]) < 1e-4 && drag === 0;
            if (sels[k]) halo(x, cy, 4.5);
            drawKey(x, cy, hot ? 6 : 4.5, 'linear', sels[k], !sels[k] && !hot);
          }
        }
      }

      // audio lanes: one per clip, with its waveform; drag a clip to move where it starts
      st.audio.forEach((au, li) => {
        const y0 = RULER_H + li * AUDIO_H;
        const rgb = laneRgb(li);
        ctx.fillStyle = colors.bg1;
        ctx.fillRect(0, y0, w, AUDIO_H);
        const ia = inter.current;
        const dragging = ia.mode === 'audio' && ia.id === au.id;
        const off = dragging ? ia.offset : au.offset;
        const at = { ...au, offset: off };
        const xa = xOf(off),
          xb = xOf(off + clipSpan(at));
        if (xb > 0 && xa < w) {
          const dim = au.muted;
          ctx.fillStyle = `rgba(${rgb},${dim ? 0.05 : 0.14})`;
          ctx.strokeStyle = dragging ? colors.accent2 : `rgba(${rgb},0.5)`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(Math.round(xa) + 0.5, y0 + 3.5, Math.max(2, xb - xa - 1), AUDIO_H - 7, 4);
          if (dragging) {
            // picked up: it lifts off the lane
            ctx.save();
            ctx.shadowColor = tokenRgba('--shade', 0.55);
            ctx.shadowBlur = 12;
            ctx.shadowOffsetY = 3;
            ctx.fillStyle = `rgba(${rgb},0.24)`;
            ctx.fill();
            ctx.restore();
          } else ctx.fill();
          ctx.stroke();
          const wave = st.audioPeaks[au.id];
          if (wave && wave.peaks.length) {
            ctx.fillStyle = `rgba(${rgb},${dim ? 0.3 : 0.9})`;
            const ps = wave.perSecond,
              pk = wave.peaks,
              mid = y0 + 23,
              half = 8 / loudest(wave);
            for (let x = Math.max(0, Math.floor(xa) + 1); x < Math.min(w, xb - 1); x++) {
              // trims and speed: which part of the file is under this pixel; fades shrink it
              const i0 = Math.max(0, Math.floor(fileTimeAt(at, tOf(x)) * ps)),
                i1 = Math.min(pk.length - 1, Math.floor(fileTimeAt(at, tOf(x + 1)) * ps));
              let p = 0;
              for (let i = i0; i <= i1; i++) if (pk[i] > p) p = pk[i];
              const bh = Math.max(0.5, p * half * fadeAt(at, tOf(x)));
              ctx.fillRect(x, mid - bh, 1, bh * 2);
            }
          }
          // name at the clip's start (kept on screen while it scrolls)
          ctx.font = '600 10px Segoe UI, system-ui, sans-serif';
          ctx.textBaseline = 'top';
          const label = `\u266a ${audioName(au)}${au.muted ? '  (muted)' : ''}`;
          ctx.save();
          ctx.beginPath();
          ctx.rect(xa + 2, y0, Math.max(0, xb - xa - 6), AUDIO_H);
          ctx.clip();
          ctx.fillStyle = dim ? colors.text3 : colors.text1;
          ctx.fillText(label, Math.max(xa + 6, 6), y0 + 5);
          ctx.restore();
        }
        // where Listen is
        if (st.audioListen?.id === au.id) {
          const lx = Math.round(xOf(timelineTimeAt(au, st.audioListen.at)));
          ctx.fillStyle = colors.accent;
          ctx.fillRect(lx - 1, y0, 2, AUDIO_H);
        }
        ctx.fillStyle = colors.lineSoft;
        ctx.fillRect(0, y0 + AUDIO_H - 1, w, 1);
      });

      // ruler
      ctx.fillStyle = colors.bg1;
      ctx.fillRect(0, 0, w, RULER_H);
      // shots: a band along the top of the ruler (drag to move, edges to trim; the picked one is brighter)
      [...st.shots].sort((a, b) => a.start - b.start).forEach((sh, i) => {
        const x0 = Math.max(PAD, xOf(sh.start)),
          x1 = Math.min(w, xOf(sh.end));
        if (x1 <= x0) return;
        const picked = sh.id === st.selShotId;
        ctx.fillStyle = picked ? colors.accent : i % 2 ? tokenRgba('--accent', 0.55) : tokenRgba('--kind-proj', 0.65);
        ctx.fillRect(x0 + 1, 0, Math.max(1, x1 - x0 - 2), picked ? SHOT_BAND : SHOT_BAND - 2);
      });
      ctx.fillStyle = colors.line;
      ctx.fillRect(0, RULER_H - 1, w, 1);
      ctx.font = '10px Segoe UI, system-ui, sans-serif';
      ctx.textBaseline = 'top';
      if (minor * v.pps >= 4) {
        ctx.fillStyle = colors.text3;
        for (let t = Math.ceil(tA / minor) * minor, gi = 0; t <= tB && gi < 2000; t += minor, gi++) ctx.fillRect(Math.round(xOf(t)), RULER_H - 5, 1, 4);
      }
      for (let t = Math.ceil(tA / major) * major, gi = 0; t <= tB && gi < 2000; t += major, gi++) {
        const x = Math.round(xOf(t));
        ctx.fillStyle = colors.text3;
        ctx.fillRect(x, RULER_H - 10, 1, 9);
        ctx.fillStyle = t < -1e-6 || t > duration + 1e-6 ? colors.text3 : colors.text2;
        const label = major < 1 ? `${t.toFixed(major < 0.1 ? 2 : 1)}s` : `${Math.round(t)}s`;
        ctx.fillText(label, x + 3, 5);
        if (major * v.pps > 110 && v.pps / fps > 1) {
          ctx.fillStyle = colors.text3;
          ctx.fillText(`f${Math.round(t * fps)}`, x + 3, 15);
        }
      }
      // duration end marker
      if (xEnd >= 0 && xEnd <= w) {
        ctx.fillStyle = colors.text3;
        ctx.fillRect(Math.round(xEnd), 0, 2, h);
      }

      // what a drag / scrub snapped to
      const sh = snapHint.current;
      const mode = inter.current.mode;
      if (sh && (mode === 'drag' || mode === 'scrub' || mode === 'audio')) {
        const sx = Math.round(xOf(sh.t)) + 0.5;
        ctx.save();
        ctx.strokeStyle = tokenRgba('--accent', 0.85);
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(sx, RULER_H);
        ctx.lineTo(sx, h);
        ctx.stroke();
        ctx.restore();
        ctx.font = '600 10px Segoe UI, system-ui, sans-serif';
        const tw = ctx.measureText(sh.label).width + 10;
        ctx.fillStyle = tokenRgba('--accent', 0.95);
        ctx.beginPath();
        ctx.roundRect(sx + 4, RULER_H + 3, tw, 15, 4);
        ctx.fill();
        ctx.fillStyle = tokenColor('--on-accent');
        ctx.textBaseline = 'middle';
        ctx.fillText(sh.label, sx + 9, RULER_H + 11);
      }

      // playhead
      const px = Math.round(xOf(now));
      if (px >= -10 && px <= w + 10) {
        ctx.fillStyle = colors.playhead;
        ctx.fillRect(px, RULER_H - 2, 1.5, h - RULER_H + 2);
        // a soft glow either side, so the playhead reads at a glance
        ctx.fillStyle = tokenRgba('--playhead', 0.16);
        ctx.fillRect(px - 2, RULER_H - 2, 5.5, h - RULER_H + 2);
        ctx.fillStyle = colors.playhead;
        const label = `${Math.round(now * fps)}`;
        ctx.font = '600 10px Segoe UI, system-ui, sans-serif';
        const tw = ctx.measureText(label).width + 10;
        ctx.beginPath();
        ctx.roundRect(px - tw / 2, 3, tw, 17, 4);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, px - tw / 2 + 5, 12);
      }

      // box selection
      const it = inter.current;
      if (it.mode === 'box') {
        const b = boxRect(it);
        const x = Math.min(b.x0, b.x1);
        const y = Math.min(b.y0, b.y1);
        ctx.fillStyle = tokenRgba('--accent-2', 0.12);
        ctx.strokeStyle = colors.accent2;
        ctx.fillRect(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
        ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      }
      if (it.mode === 'drag' && it.active) {
        ctx.fillStyle = colors.accent;
        ctx.font = '600 11px Segoe UI, system-ui, sans-serif';
        ctx.textBaseline = 'bottom';
        const frames = Math.round(it.dt * fps);
        ctx.fillText(`${it.dt >= 0 ? '+' : ''}${it.dt.toFixed(3)}s  (${frames >= 0 ? '+' : ''}${frames}f)`, PAD, h - 6);
      }
      perfRecord('dopeDraw', performance.now() - perfT0);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      offTheme();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------- hit testing ----------------
  const keysAt = (x: number, y: number): KeyId[] => {
    const idx = rowIndexAt(y);
    const row = rowsRef.current[idx];
    if (!row || y < headH()) return [];
    const list = row.kind === 'track' ? [row.track] : row.tracks;
    let bestDx = KEY_HIT + 1;
    let bestT: number | null = null;
    for (const tr of list)
      for (const k of tr.keys) {
        const dx = Math.abs(xOf(k[0]) - x);
        if (dx < bestDx) {
          bestDx = dx;
          bestT = k[0];
        }
      }
    if (bestT === null) return [];
    const ids: KeyId[] = [];
    for (const tr of list) for (const k of tr.keys) if (Math.abs(k[0] - bestT) < 1e-4) ids.push(keyId(tr.id, k[0]));
    return ids;
  };

  /** The box on screen now: its start where it was clicked (time and row, wherever they've scrolled to), its end at the pointer. */
  const boxRect = (it: { ta: number; ca: number; x1: number; y1: number }) => ({ x0: xOf(it.ta), y0: it.ca - scrollRef.current, x1: it.x1, y1: it.y1 });

  /**
   * While a box is dragged past the top or bottom of the tracks (or past the left or right edge), the sheet scrolls
   * that way, faster the further out, and the box keeps growing — rows and keys off screen get picked up too.
   */
  const edgeFrame = useRef(0);
  const edgeScroll = () => {
    if (edgeFrame.current) return;
    const step = () => {
      edgeFrame.current = 0;
      const it = inter.current;
      if (it.mode !== 'box') return;
      const top = headH();
      const bottom = size.current.h - HSCROLL_H;
      const right = size.current.w;
      const ramp = (d: number) => Math.min(28, 4 + d * 0.5);
      let dy = 0;
      if (it.y1 < top + 12) dy = -ramp(top + 12 - it.y1);
      else if (it.y1 > bottom - 12) dy = ramp(it.y1 - (bottom - 12));
      let dx = 0;
      if (it.x1 < PAD + 8) dx = -ramp(PAD + 8 - it.x1);
      else if (it.x1 > right - 12) dx = ramp(it.x1 - (right - 12));
      if (!dy && !dx) return;
      if (dy) {
        const next = clampScroll(scrollRef.current + dy);
        if (next !== scrollRef.current) {
          scrollRef.current = next; // the box reads it this frame; React catches up on render
          setScrollY(next);
        }
      }
      if (dx) {
        autoView.current = false;
        view.current.t0 = Math.max(-1, view.current.t0 + dx / view.current.pps);
      }
      dirty.current = true;
      edgeFrame.current = requestAnimationFrame(step);
    };
    edgeFrame.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(edgeFrame.current), []);

  const keysInBox = (x0: number, y0: number, x1: number, y1: number): KeyId[] => {
    const [xa, xb] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ya, yb] = [Math.min(y0, y1), Math.max(y0, y1)];
    const ids: KeyId[] = [];
    rowsRef.current.forEach((row, i) => {
      const cy = headH() + i * ROW_H - scrollRef.current + ROW_H / 2;
      if (cy < ya - 4 || cy > yb + 4) return;
      const list = row.kind === 'track' ? [row.track] : row.tracks;
      for (const tr of list)
        for (const k of tr.keys) {
          const x = xOf(k[0]);
          if (x >= xa - 4 && x <= xb + 4) ids.push(keyId(tr.id, k[0]));
        }
    });
    return ids;
  };

  /** What the last snap caught (drawn as a line while dragging / scrubbing). */
  const snapHint = useRef<{ t: number; label: string } | null>(null);

  /**
   * Snap: within a few pixels of something worth landing on — a key, the playhead, a ruler tick, the start or end,
   * an audio clip's edges — it lands exactly there; otherwise on a whole frame. Alt while dragging: no snapping.
   */
  const snapT = (t: number, e: { altKey: boolean }, o?: { skipKeys?: Set<string>; noPlayhead?: boolean; skipClip?: number }) => {
    const st = useStore.getState();
    snapHint.current = null;
    if (!st.snap || e.altKey || !st.tl) return t;
    const pps = view.current.pps;
    const tol = 8 / pps;
    let best = tol;
    let at = NaN;
    let label = '';
    const near = (c: number, l: string) => {
      const d = Math.abs(c - t);
      if (d < best) {
        best = d;
        at = c;
        label = l;
      }
    };
    // keys: only on the tracks being worked on (the dragged keys' tracks, else the selected tracks), or all of them
    if (st.snapKeys !== 'none') {
      let only: Set<number> | null = null;
      if (st.snapKeys === 'track') {
        only = new Set<number>();
        if (o?.skipKeys?.size) o.skipKeys.forEach((id) => only!.add(parseKeyId(id).track));
        else st.selTracks.forEach((id) => only!.add(id));
      }
      for (const tr of st.tracks) {
        if (!tr.keys || (only && !only.has(tr.id))) continue;
        for (const k of tr.keys) if (!o?.skipKeys?.has(keyId(tr.id, k[0]))) near(k[0], 'key');
      }
    }
    if (!o?.noPlayhead) near(liveTime(), 'playhead');
    near(0, 'start');
    near(st.tl.duration, 'end');
    for (const c of st.audio) {
      if (c.id === o?.skipClip) continue;
      near(c.offset, 'audio start');
      if (c.duration > 0) near(c.offset + c.duration, 'audio end');
    }
    // the ruler's ticks (whole seconds, halves… as zoomed)
    const major = niceStep(pps, 72, st.tl.fps);
    const tick = Math.round(t / major) * major;
    near(tick, fmtTick(tick));
    if (!Number.isNaN(at)) {
      // a key slightly off a frame still lands on that key exactly; anything else, on the frame grid
      snapHint.current = { t: at, label };
      return at;
    }
    return snapToFrame(t, st.tl.fps);
  };
  const fmtTick = (t: number) => (Math.abs(t - Math.round(t)) < 1e-6 ? `${Math.round(t)}s` : `${+t.toFixed(2)}s`);

  // ---------------- pointer handling ----------------
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    setMenu(null);
    if (e.button === 1 || (e.button === 0 && e.nativeEvent.getModifierState?.('Space'))) {
      autoView.current = false;
      inter.current = { mode: 'pan', startX: x, startT0: view.current.t0 };
      canvasRef.current!.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button === 2) {
      const hit = keysAt(x, y);
      if (hit.length && !hit.some((id) => useStore.getState().selKeys.has(id))) selectKeys(hit);
      return;
    }
    if (e.button !== 0) return;
    canvasRef.current!.setPointerCapture(e.pointerId);

    if (y < RULER_H) {
      const hit = y <= SHOT_BAND + 2 ? shotHit(x) : null;
      if (hit) {
        const st = useStore.getState();
        useStore.setState({ selShotId: hit.shot.id });
        inter.current = { mode: 'shot', id: hit.shot.id, kind: hit.kind, startX: x, orig: st.shots, moved: false, label: hit.kind === 'move' ? 'Move shot' : 'Trim shot' };
        dirty.current = true;
        return;
      }
      inter.current = { mode: 'scrub' };
      seek(snapT(tOf(x), e, { noPlayhead: true }));
      return;
    }
    const lane = laneAt(y);
    if (lane) {
      // on the clip: drag it (a plain click moves the playhead there); off it: scrub
      const au = lane.clip;
      if (x >= xOf(au.offset) && x <= xOf(au.offset + clipSpan(au))) inter.current = { mode: 'audio', id: au.id, startX: x, startOffset: au.offset, offset: au.offset, active: false };
      else {
        inter.current = { mode: 'scrub' };
        seek(snapT(tOf(x), e, { noPlayhead: true }));
      }
      dirty.current = true;
      return;
    }

    const hit = keysAt(x, y);
    const st = useStore.getState();
    if (hit.length) {
      const anySel = hit.some((id) => st.selKeys.has(id));
      if (e.ctrlKey) selectKeys(hit, 'toggle');
      else if (e.shiftKey) selectKeys(hit, 'add');
      else if (!anySel) selectKeys(hit);
      const { t } = parseKeyId(hit[0]);
      inter.current = { mode: 'drag', startX: x, grabT: t, dt: 0, active: false, clickedId: hit[0], collapseOnClick: anySel && !e.ctrlKey && !e.shiftKey };
      // select row for keying convenience
      const row = rowsRef.current[rowIndexAt(y)];
      if (row?.kind === 'track' && !e.ctrlKey && !e.shiftKey) selectTracks([row.track.id]);
    } else {
      inter.current = { mode: 'box', ta: tOf(x), ca: y + scrollRef.current, x1: x, y1: y, additive: e.shiftKey, toggle: e.ctrlKey };
    }
    dirty.current = true;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const it = inter.current;
    if (it.mode === 'none') {
      // the key under the pointer grows a little, and the pointer says it can be grabbed
      const r = canvasRef.current!.getBoundingClientRect();
      const x = e.clientX - r.left,
        y = e.clientY - r.top;
      const onShot = e.buttons === 0 && y <= SHOT_BAND + 2 ? shotHit(x) : null;
      const cv = canvasRef.current!;
      if (onShot) {
        cv.style.cursor = onShot.kind === 'move' ? 'grab' : 'ew-resize';
        cv.title = `${onShot.shot.name} · ${onShot.shot.start.toFixed(2)}–${onShot.shot.end.toFixed(2)} s — drag to move, drag an edge to trim`;
        return;
      }
      if (cv.title) {
        cv.title = '';
        cv.style.cursor = '';
      }
      const hit = e.buttons === 0 ? keysAt(x, y) : [];
      const next = hit.length ? { row: rowIndexAt(y), t: parseKeyId(hit[0]).t } : null;
      const prev = hover.current;
      if ((prev === null) !== (next === null) || (prev && next && (prev.row !== next.row || Math.abs(prev.t - next.t) > 1e-6))) {
        hover.current = next;
        canvasRef.current!.style.cursor = next ? 'grab' : '';
        dirty.current = true;
      }
      return;
    }
    if (e.buttons === 0) return onPointerUp(e); // button released somewhere we didn't hear about
    const r = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (it.mode === 'scrub') seek(snapT(tOf(x), e, { noPlayhead: true }));
    else if (it.mode === 'shot') {
      if (!it.moved && Math.abs(x - it.startX) < 3) return;
      it.moved = true;
      const me = it.orig.find((sh) => sh.id === it.id);
      const dur = useStore.getState().tl?.duration ?? 10;
      const fps = useStore.getState().tl?.fps ?? 30;
      if (me) {
        const dt = (x - it.startX) / view.current.pps;
        const targets = e.altKey ? [] : [0, dur, liveTime(), ...it.orig.filter((sh) => sh.id !== it.id).flatMap((sh) => [sh.start, sh.end])];
        const tol = 8 / view.current.pps;
        const next =
          it.kind === 'move'
            ? moveShot(it.orig, it.id, snapTime(me.start + dt, fps, targets, tol), dur)
            : trimShot(it.orig, it.id, it.kind, snapTime((it.kind === 'start' ? me.start : me.end) + dt, fps, targets, tol), dur);
        useStore.setState({ shots: next });
      }
    } else if (it.mode === 'audio') {
      if (!it.active && Math.abs(x - it.startX) > 3) it.active = true;
      if (it.active) it.offset = Math.round(snapT(it.startOffset + (x - it.startX) / view.current.pps, e, { skipClip: it.id }) * 1000) / 1000;
    } else if (it.mode === 'pan') view.current.t0 = it.startT0 - (x - it.startX) / view.current.pps;
    else if (it.mode === 'box') {
      it.x1 = x;
      it.y1 = y;
      edgeScroll();
    } else if (it.mode === 'drag') {
      if (!it.active && Math.abs(x - it.startX) > 3) it.active = true;
      if (it.active) {
        let dt = (x - it.startX) / view.current.pps;
        const sel = useStore.getState().selKeys;
        dt = snapT(it.grabT + dt, e, { skipKeys: sel }) - it.grabT;
        let minT = Infinity;
        sel.forEach((id) => (minT = Math.min(minT, parseKeyId(id).t)));
        if (minT + dt < 0) dt = -minT;
        it.dt = dt;
      }
    }
    dirty.current = true;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const it = inter.current;
    inter.current = { mode: 'none' };
    snapHint.current = null;
    try {
      canvasRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (it.mode === 'shot') {
      if (!it.moved) seek(snapT(tOf(it.startX), e));
      else {
        const now = useStore.getState().shots;
        if (JSON.stringify(now) !== JSON.stringify(it.orig)) void saveShots(now, it.label);
      }
    } else if (it.mode === 'audio') {
      if (it.active && Math.abs(it.offset - it.startOffset) > 1e-6) setAudio(it.id, { offset: it.offset });
      else if (!it.active) seek(snapT(tOf(it.startX), e));
    } else if (it.mode === 'drag') {
      if (it.active && Math.abs(it.dt) > 1e-6) moveSelectedKeys(it.dt);
      else if (!it.active && it.collapseOnClick) {
        const r = canvasRef.current!.getBoundingClientRect();
        selectKeys(keysAt(e.clientX - r.left, e.clientY - r.top));
      }
    } else if (it.mode === 'box') {
      const b = boxRect(it);
      const small = Math.abs(b.x1 - b.x0) < 3 && Math.abs(b.y1 - b.y0) < 3;
      if (small) {
        if (!it.additive && !it.toggle) selectKeys([]);
        const row = rowsRef.current[rowIndexAt(b.y0)];
        if (row?.kind === 'track') selectTracks([row.track.id], it.toggle ? 'toggle' : it.additive ? 'add' : 'replace');
      } else {
        selectKeys(keysInBox(b.x0, b.y0, b.x1, b.y1), it.toggle ? 'toggle' : it.additive ? 'add' : 'replace');
      }
    }
    dirty.current = true;
  };

  const onDoubleClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (y < RULER_H) return;
    const lane = laneAt(y);
    if (lane) {
      listenAudio(lane.clip.id, fileTimeAt(lane.clip, tOf(x)));
      return;
    }
    const row = rowsRef.current[rowIndexAt(y)];
    if (!row) return;
    const t = Math.max(0, snapT(tOf(x), e));
    const ids = row.kind === 'track' ? [row.track.id] : row.tracks.map((tr) => tr.id);
    await seekNow(t);
    await keyTracks(ids, t);
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const r = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const st = useStore.getState();
    const lane = laneAt(y);
    if (lane) {
      setMenu({ x: e.clientX, y: e.clientY, items: audioMenu(lane.clip.id, tOf(x)) });
      return;
    }
    const hasSel = st.selKeys.size > 0;
    const row = rowsRef.current[rowIndexAt(y)];
    const t = Math.max(0, snapT(tOf(x), e));
    const items: MenuItem[] = [];
    if (hasSel) {
      items.push({ label: `${st.selKeys.size} key${st.selKeys.size > 1 ? 's' : ''} selected`, header: true });
      items.push({ label: 'Interpolation', header: true });
      for (const p of PRESETS.slice(0, 5)) items.push({ label: p.label, kbd: p.hotkey, action: () => applyCurveToSelected(toFlat(p.curve)) });
      items.push({ sep: true });
      items.push({ label: 'Copy', kbd: 'Ctrl+C', action: copySelected });
      items.push({ label: 'Save as a motion clip…', action: () => showTab('animate', 'clips') });
      items.push({ label: 'Delete', kbd: 'Del', danger: true, action: deleteSelectedKeys });
      items.push({ sep: true });
    }
    if (row) {
      const ids = row.kind === 'track' ? [row.track.id] : row.tracks.map((tr) => tr.id);
      items.push({
        label: row.kind === 'track' ? 'Insert key here' : 'Key all tracks here',
        action: async () => {
          await seekNow(t);
          await keyTracks(ids, t);
        },
      });
    }
    if (st.clipboard) items.push({ label: 'Paste at playhead', kbd: 'Ctrl+V', action: pasteAtPlayhead });
    items.push({ label: 'Frame all', kbd: 'F', action: frameAll });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  /** A clip's lane menu (canvas and names column); `at` is a timeline time, or null for none. */
  const audioMenu = (id: number, at: number | null): MenuItem[] => {
    const st = useStore.getState();
    const au = st.audio.find((c) => c.id === id);
    if (!au) return [];
    const listening = st.audioListen?.id === id;
    const inClip = at != null && at >= au.offset && at <= au.offset + clipSpan(au);
    const items: MenuItem[] = [{ header: true, label: audioName(au) }];
    if (listening) items.push({ label: 'Stop listening', action: () => listenAudio(null) });
    else {
      items.push({ label: 'Listen', action: () => listenAudio(id, au.trimIn) });
      if (inClip) items.push({ label: 'Listen from here', action: () => listenAudio(id, fileTimeAt(au, at!)) });
    }
    items.push({ sep: true });
    items.push({ label: 'Start at the playhead', action: () => setAudio(id, { offset: Math.round(liveTime() * 1000) / 1000 }) });
    items.push({ label: 'Start at 0', action: () => setAudio(id, { offset: 0 }) });
    items.push({ label: au.muted ? 'Unmute' : 'Mute while animating', action: () => setAudio(id, { muted: !au.muted }) });
    items.push({
      label: 'Rename\u2026',
      action: () =>
        setPrompt({
          title: 'Rename this audio',
          hint: `The file stays ${au.file}. Leave it empty to show the file's name.`,
          value: au.name ?? '',
          placeholder: au.file.replace(/\.wav$/i, ''),
          ok: (v) => void setAudio(id, { name: v.trim() }),
        }),
    });
    items.push({ sep: true });
    if (window.studioEx?.openAudio) {
      items.push({ label: 'Replace with another WAV\u2026', action: () => pickAudio(0, id) });
      items.push({ label: 'Add another WAV\u2026', action: () => pickAudio(Math.round(liveTime() * 1000) / 1000) });
    }
    items.push({ label: 'Volume, lip-sync\u2026', action: () => showTab('shoot', 'audio') });
    items.push({ label: 'Remove this audio', danger: true, action: () => removeAudio(id) });
    return items;
  };

  // drop a WAV anywhere on the timeline: a new clip that starts where it's dropped (or at 0 over the names)
  const [dropping, setDropping] = useState(false);
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropping) setDropping(true);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDropping(false);
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.wav$/i.test(f.name)) return toast('Drop a .wav file — Studio plays WAV only', 'error');
    const path = window.studioEx?.pathForFile?.(f);
    if (!path) return toast("Couldn't tell where that file is — use + Audio instead", 'error');
    const c = canvasRef.current!.getBoundingClientRect();
    const t = e.clientX >= c.left ? Math.max(0, snapT(tOf(e.clientX - c.left), e)) : 0;
    addAudio(path, Math.round(t * 1000) / 1000);
  };

  // wheel: needs a non-passive listener to preventDefault
  useEffect(() => {
    const c = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left;
      const v = view.current;
      if (e.ctrlKey || e.altKey || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) autoView.current = false;
      if (e.ctrlKey || e.altKey) {
        const tAt = tOf(x);
        const factor = Math.exp(-e.deltaY * 0.0015);
        v.pps = Math.max(2, Math.min(4000, v.pps * factor));
        v.t0 = tAt - (x - PAD) / v.pps;
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        v.t0 += d / v.pps;
      } else {
        setScrollY((y) => clampScroll(y + e.deltaY));
      }
      dirty.current = true;
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clampScroll]);

  // ---------------- names column ----------------
  const onNameWheel = (e: React.WheelEvent) => setScrollY((y) => clampScroll(y + e.deltaY));

  const onTrackClick = (e: React.MouseEvent, tr: WireTrack) => {
    if (e.shiftKey && lastAnchor.current != null) {
      const ids = rows.filter((r): r is Extract<Row, { kind: 'track' }> => r.kind === 'track').map((r) => r.track.id);
      const a = ids.indexOf(lastAnchor.current);
      const b = ids.indexOf(tr.id);
      if (a >= 0 && b >= 0) {
        selectTracks(ids.slice(Math.min(a, b), Math.max(a, b) + 1), e.ctrlKey ? 'add' : 'replace');
        return;
      }
    }
    lastAnchor.current = tr.id;
    selectTracks([tr.id], e.ctrlKey ? 'toggle' : 'replace');
  };

  const trackMenu = (e: React.MouseEvent, tr: WireTrack) => {
    e.preventDefault();
    const st = useStore.getState();
    if (!st.selTracks.has(tr.id)) selectTracks([tr.id]);
    const targets = st.selTracks.has(tr.id) ? [...st.selTracks] : [tr.id];
    const items: MenuItem[] = [
      { label: displayName(tr), header: true },
      { label: 'Key at playhead', kbd: 'K', action: () => keyTracks(targets) },
      { label: 'Select all keys', action: () => selectKeys(tr.keys.map((k) => keyId(tr.id, k[0]))) },
      { label: 'Rename…', action: () => setRenaming(tr.id) },
      ...(/[　-￿]/.test(tr.name) ? [{ label: 'Fix translation…', action: () => editTranslation(tr.name) }] : []),
      { label: tr.enabled ? 'Disable (mute)' : 'Enable', action: () => setTrackProps(tr.id, { enabled: !tr.enabled }) },
      { sep: true },
      {
        label: targets.length > 1 ? `New folder from ${targets.length} tracks` : 'New folder from track',
        kbd: 'Ctrl+G',
        action: () => newFolderFrom(targets),
      },
      ...(tr.group !== -1 ? [{ label: 'Remove from folder', action: () => moveToFolder(targets, -1) }] : []),
      ...folderTargets(tr.group).map((g) => ({ label: `Move to “${g.name}”`, action: () => moveToFolder(targets, g.id) })),
      { sep: true },
      { label: targets.length > 1 ? `Delete ${targets.length} tracks` : 'Delete track', danger: true, action: () => removeTracks(targets) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const folderTargets = (exclude: number) => useStore.getState().groups.filter((g) => g.id !== exclude).slice(0, 10);

  /** Create a folder and immediately put its name in edit mode (folder view). */
  const newFolderFrom = async (trackIds: number[]) => {
    await createFolder('New folder', trackIds);
    const st = useStore.getState();
    if (st.groupMode !== 'folders') {
      useStore.setState({ groupMode: 'folders' });
      lsSet('studioex.groupMode', 'folders');
    }
    const created = st.groups.find((g) => g.name === 'New folder' && st.tracks.some((t) => t.group === g.id && trackIds.includes(t.id)));
    if (created) setRenamingGroup(created.id);
  };

  const folderMenu = (e: React.MouseEvent, row: Extract<Row, { kind: 'grp' }>) => {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: row.label, header: true },
      { label: 'Rename…', action: () => setRenamingGroup(row.gid) },
      { label: row.expanded ? 'Collapse' : 'Expand', action: () => setFolderExpanded(row.gid, !row.expanded) },
      { label: 'Select all tracks', action: () => selectTracks(row.tracks.map((t) => t.id)) },
      { label: 'Select all keys', action: () => selectKeys(row.tracks.flatMap((t) => t.keys.map((k) => keyId(t.id, k[0])))) },
      { label: 'Key all at playhead', kbd: 'K', action: () => keyTracks(row.tracks.map((t) => t.id)) },
      { label: 'Mute all its tracks', action: () => setTracksEnabled(row.tracks.map((t) => t.id), false) },
      { label: 'Unmute all its tracks', action: () => setTracksEnabled(row.tracks.map((t) => t.id), true) },
      { sep: true },
      { label: 'Ungroup (keep tracks)', action: () => ungroupFolder(row.gid) },
      { label: `Delete folder and its ${row.tracks.length} tracks`, danger: true, action: () => removeTracks(row.tracks.map((t) => t.id)) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  useEffect(() => {
    const onGroup = () => {
      const ids = [...useStore.getState().selTracks];
      if (ids.length) newFolderFrom(ids);
      else toast('Select tracks first (click names, Ctrl/Shift for several)');
    };
    window.addEventListener('studioex:group', onGroup);
    return () => window.removeEventListener('studioex:group', onGroup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleCollapsed = (oci: number) => {
    const next = new Set(useStore.getState().collapsed);
    if (next.has(oci)) next.delete(oci);
    else next.add(oci);
    useStore.setState({ collapsed: next });
  };

  const visibleRows: { row: Row; i: number }[] = [];
  const firstRow = Math.max(0, Math.floor(scrollY / ROW_H) - 1);
  const lastRow = Math.min(rows.length - 1, Math.ceil((scrollY + viewH) / ROW_H) + 1);
  for (let i = firstRow; i <= lastRow; i++) visibleRows.push({ row: rows[i], i });

  const startResize = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const startW = nameW;
    const move = (ev: PointerEvent) => setNameW(Math.max(150, Math.min(520, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setNameW((w) => {
        lsSet('studioex.nameW', String(w));
        return w;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const totalTracks = tracks.length;
  const shown = rows.filter((r) => r.kind === 'track').length;

  return (
    <div className="center" data-timeline-editor>
      <SheetToolbar
        shown={shown}
        total={totalTracks}
        viewExtra={
          <>
            <div className="menu-label" style={{ padding: 0 }}>
              Row height
            </div>
            <div className="seg">
              {(['S', 'M', 'L'] as RowSize[]).map((s) => (
                <button key={s} className={rowSizeState === s ? 'on' : ''} onClick={() => setRowSize(s)} style={{ flex: 1 }}>
                  {s === 'S' ? 'Compact' : s === 'M' ? 'Normal' : 'Large'}
                </button>
              ))}
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={follow}
                onChange={() => {
                  followPlayhead = !followPlayhead;
                  setFollow(followPlayhead);
                }}
              />
              Follow playhead while playing
            </label>
          </>
        }
      />
      {!compact && <SelectionBar />}
      {centerView === 'graph' && <GraphEditor />}
      <div
        className={`sheet ${dropping ? 'dropping' : ''}`}
        style={centerView === 'graph' ? { display: 'none' } : undefined}
        onDragOver={onDragOver}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
        onDrop={onDrop}
      >
        <div className="sheet-names" style={{ width: nameW }} onWheel={onNameWheel}>
          <div className={`sheet-names-header ${dropOn === -1 ? 'drop-on' : ''}`} style={{ height: RULER_H }} {...(groupMode === 'folders' ? dropZone(-1) : {})} title={groupMode === 'folders' ? 'Drop tracks here to take them out of their folder' : undefined}>
            <span style={{ flex: 1 }}>{dropOn === -1 ? 'Out of folders' : 'Tracks'}</span>
            {rows.some((r) => r.kind !== 'track') && (
              <button
                className="sheet-head-btn"
                onClick={() => {
                  const st = useStore.getState();
                  if (groupMode === 'folders') {
                    const anyOpen = st.groups.some((g) => g.expanded);
                    for (const g of st.groups) if (g.expanded === anyOpen) setFolderExpanded(g.id, !anyOpen);
                  } else {
                    const objs = rows.filter((r) => r.kind === 'obj').map((r) => (r as { oci: number }).oci);
                    const allClosed = objs.every((o) => st.collapsed.has(o));
                    useStore.setState({ collapsed: allClosed ? new Set() : new Set(objs) });
                  }
                }}
                title={groupMode === 'folders' ? 'Open or close every folder' : 'Open or close every object'}
              >
                <Icon name={(groupMode === 'folders' ? groups.some((g) => g.expanded) : rows.some((r) => r.kind === 'track')) ? 'collapseAll' : 'expandAll'} size={12} />
              </button>
            )}
            {window.studioEx?.openAudio && (
              <button className="sheet-add-audio" onClick={() => pickAudio(Math.round(liveTime() * 1000) / 1000)} title="Add a WAV at the playhead (or drop one onto the timeline where it should start)">
                + Audio
              </button>
            )}
          </div>
          {audioInfo.map((au, li) => {
            const listening = audioListen?.id === au.id;
            return (
              <div
                key={au.id}
                className="sheet-audio-row"
                style={{ top: RULER_H + li * AUDIO_H, height: AUDIO_H, ['--lane' as string]: `rgb(${laneRgb(li)})` }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, items: audioMenu(au.id, null) });
                }}
                title={`${audioName(au)}${au.name ? ` (${au.file})` : ''}\n${clipSpan(au).toFixed(2)} s, starts at ${au.offset.toFixed(2)} s\nDrag the clip to move it \u00b7 double-click it to listen from there \u00b7 right-click for more`}
              >
                <button className={`sheet-audio-btn ${listening ? 'on' : ''}`} onClick={() => listenAudio(listening ? null : au.id, au.trimIn)} title={listening ? 'Stop' : 'Listen \u2014 Studio plays this clip by itself'}>
                  {listening ? '\u25a0' : '\u25b6'}
                </button>
                <span className="name">{audioName(au)}</span>
                <button className={`sheet-audio-btn ${au.muted ? 'off' : ''}`} onClick={() => setAudio(au.id, { muted: !au.muted })} title={au.muted ? 'Unmute' : 'Mute while animating'}>
                  <Icon name={au.muted ? 'eyeOff' : 'eye'} size={13} />
                </button>
              </div>
            );
          })}
          <div style={{ position: 'absolute', inset: `${HEAD}px 0 0 0`, overflow: 'hidden' }}>
            {visibleRows.map(({ row, i }) => {
              const top = i * ROW_H - scrollY;
              if (row.kind === 'obj') {
                const isCollapsed = collapsed.has(row.oci);
                const isSel = studioSelection.includes(row.oci);
                return (
                  <div {...pressable}
                    key={row.key}
                    className={`sheet-row obj ${isSel ? 'selected' : ''}`}
                    style={{ top, height: ROW_H, paddingLeft: 4 }}
                    onClick={() => (row.oci >= 0 ? studioSelect([row.oci]) : toggleCollapsed(row.oci))}
                    onDoubleClick={() => toggleCollapsed(row.oci)}
                  >
                    <span
                      {...pressable}
                      aria-label="Open or close"
                      className="toggle"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapsed(row.oci);
                      }}
                    >
                      <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={12} />
                    </span>
                    <GroupEye tracks={row.tracks} />
                    <TypeIcon type={row.type} sex={row.sex} />
                    <span className="name">{row.label}</span>
                    <span className="count">{row.tracks.length}</span>
                  </div>
                );
              }
              if (row.kind === 'grp') {
                return (
                  <div {...pressable}
                    key={row.key}
                    className={`sheet-row obj folder ${dropOn === row.gid ? 'drop-on' : ''}`}
                    style={{ top, height: ROW_H, paddingLeft: 4 + row.depth * 14 }}
                    onClick={(e) => selectTracks(row.tracks.map((t) => t.id), e.ctrlKey ? 'add' : 'replace')}
                    onDoubleClick={() => setRenamingGroup(row.gid)}
                    onContextMenu={(e) => folderMenu(e, row)}
                    {...dropZone(row.gid)}
                    title="Timeline folder · click selects its tracks · double-click renames · drop tracks here to move them in"
                  >
                    <span
                      {...pressable}
                      aria-label="Open or close"
                      className="toggle"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFolderExpanded(row.gid, !row.expanded);
                      }}
                    >
                      <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={12} />
                    </span>
                    <GroupEye tracks={row.tracks} />
                    <span className="type-icon type-Folder">
                      <Icon name="folder" size={13} />
                    </span>
                    {renamingGroup === row.gid ? (
                      <input
                        className="input"
                        style={{ height: 20, flex: 1 }}
                        autoFocus
                        defaultValue={row.label}
                        onFocus={(e) => e.target.select()}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          setRenamingGroup(null);
                          const v = e.target.value.trim();
                          if (v && v !== row.label) renameFolder(row.gid, v);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') setRenamingGroup(null);
                          e.stopPropagation();
                        }}
                      />
                    ) : (
                      <span className="name">{row.label}</span>
                    )}
                    <span className="count">{row.tracks.length}</span>
                  </div>
                );
              }
              const tr = row.track;
              const isSel = selTracks.has(tr.id);
              const white = tr.color[0] > 0.98 && tr.color[1] > 0.98 && tr.color[2] > 0.98;
              const objName = row.showObject ? (tr.oci === -1 ? 'Scene' : displayName(nodes[tr.oci])) : '';
              return (
                <div {...pressable}
                  key={row.key}
                  className={`sheet-row ${isSel ? 'selected' : ''} ${tr.enabled ? '' : 'disabled'}`}
                  style={{ top, height: ROW_H, paddingLeft: 10 + (row.depth ?? 0) * 14 }}
                  draggable={groupMode === 'folders' && renaming !== tr.id}
                  onDragStart={(e) => {
                    // the selected tracks go together when this one is among them
                    const ids = selTracks.has(tr.id) ? [...selTracks] : [tr.id];
                    e.dataTransfer.setData('application/x-kf-tracks', JSON.stringify(ids));
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => setDropOn(null)}
                  onClick={(e) => onTrackClick(e, tr)}
                  onContextMenu={(e) => trackMenu(e, tr)}
                  onDoubleClick={() => setRenaming(tr.id)}
                  title={`${tr.name}${tr.nameEn ? `\n${tr.nameEn}` : ''}\n${tr.owner} · ${tr.model}\n${tr.keys.length} keys`}
                >
                  <span className="swatch" style={{ background: white ? 'transparent' : `rgb(${tr.color.map((c) => Math.round(c * 255)).join(',')})` }} />
                  <span
                    {...pressable}
                    aria-label={tr.enabled ? 'Mute track' : 'Unmute track'}
                    className="toggle"
                    title={tr.enabled ? 'Mute track' : 'Unmute track'}
                    onClick={(e) => {
                      e.stopPropagation();
                      setTrackProps(tr.id, { enabled: !tr.enabled });
                    }}
                  >
                    <Icon name={tr.enabled ? 'eye' : 'eyeOff'} size={13} />
                  </span>
                  {renaming === tr.id ? (
                    <input
                      className="input"
                      style={{ height: 20, flex: 1 }}
                      autoFocus
                      defaultValue={tr.alias || displayName({ name: tr.name, nameEn: tr.nameEn })}
                      onFocus={(e) => e.target.select()}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        setRenaming(null);
                        const v = e.target.value.trim();
                        const original = displayName({ name: tr.name, nameEn: tr.nameEn });
                        if (v !== (tr.alias || original)) setTrackProps(tr.id, { alias: v === original ? '' : v });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setRenaming(null);
                        e.stopPropagation();
                      }}
                    />
                  ) : (
                    <span className="name">
                      {objName && <span style={{ color: 'var(--text-3)' }}>{objName} › </span>}
                      {displayName(tr)}
                    </span>
                  )}
                  <span className="owner">{tr.owner}</span>
                </div>
              );
            })}
          </div>
          <div className="sheet-resizer" onPointerDown={startResize} />
        </div>
        <div className="sheet-canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              if (!hover.current) return;
              hover.current = null;
              canvasRef.current!.style.cursor = '';
              dirty.current = true;
            }}
            onLostPointerCapture={(e) => inter.current.mode !== 'none' && onPointerUp(e)}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
          />
          {rows.length === 0 && <EmptySheet hasTracks={totalTracks > 0} />}
          {maxScroll > 0 && (
            <VScrollbar contentH={contentH + ROW_H + HSCROLL_H} viewH={Math.max(0, viewH - HEAD - HSCROLL_H)} scrollY={scrollY} onScroll={(y) => setScrollY(clampScroll(y))} top={HEAD} />
          )}
          <TimeScrollbar
            pad={PAD}
            getView={() => ({ view: view.current, width: size.current.w })}
            setView={(v) => {
              autoView.current = false;
              view.current = v;
              dirty.current = true;
            }}
            duration={() => useStore.getState().tl?.duration ?? 10}
          />
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {prompt && <PromptDialog p={prompt} onClose={() => setPrompt(null)} />}
    </div>
  );
}

function EmptySheet({ hasTracks }: { hasTracks: boolean }) {
  const filter = useStore((s) => s.filter);
  return (
    <div className="empty" style={{ position: 'absolute', inset: `${headH() + 30}px 0 auto 0`, pointerEvents: 'none' }}>
      {hasTracks ? (
        <>
          <strong>No tracks for this selection</strong>
          {filter === 'selected' ? 'Select an animated object, or switch the filter to “All”.' : 'Nothing matches the search.'}
        </>
      ) : (
        <>
          <strong>No animation yet</strong>
          Select an object in the Scene list, then click <b>+ Track</b> above and pick a property to animate.
        </>
      )}
    </div>
  );
}

/** Zoom buttons for whichever view is showing (dope sheet or graph): same events as the + / − / F / Shift+F keys. */
function ZoomGroup() {
  const send = (detail?: string) => window.dispatchEvent(detail ? new CustomEvent('studioex:zoom', { detail }) : new CustomEvent('studioex:frame'));
  return (
    <div className="zoom-group" title="Zoom (Ctrl+wheel, or + / −)">
      <button className="btn" onClick={() => send('out')} title="Zoom out (−)">
        −
      </button>
      <button className="btn" onClick={() => send('in')} title="Zoom in (+)">
        +
      </button>
      <button className="btn" onClick={() => send()} title="Frame all keys, or the selected keys (F)">
        <Icon name="fit" size={13} />
      </button>
      <button className="btn" onClick={() => send('duration')} title="Show the whole timeline length (Shift+F)">
        <Icon name="follow" size={13} />
      </button>
    </div>
  );
}

function SheetToolbar({ shown, total, viewExtra }: { shown: number; total: number; viewExtra: React.ReactNode }) {
  const filter = useStore((s) => s.filter);
  const search = useStore((s) => s.search);
  const selCount = useStore((s) => s.selKeys.size);
  const centerView = useStore((s) => s.centerView);
  const groupMode = useStore((s) => s.groupMode);
  const setView = (v: 'dope' | 'graph') => {
    useStore.setState({ centerView: v });
    lsSet('studioex.view', v);
  };
  const setFilter = (f: 'selected' | 'all') => {
    useStore.setState({ filter: f });
    lsSet('studioex.filter', f);
  };
  const setGroup = (m: 'objects' | 'folders') => {
    useStore.setState({ groupMode: m });
    lsSet('studioex.groupMode', m);
  };
  const newFolder = async () => {
    const st = useStore.getState();
    // the selected tracks, else the tracks of the selected keys
    const ids = st.selTracks.size ? [...st.selTracks] : [...new Set([...st.selKeys].map((k) => parseKeyId(k).track))];
    const id = await createFolder('New folder', ids);
    if (id === undefined) return;
    setGroup('folders');
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('kf:rename-folder', { detail: id })));
  };
  return (
    <div className="sheet-toolbar">
      <Popover
        placement="down"
        width={320}
        openEvent="kf:add-track"
        trigger={(open, toggle) => (
          <button className={`btn ${open ? 'on' : 'solid'}`} onClick={toggle} title="Add an animation track for the selected object (or scene-wide)">
            <Icon name="plus" size={13} /> Track
          </button>
        )}
      >
        <div className="add-track-pop">
          <AddTrackPanel />
        </div>
      </Popover>
      <div className="seg" title="Tab switches views">
        <button className={centerView === 'dope' ? 'on' : ''} onClick={() => setView('dope')}>
          Dope Sheet
        </button>
        <button className={centerView === 'graph' ? 'on' : ''} onClick={() => setView('graph')}>
          Graph
        </button>
      </div>
      <div className="track-search">
        <Icon name="search" size={12} />
        <input
          id="track-search"
          className="input"
          placeholder="Search tracks…"
          title="Search track names, objects, folders and types (Ctrl+F) — several words narrow it down · Esc clears"
          value={search}
          onChange={(e) => useStore.setState({ search: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              useStore.setState({ search: '' });
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {search && (
          <button className="track-search-clear" onClick={() => useStore.setState({ search: '' })} title="Clear the search">
            ×
          </button>
        )}
      </div>
      <KindFilter />
      <div className="seg" title="Group the track list by object, or by your own folders (saved in the scene with Timeline)">
        <button className={groupMode === 'objects' ? 'on' : ''} onClick={() => setGroup('objects')}>
          Objects
        </button>
        <button className={groupMode === 'folders' ? 'on' : ''} onClick={() => setGroup('folders')}>
          Folders
        </button>
      </div>
      <button className="btn" onClick={newFolder} title="New folder from the selected tracks (Ctrl+G) — then drag more tracks onto it">
        <Icon name="folderPlus" size={14} /> Folder
      </button>
      {filter === 'selected' && (
        <button className="filter-chip" onClick={() => setFilter('all')} title="Showing only the tracks of objects selected in Studio — click to show all">
          Selected objects <span>×</span>
        </button>
      )}
      <span style={{ color: 'var(--text-3)' }}>
        {shown}/{total} tracks{selCount ? ` · ${selCount} key${selCount > 1 ? 's' : ''} selected` : ''}
      </span>
      <div className="spacer" />
      <ZoomGroup />
      <Popover
        align="right"
        placement="down"
        width={250}
        trigger={(open, toggle) => (
          <button className={`btn ${open ? 'on' : ''}`} onClick={toggle} title="Which tracks, grouping, row height">
            <Icon name="sliders" size={13} /> View
          </button>
        )}
      >
        <div style={{ display: 'grid', gap: 8, padding: 6 }}>
          <div className="menu-label" style={{ padding: 0 }}>
            Tracks of
          </div>
          <div className="seg">
            <button className={filter === 'selected' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setFilter('selected')} title="Only show tracks of objects selected in Studio">
              Selected
            </button>
            <button className={filter === 'all' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setFilter('all')} title="Show every animated object">
              All objects
            </button>
          </div>
          {centerView === 'dope' && viewExtra}
        </div>
      </Popover>
    </div>
  );
}

/** What's selected in Studio and what keying will hit, right above the tracks. */
function SelectionBar() {
  const sel = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  const tracks = useStore((s) => s.tracks);
  const selTracks = useStore((s) => s.selTracks.size);
  const pending = useStore((s) => s.pending);
  useStore((s) => s.showEnglish);
  const node = sel.length ? nodes[sel[0]] : undefined;
  const set = new Set(sel);
  const own = tracks.filter((t) => set.has(t.oci)).length;
  const keyHint = selTracks
    ? `K keys the ${selTracks} selected track${selTracks > 1 ? 's' : ''}`
    : pending
      ? `K keys the ${pending} change${pending > 1 ? 's' : ''} made in Studio`
      : 'K keys what you change in Studio';
  return (
    <div className="sel-bar">
      {node ? (
        <>
          <TypeIcon type={node.type} sex={node.sex} />
          <b>{displayName(node)}</b>
          {sel.length > 1 && <span className="kbd">+{sel.length - 1}</span>}
          <span className="sel-bar-sub">
            {own ? `${own} track${own > 1 ? 's' : ''}` : 'no tracks yet'}
          </span>
        </>
      ) : (
        <span className="sel-bar-sub">Nothing selected in Studio</span>
      )}
      <span style={{ flex: 1 }} />
      <span className="sel-bar-sub">{keyHint}</span>
      {node?.type === 'Char' && (
        <button
          className={`btn small ${own ? '' : 'primary'}`}
          onClick={() => keyWholePose()}
          title="Key the whole pose exactly as it is, at the playhead: place, every joint and target (tracks made where missing), and the face if set on Character › Posing. The way to set a character's first key. One undo step."
        >
          <Icon name="key" size={11} /> Key the whole pose
        </button>
      )}
      {node && own > 0 && (
        <button className="btn small" onClick={keyAllOfSelectedObjects} title="Key every track of the selected object at the playhead (Shift+K)">
          <Icon name="key" size={11} /> Key {sel.length > 1 ? 'objects' : 'object'}
        </button>
      )}
      {node && !own && node.type !== 'Char' && (
        <button className="btn small" onClick={() => window.dispatchEvent(new CustomEvent('kf:add-track'))} title="Pick a property of this object to animate">
          <Icon name="plus" size={11} /> Add a track
        </button>
      )}
    </div>
  );
}

/** Show only some kinds of track (bones, face, camera…); none ticked = all. */
function KindFilter() {
  const kinds = useStore((s) => s.trackKinds);
  const tracks = useStore((s) => s.tracks);
  const counts = new Map<TrackKind, number>();
  for (const t of tracks) counts.set(trackKind(t), (counts.get(trackKind(t)) ?? 0) + 1);
  const on = new Set(kinds);
  const toggle = (k: TrackKind) => setTrackKinds(on.has(k) ? kinds.filter((x) => x !== k) : [...kinds, k]);
  return (
    <Popover
      placement="down"
      width={220}
      trigger={(open, toggleOpen) => (
        <button className={`btn ${open || kinds.length ? 'on' : ''}`} onClick={toggleOpen} title="Show only some kinds of track: bones, face, camera, lights…">
          <Icon name="funnel" size={13} />
          {kinds.length ? <span className="badge">{kinds.length}</span> : null}
        </button>
      )}
    >
      <div className="layout-menu kind-filter">
        <div className="layout-menu-h">
          Show tracks of
          {kinds.length > 0 && (
            <button className="btn small solid" onClick={() => setTrackKinds([])}>
              Show all
            </button>
          )}
        </div>
        {TRACK_KINDS.map((k) => {
          const n = counts.get(k) ?? 0;
          return (
            <label key={k} className={n ? '' : 'kind-none'}>
              <input type="checkbox" checked={on.has(k)} onChange={() => toggle(k)} /> {k}
              <span className="sub">{n}</span>
            </label>
          );
        })}
        <small className="hint" style={{ margin: '4px 0 0' }}>Nothing ticked shows every kind. Tick one or more to narrow the list.</small>
      </div>
    </Popover>
  );
}

/** The eye on a folder or object row: mutes / unmutes every track in it (half-dimmed when only some are muted). */
function GroupEye({ tracks }: { tracks: WireTrack[] }) {
  const on = tracks.filter((t) => t.enabled).length;
  if (!tracks.length) return null;
  const all = on === tracks.length;
  const none = on === 0;
  const title = all ? `Mute all ${tracks.length} tracks` : none ? `Unmute all ${tracks.length} tracks` : `${tracks.length - on} of ${tracks.length} muted — click to unmute all`;
  return (
    <span
      {...pressable}
      aria-label={title}
      className={`toggle group-eye ${!all && !none ? 'mixed' : ''}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        void setTracksEnabled(tracks.map((t) => t.id), !all);
      }}
    >
      <Icon name={none ? 'eyeOff' : 'eye'} size={13} />
    </span>
  );
}

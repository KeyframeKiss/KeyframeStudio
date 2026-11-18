import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WireTrack } from '../bridge/types';
import { curveKind, PRESETS, toFlat } from '../lib/curve';
import { niceStep, snapToFrame } from '../lib/time';
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
  studioSelect,
  keyAllOfSelectedObjects,
  useStore,
  visibleTracks,
  type KeyId,
} from '../state/store';
import { Icon, TypeIcon } from './Icon';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { GraphEditor } from './GraphEditor';
import { TimeScrollbar, VScrollbar } from './Scrollbars';
import { Popover } from './Shell';
import { AddTrackPanel } from './AddTrackPanel';

const HSCROLL_H = 14;
import { createFolder, editTranslation, moveToFolder, renameFolder, setFolderExpanded, toast, ungroupFolder } from '../state/store';
import type { WireGroup } from '../bridge/types';

import { pressable } from '../lib/pressable';
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
  | { mode: 'box'; x0: number; y0: number; x1: number; y1: number; additive: boolean; toggle: boolean }
  | { mode: 'drag'; startX: number; grabT: number; dt: number; active: boolean; clickedId: KeyId; collapseOnClick: boolean };

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

export function DopeSheet() {
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
  const [renamingGroup, setRenamingGroup] = useState<number | null>(null);

  const [nameW, setNameW] = useState(() => Number(localStorage.getItem('studioex.nameW')) || 250);
  const [scrollY, setScrollY] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [viewH, setViewH] = useState(0); // mirrors size.current.h so the names column re-renders on resize

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const view = useRef<View>({ t0: 0, pps: 80 });
  const inter = useRef<Interaction>({ mode: 'none' });
  const dirty = useRef(true);
  // redraw when the audio track or its waveform changes
  const audioPeaks = useStore((s) => s.audioPeaks);
  const audioInfo = useStore((s) => s.audio);
  const shotsList = useStore((s) => s.shots);
  useEffect(() => {
    dirty.current = true;
  }, [audioPeaks, audioInfo, shotsList]);
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
  }, [tracks, nodes, filter, studioSelection, search, collapsed, showEnglish, groupMode, groups]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const contentH = rows.length * ROW_H;
  const maxScroll = Math.max(0, contentH - (viewH - RULER_H) + ROW_H);

  useEffect(() => {
    dirty.current = true;
  });

  const clampScroll = useCallback(
    (y: number) => Math.max(0, Math.min(Math.max(0, rowsRef.current.length * ROW_H - (size.current.h - RULER_H - HSCROLL_H) + ROW_H), y)),
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
  const rowIndexAt = (y: number) => Math.floor((y - RULER_H + scrollRef.current) / ROW_H);

  /** True until the user zooms/pans; while true the view auto-fits on resize. */
  const autoView = useRef(true);
  const frameAll = useCallback(() => {
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
    const w = Math.max(100, size.current.w - PAD * 2 - 20);
    view.current.pps = w / (hi - lo);
    view.current.t0 = lo;
    dirty.current = true;
  }, []);

  useEffect(() => {
    const onFrame = () => useStore.getState().centerView !== 'graph' && frameAll();
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
    const colors = {
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
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const st = useStore.getState();
      const playing = !!st.tl?.playing;
      if (!dirty.current && !playing && inter.current.mode === 'none') return;
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
      const first = Math.max(0, Math.floor(sy / ROW_H));
      const last = Math.min(rowsNow.length - 1, Math.ceil((sy + h - RULER_H) / ROW_H));
      const selKeys = st.selKeys;
      const selTr = st.selTracks;
      const drag = inter.current.mode === 'drag' && inter.current.active ? inter.current.dt : 0;

      // rows background
      for (let i = first; i <= last; i++) {
        const row = rowsNow[i];
        const y = RULER_H + i * ROW_H - sy;
        if (row.kind !== 'track') {
          ctx.fillStyle = colors.bg2;
          ctx.fillRect(0, y, w, ROW_H);
        } else if (selTr.has(row.track.id)) {
          ctx.fillStyle = 'rgba(90,169,255,0.10)';
          ctx.fillRect(0, y, w, ROW_H);
        }
        ctx.fillStyle = colors.lineSoft;
        ctx.fillRect(0, y + ROW_H - 1, w, 1);
      }

      // beyond-duration shade
      const xEnd = xOf(duration);
      if (xEnd < w) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(Math.max(0, xEnd), RULER_H, w - xEnd, h - RULER_H);
      }
      const xStart = xOf(0);
      if (xStart > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(0, RULER_H, xStart, h - RULER_H);
      }

      // grid
      const major = niceStep(v.pps, 72, fps);
      const minor = v.pps / fps >= 7 ? 1 / fps : major / 5;
      const tA = tOf(0);
      const tB = tOf(w);
      if (minor * v.pps >= 5) {
        ctx.fillStyle = 'rgba(255,255,255,0.025)';
        for (let t = Math.ceil(tA / minor) * minor, gi = 0; t <= tB && gi < 2000; t += minor, gi++) ctx.fillRect(Math.round(xOf(t)), RULER_H, 1, h - RULER_H);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
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
        ctx.fillStyle = selected ? colors.accent : dim ? colors.text3 : '#d9dce4';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = selected ? '#fff3dc' : 'rgba(0,0,0,0.55)';
        ctx.stroke();
      };

      // Only keys inside the visible time range are looked at (keys are sorted by time; selected keys may be
      // shifted by a drag, so the range is widened by it), and selection lookups (string keys) are skipped
      // entirely when nothing is selected — large scenes otherwise allocate per key per frame while playing.
      const anySel = selKeys.size > 0;
      const isSel = (id: number, t: number) => anySel && selKeys.has(keyId(id, t));
      const tLo = tOf(-10) - Math.abs(drag),
        tHi = tOf(w + 10) + Math.abs(drag);
      for (let i = first; i <= last; i++) {
        const row = rowsNow[i];
        const cy = RULER_H + i * ROW_H - sy + ROW_H / 2;
        if (row.kind === 'track') {
          const tr = row.track;
          const keys = tr.keys;
          const dim = !tr.enabled;
          if (!keys.length) continue;
          // one key either side of the window, so segment bars crossing the edges still draw
          const k0 = Math.max(0, firstKeyAtOrAfter(keys, tLo) - 1);
          const k1 = Math.min(keys.length - 1, firstKeyAtOrAfter(keys, tHi));
          // segment bars
          ctx.fillStyle = dim ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.09)';
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
            drawKey(x, cy, 5.5, curveKind(key[1]), sel, dim);
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
            drawKey(x, cy, 4.5, 'linear', sels[k], !sels[k]);
          }
        }
      }

      // ruler
      ctx.fillStyle = colors.bg1;
      ctx.fillRect(0, 0, w, RULER_H);
      // shots: a thin coloured strip per shot along the top of the ruler (names are in the Shots tab)
      st.shots.forEach((sh, i) => {
        const x0 = Math.max(PAD, xOf(sh.start)),
          x1 = Math.min(w, xOf(sh.end));
        if (x1 <= x0) return;
        ctx.fillStyle = i % 2 ? 'rgba(255,159,46,0.75)' : 'rgba(139,123,255,0.8)';
        ctx.fillRect(x0 + 1, 0, Math.max(1, x1 - x0 - 2), 3);
      });
      // the audio track's waveform, behind the tick labels (aligned with the keys)
      const au = st.audio,
        wave = st.audioPeaks;
      if (au && wave && wave.peaks.length) {
        ctx.fillStyle = 'rgba(90,169,255,0.32)';
        const ps = wave.perSecond,
          pk = wave.peaks,
          hMax = RULER_H - 3;
        for (let x = Math.max(PAD, Math.floor(xOf(au.offset))); x < Math.min(w, xOf(au.offset + au.duration)); x++) {
          const i0 = Math.max(0, Math.floor((tOf(x) - au.offset) * ps)),
            i1 = Math.min(pk.length - 1, Math.floor((tOf(x + 1) - au.offset) * ps));
          let p = 0;
          for (let i = i0; i <= i1; i++) if (pk[i] > p) p = pk[i];
          if (p <= 0.004) continue;
          const bh = Math.max(1, p * hMax);
          ctx.fillRect(x, RULER_H - 1 - bh, 1, bh);
        }
      }
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

      // playhead
      const px = Math.round(xOf(now));
      if (px >= -10 && px <= w + 10) {
        ctx.fillStyle = colors.playhead;
        ctx.fillRect(px, RULER_H - 2, 1.5, h - RULER_H + 2);
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
        const x = Math.min(it.x0, it.x1);
        const y = Math.min(it.y0, it.y1);
        ctx.fillStyle = 'rgba(90,169,255,0.12)';
        ctx.strokeStyle = colors.accent2;
        ctx.fillRect(x, y, Math.abs(it.x1 - it.x0), Math.abs(it.y1 - it.y0));
        ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(it.x1 - it.x0), Math.abs(it.y1 - it.y0));
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
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------- hit testing ----------------
  const keysAt = (x: number, y: number): KeyId[] => {
    const idx = rowIndexAt(y);
    const row = rowsRef.current[idx];
    if (!row || y < RULER_H) return [];
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

  const keysInBox = (x0: number, y0: number, x1: number, y1: number): KeyId[] => {
    const [xa, xb] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ya, yb] = [Math.min(y0, y1), Math.max(y0, y1)];
    const ids: KeyId[] = [];
    rowsRef.current.forEach((row, i) => {
      const cy = RULER_H + i * ROW_H - scrollRef.current + ROW_H / 2;
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

  const snapT = (t: number, e: { altKey: boolean }) => {
    const st = useStore.getState();
    return st.snap && !e.altKey && st.tl ? snapToFrame(t, st.tl.fps) : t;
  };

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
      inter.current = { mode: 'scrub' };
      seek(snapT(tOf(x), e));
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
      inter.current = { mode: 'box', x0: x, y0: y, x1: x, y1: y, additive: e.shiftKey, toggle: e.ctrlKey };
    }
    dirty.current = true;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const it = inter.current;
    if (it.mode === 'none') return;
    if (e.buttons === 0) return onPointerUp(e); // button released somewhere we didn't hear about
    const r = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (it.mode === 'scrub') seek(snapT(tOf(x), e));
    else if (it.mode === 'pan') view.current.t0 = it.startT0 - (x - it.startX) / view.current.pps;
    else if (it.mode === 'box') {
      it.x1 = x;
      it.y1 = y;
    } else if (it.mode === 'drag') {
      if (!it.active && Math.abs(x - it.startX) > 3) it.active = true;
      if (it.active) {
        let dt = (x - it.startX) / view.current.pps;
        dt = snapT(it.grabT + dt, e) - it.grabT;
        const sel = useStore.getState().selKeys;
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
    try {
      canvasRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (it.mode === 'drag') {
      if (it.active && Math.abs(it.dt) > 1e-6) moveSelectedKeys(it.dt);
      else if (!it.active && it.collapseOnClick) {
        const r = canvasRef.current!.getBoundingClientRect();
        selectKeys(keysAt(e.clientX - r.left, e.clientY - r.top));
      }
    } else if (it.mode === 'box') {
      const small = Math.abs(it.x1 - it.x0) < 3 && Math.abs(it.y1 - it.y0) < 3;
      if (small) {
        if (!it.additive && !it.toggle) selectKeys([]);
        const row = rowsRef.current[rowIndexAt(it.y0)];
        if (row?.kind === 'track') selectTracks([row.track.id], it.toggle ? 'toggle' : it.additive ? 'add' : 'replace');
      } else {
        selectKeys(keysInBox(it.x0, it.y0, it.x1, it.y1), it.toggle ? 'toggle' : it.additive ? 'add' : 'replace');
      }
    }
    dirty.current = true;
  };

  const onDoubleClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (y < RULER_H) return;
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
    <div className="center">
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
      <SelectionBar />
      {centerView === 'graph' && <GraphEditor />}
      <div className="sheet" style={centerView === 'graph' ? { display: 'none' } : undefined}>
        <div className="sheet-names" style={{ width: nameW }} onWheel={onNameWheel}>
          <div className="sheet-names-header" style={{ height: RULER_H }}>
            Tracks
          </div>
          <div style={{ position: 'absolute', inset: `${RULER_H}px 0 0 0`, overflow: 'hidden' }}>
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
                      className="toggle"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapsed(row.oci);
                      }}
                    >
                      <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={12} />
                    </span>
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
                    className="sheet-row obj"
                    style={{ top, height: ROW_H, paddingLeft: 4 + row.depth * 14 }}
                    onClick={(e) => selectTracks(row.tracks.map((t) => t.id), e.ctrlKey ? 'add' : 'replace')}
                    onDoubleClick={() => setRenamingGroup(row.gid)}
                    onContextMenu={(e) => folderMenu(e, row)}
                    title="Timeline folder · click selects its tracks · double-click renames"
                  >
                    <span
                      className="toggle"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFolderExpanded(row.gid, !row.expanded);
                      }}
                    >
                      <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={12} />
                    </span>
                    <span className="type-icon type-Folder">▤</span>
                    {renamingGroup === row.gid ? (
                      <input
                        className="input"
                        style={{ height: 20, flex: 1 }}
                        autoFocus
                        defaultValue={row.label}
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
                  onClick={(e) => onTrackClick(e, tr)}
                  onContextMenu={(e) => trackMenu(e, tr)}
                  onDoubleClick={() => setRenaming(tr.id)}
                  title={`${tr.name}${tr.nameEn ? `\n${tr.nameEn}` : ''}\n${tr.owner} · ${tr.model}\n${tr.keys.length} keys`}
                >
                  <span className="swatch" style={{ background: white ? 'transparent' : `rgb(${tr.color.map((c) => Math.round(c * 255)).join(',')})` }} />
                  <span
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
            onLostPointerCapture={(e) => inter.current.mode !== 'none' && onPointerUp(e)}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
          />
          {rows.length === 0 && <EmptySheet hasTracks={totalTracks > 0} />}
          {maxScroll > 0 && (
            <VScrollbar contentH={contentH + ROW_H + HSCROLL_H} viewH={Math.max(0, viewH - RULER_H - HSCROLL_H)} scrollY={scrollY} onScroll={(y) => setScrollY(clampScroll(y))} top={RULER_H} />
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
    </div>
  );
}

function EmptySheet({ hasTracks }: { hasTracks: boolean }) {
  const filter = useStore((s) => s.filter);
  return (
    <div className="empty" style={{ position: 'absolute', inset: `${RULER_H + 30}px 0 auto 0`, pointerEvents: 'none' }}>
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
      <input className="input" style={{ width: 150 }} placeholder="Search tracks…" value={search} onChange={(e) => useStore.setState({ search: e.target.value })} />
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
          <div className="menu-label" style={{ padding: 0 }}>
            Group by
          </div>
          <div className="seg" title="Group tracks by object, or by Timeline's own folders">
            <button className={groupMode === 'objects' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setGroup('objects')}>
              Objects
            </button>
            <button className={groupMode === 'folders' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setGroup('folders')}>
              Folders
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
      {node && own > 0 && (
        <button className="btn small" onClick={keyAllOfSelectedObjects} title="Key every track of the selected object at the playhead (Shift+K)">
          <Icon name="key" size={11} /> Key {sel.length > 1 ? 'objects' : 'object'}
        </button>
      )}
      {node && !own && (
        <button className="btn small" onClick={() => window.dispatchEvent(new CustomEvent('kf:add-track'))} title="Pick a property of this object to animate">
          <Icon name="plus" size={11} /> Add a track
        </button>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WireTrack } from '../bridge/types';
import { evaluate, fromFlat } from '../lib/curve';
import { eulerFromQuat, quatFromEuler, slerp, unwrap, type Euler, type Quat } from '../lib/rotation';
import { niceStep, snapToFrame } from '../lib/time';
import {
  call,
  displayName,
  keyId,
  keyTracks,
  liveTime,
  moveSelectedKeys,
  refreshTimeline,
  seek,
  seekNow,
  selectKeys,
  targetTracks,
  workingShot,
  useStore,
  visibleTracks,
} from '../state/store';
import { TimeScrollbar } from './Scrollbars';

import { pressable } from '../lib/pressable';
import { perfRecord } from '../lib/perf';
const RULER_H = 28;
const PAD_L = 54; // value labels
const HIT = 7;
const AXIS_COLORS = ['#ff6b6b', '#5ee08a', '#5aa9ff', '#f5d76e'];
const PALETTE = ['#ff9f2e', '#c792ea', '#5ad8e6', '#ff7ab6', '#9ccc65', '#ffd54f', '#80cbc4', '#f48fb1'];

type RawKey = { t: number; attrs: Record<string, number>; curve?: number[] };

interface Channel {
  id: string;
  track: WireTrack;
  comp: string; // attribute name, or 'rx' | 'ry' | 'rz'
  label: string;
  color: string;
  axis?: 0 | 1 | 2;
  keys: { t: number; v: number }[];
  poly: number[]; // flattened [t, v, t, v, ...] sampled curve
  min: number;
  max: number;
}

interface TrackData {
  track: WireTrack;
  keys: RawKey[];
  quats?: Quat[];
  eulers?: Euler[];
}

const isQuat = (a: Record<string, number>) => 'valueX' in a && 'valueY' in a && 'valueZ' in a && 'valueW' in a;

function buildChannels(data: TrackData[]): Channel[] {
  const out: Channel[] = [];
  let pi = 0;
  for (const td of data) {
    const { track, keys } = td;
    if (!keys.length) continue;
    const curves = keys.map((k) => fromFlat(k.curve));
    if (isQuat(keys[0].attrs)) {
      const quats = keys.map((k) => [k.attrs.valueX, k.attrs.valueY, k.attrs.valueZ, k.attrs.valueW] as Quat);
      const eulers: Euler[] = [];
      quats.forEach((q, i) => eulers.push(i ? unwrap(eulerFromQuat(q), eulers[i - 1]) : eulerFromQuat(q)));
      td.quats = quats;
      td.eulers = eulers;
      // sample the slerp path once for all three axes
      const samples: { t: number; e: Euler }[] = [{ t: keys[0].t, e: eulers[0] }];
      for (let i = 0; i < keys.length - 1; i++) {
        const n = 24;
        for (let s = 1; s <= n; s++) {
          const f = evaluate(curves[i], s / n);
          const e = unwrap(eulerFromQuat(slerp(quats[i], quats[i + 1], f)), samples[samples.length - 1].e);
          samples.push({ t: keys[i].t + ((keys[i + 1].t - keys[i].t) * s) / n, e });
        }
      }
      (['X', 'Y', 'Z'] as const).forEach((ax, axis) => {
        const vals = samples.map((s) => s.e[axis]);
        out.push({
          id: `${track.id}:r${ax}`,
          track,
          comp: `r${ax.toLowerCase()}`,
          label: `Rot ${ax}°`,
          color: AXIS_COLORS[axis],
          axis: axis as 0 | 1 | 2,
          keys: keys.map((k, i) => ({ t: k.t, v: eulers[i][axis] })),
          poly: samples.flatMap((s) => [s.t, s.e[axis]]),
          min: arrMin(vals),
          max: arrMax(vals),
        });
      });
      continue;
    }
    const comps = Object.keys(keys[0].attrs);
    comps.forEach((comp, ci) => {
      const ks = keys.map((k) => ({ t: k.t, v: k.attrs[comp] ?? 0 }));
      const poly: number[] = [ks[0].t, ks[0].v];
      for (let i = 0; i < ks.length - 1; i++) {
        const n = 24;
        for (let s = 1; s <= n; s++) {
          const f = evaluate(curves[i], s / n);
          poly.push(ks[i].t + ((ks[i + 1].t - ks[i].t) * s) / n, ks[i].v + (ks[i + 1].v - ks[i].v) * f);
        }
      }
      const vals = poly.filter((_, i) => i % 2 === 1);
      const axisMatch = /([XYZW])$/.exec(comp);
      out.push({
        id: `${track.id}:${comp}`,
        track,
        comp,
        label: comp.replace(/^value/, '') || 'value',
        color: axisMatch && comps.length > 1 ? AXIS_COLORS['XYZW'.indexOf(axisMatch[1])] : PALETTE[(pi + ci) % PALETTE.length],
        keys: ks,
        poly,
        min: arrMin(vals),
        max: arrMax(vals),
      });
    });
    pi++;
  }
  return out;
}

/** Selected key times per track, built once per selection (the draw loop asks for every key, every frame). */
let selCache: { sel: Set<string> | null; map: Map<number, number[]> } = { sel: null, map: new Map() };
function selectionByTrack(sel: Set<string>) {
  if (selCache.sel === sel) return selCache.map;
  const map = new Map<number, number[]>();
  for (const id of sel) {
    const i = id.indexOf('|');
    const track = Number(id.slice(0, i));
    const t = Number(id.slice(i + 1));
    const a = map.get(track);
    if (a) a.push(t);
    else map.set(track, [t]);
  }
  for (const a of map.values()) a.sort((x, y) => x - y);
  selCache = { sel, map };
  return map;
}
/** Is t (within float noise) in the sorted list? */
function hasTime(sorted: number[], t: number) {
  let lo = 0,
    hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t - 1e-6) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && Math.abs(sorted[lo] - t) < 1e-6;
}

function arrMin(a: number[]) {
  let m = Infinity;
  for (const v of a) if (v < m) m = v;
  return m;
}
function arrMax(a: number[]) {
  let m = -Infinity;
  for (const v of a) if (v > m) m = v;
  return m;
}

type Interaction =
  | { mode: 'none' }
  | { mode: 'scrub' }
  | { mode: 'pan'; x: number; y: number; t0: number; yMin: number; yMax: number }
  | { mode: 'drag'; ch: Channel; keyIndex: number; x: number; y: number; axis: 'none' | 'time' | 'value'; dt: number; dv: number };

export function GraphEditor() {
  const shot = useStore(workingShot);
  const full = useStore((s) => s.frameFullTimeline);
  const tracks = useStore((s) => s.tracks);
  const selKeys = useStore((s) => s.selKeys);
  const selTracks = useStore((s) => s.selTracks);
  const studioSelection = useStore((s) => s.studioSelection);
  const revision = useStore((s) => s.revision);
  useStore((s) => s.showEnglish);

  const [data, setData] = useState<TrackData[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [normalize, setNormalize] = useState(false);

  // Which tracks to graph: what the user targeted, else the selected objects' tracks.
  const filterMode = useStore((s) => s.filter);
  const search = useStore((s) => s.search);
  const lastShown = useRef<number[]>([]);
  const shownTracks = useMemo(() => {
    let ids = [...selTracks];
    if (!ids.length) {
      // Keys picked on curves that are already graphed keep the current set (no re-zoom mid-edit).
      const fromKeys = targetTracks();
      ids = fromKeys.length && !fromKeys.every((id) => lastShown.current.includes(id)) ? fromKeys : [];
      if (!ids.length && selKeys.size) ids = lastShown.current;
    }
    let list = tracks.filter((t) => ids.includes(t.id));
    if (!list.length) list = visibleTracks().slice(0, 8);
    lastShown.current = list.map((t) => t.id);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, selKeys, selTracks, studioSelection, filterMode, search]);
  const idsKey = shownTracks.map((t) => t.id).join(',');

  useEffect(() => {
    if (!shownTracks.length) {
      setData([]);
      return;
    }
    let alive = true;
    call<Record<string, [number, Record<string, number>][]>>('timeline.keyValues', { tracks: shownTracks.map((t) => t.id) }).then((r) => {
      if (!alive || !r) return;
      setData(
        shownTracks.map((track) => ({
          track,
          keys: (r[String(track.id)] ?? []).map(([t, attrs]) => ({ t, attrs, curve: track.keys.find((k) => Math.abs(k[0] - t) < 1e-4)?.[1] })),
        })),
      );
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, revision]);

  const channels = useMemo(() => buildChannels(data), [data]);
  const visible = channels.filter((c) => !hidden.has(c.id));

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const view = useRef({ t0: 0, pps: 80, yMin: -1, yMax: 1 });
  const inter = useRef<Interaction>({ mode: 'none' });
  const dirty = useRef(true);
  const state = useRef({ visible, normalize, data });
  state.current = { visible, normalize, data };

  useEffect(() => {
    dirty.current = true;
  });

  const norm = (c: Channel, v: number) => (state.current.normalize ? (c.max - c.min > 1e-9 ? (v - c.min) / (c.max - c.min) : 0.5) : v);
  const X = (t: number) => PAD_L + (t - view.current.t0) * view.current.pps;
  const T = (x: number) => view.current.t0 + (x - PAD_L) / view.current.pps;
  const Y = (v: number) => {
    const { yMin, yMax } = view.current;
    const h = size.current.h - RULER_H - 16;
    return RULER_H + 8 + (1 - (v - yMin) / (yMax - yMin)) * h;
  };
  const V = (y: number) => {
    const { yMin, yMax } = view.current;
    const h = size.current.h - RULER_H - 16;
    return yMin + (1 - (y - RULER_H - 8) / h) * (yMax - yMin);
  };

  const frame = useCallback((automatic = true) => {
    const { visible: vis } = state.current;
    const dur = useStore.getState().tl?.duration ?? 10;
    let tLo = Infinity, tHi = -Infinity, vLo = Infinity, vHi = -Infinity;
    for (const c of vis) {
      for (const k of c.keys) {
        tLo = Math.min(tLo, k.t);
        tHi = Math.max(tHi, k.t);
      }
      vLo = Math.min(vLo, norm(c, c.min));
      vHi = Math.max(vHi, norm(c, c.max));
    }
    if (!Number.isFinite(tLo) || tHi - tLo < 0.05) {
      tLo = 0;
      tHi = dur;
    }
    if (automatic && full) { tLo = 0; tHi = Math.max(0.5, dur); }
    if (shot) { tLo = shot.start; tHi = shot.end; }
    if (!Number.isFinite(vLo)) {
      vLo = -1;
      vHi = 1;
    }
    if (vHi - vLo < 1e-6) {
      vLo -= 0.5;
      vHi += 0.5;
    }
    const pad = (vHi - vLo) * 0.12;
    const w = Math.max(100, size.current.w - PAD_L - 30);
    view.current = { t0: tLo - 6 / (w / (tHi - tLo)), pps: w / (tHi - tLo), yMin: vLo - pad, yMax: vHi + pad };
    dirty.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot?.id, shot?.start, shot?.end, full]);

  // auto-frame when the set of channels changes
  const channelSig = visible.map((c) => c.id).join('|') + normalize;
  useEffect(() => {
    if (size.current.w > 0) frame();
  }, [channelSig, frame]);

  useEffect(() => {
    const onFrame = () => frame(false);
    window.addEventListener('studioex:frame', onFrame);
    return () => window.removeEventListener('studioex:frame', onFrame);
  }, [frame]);

  // + / − (keys and toolbar): zoom time around the playhead when it's on screen (else the centre) and values
  // around the middle of the view. Shift+F: the whole timeline length, values kept.
  useEffect(() => {
    const onZoom = (e: Event) => {
      const d = (e as CustomEvent<string>).detail;
      const v = view.current;
      const w = size.current.w;
      if (d === 'duration') {
        const dur = Math.max(0.5, useStore.getState().tl?.duration ?? 10);
        v.pps = Math.max(2, (w - PAD_L - 30) / dur);
        v.t0 = -6 / v.pps;
      } else if (d === 'in' || d === 'out') {
        const f = d === 'in' ? 1.25 : 0.8;
        const px = X(liveTime());
        const ax = px >= PAD_L && px <= w ? px : PAD_L + (w - PAD_L) / 2;
        const tAt = T(ax);
        v.pps = Math.max(2, Math.min(4000, v.pps * f));
        v.t0 = tAt - (ax - PAD_L) / v.pps;
        const mid = (v.yMin + v.yMax) / 2,
          half = (v.yMax - v.yMin) / 2 / f;
        v.yMin = mid - half;
        v.yMax = mid + half;
      } else return;
      dirty.current = true;
    };
    window.addEventListener('studioex:zoom', onZoom);
    return () => window.removeEventListener('studioex:zoom', onZoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      size.current = { w: r.width, h: r.height };
      const c = canvasRef.current!;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
      frame();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [frame]);

  // ---------------- draw ----------------
  useEffect(() => {
    let raf = 0;
    let lastPlayDraw = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const st = useStore.getState();
      if (!dirty.current && !st.tl?.playing && inter.current.mode === 'none') return;
      // While playing only the playhead moves: redraw at ~20 fps instead of every frame (big graphs are costly).
      const now = performance.now();
      if (!dirty.current && inter.current.mode === 'none' && now - lastPlayDraw < 50) return;
      lastPlayDraw = now;
      dirty.current = false;
      const perfT0 = performance.now();
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext('2d')!;
      const dpr = window.devicePixelRatio || 1;
      const { w, h } = size.current;
      const v = view.current;
      const fps = st.tl?.fps ?? 60;
      const dur = st.tl?.duration ?? 10;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#111216';
      ctx.fillRect(0, 0, w, h);

      // duration shading
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      if (X(dur) < w) ctx.fillRect(Math.max(PAD_L, X(dur)), RULER_H, w, h);
      if (X(0) > PAD_L) ctx.fillRect(PAD_L, RULER_H, X(0) - PAD_L, h);

      // value grid
      if (!(v.yMax - v.yMin > 1e-9) || !Number.isFinite(v.yMax - v.yMin)) {
        v.yMin = -1;
        v.yMax = 1;
      }
      const vRange = v.yMax - v.yMin;
      const rawStep = vRange / Math.max(2, (h - RULER_H) / 46);
      const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
      const vStep = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) ?? rawStep;
      ctx.font = '10px Segoe UI, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (let val = Math.ceil(v.yMin / vStep) * vStep, n = 0; val <= v.yMax && n < 200; val += vStep, n++) {
        const y = Math.round(Y(val));
        ctx.fillStyle = Math.abs(val) < vStep / 2 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.05)';
        ctx.fillRect(PAD_L, y, w - PAD_L, 1);
        ctx.fillStyle = '#7d828f';
        const label = Math.abs(vStep) >= 1 ? val.toFixed(0) : val.toFixed(Math.min(4, Math.max(1, -Math.floor(Math.log10(vStep)))));
        ctx.fillText(label, 6, y);
      }
      // time grid
      const major = niceStep(v.pps, 72, fps);
      for (let t = Math.ceil(T(PAD_L) / major) * major, gi = 0; t <= T(w) && gi < 2000; t += major, gi++) {
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(Math.round(X(t)), RULER_H, 1, h);
      }

      const it = inter.current;
      const drag = it.mode === 'drag' ? it : null;
      // Large graphs (hundreds of curves, thousands of keys): only the visible time range, curve points at least
      // a pixel apart, and each channel's keys as two batched paths (plain + selected), not one draw per key.
      const selByTrack = selectionByTrack(st.selKeys);
      const tVisLo = T(PAD_L) - (drag?.axis === 'time' ? Math.abs(drag.dt) : 0) - 1 / v.pps,
        tVisHi = T(w) + (drag?.axis === 'time' ? Math.abs(drag.dt) : 0) + 1 / v.pps;
      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD_L, RULER_H, w - PAD_L, h - RULER_H);
      ctx.clip();
      for (const ch of state.current.visible) {
        // curve: from the last point before the view to the first after it
        const poly = ch.poly;
        const n = poly.length / 2;
        let lo = 0,
          hi = n;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (poly[mid * 2] < tVisLo) lo = mid + 1;
          else hi = mid;
        }
        const start = Math.max(0, lo - 1);
        ctx.beginPath();
        let lx = NaN,
          ly = NaN;
        for (let i = start; i < n; i++) {
          const x = X(poly[i * 2]);
          const y = Y(norm(ch, poly[i * 2 + 1]));
          const last = i === n - 1 || poly[i * 2] > tVisHi;
          if (i === start) ctx.moveTo(x, y);
          else if (last || Math.abs(x - lx) >= 1 || Math.abs(y - ly) >= 1) ctx.lineTo(x, y);
          else continue;
          lx = x;
          ly = y;
          if (poly[i * 2] > tVisHi) break;
        }
        ctx.strokeStyle = ch.color;
        ctx.globalAlpha = ch.track.enabled ? 0.95 : 0.35;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.globalAlpha = 1;
        // keys
        const selT = selByTrack.get(ch.track.id);
        const plain = new Path2D(),
          picked = new Path2D();
        let anyPicked = false;
        const dense = ch.keys.length > 1 && (ch.keys[ch.keys.length - 1].t - ch.keys[0].t) * v.pps < ch.keys.length * 6; // keys < 6 px apart
        const r = dense ? 2.5 : 4;
        for (let i = 0; i < ch.keys.length; i++) {
          const k = ch.keys[i];
          const sel = !!selT && hasTime(selT, k.t);
          let t = k.t;
          if (drag && sel && drag.axis === 'time') t += drag.dt;
          if (t < tVisLo || t > tVisHi) continue;
          let val = norm(ch, k.v);
          if (drag && drag.ch.id === ch.id && drag.keyIndex === i && drag.axis === 'value') val += drag.dv;
          const x = X(t);
          const y = Y(val);
          const p = sel ? picked : plain;
          p.moveTo(x + (sel ? r + 1 : r), y);
          p.arc(x, y, sel ? r + 1 : r, 0, Math.PI * 2);
          if (sel) anyPicked = true;
        }
        ctx.lineWidth = 1.5;
        ctx.fillStyle = '#111216';
        ctx.fill(plain);
        ctx.strokeStyle = ch.color;
        ctx.stroke(plain);
        if (anyPicked) {
          ctx.fillStyle = '#ff9f2e';
          ctx.fill(picked);
          ctx.strokeStyle = '#fff3dc';
          ctx.stroke(picked);
        }
      }
      ctx.restore();

      // ruler
      ctx.fillStyle = '#17181d';
      ctx.fillRect(0, 0, w, RULER_H);
      ctx.fillStyle = '#2b2e37';
      ctx.fillRect(0, RULER_H - 1, w, 1);
      ctx.textBaseline = 'top';
      for (let t = Math.ceil(T(PAD_L) / major) * major, gi = 0; t <= T(w) && gi < 2000; t += major, gi++) {
        const x = Math.round(X(t));
        ctx.fillStyle = '#575b66';
        ctx.fillRect(x, RULER_H - 9, 1, 8);
        ctx.fillStyle = '#7d828f';
        ctx.fillText(major < 1 ? `${t.toFixed(2)}s` : `${Math.round(t)}s`, x + 3, 6);
      }
      ctx.fillStyle = '#17181d';
      ctx.fillRect(0, 0, PAD_L, RULER_H);
      if (state.current.normalize) {
        ctx.fillStyle = '#ff9f2e';
        ctx.fillText('NORM', 8, 8);
      }

      // playhead
      const px = Math.round(X(liveTime()));
      if (px >= PAD_L) {
        ctx.fillStyle = '#ff4d6a';
        ctx.fillRect(px, RULER_H - 2, 1.5, h);
        ctx.beginPath();
        ctx.roundRect(px - 14, 4, 28, 16, 4);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.font = '600 10px Segoe UI, system-ui, sans-serif';
        const label = String(Math.round(liveTime() * fps));
        ctx.fillText(label, px - ctx.measureText(label).width / 2, 12);
      }
      if (drag && drag.axis !== 'none') {
        ctx.fillStyle = '#ff9f2e';
        ctx.font = '600 11px Segoe UI, system-ui, sans-serif';
        ctx.textBaseline = 'bottom';
        const txt = drag.axis === 'time' ? `Δt ${drag.dt >= 0 ? '+' : ''}${drag.dt.toFixed(3)}s` : `Δ ${drag.dv >= 0 ? '+' : ''}${drag.dv.toFixed(4)}${state.current.normalize ? ' (normalized)' : ''}`;
        ctx.fillText(txt, PAD_L + 6, h - 6);
      }
      perfRecord('graphDraw', performance.now() - perfT0);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------- interaction ----------------
  const hitKey = (x: number, y: number) => {
    let best: { ch: Channel; i: number; d: number } | null = null;
    for (const ch of state.current.visible)
      ch.keys.forEach((k, i) => {
        const d = Math.hypot(X(k.t) - x, Y(norm(ch, k.v)) - y);
        if (d <= HIT && (!best || d < best.d)) best = { ch, i, d };
      });
    return best as { ch: Channel; i: number; d: number } | null;
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    canvasRef.current!.setPointerCapture(e.pointerId);
    const v = view.current;
    if (e.button === 1) {
      inter.current = { mode: 'pan', x, y, t0: v.t0, yMin: v.yMin, yMax: v.yMax };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (y < RULER_H) {
      inter.current = { mode: 'scrub' };
      seek(Math.max(0, T(x)));
      return;
    }
    const hit = hitKey(x, y);
    if (hit) {
      const id = keyId(hit.ch.track.id, hit.ch.keys[hit.i].t);
      if (e.ctrlKey) selectKeys([id], 'toggle');
      else if (e.shiftKey) selectKeys([id], 'add');
      else if (!useStore.getState().selKeys.has(id)) selectKeys([id]);
      inter.current = { mode: 'drag', ch: hit.ch, keyIndex: hit.i, x, y, axis: 'none', dt: 0, dv: 0 };
    } else {
      if (!e.shiftKey && !e.ctrlKey) selectKeys([]);
      inter.current = { mode: 'pan', x, y, t0: v.t0, yMin: v.yMin, yMax: v.yMax };
    }
    dirty.current = true;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const it = inter.current;
    if (it.mode === 'none') return;
    if (e.buttons === 0) return void onPointerUp(); // button released somewhere we didn't hear about
    const { x, y } = local(e);
    const v = view.current;
    if (it.mode === 'scrub') seek(Math.max(0, T(x)));
    else if (it.mode === 'pan') {
      v.t0 = it.t0 - (x - it.x) / v.pps;
      const dv = ((y - it.y) / (size.current.h - RULER_H - 16)) * (it.yMax - it.yMin);
      v.yMin = it.yMin + dv;
      v.yMax = it.yMax + dv;
    } else if (it.mode === 'drag') {
      if (it.axis === 'none' && Math.hypot(x - it.x, y - it.y) > 4) it.axis = Math.abs(x - it.x) > Math.abs(y - it.y) ? 'time' : 'value';
      if (it.axis === 'time') {
        const st = useStore.getState();
        const t0 = it.ch.keys[it.keyIndex].t;
        let target = t0 + (x - it.x) / v.pps;
        if (st.snap && !e.altKey && st.tl) target = snapToFrame(target, st.tl.fps);
        it.dt = Math.max(-t0, target - t0);
      } else if (it.axis === 'value') {
        let dv = V(y) - V(it.y);
        if (e.shiftKey) dv = Math.round(dv * 10) / 10;
        it.dv = dv;
      }
    }
    dirty.current = true;
  };

  const onPointerUp = async () => {
    const it = inter.current;
    inter.current = { mode: 'none' };
    dirty.current = true;
    if (it.mode !== 'drag') return;
    if (it.axis === 'time' && Math.abs(it.dt) > 1e-6) {
      moveSelectedKeys(it.dt);
    } else if (it.axis === 'value' && Math.abs(it.dv) > 1e-9) {
      const ch = it.ch;
      const k = ch.keys[it.keyIndex];
      const dvReal = state.current.normalize ? it.dv * (ch.max - ch.min || 1) : it.dv;
      let value: Record<string, number>;
      if (ch.axis !== undefined) {
        const td = state.current.data.find((d) => d.track.id === ch.track.id);
        const cur = td?.eulers?.[it.keyIndex];
        if (!cur) return; // track/keys changed while dragging
        const e = [...cur] as Euler;
        e[ch.axis] += dvReal;
        const q = quatFromEuler(e);
        value = { valueX: q[0], valueY: q[1], valueZ: q[2], valueW: q[3] };
      } else {
        value = { [ch.comp]: k.v + dvReal };
      }
      await call('timeline.setKeyValue', { track: ch.track.id, t: k.t, value });
      await refreshTimeline();
    }
  };

  const onDoubleClick = async (e: React.MouseEvent) => {
    const { x, y } = local(e);
    if (y < RULER_H || hitKey(x, y)) return;
    // nearest curve → insert a key on its track at that time
    let best: { ch: Channel; d: number } | null = null;
    const t = T(x);
    for (const ch of state.current.visible) {
      for (let i = 0; i + 3 < ch.poly.length; i += 2) {
        if (ch.poly[i] <= t && ch.poly[i + 2] >= t) {
          const d = Math.abs(Y(norm(ch, ch.poly[i + 1])) - y);
          if (!best || d < best.d) best = { ch, d };
          break;
        }
      }
    }
    if (!best || best.d > 24) return;
    const st = useStore.getState();
    const at = st.snap && st.tl ? snapToFrame(Math.max(0, t), st.tl.fps) : Math.max(0, t);
    await seekNow(at);
    await keyTracks([best.ch.track.id], at);
  };

  useEffect(() => {
    const c = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = local(e);
      const v = view.current;
      if (e.ctrlKey) {
        const t = T(x);
        v.pps = Math.max(2, Math.min(4000, v.pps * Math.exp(-e.deltaY * 0.0015)));
        v.t0 = t - (x - PAD_L) / v.pps;
      } else if (e.shiftKey) {
        v.t0 += e.deltaY / v.pps;
      } else {
        const at = V(y);
        const f = Math.exp(e.deltaY * 0.0015);
        v.yMin = at - (at - v.yMin) * f;
        v.yMax = at + (v.yMax - at) * f;
      }
      dirty.current = true;
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string, solo: boolean) =>
    setHidden((h) => {
      if (solo) return new Set(channels.filter((c) => c.id !== id).map((c) => c.id));
      const n = new Set(h);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const byTrack = new Map<number, Channel[]>();
  channels.forEach((c) => {
    const l = byTrack.get(c.track.id) ?? [];
    l.push(c);
    byTrack.set(c.track.id, l);
  });

  return (
    <div className="sheet">
      <div className="sheet-names" style={{ width: 220, overflowY: 'auto' }}>
        <div className="sheet-names-header" style={{ height: RULER_H, position: 'sticky', top: 0 }}>
          Channels
          <span className="spacer" style={{ flex: 1 }} />
          <button className={`btn ${normalize ? 'on' : ''}`} style={{ height: 20, fontSize: 10 }} title="Normalize every channel to 0–1 so different units overlay" onClick={() => setNormalize((n) => !n)}>
            Normalize
          </button>
        </div>
        {[...byTrack.entries()].map(([tid, list]) => (
          <div key={tid} style={{ padding: '6px 0 4px' }}>
            <div style={{ padding: '0 10px 2px', fontWeight: 600, color: 'var(--text-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={list[0].track.name}>
              {displayName(list[0].track)}
            </div>
            {list.map((c) => (
              <div {...pressable}
                key={c.id}
                className="tree-row"
                style={{ paddingLeft: 14, height: 22, opacity: hidden.has(c.id) ? 0.4 : 1 }}
                onClick={(e) => toggle(c.id, e.altKey)}
                title="Click to show/hide · Alt+click to solo"
              >
                <span style={{ width: 10, height: 10, borderRadius: 3, background: hidden.has(c.id) ? 'transparent' : c.color, border: `1.5px solid ${c.color}` }} />
                <span className="name">{c.label}</span>
                <span className="sub">
                  {c.min.toFixed(2)}…{c.max.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        ))}
        {!channels.length && (
          <div className="empty">
            <strong>Nothing to graph</strong>
            Select tracks or keys in the dope sheet. Tracks without numeric values (e.g. on/off switches) can't be graphed.
          </div>
        )}
      </div>
      <div className="sheet-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => void onPointerUp()} onLostPointerCapture={() => inter.current.mode !== 'none' && void onPointerUp()} onDoubleClick={onDoubleClick} onContextMenu={(e) => e.preventDefault()} />
        <TimeScrollbar
          pad={PAD_L}
          getView={() => ({ view: view.current, width: size.current.w })}
          setView={(v) => {
            view.current = { ...view.current, t0: v.t0, pps: v.pps };
            dirty.current = true;
          }}
          duration={() => useStore.getState().tl?.duration ?? 10}
        />
      </div>
    </div>
  );
}

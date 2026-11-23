// Shot sequencer maths: moving, trimming, cutting, swapping, splitting and reordering shots on the timeline.
// Pure functions on plain shot lists (no store, no bridge), so the shot track, the storyboard and the dope sheet's
// ruler all edit shots the same way — and the unit tests can check them.

export interface ShotLike {
  id: string;
  name: string;
  start: number;
  end: number;
}

/** Shortest shot: one frame at 60 fps would be too fiddly to grab, so a tenth of a second. */
export const MIN_SHOT = 0.1;
const EPS = 1e-4;

export const byStart = <T extends ShotLike>(shots: T[]) => [...shots].sort((a, b) => a.start - b.start || a.end - b.end);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Snap a time to the nearest frame, or to a target within `tol` seconds (targets win over frames). */
export function snapTime(t: number, fps: number, targets: number[] = [], tol = 0): number {
  let best = t;
  let bestD = tol;
  for (const x of targets) {
    const d = Math.abs(x - t);
    if (d <= bestD) {
      best = x;
      bestD = d;
    }
  }
  if (best !== t) return r4(best);
  return fps > 0 ? r4(Math.round(t * fps) / fps) : r4(t);
}

/** Where a shot can move: between the end of the one before it and the start of the one after (or 0 … duration). */
export function room<T extends ShotLike>(shots: T[], id: string, duration: number): { lo: number; hi: number } {
  const list = byStart(shots);
  const i = list.findIndex((s) => s.id === id);
  const prev = list.slice(0, i).reduce((m, s) => Math.max(m, s.end), 0);
  const next = list.slice(i + 1).reduce((m, s) => Math.min(m, s.start), duration);
  // a shot that already overlaps its neighbours isn't pulled out of them: it just can't go further in
  const me = list[i];
  return { lo: Math.min(prev, me?.start ?? prev), hi: Math.max(next, me?.end ?? next) };
}

/** Move a shot to start at `start`, kept between its neighbours. */
export function moveShot<T extends ShotLike>(shots: T[], id: string, start: number, duration: number): T[] {
  const me = shots.find((s) => s.id === id);
  if (!me) return shots;
  const len = me.end - me.start;
  const { lo, hi } = room(shots, id, duration);
  const s = clamp(start, lo, hi - len);
  return shots.map((x) => (x.id === id ? { ...x, start: r4(s), end: r4(s + len) } : x));
}

/** True when shot a ends exactly where b starts (they share a cut). */
export const touching = (a: ShotLike, b: ShotLike) => Math.abs(a.end - b.start) < 1e-3;

/**
 * Drag one edge of a shot. Where it shares the cut with its neighbour, both move (the cut moves); otherwise the
 * edge stops at the neighbour. A shot never gets shorter than MIN_SHOT.
 */
export function trimShot<T extends ShotLike>(shots: T[], id: string, edge: 'start' | 'end', t: number, duration: number): T[] {
  const list = byStart(shots);
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) return shots;
  const me = list[i];
  if (edge === 'start') {
    const prev = i > 0 ? list[i - 1] : null;
    const shared = prev && touching(prev, me);
    const lo = shared ? prev!.start + MIN_SHOT : prev ? Math.min(prev.end, me.start) : 0;
    const v = r4(clamp(t, lo, me.end - MIN_SHOT));
    return shots.map((x) => (x.id === id ? { ...x, start: v } : shared && x.id === prev!.id ? { ...x, end: v } : x));
  }
  const next = i < list.length - 1 ? list[i + 1] : null;
  const shared = next && touching(me, next);
  const hi = shared ? next!.end - MIN_SHOT : next ? Math.max(next.start, me.end) : duration;
  const v = r4(clamp(t, me.start + MIN_SHOT, hi));
  return shots.map((x) => (x.id === id ? { ...x, end: v } : shared && x.id === next!.id ? { ...x, start: v } : x));
}

/**
 * Swap a shot with its neighbour: they trade places within the span the two of them cover, each keeping its
 * length (the gap between them, if any, stays between them).
 */
export function swapWith<T extends ShotLike>(shots: T[], id: string, dir: -1 | 1): T[] {
  const list = byStart(shots);
  const i = list.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return shots;
  const [a, b] = dir === 1 ? [list[i], list[j]] : [list[j], list[i]]; // a before b
  const gap = Math.max(0, b.start - a.end);
  const lenA = a.end - a.start;
  const lenB = b.end - b.start;
  const nb = { start: a.start, end: a.start + lenB };
  const na = { start: nb.end + gap, end: nb.end + gap + lenA };
  return shots.map((x) => (x.id === a.id ? { ...x, start: r4(na.start), end: r4(na.end) } : x.id === b.id ? { ...x, start: r4(nb.start), end: r4(nb.end) } : x));
}

/** Put shots in a new order, back to back from where the first one starts, each keeping its length. */
export function reorder<T extends ShotLike>(shots: T[], order: string[], duration: number): T[] {
  const list = byStart(shots);
  if (!list.length) return shots;
  let t = list[0].start;
  const placed = new Map<string, { start: number; end: number }>();
  for (const id of order) {
    const s = list.find((x) => x.id === id);
    if (!s) continue;
    const len = s.end - s.start;
    placed.set(id, { start: r4(t), end: r4(Math.min(duration, t + len)) });
    t += len;
  }
  return shots.map((x) => (placed.has(x.id) ? { ...x, ...placed.get(x.id)! } : x));
}

/** Split a shot at `t` into two that share the cut; the second is a copy with a new id and name. */
export function splitShot<T extends ShotLike>(shots: T[], id: string, t: number, newId: string): T[] | null {
  const me = shots.find((s) => s.id === id);
  if (!me || t < me.start + MIN_SHOT - EPS || t > me.end - MIN_SHOT + EPS) return null;
  const second = { ...me, id: newId, name: `${me.name} B`, start: r4(t) } as T;
  return [...shots.map((x) => (x.id === id ? { ...x, end: r4(t) } : x)), second];
}

/** A copy of a shot in the room right after it (as long as the original, or as long as fits). */
export function duplicateShot<T extends ShotLike>(shots: T[], id: string, newId: string, duration: number): T[] | null {
  const me = shots.find((s) => s.id === id);
  if (!me) return null;
  const next = byStart(shots).find((s) => s.start >= me.end - EPS && s.id !== id);
  const limit = next ? next.start : duration;
  const end = Math.min(limit, me.end + (me.end - me.start));
  if (end - me.end < MIN_SHOT - EPS) return null;
  return [...shots, { ...me, id: newId, name: `${me.name} copy`, start: r4(me.end), end: r4(end) } as T];
}

/** A new shot at `t`: until the next shot starts (or 3 s, or the end of the timeline). Null when there's no room. */
export function newShotAt(shots: ShotLike[], t: number, duration: number): { start: number; end: number } | null {
  const inside = shots.find((s) => t >= s.start - EPS && t < s.end - EPS);
  const start = inside ? inside.end : t;
  const next = byStart(shots).find((s) => s.start > start + EPS);
  const end = Math.min(duration, next ? next.start : Infinity, start + 3);
  return end - start >= MIN_SHOT - EPS ? { start: r4(start), end: r4(end) } : null;
}

/** Shots that run past the end of the timeline (they won't play there). */
export const pastEnd = <T extends ShotLike>(shots: T[], duration: number) => shots.filter((s) => s.end > duration + 1e-3);

/** Every shot ends by the end of the timeline; shots that would start there or later are left out. */
export function trimToEnd<T extends ShotLike>(shots: T[], duration: number): T[] {
  return shots.filter((s) => s.start < duration - MIN_SHOT + EPS).map((s) => (s.end > duration ? { ...s, end: r4(duration) } : s));
}

export interface Problem {
  kind: 'gap' | 'overlap';
  start: number;
  end: number;
  /** the shots on either side */
  a: string;
  b: string;
}

/** Gaps between shots and overlaps (the camera goes uncovered, or two shots claim the same time). */
export function problems(shots: ShotLike[]): Problem[] {
  const list = byStart(shots);
  const out: Problem[] = [];
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (b.start < a.end - 1e-3) out.push({ kind: 'overlap', start: b.start, end: Math.min(a.end, b.end), a: a.id, b: b.id });
    }
    const b = list[i + 1];
    if (b.start > a.end + 1e-3) out.push({ kind: 'gap', start: a.end, end: b.start, a: a.id, b: b.id });
  }
  return out;
}

/** Remove overlaps: each shot ends where the next one starts. */
export function fixOverlaps<T extends ShotLike>(shots: T[]): T[] {
  const list = byStart(shots);
  const ends = new Map<string, number>();
  for (let i = 0; i + 1 < list.length; i++) if (list[i].end > list[i + 1].start + 1e-3) ends.set(list[i].id, Math.max(list[i].start + MIN_SHOT, list[i + 1].start));
  return shots.map((x) => (ends.has(x.id) ? { ...x, end: r4(ends.get(x.id)!) } : x));
}

/** Total time the shots cover (overlaps counted once). */
export function covered(shots: ShotLike[]): number {
  let total = 0;
  let reach = -Infinity;
  for (const s of byStart(shots)) {
    const a = Math.max(s.start, reach);
    if (s.end > a) total += s.end - a;
    reach = Math.max(reach, s.end);
  }
  return r4(total);
}

/** The shot at time t (a later shot wins an overlap; the very end belongs to the last shot). */
export function shotAt<T extends ShotLike>(shots: T[], t: number): T | null {
  let hit: T | null = null;
  for (const s of byStart(shots)) if (t >= s.start - EPS && t < s.end - EPS) hit = s;
  if (!hit && shots.length) {
    const last = byStart(shots)[shots.length - 1];
    if (Math.abs(t - last.end) < 1e-3) hit = last;
  }
  return hit;
}

export const newShotId = () => Math.random().toString(36).slice(2, 10);

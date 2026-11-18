/**
 * Motion cleanup math (no UI, no app imports, so it can be unit-tested with plain Node).
 * Key values come from timeline.keyValues: numeric attributes per key, e.g. {valueX, valueY, valueZ} for a
 * position or {valueX, valueY, valueZ, valueW} for a rotation (quaternion).
 */
export type Attrs = Record<string, number>;
export interface KeyVal {
  t: number;
  attrs: Attrs;
}

const QUAT = ['valueX', 'valueY', 'valueZ', 'valueW'];
export const isQuat = (a: Attrs) => QUAT.every((k) => typeof a[k] === 'number');

type Q = [number, number, number, number];
const q = (a: Attrs): Q => [a.valueX, a.valueY, a.valueZ, a.valueW];
const qAttrs = (base: Attrs, v: Q): Attrs => ({ ...base, valueX: v[0], valueY: v[1], valueZ: v[2], valueW: v[3] });
const dot = (a: Q, b: Q) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
function norm(a: Q): Q {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l, a[3] / l];
}
export function slerp(a: Q, b0: Q, f: number): Q {
  let b = b0;
  let d = dot(a, b);
  if (d < 0) {
    b = [-b[0], -b[1], -b[2], -b[3]];
    d = -d;
  }
  if (d > 0.9995) return norm([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f]);
  const th = Math.acos(Math.min(1, d));
  const s = Math.sin(th);
  const wa = Math.sin((1 - f) * th) / s,
    wb = Math.sin(f * th) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb];
}
/** Angle between two rotations, degrees. */
export const quatAngle = (a: Q, b: Q) => (2 * Math.acos(Math.min(1, Math.abs(dot(norm(a), norm(b))))) * 180) / Math.PI;

/** Value at time t between two keys (straight line; rotations along the shortest arc). */
function between(a: KeyVal, b: KeyVal, t: number): Attrs {
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  if (isQuat(a.attrs) && isQuat(b.attrs)) return qAttrs(a.attrs, slerp(q(a.attrs), q(b.attrs), f));
  const out: Attrs = {};
  for (const k of Object.keys(a.attrs)) out[k] = typeof b.attrs[k] === 'number' ? a.attrs[k] + (b.attrs[k] - a.attrs[k]) * f : a.attrs[k];
  return out;
}

function toward(cur: Attrs, target: Attrs, s: number): Attrs {
  if (isQuat(cur) && isQuat(target)) return qAttrs(cur, slerp(q(cur), q(target), s));
  const out: Attrs = {};
  for (const k of Object.keys(cur)) out[k] = typeof target[k] === 'number' ? cur[k] + (target[k] - cur[k]) * s : cur[k];
  return out;
}

/**
 * Smooth the chosen keys of one track: each moves toward the straight line between its neighbours.
 * strength 0..1 per pass; the first and last key of the track never move. Returns new values by key index.
 */
export function smoothKeys(keys: KeyVal[], chosen: Set<number>, strength: number, passes = 1): Map<number, Attrs> {
  let vals = keys.map((k) => k.attrs);
  const s = Math.max(0, Math.min(1, strength));
  for (let p = 0; p < passes; p++) {
    const next = vals.slice();
    for (const i of chosen) {
      if (i <= 0 || i >= keys.length - 1) continue;
      const target = between({ t: keys[i - 1].t, attrs: vals[i - 1] }, { t: keys[i + 1].t, attrs: vals[i + 1] }, keys[i].t);
      next[i] = toward(vals[i], target, s);
    }
    vals = next;
  }
  const out = new Map<number, Attrs>();
  for (const i of chosen) if (i > 0 && i < keys.length - 1) out.set(i, vals[i]);
  return out;
}

/** How fast the value changes from key i to key i+1 (units or degrees per second). */
export function segmentSpeed(a: KeyVal, b: KeyVal): number {
  const dt = Math.max(1e-4, b.t - a.t);
  if (isQuat(a.attrs) && isQuat(b.attrs)) return quatAngle(q(a.attrs), q(b.attrs)) / dt;
  let d2 = 0;
  for (const k of Object.keys(a.attrs)) if (typeof b.attrs[k] === 'number') d2 += (b.attrs[k] - a.attrs[k]) ** 2;
  return Math.sqrt(d2) / dt;
}

export interface Pop {
  /** the segment from key `index` to key `index + 1` */
  index: number;
  speed: number;
  /** speed ÷ the track's typical (median) speed */
  ratio: number;
}

/**
 * Sudden moves: segments much faster than the track usually moves. Needs a few segments to know what's
 * "usual"; tiny absolute changes (below `floor`) are ignored.
 */
export function findPops(keys: KeyVal[], { ratio = 4, floor = 1e-3 } = {}): Pop[] {
  if (keys.length < 4) return [];
  const speeds = keys.slice(0, -1).map((k, i) => segmentSpeed(k, keys[i + 1]));
  const moving = speeds.filter((v) => v > floor).sort((a, b) => a - b);
  if (moving.length < 3) return [];
  const median = moving[Math.floor(moving.length / 2)];
  const out: Pop[] = [];
  speeds.forEach((v, i) => {
    if (v > floor && v > median * ratio) out.push({ index: i, speed: v, ratio: v / median });
  });
  return out;
}

/** How far key i sits off the line between its neighbours, relative to the neighbours' own spread. */
function offLine(keys: KeyVal[], i: number): number {
  if (i <= 0 || i >= keys.length - 1) return 0;
  const line = between(keys[i - 1], keys[i + 1], keys[i].t);
  const cur = keys[i].attrs;
  if (isQuat(cur) && isQuat(line)) return quatAngle(q(cur), q(line));
  let d2 = 0;
  for (const k of Object.keys(cur)) if (typeof line[k] === 'number') d2 += (cur[k] - line[k]) ** 2;
  return Math.sqrt(d2);
}

/**
 * The stray keys behind a set of sudden moves: a key shared by two fast segments (up and back down) is the
 * culprit; for a lone fast segment, whichever of its two keys sits further off its neighbours' line.
 * First and last keys are never chosen (they can't be put back on a line). Returns key indices.
 */
export function popCulprits(keys: KeyVal[], pops: Pop[]): number[] {
  const seg = new Set(pops.map((p) => p.index));
  const out = new Set<number>();
  for (const p of pops) {
    const a = p.index,
      b = p.index + 1;
    if (seg.has(a - 1) && a > 0) out.add(a); // previous segment fast too: key a is the spike
    else if (seg.has(b)) out.add(b); // next segment fast too: key b is the spike
    else {
      const pick = offLine(keys, a) >= offLine(keys, b) ? a : b;
      if (pick > 0 && pick < keys.length - 1) out.add(pick);
      else if (a > 0 && a < keys.length - 1) out.add(a);
      else if (b > 0 && b < keys.length - 1) out.add(b);
    }
  }
  return [...out].sort((x, y) => x - y);
}

export interface SlideRange {
  bone: string;
  t0: number;
  t1: number;
  /** how far the foot slid while planted (scene units) */
  distance: number;
}

/**
 * Foot sliding: the foot is on the ground (within 3% of the character's height of its lowest point) but moves
 * sideways faster than 12% of the height per second, for at least `minSamples` samples in a row.
 */
export function footSlides(times: number[], series: Record<string, number[][]>, height: number, { minSamples = 3, contact = 0.03, speed = 0.12 } = {}): SlideRange[] {
  const out: SlideRange[] = [];
  const h = height > 0 ? height : 1;
  for (const [bone, pts] of Object.entries(series)) {
    if (pts.length < 2) continue;
    const ys = pts.map((p) => p[1]).sort((a, b) => a - b);
    const ground = ys[Math.floor(ys.length * 0.05)];
    let start = -1,
      dist = 0,
      count = 0;
    const flush = (end: number) => {
      if (start >= 0 && count >= minSamples) out.push({ bone, t0: times[start], t1: times[end], distance: dist });
      start = -1;
      dist = 0;
      count = 0;
    };
    for (let i = 1; i < pts.length; i++) {
      const dt = Math.max(1e-4, times[i] - times[i - 1]);
      const planted = pts[i][1] < ground + contact * h && pts[i - 1][1] < ground + contact * h;
      const horiz = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]);
      if (planted && horiz / dt > speed * h) {
        if (start < 0) start = i - 1;
        dist += horiz;
        count++;
      } else flush(i - 1);
    }
    flush(pts.length - 1);
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

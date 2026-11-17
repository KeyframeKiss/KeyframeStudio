// Unity AnimationCurve math. Timeline stores, per keyframe, a curve that maps the
// normalised time between this key and the next (0..1) to a blend factor (usually 0..1).

export interface CurveKey {
  time: number;
  value: number;
  inTangent: number;
  outTangent: number;
}

export type Curve = CurveKey[];

// Same tangents as Unity's AnimationCurve.Linear(0,0,1,1).
export const LINEAR: Curve = [
  { time: 0, value: 0, inTangent: 0, outTangent: 1 },
  { time: 1, value: 1, inTangent: 1, outTangent: 0 },
];

export function fromFlat(flat: number[] | undefined | null): Curve {
  if (!flat || flat.length < 8) return LINEAR.map((k) => ({ ...k }));
  const out: Curve = [];
  for (let i = 0; i + 3 < flat.length; i += 4) {
    out.push({ time: flat[i], value: flat[i + 1], inTangent: num(flat[i + 2]), outTangent: num(flat[i + 3]) });
  }
  return out;
}

function num(v: number | null) {
  // Plugin encodes ±Infinity as ±1e999 (parses to Infinity) and NaN as null.
  return v == null ? 0 : v;
}

/** JSON can't carry Infinity; 1e39 overflows float on the C# side back into Infinity. */
export function toFlat(c: Curve): number[] {
  const enc = (v: number) => (v === Infinity ? 1e39 : v === -Infinity ? -1e39 : v);
  return c.flatMap((k) => [k.time, k.value, enc(k.inTangent), enc(k.outTangent)]);
}

export function evaluate(c: Curve, t: number): number {
  if (c.length === 0) return t;
  if (t <= c[0].time) return c[0].value;
  const last = c[c.length - 1];
  if (t >= last.time) return last.value;
  let i = 0;
  while (i < c.length - 2 && t > c[i + 1].time) i++;
  const k0 = c[i];
  const k1 = c[i + 1];
  const dt = k1.time - k0.time;
  if (dt <= 0) return k1.value;
  if (!Number.isFinite(k0.outTangent) || !Number.isFinite(k1.inTangent)) return k0.value; // stepped
  const s = (t - k0.time) / dt;
  const s2 = s * s;
  const s3 = s2 * s;
  const m0 = k0.outTangent * dt;
  const m1 = k1.inTangent * dt;
  return (2 * s3 - 3 * s2 + 1) * k0.value + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * k1.value + (s3 - s2) * m1;
}

const k = (time: number, value: number, inTangent: number, outTangent: number): CurveKey => ({ time, value, inTangent, outTangent });

export interface Preset {
  id: string;
  label: string;
  hotkey?: string;
  curve: Curve;
}

// The first five match Timeline's built-in presets so curves look the same in both UIs.
export const PRESETS: Preset[] = [
  { id: 'linear', label: 'Linear', hotkey: '1', curve: [k(0, 0, 0, 1), k(1, 1, 1, 0)] },
  { id: 'easeInOut', label: 'Ease In-Out', hotkey: '2', curve: [k(0, 0, 0, 0), k(1, 1, 0, 0)] },
  { id: 'easeIn', label: 'Ease In', hotkey: '3', curve: [k(0, 0, 0, 0), k(1, 1, 2, 2)] },
  { id: 'easeOut', label: 'Ease Out', hotkey: '4', curve: [k(0, 0, 2, 2), k(1, 1, 0, 0)] },
  { id: 'step', label: 'Step (Hold)', hotkey: '5', curve: [k(0, 0, 0, 0), k(1, 1, Infinity, 0)] },
  { id: 'overshoot', label: 'Overshoot', curve: [k(0, 0, 4, 4), k(1, 1, 0, 0)] },
  { id: 'anticipate', label: 'Anticipate', curve: [k(0, 0, 0, 0), k(1, 1, 4, 4)] },
  {
    id: 'smoothStop',
    label: 'Strong Ease Out',
    curve: [k(0, 0, 3, 3), k(0.4, 0.92, 0.35, 0.35), k(1, 1, 0, 0)],
  },
  {
    id: 'smoothStart',
    label: 'Strong Ease In',
    curve: [k(0, 0, 0, 0), k(0.6, 0.08, 0.35, 0.35), k(1, 1, 3, 3)],
  },
];

export function curvesEqual(a: Curve, b: Curve, eps = 1e-4): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (Math.abs(x.time - y.time) > eps || Math.abs(x.value - y.value) > eps) return false;
    // The first key's in-tangent and last key's out-tangent never affect evaluation.
    if (i > 0 && !tanEq(x.inTangent, y.inTangent, eps)) return false;
    if (i < a.length - 1 && !tanEq(x.outTangent, y.outTangent, eps)) return false;
  }
  return true;
}

function tanEq(a: number, b: number, eps: number) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= eps;
}

export function presetFor(c: Curve): Preset | undefined {
  return PRESETS.find((p) => curvesEqual(p.curve, c));
}

/** Short glyph for drawing in the dope sheet. */
export function curveKind(flat: number[] | undefined): 'linear' | 'step' | 'ease' | 'custom' {
  if (!flat) return 'linear';
  const c = fromFlat(flat);
  if (c.some((k) => !Number.isFinite(k.inTangent) || !Number.isFinite(k.outTangent))) return 'step';
  const p = presetFor(c);
  if (p?.id === 'linear') return 'linear';
  if (p) return 'ease';
  return 'custom';
}

/**
 * Tone curves for Look › Picture › Grading: points "x,y x,y …" (0..1), drawn and baked the same way — a smooth curve
 * through every point that never overshoots (monotone cubic, as the bridge's GradingBake does).
 */

export type Pt = [number, number];

export const IDENTITY = '0,0 1,1';

export function parseCurve(s: string | undefined | null): Pt[] {
  const pts: Pt[] = [];
  for (const p of (s ?? '').split(/[ ;]+/)) {
    const [x, y] = p.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push([Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  const clean: Pt[] = [];
  for (const p of pts) if (!clean.length || p[0] - clean[clean.length - 1][0] > 1e-4) clean.push(p);
  return clean.length >= 2 ? clean : [
    [0, 0],
    [1, 1],
  ];
}

export function formatCurve(pts: Pt[]): string {
  return [...pts]
    .sort((a, b) => a[0] - b[0])
    .map(([x, y]) => `${+x.toFixed(4)},${+y.toFixed(4)}`)
    .join(' ');
}

export function isIdentity(s: string | undefined | null): boolean {
  const p = parseCurve(s);
  return p.every(([x, y]) => Math.abs(x - y) < 1e-3);
}

/** The curve as a function (Fritsch–Carlson tangents: no overshoot between points). */
export function curveFn(pts: Pt[]): (x: number) => number {
  const n = pts.length;
  const xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  const m = new Array<number>(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-6) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i],
      b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t,
      t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    return Math.min(1, Math.max(0, y));
  };
}

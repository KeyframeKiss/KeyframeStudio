/**
 * Vowels from a voice (no UI, no app imports — unit-tested with plain Node).
 *
 * Each window's spectrum (dB per frequency band) gives the first two formants — the resonances that tell
 * vowels apart — and the nearest of A / I / U / E / O is picked. Silent windows get none. The sequence is
 * then smoothed so a syllable doesn't flicker between shapes. Rough (no phonemes, no consonants), but the mouth
 * shape follows the sound instead of only opening and closing.
 */
export type Vowel = 'a' | 'i' | 'u' | 'e' | 'o';
export const VOWELS: Vowel[] = ['a', 'i', 'u', 'e', 'o'];

export interface Spectrum {
  /** windows per second */
  rate: number;
  /** bands per window */
  bands: number;
  /** lowest band's start (Hz) and each band's width (Hz) */
  from: number;
  width: number;
  /** dB, window after window */
  values: number[];
}

/** Typical first/second formants (Hz) of the Japanese vowels for a female or young voice. */
export const FORMANTS: Record<Vowel, [number, number]> = {
  a: [850, 1450],
  i: [330, 2650],
  u: [370, 1550],
  e: [560, 2250],
  o: [520, 950],
};

const bandHz = (s: Spectrum, b: number) => s.from + (b + 0.5) * s.width;

/**
 * [F1, F2] in Hz for window w: the first two peaks of the envelope (the plugin sends a smooth LPC envelope,
 * so its peaks are the voice's resonances, not its harmonics), refined between bands with a parabola.
 */
export function formants(s: Spectrum, w: number): [number, number] {
  const at = (b: number) => s.values[w * s.bands + b];
  const refine = (b: number) => {
    if (b <= 0 || b >= s.bands - 1) return bandHz(s, b);
    const l = at(b - 1),
      c = at(b),
      r = at(b + 1);
    const den = l - 2 * c + r;
    return bandHz(s, b + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0));
  };
  const peaks: number[] = [];
  for (let b = 1; b < s.bands - 1; b++) if (at(b) > at(b - 1) && at(b) >= at(b + 1)) peaks.push(refine(b));
  const argmax = (lo: number, hi: number) => {
    let best = -1;
    for (let b = 0; b < s.bands; b++) {
      const hz = bandHz(s, b);
      if (hz >= lo && hz <= hi && (best < 0 || at(b) > at(best))) best = b;
    }
    return best < 0 ? (lo + hi) / 2 : refine(best);
  };
  const f1 = peaks.find((hz) => hz >= 250 && hz <= 1050) ?? argmax(250, 1000);
  // F2: the next peak up; when F1 and F2 merge into one hump (open back vowels), assume the usual spacing
  const f2 = peaks.find((hz) => hz > f1 + 250 && hz <= 3100) ?? (f1 > 600 ? f1 * 1.6 : argmax(f1 + 300, 3000));
  return [f1, f2];
}

/** Nearest vowel in log-frequency (F1 counts a bit more: it separates open from closed vowels). */
export function nearestVowel([f1, f2]: [number, number], scale: [number, number] = [1, 1]): Vowel {
  let best: Vowel = 'a',
    d = Infinity;
  for (const v of VOWELS) {
    const [c1, c2] = FORMANTS[v];
    const x = Math.log(f1 / (c1 * scale[0])),
      y = Math.log(f2 / (c2 * scale[1]));
    const dist = 1.3 * x * x + y * y;
    if (dist < d) (d = dist), (best = v);
  }
  return best;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

export interface VowelOptions {
  /** windows whose loudness (0..1 of the loudest) is below this are silent */
  threshold: number;
  /** shortest vowel (seconds) — shorter ones merge into a neighbour */
  minLength: number;
}
export const VOWEL_DEFAULTS: VowelOptions = { threshold: 0.12, minLength: 0.07 };

/**
 * One label per window: a vowel, or null where it's quiet. `loud` is each window's loudness (any unit; it's
 * normalized to the loudest). Formant targets are shifted to the speaker (lower or higher voice).
 */
export function vowelTrack(s: Spectrum, loud: number[], o: VowelOptions = VOWEL_DEFAULTS): (Vowel | null)[] {
  const n = Math.min(loud.length, Math.floor(s.values.length / s.bands));
  const max = Math.max(1e-9, ...loud.slice(0, n));
  const voiced: boolean[] = [];
  const fs: [number, number][] = [];
  for (let w = 0; w < n; w++) {
    voiced.push(loud[w] / max >= o.threshold);
    fs.push(formants(s, w));
  }
  // speaker normalization: the median formants of voiced windows vs the average vowel
  const v1 = fs.filter((_, w) => voiced[w]).map((f) => f[0]);
  const v2 = fs.filter((_, w) => voiced[w]).map((f) => f[1]);
  const avg = (i: 0 | 1) => Math.exp(VOWELS.reduce((a, v) => a + Math.log(FORMANTS[v][i]), 0) / VOWELS.length);
  const clamp = (x: number) => (Number.isFinite(x) ? Math.max(0.8, Math.min(1.25, x)) : 1);
  const scale: [number, number] = v1.length >= 8 ? [clamp(median(v1) / avg(0)), clamp(median(v2) / avg(1))] : [1, 1];
  const raw = fs.map((f, w) => (voiced[w] ? nearestVowel(f, scale) : null));
  return smooth(raw, Math.max(1, Math.round(o.minLength * s.rate)));
}

/** Majority vote over ±2 windows, then runs shorter than `minRun` windows join the longer neighbour. */
export function smooth(labels: (Vowel | null)[], minRun: number): (Vowel | null)[] {
  const voted = labels.map((l, i) => {
    if (l === null) return null;
    const count = new Map<Vowel, number>();
    for (let k = Math.max(0, i - 2); k <= Math.min(labels.length - 1, i + 2); k++) {
      const x = labels[k];
      if (x) count.set(x, (count.get(x) ?? 0) + 1);
    }
    let best = l,
      c = 0;
    for (const [v, m] of count) if (m > c || (m === c && v === l)) (best = v), (c = m);
    return best;
  });
  // runs
  const runs: { v: Vowel | null; start: number; len: number }[] = [];
  for (let i = 0; i < voted.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.v === voted[i]) last.len++;
    else runs.push({ v: voted[i], start: i, len: 1 });
  }
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.v === null || r.len >= minRun) continue;
    const prev = runs[i - 1],
      next = runs[i + 1];
    const into = prev?.v && (!next?.v || prev.len >= next.len) ? prev.v : next?.v ?? prev?.v ?? r.v;
    r.v = into;
  }
  const out: (Vowel | null)[] = [];
  for (const r of runs) for (let k = 0; k < r.len; k++) out.push(r.v);
  return out;
}

/** Keys where the label changes: {t (seconds from the start of the audio), v (vowel or null = rest)}. */
export function vowelKeys(labels: (Vowel | null)[], rate: number): { t: number; v: Vowel | null }[] {
  const keys: { t: number; v: Vowel | null }[] = [];
  labels.forEach((l, i) => {
    if (i === 0 || l !== labels[i - 1]) keys.push({ t: Math.round((i / rate) * 1000) / 1000, v: l });
  });
  if (keys.length && keys[keys.length - 1].v !== null) keys.push({ t: Math.round((labels.length / rate) * 1000) / 1000, v: null });
  return keys;
}

/**
 * Which mouth pattern shows each vowel, from the game's pattern list ({ptn, open: shape name}): the large
 * version ("…_a_l_op"), else the small one. Missing vowels are left out.
 */
export function vowelPatterns(patterns: { ptn: number; open: string; close: string }[]): Partial<Record<Vowel, number>> {
  const out: Partial<Record<Vowel, number>> = {};
  for (const v of VOWELS) {
    const large = patterns.find((p) => new RegExp(`_${v}_l_op$`).test(p.open));
    const small = patterns.find((p) => new RegExp(`_${v}_s_op$`).test(p.open));
    const hit = large ?? small;
    if (hit) out[v] = hit.ptn;
  }
  return out;
}

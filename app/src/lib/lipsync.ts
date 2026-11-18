/**
 * Lip-sync from loudness (no UI, no app imports — unit-tested with plain Node).
 * The audio's RMS envelope becomes "mouth open" keys: louder = wider. Not phoneme-accurate, but it reads as
 * talking/singing and is a good base to refine by hand.
 */
export interface LipSyncOptions {
  /** 0.5..3 — how wide the mouth opens for a given loudness */
  sensitivity: number;
  /** 0..0.5 — quieter than this (relative to the loudest part) counts as closed: background noise, breaths */
  threshold: number;
  /** 0..1 — 0 follows every flicker, 1 is lazy (slower to close than to open) */
  smoothing: number;
  /** keys per second (10–20 looks natural) */
  keysPerSecond: number;
  /** the widest the mouth gets (0..1) */
  maxOpen: number;
}

export const LIPSYNC_DEFAULTS: LipSyncOptions = { sensitivity: 1.4, threshold: 0.08, smoothing: 0.4, keysPerSecond: 15, maxOpen: 1 };

/**
 * values: RMS per window, `rate` windows per second; max: the loudest window.
 * Returns keys {t (seconds from the start of the audio), v (0..maxOpen)} with redundant keys dropped.
 */
export function lipSyncKeys(values: number[], rate: number, max: number, o: LipSyncOptions = LIPSYNC_DEFAULTS): { t: number; v: number }[] {
  if (!values.length || !(max > 0)) return [];
  const thr = Math.max(0, Math.min(0.9, o.threshold));
  const attack = 1 - Math.min(0.9, o.smoothing * 0.5),
    release = 1 - Math.min(0.95, o.smoothing * 0.85);
  // loudness → openness, gated and smoothed (fast open, slower close)
  const open: number[] = [];
  let y = 0;
  for (const rms of values) {
    let v = Math.min(1, (rms / max) * o.sensitivity);
    v = v < thr ? 0 : (v - thr) / (1 - thr);
    v = Math.sqrt(v); // quiet speech still opens the mouth a little
    y += (v - y) * (v > y ? attack : release);
    open.push(y);
  }
  // sample at keysPerSecond, taking the peak inside each window so short syllables aren't skipped
  const kps = Math.max(2, Math.min(60, o.keysPerSecond));
  const per = rate / kps;
  const keys: { t: number; v: number }[] = [];
  const n = Math.ceil(values.length / per);
  for (let k = 0; k < n; k++) {
    let peak = 0;
    for (let i = Math.floor(k * per); i < Math.min(open.length, Math.floor((k + 1) * per)); i++) peak = Math.max(peak, open[i]);
    keys.push({ t: k / kps, v: Math.round(peak * o.maxOpen * 1000) / 1000 });
  }
  keys.push({ t: values.length / rate, v: 0 }); // close at the end
  // drop keys that don't change anything (same as both neighbours)
  return keys.filter((k, i) => i === 0 || i === keys.length - 1 || Math.abs(k.v - keys[i - 1].v) > 0.02 || Math.abs(k.v - keys[i + 1].v) > 0.02);
}

/**
 * Natural blinks over [t0, t1]: every `every` seconds ± 30%, each a quick close and a slightly slower open.
 * `open` is the eyes' usual openness. Deterministic for a given seed (so a redo gives the same blinks).
 */
export function blinkKeys(t0: number, t1: number, every: number, open: number, seed = 1): { t: number; v: number }[] {
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const keys: { t: number; v: number }[] = [];
  for (let t = t0 + every * (0.4 + rand() * 0.4); t + 0.3 < t1; t += every * (0.7 + rand() * 0.6)) {
    keys.push({ t, v: open }, { t: t + 0.07, v: 0 }, { t: t + 0.12, v: 0 }, { t: t + 0.26, v: open });
  }
  return keys.map((k) => ({ t: Math.round(k.t * 1000) / 1000, v: k.v }));
}

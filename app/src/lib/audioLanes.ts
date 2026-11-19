/** Each audio clip's colour, by its place in the list, shared by the Timeline lanes and the Audio page. */
const LANE_RGB = ['90,169,255', '94,201,140', '186,146,255', '240,170,90', '255,128,170'];

/** "r,g,b" for rgba(): the colour of clip number `i`. */
export const laneRgb = (i: number) => LANE_RGB[i % LANE_RGB.length];

/** Loudest peak per waveform, so quiet files still fill their lane. */
const peakMax = new WeakMap<object, number>();
export function loudest(w: { peaks: number[] }) {
  let m = peakMax.get(w);
  if (m == null) {
    m = 0.05;
    for (const p of w.peaks) if (p > m) m = p;
    peakMax.set(w, m);
  }
  return m;
}

/** How a clip plays: where it starts, its trims and speed (the pitch follows the speed). */
export interface ClipTiming {
  offset: number;
  speed: number;
  trimIn: number;
  trimOut: number;
  duration: number;
}
/** Seconds the clip plays on the timeline. */
export const clipSpan = (c: ClipTiming) => Math.max(0.01, c.duration - c.trimIn - c.trimOut) / c.speed;
/** Timeline time → seconds into the file. */
export const fileTimeAt = (c: ClipTiming, t: number) => c.trimIn + (t - c.offset) * c.speed;
/** Seconds into the file → timeline time. */
export const timelineTimeAt = (c: ClipTiming, ft: number) => c.offset + (ft - c.trimIn) / c.speed;
/** The fade factor (0..1) at timeline time t. */
export function fadeAt(c: ClipTiming & { fadeIn: number; fadeOut: number }, t: number) {
  const local = t - c.offset,
    span = clipSpan(c);
  let g = 1;
  if (c.fadeIn > 0.001) g *= Math.min(1, Math.max(0, local / c.fadeIn));
  if (c.fadeOut > 0.001) g *= Math.min(1, Math.max(0, (span - local) / c.fadeOut));
  return g;
}

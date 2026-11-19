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

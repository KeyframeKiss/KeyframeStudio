/**
 * Scopes for Look › Picture, from a small picture of Studio's view: histogram, waveform, RGB parade and
 * vectorscope. Pure maths on RGBA pixels (0..255) so it's testable; drawing is in ScopesPanel.
 */

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  l: Uint32Array;
  max: number;
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 256 bins per channel and for brightness; max = the tallest bin (for scaling). */
export function histogram(px: ArrayLike<number>): Histogram {
  const r = new Uint32Array(256),
    g = new Uint32Array(256),
    b = new Uint32Array(256),
    l = new Uint32Array(256);
  for (let i = 0; i + 3 < px.length; i += 4) {
    r[px[i]]++;
    g[px[i + 1]]++;
    b[px[i + 2]]++;
    l[Math.min(255, Math.round(luma(px[i], px[i + 1], px[i + 2])))]++;
  }
  let max = 1;
  for (let k = 0; k < 256; k++) max = Math.max(max, r[k], g[k], b[k], l[k]);
  return { r, g, b, l, max };
}

/**
 * Waveform: for each of `cols` columns across the picture, how many pixels sit at each level (0..levels-1, bottom up).
 * channel: 'l' brightness, or 0 / 1 / 2 for red / green / blue (the parade is three of these).
 */
export function waveform(px: ArrayLike<number>, w: number, h: number, cols: number, levels = 128, channel: 'l' | 0 | 1 | 2 = 'l'): { bins: Uint32Array; max: number } {
  const bins = new Uint32Array(cols * levels);
  let max = 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = channel === 'l' ? luma(px[i], px[i + 1], px[i + 2]) : px[i + channel];
      const c = Math.min(cols - 1, Math.floor((x * cols) / w));
      const lv = Math.min(levels - 1, Math.floor((v * levels) / 256));
      const k = c * levels + lv;
      bins[k]++;
      if (bins[k] > max) max = bins[k];
    }
  return { bins, max };
}

/** Where a colour sits on the vectorscope: BT.709 colour difference, -0.5..0.5 each (0, 0 = no colour). */
export function chroma(r: number, g: number, b: number): [number, number] {
  const R = r / 255,
    G = g / 255,
    B = b / 255;
  return [-0.1146 * R - 0.3854 * G + 0.5 * B, 0.5 * R - 0.4542 * G - 0.0458 * B];
}

/** Vectorscope: a size × size grid of counts, Cb left → right, Cr bottom → top (row 0 is the top). */
export function vectorscope(px: ArrayLike<number>, size = 128): { bins: Uint32Array; max: number } {
  const bins = new Uint32Array(size * size);
  let max = 1;
  for (let i = 0; i + 3 < px.length; i += 4) {
    const [cb, cr] = chroma(px[i], px[i + 1], px[i + 2]);
    const x = Math.min(size - 1, Math.max(0, Math.floor((cb + 0.5) * size)));
    const y = Math.min(size - 1, Math.max(0, Math.floor((0.5 - cr) * size)));
    const k = y * size + x;
    bins[k]++;
    if (bins[k] > max) max = bins[k];
  }
  return { bins, max };
}

/** The skin-tone line on a vectorscope (about 123° from the Cb axis), as a unit direction. */
export const SKIN_LINE: [number, number] = [Math.cos((123 * Math.PI) / 180), Math.sin((123 * Math.PI) / 180)];

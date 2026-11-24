import { create } from 'zustand';

// Appearance: the theme (dark / light / follow Windows) and the accent colour, applied as data-theme / data-accent
// on <html>, where the design tokens in styles.css pick them up. Canvas drawings (timeline, graph, waveforms) read
// the same tokens through tokenColor / tokenRgba and redraw on "kf:theme".

export type ThemeChoice = 'dark' | 'light' | 'system';
export type Accent = 'orange' | 'pink' | 'blue' | 'green' | 'violet';
export const ACCENTS: { id: Accent; label: string; dark: string; light: string }[] = [
  { id: 'orange', label: 'Orange', dark: '#ff9f2e', light: '#dc7a0c' },
  { id: 'pink', label: 'Pink', dark: '#ff5fa8', light: '#d6337f' },
  { id: 'blue', label: 'Blue', dark: '#5aa9ff', light: '#1f6fd1' },
  { id: 'green', label: 'Green', dark: '#47d18c', light: '#128a52' },
  { id: 'violet', label: 'Violet', dark: '#a98bff', light: '#6a4fd8' },
];

interface Appearance {
  theme: ThemeChoice;
  accent: Accent;
}
const KEY = 'kf.appearance';
const DEFAULT: Appearance = { theme: 'dark', accent: 'orange' };

function load(): Appearance {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Appearance> | null;
    return {
      theme: a?.theme === 'light' || a?.theme === 'system' ? a.theme : 'dark',
      accent: ACCENTS.some((x) => x.id === a?.accent) ? (a!.accent as Accent) : 'orange',
    };
  } catch {
    return DEFAULT;
  }
}

const systemLight = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
export const resolvedTheme = (t: ThemeChoice): 'dark' | 'light' => (t === 'system' ? (systemLight() ? 'light' : 'dark') : t);

export const useAppearance = create<Appearance & { resolved: 'dark' | 'light' }>(() => {
  const a = load();
  return { ...a, resolved: resolvedTheme(a.theme) };
});

const cache = new Map<string, string>();

function apply() {
  const { theme, accent } = useAppearance.getState();
  const resolved = resolvedTheme(theme);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.accent = accent;
  cache.clear();
  if (useAppearance.getState().resolved !== resolved) useAppearance.setState({ resolved });
  window.dispatchEvent(new CustomEvent('kf:theme'));
}

/** Apply the saved appearance (before the first render, so nothing flashes) and follow Windows when asked to. */
export function installAppearance() {
  apply();
  if (typeof matchMedia === 'function')
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (useAppearance.getState().theme === 'system') apply();
    });
}

export function setAppearance(patch: Partial<Appearance>) {
  useAppearance.setState(patch);
  const { theme, accent } = useAppearance.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify({ theme, accent }));
  } catch {
    /* storage unavailable: this session only */
  }
  apply();
}

/** A design token's colour as the browser resolves it now (cached until the theme changes). */
export function tokenColor(name: string): string {
  let v = cache.get(name);
  if (v == null) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cache.set(name, v);
  }
  return v;
}

function rgbOf(c: string): [number, number, number] | null {
  const h = c.replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(h)) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  if (/^[0-9a-f]{6}/i.test(h)) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  const m = c.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** A design token's colour at some opacity, for canvas drawing (tokens are plain colours, not mixes). */
export function tokenRgba(name: string, alpha: number): string {
  alpha = Math.round(alpha * 100) / 100;
  const key = `${name}@${alpha}`;
  let v = cache.get(key);
  if (v == null) {
    const rgb = rgbOf(tokenColor(name)) ?? [128, 128, 128];
    v = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
    cache.set(key, v);
  }
  return v;
}

/** Run when the theme or accent changes (returns the unsubscribe). */
export function onThemeChange(fn: () => void): () => void {
  window.addEventListener('kf:theme', fn);
  return () => window.removeEventListener('kf:theme', fn);
}

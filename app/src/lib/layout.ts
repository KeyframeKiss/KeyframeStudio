import { useSyncExternalStore } from 'react';

/**
 * Workspace layouts: side-panel widths (or hidden) per workspace, compact mode, and named layouts that also
 * remember which tab each panel shows and the window's size/position. All in localStorage (per machine).
 */
export interface PanelSizes {
  left: number;
  right: number;
  leftHidden?: boolean;
  rightHidden?: boolean;
}
export interface SavedLayout {
  name: string;
  sizes: Record<string, PanelSizes>;
  tabs: Record<string, string>;
  compact: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

const DEFAULTS: Record<string, PanelSizes> = { animate: { left: 264, right: 330 }, pose: { left: 264, right: 340 }, look: { left: 264, right: 330 }, shoot: { left: 240, right: 330 } };
const read = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

let sizes: Record<string, PanelSizes> = { ...DEFAULTS, ...read<Record<string, PanelSizes>>('kf.layout.sizes', {}) };
let compact = read<boolean>('kf.layout.compact', false);
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const applyCompact = () => document.documentElement.classList.toggle('compact', compact);
applyCompact();

export function usePanelSizes(ws: string): PanelSizes {
  return useSyncExternalStore(subscribe, () => sizes[ws] ?? DEFAULTS.animate);
}
export function useCompact() {
  return useSyncExternalStore(subscribe, () => compact);
}

export function setPanelSizes(ws: string, patch: Partial<PanelSizes>) {
  const cur = sizes[ws] ?? DEFAULTS.animate;
  const next = { ...cur, ...patch };
  next.left = Math.max(180, Math.min(560, Math.round(next.left)));
  next.right = Math.max(220, Math.min(640, Math.round(next.right)));
  sizes = { ...sizes, [ws]: next };
  write('kf.layout.sizes', sizes);
  emit();
}
export function setCompact(on: boolean) {
  compact = on;
  write('kf.layout.compact', on);
  applyCompact();
  emit();
}

/** Side-panel widths as CSS: in a narrow window they give way (at most 22% / 30% of it) so the center keeps room. */
export const leftCss = (s: PanelSizes) => (s.leftHidden ? '0px' : `min(${s.left}px, 22vw)`);
export const rightCss = (s: PanelSizes) => (s.rightHidden ? '0px' : `min(${s.right}px, 30vw)`);
/** Grid columns for a 3-panel workspace. */
export const columns = (s: PanelSizes) => `${leftCss(s)} minmax(0, 1fr) ${rightCss(s)}`;

// ---------------- named layouts ----------------

export const savedLayouts = () => read<SavedLayout[]>('kf.layout.saved', []);

/** Every panel's remembered tab (TabbedPanel stores them as studioex.tab.<panel>). */
function currentTabs() {
  const tabs: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('studioex.tab.')) tabs[k.slice('studioex.tab.'.length)] = localStorage.getItem(k) ?? '';
    }
  } catch {
    /* storage unavailable */
  }
  return tabs;
}

export async function saveLayout(name: string) {
  const bounds = (await window.studioEx?.getBounds?.().catch(() => undefined)) ?? undefined;
  const list = savedLayouts().filter((l) => l.name !== name);
  list.push({ name, sizes, tabs: currentTabs(), compact, bounds });
  write('kf.layout.saved', list.sort((a, b) => a.name.localeCompare(b.name)));
  emit();
}

export function deleteLayout(name: string) {
  write('kf.layout.saved', savedLayouts().filter((l) => l.name !== name));
  emit();
}

export async function applyLayout(l: SavedLayout) {
  sizes = { ...DEFAULTS, ...l.sizes };
  write('kf.layout.sizes', sizes);
  setCompact(l.compact);
  for (const [panel, tab] of Object.entries(l.tabs)) {
    try {
      localStorage.setItem(`studioex.tab.${panel}`, tab);
    } catch {
      /* storage unavailable */
    }
    window.dispatchEvent(new CustomEvent('studioex:tab', { detail: { panel, tab } }));
  }
  if (l.bounds) await window.studioEx?.setBounds?.(l.bounds).catch(() => {});
  emit();
}

export function resetLayout() {
  sizes = { ...DEFAULTS };
  write('kf.layout.sizes', sizes);
  setCompact(false);
}

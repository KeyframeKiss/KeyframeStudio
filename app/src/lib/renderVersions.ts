/**
 * Render versions: several sizes from one render, each with its own camera framing (the timeline's camera, the
 * timeline's camera shifted and zoomed, or one fixed view). Saved with the scene (scene notes).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/client';

export type Framing =
  | { mode: 'timeline' }
  | { mode: 'adjust'; x: number; y: number; zoom: number }
  | { mode: 'fixed'; pos?: number[]; rot?: number[]; fov?: number };

export interface RenderVersion {
  /** the size tile's name: "1080p", "Vertical", "Screencap"… */
  label: string;
  /** 0 = no size (Screencap's own size, or the window) */
  w: number;
  h: number;
  framing: Framing;
}

export const SIZES: { label: string; w?: number; h?: number; hint: string }[] = [
  { label: 'Window', hint: "Studio's window size" },
  { label: '720p', w: 1280, h: 720, hint: 'HD' },
  { label: '1080p', w: 1920, h: 1080, hint: 'Full HD' },
  { label: '1440p', w: 2560, h: 1440, hint: 'QHD' },
  { label: '4K', w: 3840, h: 2160, hint: 'UHD' },
  { label: 'Square', w: 1080, h: 1080, hint: 'Social posts' },
  { label: 'Vertical', w: 1080, h: 1920, hint: 'Phones, shorts' },
];

export const sameSize = (v: { w: number; h: number }, x: { w?: number; h?: number }) => (v.w || 0) === (x.w || 0) && (v.h || 0) === (x.h || 0);

/** What the plugin's render.start / render.queue take. */
export const toWire = (vs: RenderVersion[]) => vs.map((v) => ({ label: v.label, width: v.w, height: v.h, framing: v.framing }));

/** True when the versions need the versions path (more than one, or a framing of their own). */
export const needsVersions = (vs: RenderVersion[]) => vs.length > 1 || vs.some((v) => v.framing.mode !== 'timeline');

const NOTE = 'render.versions';

/** The scene's render versions (null until loaded / when the scene has none saved). */
export function useRenderVersions() {
  const [versions, setLocal] = useState<RenderVersion[] | null>(null);
  const load = useCallback(() => {
    bridge
      .request<{ value: RenderVersion[] | null }>('notes.get', { key: NOTE })
      .then((r) => setLocal(Array.isArray(r.value) && r.value.length ? r.value : null))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    return bridge.on('notes.changed', load);
  }, [load]);
  const timer = useRef(0);
  const setVersions = useCallback((vs: RenderVersion[] | null) => {
    setLocal(vs);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => bridge.request('notes.set', { key: NOTE, value: vs }).catch(() => undefined), 250);
  }, []);
  return { versions, setVersions };
}

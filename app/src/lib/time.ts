export function formatTime(t: number, fps: number): string {
  const safe = Math.max(0, t);
  const m = Math.floor(safe / 60);
  const s = safe - m * 60;
  const frame = Math.round(safe * fps);
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}  ·  f${frame}`;
}

/** Accepts "12.5", "1:02.5", "f120" / "120f" (frames). Returns seconds or null. */
export function parseTime(text: string, fps: number): number | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  const frameMatch = s.match(/^f?(\d+(?:\.\d+)?)f?$/);
  if ((s.startsWith('f') || s.endsWith('f')) && frameMatch) return Number(frameMatch[1]) / fps;
  if (s.includes(':')) {
    const [m, sec] = s.split(':');
    const v = Number(m) * 60 + Number(sec);
    return Number.isFinite(v) ? v : null;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

export function snapToFrame(t: number, fps: number) {
  return Math.round(t * fps) / fps;
}

/** Pick a "nice" ruler step (seconds) so labels are at least minPx apart. */
export function niceStep(pxPerSec: number, minPx: number, fps: number): number {
  const frame = 1 / fps;
  const candidates = [frame, frame * 2, frame * 5, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const c of candidates) if (c * pxPerSec >= minPx) return c;
  return 600;
}

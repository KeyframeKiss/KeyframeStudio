import { useEffect, useRef } from 'react';

export interface TimeView {
  t0: number; // time at x = pad
  pps: number; // pixels per second
}

/**
 * Horizontal time scrollbar for canvas views. The thumb is the visible window over
 * [0, duration] (extended when scrolled past either end).
 *  - drag the thumb to scroll
 *  - drag either end of the thumb to zoom (like a video editor)
 *  - click the track to jump there; double-click the thumb to fit the whole duration
 * Runs its own rAF loop and writes styles directly, so scrolling never re-renders the sheet.
 */
export function TimeScrollbar({
  getView,
  setView,
  pad,
  duration,
}: {
  getView: () => { view: TimeView; width: number };
  setView: (v: TimeView) => void;
  pad: number;
  duration: () => number;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const range = () => {
    const { view, width } = getView();
    const visStart = view.t0 - pad / view.pps;
    const visEnd = visStart + width / view.pps;
    const lo = Math.min(0, visStart);
    const hi = Math.max(duration(), visEnd, 0.001);
    return { visStart, visEnd, lo, hi, width };
  };

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const track = trackRef.current;
      const thumb = thumbRef.current;
      if (!track || !thumb) return;
      const tw = track.clientWidth;
      const { visStart, visEnd, lo, hi } = range();
      const left = ((visStart - lo) / (hi - lo)) * tw;
      const w = Math.max(24, ((visEnd - visStart) / (hi - lo)) * tw);
      thumb.style.left = `${Math.min(tw - w, Math.max(0, left))}px`;
      thumb.style.width = `${Math.min(tw, w)}px`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = (visStart: number, visEnd: number, width: number) => {
    const span = Math.max(0.02, visEnd - visStart);
    const pps = Math.max(2, Math.min(4000, width / span));
    setView({ pps, t0: visStart + pad / pps });
  };

  const drag = (e: React.PointerEvent, mode: 'move' | 'left' | 'right') => {
    e.stopPropagation();
    e.preventDefault();
    const tw = trackRef.current!.clientWidth;
    const start = range();
    const secPerPx = (start.hi - start.lo) / tw;
    const x0 = e.clientX;
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) * secPerPx;
      if (mode === 'move') apply(start.visStart + dt, start.visEnd + dt, start.width);
      else if (mode === 'left') apply(Math.min(start.visStart + dt, start.visEnd - 0.02), start.visEnd, start.width);
      else apply(start.visStart, Math.max(start.visEnd + dt, start.visStart + 0.02), start.width);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const jump = (e: React.PointerEvent) => {
    if (e.target !== trackRef.current) return;
    const r = trackRef.current!.getBoundingClientRect();
    const { visStart, visEnd, lo, hi, width } = range();
    const center = lo + ((e.clientX - r.left) / r.width) * (hi - lo);
    const half = (visEnd - visStart) / 2;
    apply(center - half, center + half, width);
  };

  return (
    <div className="hscroll" ref={trackRef} onPointerDown={jump} title="Drag to scroll · drag the ends to zoom · double-click to fit">
      <div
        className="hscroll-thumb"
        ref={thumbRef}
        onPointerDown={(e) => drag(e, 'move')}
        onDoubleClick={() => {
          const { width } = getView();
          apply(-0.02 * duration(), duration() * 1.02, width);
        }}
      >
        <span className="hscroll-grip left" onPointerDown={(e) => drag(e, 'left')} />
        <span className="hscroll-grip right" onPointerDown={(e) => drag(e, 'right')} />
      </div>
    </div>
  );
}

/** Draggable vertical scrollbar for the row area. */
export function VScrollbar({ contentH, viewH, scrollY, onScroll, top }: { contentH: number; viewH: number; scrollY: number; onScroll: (y: number) => void; top: number }) {
  const ref = useRef<HTMLDivElement>(null);
  if (contentH <= viewH) return null;
  const trackH = viewH;
  const thumbH = Math.max(24, (viewH / contentH) * trackH);
  const maxScroll = contentH - viewH;
  const thumbTop = (scrollY / maxScroll) * (trackH - thumbH);
  const drag = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const y0 = e.clientY;
    const s0 = scrollY;
    const move = (ev: PointerEvent) => onScroll(Math.max(0, Math.min(maxScroll, s0 + ((ev.clientY - y0) / Math.max(1, trackH - thumbH)) * maxScroll)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  return (
    <div
      className="vscroll"
      ref={ref}
      style={{ top, height: trackH }}
      onPointerDown={(e) => {
        if (e.target !== ref.current) return;
        const r = ref.current!.getBoundingClientRect();
        onScroll(Math.max(0, Math.min(maxScroll, ((e.clientY - r.top - thumbH / 2) / Math.max(1, trackH - thumbH)) * maxScroll)));
      }}
    >
      <div className="vscroll-thumb" style={{ top: thumbTop, height: thumbH }} onPointerDown={drag} />
    </div>
  );
}

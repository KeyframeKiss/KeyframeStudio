import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { liveTime, saveShots, seek, useStore, type Shot } from '../../state/store';
import { byStart, moveShot, problems, snapTime, swapWith, touching, trimShot } from '../../lib/shots';
import { ContextMenu } from '../ContextMenu';
import { Icon } from '../Icon';
import { useAnimationFrame } from '../useAnimationFrame';
import { VIEW_DRAG } from '../CameraPanel';
import { addShotAt, deleteShot, duplicate, fromView, lookThrough, selectShot, shotMenu, splitAtPlayhead, swap } from './actions';

const EDGE = 7; // px: grab a shot's edge to trim it
const SNAP_PX = 8;

type Drag = { id: string; kind: 'move' | 'start' | 'end'; x0: number; orig: Shot[]; moved: boolean; label: string };

/** Ruler ticks: a step that leaves about 70 px between labels. */
function tickStep(pps: number) {
  for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120]) if (s * pps >= 70) return s;
  return 300;
}

/** Shoot › Shots: the shots laid out along the timeline, to move, trim, cut, swap and pick. */
export function ShotTrack() {
  const shots = useStore((s) => s.shots);
  const sel = useStore((s) => s.selShotId);
  const duration = useStore((s) => s.tl?.duration ?? 10);
  const fps = useStore((s) => s.tl?.fps ?? 30);
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const drag = useRef<Drag | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [hint, setHint] = useState<{ x: number; text: string } | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pps = Math.max(1, w / Math.max(0.1, duration));
  const xOf = (t: number) => t * pps;
  const tOf = (x: number) => Math.min(duration, Math.max(0, x / pps));
  const sorted = useMemo(() => byStart(shots), [shots]);
  const issues = useMemo(() => problems(shots), [shots]);
  const step = tickStep(pps);

  const localX = (e: { clientX: number }) => e.clientX - (wrap.current?.getBoundingClientRect().left ?? 0);

  const onDown = (e: React.PointerEvent, s: Shot) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectShot(s.id);
    const x = localX(e);
    const left = xOf(s.start);
    const right = xOf(s.end);
    const kind = right - left > EDGE * 3 && x - left < EDGE ? 'start' : right - left > EDGE * 3 && right - x < EDGE ? 'end' : 'move';
    drag.current = { id: s.id, kind, x0: x, orig: shots, moved: false, label: kind === 'move' ? 'Move shot' : 'Trim shot' };
    wrap.current?.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const x = localX(e);
    if (!d.moved && Math.abs(x - d.x0) < 3) return;
    d.moved = true;
    const me = d.orig.find((s) => s.id === d.id)!;
    const others = d.orig.filter((s) => s.id !== d.id);
    const targets = e.altKey ? [] : [0, duration, liveTime(), ...others.flatMap((s) => [s.start, s.end])];
    const tol = SNAP_PX / pps;
    const dt = (x - d.x0) / pps;
    let next: Shot[];
    if (d.kind === 'move') {
      const len = me.end - me.start;
      // drag past a neighbour's middle: the two swap places
      const ord = byStart(d.orig);
      const i = ord.findIndex((s) => s.id === d.id);
      const pointer = tOf(x);
      const nextShot = ord[i + 1];
      const prevShot = ord[i - 1];
      if (nextShot && dt > 0 && pointer > (nextShot.start + nextShot.end) / 2) {
        next = swapWith(d.orig, d.id, 1);
        d.label = 'Swap shots';
        setHint({ x, text: `Swap with ${nextShot.name}` });
      } else if (prevShot && dt < 0 && pointer < (prevShot.start + prevShot.end) / 2) {
        next = swapWith(d.orig, d.id, -1);
        d.label = 'Swap shots';
        setHint({ x, text: `Swap with ${prevShot.name}` });
      } else {
        let start = snapTime(me.start + dt, fps, targets, tol);
        const end = snapTime(me.start + dt + len, fps, targets, tol);
        // the end landed on something and the start didn't: line the end up instead
        if (Math.abs(start - (me.start + dt)) > Math.abs(end - (me.start + dt + len)) && !targets.some((t) => Math.abs(t - start) < 1e-4)) start = end - len;
        next = moveShot(d.orig, d.id, start, duration);
        d.label = 'Move shot';
        const moved = next.find((s) => s.id === d.id)!;
        setHint({ x, text: `${moved.start.toFixed(2)} – ${moved.end.toFixed(2)} s` });
      }
    } else {
      const edgeT = (d.kind === 'start' ? me.start : me.end) + dt;
      const t = snapTime(edgeT, fps, targets.filter((v) => Math.abs(v - (d.kind === 'start' ? me.end : me.start)) > 1e-4), tol);
      next = trimShot(d.orig, d.id, d.kind, t, duration);
      const ord = byStart(d.orig);
      const i = ord.findIndex((s) => s.id === d.id);
      const shared = d.kind === 'start' ? i > 0 && touching(ord[i - 1], me) : i < ord.length - 1 && touching(me, ord[i + 1]);
      d.label = shared ? 'Move cut' : 'Trim shot';
      const after = next.find((s) => s.id === d.id)!;
      setHint({ x, text: `${shared ? 'Cut' : d.kind === 'start' ? 'Start' : 'End'} ${(d.kind === 'start' ? after.start : after.end).toFixed(2)} s · ${(after.end - after.start).toFixed(2)} s long` });
    }
    useStore.setState({ shots: next }); // shown at once; saved (one undo step) on release
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setHint(null);
    try {
      wrap.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (!d) return;
    if (!d.moved) {
      const s = d.orig.find((x) => x.id === d.id);
      if (s && !(liveTime() >= s.start && liveTime() < s.end)) seek(s.start);
      return;
    }
    const now = useStore.getState().shots;
    if (JSON.stringify(now) === JSON.stringify(d.orig)) return;
    void saveShots(now, d.label);
  };

  const onCancel = () => {
    const d = drag.current;
    drag.current = null;
    setHint(null);
    if (d?.moved) useStore.setState({ shots: d.orig });
  };

  const onKey = (e: React.KeyboardEvent) => {
    const id = useStore.getState().selShotId;
    const k = e.key;
    const i = sorted.findIndex((s) => s.id === id);
    let handled = true;
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && e.altKey && id) void swap(id, k === 'ArrowLeft' ? -1 : 1);
    else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const j = i < 0 ? 0 : Math.min(sorted.length - 1, Math.max(0, i + (k === 'ArrowLeft' ? -1 : 1)));
      if (sorted[j]) {
        selectShot(sorted[j].id);
        seek(sorted[j].start);
      }
    } else if ((k === 'Delete' || k === 'Backspace') && id) void deleteShot(id);
    else if (k.toLowerCase() === 's' && !e.ctrlKey && id) void splitAtPlayhead(id);
    else if (k.toLowerCase() === 'd' && !e.ctrlKey && id) void duplicate(id);
    else if (k === 'Enter' && id) void lookThrough(id);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation(); // not the timeline's own keys (Delete would delete keys there)
    }
  };

  const ticks: number[] = [];
  for (let t = 0; t <= duration + 1e-6 && ticks.length < 400; t += step) ticks.push(Math.round(t * 1000) / 1000);

  return (
    <div className="sq-track-wrap">
      <div
        ref={wrap}
        className="sq-track"
        tabIndex={0}
        role="listbox"
        aria-label="Shots along the timeline"
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          selectShot(null);
          seek(snapTime(tOf(localX(e)), fps));
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('.sq-shot')) return;
          void addShotAt(snapTime(tOf(localX(e)), fps));
        }}
      >
        <div className="sq-ruler" aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="sq-tick" style={{ left: xOf(t) }}>
              {step < 1 ? t.toFixed(step < 0.5 ? 2 : 1) : Math.round(t)}s
            </span>
          ))}
        </div>
        <div className="sq-lane">
          {issues
            .filter((p) => p.kind === 'gap')
            .map((p) => (
              <div key={`g${p.start}`} className="sq-gap" style={{ left: xOf(p.start), width: xOf(p.end) - xOf(p.start) }} title={`No shot ${p.start.toFixed(2)}–${p.end.toFixed(2)} s: the camera stays as it is`} />
            ))}
          {sorted.map((s, i) => {
            const left = xOf(s.start);
            const width = Math.max(4, xOf(s.end) - left);
            const narrow = width < 70;
            return (
              <div
                key={s.id}
                role="option"
                aria-selected={sel === s.id}
                className={`sq-shot st-${s.status ?? 'idea'} ${sel === s.id ? 'sel' : ''} ${dropOn === s.id ? 'drop' : ''} ${narrow ? 'narrow' : ''}`}
                style={{ left, width }}
                onPointerDown={(e) => onDown(e, s)}
                onDoubleClick={() => lookThrough(s.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  selectShot(s.id);
                  setMenu({ x: e.clientX, y: e.clientY, id: s.id });
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(VIEW_DRAG)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                  setDropOn(s.id);
                }}
                onDragLeave={() => setDropOn((x) => (x === s.id ? null : x))}
                onDrop={(e) => {
                  const v = e.dataTransfer.getData(VIEW_DRAG);
                  setDropOn(null);
                  if (v === '') return;
                  e.preventDefault();
                  selectShot(s.id);
                  void fromView(s.id, Number(v));
                }}
                title={`${i + 1}. ${s.name} · ${s.start.toFixed(2)}–${s.end.toFixed(2)} s (${(s.end - s.start).toFixed(2)} s)${s.notes ? `\n${s.notes}` : ''}\nDrag to move · drag an edge to trim · double-click to look through · right-click for more`}
              >
                {s.thumb && <img className="sq-shot-img" src={s.thumb} alt="" draggable={false} />}
                <span className="sq-shot-shade" />
                <span className="sq-shot-n">{i + 1}</span>
                {!narrow && (
                  <span className="sq-shot-text">
                    <b>{s.name}</b>
                    <small>
                      {(s.end - s.start).toFixed(2)} s{s.camMode === 'keys' ? ' · camera keys' : !s.cam ? ' · no camera' : ''}
                    </small>
                  </span>
                )}
                {s.camMode === 'keys' && !narrow && <Icon name="key" size={11} />}
                <span className="sq-edge l" />
                <span className="sq-edge r" />
              </div>
            );
          })}
          {issues
            .filter((p) => p.kind === 'overlap')
            .map((p) => (
              <div key={`o${p.start}${p.a}`} className="sq-overlap" style={{ left: xOf(p.start), width: Math.max(3, xOf(p.end) - xOf(p.start)) }} title="Two shots overlap here — the later one is used" />
            ))}
          {!shots.length && <div className="sq-empty">Double-click here to add a shot at that time, or use + Shot at playhead</div>}
        </div>
        <Playhead pps={pps} />
        {hint && (
          <div className="sq-hint" style={{ left: Math.min(Math.max(hint.x, 60), w - 60) }}>
            {hint.text}
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={shotMenu(menu.id)} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** The playhead line, moved every frame without re-rendering the track. */
function Playhead({ pps }: { pps: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useAnimationFrame(() => {
    if (ref.current) ref.current.style.transform = `translateX(${Math.round(liveTime() * pps)}px)`;
  });
  return <div ref={ref} className="sq-playhead" aria-hidden />;
}

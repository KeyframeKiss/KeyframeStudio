import { useEffect, useRef, useState, type ReactNode } from 'react';
import { bridge } from '../../bridge/client';
import { liveTime, useStore } from '../../state/store';
import { byStart, shotAt } from '../../lib/shots';
import { formatTime } from '../../lib/time';
import { useAnimationFrame } from '../useAnimationFrame';
import { FrameGuidesPanel, useLoadedCamTools } from '../CameraToolsCards';
import { CameraMenu } from '../CameraPanel';
import { Icon } from '../Icon';
import { effMode, lookThrough } from './actions';

const LIVE_KEY = 'kf.monitor.live';
const WIDTH = 640;
const FPS = 12;

/** A small menu under a toolbar button; closes on a click outside or Esc. */
function Pop({ label, icon, title, children, wide }: { label: string; icon: string; title: string; children: ReactNode; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="mon-pop" ref={ref}>
      <button className={`btn small solid ${open ? 'on' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)} title={title}>
        <Icon name={icon} size={12} /> {label}
      </button>
      {open && <div className={`mon-pop-body ${wide ? 'wide' : ''}`}>{children}</div>}
    </div>
  );
}

/**
 * Shoot › Shots: the monitor. What the edit shows at the playhead — through the shot's own camera (Studio's view
 * isn't moved), or Studio's camera for shots driven by keys, first person or follow — with the shot's name,
 * the timecode, its frame and your guides on top. Paused, it shows the shot's picture and costs Studio nothing.
 */
export function Monitor() {
  const status = useStore((s) => s.status);
  const shots = useStore((s) => s.shots);
  const fps = useStore((s) => s.tl?.fps ?? 30);
  const playEdit = useStore((s) => s.liveCuts);
  useStore((s) => s.keyedShots);
  const { t: tools } = useLoadedCamTools();
  const [live, setLive] = useState(() => {
    try {
      return localStorage.getItem(LIVE_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const [size, setSize] = useState<[number, number]>([16, 9]);
  const [got, setGot] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const img = useRef<ImageData | null>(null);
  const decoding = useRef(false);
  const [now, setNow] = useState<{ id: string | null; text: string }>({ id: null, text: '' });

  useEffect(() => {
    const v = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', v);
    return () => document.removeEventListener('visibilitychange', v);
  }, []);

  const streaming = live && visible && status === 'open';
  useEffect(() => {
    if (!streaming) return;
    setGot(false);
    // Play the edit on: the shots' cameras and transitions (what renders); off: Studio's camera as it is
    bridge.request('preview.start', { width: WIDTH, height: 360, matchScreen: true, fps: FPS, format: 'raw', delayed: true, program: playEdit }).catch(() => setLive(false));
    return () => {
      bridge.request('preview.stop').catch(() => {});
    };
  }, [streaming, playEdit]);

  // frames: "SXP" + 'R' (raw RGB24, rows bottom-up) or 'V' (JPEG)
  useEffect(
    () =>
      bridge.on('$binary', async (data) => {
        const buf = data as ArrayBuffer;
        if (buf.byteLength < 24) return;
        const dv = new DataView(buf);
        if (dv.getUint8(0) !== 83 || dv.getUint8(1) !== 88) return;
        const c = canvas.current;
        if (!c) return;
        const w = dv.getInt16(20, true);
        const h = dv.getInt16(22, true);
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
          setSize([w, h]);
        }
        const ctx = c.getContext('2d')!;
        if (dv.getUint8(3) === 82) {
          const src = new Uint8Array(buf, 24);
          if (!img.current || img.current.width !== w || img.current.height !== h) img.current = ctx.createImageData(w, h);
          const d = img.current.data;
          for (let y = 0; y < h; y++) {
            let si = (h - 1 - y) * w * 3;
            let di = y * w * 4;
            for (let x = 0; x < w; x++, si += 3, di += 4) {
              d[di] = src[si];
              d[di + 1] = src[si + 1];
              d[di + 2] = src[si + 2];
              d[di + 3] = 255;
            }
          }
          ctx.putImageData(img.current, 0, 0);
        } else if (!decoding.current) {
          decoding.current = true;
          try {
            const bmp = await createImageBitmap(new Blob([new Uint8Array(buf, 24)], { type: 'image/jpeg' }));
            ctx.drawImage(bmp, 0, 0, w, h);
            bmp.close();
          } finally {
            decoding.current = false;
          }
        }
        setGot(true);
      }),
    [],
  );

  // the shot under the playhead and the timecode, every frame (only re-rendering when the text changes)
  useAnimationFrame(() => {
    const t = liveTime();
    const sh = shotAt(useStore.getState().shots, t);
    const text = formatTime(t, fps);
    if (text !== now.text || (sh?.id ?? null) !== now.id) setNow({ id: sh?.id ?? null, text });
  });

  const sorted = byStart(shots);
  const cur = now.id ? sorted.find((s) => s.id === now.id) : null;
  const n = cur ? sorted.indexOf(cur) + 1 : 0;
  const g = tools?.guides;
  const aspect = (cur?.aspect ?? 0) > 0 ? cur!.aspect! : g?.aspect ?? 0;
  const [w, h] = size;
  // the frame inside the picture (the outside is dimmed), in percent
  let fx = 0,
    fy = 0,
    fw = 100,
    fh = 100;
  if (aspect > 0) {
    const a = w / h;
    if (aspect > a) {
      fh = (a / aspect) * 100;
      fy = (100 - fh) / 2;
    } else {
      fw = (aspect / a) * 100;
      fx = (100 - fw) / 2;
    }
  }
  const lineColor = g ? `rgba(${g.color.slice(0, 3).map((x) => Math.round(x * 255)).join(',')},0.75)` : 'rgba(255,255,255,0.7)';
  const X = (u: number) => fx + (fw * u) / 100;
  const Y = (v: number) => fy + (fh * v) / 100;
  const lines: [number, number, number, number][] = [];
  if (g?.thirds) for (const u of [100 / 3, 200 / 3]) lines.push([X(u), Y(0), X(u), Y(100)], [X(0), Y(u), X(100), Y(u)]);
  if (g?.golden) for (const u of [38.2, 61.8]) lines.push([X(u), Y(0), X(u), Y(100)], [X(0), Y(u), X(100), Y(u)]);
  if (g?.center) lines.push([X(47), Y(50), X(53), Y(50)], [X(50), Y(46), X(50), Y(54)]);
  if (g?.diagonals) lines.push([X(0), Y(0), X(100), Y(100)], [X(100), Y(0), X(0), Y(100)]);

  const showStill = !streaming || !got;
  const still = cur?.thumb;
  const m = cur ? effMode(cur) : null;
  const what = !cur ? 'No shot here' : !playEdit ? 'Play the edit is off' : m === 'keys' ? 'Camera keys' : m === 'pov' ? 'First person' : m === 'follow' ? 'Follow' : cur.cam ? 'Its camera' : 'No camera yet';

  return (
    <section className="mon" aria-label="Monitor">
      <header className="mon-head">
        <b title="What the edit shows at the playhead: the shot's own camera (Studio's view is left alone), or Studio's camera for shots on camera keys, first person or follow. Live streams Studio's picture here and costs Studio a little speed; paused, it shows the shot's picture.">Monitor</b>
        <span className="mon-gap" />
        <button className={`mon-live ${live ? 'on' : ''}`} role="switch" aria-checked={live} onClick={() => {
          setLive(!live);
          try {
            localStorage.setItem(LIVE_KEY, live ? '0' : '1');
          } catch {
            /* storage blocked */
          }
        }} title={live ? 'Live — click to pause (shows the shot’s picture, costs Studio nothing)' : 'Paused — click for a live picture'}>
          <span className="mon-live-dot" />
          {live ? 'Live' : 'Paused'}
        </button>
        <Pop label="Guides" icon="grid" title="Thirds, centre, safe areas… drawn here and in Studio's window (never in renders)" wide>
          <FrameGuidesPanel />
        </Pop>
        <Pop label="Camera" icon="camera" title="Studio's own camera: lens, camera keys, first person / follow, scene cameras, camera moves" wide>
          <CameraMenu />
        </Pop>
      </header>
      <div className="mon-screen" style={{ aspectRatio: `${w} / ${h}` }} onDoubleClick={() => cur && lookThrough(cur.id)} title={cur ? 'Double-click to look through this shot in Studio' : undefined}>
        <canvas ref={canvas} className={showStill ? 'hidden' : ''} />
        {showStill && (still ? <img src={still} alt="" /> : <div className="mon-empty">{status !== 'open' ? 'Not connected' : live ? 'Starting…' : what}</div>)}
        <svg className="mon-over" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {aspect > 0 && (
            <path
              d={`M0 0H100V100H0Z M${fx} ${fy}V${fy + fh}H${fx + fw}V${fy}Z`}
              fill={`rgba(0,0,0,${Math.max(0.35, g?.dim ?? 0.6)})`}
              fillRule="evenodd"
            />
          )}
          {lines.map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={lineColor} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {g?.safe && (
            <>
              <rect x={X(5)} y={Y(5)} width={(fw * 90) / 100} height={(fh * 90) / 100} fill="none" stroke={lineColor} strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
              <rect x={X(10)} y={Y(10)} width={(fw * 80) / 100} height={(fh * 80) / 100} fill="none" stroke={lineColor} strokeWidth={1} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
            </>
          )}
        </svg>
        <div className="mon-badge">
          {cur ? (
            <>
              <i>{n}</i>
              <span>{cur.name}</span>
            </>
          ) : (
            <span>No shot</span>
          )}
        </div>
        <div className="mon-time">{now.text}</div>
        {showStill && streaming === false && cur && <div className="mon-what">{what}</div>}
      </div>
    </section>
  );
}

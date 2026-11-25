import { useEffect, useRef, useState } from 'react';
import { call, useStore } from '../state/store';
import { chroma, histogram, SKIN_LINE, vectorscope, waveform } from '../lib/scopes';
import { Help } from './Help';

type Mode = 'histogram' | 'waveform' | 'parade' | 'vector';
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'histogram', label: 'Histogram', hint: 'How many pixels at each brightness, per colour: bunched at an edge = crushed shadows or clipped highlights' },
  { id: 'waveform', label: 'Waveform', hint: 'Brightness across the picture, left to right: bottom = black, top = white' },
  { id: 'parade', label: 'Parade', hint: 'Red, green and blue waveforms side by side: equal heights in a neutral area = no colour cast' },
  { id: 'vector', label: 'Vectorscope', hint: 'Colour only: further out = more saturated, angle = hue. The line is where skin tones fall' },
];

const W = 360,
  H = 150;
const BG = '#0d0f12';

function load(): Mode {
  try {
    const m = localStorage.getItem('kf.scopes.mode') as Mode | null;
    return m && MODES.some((x) => x.id === m) ? m : 'histogram';
  } catch {
    return 'histogram';
  }
}

/** Pixels of Studio's view (with every effect), small: a JPEG from the bridge decoded in a canvas. */
async function grab(width: number): Promise<{ px: Uint8ClampedArray; w: number; h: number } | null> {
  const b64 = await call<string>('camera.snapshot', { width });
  if (!b64) return null;
  const img = new Image();
  img.src = b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  return { px: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
}

const glow = (n: number, max: number) => Math.min(1, Math.sqrt(n / max) * 1.6);

function draw(cv: HTMLCanvasElement, mode: Mode, src: { px: Uint8ClampedArray; w: number; h: number }) {
  const square = mode === 'vector';
  const w = square ? H : W;
  cv.width = w;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, H);
  const out = ctx.createImageData(w, H);
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * w + x) * 4;
    out.data[i] = Math.min(255, out.data[i] + r);
    out.data[i + 1] = Math.min(255, out.data[i + 1] + g);
    out.data[i + 2] = Math.min(255, out.data[i + 2] + b);
    out.data[i + 3] = 255;
  };
  // background into the buffer
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 13;
    out.data[i + 1] = 15;
    out.data[i + 2] = 18;
    out.data[i + 3] = 255;
  }
  if (mode === 'histogram') {
    const hst = histogram(src.px);
    const top = (n: number) => Math.round(H - 1 - Math.sqrt(n / hst.max) * (H - 4));
    for (let x = 0; x < w; x++) {
      const k = Math.min(255, Math.floor((x * 256) / w));
      const tr = top(hst.r[k]),
        tg = top(hst.g[k]),
        tb = top(hst.b[k]);
      for (let y = 0; y < H; y++) put(x, y, y >= tr ? 150 : 0, y >= tg ? 150 : 0, y >= tb ? 170 : 0);
      const tl = top(hst.l[k]);
      put(x, tl, 120, 120, 120);
    }
  } else if (mode === 'waveform' || mode === 'parade') {
    const parts: { ch: 'l' | 0 | 1 | 2; tint: [number, number, number] }[] =
      mode === 'waveform'
        ? [{ ch: 'l', tint: [150, 235, 160] }]
        : [
            { ch: 0, tint: [255, 90, 80] },
            { ch: 1, tint: [90, 240, 110] },
            { ch: 2, tint: [100, 150, 255] },
          ];
    const pw = Math.floor(w / parts.length);
    parts.forEach((p, n) => {
      const wf = waveform(src.px, src.w, src.h, pw - (parts.length > 1 ? 4 : 0), H, p.ch);
      const cols = pw - (parts.length > 1 ? 4 : 0);
      for (let c = 0; c < cols; c++)
        for (let lv = 0; lv < H; lv++) {
          const v = wf.bins[c * H + lv];
          if (!v) continue;
          const a = glow(v, wf.max);
          put(n * pw + c, H - 1 - lv, p.tint[0] * a, p.tint[1] * a, p.tint[2] * a);
        }
    });
  } else {
    const size = H;
    const vs = vectorscope(src.px, size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const v = vs.bins[y * size + x];
        if (!v) continue;
        const a = glow(v, vs.max);
        // each dot in its own hue, so the scope reads at a glance
        const cb = (x + 0.5) / size - 0.5,
          cr = 0.5 - (y + 0.5) / size;
        const r = 0.5 + 1.5748 * cr * 2,
          g = 0.5 - 0.1873 * cb * 2 - 0.4681 * cr * 2,
          b = 0.5 + 1.8556 * cb * 2;
        put(x, y, Math.max(0.3, r) * 230 * a, Math.max(0.3, g) * 230 * a, Math.max(0.3, b) * 230 * a);
      }
  }
  ctx.putImageData(out, 0, 0);
  // guides
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.font = '9px system-ui';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  if (mode === 'vector') {
    const c = H / 2;
    ctx.beginPath();
    ctx.arc(c, c, c * 0.75 * 2 * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c, 4);
    ctx.lineTo(c, H - 4);
    ctx.moveTo(4, c);
    ctx.lineTo(H - 4, c);
    ctx.stroke();
    // the skin-tone line
    ctx.strokeStyle = 'rgba(255,190,140,0.45)';
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + SKIN_LINE[0] * c * 0.95, c - SKIN_LINE[1] * c * 0.95);
    ctx.stroke();
    // where 75% red, yellow, green, cyan, blue and magenta fall
    for (const [lab, col] of [
      ['R', [191, 0, 0]],
      ['Y', [191, 191, 0]],
      ['G', [0, 191, 0]],
      ['C', [0, 191, 191]],
      ['B', [0, 0, 191]],
      ['M', [191, 0, 191]],
    ] as const) {
      const [cb, cr] = chroma(col[0], col[1], col[2]);
      const x = (cb + 0.5) * H,
        y = (0.5 - cr) * H;
      ctx.strokeRect(x - 3, y - 3, 6, 6);
      ctx.fillText(lab, x + 5, y + 3);
    }
  } else {
    for (const f of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(0, Math.round(H - f * H) + 0.5);
      ctx.lineTo(w, Math.round(H - f * H) + 0.5);
      ctx.stroke();
    }
  }
}

/** Scopes of Studio's view, kept fresh while shown. */
export function ScopesPanel() {
  const status = useStore((s) => s.status);
  const [mode, setModeState] = useState<Mode>(load);
  const [err, setErr] = useState<string | null>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem('kf.scopes.mode', m);
    } catch {
      /* not remembered */
    }
  };
  useEffect(() => {
    if (status !== 'open') return;
    let alive = true;
    let busy = false;
    const tick = async () => {
      if (busy || document.hidden || !cv.current) return;
      busy = true;
      try {
        const src = await grab(400);
        if (alive && src && cv.current) {
          draw(cv.current, mode, src);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      } finally {
        busy = false;
      }
    };
    void tick();
    const t = window.setInterval(tick, 900);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [mode, status]);
  return (
    <div className="scopes">
      <div className="scopes-head">
        <div className="seg" role="tablist" aria-label="Scope">
          {MODES.map((m) => (
            <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'on' : ''} title={m.hint} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <Help text="Read from Studio's view with every effect on, about once a second. Scopes judge the picture by numbers rather than by eye — exposure, clipping, colour casts, skin tones." />
      </div>
      <canvas ref={cv} className={`scopes-canvas ${mode === 'vector' ? 'square' : ''}`} width={W} height={H} />
      {err && <small className="scopes-err">{err}</small>}
    </div>
  );
}

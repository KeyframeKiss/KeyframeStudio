import { useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { toast, useStore } from '../state/store';

/**
 * EXPERIMENTAL live preview (roadmap Phase 3 spike).
 * Studio renders its camera into a texture, JPEG-encodes it and pushes binary frames; dragging here moves
 * Studio's own camera, so the numbers shown are the real round trip of an interactive viewport.
 */

const SIZES: Record<string, [number, number]> = { '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080] };

interface PluginStats {
  sentFps: number;
  renderMs: number;
  readbackMs: number;
  encodeMs: number;
  sendMs: number;
  costMs: number;
  kbPerFrame: number;
  gameFps: number;
}

export function PreviewPanel() {
  const status = useStore((s) => s.status);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Defaults from the Phase 3 benchmark: raw frames cost Studio far less than JPEG (no encode on its main
  // thread), and 720p at 10-15 fps keeps a heavy scene's frame rate drop around 10%.
  const [size, setSize] = useState('720p');
  const [fps, setFps] = useState(15);
  const [format, setFormat] = useState<'raw' | 'jpeg'>('raw');
  const quality = 75;
  const [plugin, setPlugin] = useState<PluginStats | null>(null);
  const [client, setClient] = useState({ fps: 0, latency: 0, inputLatency: 0 });

  // Client-side measurements
  const recv = useRef<number[]>([]);
  const latency = useRef(0);
  const inputLatency = useRef(0);
  const seq = useRef(0);
  const seqSent = useRef(new Map<number, number>());
  const decoding = useRef(false);
  const imgData = useRef<ImageData | null>(null);

  // Start / restart the stream with the chosen settings; stop on close.
  useEffect(() => {
    if (status !== 'open') return;
    const [w, h] = SIZES[size];
    bridge.request('preview.start', { width: w, height: h, fps, quality, format, delayed: true }).catch((e) => toast((e as Error).message, 'error'));
    return () => {
      bridge.request('preview.stop').catch(() => {});
    };
  }, [status, size, fps, format]);

  // Frames
  useEffect(
    () =>
      bridge.on('$binary', async (data) => {
        const buf = data as ArrayBuffer;
        if (buf.byteLength < 24) return;
        const dv = new DataView(buf);
        if (dv.getUint8(0) !== 83 || dv.getUint8(1) !== 88) return; // "SX"
        const captured = dv.getFloat64(8, true);
        const inSeq = dv.getInt32(16, true);
        const now = Date.now();
        latency.current = latency.current ? latency.current * 0.9 + (now - captured) * 0.1 : now - captured;
        if (inSeq > 0 && seqSent.current.has(inSeq)) {
          inputLatency.current = performance.now() - seqSent.current.get(inSeq)!;
          seqSent.current.delete(inSeq);
        }
        recv.current.push(performance.now());
        const c = canvasRef.current;
        if (!c) return;
        const w = dv.getInt16(20, true);
        const h = dv.getInt16(22, true);
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        const ctx = c.getContext('2d')!;
        if (dv.getUint8(3) === 82) {
          // 'R': raw RGB24, rows bottom-up (Unity texture order) -> RGBA top-down
          const src = new Uint8Array(buf, 24);
          if (!imgData.current || imgData.current.width !== w || imgData.current.height !== h) imgData.current = ctx.createImageData(w, h);
          const d = imgData.current.data;
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
          ctx.putImageData(imgData.current, 0, 0);
          return;
        }
        if (decoding.current) return; // still decoding the previous JPEG: skip this one
        decoding.current = true;
        try {
          const bmp = await createImageBitmap(new Blob([new Uint8Array(buf, 24)], { type: 'image/jpeg' }));
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
        } finally {
          decoding.current = false;
        }
      }),
    [],
  );

  // Stats refresh
  useEffect(() => {
    const h = window.setInterval(() => {
      const t = performance.now();
      recv.current = recv.current.filter((x) => t - x < 2000);
      const n = recv.current.length;
      setClient({ fps: n > 1 ? (n - 1) / ((recv.current[n - 1] - recv.current[0]) / 1000) : 0, latency: latency.current, inputLatency: inputLatency.current });
      bridge.request<PluginStats>('preview.stats').then(setPlugin).catch(() => {});
    }, 1000);
    return () => window.clearInterval(h);
  }, []);

  // Mouse: left = orbit, right/middle = pan, wheel = zoom (moves Studio's camera)
  const pending = useRef({ dx: 0, dy: 0, px: 0, py: 0, zoom: 1 });
  const raf = useRef(0);
  const sendMove = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const p = pending.current;
      pending.current = { dx: 0, dy: 0, px: 0, py: 0, zoom: 1 };
      const s = ++seq.current;
      seqSent.current.set(s, performance.now());
      if (seqSent.current.size > 200) seqSent.current.delete(seqSent.current.keys().next().value!);
      bridge.request('preview.orbit', { ...p, seq: s }).catch(() => {});
    });
  };
  const drag = useRef<{ button: number } | null>(null);

  const close = () => useStore.setState({ previewOpen: false });

  return (
    <div className="preview-panel">
      <div className="preview-bar">
        <strong>Live preview</strong>
        <span className="preview-tag">experimental</span>
        <span style={{ flex: 1 }} />
        <select className="input small" value={size} onChange={(e) => setSize(e.target.value)} title="Stream resolution">
          {Object.keys(SIZES).map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <select className="input small" value={fps} onChange={(e) => setFps(Number(e.target.value))} title="Target frame rate">
          {[10, 15, 30, 60].map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
        <select className="input small" value={format} onChange={(e) => setFormat(e.target.value as 'raw' | 'jpeg')} title="Raw: least work for Studio (recommended). JPEG: smaller frames, but Studio spends ~7 ms encoding each one.">
          <option value="raw">Raw</option>
          <option value="jpeg">JPEG</option>
        </select>
        <button className="btn icon" onClick={close} title="Close preview">
          ✕
        </button>
      </div>
      <div className="preview-view">
        <canvas
          ref={canvasRef}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture(e.pointerId);
            drag.current = { button: e.button };
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            if (e.buttons === 0) return void (drag.current = null);
            const h = (e.target as HTMLElement).clientHeight || 1;
            if (drag.current.button === 0) {
              pending.current.dx += e.movementX * 0.3;
              pending.current.dy += e.movementY * 0.3;
            } else {
              pending.current.px += e.movementX / h;
              pending.current.py += e.movementY / h;
            }
            sendMove();
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onWheel={(e) => {
            pending.current.zoom *= e.deltaY > 0 ? 1.1 : 1 / 1.1;
            sendMove();
          }}
        />
        {status !== 'open' && <div className="preview-empty">Waiting for CharaStudio…</div>}
      </div>
      <div className="preview-stats">
        <span title="Frames shown per second here">
          <b>{client.fps.toFixed(0)}</b> fps
        </span>
        <span title="Capture in Studio → shown here">
          <b>{client.latency.toFixed(0)}</b> ms lag
        </span>
        <span title="Mouse move → first frame showing it">
          <b>{client.inputLatency ? client.inputLatency.toFixed(0) : '–'}</b> ms input
        </span>
        {plugin && (
          <>
            <span title={`render ${plugin.renderMs.toFixed(1)} · readback ${plugin.readbackMs.toFixed(1)} · encode ${plugin.encodeMs.toFixed(1)} · send ${plugin.sendMs.toFixed(1)} ms`}>
              <b>{plugin.costMs.toFixed(1)}</b> ms/frame in Studio
            </span>
            <span>
              <b>{plugin.kbPerFrame.toFixed(0)}</b> KB
            </span>
            <span title="CharaStudio's own frame rate">
              Studio <b>{plugin.gameFps.toFixed(0)}</b> fps
            </span>
          </>
        )}
      </div>
    </div>
  );
}

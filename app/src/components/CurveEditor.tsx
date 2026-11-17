import { useEffect, useMemo, useRef, useState } from 'react';
import { evaluate, type Curve, type CurveKey } from '../lib/curve';

const W = 300;
const H = 240;
const M = 22;
const HANDLE = 38;
const TANGENT_LIMIT = 20;
const VALUE_LIMIT = 3;
const clampTan = (t: number) => Math.max(-TANGENT_LIMIT, Math.min(TANGENT_LIMIT, t));

interface Props {
  curve: Curve;
  onCommit: (c: Curve) => void;
  disabled?: boolean;
}

type Drag = { kind: 'point' | 'in' | 'out'; index: number; broken: boolean } | null;

export function CurveEditor({ curve, onCommit, disabled }: Props) {
  const [local, setLocal] = useState<Curve>(curve);
  const [active, setActive] = useState(curve.length > 1 ? 0 : -1);
  const drag = useRef<Drag>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!drag.current) setLocal(curve);
  }, [curve]);

  // Vertical range adapts to overshoot — but is frozen while dragging. Re-fitting mid-drag creates a
  // feedback loop (bigger range → steeper tangent for the same mouse position → bigger range…).
  const fitted = useMemo(() => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i <= 64; i++) {
      const v = evaluate(local, i / 64);
      if (!Number.isFinite(v)) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    lo = Math.max(lo, -VALUE_LIMIT);
    hi = Math.min(hi, VALUE_LIMIT + 1);
    const pad = (hi - lo) * 0.12 + 0.05;
    return [lo - pad, hi + pad] as const;
  }, [local]);
  const frozenRange = useRef<readonly [number, number] | null>(null);
  const [yMin, yMax] = frozenRange.current ?? fitted;

  const sx = W - 2 * M;
  const sy = (H - 2 * M) / (yMax - yMin);
  const X = (t: number) => M + t * sx;
  const Y = (v: number) => H - M - (v - yMin) * sy;
  const invX = (px: number) => (px - M) / sx;
  const invY = (py: number) => (H - M - py) / sy + yMin;

  const pathD = useMemo(() => {
    const parts: string[] = [];
    const N = 160;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      parts.push(`${i ? 'L' : 'M'}${X(t).toFixed(2)},${Y(evaluate(local, t)).toFixed(2)}`);
    }
    return parts.join('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, yMin, yMax]);

  const handlePos = (k: CurveKey, which: 'in' | 'out') => {
    const tan = which === 'out' ? k.outTangent : k.inTangent;
    const dir = which === 'out' ? 1 : -1;
    if (!Number.isFinite(tan)) return { x: X(k.time), y: Y(k.value) - dir * HANDLE * Math.sign(tan || 1) };
    const dx = sx;
    const dy = -tan * sy;
    const len = Math.hypot(dx, dy);
    return { x: X(k.time) + (dir * dx * HANDLE) / len, y: Y(k.value) + (dir * dy * HANDLE) / len };
  };

  const toLocal = (e: React.PointerEvent | PointerEvent) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  };

  const begin = (e: React.PointerEvent, d: NonNullable<Drag>) => {
    if (disabled) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    frozenRange.current = [yMin, yMax];
    drag.current = d;
    setActive(d.index);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (e.buttons === 0) return end();
    const p = toLocal(e);
    setLocal((c) => {
      const next = c.map((k) => ({ ...k }));
      const k = next[d.index];
      if (d.kind === 'point') {
        const isEnd = d.index === 0 || d.index === next.length - 1;
        if (!isEnd) {
          const lo = next[d.index - 1].time + 0.01;
          const hi = next[d.index + 1].time - 0.01;
          k.time = Math.max(lo, Math.min(hi, invX(p.x)));
        }
        k.value = Math.max(-VALUE_LIMIT, Math.min(VALUE_LIMIT + 1, Math.round(invY(p.y) * 1000) / 1000));
        if (e.shiftKey) k.value = Math.round(k.value * 10) / 10;
      } else {
        const px = p.x - X(k.time);
        const py = p.y - Y(k.value);
        const along = d.kind === 'out' ? Math.max(4, px) : Math.min(-4, px);
        const tan = clampTan(-(py / sy) / (along / sx));
        const t = Math.round(tan * 1000) / 1000;
        if (d.kind === 'out') k.outTangent = t;
        else k.inTangent = t;
        if (!d.broken && !e.altKey) {
          if (d.kind === 'out') k.inTangent = t;
          else k.outTangent = t;
        }
      }
      return next;
    });
  };

  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    frozenRange.current = null;
    onCommit(local);
  };

  const addPoint = (e: React.MouseEvent) => {
    if (disabled) return;
    const p = toLocal(e as unknown as React.PointerEvent);
    const t = invX(p.x);
    if (t <= 0.01 || t >= 0.99) return;
    const v = evaluate(local, t);
    const eps = 0.001;
    const slope = (evaluate(local, t + eps) - evaluate(local, t - eps)) / (2 * eps);
    const next = [...local, { time: t, value: v, inTangent: slope, outTangent: slope }].sort((a, b) => a.time - b.time);
    setLocal(next);
    setActive(next.findIndex((k) => k.time === t));
    onCommit(next);
  };

  const removePoint = (i: number) => {
    if (i <= 0 || i >= local.length - 1) return;
    const next = local.filter((_, j) => j !== i);
    setLocal(next);
    setActive(-1);
    onCommit(next);
  };

  const grid = [];
  // Grid step grows with the range so the line count stays small whatever the curve does.
  const gStep = Math.max(0.25, Math.pow(2, Math.ceil(Math.log2(Math.max(1e-6, (yMax - yMin) / 8)))));
  for (let v = Math.ceil(yMin / gStep) * gStep, n = 0; v <= yMax && n < 40; v += gStep, n++) {
    const strong = Math.abs(v) < 1e-6 || Math.abs(v - 1) < 1e-6;
    grid.push(<line key={`h${v}`} x1={M} x2={W - M} y1={Y(v)} y2={Y(v)} stroke={strong ? 'var(--text-3)' : 'var(--line)'} strokeDasharray={strong ? '3 3' : undefined} />);
  }
  for (let t = 0; t <= 1.0001; t += 0.25) grid.push(<line key={`v${t}`} y1={M - 8} y2={H - M + 8} x1={X(t)} x2={X(t)} stroke="var(--line)" />);

  const activeKey = local[active];

  return (
    <div>
      <div className="curve-box">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onDoubleClick={addPoint} style={{ opacity: disabled ? 0.4 : 1 }}>
          {grid}
          <text x={M - 4} y={Y(0) + 3} fontSize={8} fill="var(--text-3)" textAnchor="end">
            A
          </text>
          <text x={M - 4} y={Y(1) + 3} fontSize={8} fill="var(--text-3)" textAnchor="end">
            B
          </text>
          <path d={pathD} fill="none" stroke="var(--accent)" strokeWidth={2} />
          {activeKey &&
            (['in', 'out'] as const).map((which) => {
              if (which === 'in' && active === 0) return null;
              if (which === 'out' && active === local.length - 1) return null;
              const h = handlePos(activeKey, which);
              return (
                <g key={which}>
                  <line x1={X(activeKey.time)} y1={Y(activeKey.value)} x2={h.x} y2={h.y} stroke="var(--accent-2)" strokeWidth={1} />
                  <circle
                    cx={h.x}
                    cy={h.y}
                    r={5}
                    fill="var(--bg-0)"
                    stroke="var(--accent-2)"
                    strokeWidth={1.5}
                    style={{ cursor: 'grab' }}
                    onPointerDown={(e) => begin(e, { kind: which, index: active, broken: e.altKey })}
                  />
                </g>
              );
            })}
          {local.map((k, i) => (
            <rect
              key={i}
              x={X(k.time) - 5}
              y={Y(k.value) - 5}
              width={10}
              height={10}
              rx={2}
              transform={`rotate(45 ${X(k.time)} ${Y(k.value)})`}
              fill={i === active ? 'var(--accent)' : 'var(--text-0)'}
              stroke="var(--bg-0)"
              style={{ cursor: 'move' }}
              onPointerDown={(e) => begin(e, { kind: 'point', index: i, broken: false })}
              onContextMenu={(e) => {
                e.preventDefault();
                removePoint(i);
              }}
            />
          ))}
        </svg>
      </div>
      <div className="hint">
        Drag points/handles · <span className="kbd">Alt</span> breaks tangents · double-click adds a point · right-click removes. A→B is the blend from this key to
        the next.
      </div>
    </div>
  );
}

export function CurveThumb({ curve }: { curve: Curve }) {
  const d = useMemo(() => {
    let lo = 0;
    let hi = 1;
    const pts: number[] = [];
    for (let i = 0; i <= 40; i++) {
      const v = evaluate(curve, i / 40);
      pts.push(v);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    return pts.map((v, i) => `${i ? 'L' : 'M'}${(4 + (i / 40) * 52).toFixed(1)},${(23 - ((v - lo) / (hi - lo)) * 20).toFixed(1)}`).join('');
  }, [curve]);
  return (
    <svg viewBox="0 0 60 26">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.6} />
    </svg>
  );
}

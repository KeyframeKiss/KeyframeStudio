/**
 * A lighting rig at a glance: seen from above (the character in the middle, facing down the picture, each light
 * where it stands, spots with their beam) and from the side (how high each light is). Drawn from the rig's own
 * numbers: az = degrees around from straight in front (positive = the character's right), el = degrees above the
 * head, dist = × the character's height.
 */
export interface DiagramLight {
  role: string;
  type: string;
  az?: number;
  el?: number;
  dist?: number;
  color?: number[];
  intensity?: number;
  angle?: number;
}

const rgb = (c?: number[]) => (c && c.length >= 3 ? `rgb(${c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')})` : '#fff');
const rad = (d: number) => (d * Math.PI) / 180;

export function RigDiagram({ lights, id }: { lights: DiagramLight[]; id: string }) {
  // from above
  const cx = 72;
  const cy = 54;
  const R = 42;
  const top = lights.map((l) => {
    const az = l.az ?? 0;
    const el = l.el ?? 0;
    const r = R * Math.min(1, Math.max(0.42, ((l.dist ?? 1.5) * Math.cos(rad(el))) / 1.6));
    return { l, x: cx - Math.sin(rad(az)) * r, y: cy + Math.cos(rad(az)) * r };
  });
  // from the side: the character faces left
  const sx = 170;
  const head = 40;
  const ground = 98;
  const side = lights.map((l) => {
    const az = l.az ?? 0;
    const el = l.el ?? 0;
    const rr = 24;
    return { l, x: sx - Math.cos(rad(az)) * Math.cos(rad(el)) * rr, y: head - Math.sin(rad(el)) * rr };
  });
  const gid = `rigstage-${id.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <svg className="rig-diagram" viewBox="0 0 210 108" role="img" aria-label={`Lights: ${lights.map((l) => l.role).join(', ')}`}>
      <defs>
        <radialGradient id={gid} cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor="#2a2d36" />
          <stop offset="100%" stopColor="#15161b" />
        </radialGradient>
        {top.map(({ l, x, y }, i) => (
          <linearGradient key={`lg${i}`} id={`${gid}-b${i}`} gradientUnits="userSpaceOnUse" x1={x} y1={y} x2={cx + (cx - x) * 0.4} y2={cy + (cy - y) * 0.4}>
            <stop offset="0%" stopColor={rgb(l.color)} stopOpacity={Math.min(0.6, 0.3 + (l.intensity ?? 1) * 0.1)} />
            <stop offset="100%" stopColor={rgb(l.color)} stopOpacity="0" />
          </linearGradient>
        ))}
        {top.map(({ l }, i) => (
          <radialGradient key={i} id={`${gid}-g${i}`}>
            <stop offset="0%" stopColor={rgb(l.color)} stopOpacity={Math.min(0.9, 0.35 + (l.intensity ?? 1) * 0.25)} />
            <stop offset="100%" stopColor={rgb(l.color)} stopOpacity="0" />
          </radialGradient>
        ))}
      </defs>
      <rect x="0" y="0" width="210" height="108" fill={`url(#${gid})`} />

      {/* from above */}
      <circle cx={cx} cy={cy} r={R} className="rig-ring" />
      <circle cx={cx} cy={cy} r={R * 0.55} className="rig-ring" />
      {top.map(({ l, x, y }, i) => {
        if (l.type !== 'spot') return <circle key={`b${i}`} cx={x} cy={y} r={14 + (l.intensity ?? 1) * 3} fill={`url(#${gid}-g${i})`} />;
        // a beam from the light past the character
        const a = Math.atan2(cy - y, cx - x);
        const half = rad(Math.min(34, Math.max(12, (l.angle ?? 40) / 2)));
        const len = Math.hypot(cx - x, cy - y) + 16;
        const p1 = [x + Math.cos(a - half) * len, y + Math.sin(a - half) * len];
        const p2 = [x + Math.cos(a + half) * len, y + Math.sin(a + half) * len];
        return <path key={`b${i}`} d={`M${x},${y} L${p1[0]},${p1[1]} L${p2[0]},${p2[1]} Z`} fill={`url(#${gid}-b${i})`} />;
      })}
      <ellipse cx={cx} cy={cy - 1} rx={15} ry={6.5} className="rig-body" />
      <circle cx={cx} cy={cy} r={6.5} className="rig-head" />
      <path d={`M${cx - 3},${cy + 5.5} L${cx},${cy + 10} L${cx + 3},${cy + 5.5} Z`} className="rig-nose" />
      {/* higher lights in front, as seen from above */}
      {[...top].sort((p, q) => (p.l.el ?? 0) - (q.l.el ?? 0)).map(({ l, x, y }, i) => (
        <g key={`m${i}`}>
          <circle cx={x} cy={y} r={6.2} fill={rgb(l.color)} className="rig-lamp" />
          <text x={x} y={y + 2.4} className="rig-lamp-label">
            {l.role.slice(0, 1)}
          </text>
        </g>
      ))}
      <text x={cx} y={104} className="rig-caption">
        from above
      </text>

      {/* from the side */}
      <line x1="140" y1={ground} x2="202" y2={ground} className="rig-ground" />
      <line x1={sx} y1={ground} x2={sx} y2={head + 5} className="rig-stick" />
      <circle cx={sx} cy={head} r={5} className="rig-head" />
      <path d={`M${sx - 4.5},${head - 1} L${sx - 8},${head + 1.5} L${sx - 4.5},${head + 3}`} className="rig-nose-side" />
      {side.map(({ l, x, y }, i) => (
        <g key={`s${i}`}>
          <line x1={x} y1={y} x2={sx} y2={head} stroke={rgb(l.color)} className="rig-ray" />
          <circle cx={x} cy={y} r={3.6} fill={rgb(l.color)} className="rig-lamp" />
        </g>
      ))}
      <text x={sx} y={104} className="rig-caption">
        from the side
      </text>
    </svg>
  );
}

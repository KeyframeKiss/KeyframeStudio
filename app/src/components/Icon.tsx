const paths: Record<string, string> = {
  play: 'M5 3.5v9l8-4.5z',
  pause: 'M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z',
  stop: 'M4 4h8v8H4z',
  prevFrame: 'M11.5 3.5v9L5 8zM3.5 3.5h1.5v9H3.5z',
  nextFrame: 'M4.5 3.5v9L11 8zM11 3.5h1.5v9H11z',
  prevKey: 'M12 4v8L7 8zM7 4v8L2 8z',
  nextKey: 'M4 4v8l5-4zM9 4v8l5-4z',
  toStart: 'M3 3.5h1.5v9H3zM13 3.5v9L6 8z',
  chevronRight: 'M6 4l4 4-4 4',
  chevronDown: 'M4 6l4 4 4-4',
  eye: 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8zM8 10.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4z',
  eyeOff: 'M2 2l12 12M6.3 6.4A2.2 2.2 0 009.6 9.7M4 4.6C2.4 5.8 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1.3 0 2.4-.4 3.3-1M7 3.6c.3 0 .7-.1 1-.1 4.1 0 6.5 4.5 6.5 4.5s-.5 1-1.5 2.1',
  key: 'M8 1.8l6.2 6.2L8 14.2 1.8 8z',
  plus: 'M8 3v10M3 8h10',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
  search: 'M7 12A5 5 0 107 2a5 5 0 000 10zM10.6 10.6L14 14',
  magnet: 'M4 2v6a4 4 0 008 0V2M4 5h2.5M9.5 5H12M6.5 2v6a1.5 1.5 0 003 0V2',
  pin: 'M9.5 2l4.5 4.5-2 1-2.5 2.5.5 3-1.5 1-3-3L2 14.5M6 7l3 3',
  undo: 'M5.5 3L2.5 6l3 3M2.5 6H10a3.5 3.5 0 010 7H7',
  redo: 'M10.5 3l3 3-3 3M13.5 6H6a3.5 3.5 0 000 7h3',
  help: 'M6 6a2 2 0 113 1.7c-.6.4-1 .8-1 1.6V10M8 12.2v.3',
  pulse: 'M1.5 8.5h3l1.5-4 3 7.5 1.5-3.5h4',
  fit: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4',
  legacy: 'M2.5 3.5h11v9h-11zM2.5 6h11M5 8.5h6M5 10.5h4',
  check: 'M3.5 8.5l3 3 6-7',
  globe: 'M8 14A6 6 0 108 2a6 6 0 000 12zM2 8h12M8 2c1.7 1.6 2.5 3.6 2.5 6S9.7 12.4 8 14C6.3 12.4 5.5 10.4 5.5 8S6.3 3.6 8 2z',
  // workspaces
  animate: 'M2 4h12v8H2zM2 6.5h12M2 9.5h12M5 4v8M11 4v8',
  pose: 'M8 2.2a1.4 1.4 0 110 2.8 1.4 1.4 0 010-2.8zM8 6v4M8 7l-3.5-1.5M8 7l3.5 2M8 10l-2.5 4M8 10l2.5 4',
  look: 'M8 2a6 6 0 100 12c.9 0 1.3-.6 1-1.4-.3-.8.2-1.6 1.1-1.6H12a2 2 0 002-2A6 6 0 008 2zM5 7.5h.01M6.5 5h.01M9.5 5h.01M11 7.5h.01',
  library: 'M2.5 2.5h3v11h-3zM6.5 2.5h3v11h-3zM10.5 3l2.8-.7 2 10.8-2.8.6z',
  // tools
  paths: 'M2 12c2-6 4-1 6-5s4-3 6-4M2 12h.01M8 7h.01M14 3h.01',
  folder: 'M2 4.5h4.2l1.4 1.5H14v6.5H2zM2 6h12',
  folderPlus: 'M2 4.5h4.2l1.4 1.5H14v6.5H2zM8 7.5v3.5M6.25 9.25h3.5',
  expandAll: 'M4 3.5l4 3 4-3M4 9l4 3 4-3',
  collapseAll: 'M4 6.5l4-3 4 3M4 12.5l4-3 4 3',
  skeleton: 'M8 1.8a1.4 1.4 0 110 2.8 1.4 1.4 0 010-2.8zM8 4.6v5M4.2 6.6L8 6l3.8.6M8 9.6l-2.6 4.6M8 9.6l2.6 4.6',
  gizmo: 'M4 12V3.5M4 12h8.5M4 12l5-5M2.5 5L4 3.5 5.5 5M11 10.5l1.5 1.5-1.5 1.5M7 7h2v2',
  ghost: 'M4 14V7a4 4 0 018 0v7l-1.5-1.2L9 14l-1-1.2L7 14l-1.5-1.2zM6.5 7.5h.01M9.5 7.5h.01',
  funnel: 'M2.5 3h11L9.5 8v4.5l-3 1.5V8z',
  target: 'M8 13A5 5 0 108 3a5 5 0 000 10zM8 1v3M8 12v3M1 8h3M12 8h3',
  follow: 'M3 8h8M8 5l3 3-3 3M13 3v10',
  attach: 'M8 2v5M8 7l-4 4M8 7l4 4M4 11v2M12 11v2',
  command: 'M5.5 2.5a2 2 0 100 4h5a2 2 0 100-4 2 2 0 00-2 2v7a2 2 0 102-2h-5a2 2 0 100 4 2 2 0 002-2v-7a2 2 0 00-2-2z',
  settings: 'M8 10a2 2 0 100-4 2 2 0 000 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  sliders: 'M2 4h7M12 4h2M2 12h3M8 12h6M10.5 2.5v3M6.5 10.5v3',
  camera: 'M2 5h3l1-1.5h4L11 5h3v8H2zM8 11a2 2 0 100-4 2 2 0 000 4z',
  scissors: 'M4.5 6a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6zM4.5 13.6a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6zM6 5.2L14 12M6 10.8L14 4',
  tracks: 'M2 4h12M2 8h12M2 12h12M5 3v2M10 7v2M7 11v2',
  record: 'M8 12a4 4 0 100-8 4 4 0 000 8z',
  bolt: 'M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z',
  sparkle: 'M8 1.5l1.5 4.5 4.5 1.5-4.5 1.5L8 13.5 6.5 9 2 7.5l4.5-1.5zM13 11l.6 1.4L15 13l-1.4.6L13 15l-.6-1.4L11 13l1.4-.6z',
  translate: 'M2 3h7M5.5 3v1.5c0 2.5-1.5 4.5-3.5 5.5M4 6.5c.8 1.6 2.3 2.9 4 3.5M9.5 14l2.5-6 2.5 6M10.4 12h3.2',
  keyboard: 'M1.5 4.5h13v7h-13zM4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6',
  scenes: 'M2 3h12v10H2zM2 10l3.5-3 3 2.5L11 7l3 3',
  grid: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
};

const filled = new Set(['play', 'pause', 'stop', 'prevFrame', 'nextFrame', 'prevKey', 'nextKey', 'toStart', 'key', 'record', 'bolt']);

export function Icon({ name, size = 16 }: { name: keyof typeof paths | string; size?: number }) {
  const d = paths[name];
  if (!d) return null;
  const fill = filled.has(name);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={d}
        fill={fill ? 'currentColor' : 'none'}
        stroke={fill ? 'none' : 'currentColor'}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fillRule="evenodd"
      />
    </svg>
  );
}

export function TypeIcon({ type, sex }: { type: string; sex?: number }) {
  const label: Record<string, string> = { Char: sex === 0 ? '♂' : '♀', Item: '◆', Light: '☀', Folder: '▤', Camera: '◉', Route: '↝', RoutePoint: '•' };
  return <span className={`type-icon type-${type}`}>{label[type] ?? '·'}</span>;
}

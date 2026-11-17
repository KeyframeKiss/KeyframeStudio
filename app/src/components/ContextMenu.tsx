import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem =
  | { sep: true }
  | { header: true; label: string }
  | { label: string; kbd?: string; danger?: boolean; action: () => unknown };

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 6),
      y: Math.min(y, window.innerHeight - r.height - 6),
    });
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => {
        if ('sep' in it) return <div key={i} className="menu-sep" />;
        if ('header' in it) return <div key={i} className="menu-label">{it.label}</div>;
        return (
          <div
            key={i}
            className={`menu-item ${it.danger ? 'danger' : ''}`}
            onClick={() => {
              onClose();
              it.action();
            }}
          >
            {it.label}
            {it.kbd && <span className="kbd">{it.kbd}</span>}
          </div>
        );
      })}
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pressable } from '../lib/pressable';

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

  // keyboard: the first item has focus; ↑ ↓ Home End move between items, Enter / Space picks
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, []);
  const move = (e: React.KeyboardEvent) => {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!all.length) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = e.key === 'ArrowDown' ? (at + 1) % all.length : e.key === 'ArrowUp' ? (at - 1 + all.length) % all.length : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : -1;
    if (go < 0) return;
    e.preventDefault();
    all[go].focus();
  };

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

  // on the page itself: inside a moved or animated panel a fixed box is placed relative to that panel
  return createPortal(
    <div className="menu" role="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()} onKeyDown={move}>
      {items.map((it, i) => {
        if ('sep' in it) return <div key={i} className="menu-sep" />;
        if ('header' in it) return <div key={i} className="menu-label">{it.label}</div>;
        return (
          <div
            key={i}
            {...pressable}
            role="menuitem"
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
    </div>,
    document.body,
  );
}

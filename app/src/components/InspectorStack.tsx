import { useEffect, useRef, useState, type ReactNode } from 'react';
import { displayName, useStore } from '../state/store';
import { Icon, TypeIcon } from './Icon';

/**
 * The right-hand side panel: one scrolling column of collapsible groups that follow the selection, instead of
 * a strip of tabs. Each group remembers whether it's open (per workspace).
 */
export function Stack({ children, side = 'right' }: { children: ReactNode; side?: 'left' | 'right' }) {
  return (
    <aside className={`panel ${side}`}>
      <div className="panel-body stack">{children}</div>
    </aside>
  );
}

const groupKey = (ws: string, id: string) => `kf.group.${ws}.${id}`;

/** Open (and scroll to) a group from elsewhere, e.g. a context menu. */
export function revealGroup(ws: string, id: string) {
  try {
    localStorage.setItem(groupKey(ws, id), '1');
  } catch {
    /* storage unavailable */
  }
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('kf:reveal-group', { detail: { ws, id } })));
}

/** A collapsible group. `pinned`: stays at the bottom of the side panel, the other groups scroll behind it. */
export function Group({ ws, id, title, icon, extra, defaultOpen = true, pinned = false, children }: { ws: string; id: string; title: ReactNode; icon?: string; extra?: ReactNode; defaultOpen?: boolean; pinned?: boolean; children: ReactNode }) {
  const key = groupKey(ws, id);
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? defaultOpen : v === '1';
    } catch {
      return defaultOpen;
    }
  });
  const ref = useRef<HTMLDivElement>(null);
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? '0' : '1');
    } catch {
      /* storage unavailable */
    }
  };
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ ws: string; id: string }>).detail;
      if (d.ws !== ws || d.id !== id) return;
      setOpen(true);
      requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    };
    window.addEventListener('kf:reveal-group', on);
    return () => window.removeEventListener('kf:reveal-group', on);
  }, [ws, id]);
  return (
    <div ref={ref} className={`group-box ${open ? 'open' : ''} ${pinned ? 'pinned' : ''}`} data-group={id}>
      <div className="group-head" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle())}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        {icon && <Icon name={icon} size={13} />}
        <span className="group-title">{title}</span>
        {extra && (
          <span className="group-extra" onClick={(e) => e.stopPropagation()}>
            {extra}
          </span>
        )}
      </div>
      {open && <div className="group-content">{children}</div>}
    </div>
  );
}

/** What the panel below is about: the object selected in Studio (+N more). */
export function SelectionHeader({ empty }: { empty?: ReactNode }) {
  const sel = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  useStore((s) => s.showEnglish);
  const node = sel.length ? nodes[sel[0]] : undefined;
  if (!node)
    return empty ? (
      <div className="empty">
        <strong>Nothing selected</strong>
        {empty}
      </div>
    ) : null;
  return (
    <div className="sel-header">
      <TypeIcon type={node.type} sex={node.sex} />
      <b>{displayName(node)}</b>
      {sel.length > 1 && <span className="kbd">+{sel.length - 1} more</span>}
    </div>
  );
}

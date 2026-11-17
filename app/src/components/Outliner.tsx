import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, TypeIcon } from './Icon';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { call, displayName, lsSet, refreshScene, setNodeVisible, showPanel, studioSelect, toast, useStore } from '../state/store';
import type { SceneNode } from '../bridge/types';

type TypeKey = 'Char' | 'Item' | 'Light' | 'Folder' | 'Camera' | 'Route';
const TYPE_FILTERS: { key: TypeKey; label: string; title: string }[] = [
  { key: 'Char', label: '♀', title: 'Characters' },
  { key: 'Item', label: '◆', title: 'Items' },
  { key: 'Light', label: '☀', title: 'Lights' },
  { key: 'Folder', label: '▤', title: 'Folders' },
  { key: 'Camera', label: '◉', title: 'Cameras' },
  { key: 'Route', label: '↝', title: 'Routes' },
];
const typeKey = (t: string): TypeKey | null => (t === 'RoutePoint' ? 'Route' : (TYPE_FILTERS.find((f) => f.key === t)?.key ?? null));

function lsBool(k: string, def: boolean) {
  try {
    const v = localStorage.getItem(k);
    return v == null ? def : v === '1';
  } catch {
    return def;
  }
}

export function Outliner() {
  const nodes = useStore((s) => s.nodes);
  const roots = useStore((s) => s.roots);
  const selection = useStore((s) => s.studioSelection);
  const tracks = useStore((s) => s.tracks);
  useStore((s) => s.showEnglish);

  const [query, setQuery] = useState('');
  // Expanded (not collapsed) set: big scenes start fully collapsed and readable.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showAttach, setShowAttach] = useState(() => lsBool('studioex.outliner.attach', false));
  const [hideHidden, setHideHidden] = useState(() => lsBool('studioex.outliner.hideHidden', false));
  const [animatedOnly, setAnimatedOnly] = useState(false);
  const [follow, setFollow] = useState(() => lsBool('studioex.outliner.follow', true));
  const [types, setTypes] = useState<Set<TypeKey>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);

  const commitRename = async (ids: number[], name: string) => {
    setRenaming(null);
    const n = name.trim();
    if (!n) return;
    const r = await call<{ persists: boolean }>('scene.rename', { ids, name: n });
    if (r && !r.persists) toast('Renamed — install KK_TreeNodeNaming to keep character/item names when saving', 'info');
    refreshScene();
  };
  const anchor = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // reset view state on scene change
  useEffect(() => {
    const reset = () => setExpanded(new Set());
    window.addEventListener('studioex:scene-reset', reset);
    return () => window.removeEventListener('studioex:scene-reset', reset);
  }, []);

  const parentOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const n of Object.values(nodes)) for (const c of n.children) m.set(c, n.id);
    return m;
  }, [nodes]);

  const animated = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of tracks) if (t.oci >= 0) m.set(t.oci, (m.get(t.oci) ?? 0) + 1);
    return m;
  }, [tracks]);

  // Memoized "does this subtree contain a node passing pred" helper.
  const subtreeHas = (pred: (n: SceneNode) => boolean) => {
    const memo = new Map<number, boolean>();
    const visit = (id: number): boolean => {
      const hit = memo.get(id);
      if (hit !== undefined) return hit;
      const n = nodes[id];
      const r = !!n && (pred(n) || n.children.some(visit));
      memo.set(id, r);
      return r;
    };
    return visit;
  };

  const q = query.trim().toLowerCase();
  const filtering = !!q || types.size > 0 || animatedOnly;

  // Characters expose dozens of attach points ("Group: Hair" / "Part: Ponytail") as plain tree nodes:
  // only show those when something real hangs beneath them.
  const hasReal = useMemo(() => subtreeHas((n) => n.type !== 'node'), [nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const matchesSelf = (n: SceneNode) =>
    (!q || `${n.name} ${n.nameEn ?? ''}`.toLowerCase().includes(q)) &&
    (types.size === 0 || (typeKey(n.type) !== null && types.has(typeKey(n.type)!))) &&
    (!animatedOnly || animated.has(n.id));
  const subtreeMatches = useMemo(() => subtreeHas(matchesSelf), [nodes, q, types, animatedOnly, animated]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows: { node: SceneNode; depth: number; hasKids: boolean; open: boolean }[] = [];
  const walk = (id: number, depth: number) => {
    const n = nodes[id];
    if (!n) return;
    if (n.type === 'node' && !showAttach && !hasReal(n.id)) return;
    if (hideHidden && !n.visible) return;
    if (filtering && !subtreeMatches(id)) return;
    const kids = n.children.filter((c) => nodes[c] && (showAttach || nodes[c].type !== 'node' || hasReal(c)));
    const open = filtering ? true : expanded.has(id);
    rows.push({ node: n, depth, hasKids: kids.length > 0, open });
    if (open) kids.forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  const visibleIds = rows.map((r) => r.node.id);
  const sel = new Set(selection);

  // ---------- expansion helpers ----------
  const descendants = (id: number, out: number[] = []) => {
    for (const c of nodes[id]?.children ?? []) {
      out.push(c);
      descendants(c, out);
    }
    return out;
  };
  const setOpen = (ids: number[], open: boolean) =>
    setExpanded((e) => {
      const n = new Set(e);
      ids.forEach((id) => (open ? n.add(id) : n.delete(id)));
      return n;
    });
  const toggle = (id: number) => setOpen([id], !expanded.has(id));
  const expandAll = () => setExpanded(new Set(Object.values(nodes).filter((n) => n.children.length).map((n) => n.id)));
  const collapseAll = () => setExpanded(new Set());
  const reveal = (ids: number[], scroll = true) => {
    const anc: number[] = [];
    for (const id of ids) for (let p = parentOf.get(id); p !== undefined; p = parentOf.get(p)) anc.push(p);
    if (anc.some((a) => !expanded.has(a))) setOpen(anc, true);
    if (scroll && ids.length)
      requestAnimationFrame(() => bodyRef.current?.querySelector(`[data-id="${ids[0]}"]`)?.scrollIntoView({ block: 'nearest' }));
  };

  // Follow Studio's selection: expand ancestors and scroll to it.
  const selKey = selection.join(',');
  useEffect(() => {
    if (follow && selection.length) reveal(selection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, follow]);

  // ---------- selection ----------
  const onRowClick = (e: React.MouseEvent, id: number) => {
    if (e.shiftKey && anchor.current != null) {
      const a = visibleIds.indexOf(anchor.current);
      const b = visibleIds.indexOf(id);
      if (a >= 0 && b >= 0) {
        studioSelect(visibleIds.slice(Math.min(a, b), Math.max(a, b) + 1));
        return;
      }
    }
    anchor.current = id;
    if (e.ctrlKey) {
      if (sel.has(id)) studioSelect(selection.filter((x) => x !== id));
      else studioSelect([id], true);
    } else studioSelect([id]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const cur = selection.length ? selection[selection.length - 1] : null;
    const idx = cur != null ? visibleIds.indexOf(cur) : -1;
    const k = e.key;
    let handled = true;
    if (k === 'ArrowDown') {
      const next = visibleIds[Math.min(visibleIds.length - 1, idx + 1)];
      if (next != null) {
        studioSelect(e.shiftKey && cur != null ? [...selection, next] : [next]);
        anchor.current = next;
        reveal([next]);
      }
    } else if (k === 'ArrowUp') {
      const prev = visibleIds[Math.max(0, idx - 1)];
      if (prev != null) {
        studioSelect(e.shiftKey && cur != null ? [...selection, prev] : [prev]);
        anchor.current = prev;
        reveal([prev]);
      }
    } else if (k === 'ArrowRight' && cur != null) {
      if (e.shiftKey) setOpen([cur, ...descendants(cur)], true);
      else if (!expanded.has(cur) && nodes[cur]?.children.length) setOpen([cur], true);
      else {
        const first = nodes[cur]?.children.find((c) => visibleIds.includes(c));
        if (first != null) studioSelect([first]);
      }
    } else if (k === 'ArrowLeft' && cur != null) {
      if (e.shiftKey) setOpen([cur, ...descendants(cur)], false);
      else if (expanded.has(cur)) setOpen([cur], false);
      else {
        const p = parentOf.get(cur);
        if (p != null) {
          studioSelect([p]);
          reveal([p]);
        }
      }
    } else if (k === 'Home' && visibleIds.length) studioSelect([visibleIds[0]]);
    else if (k === 'End' && visibleIds.length) studioSelect([visibleIds[visibleIds.length - 1]]);
    else if (k === 'h' && cur != null) selection.forEach((id) => setNodeVisible(id, !nodes[id]?.visible));
    else if (k === 'F2' && cur != null && cur >= 0) setRenaming(cur);
    else if (k === '*' && cur != null) setOpen([cur, ...descendants(cur)], true);
    else if (k === 'Escape') studioSelect([]);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation(); // keep arrows from also stepping the timeline
    }
  };

  const contextMenu = (e: React.MouseEvent, n: SceneNode) => {
    e.preventDefault();
    if (!sel.has(n.id)) studioSelect([n.id]);
    const kids = descendants(n.id).filter((id) => nodes[id]?.type !== 'node');
    const items: MenuItem[] = [{ label: displayName(n), header: true }];
    if (n.children.length) {
      items.push({ label: 'Expand all below', kbd: 'Shift →', action: () => setOpen([n.id, ...descendants(n.id)], true) });
      items.push({ label: 'Collapse all below', kbd: 'Shift ←', action: () => setOpen([n.id, ...descendants(n.id)], false) });
    }
    if (kids.length) items.push({ label: `Select children (${kids.length})`, action: () => studioSelect([n.id, ...kids]) });
    items.push({ sep: true });
    if (n.id >= 0) {
      const many = sel.has(n.id) && selection.length > 1;
      items.push({ label: many ? `Rename ${selection.length} objects… (numbered)` : 'Rename…', kbd: 'F2', action: () => setRenaming(n.id) });
    }
    items.push({ label: n.visible ? 'Hide' : 'Show', kbd: 'H', action: () => setNodeVisible(n.id, !n.visible) });
    items.push({
      label: 'Show only this in the dope sheet',
      action: () => {
        studioSelect([n.id]);
        useStore.setState({ filter: 'selected' });
        lsSet('studioex.filter', 'selected');
      },
    });
    if (n.type === 'Char') items.push({ label: 'Open Character panel', action: () => showPanel('pose', 'pose.right', 'character') });
    items.push({ label: 'Add animation track…', action: () => showPanel('animate', 'animate.left', 'tracks') });
    items.push({ sep: true });
    items.push({ label: 'Copy name', action: () => navigator.clipboard?.writeText(displayName(n)) });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const toggleType = (t: TypeKey, solo: boolean) =>
    setTypes((cur) => {
      if (solo) return cur.size === 1 && cur.has(t) ? new Set() : new Set([t]);
      const n = new Set(cur);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });

  const flip = (key: string, v: boolean, setter: (b: boolean) => void) => {
    setter(v);
    lsSet(key, v ? '1' : '0');
  };

  const total = Object.values(nodes).filter((n) => n.type !== 'node').length;

  return (
    <>
      <div style={{ padding: '8px 8px 4px', display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <input className="input search" style={{ minWidth: 0 }} placeholder="Filter objects…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn icon" title="Expand all" onClick={expandAll}>
            <Icon name="chevronDown" size={13} />
          </button>
          <button className="btn icon" title="Collapse all" onClick={collapseAll}>
            <Icon name="chevronRight" size={13} />
          </button>
          <button className="btn icon" title="Reveal selection" onClick={() => reveal(selection)} disabled={!selection.length}>
            <Icon name="target" size={13} />
          </button>
        </div>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`btn ${types.has(f.key) ? 'on' : ''}`}
              style={{ height: 22, minWidth: 24, padding: '0 5px' }}
              title={`${f.title} — click to filter, Alt+click to show only these`}
              onClick={(e) => toggleType(f.key, e.altKey)}
            >
              <span className={`type-${f.key}`}>{f.label}</span>
            </button>
          ))}
          <span style={{ width: 1, height: 16, background: 'var(--line)', margin: '0 2px' }} />
          <button className={`btn ${animatedOnly ? 'on' : ''}`} style={{ height: 22, padding: '0 6px', fontSize: 11 }} title="Only objects that have animation tracks" onClick={() => setAnimatedOnly((v) => !v)}>
            ◆ Anim
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          <button
            className={`btn icon ${follow ? 'on' : ''}`}
            style={{ height: 22, width: 22 }}
            title="Follow selection: expand and scroll to what you select in Studio"
            onClick={() => flip('studioex.outliner.follow', !follow, setFollow)}
          >
            <Icon name="follow" size={12} />
          </button>
          <button
            className={`btn icon ${hideHidden ? 'on' : ''}`}
            style={{ height: 22, width: 22 }}
            title="Hide objects that are hidden in Studio"
            onClick={() => flip('studioex.outliner.hideHidden', !hideHidden, setHideHidden)}
          >
            <Icon name="eyeOff" size={12} />
          </button>
          <button
            className={`btn icon ${showAttach ? 'on' : ''}`}
            style={{ height: 22, width: 22 }}
            title="Show empty character attach points (Group/Part nodes)"
            onClick={() => flip('studioex.outliner.attach', !showAttach, setShowAttach)}
          >
            <Icon name="attach" size={12} />
          </button>
        </div>
      </div>
      <div className="panel-body" ref={bodyRef} tabIndex={0} onKeyDown={onKeyDown} style={{ outline: 'none' }}>
        {rows.length === 0 ? (
          <div className="empty">
            <strong>{roots.length ? 'No matches' : 'Empty scene'}</strong>
            {roots.length ? 'Try a different filter.' : 'Add characters or items in Studio — they show up here.'}
          </div>
        ) : (
          <div className="tree">
            {rows.map(({ node, depth, hasKids, open }) => {
              const count = animated.get(node.id);
              const dim = filtering && !matchesSelf(node);
              return (
                <div
                  key={node.id}
                  data-id={node.id}
                  className={`tree-row ${sel.has(node.id) ? 'selected' : ''} ${node.visible ? '' : 'hidden'}`}
                  style={{ paddingLeft: 6 + depth * 14, opacity: dim ? 0.55 : 1 }}
                  onClick={(e) => onRowClick(e, node.id)}
                  onDoubleClick={() => hasKids && toggle(node.id)}
                  onContextMenu={(e) => contextMenu(e, node)}
                  title={node.nameEn ? `${node.name}\n${node.nameEn}` : node.name}
                >
                  <span
                    className="chev"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (e.shiftKey || e.altKey) setOpen([node.id, ...descendants(node.id)], !open);
                      else toggle(node.id);
                    }}
                    title="Shift/Alt+click: expand or collapse the whole branch"
                  >
                    {hasKids && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />}
                  </span>
                  <TypeIcon type={node.type} sex={node.sex} />
                  {renaming === node.id ? (
                    <input
                      className="input"
                      style={{ height: 20, flex: 1, minWidth: 0 }}
                      autoFocus
                      defaultValue={node.name}
                      onFocus={(e) => e.target.select()}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const ids = sel.has(node.id) && selection.length > 1 ? selection.filter((x) => x >= 0) : [node.id];
                        if (e.target.value.trim() !== node.name) commitRename(ids, e.target.value);
                        else setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') {
                          // Unmounting a focused input can fire blur: restore the name first so it can't commit.
                          (e.target as HTMLInputElement).value = node.name;
                          setRenaming(null);
                        }
                      }}
                    />
                  ) : (
                    <span
                      className="name"
                      onDoubleClick={(e) => {
                        if (node.id < 0) return;
                        e.stopPropagation();
                        setRenaming(node.id);
                      }}
                    >
                      {displayName(node)}
                    </span>
                  )}
                  {hasKids && !open && <span className="sub">{node.children.length}</span>}
                  {count ? <span className="sub" title={`${count} animated track(s)`}>◆{count}</span> : null}
                  <span
                    className={`toggle eye ${node.visible ? '' : 'off'}`}
                    title={node.visible ? 'Hide' : 'Show'}
                    onClick={(e) => {
                      e.stopPropagation();
                      setNodeVisible(node.id, !node.visible);
                    }}
                  >
                    <Icon name={node.visible ? 'eye' : 'eyeOff'} size={14} />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="hint" style={{ padding: '4px 10px 6px', margin: 0, borderTop: '1px solid var(--line-soft)', display: 'flex', gap: 8 }}>
        <span>
          {selection.length ? `${selection.length} selected · ` : ''}
          {rows.length} shown / {total} objects
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <span title="Keyboard: ↑↓ select · ←→ collapse/expand · Shift+→ expand branch · H hide · Esc deselect">⌨ ↑↓←→</span>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}

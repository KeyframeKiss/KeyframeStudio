import { useEffect, useMemo, useState } from 'react';
import { call, displayName, useStore } from '../state/store';

type Named = { name: string; nameEn?: string };
interface Group extends Named {
  id: number;
  categories: (Named & { id: number; clips: (Named & { no: number })[] })[];
}

let cache: Group[] | null = null;

export function AnimationBrowser({
  current,
  onPick,
  onClose,
  embedded,
}: {
  current: { group: number; category: number; no: number };
  onPick: (group: number, category: number, no: number) => void;
  onClose: () => void;
  /** Render inline (Pose workspace) instead of as a dialog. */
  embedded?: boolean;
}) {
  useStore((s) => s.showEnglish);
  const [groups, setGroups] = useState<Group[] | null>(cache);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState(current.group);
  const [category, setCategory] = useState(current.category);

  // Show the cached catalog at once, but refresh it (new English names from auto-translate, reconnects).
  const status = useStore((s) => s.status);
  const translating = useStore((s) => !!s.translateJob);
  useEffect(() => {
    if (status !== 'open' || translating) return;
    call<Group[]>('chara.animations').then((g) => {
      if (!g) return;
      cache = g;
      setGroups(g);
    });
  }, [status, translating]);

  // Embedded in the Pose workspace the current clip arrives after mount: follow it until the user browses.
  useEffect(() => {
    if (group < 0 && current.group >= 0) {
      setGroup(current.group);
      setCategory(current.category);
    }
  }, [current.group, current.category]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e: KeyboardEvent) => !embedded && e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const matches = (n: Named) => `${n.name} ${n.nameEn ?? ''}`.toLowerCase().includes(q);

  const results = useMemo(() => {
    if (!groups || !q) return null;
    const out: { g: Group; c: Group['categories'][number]; clip: Named & { no: number } }[] = [];
    for (const g of groups) for (const c of g.categories) for (const clip of c.clips) if (matches(clip) || matches(c)) out.push({ g, c, clip });
    return out.slice(0, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, q]);

  const g = groups?.find((x) => x.id === group) ?? groups?.[0];
  const c = g?.categories.find((x) => x.id === category) ?? g?.categories[0];
  const isCurrent = (gi: number, ci: number, no: number) => gi === current.group && ci === current.category && no === current.no;

  return (
    <div className={embedded ? 'page' : 'overlay'} onClick={embedded ? undefined : onClose}>
      <div className={embedded ? 'page-inner' : 'dialog'} style={embedded ? undefined : { width: 'min(980px, calc(100vw - 32px))', height: 'min(640px, calc(100vh - 64px))', display: 'flex', flexDirection: 'column', padding: 0 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
          <h2 style={{ margin: 0, flex: 'none' }}>Animations</h2>
          <input className="input" autoFocus placeholder="Search every animation (incl. mods)…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1 }} />
          {!embedded && (
            <button className="btn" onClick={onClose}>
              Close
            </button>
          )}
        </div>
        {!groups ? (
          <div className="empty">Loading catalog…</div>
        ) : results ? (
          <div className="panel-body" style={{ padding: 8 }}>
            {results.map(({ g: rg, c: rc, clip }) => (
              <div key={`${rg.id}/${rc.id}/${clip.no}`} className={`model-row ${isCurrent(rg.id, rc.id, clip.no) ? 'selected' : ''}`} onClick={() => onPick(rg.id, rc.id, clip.no)} onDoubleClick={onClose}>
                <span className="name">{displayName(clip)}</span>
                <span className="sub">
                  {displayName(rg)} › {displayName(rc)}
                </span>
              </div>
            ))}
            {!results.length && <div className="empty">No animations match “{query}”.</div>}
          </div>
        ) : (
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '200px 240px 1fr', minHeight: 0 }}>
            <div className="panel-body" style={{ borderRight: '1px solid var(--line)' }}>
              {groups.map((x) => (
                <div key={x.id} className={`tree-row ${x.id === g?.id ? 'selected' : ''}`} style={{ paddingLeft: 10 }} onClick={() => { setGroup(x.id); setCategory(x.categories[0]?.id ?? 0); }}>
                  <span className="name">{displayName(x)}</span>
                </div>
              ))}
            </div>
            <div className="panel-body" style={{ borderRight: '1px solid var(--line)' }}>
              {g?.categories.map((x) => (
                <div key={x.id} className={`tree-row ${x.id === c?.id ? 'selected' : ''}`} style={{ paddingLeft: 10 }} onClick={() => setCategory(x.id)}>
                  <span className="name">{displayName(x)}</span>
                  <span className="sub">{x.clips.length}</span>
                </div>
              ))}
            </div>
            <div className="panel-body">
              {c?.clips.map((clip) => (
                <div
                  key={clip.no}
                  className={`tree-row ${g && isCurrent(g.id, c.id, clip.no) ? 'selected' : ''}`}
                  style={{ paddingLeft: 10 }}
                  onClick={() => g && onPick(g.id, c.id, clip.no)}
                  onDoubleClick={onClose}
                  title={clip.nameEn ? `${clip.name}\n${clip.nameEn}` : clip.name}
                >
                  <span className="name">{displayName(clip)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="hint" style={{ padding: '8px 16px', borderTop: '1px solid var(--line)', margin: 0 }}>
          Click to preview on the selected character(s) · double-click to apply and close
        </div>
      </div>
    </div>
  );
}

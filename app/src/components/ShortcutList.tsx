import { useState } from 'react';
import { SHORTCUT_GROUPS, SHORTCUTS } from './shortcuts';

/** Every shortcut under a few headings, with a filter: for Settings › Shortcuts and the "?" overlay. */
export function ShortcutList({ autoFocus }: { autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const words = q.trim().toLowerCase();
  const desc = new Map(SHORTCUTS);
  const placed = new Set(SHORTCUT_GROUPS.flatMap(([, ks]) => ks));
  const groups: [string, string[]][] = [...SHORTCUT_GROUPS, ['Other', SHORTCUTS.map(([k]) => k).filter((k) => !placed.has(k))]];
  const hit = (k: string) => !words || `${k} ${desc.get(k) ?? ''}`.toLowerCase().includes(words);
  return (
    <div className="shortcut-list">
      <input className="input search" autoFocus={autoFocus} placeholder="Find a shortcut (key, play, undo…)" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="shortcut-groups">
        {groups.map(([title, keys]) => {
          const shown = keys.filter((k) => desc.has(k) && hit(k));
          if (!shown.length) return null;
          return (
            <section key={title} className="shortcut-group">
              <h3>{title}</h3>
              <div className="shortcut-grid one">
                {shown.map((k) => (
                  <div key={k}>
                    <span>{desc.get(k)}</span>
                    <span className="kbd">{k}</span>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

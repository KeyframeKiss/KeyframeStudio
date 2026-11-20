import { useCallback, useEffect, useMemo, useState } from 'react';
import { call, useStore } from '../state/store';

/** Favorites, tags and last use for scenes, animation clips and looks (stored by the bridge plugin). */
export type LibKind = 'scenes' | 'animations' | 'looks' | 'characters' | 'items';
export interface LibMeta {
  favorite?: boolean;
  tags?: string[];
  lastUsed?: number;
}

const cache: Partial<Record<LibKind, Record<string, LibMeta>>> = {};

export function useLibMeta(kind: LibKind) {
  const status = useStore((s) => s.status);
  const [meta, setMeta] = useState<Record<string, LibMeta>>(cache[kind] ?? {});

  useEffect(() => {
    if (status !== 'open') return;
    call<Record<string, LibMeta>>('lib.meta', { kind }).then((m) => {
      if (!m) return;
      cache[kind] = m;
      setMeta(m);
    });
  }, [kind, status]);

  const update = useCallback(
    async (key: string, patch: { favorite?: boolean; tags?: string[]; used?: boolean }) => {
      const r = await call<LibMeta | null>('lib.setMeta', { kind, key, ...patch });
      if (r === undefined) return;
      setMeta((m) => {
        const n = { ...m };
        if (r) n[key] = r;
        else delete n[key];
        cache[kind] = n;
        return n;
      });
    },
    [kind],
  );

  const allTags = useMemo(() => {
    const count = new Map<string, number>();
    for (const m of Object.values(meta)) for (const t of m.tags ?? []) count.set(t, (count.get(t) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }, [meta]);

  return {
    meta,
    allTags,
    get: (key: string): LibMeta => meta[key] ?? {},
    toggleFavorite: (key: string) => update(key, { favorite: !meta[key]?.favorite }),
    setTags: (key: string, tags: string[]) => update(key, { tags }),
    markUsed: (key: string) => update(key, { used: true }),
  };
}

/** "a, b , c" → ['a','b','c'] */
export const parseTags = (v: string) =>
  v
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

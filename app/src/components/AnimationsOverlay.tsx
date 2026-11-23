import { useEffect, useState } from 'react';
import { bridge } from '../bridge/client';
import { displayName, useStore } from '../state/store';
import { applyAnimation, putClipOnTimeline } from '../lib/animation';
import { AnimationBrowser } from './AnimationBrowser';

/** The animation browser as a window over everything (opened from Ctrl+K, the scene list, the dope sheet). */
export function AnimationsOverlay() {
  const ids = useStore((s) => s.animBrowserFor);
  const nodes = useStore((s) => s.nodes);
  const [current, setCurrent] = useState({ group: -1, category: -1, no: -1 });
  useEffect(() => {
    if (!ids?.length) return;
    bridge
      .request<{ anime: { group: number; category: number; no: number } }>('chara.get', { id: ids[0] })
      .then((c) => setCurrent(c.anime))
      .catch(() => {});
  }, [ids?.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ids?.length) return null;
  return (
    <AnimationBrowser
      current={current}
      title={`Animation for ${ids.map((id) => displayName(nodes[id])).join(', ')}`}
      onClose={() => useStore.setState({ animBrowserFor: null })}
      onPick={async (g, c, n) => {
        if (await applyAnimation(ids, g, c, n)) setCurrent({ group: g, category: c, no: n });
      }}
      onTimeline={async (g, c, n) => {
        const same = g === current.group && c === current.category && n === current.no;
        if (!same && !(await applyAnimation(ids, g, c, n))) return;
        setCurrent({ group: g, category: c, no: n });
        await putClipOnTimeline(ids);
      }}
    />
  );
}

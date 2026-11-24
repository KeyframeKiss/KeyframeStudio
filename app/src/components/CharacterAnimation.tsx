import { useEffect, useState } from 'react';
import { bridge } from '../bridge/client';
import { displayName, useStore } from '../state/store';
import { openAnimations } from '../lib/animation';
import { listenMotion, loadSeq, seqEnd, useMotion } from '../lib/motionSeq';

interface Anime {
  name: string;
  nameEn?: string;
  speed: number;
}

/** Animate › Character animation: the selected character's Studio clip, or its motion from the Motion builder. */
export function CharacterAnimationPanel({ id }: { id: number }) {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  useStore((s) => s.showEnglish);
  const seq = useMotion((s) => s.seqs[id]);
  const [anime, setAnime] = useState<Anime | null>(null);

  useEffect(() => {
    if (status !== 'open') return;
    listenMotion();
    void loadSeq(id);
    let live = true;
    bridge
      .request<{ anime: Anime }>('chara.get', { id })
      .then((c) => live && setAnime(c.anime))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, status, revision]);

  return (
    <div className="char-anim">
      <div className="char-anim-clip">
        <div className="char-anim-name" title={anime?.name}>
          {seq?.blocks.length ? `Motion · ${seq.blocks.length} block${seq.blocks.length > 1 ? 's' : ''}` : anime ? displayName(anime) : '…'}
          <span className="char-anim-state">
            {seq?.blocks.length ? `Motion builder, ${seqEnd(seq).toFixed(2)} s` : anime && anime.speed > 0.001 ? 'Studio clip, playing' : 'Studio clip'}
          </span>
        </div>
        {!seq?.blocks.length && (
          <button className="btn small solid" disabled={status !== 'open'} onClick={() => openAnimations([id])} title="Pick another Studio animation for this character">
            Change…
          </button>
        )}
      </div>
    </div>
  );
}

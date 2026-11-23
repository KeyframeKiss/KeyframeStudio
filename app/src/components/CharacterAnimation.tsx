import { useEffect, useState } from 'react';
import { bridge } from '../bridge/client';
import { displayName, liveTime, useStore } from '../state/store';
import { BAKE_PARTS, bakeClip, openAnimations, putClipOnTimeline, type BakePart, type ClipTimeline } from '../lib/animation';
import { Help } from './Help';
import { NumberField } from './TopBar';

interface Anime {
  name: string;
  nameEn?: string;
  speed: number;
  group: number;
}

/**
 * Animate › Character animation: the Studio clip on the selected character — change it, put it on the timeline
 * (so it plays, scrubs and renders with everything else) and bake it into bone keys to edit.
 */
export function CharacterAnimationPanel({ id }: { id: number }) {
  const status = useStore((s) => s.status);
  const tl = useStore((s) => s.tl);
  const revision = useStore((s) => s.revision);
  const playhead = useStore((s) => Math.round((s.tl?.time ?? 0) * 100) / 100);
  useStore((s) => s.showEnglish);
  const [anime, setAnime] = useState<Anime | null>(null);
  const [info, setInfo] = useState<ClipTimeline | null>(null);
  const [parts, setParts] = useState<BakePart[]>(['body', 'neck', 'hands']);
  const [t0, setT0] = useState(0);
  const [t1, setT1] = useState(tl?.duration ?? 10);
  const [busy, setBusy] = useState<'put' | 'bake' | null>(null);
  const fps = tl?.fps ?? 30;
  const dur = tl?.duration ?? 10;
  const snap = (t: number) => Math.min(dur, Math.max(0, Math.round(t * fps) / fps));

  useEffect(() => {
    if (status !== 'open') return;
    let live = true;
    bridge
      .request<{ anime: Anime }>('chara.get', { id })
      .then((c) => live && setAnime(c.anime))
      .catch(() => {});
    bridge
      .request<ClipTimeline>('anim.timeline', { id })
      .then((r) => live && setInfo(r))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [id, status, revision]);

  // a new character: bake its whole timeline unless a stretch is picked
  useEffect(() => {
    setT0(0);
    setT1(dur);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (t1 > dur) setT1(dur);
  }, [dur]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = (v: number) => `${v.toFixed(2)} s`;
  const parse = (s: string) => {
    const v = Number(s.replace(/s$/i, '').trim());
    return Number.isFinite(v) ? snap(v) : null;
  };
  const off = status !== 'open' || !tl;
  const driven = !!info?.driven;
  const segs = info?.segments ?? [];
  const valid = t1 - t0 >= 1 / fps - 1e-6;
  const name = anime ? displayName(anime) : '…';

  const togglePart = (p: BakePart) => setParts((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  const put = async () => {
    setBusy('put');
    try {
      await putClipOnTimeline([id]);
    } finally {
      setBusy(null);
    }
  };
  const bake = async () => {
    setBusy('bake');
    try {
      await bakeClip(id, t0, t1, parts);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="char-anim">
      <div className="char-anim-clip">
        <div className="char-anim-name" title={anime?.name}>
          {name}
          <span className="char-anim-state">
            {driven ? 'Plays with the timeline' : anime && anime.speed > 0.001 ? 'Plays on its own — not tied to the timeline' : 'Stopped'}
          </span>
        </div>
        <button className="btn small solid" disabled={off} onClick={() => openAnimations([id])} title="Pick another Studio animation for this character">
          Change…
        </button>
      </div>

      {segs.length > 0 && (
        <div className="char-anim-segs">
          {segs.map((s) => (
            <button
              key={s.t0}
              className={`char-anim-seg ${t0 === snap(s.t0) && t1 === snap(s.t1) ? 'on' : ''}`}
              onClick={() => (setT0(snap(s.t0)), setT1(snap(s.t1)))}
              title={`“${s.name}” from ${fmt(s.t0)} to ${fmt(s.t1)} — click to bake this stretch`}
            >
              <span className="name">{s.name}</span>
              <span className="sub">
                {s.t0.toFixed(2)}–{s.t1.toFixed(2)} s
              </span>
            </button>
          ))}
        </div>
      )}

      <button
        className="btn primary wide"
        disabled={off || !!busy || !anime}
        onClick={put}
        title="Keys this clip on Timeline's Animation tracks to start at the playhead and run to the next clip (or the end). It plays, scrubs and renders in step with the timeline. Ctrl+Z undoes it."
      >
        {busy === 'put' ? 'Putting it on the timeline…' : `Put on the timeline at ${playhead.toFixed(2)} s`}
      </button>

      <div className="section char-anim-bake">
        <h3>
          Bake to bone keys
          <Help text="Turns the clip's motion over the range into ordinary FK keys you can edit: each bone gets only as many keys as it takes to stay within half a degree of the clip. The clip stays on the timeline underneath (it still moves the hips through space); FK takes over the baked parts. One undo step." />
        </h3>
        <div className="seg char-anim-parts">
          {BAKE_PARTS.map((p) => (
            <button key={p.id} className={parts.includes(p.id) ? 'on' : ''} onClick={() => togglePart(p.id)} aria-pressed={parts.includes(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="cleanup-row">
          <span>From</span>
          <NumberField value={t0} format={fmt} parse={parse} onCommit={(v) => setT0(Math.min(v, t1))} />
          <button className="btn small solid" onClick={() => setT0(Math.min(snap(liveTime()), t1))} title="Start at the playhead">
            Playhead
          </button>
        </div>
        <div className="cleanup-row">
          <span>To</span>
          <NumberField value={t1} format={fmt} parse={parse} onCommit={(v) => setT1(Math.max(v, t0))} />
          <button className="btn small solid" onClick={() => setT1(Math.max(snap(liveTime()), t0))} title="End at the playhead">
            Playhead
          </button>
        </div>
        {(t0 > 0 || t1 < dur) && (
          <button className="btn small solid char-anim-all" onClick={() => (setT0(0), setT1(dur))}>
            Whole timeline (0–{dur.toFixed(2)} s)
          </button>
        )}
        <button
          className="btn primary wide"
          disabled={off || !!busy || !anime || !parts.length || !valid}
          onClick={bake}
          title={!parts.length ? 'Pick at least one part to bake' : `Bake ${name} from ${fmt(t0)} to ${fmt(t1)}`}
        >
          {busy === 'bake' ? 'Baking…' : `Bake ${t0.toFixed(2)}–${t1.toFixed(2)} s`}
        </button>
      </div>
    </div>
  );
}

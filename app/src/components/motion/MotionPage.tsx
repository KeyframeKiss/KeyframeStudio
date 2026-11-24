import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../../bridge/client';
import { call, displayName, liveTime, seek, useStore } from '../../state/store';
import { appended, blockEnd, blockName, clearSeq, listenMotion, loadAll, newId, plays, seqEnd, setSeq, useMotion, type Block, type Seq } from '../../lib/motionSeq';
import { MClipPicker } from './MClipPicker';
import { AnimationBrowser } from '../AnimationBrowser';
import { Help } from '../Help';
import { Icon } from '../Icon';
import { NumberField } from '../TopBar';
import { useAnimationFrame } from '../useAnimationFrame';
import { PosePicker } from './PosePicker';

const LABEL_W = 150;
const EDGE = 7; // px: grab a block's edge to trim it
const SNAP_PX = 10; // px: edges this close snap together (Shift: no snapping)
const lsGet = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* fine */
  }
};

interface Catalog {
  id: number;
  name: string;
  nameEn?: string;
  categories: { id: number; name: string; nameEn?: string; clips: { no: number; name: string; nameEn?: string }[] }[];
}

type Drag = { chara: number; id: string; kind: 'move' | 'len' | 'trim' | 'blend'; x0: number; orig: Block; all: Block[]; moved: boolean };
type Guide = { t: number | null; text: string; x: number };

const fmtT = (v: number) => `${v.toFixed(2)} s`;

function tickStep(pps: number) {
  for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120]) if (s * pps >= 70) return s;
  return 300;
}

/**
 * Animate › Motion: each character's motion as blocks on a lane — Studio clips and poses, one after another, each
 * blending in from the one before. Every change is built into keys (a "Motion" folder on the timeline).
 */
export function MotionPage() {
  const nodes = useStore((s) => s.nodes);
  const status = useStore((s) => s.status);
  const studioSel = useStore((s) => s.studioSelection);
  const duration = useStore((s) => s.tl?.duration ?? 10);
  const fps = useStore((s) => s.tl?.fps ?? 30);
  useStore((s) => s.showEnglish);
  const { seqs, building, lengths, sel } = useMotion();
  const [picker, setPicker] = useState<null | { kind: Block['kind']; replace?: string }>(null);
  const [catalog, setCatalog] = useState<Catalog[] | null>(null);
  const [draft, setDraft] = useState<{ chara: number; blocks: Block[] } | null>(null);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [ripple, setRippleState] = useState(() => lsGet('studioex.motion.ripple', '1') === '1');
  const setRipple = (on: boolean) => (setRippleState(on), lsSet('studioex.motion.ripple', on ? '1' : '0'));
  const [zoom, setZoom] = useState(1);
  const zoomAnchor = useRef<{ t: number; px: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);

  useEffect(() => {
    listenMotion();
    if (status === 'open') void loadAll();
  }, [status]);

  const chars = useMemo(() => Object.values(nodes).filter((n) => n.type === 'Char').sort((a, b) => a.id - b.id), [nodes]);
  // the lanes only exist with a character in the scene (see the early return below): measure them once they do
  const hasLanes = chars.length > 0;
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(100, el.clientWidth - LABEL_W)));
    ro.observe(el);
    setW(Math.max(100, el.clientWidth - LABEL_W));
    return () => ro.disconnect();
  }, [hasLanes]);
  // whose lane is picked: the one clicked here, else the one selected in Studio, else the first
  const chara = sel.chara != null && nodes[sel.chara] ? sel.chara : (studioSel.find((id) => nodes[id]?.type === 'Char') ?? chars[0]?.id ?? null);
  const seq: Seq | undefined = chara != null ? seqs[chara] : undefined;
  const selBlock = seq?.blocks.find((b) => b.id === sel.block) ?? null;

  const span = Math.max(duration, ...Object.values(seqs).map(seqEnd), 1) + 0.5;
  const pps = (w / span) * zoom;
  const xOf = (t: number) => t * pps;
  const snapT = (t: number) => Math.max(0, Math.round(t * fps) / fps);
  const step = tickStep(pps);

  const pick = (c: number, block: string | null) => useMotion.setState({ sel: { chara: c, block } });
  const blocksOf = (c: number) => (draft?.chara === c ? draft.blocks : (seqs[c]?.blocks ?? []));
  const save = (c: number, blocks: Block[], label: string) => setSeq(c, { ...(seqs[c] ?? { blocks: [] }), blocks }, label);
  const update = (patch: Partial<Block>, label = 'Edit motion') => {
    if (chara == null || !seq || !selBlock) return;
    void save(chara, seq.blocks.map((b) => (b.id === selBlock.id ? { ...b, ...patch } : b)), label);
  };

  // clip names for blocks added from the browser
  const clipName = (g: number, c: number, no: number) => {
    const cat = catalog?.find((x) => x.id === g)?.categories.find((x) => x.id === c);
    const clip = cat?.clips.find((x) => x.no === no);
    return clip ? displayName(clip) : `Clip ${g}/${c}/${no}`;
  };
  useEffect(() => {
    if (picker?.kind === 'clip' && !catalog) bridge.request<Catalog[]>('chara.animations').then(setCatalog).catch(() => {});
  }, [picker, catalog]);

  const addOrReplace = (b: Omit<Block, 'id' | 'start' | 'blend' | 'ease'>, label: string) => {
    if (chara == null) return;
    const cur = seqs[chara];
    if (picker?.replace && cur) {
      void save(chara, cur.blocks.map((x) => (x.id === picker.replace ? { ...x, kind: b.kind, clip: b.clip, pose: b.pose, mclip: b.mclip } : x)), 'Replace block');
      return;
    }
    const nb = appended(cur, b);
    void save(chara, [...(cur?.blocks ?? []), nb], label);
    pick(chara, nb.id);
  };

  // ---- dragging blocks: move, trim either edge, blend (the handle at the end of the blend ramp)
  const onDown = (e: React.PointerEvent, c: number, b: Block) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    pick(c, b.id);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left;
    const kind: Drag['kind'] = (e.target as HTMLElement).classList.contains('mo-blend-handle')
      ? 'blend'
      : x > r.width - EDGE
        ? 'len'
        : x < EDGE && r.width > EDGE * 3
          ? 'trim'
          : 'move';
    drag.current = { chara: c, id: b.id, kind, x0: e.clientX, orig: b, all: seqs[c]?.blocks ?? [], moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  /** Everything a dragged edge can snap to: other blocks' edges (all lanes), the start, the playhead, the end. */
  const snapTargets = (skip: Set<string>) => {
    const list: { t: number; what: string }[] = [
      { t: 0, what: 'the start' },
      { t: liveTime(), what: 'the playhead' },
      { t: duration, what: 'the timeline end' },
    ];
    for (const [cid, sq] of Object.entries(seqs))
      for (const x of sq.blocks)
        if (!skip.has(x.id)) {
          const own = Number(cid) === chara ? '' : ` (${displayName(nodes[Number(cid)])})`;
          list.push({ t: x.start, what: `${blockName(x)} start${own}` }, { t: blockEnd(x), what: `${blockName(x)} end${own}` });
        }
    return list;
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const dt = dx / pps;
    const free = e.shiftKey;
    // blocks that ride along with a length change (ripple): the ones after it in its lane
    const follows = ripple && d.kind === 'len' ? d.all.filter((x) => x.id !== d.id && x.start >= blockEnd(d.orig) - 1e-3) : [];
    const targets = snapTargets(new Set([d.id, ...follows.map((x) => x.id)]));
    let snapped: { t: number; what: string } | null = null;
    // snap one or more candidate times (the edges that move); the closest target wins
    const snap = (cands: number[]): number => {
      if (free) return snapT(cands[0]) - cands[0];
      let best: { off: number; t: number; what: string } | null = null;
      for (const c of cands)
        for (const g of targets) {
          const off = g.t - c;
          if (Math.abs(off) * pps < SNAP_PX && (!best || Math.abs(off) < Math.abs(best.off))) best = { off, t: g.t, what: g.what };
        }
      if (best) {
        snapped = { t: best.t, what: best.what };
        return best.off;
      }
      return snapT(cands[0]) - cands[0];
    };
    const o = d.orig;
    let b = o;
    let shift = 0;
    let text = '';
    if (d.kind === 'move') {
      const start = Math.max(0, o.start + dt);
      const off = snap([start, start + o.len]);
      b = { ...o, start: Math.max(0, start + off) };
      text = `${fmtT(b.start)} – ${fmtT(blockEnd(b))}`;
    } else if (d.kind === 'len') {
      const endRaw = blockEnd(o) + dt;
      const end = Math.max(o.start + 1 / fps, endRaw + snap([endRaw]));
      b = { ...o, len: end - o.start, blend: Math.min(o.blend, end - o.start) };
      shift = end - blockEnd(o);
      text = `Length ${fmtT(b.len)}${follows.length ? ` · ${follows.length} after it move along` : ''}`;
    } else if (d.kind === 'trim') {
      const end = blockEnd(o);
      const speed = o.speed ?? 1;
      // a clip can't start before its own beginning
      const earliest = plays(o) ? Math.max(0, o.start - (o.offset ?? 0) / speed) : 0;
      const raw = o.start + dt;
      const start = Math.min(end - 1 / fps, Math.max(earliest, raw + snap([raw])));
      b = { ...o, start, len: end - start, blend: Math.min(o.blend, end - start) };
      if (plays(o)) b.offset = Math.max(0, (o.offset ?? 0) + (start - o.start) * speed);
      text = `Starts ${fmtT(start)} · length ${fmtT(b.len)}`;
    } else {
      const blend = Math.min(o.len, Math.max(0, o.blend + dt));
      const bl = free ? snapT(blend) : Math.min(o.len, Math.max(0, blend + snap([o.start + blend])));
      b = { ...o, blend: bl };
      text = `Blend ${fmtT(b.blend)}`;
    }
    const s0 = snapped as { t: number; what: string } | null;
    if (s0) text += ` · snapped to ${s0.what}`;
    const blocks = d.all.map((x) => (x.id === d.id ? b : follows.some((f) => f.id === x.id) ? { ...x, start: x.start + shift } : x));
    setDraft({ chara: d.chara, blocks });
    const box = wrap.current?.getBoundingClientRect();
    setGuide({ t: s0 ? s0.t : null, text, x: box ? e.clientX - box.left + (wrap.current?.scrollLeft ?? 0) : 0 });
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setGuide(null);
    if (!d?.moved || !draft) return setDraft(null);
    const blocks = draft.blocks;
    setDraft(null);
    void save(d.chara, blocks, d.kind === 'move' ? 'Move block' : d.kind === 'blend' ? 'Change blend' : 'Change block length');
  };

  const remove = (c: number, id: string) => {
    const cur = seqs[c];
    const gone = cur?.blocks.find((x) => x.id === id);
    if (!cur || !gone) return;
    // ripple: blocks right after it close the gap
    const end = blockEnd(gone);
    const closes = ripple && cur.blocks.some((x) => x.id !== id && Math.abs(x.start - end) < 1e-3);
    const blocks = cur.blocks
      .filter((x) => x.id !== id)
      .map((x) => (closes && x.start >= end - 1e-3 ? { ...x, start: Math.max(0, x.start - gone.len) } : x));
    void save(c, blocks, 'Remove block');
    pick(c, null);
  };
  const duplicate = (c: number, b: Block) => {
    const cur = seqs[c];
    if (!cur) return;
    const copy = { ...b, id: newId(), start: seqEnd(cur), blend: Math.max(b.blend, 0.4) };
    void save(c, [...cur.blocks, copy], 'Duplicate block');
    pick(c, copy.id);
  };
  const placeHere = async () => {
    if (chara == null || !seq) return;
    const o = await call<{ transform: { pos: number[] } }>('object.get', { id: chara });
    if (o) void setSeq(chara, { ...seq, anchor: o.transform.pos }, 'Place motion');
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (chara == null || !selBlock || !seq || (e.target as HTMLElement).closest('input')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove(chara, selBlock.id);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // nudge by a frame (Shift: ten)
      e.preventDefault();
      e.stopPropagation();
      const by = ((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1)) / fps;
      update({ start: Math.max(0, snapT(selBlock.start + by)) }, 'Move block');
    }
  };

  // Ctrl + wheel: zoom the lanes around the pointer
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const el = wrap.current;
    if (!el) return;
    const px = e.clientX - el.getBoundingClientRect().left - LABEL_W;
    const t = (px + el.scrollLeft) / pps;
    zoomAnchor.current = { t, px };
    setZoom((z) => Math.min(40, Math.max(1, z * (e.deltaY < 0 ? 1.25 : 0.8))));
  };
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const el = wrap.current;
    if (!a || !el) return;
    zoomAnchor.current = null;
    el.scrollLeft = Math.max(0, a.t * pps - a.px);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // the wheel listener must be non-passive to stop the page zooming
    const el = wrap.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.ctrlKey && e.preventDefault();
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, [hasLanes]);

  const fmt = fmtT;
  const parseS = (s: string) => {
    const v = Number(s.replace(/s$/i, '').trim());
    return Number.isFinite(v) ? v : null;
  };
  const who = chara != null ? displayName(nodes[chara]) : '';
  const busy = chara != null && building[chara] != null;
  const natural = selBlock && plays(selBlock) ? lengths[selBlock.id] : undefined;
  const iconOf = (k: Block['kind']) => (k === 'pose' ? 'pose' : k === 'mclip' ? 'scissors' : 'animate');

  if (!chars.length) return <div className="empty mo-empty">Add a character to the scene to build its motion.</div>;

  return (
    <div className="mo-page" tabIndex={-1} onKeyDown={onKey}>
      <div className="mo-toolbar">
        <b className="mo-who">{who}</b>
        <button className="btn solid" disabled={chara == null} onClick={() => setPicker({ kind: 'clip' })}>
          <Icon name="animate" size={13} /> Add a clip
        </button>
        <button className="btn solid" disabled={chara == null} onClick={() => setPicker({ kind: 'pose' })}>
          <Icon name="pose" size={13} /> Add a pose
        </button>
        <button className="btn solid" disabled={chara == null} onClick={() => setPicker({ kind: 'mclip' })} title="A clip you saved in Animate › Motion clips">
          <Icon name="scissors" size={13} /> Add a motion clip
        </button>
        <button
          className={`btn solid ${ripple ? 'on' : ''}`}
          aria-pressed={ripple}
          onClick={() => setRipple(!ripple)}
          title="Ripple: lengthening, shortening or removing a block moves the blocks after it along, so the sequence stays joined up"
        >
          Ripple {ripple ? 'on' : 'off'}
        </button>
        {zoom > 1.01 && (
          <button className="btn solid" onClick={() => setZoom(1)} title="Show the whole motion (Ctrl + wheel zooms)">
            Zoom {zoom.toFixed(1)}× · fit
          </button>
        )}
        <span className="spacer" />
        <span className="mo-status">
          {busy ? (building[chara!] > 0 ? `Building… ${Math.round(building[chara!] * 100)}%` : 'Building…') : seq?.blocks.length ? `${seq.blocks.length} block${seq.blocks.length > 1 ? 's' : ''} · ${seqEnd(seq).toFixed(2)} s · built` : 'No motion yet'}
        </span>
        <button className="btn solid" disabled={!seq} onClick={placeHere} title="Use where the character stands now as where its motion happens (move it in Studio first)">
          Place here
        </button>
        <button className="btn solid" disabled={!seq} onClick={() => chara != null && clearSeq(chara)} title="Remove this character's motion and its keys (Ctrl+Z brings them back)">
          Clear
        </button>
        <Help text="Add Studio clips and poses: they play one after another on the character's lane. Drag a block to move it, either edge to trim it, and the handle at the top of its ramp to blend in from the block before. Edges snap to other blocks, the playhead and the start (hold Shift to drag freely); ← / → nudge the selected block a frame (Shift: ten); Ctrl + wheel zooms. With Ripple on, the blocks after one move along when it gets longer or shorter or is removed. Every change is built into keys in the timeline's “Motion” folder, so it plays, scrubs and renders like any animation. Edit those keys by hand (in the dope sheet, or posing with FK) and your edits are kept with their block through later changes (✎ on the block). Ctrl+Z undoes each change." />
      </div>

      <div className="mo-lanes" ref={wrap} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel}>
       <div className="mo-content" style={{ width: LABEL_W + span * pps }}>
        <div className="mo-row mo-ruler-row">
          <div className="mo-label" />
          <div className="mo-ruler" onPointerDown={(e) => seek(Math.min(duration, Math.max(0, (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps)))}>
            {Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => i * step).map((t) => (
              <span key={t} className="mo-tick" style={{ left: xOf(t) }}>
                {t % 1 === 0 ? `${t}s` : t.toFixed(2)}
              </span>
            ))}
            {span > duration && <span className="mo-end" style={{ left: xOf(duration) }} title="The end of the timeline (it grows to fit the motion)" />}
          </div>
        </div>
        {chars.map((c) => {
          const blocks = blocksOf(c.id);
          const mine = c.id === chara;
          return (
            <div key={c.id} className={`mo-row ${mine ? 'on' : ''}`}>
              <div className="mo-label" onClick={() => pick(c.id, null)} title="Pick this character's lane">
                <span className="name">{displayName(c)}</span>
                {building[c.id] != null && <span className="mo-dot" title="Building" />}
              </div>
              <div className="mo-track" onPointerDown={() => pick(c.id, null)}>
                {blocks.map((b, i) => {
                  const prev = i > 0;
                  return (
                    <div
                      key={b.id}
                      className={`mo-block ${b.kind} ${mine && b.id === sel.block ? 'sel' : ''}`}
                      style={{ left: xOf(b.start), width: Math.max(6, xOf(b.len)) }}
                      onPointerDown={(e) => onDown(e, c.id, b)}
                      onDoubleClick={() => setPicker({ kind: b.kind, replace: b.id })}
                      title={`${blockName(b)}\n${b.start.toFixed(2)}–${blockEnd(b).toFixed(2)} s${b.blend > 0 && prev ? ` · blends in over ${b.blend.toFixed(2)} s` : ''}\nDrag to move · drag an edge to trim · double-click to replace`}
                    >
                      {prev && b.blend > 0 && <span className="mo-blend" style={{ width: Math.min(xOf(b.blend), xOf(b.len)) }} />}
                      {prev && <span className="mo-blend-handle" style={{ left: Math.min(xOf(b.blend), xOf(b.len)) - 5 }} title="Drag: how long it blends in from the block before" />}
                      <Icon name={iconOf(b.kind)} size={11} />
                      <span className="mo-name">{blockName(b)}</span>
                      {b.mirror && <span className="mo-mirror" title="Mirrored: left and right swapped">⇋</span>}
                      {b.feet && <span className="mo-mirror" title="Feet planted: no sliding while a foot is down">⊥</span>}
                      {b.tweaks && Object.keys(b.tweaks).length > 0 && (
                        <span className="mo-mirror" title={`Your key edits on ${Object.keys(b.tweaks).length} bone${Object.keys(b.tweaks).length > 1 ? 's' : ''} are kept through rebuilds`}>
                          ✎
                        </span>
                      )}
                    </div>
                  );
                })}
                {!blocks.length && mine && <span className="mo-hint">Add a clip or a pose to start {displayName(c)}'s motion</span>}
              </div>
            </div>
          );
        })}
        <Playhead pps={pps} />
        {guide && guide.t != null && <div className="mo-guide" style={{ left: LABEL_W + xOf(guide.t) }} />}
        {guide && (
          <div className="mo-readout" style={{ left: Math.max(LABEL_W + 4, guide.x + 12) }}>
            {guide.text}
          </div>
        )}
       </div>
      </div>

      {chara != null && selBlock && (
        <div className={`mo-inspector ${selBlock.kind}`}>
          <div className="mo-insp-head">
            <span className="mo-insp-icon">
              <Icon name={iconOf(selBlock.kind)} size={14} />
            </span>
            <div className="mo-insp-title">
              <b>{blockName(selBlock)}</b>
              <span className="sub">
                {selBlock.kind === 'clip' ? 'Studio clip' : selBlock.kind === 'mclip' ? 'Motion clip' : 'Pose (held)'}
                <span className="mo-insp-range">
                  {fmt(selBlock.start)} – {fmt(blockEnd(selBlock))}
                </span>
              </span>
            </div>
            <span className="spacer" />
            <button className="btn small solid" onClick={() => setPicker({ kind: selBlock.kind, replace: selBlock.id })}>
              Replace…
            </button>
            <button className="btn small solid" onClick={() => duplicate(chara, selBlock)}>
              Duplicate
            </button>
            <button className="btn small solid danger" onClick={() => remove(chara, selBlock.id)}>
              <Icon name="trash" size={12} />
              Remove
            </button>
          </div>
          <div className="mo-groups">
            <section className="mo-group">
              <h4>Timing</h4>
              <div className="mo-row-fields">
                <label>
                  Starts at
                  <NumberField value={selBlock.start} format={fmt} parse={parseS} onCommit={(v) => update({ start: snapT(v) }, 'Move block')} />
                </label>
                <label>
                  Length
                  <NumberField value={selBlock.len} format={fmt} parse={parseS} onCommit={(v) => update({ len: Math.max(1 / fps, snapT(v)) }, 'Change block length')} />
                </label>
                {natural != null && (
                  <button
                    className="btn small solid mo-fit"
                    onClick={() => update({ len: Math.max(1 / fps, snapT(natural / (selBlock.speed ?? 1))) }, 'Change block length')}
                    title="Make the block one pass of the clip at this speed"
                  >
                    <Icon name="fit" size={12} />
                    Fit {(natural / (selBlock.speed ?? 1)).toFixed(2)} s
                  </button>
                )}
              </div>
            </section>
            {plays(selBlock) && (
              <section className="mo-group">
                <h4>Playback</h4>
                <div className="mo-row-fields">
                  <label>
                    Speed
                    <NumberField value={selBlock.speed ?? 1} format={(v) => `${v.toFixed(2)}×`} parse={(s) => {
                      const v = Number(s.replace(/x|×/gi, '').trim());
                      return Number.isFinite(v) && v > 0 ? Math.min(10, Math.max(0.05, v)) : null;
                    }} onCommit={(v) => update({ speed: v }, 'Change speed')} />
                  </label>
                  <label>
                    Clip starts at
                    <NumberField value={selBlock.offset ?? 0} format={fmt} parse={parseS} onCommit={(v) => update({ offset: Math.max(0, v) }, 'Change clip start')} />
                  </label>
                </div>
              </section>
            )}
            {seq && seq.blocks[0]?.id !== selBlock.id && (
              <section className="mo-group">
                <h4>Blend in</h4>
                <div className="mo-row-fields">
                  <label>
                    Length
                    <NumberField value={selBlock.blend} format={fmt} parse={parseS} onCommit={(v) => update({ blend: Math.min(selBlock.len, Math.max(0, v)) }, 'Change blend')} />
                  </label>
                  <label>
                    Curve
                    <div className="seg mo-ease" title="How the blend moves: smooth eases in and out, linear goes at an even pace">
                      {(['smooth', 'linear'] as const).map((e) => (
                        <button key={e} className={selBlock.ease === e ? 'on' : ''} onClick={() => update({ ease: e }, 'Change blend')}>
                          <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">
                            <path d={e === 'smooth' ? 'M1 11 C 8 11, 10 1, 17 1' : 'M1 11 L 17 1'} />
                          </svg>
                          {e === 'smooth' ? 'Smooth' : 'Linear'}
                        </button>
                      ))}
                    </div>
                  </label>
                </div>
              </section>
            )}
            <section className="mo-group mo-options">
              <h4>Options</h4>
              <div className="mo-row-fields">
                <button
                  className={`mo-option ${selBlock.feet ? 'on' : ''}`}
                  aria-pressed={!!selBlock.feet}
                  onClick={() => update({ feet: !selBlock.feet }, selBlock.feet ? 'Unplant feet' : 'Plant feet')}
                  title="A foot on the ground stays on its spot while it's down: no sliding, and a walk or run on the spot moves across the floor"
                >
                  <span className={`switch ${selBlock.feet ? 'on' : ''}`}>
                    <span />
                  </span>
                  <span className="mo-option-text">
                    <b>Feet planted</b>
                    <span>No sliding while a foot is down</span>
                  </span>
                </button>
                <button
                  className={`mo-option ${selBlock.mirror ? 'on' : ''}`}
                  aria-pressed={!!selBlock.mirror}
                  onClick={() => update({ mirror: !selBlock.mirror }, selBlock.mirror ? 'Unmirror block' : 'Mirror block')}
                  title="Play it as in a mirror: left and right swapped (a right-foot step becomes a left-foot one)"
                >
                  <span className={`switch ${selBlock.mirror ? 'on' : ''}`}>
                    <span />
                  </span>
                  <span className="mo-option-text">
                    <b>Mirror</b>
                    <span>Left and right swapped</span>
                  </span>
                </button>
              </div>
            </section>
          </div>
          {selBlock.tweaks && Object.keys(selBlock.tweaks).length > 0 && (
            <div className="mo-tweaks" title={Object.keys(selBlock.tweaks).join(', ')}>
              <Icon name="key" size={12} />
              Your key edits on {Object.keys(selBlock.tweaks).length} bone{Object.keys(selBlock.tweaks).length > 1 ? 's' : ''} are kept through rebuilds.
              <button className="btn small solid" onClick={() => update({ tweaks: undefined, clearTweaks: true }, 'Clear key edits')}>
                Clear them
              </button>
            </div>
          )}
        </div>
      )}

      {picker?.kind === 'clip' && chara != null && (
        <AnimationBrowser
          current={selBlock?.clip && picker.replace ? { group: selBlock.clip.group, category: selBlock.clip.category, no: selBlock.clip.no } : { group: -1, category: -1, no: -1 }}
          title={picker.replace ? `Replace the clip in ${who}'s motion` : `Add a clip to ${who}'s motion`}
          onClose={() => setPicker(null)}
          onPick={(g, c, no) => {
            const name = clipName(g, c, no);
            addOrReplace({ kind: 'clip', len: 3, speed: 1, offset: 0, clip: { group: g, category: c, no, name } }, 'Add clip');
            setPicker(null);
          }}
        />
      )}
      {picker?.kind === 'mclip' && chara != null && (
        <MClipPicker
          title={picker.replace ? `Replace the motion clip in ${who}'s motion` : `Add a motion clip to ${who}'s motion`}
          onClose={() => setPicker(null)}
          onPick={(m) => {
            addOrReplace({ kind: 'mclip', len: Math.max(1 / fps, Math.round(m.length * fps) / fps), speed: 1, offset: 0, mclip: { file: m.file, name: m.name } }, 'Add motion clip');
            setPicker(null);
          }}
        />
      )}
      {picker?.kind === 'pose' && chara != null && (
        <PosePicker
          title={picker.replace ? `Replace the pose in ${who}'s motion` : `Add a pose to ${who}'s motion`}
          onClose={() => setPicker(null)}
          onPick={(p) => {
            addOrReplace({ kind: 'pose', len: 1.5, pose: { path: p.path, name: displayName(p) } }, 'Add pose');
            setPicker(null);
          }}
        />
      )}
    </div>
  );
}

function Playhead({ pps }: { pps: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useAnimationFrame(() => {
    if (ref.current) ref.current.style.transform = `translateX(${LABEL_W + liveTime() * pps}px)`;
  });
  return <div ref={ref} className="mo-playhead" />;
}

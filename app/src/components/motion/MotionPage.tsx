import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../../bridge/client';
import { call, displayName, liveTime, seek, useStore } from '../../state/store';
import { appended, blockEnd, blockName, clearSeq, listenMotion, loadAll, newId, seqEnd, setSeq, useMotion, type Block, type Seq } from '../../lib/motionSeq';
import { AnimationBrowser } from '../AnimationBrowser';
import { Help } from '../Help';
import { Icon } from '../Icon';
import { NumberField } from '../TopBar';
import { useAnimationFrame } from '../useAnimationFrame';
import { PosePicker } from './PosePicker';

const LABEL_W = 150;
const EDGE = 7; // px: grab a block's right edge to change its length
const SNAP_PX = 8;

interface Catalog {
  id: number;
  name: string;
  nameEn?: string;
  categories: { id: number; name: string; nameEn?: string; clips: { no: number; name: string; nameEn?: string }[] }[];
}

type Drag = { chara: number; id: string; kind: 'move' | 'len' | 'blend'; x0: number; orig: Block; moved: boolean };

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
  const [picker, setPicker] = useState<null | { kind: 'clip' | 'pose'; replace?: string }>(null);
  const [catalog, setCatalog] = useState<Catalog[] | null>(null);
  const [draft, setDraft] = useState<{ chara: number; block: Block } | null>(null);
  const drag = useRef<Drag | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);

  useEffect(() => {
    listenMotion();
    if (status === 'open') void loadAll();
  }, [status]);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(100, el.clientWidth - LABEL_W)));
    ro.observe(el);
    setW(Math.max(100, el.clientWidth - LABEL_W));
    return () => ro.disconnect();
  }, []);

  const chars = useMemo(() => Object.values(nodes).filter((n) => n.type === 'Char').sort((a, b) => a.id - b.id), [nodes]);
  // whose lane is picked: the one clicked here, else the one selected in Studio, else the first
  const chara = sel.chara != null && nodes[sel.chara] ? sel.chara : (studioSel.find((id) => nodes[id]?.type === 'Char') ?? chars[0]?.id ?? null);
  const seq: Seq | undefined = chara != null ? seqs[chara] : undefined;
  const selBlock = seq?.blocks.find((b) => b.id === sel.block) ?? null;

  const span = Math.max(duration, ...Object.values(seqs).map(seqEnd), 1);
  const pps = w / span;
  const xOf = (t: number) => t * pps;
  const snapT = (t: number) => Math.max(0, Math.round(t * fps) / fps);
  const step = tickStep(pps);

  const pick = (c: number, block: string | null) => useMotion.setState({ sel: { chara: c, block } });
  const blocksOf = (c: number) => {
    const list = seqs[c]?.blocks ?? [];
    return draft?.chara === c ? list.map((b) => (b.id === draft.block.id ? draft.block : b)) : list;
  };
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
      void save(chara, cur.blocks.map((x) => (x.id === picker.replace ? { ...x, kind: b.kind, clip: b.clip, pose: b.pose } : x)), 'Replace block');
      return;
    }
    const nb = appended(cur, b);
    void save(chara, [...(cur?.blocks ?? []), nb], label);
    pick(chara, nb.id);
  };

  // ---- dragging blocks: move, length (right edge), blend (the handle at the end of the blend ramp)
  const onDown = (e: React.PointerEvent, c: number, b: Block) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    pick(c, b.id);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left;
    const kind: Drag['kind'] = (e.target as HTMLElement).classList.contains('mo-blend-handle') ? 'blend' : x > r.width - EDGE ? 'len' : 'move';
    drag.current = { chara: c, id: b.id, kind, x0: e.clientX, orig: b, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const dt = dx / pps;
    const others = (seqs[d.chara]?.blocks ?? []).filter((x) => x.id !== d.id);
    const edges = [0, ...others.flatMap((x) => [x.start, blockEnd(x)])];
    const snapEdge = (t: number) => {
      const near = edges.find((x) => Math.abs(x - t) * pps < SNAP_PX);
      return near ?? snapT(t);
    };
    let b = d.orig;
    if (d.kind === 'move') {
      let start = Math.max(0, d.orig.start + dt);
      const s1 = snapEdge(start);
      const s2 = snapEdge(start + d.orig.len) - d.orig.len;
      start = Math.abs(s1 - start) <= Math.abs(s2 - start) ? s1 : Math.max(0, s2);
      b = { ...d.orig, start };
    } else if (d.kind === 'len') {
      const end = Math.max(d.orig.start + 1 / fps, snapEdge(blockEnd(d.orig) + dt));
      b = { ...d.orig, len: end - d.orig.start, blend: Math.min(d.orig.blend, end - d.orig.start) };
    } else {
      b = { ...d.orig, blend: Math.min(d.orig.len, Math.max(0, snapT(d.orig.blend + dt))) };
    }
    setDraft({ chara: d.chara, block: b });
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved || !draft) return setDraft(null);
    const blocks = (seqs[d.chara]?.blocks ?? []).map((x) => (x.id === d.id ? draft.block : x));
    setDraft(null);
    void save(d.chara, blocks, d.kind === 'move' ? 'Move block' : d.kind === 'len' ? 'Change block length' : 'Change blend');
  };

  const remove = (c: number, id: string) => {
    const cur = seqs[c];
    if (!cur) return;
    void save(c, cur.blocks.filter((x) => x.id !== id), 'Remove block');
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && chara != null && selBlock && !(e.target as HTMLElement).closest('input')) {
      e.preventDefault();
      remove(chara, selBlock.id);
    }
  };

  const fmt = (v: number) => `${v.toFixed(2)} s`;
  const parseS = (s: string) => {
    const v = Number(s.replace(/s$/i, '').trim());
    return Number.isFinite(v) ? v : null;
  };
  const who = chara != null ? displayName(nodes[chara]) : '';
  const busy = chara != null && building[chara] != null;
  const natural = selBlock?.kind === 'clip' ? lengths[selBlock.id] : undefined;

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
        <Help text="Add Studio clips and poses: they play one after another on the character's lane. Drag a block to move it, its right edge to change its length, and the handle at the top of its ramp to blend in from the block before (overlap = a smooth change, not a jump). Every change is built into keys in the timeline's “Motion” folder, so it plays, scrubs and renders like any animation. Ctrl+Z undoes each change." />
      </div>

      <div className="mo-lanes" ref={wrap} onPointerMove={onMove} onPointerUp={onUp}>
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
                      title={`${blockName(b)}\n${b.start.toFixed(2)}–${blockEnd(b).toFixed(2)} s${b.blend > 0 && prev ? ` · blends in over ${b.blend.toFixed(2)} s` : ''}\nDrag to move · drag the right edge for length · double-click to replace`}
                    >
                      {prev && b.blend > 0 && <span className="mo-blend" style={{ width: Math.min(xOf(b.blend), xOf(b.len)) }} />}
                      {prev && <span className="mo-blend-handle" style={{ left: Math.min(xOf(b.blend), xOf(b.len)) - 5 }} title="Drag: how long it blends in from the block before" />}
                      <Icon name={b.kind === 'clip' ? 'animate' : 'pose'} size={11} />
                      <span className="mo-name">{blockName(b)}</span>
                    </div>
                  );
                })}
                {!blocks.length && mine && <span className="mo-hint">Add a clip or a pose to start {displayName(c)}'s motion</span>}
              </div>
            </div>
          );
        })}
        <Playhead pps={pps} />
      </div>

      {chara != null && selBlock && (
        <div className="mo-inspector">
          <div className="mo-insp-head">
            <Icon name={selBlock.kind === 'clip' ? 'animate' : 'pose'} size={13} />
            <b>{blockName(selBlock)}</b>
            <span className="sub">{selBlock.kind === 'clip' ? 'Studio clip' : 'Pose (held)'}</span>
            <span className="spacer" />
            <button className="btn small solid" onClick={() => setPicker({ kind: selBlock.kind, replace: selBlock.id })}>
              Replace…
            </button>
            <button className="btn small solid" onClick={() => duplicate(chara, selBlock)}>
              Duplicate
            </button>
            <button className="btn small solid danger" onClick={() => remove(chara, selBlock.id)}>
              Remove
            </button>
          </div>
          <div className="mo-fields">
            <label>
              Starts at
              <NumberField value={selBlock.start} format={fmt} parse={parseS} onCommit={(v) => update({ start: snapT(v) }, 'Move block')} />
            </label>
            <label>
              Length
              <NumberField value={selBlock.len} format={fmt} parse={parseS} onCommit={(v) => update({ len: Math.max(1 / fps, snapT(v)) }, 'Change block length')} />
            </label>
            {selBlock.kind === 'clip' && (
              <>
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
              </>
            )}
            {seq && seq.blocks[0]?.id !== selBlock.id && (
              <label>
                Blend in
                <NumberField value={selBlock.blend} format={fmt} parse={parseS} onCommit={(v) => update({ blend: Math.min(selBlock.len, Math.max(0, v)) }, 'Change blend')} />
              </label>
            )}
            {seq && seq.blocks[0]?.id !== selBlock.id && (
              <div className="seg mo-ease" title="How the blend moves: smooth eases in and out, linear goes at an even pace">
                {(['smooth', 'linear'] as const).map((e) => (
                  <button key={e} className={selBlock.ease === e ? 'on' : ''} onClick={() => update({ ease: e }, 'Change blend')}>
                    {e === 'smooth' ? 'Smooth' : 'Linear'}
                  </button>
                ))}
              </div>
            )}
            {natural != null && (
              <button className="btn small solid" onClick={() => update({ len: Math.max(1 / fps, snapT(natural / (selBlock.speed ?? 1))) }, 'Change block length')} title="One pass of the clip at this speed">
                Fit to the clip ({(natural / (selBlock.speed ?? 1)).toFixed(2)} s)
              </button>
            )}
          </div>
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

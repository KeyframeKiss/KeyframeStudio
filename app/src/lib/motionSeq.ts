// The Motion builder: per character, a sequence of blocks (Studio clips, poses) that the bridge builds into keys.
// The sequence lives in the bridge (saved with the scene); this keeps a copy for the page and sends edits back.
import { create } from 'zustand';
import { bridge } from '../bridge/client';
import { call, refreshTimeline, toast } from '../state/store';

export type Ease = 'smooth' | 'linear';
export interface ClipRef {
  group: number;
  category: number;
  no: number;
  name: string;
}
export interface PoseRef {
  path: string;
  name: string;
}
/** a saved Motion clip (Animate › Motion clips) */
export interface MClipRef {
  file: string;
  name: string;
}
export interface Block {
  id: string;
  kind: 'clip' | 'pose' | 'mclip';
  /** seconds on the timeline */
  start: number;
  len: number;
  /** seconds blending in from the block before (at this block's start) */
  blend: number;
  ease: Ease;
  /** clips: playback speed and where in the clip to start (seconds) */
  speed?: number;
  offset?: number;
  clip?: ClipRef;
  pose?: PoseRef;
  mclip?: MClipRef;
  /** played as in a mirror: left and right swapped */
  mirror?: boolean;
  /** hand edits to its keys, kept through rebuilds: bone → [block time, x, y, z, w][] (the bridge owns these) */
  tweaks?: Record<string, number[][]>;
  /** sent once to drop the kept hand edits (the bridge keeps them otherwise, whatever this copy says) */
  clearTweaks?: boolean;
}
export interface Seq {
  blocks: Block[];
  anchor?: number[];
}

interface MotionState {
  seqs: Record<number, Seq>;
  /** build in progress per character: 0…1, or -1 = waiting */
  building: Record<number, number>;
  /** the natural length of clip blocks (seconds at speed 1), from the last build */
  lengths: Record<string, number>;
  sel: { chara: number | null; block: string | null };
}

export const useMotion = create<MotionState>(() => ({ seqs: {}, building: {}, lengths: {}, sel: { chara: null, block: null } }));

// Each edit sent to the bridge gets a number. Until the bridge reports the latest one built, the page keeps
// its own copy: what the bridge reads back meanwhile is an older sequence.
const latest: Record<number, number> = {};
let token = 0;
const pending = (id: number) => useMotion.getState().building[id] != null;

let listening = false;
export function listenMotion() {
  if (listening) return;
  listening = true;
  bridge.on('motion.build', (d) => {
    const r = d as { id: number; token?: number; progress?: number; done?: boolean; error?: string; cancelled?: boolean; lengths?: Record<string, number> };
    // an older edit, already replaced by a newer one still on its way
    if (r.token != null && latest[r.id] != null && r.token !== latest[r.id]) return;
    if (!r.done) return useMotion.setState((s) => ({ building: { ...s.building, [r.id]: r.progress ?? 0 } }));
    useMotion.setState((s) => {
      const building = { ...s.building };
      delete building[r.id];
      return { building, lengths: { ...s.lengths, ...(r.lengths ?? {}) } };
    });
    if (r.error) {
      toast(r.error, 'error');
      void loadSeq(r.id); // back to what the bridge has
    }
    void refreshTimeline();
  });
  bridge.on('motion.seq', (d) => {
    const id = (d as { id: number }).id;
    if (id === -1) void loadAll();
    else void loadSeq(id);
  });
}

export async function loadSeq(id: number) {
  const seq = await bridge.request<Seq | null>('motion.seq.get', { id }).catch(() => null);
  if (pending(id)) return; // an edit is still building: the bridge's copy is older than this one
  useMotion.setState((s) => {
    const seqs = { ...s.seqs };
    if (seq) seqs[id] = seq;
    else delete seqs[id];
    return { seqs };
  });
}

export async function loadAll() {
  const list = await bridge.request<{ id: number }[]>('motion.seq.list').catch(() => []);
  useMotion.setState({ seqs: {} });
  await Promise.all(list.map((x) => loadSeq(x.id)));
}

/** Change a character's sequence: shown at once, built by the bridge (one undo step with the keys). */
export async function setSeq(id: number, seq: Seq, label = 'Edit motion') {
  const blocks = [...seq.blocks].sort((a, b) => a.start - b.start);
  const next = { ...seq, blocks };
  // the copy shown keeps no one-off requests (clearing edits is sent once)
  const shown = { ...next, blocks: blocks.map(({ clearTweaks: _, ...b }) => b) };
  const t = (latest[id] = ++token);
  useMotion.setState((s) => ({ seqs: { ...s.seqs, [id]: shown }, building: { ...s.building, [id]: -1 } }));
  const r = await call('motion.seq.set', { id, seq: next, label, token: t });
  if (!r && latest[id] === t) {
    useMotion.setState((s) => {
      const building = { ...s.building };
      delete building[id];
      return { building };
    });
    void loadSeq(id);
  }
}

export async function clearSeq(id: number) {
  latest[id] = ++token; // a build still on its way is cancelled by the bridge
  useMotion.setState((s) => {
    const building = { ...s.building };
    delete building[id];
    return { building };
  });
  await call('motion.seq.clear', { id });
  useMotion.setState((s) => ({ sel: s.sel.chara === id ? { chara: id, block: null } : s.sel }));
}

let n = 0;
export const newId = () => `b${Date.now().toString(36)}${(n++).toString(36)}`;

export const blockEnd = (b: Block) => b.start + b.len;
export const seqEnd = (seq?: Seq) => (seq?.blocks.length ? Math.max(...seq.blocks.map(blockEnd)) : 0);
export const blockName = (b: Block) => (b.kind === 'clip' ? b.clip?.name : b.kind === 'mclip' ? b.mclip?.name : b.pose?.name) ?? (b.kind === 'pose' ? 'Pose' : 'Clip');
/** clips play (speed, in-point); a pose holds */
export const plays = (b: Block) => b.kind !== 'pose';

/** A new block after the last one (blending in from it). */
export function appended(seq: Seq | undefined, b: Omit<Block, 'id' | 'start' | 'blend' | 'ease'>): Block {
  const end = seqEnd(seq);
  const first = !seq?.blocks.length;
  return { id: newId(), start: end, blend: first ? 0 : b.kind === 'pose' ? 0.6 : 0.4, ease: 'smooth', ...b };
}

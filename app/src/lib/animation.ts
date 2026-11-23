// Studio's animation clips on characters — one way to apply them from anywhere (Pose › Animations, the character
// panel, the scene list, Ctrl+K), saying what had to change for the clip to show.
import { call, displayName, liveTime, refreshTimeline, selectedCharacters, toast, useStore } from '../state/store';

interface LoadResult {
  applied: number;
  freed: string[];
  started: string[];
  /** characters whose clip the timeline drives (it switches back to the keyed clip at the next seek) */
  driven?: string[];
}

export interface ClipSegment {
  t0: number;
  t1: number;
  name: string;
  group: number;
  category: number;
  no: number;
}
export interface ClipTimeline {
  driven: boolean;
  tracks: { clip: number | null; time: number | null };
  segments: ClipSegment[];
}

const names = (l: string[]) => (l.length <= 2 ? l.join(' and ') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);

/** Apply clip (group, category, no) to the characters. Returns false when it didn't happen. */
export async function applyAnimation(ids: number[], group: number, category: number, no: number) {
  if (!ids.length) {
    toast('Select a character first (in the scene list or Studio)');
    return false;
  }
  const r = await call<LoadResult | number>('chara.loadAnime', { ids, group, category, no });
  if (r == null) return false;
  if (typeof r !== 'object') return true; // an older bridge
  const notes: string[] = [];
  if (r.freed.length) notes.push(`${names(r.freed)} ${r.freed.length > 1 ? 'were' : 'was'} posed with FK / IK, which holds the body still — turned off so the animation plays`);
  if (r.started.length) notes.push(`${names(r.started)}'s animation was stopped (speed 0) — now playing at speed 1`);
  if (r.driven?.length) notes.push(`${names(r.driven)}'s animation is on the timeline, which goes back to the keyed clip at the next seek — "Put on the timeline" keys this one at the playhead`);
  // bones keyed on the timeline still win over the clip where they're keyed, while the timeline plays
  const st = useStore.getState();
  const bones = st.tracks.filter((t) => ids.includes(t.oci) && t.enabled && t.keys.length > 0 && /cf_[jt]_/.test(t.name));
  if (bones.length) notes.push(`${bones.length} bone track${bones.length > 1 ? 's' : ''} on the timeline still ${bones.length > 1 ? 'play' : 'plays'} over it where keyed (mute ${bones.length > 1 ? 'them' : 'it'} to see the clip there)`);
  if (notes.length) toast(`Animation applied. ${notes.join('. ')}. Ctrl+Z undoes it all`, 'done');
  return true;
}

/** Open the animation browser for these characters (default: the selected ones). */
export function openAnimations(ids?: number[]) {
  const chars = ids ?? selectedCharacters();
  if (!chars.length) return toast('Select a character first (in the scene list or Studio)');
  useStore.setState({ animBrowserFor: chars });
}

const sec = (t: number) => `${t.toFixed(2)} s`;

/**
 * Put each character's current clip on the timeline from `t` (default the playhead): Timeline's Animation and
 * Animation Time tracks, so the clip plays in step with the timeline (and scrubbing shows its pose).
 */
export async function putClipOnTimeline(ids: number[], t?: number) {
  if (!ids.length) return toast('Select a character first (in the scene list or Studio)');
  const at = t ?? liveTime();
  const done: string[] = [];
  let last: { t0: number; t1: number; name: string } | undefined;
  for (const id of ids) {
    const r = await call<{ t0: number; t1: number; name: string }>('anim.toTimeline', { id, t: at });
    if (!r) break;
    last = r;
    done.push(displayName(useStore.getState().nodes[id]));
  }
  void refreshTimeline();
  if (!last) return;
  toast(
    `“${last.name}” is on the timeline from ${sec(last.t0)} to ${sec(last.t1)}${done.length > 1 ? ` for ${names(done)}` : ''}. Scrub to see any moment of it; it plays and renders with the timeline — Ctrl+Z undoes it`,
    'done',
  );
}

export type BakePart = 'body' | 'neck' | 'hands';
export const BAKE_PARTS: { id: BakePart; label: string }[] = [
  { id: 'body', label: 'Body' },
  { id: 'neck', label: 'Head & neck' },
  { id: 'hands', label: 'Fingers' },
];

/** Turn the clip's motion over [t0, t1] into FK bone keys on the chosen parts. */
export async function bakeClip(id: number, t0: number, t1: number, parts: BakePart[]) {
  const r = await call<{ keys: number; bones: number; tracks: number; name: string; t0: number; t1: number; travel?: boolean }>('anim.bake', { id, t0, t1, parts });
  void refreshTimeline();
  if (!r) return false;
  const what = BAKE_PARTS.filter((p) => parts.includes(p.id)).map((p) => p.label.toLowerCase());
  toast(
    `Baked “${r.name}” (${sec(r.t0)}–${sec(r.t1)}): ${r.keys} keys on ${r.bones} bones${r.tracks ? `, in the folder “${r.name} (baked)” with the clip's own tracks (hide the folder to hide it all)` : ''}. FK now drives the ${names(what)}${
      r.travel ? "; the hips' bob and travel are on the character's position track and the clip is held still underneath, so the keys carry it all" : '; the clip still moves the hips'
    }. Edit the keys like any others — Ctrl+Z undoes it`,
    'done',
  );
  return true;
}

// Studio's animation clips on characters — one way to apply them from anywhere (Pose › Animations, the character
// panel, the scene list, Ctrl+K), saying what had to change for the clip to show.
import { call, selectedCharacters, toast, useStore } from '../state/store';

interface LoadResult {
  applied: number;
  freed: string[];
  started: string[];
  /** characters whose clip the timeline drives (it switches back to the keyed clip at the next seek) */
  driven?: string[];
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
  if (r.driven?.length) notes.push(`${names(r.driven)}'s animation comes from the timeline, which goes back to its own clip at the next seek — use Animate › Motion builder to change it there`);
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

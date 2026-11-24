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
  if (r.freed.length) notes.push(`FK / IK turned off for ${names(r.freed)}`);
  if (r.started.length) notes.push(`${names(r.started)} was paused; now playing`);
  if (r.driven?.length) notes.push(`${names(r.driven)}'s motion comes from the timeline: change it in the Motion builder`);
  // bones keyed on the timeline still win over the clip where they're keyed, while the timeline plays
  const st = useStore.getState();
  const bones = st.tracks.filter((t) => ids.includes(t.oci) && t.enabled && t.keys.length > 0 && /cf_[jt]_/.test(t.name));
  if (bones.length) notes.push(`${bones.length} keyed bone${bones.length > 1 ? 's' : ''} still override${bones.length > 1 ? '' : 's'} it`);
  if (notes.length) toast(`Animation applied. ${notes.join('. ')}.`, 'done');
  return true;
}

/** Open the animation browser for these characters (default: the selected ones). */
export function openAnimations(ids?: number[]) {
  const chars = ids ?? selectedCharacters();
  if (!chars.length) return toast('Select a character first (in the scene list or Studio)');
  useStore.setState({ animBrowserFor: chars });
}

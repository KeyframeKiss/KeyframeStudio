import { editTimeline, liveTime, selectedCharacters, toast, useStore } from '../state/store';
import { FACE_ROWS } from '../components/FaceAnimation';

const FACE_KEY = 'kf.keyPose.face';

/** Whether "Key the whole pose" also keys the face (eyes, brows, mouth, blush, tears, neck look). On by default. */
export function keyPoseWithFace() {
  try {
    return localStorage.getItem(FACE_KEY) !== '0';
  } catch {
    return true;
  }
}
export function setKeyPoseWithFace(on: boolean) {
  try {
    localStorage.setItem(FACE_KEY, on ? '1' : '0');
  } catch {
    /* this session only */
  }
}

/**
 * Key the whole pose of the selected characters exactly as it is, at the playhead: their place, every joint and
 * target (tracks made where missing; a pose only the animation holds is taken over by joints first), and the face
 * when asked. One undo step. The way to set a character's first key.
 */
export async function keyWholePose(ids = selectedCharacters(), face = keyPoseWithFace()) {
  if (!ids.length) {
    toast('Select a character first');
    return;
  }
  const n = await editTimeline<number>('timeline.keyPose', { ids, t: liveTime(), extra: face ? FACE_ROWS.map((r) => r.model) : [] });
  if (n == null) return;
  const who = ids.length > 1 ? `${ids.length} characters` : 'the character';
  toast(`Keyed the whole pose of ${who} at ${liveTime().toFixed(2)} s (${n} track${n === 1 ? '' : 's'})`, 'done');
  useStore.setState({ pending: 0 });
}

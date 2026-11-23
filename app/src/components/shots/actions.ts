// What you can do to shots — shared by the shot track, the storyboard, the inspector, the timeline ruler and the
// right-click menus, so each action behaves (and is named) the same everywhere.
import { call, displayName, liveTime, renderShots, saveShots, seekNow, setLiveCuts, showTab, toast, togglePlay, useStore, type Shot } from '../../state/store';
import { duplicateShot, newShotAt, newShotId, splitShot, swapWith } from '../../lib/shots';
import type { MenuItem } from '../ContextMenu';

const st = () => useStore.getState();
const duration = () => st().tl?.duration ?? 10;

export const selectShot = (id: string | null) => useStore.setState({ selShotId: id });

/** A new shot at `t` with Studio's camera as it is now. The first shot turns live cuts on. */
export async function addShotAt(t = liveTime()) {
  const { shots } = st();
  const r = newShotAt(shots, Math.round(t * 100) / 100, duration());
  if (!r) return toast('No room for a shot here — move the playhead to a gap, or make the timeline longer');
  const id = newShotId();
  const first = shots.length === 0;
  if (!(await saveShots([...shots, { id, name: `Shot ${shots.length + 1}`, ...r, notes: '', status: 'idea', camMode: 'still' }], 'Add shot'))) return;
  const after = await call<Shot[]>('shots.captureCamera', { id });
  if (after) useStore.setState({ shots: after });
  selectShot(id);
  if (first && !st().liveCuts) {
    await setLiveCuts(true);
    toast(`Shot added ${r.start.toFixed(2)}–${r.end.toFixed(2)} s with the current camera. Live cuts are on: playing switches to each shot's camera`, 'done');
  } else toast(`Shot added ${r.start.toFixed(2)}–${r.end.toFixed(2)} s with the current camera`);
}

export async function deleteShot(id: string) {
  const s = st().shots.find((x) => x.id === id);
  if (!s) return;
  if (await saveShots(st().shots.filter((x) => x.id !== id), 'Delete shot')) {
    if (st().selShotId === id) selectShot(null);
    toast(`Deleted “${s.name}” — Ctrl+Z to undo`);
  }
}

export async function splitAtPlayhead(id: string) {
  const t = Math.round(liveTime() * 1000) / 1000;
  const nid = newShotId();
  const next = splitShot(st().shots, id, t, nid);
  if (!next) return toast('Put the playhead inside the shot (not at its very edge) to split it there');
  if (await saveShots(next, 'Split shot')) selectShot(nid);
}

export async function duplicate(id: string) {
  const nid = newShotId();
  const next = duplicateShot(st().shots, id, nid, duration());
  if (!next) return toast('No room right after this shot — make a gap first (drag the next shot along) or split it');
  if (await saveShots(next, 'Duplicate shot')) selectShot(nid);
}

export async function swap(id: string, dir: -1 | 1) {
  const next = swapWith(st().shots, id, dir);
  if (next !== st().shots) await saveShots(next, 'Swap shots');
}

export async function patchShot(id: string, p: Partial<Shot>, label = 'Edit shot') {
  return saveShots(
    st().shots.map((s) => (s.id === id ? { ...s, ...p } : s)),
    label,
  );
}

/** Look through a shot's camera (and its frame guide); the playhead goes to its start. */
export async function lookThrough(id: string) {
  const s = st().shots.find((x) => x.id === id);
  if (!s) return;
  selectShot(id);
  await seekNow(s.start);
  if (s.camMode === 'keys') return; // its camera keys show it at the start
  if (!s.cam) return toast('This shot has no camera yet — frame the view in Studio and press Use current view');
  await call('shots.view', { id });
}

export async function useCurrentView(id: string) {
  const r = await call<Shot[]>('shots.captureCamera', { id });
  if (r) {
    useStore.setState({ shots: r });
    toast('The shot now uses Studio’s current view');
  }
}

export async function fromAngle(id: string, angle: string) {
  const r = await call<Shot[]>('shots.fromAngle', { id, angle });
  if (r) {
    useStore.setState({ shots: r });
    toast(`The shot now uses the angle “${st().angles.find((a) => a.id === angle)?.name ?? 'angle'}”`);
  }
}

/** A new shot at `t` (until the next shot, or 3 s) that uses an angle's camera. */
export async function addShotWithAngle(t: number, angle: string) {
  const { shots } = st();
  const r = newShotAt(shots, Math.round(t * 100) / 100, duration());
  if (!r) return toast('No room for a shot there — drop it on a gap, or make the timeline longer');
  const a = st().angles.find((x) => x.id === angle);
  const id = newShotId();
  const first = shots.length === 0;
  if (!(await saveShots([...shots, { id, name: a?.name ?? `Shot ${shots.length + 1}`, ...r, notes: '', status: 'idea', camMode: 'still' }], 'Add shot'))) return;
  await fromAngle(id, angle);
  selectShot(id);
  if (first && !st().liveCuts) await setLiveCuts(true);
}

/** How a shot's camera works, in a few words (for the track, storyboard and monitor). */
export function camLabel(s: Shot): string {
  const who = s.who != null ? st().nodes[s.who] : null;
  const name = who ? displayName(who) : 'a character';
  switch (s.camMode) {
    case 'keys':
      return 'Camera keys';
    case 'pov':
      return `First person · ${name}`;
    case 'follow':
      return `Follow · ${name}`;
    default: {
      const a = s.angle ? st().angles.find((x) => x.id === s.angle) : null;
      return a ? a.name : s.cam ? '' : 'No camera';
    }
  }
}

export async function playShot(id: string, loop: boolean) {
  const s = st().shots.find((x) => x.id === id);
  if (!s) return;
  useStore.setState({ workingShotId: loop ? id : st().workingShotId, loopShot: loop });
  await seekNow(s.start);
  if (!st().tl?.playing) togglePlay();
}

export function workOn(id: string) {
  const s = st().shots.find((x) => x.id === id);
  if (!s) return;
  useStore.setState({ workingShotId: id, frameFullTimeline: false, loopShot: false });
  showTab('animate', 'timeline');
  void seekNow(s.start);
}

export function canRender() {
  return !!st().hello?.features?.some((f) => f.id === 'render' && (f.status === 'ok' || f.status === 'untested'));
}

/** The right-click menu for a shot. */
export function shotMenu(id: string): MenuItem[] {
  const shots = st().shots;
  const s = shots.find((x) => x.id === id);
  if (!s) return [];
  const sorted = [...shots].sort((a, b) => a.start - b.start);
  const i = sorted.findIndex((x) => x.id === id);
  return [
    { header: true, label: s.name },
    { label: 'Look through its camera', kbd: 'Enter', action: () => lookThrough(id) },
    { label: 'Use Studio’s current view', action: () => useCurrentView(id) },
    { label: 'Play shot', action: () => playShot(id, false) },
    { label: 'Loop shot', action: () => playShot(id, true) },
    { label: 'Work on this shot (Animate)', action: () => workOn(id) },
    ...(canRender() ? [{ label: 'Render this shot', action: () => renderShots([id]) }] : []),
    { sep: true },
    { label: 'Split at playhead', kbd: 'S', action: () => splitAtPlayhead(id) },
    { label: 'Duplicate', kbd: 'D', action: () => duplicate(id) },
    ...(i > 0 ? [{ label: 'Swap with the shot before', kbd: 'Alt ←', action: () => swap(id, -1) }] : []),
    ...(i < sorted.length - 1 ? [{ label: 'Swap with the shot after', kbd: 'Alt →', action: () => swap(id, 1) }] : []),
    { sep: true },
    { label: 'Delete', kbd: 'Del', danger: true, action: () => deleteShot(id) },
  ];
}

export const TRANSITIONS: { id: import('../../state/store').TransType; label: string; glyph: string; hint: string }[] = [
  { id: 'cut', label: 'Cut', glyph: '│', hint: 'A hard cut: the camera switches at once' },
  { id: 'glide', label: 'Glide', glyph: '↝', hint: 'The camera travels from the shot before to this one (short = a whip pan)' },
  { id: 'dipBlack', label: 'Dip to black', glyph: '●', hint: 'Fade to black, cut, fade back in' },
  { id: 'dipWhite', label: 'Dip to white', glyph: '○', hint: 'Fade to white, cut, fade back in' },
  { id: 'dissolve', label: 'Dissolve', glyph: '◇', hint: 'The shot before fades into this one' },
];

/** The shot before (by start), or null. */
export function shotBefore(id: string): Shot | null {
  const list = [...st().shots].sort((a, b) => a.start - b.start);
  const i = list.findIndex((s) => s.id === id);
  return i > 0 ? list[i - 1] : null;
}

const stillCam = (s: Shot | null) => !!s && (s.camMode ?? 'still') === 'still' && !!s.cam;

/** Why a transition can't play (glides and dissolves need still cameras on both sides), or null. */
export function transProblem(s: Shot): string | null {
  const t = s.trans?.type ?? 'cut';
  if (t !== 'glide' && t !== 'dissolve') return null;
  const a = shotBefore(s.id);
  if (!a) return 'There’s no shot before this one — it plays as a cut';
  if (!stillCam(a) || !stillCam(s)) return 'Needs a still camera on this shot and the one before — until then it plays as a cut';
  return null;
}

/** The time the transition covers (centred on the cut, no longer than either shot), or null for a cut. */
export function transWindow(s: Shot): [number, number] | null {
  const tr = s.trans;
  if (!tr || tr.type === 'cut') return null;
  const a = shotBefore(s.id);
  let dur = Math.min(tr.dur, s.end - s.start);
  if (a) dur = Math.min(dur, a.end - a.start);
  return [s.start - dur / 2, s.start + dur / 2];
}

export function setTrans(id: string, p: Partial<import('../../state/store').ShotTrans>) {
  const s = st().shots.find((x) => x.id === id);
  if (!s) return;
  const cur = s.trans ?? { type: 'cut' as const, dur: 0.5, ease: 'smooth' as const };
  const next = { ...cur, ...p };
  if (p.type && p.type !== 'cut' && cur.type === 'cut' && p.dur == null) next.dur = p.type === 'glide' ? 0.8 : 0.6;
  return patchShot(id, { trans: next.type === 'cut' ? undefined : next }, `Transition: ${TRANSITIONS.find((x) => x.id === next.type)!.label.toLowerCase()}`);
}

export const STATUSES: { id: NonNullable<Shot['status']>; label: string; hint: string }[] = [
  { id: 'idea', label: 'Idea', hint: 'Planned: a rough range and a note' },
  { id: 'blocked', label: 'Blocked', hint: 'The timing and the main poses are in' },
  { id: 'framed', label: 'Framed', hint: 'The camera is set' },
  { id: 'final', label: 'Final', hint: 'Done — ready to render' },
];

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

export const STATUSES: { id: NonNullable<Shot['status']>; label: string; hint: string }[] = [
  { id: 'idea', label: 'Idea', hint: 'Planned: a rough range and a note' },
  { id: 'blocked', label: 'Blocked', hint: 'The timing and the main poses are in' },
  { id: 'framed', label: 'Framed', hint: 'The camera is set' },
  { id: 'final', label: 'Final', hint: 'Done — ready to render' },
];

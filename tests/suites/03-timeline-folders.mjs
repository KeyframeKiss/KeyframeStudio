export const name = 'Timeline: folders and folder-aware undo';

export default async function (t) {
  t.needs('timeline');
  const { ok, check } = t;
  const tl = () => ok('timeline.get');
  const order = (data, gid) =>
    data.tracks
      .filter((x) => x.group === gid)
      .sort((a, b) => a.order - b.order)
      .map((x) => x.id);

  await t.step('create, rename, move, ungroup', async () => {
    const a = await ok('timeline.addTrack', { owner: 'Timeline', model: 'cameraFOV', keyAt: 0 });
    const b = await ok('timeline.addTrack', { owner: 'Timeline', model: 'timeScale', keyAt: 0 });
    t.defer(() => t.req('timeline.removeTracks', { tracks: [a, b] }));
    const gid = await ok('timeline.groupCreate', { name: 'Test folder', tracks: [a, b] });
    let d = await tl();
    check('folder created with both tracks', d.tracks.filter((x) => x.group === gid).length === 2);
    await ok('timeline.groupRename', { group: gid, name: 'Renamed' });
    check('folder renamed', (await tl()).groups.find((x) => x.id === gid)?.name === 'Renamed');
    await ok('timeline.groupMove', { tracks: [b], group: -1 });
    d = await tl();
    check('track moved out', d.tracks.find((x) => x.id === b).group === -1 && d.tracks.find((x) => x.id === a).group === gid);
    await ok('timeline.groupDelete', { group: gid });
    d = await tl();
    check('ungroup keeps tracks', !d.groups.some((x) => x.id === gid) && d.tracks.some((x) => x.id === a) && d.tracks.some((x) => x.id === b));
  });

  const { items } = await t.loadSample();
  if (items.length < 2) t.skip('sample scene needs two items');
  const T1 = await ok('timeline.addTrack', { owner: 'Timeline', model: 'guideObjectPos', oci: items[0].id, keyAt: 0 });
  const T2 = await ok('timeline.addTrack', { owner: 'Timeline', model: 'guideObjectPos', oci: items[1].id, keyAt: 0 });
  const g = await ok('timeline.groupCreate', { tracks: [T1, T2], name: 'Undo folder' });
  let d = await tl();
  const before = order(d, g);
  check('setup: both tracks in the folder', before.length === 2);

  await ok('timeline.removeTracks', { tracks: [before[0]] });
  await ok('undo');
  check('undo single delete: back in its folder, same order', JSON.stringify(order(await tl(), g)) === JSON.stringify(before));

  await ok('timeline.removeTracks', { tracks: [T1, T2] });
  check('folder removed with its last track', !(await tl()).groups.some((x) => x.id === g));
  await ok('undo');
  d = await tl();
  check('undo: folder back with its name', d.groups.find((x) => x.id === g)?.name === 'Undo folder');
  check('undo: both tracks back in order', JSON.stringify(order(d, g)) === JSON.stringify(before));
  await ok('redo');
  d = await tl();
  check('redo removes them again', !d.tracks.some((x) => x.id === T1 || x.id === T2));
}

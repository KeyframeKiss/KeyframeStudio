export const name = 'Viewport: camera, motion paths, ghosts';

export default async function (t) {
  const { ok, req, check, near, sleep } = t;
  const { chara } = await t.loadSample();

  await t.step('camera', async () => {
    const c = await ok('camera.get');
    check('10 camera slots', c.slots.length === 10);
    const snap = await ok('camera.snapshot', { width: 200 });
    check('viewport snapshot', typeof snap === 'string' && snap.startsWith('data:image/jpeg;base64,') && snap.length > 2000);
    const c2 = await ok('camera.saveSlot', { index: 9 });
    check('save slot with thumbnail', c2.slots[9].used && !!c2.slots[9].thumb);
    check('the camera is at the view just saved', (await ok('camera.activeSlot')).includes(9) && c2.activeSlots.includes(9));
    const fov = (await ok('camera.get')).fov;
    await ok('camera.setFov', { fov: fov + 7 });
    check('moving the camera leaves the saved view', !(await ok('camera.activeSlot')).includes(9));
    await ok('camera.loadSlot', { index: 9 });
    await sleep(300);
    check('going back to it is recognised', (await ok('camera.activeSlot')).includes(9));
    if (t.hello.timeline) {
      const k1 = await ok('camera.key', { t: 1 });
      await ok('camera.key', { t: 3, cut: true });
      const shots = await ok('camera.shots');
      check('camera keys + cut', k1.tracks === 4 && shots.length === 2 && shots[1].cut === true && shots[0].cut === false && !!shots[0].thumb);
    }
  });

  if (!t.hello.timeline) return;
  const prev = await ok('viewport.get');
  t.defer(() => req('viewport.set', { paths: prev.paths, ghosts: prev.ghosts, ghostsAuto: prev.ghostsAuto, ghostCount: prev.ghostCount, ghostMode: prev.ghostMode, pathsCamera: prev.pathsCamera }));

  // animate the character root: a path and keys for ghosts
  const pos = await ok('timeline.addTrack', { owner: 'Timeline', model: 'guideObjectPos', oci: chara.id, keyAt: 0 });
  const rot = await ok('timeline.addTrack', { owner: 'Timeline', model: 'guideObjectRot', oci: chara.id, keyAt: 0 });
  const o = await ok('object.get', { id: chara.id });
  for (const [tt, dx, yaw] of [
    [2, 0.6, 90],
    [4, 0.6, 180],
    [6, 0, 270],
  ]) {
    await ok('timeline.addKeys', { tracks: [pos, rot], t: tt });
    await ok('timeline.setKeyValue', { track: pos, t: tt, value: { valueX: o.transform.pos[0] + dx, valueZ: o.transform.pos[2] + (tt === 4 ? 0.6 : 0) } });
    const h = (yaw * Math.PI) / 360;
    await ok('timeline.setKeyValue', { track: rot, t: tt, value: { valueX: 0, valueY: Math.sin(h), valueZ: 0, valueW: Math.cos(h) } });
  }
  await ok('timeline.seek', { t: 3 });
  await sleep(1200);

  await t.step('motion paths', async () => {
    await ok('viewport.set', { paths: true, pathsCamera: false, pathsBody: false });
    await sleep(800);
    check('path drawn for the selected character', (await ok('viewport.get')).pathCount === 1);
    await ok('scene.select', { ids: [] });
    await sleep(800);
    const empty = await ok('viewport.get');
    check('no path when nothing is selected, and it says why', empty.pathCount === 0 && /Select something/.test(empty.pathsNote), empty.pathsNote);
    await ok('scene.select', { ids: [chara.id] });
    await sleep(800);
  });

  await t.step('body paths (hands, feet, head)', async () => {
    await ok('viewport.set', { pathsBody: true, pathsBones: 'hands,feet,head' });
    let v;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      v = await ok('viewport.get');
      if (!v.pathsBaking && v.pathsDrawn >= 6) break;
    }
    check('traced: the root path + 5 body paths', v.pathsDrawn === 6 && v.pathsNote === '', JSON.stringify({ drawn: v.pathsDrawn, note: v.pathsNote }));
    check('playhead put back after tracing', near((await ok('timeline.state')).time, 3));
    await sleep(1500);
    check('still there a moment later', (await ok('viewport.get')).pathsDrawn === 6);
    await ok('viewport.set', { pathsBones: 'head' });
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      v = await ok('viewport.get');
      if (!v.pathsBaking && v.pathsDrawn === 2) break;
    }
    check('only the chosen parts', v.pathsDrawn === 2);
    await ok('viewport.set', { pathsBody: false, pathsBones: 'hands,feet,head' });
    await sleep(500);
    check('body paths off leaves the object path', (await ok('viewport.get')).pathsDrawn === 1);
  });

  await t.step('ghosts', async () => {
    const before = await ok('object.get', { id: chara.id });
    const tBefore = (await ok('timeline.state')).time;
    await ok('viewport.set', { ghosts: true, ghostsAuto: false, ghostMode: 'keys', ghostCount: 1 });
    await ok('viewport.refreshGhosts');
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      if (!(await ok('viewport.get')).busy) break;
    }
    const v = await ok('viewport.get');
    const after = await ok('object.get', { id: chara.id });
    check('ghosts built', v.ghostCountBuilt > 0);
    check('playhead restored', near((await ok('timeline.state')).time, tBefore));
    check('pose restored', after.transform.pos.every((x, i) => near(x, before.transform.pos[i])));
    await ok('object.set', { ids: [chara.id], pos: [null, before.transform.pos[1] + 0.3, null] });
    await sleep(1300);
    const blocked = await req('viewport.refreshGhosts');
    check('refresh refused while changes are unkeyed', !blocked.ok);
    check('unkeyed edit preserved', near((await ok('object.get', { id: chara.id })).transform.pos[1], before.transform.pos[1] + 0.3));
    await ok('undo');
  });
}

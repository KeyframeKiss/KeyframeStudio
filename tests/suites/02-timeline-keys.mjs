export const name = 'Timeline: tracks, keys, curves, undo';

export default async function (t) {
  t.needs('timeline');
  const { ok, req, check, near, sleep } = t;
  const keysOf = async (id) => (await ok('timeline.get')).tracks.find((x) => x.id === id)?.keys;

  // scene-wide track (no object needed)
  const tid = await ok('timeline.addTrack', { owner: 'Timeline', model: 'cameraFOV', keyAt: 0 });
  t.defer(() => req('timeline.removeTracks', { tracks: [tid] }));
  check('addTrack returns id', typeof tid === 'number');
  let keys = await keysOf(tid);
  check('track has key at 0', keys?.length === 1 && keys[0][0] === 0);

  await ok('timeline.seek', { t: 2 });
  check('seek moved playhead', near((await ok('timeline.state')).time, 2, 1e-4));
  await ok('timeline.addKeys', { tracks: [tid], t: 2 });
  check('addKeys → 2 keys', (await keysOf(tid)).length === 2);
  await ok('timeline.moveKeys', { keys: [{ track: tid, t: 2 }], dt: 1.5 });
  keys = await keysOf(tid);
  check('moveKeys 2 → 3.5', keys.length === 2 && near(keys[1][0], 3.5, 1e-4), JSON.stringify(keys));
  const coll = await req('timeline.moveKeys', { keys: [{ track: tid, t: 3.5 }], dt: -3.5 });
  check('moveKeys onto an existing key is rejected', !coll.ok);

  await ok('timeline.setCurve', { keys: [{ track: tid, t: 0 }], curve: [0, 0, 0, 0, 1, 1, 0, 0] });
  check('setCurve ease in-out stored', JSON.stringify((await keysOf(tid))[0][1]) === '[0,0,0,0,1,1,0,0]');
  await ok('timeline.setCurve', { keys: [{ track: tid, t: 0 }], curve: [0, 0, 0, 0, 1, 1, 1e39, 0] });
  check('step curve keeps Infinity tangent', (await keysOf(tid))[0][1]?.[6] === Infinity);
  const info = await ok('timeline.keyInfo', { track: tid, t: 0 });
  check('keyInfo describes value', info && Object.keys(info.value).length > 0);

  await ok('timeline.copyKeys', { keys: [{ track: tid, t: 0 }], dt: 5 });
  check('copyKeys → key at 5', (await keysOf(tid)).some((k) => near(k[0], 5, 1e-4)));
  await ok('timeline.deleteKeys', { keys: [{ track: tid, t: 5 }, { track: tid, t: 3.5 }] });
  check('deleteKeys → 1 key', (await keysOf(tid)).length === 1);
  await ok('undo');
  check('undo delete → 3 keys', (await keysOf(tid)).length === 3);
  await ok('undo');
  check('undo copy → 2 keys', (await keysOf(tid)).length === 2);
  await ok('redo');
  check('redo copy → 3 keys', (await keysOf(tid)).length === 3);

  await ok('timeline.setTrack', { track: tid, alias: 'My FOV', enabled: false });
  const tr = (await ok('timeline.get')).tracks.find((x) => x.id === tid);
  check('setTrack alias/enabled', tr.alias === 'My FOV' && tr.enabled === false);

  const st0 = await ok('timeline.state');
  await ok('timeline.setSettings', { duration: 12, fps: 30 });
  const st2 = await ok('timeline.state');
  check('setSettings duration/fps', st2.duration === 12 && st2.fps === 30);
  await ok('timeline.setSettings', { duration: st0.duration, fps: st0.fps });

  await ok('timeline.play');
  await sleep(600);
  check('play advances time', (await ok('timeline.pause')).time > 0.3);
  await ok('timeline.stop');

  await ok('timeline.removeTracks', { tracks: [tid] });
  check('removeTracks', !(await keysOf(tid)));
  await ok('undo');
  check('undo remove restores track + keys', (await keysOf(tid))?.length === 3);

  // object tracks and key values (graph editor)
  const { chara } = await t.loadSample();
  await t.step('character tracks and key values', async () => {
    const models = await ok('timeline.models', { oci: chara.id });
    check('character track types', models.some((m) => m.id === 'guideObjectPos'), `${models.length} models`);
    const rot = await ok('timeline.addTrack', { owner: 'Timeline', model: 'guideObjectRot', oci: chara.id, keyAt: 0 });
    await ok('timeline.addKeys', { tracks: [rot], t: 1 });
    const vals = (await ok('timeline.keyValues', { tracks: [rot] }))[String(rot)];
    check('keyValues rotation', vals.length === 2 && 'valueW' in vals[0][1]);
    const q = [0, 0.7071068, 0, 0.7071068];
    const d = await ok('timeline.setKeyValue', { track: rot, t: 1, value: { valueX: q[0], valueY: q[1], valueZ: q[2], valueW: q[3] } });
    check('setKeyValue', near(Number(d.valueY), q[1], 1e-4));
    await ok('undo');
    const back = (await ok('timeline.keyValues', { tracks: [rot] }))[String(rot)];
    check('undo setKeyValue', Math.abs(back[1][1].valueY - q[1]) > 1e-3);
    const pos = await ok('timeline.addTrack', { owner: 'Timeline', model: 'guideObjectPos', oci: chara.id, keyAt: 0 });
    const d2 = await ok('timeline.setKeyValue', { track: pos, t: 0, value: { valueY: 0.25 } });
    check('setKeyValue partial (Y only)', near(Number(d2.valueY), 0.25, 1e-4) && 'valueX' in d2);
    await ok('timeline.removeTracks', { tracks: [rot, pos] });
    await ok('undo');
    const again = (await ok('timeline.get')).tracks.filter((x) => x.oci === chara.id);
    check('undo addTrack/remove round-trip', again.length === 2);
  });
}

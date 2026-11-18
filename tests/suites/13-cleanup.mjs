export const name = 'Motion cleanup: batch values, retime, loop, bone sampling';

export default async function (t) {
  t.needs('timeline');
  const { ok, req, check, near, sleep, studio } = t;
  const { chara, items } = await t.loadSample();
  const item = items[0];
  const T = await ok('timeline.addTrack', { owner: 'Timeline', model: 'guideObjectPos', oci: item.id, keyAt: 0 });
  for (const k of [1, 2, 3, 4]) await ok('timeline.addKeys', { tracks: [T], t: k });
  const xs = [0, 1, 10, 3, 4];
  await ok('timeline.setKeyValues', { edits: xs.map((x, i) => ({ track: T, t: i, value: { valueX: x } })) });
  const values = async () => (await ok('timeline.keyValues', { tracks: [T] }))[String(T)];
  const keyTimes = async () => (await ok('timeline.get')).tracks.find((x) => x.id === T).keys.map((k) => +k[0].toFixed(4));

  await t.step('batch key values (one undo step)', async () => {
    check('values written', (await values()).map((k) => k[1].valueX).join() === xs.join());
    const n = await ok('timeline.setKeyValues', { edits: [{ track: T, t: 2, value: { valueX: 2 } }, { track: T, t: 3, value: { valueX: 3.5 } }], label: 'Smooth keys' });
    check('two keys changed', n === 2);
    let v = await values();
    check('new values', near(v[2][1].valueX, 2) && near(v[3][1].valueX, 3.5));
    await ok('undo');
    v = await values();
    check('one undo restores both', near(v[2][1].valueX, 10) && near(v[3][1].valueX, 3));
  });

  await t.step('retime', async () => {
    const keys = [1, 2, 3, 4].map((x) => ({ track: T, t: x }));
    const bad = await req('timeline.scaleKeys', { keys: keys.slice(1), factor: 0.5, pivot: 0, fps: 60 });
    check('refused when a key would land on another key', !bad.ok, bad.error);
    const past = await req('timeline.scaleKeys', { keys, factor: 4, pivot: 0, fps: 60 });
    check('refused past the end of the timeline', !past.ok, past.error);
    check('scaled 2× around t=1', (await ok('timeline.scaleKeys', { keys, factor: 2, pivot: 1, fps: 60 })) === 4);
    check('times 0,1,3,5,7', (await keyTimes()).join() === '0,1,3,5,7', (await keyTimes()).join());
    check('values move with their keys', (await values())[2][1].valueX === 10);
    await ok('undo');
    check('undo puts the times back', (await keyTimes()).join() === '0,1,2,3,4');
    await ok('timeline.scaleKeys', { keys: [{ track: T, t: 1 }, { track: T, t: 2 }], factor: 1.37, pivot: 0, fps: 30 });
    const snapped = (await ok('timeline.get')).tracks.find((x) => x.id === T).keys.slice(1, 3).map((k) => k[0]);
    check('snapped to frames', snapped.every((x) => near(x * 30, Math.round(x * 30), 1e-3)), snapped.join());
    await ok('undo');
  });

  await t.step('make loop', async () => {
    check('loop at an existing key', (await ok('timeline.makeLoop', { tracks: [T], end: 4 })) === 1);
    let v = await values();
    check('last key now matches the first', near(v[4][1].valueX, 0) && v.length === 5);
    await ok('undo');
    await ok('timeline.makeLoop', { tracks: [T], end: 6 });
    v = await values();
    check('a key is added at the loop end', v.length === 6 && near(v[5][0], 6) && near(v[5][1].valueX, 0));
    await ok('undo');
    check('undo removes it', (await values()).length === 5);
  });

  await t.step('bone sampling', async () => {
    await ok('timeline.seek', { t: 0.5 });
    await sleep(1200);
    const done = studio.waitFor('motion.sample', () => true, 30000);
    const n = await ok('motion.sample', { id: chara.id, bones: ['cf_j_foot_L', 'cf_j_foot_R', 'cf_j_nope'], t0: 0, t1: 1, rate: 10 });
    check('11 samples planned', n === 11);
    const r = await done;
    check('result: times, both feet, height', !r.error && r.times.length === 11 && r.bones.cf_j_foot_L?.length === 11 && r.bones.cf_j_foot_R && !r.bones.cf_j_nope && r.height > 0, JSON.stringify({ e: r.error, n: r.times?.length, h: r.height }));
    await sleep(600);
    check('playhead put back', near((await ok('timeline.state')).time, 0.5, 1e-3));
    const o = await ok('object.get', { id: item.id });
    await ok('object.set', { ids: [item.id], pos: [o.transform.pos[0] + 0.3, null, null] });
    await sleep(1200);
    const refused = await req('motion.sample', { id: chara.id, bones: ['cf_j_foot_L'] });
    check('refused while changes are unkeyed', !refused.ok, refused.error);
    await ok('timeline.resetPose');
  });
}

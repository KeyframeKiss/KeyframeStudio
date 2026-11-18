export const name = 'Timeline: key changes, auto-key, held-back edits';

export default async function (t) {
  t.needs('timeline');
  const { ok, req, check, near, sleep, studio } = t;
  const { chara, items } = await t.loadSample();
  const tl = () => ok('timeline.get');
  t.defer(() => req('timeline.setAutoKey', { on: false }));

  await t.step('key changed', async () => {
    await ok('timeline.seek', { t: 1.5 });
    await sleep(2500); // the plugin learns what animates by itself (spinning items etc.)
    await ok('timeline.rebase');
    await sleep(1000);
    const c0 = await ok('timeline.changes');
    check('self-animating objects are ignored', c0.count === 0, JSON.stringify(c0.items));
    const o = await ok('object.get', { id: chara.id });
    await ok('object.set', { ids: [chara.id], pos: [o.transform.pos[0] + 0.3, null, null] });
    const c1 = await ok('timeline.changes');
    check('move detected as a change', c1.count >= 1 && c1.items.some((i) => i.isNew));
    const n = await ok('timeline.keyChanged', { includeNew: true });
    const tr = (await tl()).tracks.find((x) => x.oci === chara.id && x.model === 'guideObjectPos');
    check('keyChanged created a track with rest key + key', n >= 1 && tr?.keys.length === 2 && tr.keys[0][0] === 0 && near(tr.keys[1][0], 1.5));
    check('nothing pending after keying', (await ok('timeline.changes')).count === 0);
    await ok('undo');
    check('undo removes the created track', !(await tl()).tracks.some((x) => x.oci === chara.id && x.model === 'guideObjectPos'));
    await ok('object.set', { ids: [chara.id], pos: o.transform.pos });
  });

  await t.step('auto-key', async () => {
    const o = await ok('object.get', { id: chara.id });
    await ok('timeline.seek', { t: 2.5 });
    await sleep(1200);
    await ok('timeline.setAutoKey', { on: true, newTracks: true });
    await sleep(500);
    const got = studio.waitFor('autokey', () => true, 6000).catch(() => null);
    await ok('object.set', { ids: [chara.id], pos: [null, o.transform.pos[1] + 0.2, null] });
    check('auto-key event', (await got) != null);
    const d = await tl();
    const tr = d.tracks.find((x) => x.oci === chara.id && x.model === 'guideObjectPos');
    check('auto-key keyed the move', tr?.keys.some((k) => near(k[0], 2.5)));
    check('auto-key ignored self-animating objects', !d.tracks.some((x) => x.model?.startsWith('guideObject') && x.oci !== chara.id));
    check('auto-key off', (await ok('timeline.setAutoKey', { on: false })).on === false);
    if (tr) await ok('timeline.removeTracks', { tracks: [tr.id] });
    await ok('object.set', { ids: [chara.id], pos: o.transform.pos });
  });

  await t.step('held-back key edits protect unkeyed changes', async () => {
    const [i1, i2] = items;
    const T1 = await ok('timeline.addTrack', { owner: 'Timeline', model: 'guideObjectPos', oci: i1.id, keyAt: 0 });
    const T2 = await ok('timeline.addTrack', { owner: 'Timeline', model: 'guideObjectPos', oci: i2.id, keyAt: 0 });
    await ok('timeline.seek', { t: 0 });
    await sleep(1200);
    const p0 = (await ok('object.get', { id: i2.id })).transform.pos;
    const since = studio.events.length;
    await ok('object.set', { ids: [i2.id], pos: [p0[0] + 0.5, p0[1], p0[2]] });
    await sleep(1500);
    check('unkeyed change counted', (studio.last('timeline.pending', since) ?? 0) > 0);
    await ok('timeline.addKeys', { tracks: [T1], t: 0.5 });
    await sleep(1200);
    check('adding a key leaves the pose alone', studio.last('timeline.poseStale', since) !== true);
    check('still counted after an edit', (await ok('timeline.state')).pending > 0);
    await ok('timeline.moveKeys', { keys: [{ track: T1, t: 0.5 }], dt: 0.25 });
    await sleep(1200);
    check('moving keys marks the pose stale', (await ok('timeline.state')).poseStale === true);
    const p1 = (await ok('object.get', { id: i2.id })).transform.pos;
    check('the unkeyed move survives edits', near(p1[0], p0[0] + 0.5));
    await ok('timeline.resetPose');
    await sleep(1200);
    const st = await ok('timeline.state');
    check('reset pose: back to the key', near((await ok('object.get', { id: i2.id })).transform.pos[0], p0[0]));
    check('reset pose: nothing stale or pending', !st.poseStale && st.pending === 0);
    await ok('object.set', { ids: [i2.id], pos: [p0[0] + 0.3, p0[1], p0[2]] });
    await sleep(1500);
    await ok('timeline.moveKeys', { keys: [{ track: T1, t: 0.75 }], dt: 0.1 });
    await sleep(1200);
    check('stale again', (await ok('timeline.state')).poseStale === true);
    await ok('timeline.keyChanged', { includeNew: false });
    await sleep(1200);
    check('key changes clears stale', (await ok('timeline.state')).poseStale === false);
    check('keyed value kept', near((await ok('object.get', { id: i2.id })).transform.pos[0], p0[0] + 0.3));
    await ok('timeline.removeTracks', { tracks: [T1, T2] });
  });
}

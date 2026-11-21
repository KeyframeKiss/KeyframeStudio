export const name = 'Foot & hand locking: stays put while the body moves, FK limb converted, one undo step';

export default async function (t) {
  const { ok, req, check, sleep, near, studio } = t;
  const { chara } = await t.loadSample();
  if (!chara) t.skip('the sample scene has no character');
  const id = chara.id;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // where bones are over a time range (the foot-sliding check's sampler)
  async function sample(bones, t0, t1, rate = 20) {
    const done = studio.waitFor('motion.sample', () => true, 60000);
    await ok('motion.sample', { id, bones, t0, t1, rate });
    const r = await done;
    if (r.error) throw new Error(r.error);
    return r;
  }
  const drift = (pts) => Math.max(...pts.map((p) => dist(p, pts[0])));
  async function lock(args) {
    const done = studio.waitFor('motion.lock', (d) => d.done, 120000);
    const started = await req('motion.lock', { id, ...args });
    if (!started.ok) return { refused: started.error };
    return done;
  }

  // the character glides 0.6 to the side over 2 s: its feet slide unless locked
  let charTrack;
  const duration = (await ok('timeline.get')).duration;
  t.defer(() => req('timeline.setSettings', { duration }));
  await t.step('a moving character', async () => {
    await ok('timeline.setSettings', { duration: 3 });
    await ok('timeline.seek', { t: 0 });
    await sleep(600);
    charTrack = await ok('timeline.addTrack', { owner: 'Timeline', model: 'guideObjectPos', oci: id, keyAt: 0 });
    const o = await ok('object.get', { id });
    await ok('timeline.seek', { t: 2 });
    await sleep(600);
    await ok('object.set', { ids: [id], pos: [o.transform.pos[0] + 0.6, null, null] });
    await sleep(800);
    await ok('timeline.addKeys', { tracks: [charTrack], t: 2 });
    await ok('timeline.resetPose');
    await ok('timeline.seek', { t: 0.25 });
    await sleep(1000);
    const st = await ok('timeline.state');
    check('no unkeyed changes left', (st.pending ?? 0) === 0, `pending ${st.pending}`);
  });
  t.defer(() => req('timeline.removeTracks', { tracks: [charTrack] }));

  const before = await sample(['cf_j_foot_L', 'cf_j_foot_R', 'cf_j_thigh00_L'], 0, 2, 20);
  // tolerances scale with the leg (hip to ankle), whatever pose or size the character has
  const h = dist(before.bones.cf_j_thigh00_L[0], before.bones.cf_j_foot_L[0]) * 2;
  t.metric('leg length', ((h / 2)).toFixed(4), 'units');
  const slid = drift(before.bones.cf_j_foot_L.slice(10, 31)); // 0.5 … 1.5 s
  check('before locking the left foot slides with the body', slid > 0.15, slid.toFixed(3));

  const kinOf = async () => (await ok('chara.get', { id })).kinematics;
  const legIk = (k) => !!(k.ik && k.ikParts[2].on);
  const kin0 = await kinOf();
  let first;
  await t.step('lock the left foot (FK or idle limb: converted to IK)', async () => {
    first = await lock({ limb: 'footL', t0: 0.5, t1: 1.5 });
    check('locked', !first.refused && !first.error && first.keys > 0, JSON.stringify(first));
    t.metric('keys written', first.keys, '');
    check('the limb was converted (it was not on IK)', first.converted === !legIk(kin0), `converted ${first.converted}, ik before ${legIk(kin0)}`);
    const st = await ok('timeline.state');
    check('playhead put back', near(st.time, 0.25, 2e-3), String(st.time));
    check('left leg now on IK', legIk(await kinOf()));
  });

  await t.step('the foot stays put over the range', async () => {
    const after = await sample(['cf_j_foot_L', 'cf_j_foot_R'], 0.5, 1.5, 20);
    const d = drift(after.bones.cf_j_foot_L);
    t.metric('left foot drift while locked', (d).toFixed(4), 'units');
    check('left foot drift under 1% of body height', d < 0.01 * h, `${d.toFixed(4)} vs ${(0.01 * h).toFixed(4)}`);
    const right = drift(after.bones.cf_j_foot_R);
    check('the right foot still slides (only the left was locked)', right > 0.15, right.toFixed(3));
    // where it's kept: where it was at the start of the range
    const start = before.bones.cf_j_foot_L[10];
    check('kept at its spot at 0.5 s', dist(after.bones.cf_j_foot_L[0], start) < 0.02 * h, dist(after.bones.cf_j_foot_L[0], start).toFixed(4));
  });

  await t.step('outside the range the motion is unchanged', async () => {
    // the same moments as before (0 … 2 s, 20 a second); compare before the range and after its release
    const after = await sample(['cf_j_foot_L'], 0, 2, 20);
    const idx = [0, 2, 4, 6, 8, 36, 37, 38, 39, 40]; // 0 … 0.4 s and 1.8 … 2.0 s
    const worst = Math.max(...idx.map((i) => dist(after.bones.cf_j_foot_L[i], before.bones.cf_j_foot_L[i])));
    t.metric('left foot change after the range', (worst).toFixed(4), 'units');
    check('within 2% of body height of before', worst < 0.02 * h, `${worst.toFixed(4)} vs ${(0.02 * h).toFixed(4)}`);
  });

  await t.step('after the range it eases back into its motion (no snap)', async () => {
    const s = await sample(['cf_j_foot_L'], 1.4, 1.9, 30);
    const steps = s.bones.cf_j_foot_L.slice(1).map((p, i) => dist(p, s.bones.cf_j_foot_L[i]));
    const worst = Math.max(...steps);
    t.metric('largest move between frames while letting go', worst.toFixed(4), 'units');
    // without easing the foot snapped 0.3 in one frame; a quarter-second release catches up over ~8 frames
    const moving = steps.filter((x) => x > 0.015).length;
    check('no jump when the lock ends', worst < 0.1 && moving >= 5, `largest ${worst.toFixed(4)}, ${moving} frames moving`);
  });

  await t.step('one undo step puts everything back', async () => {
    await ok('undo');
    await sleep(800);
    const kin = await kinOf();
    const sig = (k) => JSON.stringify([k.fk, k.ik, k.ikParts.map((p) => p.on), k.fkParts.map((p) => p.on)]);
    check('FK / IK as before', sig(kin) === sig(kin0), `${sig(kin0)} → ${sig(kin)}`);
    const again = await sample(['cf_j_foot_L'], 0.5, 1.5, 20);
    check('the foot slides again', drift(again.bones.cf_j_foot_L) > 0.15, drift(again.bones.cf_j_foot_L).toFixed(3));
    await ok('redo');
    await sleep(800);
    const redone = await sample(['cf_j_foot_L'], 0.5, 1.5, 20);
    check('redo locks it again', drift(redone.bones.cf_j_foot_L) < 0.01 * h, drift(redone.bones.cf_j_foot_L).toFixed(4));
  });

  await t.step('a second lock on an IK limb writes only its range', async () => {
    const r = await lock({ limb: 'footL', t0: 1.7, t1: 2.2, rotation: false });
    check('locked without converting', !r.refused && !r.error && r.converted === false && r.keys > 0, JSON.stringify(r));
    const s = await sample(['cf_j_foot_L'], 1.7, 2.2, 20);
    const d = drift(s.bones.cf_j_foot_L);
    check('held over 1.7 … 2.2 s', d < 0.01 * h, d.toFixed(4));
    const s1 = await sample(['cf_j_foot_L'], 0.5, 1.5, 20);
    check('the first lock is untouched', drift(s1.bones.cf_j_foot_L) < 0.01 * h, drift(s1.bones.cf_j_foot_L).toFixed(4));
    await ok('undo');
  });

  await t.step('a hand', async () => {
    // a short range: the body moves less than the arm can reach
    const r = await lock({ limb: 'handR', t0: 0.3, t1: 0.42 });
    check('right hand locked', !r.refused && !r.error && r.keys > 0 && !r.outOfReach, JSON.stringify(r));
    const s = await sample(['cf_j_hand_R'], 0.3, 0.42, 30);
    const d = drift(s.bones.cf_j_hand_R);
    t.metric('right hand drift while locked', (d).toFixed(4), 'units');
    check('hand held within 1% of body height', d < 0.01 * h, d.toFixed(4));
    await ok('undo');
    // the body walks away further than the arm reaches: held as close as it can, and the result says so
    const far = await lock({ limb: 'handR', t0: 0.3, t1: 0.9 });
    check('out of reach is reported', !!far.outOfReach && far.outOfReach.from > 0.35 && far.outOfReach.from < 0.7, JSON.stringify(far.outOfReach));
    await ok('undo');
  });

  await t.step('refusals', async () => {
    const bad = await req('motion.lock', { id, limb: 'tail', t0: 0, t1: 1 });
    check('unknown limb refused', !bad.ok, bad.error);
    const tiny = await req('motion.lock', { id, limb: 'footR', t0: 1, t1: 1 });
    check('a zero-length range refused', !tiny.ok, tiny.error);
    const o = await ok('object.get', { id });
    await ok('object.set', { ids: [id], pos: [o.transform.pos[0] + 0.2, null, null] });
    await sleep(1200);
    const pend = await req('motion.lock', { id, limb: 'footR', t0: 0, t1: 1 });
    check('refused while changes are unkeyed', !pend.ok, pend.error);
    await ok('timeline.resetPose');
  });

  await ok('undo'); // the first lock (redone above)
}

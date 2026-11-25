export const name = 'Posing: joints / target per limb without jumps, IK strength, joint correction, copy a side, physics, bones; undo';

// Character › Posing (Api/PosingApi.cs). The KKPE parts are skipped (not failed) when KKPE isn't installed.
export default async function (t) {
  const { ok, req, check, sleep } = t;
  const { chara } = await t.loadSample();
  if (!chara) t.skip('the sample scene has no character');
  const id = chara.id;
  const st0 = await ok('chara.get', { id });
  t.defer(async () => {
    await req('chara.set', { ids: [id], fk: false, ik: false });
    await req('chara.set', { ids: [id], animeSpeed: st0.anime.speed });
  });
  // a still pose, so "didn't move" can be measured
  await ok('chara.set', { ids: [id], fk: false, ik: false, animeSpeed: 0 });
  await sleep(500);

  const hand = async () => {
    const done = t.studio.waitFor('motion.sample', () => true, 30000);
    await ok('motion.sample', { id, bones: ['cf_j_hand_L', 'cf_j_foot_R'], t0: 0, t1: 0, rate: 1 });
    const r = await done;
    return [r.bones.cf_j_hand_L[0], r.bones.cf_j_foot_R[0]];
  };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const mode = (p, l) => p.limbs.find((x) => x.limb === l)?.mode;

  let p = await ok('posing.get', { id });
  check('five parts, all on the animation to start', p.limbs.length === 5 && p.limbs.every((x) => x.mode === 'anim'), JSON.stringify(p.limbs));

  await t.step('a limb by its target, then by its joints: the pose stays', async () => {
    const before = await hand();
    p = await ok('posing.mode', { id, limb: 'armL', mode: 'ik' });
    check('left arm on a target, the rest unchanged', mode(p, 'armL') === 'ik' && mode(p, 'armR') === 'anim', JSON.stringify(p.limbs));
    await sleep(300);
    const mid = await hand();
    t.metric('left hand moved going to a target', dist(before[0], mid[0]), 'm');
    check('the hand stays where it was (target)', dist(before[0], mid[0]) < 0.02, dist(before[0], mid[0]).toFixed(4));
    p = await ok('posing.mode', { id, limb: 'armL', mode: 'fk' });
    check('left arm by its joints now', mode(p, 'armL') === 'fk', JSON.stringify(p.limbs));
    await sleep(300);
    const after = await hand();
    t.metric('left hand moved target → joints', dist(mid[0], after[0]), 'm');
    check('the hand stays where it was (target → joints)', dist(mid[0], after[0]) < 0.02, dist(mid[0], after[0]).toFixed(4));
    check('the right foot didn’t move either', dist(before[1], after[1]) < 0.02, dist(before[1], after[1]).toFixed(4));
    await ok('undo');
    p = await ok('posing.get', { id });
    check('undo: the left arm is on its target again', mode(p, 'armL') === 'ik', JSON.stringify(p.limbs));
    p = await ok('posing.mode', { id, part: 'neck', mode: 'fk' });
    check('the neck by its joints', p.fkExtras.find((x) => x.part === 'neck')?.on === true, JSON.stringify(p.fkExtras));
    p = await ok('posing.mode', { id, mode: 'anim' });
    check('let the animation play: everything back on the animation', p.limbs.every((x) => x.mode === 'anim') && !p.fk && !p.ik, JSON.stringify(p));
  });

  await t.step('key the whole pose: a character’s first key, nothing moves, one undo', async () => {
    await ok('chara.set', { ids: [id], fk: false, ik: false });
    await sleep(400);
    const tracksOf = async () => (await ok('timeline.get')).tracks.filter((x) => x.oci === id);
    const before = await tracksOf();
    const pose0 = await hand();
    const n = await ok('timeline.keyPose', { ids: [id], t: 0, extra: ['characterEyes', 'characterMouth'] });
    await sleep(400);
    const after = await tracksOf();
    t.metric('tracks keyed', n, '');
    check('many tracks keyed (place, joints, face)', n > 40, String(n));
    check('tracks made for it', after.length >= before.length + 40, `${before.length} → ${after.length}`);
    check('the face came too', after.some((x) => x.model === 'characterEyes') && after.some((x) => x.model === 'characterMouth'));
    check('every new track has a key at the playhead', after.filter((x) => !before.some((b) => b.id === x.id)).every((x) => x.keys?.some((k) => Math.abs(k[0]) < 1e-3) ?? false));
    const pz = await ok('posing.get', { id });
    check('the animation’s pose is now held by joints', pz.fk && pz.limbs.every((x) => x.mode === 'fk'), JSON.stringify(pz.limbs));
    const pose1 = await hand();
    t.metric('left hand moved by keying the pose', dist(pose0[0], pose1[0]), 'm');
    check('nothing moved', dist(pose0[0], pose1[0]) < 0.02 && dist(pose0[1], pose1[1]) < 0.02, `${dist(pose0[0], pose1[0]).toFixed(4)} / ${dist(pose0[1], pose1[1]).toFixed(4)}`);
    await ok('undo');
    await sleep(300);
    const back = await tracksOf();
    const pu = await ok('posing.get', { id });
    check('one undo: the tracks are gone and the animation plays the pose again', back.length === before.length && pu.limbs.every((x) => x.mode === 'anim'), `${back.length} tracks, ${JSON.stringify(pu.limbs)}`);
  });

  if (p.kkpe !== 'ok') {
    t.say(`KKPE: ${p.kkpe} — its parts skipped`);
    return;
  }

  await t.step('target strength and bend goals', async () => {
    await ok('posing.mode', { id, limb: 'armL', mode: 'ik' });
    let rows = await ok('posing.ik', { id, key: 'handL', pos: 0.5 });
    let r = rows.find((x) => x.key === 'handL');
    check('left hand at half strength, marked changed', Math.abs(r.pos - 0.5) < 1e-3 && r.edited, JSON.stringify(r));
    rows = await ok('posing.ik', { id, key: 'elbowL', bend: 0.8 });
    r = rows.find((x) => x.key === 'elbowL');
    check('left elbow bend goal at 0.8', Math.abs(r.bend - 0.8) < 1e-3 && r.edited, JSON.stringify(r));
    await ok('undo');
    await ok('undo');
    p = await ok('posing.get', { id });
    r = p.ikWeights.find((x) => x.key === 'handL');
    check('undo twice: the hand is back as it was, not marked changed', !r.edited, JSON.stringify(r));
    await ok('posing.ik', { id, key: 'kneeR', bend: 0.4 });
    rows = await ok('posing.ik', { id, key: 'kneeR', reset: true });
    check('reset puts a bend goal back', !rows.find((x) => x.key === 'kneeR').edited);
  });

  await t.step('joint correction', async () => {
    const was = p.joints.crotch;
    const j = await ok('posing.joints', { id, crotch: !was });
    check('crotch correction switched', j.crotch === !was, JSON.stringify(j));
    await ok('undo');
    p = await ok('posing.get', { id });
    check('undo switches it back', p.joints.crotch === was, JSON.stringify(p.joints));
  });

  await t.step('copy a side', async () => {
    await ok('posing.mode', { id, limb: 'armL', mode: 'fk' });
    check('left arm copied onto the right', (await ok('posing.copy', { id, what: 'arm', from: 'L' })) === true);
    await sleep(400);
    check('left fingers copied onto the right', (await ok('posing.copy', { id, what: 'hand', from: 'L' })) === true);
    await sleep(300);
    await ok('undo');
    await ok('undo');
  });

  await t.step('physics', async () => {
    if (p.bust.length) {
      const b = p.bust[0];
      const g = [b.gravity[0], b.gravity[1] - 0.002, b.gravity[2]];
      let list = await ok('posing.bust', { id, which: b.id, gravity: g });
      check(`${b.label}: gravity changed`, list.find((x) => x.id === b.id).edited);
      await ok('undo');
      list = (await ok('posing.get', { id })).bust;
      check(`${b.label}: undo puts it back`, !list.find((x) => x.id === b.id).edited);
    } else t.say('no bust settings on this character');
    if (p.dyn.length) {
      const d = p.dyn[0];
      let list = await ok('posing.dyn', { id, path: d.path, stiffness: 0.37 });
      const e = list.find((x) => x.path === d.path);
      check(`${d.name}: stiffness 0.37`, Math.abs(e.stiffness - 0.37) < 1e-3 && e.edited, JSON.stringify(e));
      await ok('undo');
      list = (await ok('posing.get', { id })).dyn;
      const u = list.find((x) => x.path === d.path);
      check(`${d.name}: undo puts it back`, !u.edited && Math.abs(u.stiffness - d.stiffness) < 1e-3, JSON.stringify(u));
    } else t.say('no swaying parts on this character');
  });

  // ◆ beside a value: its KKPE Timeline track, added and keyed at the playhead (the app's lib/posingTracks.ts names)
  await t.step('◆ keys: target strength, a physics bone, a collider', async () => {
    const all = async () => (await ok('timeline.get')).tracks;
    const n0 = (await all()).length;
    const tl0 = await ok('timeline.get');
    const at = Math.min(1, tl0.duration / 2);
    const tid = await ok('timeline.addTrack', { owner: 'KKPE', model: 'fbbikEffectorPositionWeightL. Hand', oci: id, keyAt: at });
    let tr = (await all()).find((x) => x.id === tid);
    check('left hand strength: a track on this character, keyed', tr && tr.oci === id && tr.keys?.length === 1, JSON.stringify(tr && { oci: tr.oci, name: tr.name, keys: tr.keys }));
    // again at the same time: the same track, still one key
    const again = await ok('timeline.addTrack', { owner: 'KKPE', model: 'fbbikEffectorPositionWeightL. Hand', oci: id, keyAt: at });
    check('a second ◆ keys the same track', again === tid && (await all()).find((x) => x.id === tid).keys.length === 1);
    if (p.dyn.length) {
      const d = p.dyn[0];
      const did = await ok('timeline.addTrack', { owner: 'KKPE', model: 'dynamicBoneStiffness', oci: id, param: d.path, keyAt: at });
      tr = (await all()).find((x) => x.id === did);
      check(`${d.name}: stiffness track for that bone, keyed`, tr && tr.keys?.length === 1 && did !== tid, JSON.stringify(tr && { name: tr.name, keys: tr.keys }));
      const other = p.dyn[1];
      if (other) {
        const oid = await ok('timeline.addTrack', { owner: 'KKPE', model: 'dynamicBoneStiffness', oci: id, param: other.path, keyAt: at });
        check('another bone: another track', oid !== did);
      }
      const bad = await req('timeline.addTrack', { owner: 'KKPE', model: 'dynamicBoneStiffness', oci: id, param: 'no/such/bone', keyAt: at });
      check('a bone that isn’t there is refused, nothing added', !bad.ok || bad.result == null, JSON.stringify(bad).slice(0, 160));
    }
    const cols = p.colliders ?? [];
    if (cols.length) {
      const cid = await ok('timeline.addTrack', { owner: 'KKPE', model: 'colliderRadius', oci: id, param: cols[0].path, keyAt: at });
      tr = (await all()).find((x) => x.id === cid);
      check(`collider ${cols[0].name}: size track, keyed`, tr && tr.keys?.length === 1, JSON.stringify(tr && { name: tr.name }));
    }
    // undo everything this step made
    for (let i = 0; i < 8 && (await all()).length > n0; i++) await ok('undo');
    check('undo removes the new tracks', (await all()).length === n0, `${(await all()).length} vs ${n0}`);
  });

  await t.step('colliders', async () => {
    const cols = (await ok('posing.get', { id })).colliders ?? [];
    if (!cols.length) return t.say('no colliders on this character (KKPE)');
    t.metric('colliders', cols.length, '');
    check('each with a path, size, length, direction and side', cols.every((c) => c.path && typeof c.radius === 'number' && typeof c.height === 'number' && c.center?.length === 3 && [0, 1, 2].includes(c.direction) && [0, 1].includes(c.bound)), JSON.stringify(cols[0]));
    const c = cols[0];
    let list = await ok('posing.collider', { id, path: c.path, radius: c.radius + 0.02 });
    let e = list.find((x) => x.path === c.path);
    check(`${c.name}: bigger, marked changed`, Math.abs(e.radius - (c.radius + 0.02)) < 1e-4 && e.edited, JSON.stringify(e));
    // a drag: several steps, one undo
    await ok('posing.collider', { id, path: c.path, height: c.height + 0.01 });
    await ok('posing.collider', { id, path: c.path, height: c.height + 0.02 });
    await ok('posing.collider', { id, path: c.path, height: c.height + 0.03 });
    list = await ok('posing.collider', { id, path: c.path, bound: c.bound ? 0 : 1, center: [c.center[0], c.center[1] + 0.01, c.center[2]] });
    e = list.find((x) => x.path === c.path);
    check('length, side and centre changed', Math.abs(e.height - (c.height + 0.03)) < 1e-4 && e.bound !== c.bound && Math.abs(e.center[1] - c.center[1] - 0.01) < 1e-4, JSON.stringify(e));
    await ok('undo'); // side + centre
    await ok('undo'); // the length drag
    list = (await ok('posing.get', { id })).colliders;
    e = list.find((x) => x.path === c.path);
    check('undo: the length drag goes back in one step', Math.abs(e.height - c.height) < 1e-4 && Math.abs(e.radius - (c.radius + 0.02)) < 1e-4, JSON.stringify(e));
    list = await ok('posing.collider', { id, path: c.path, reset: true });
    e = list.find((x) => x.path === c.path);
    check('reset: as the game made it, not marked changed', !e.edited && Math.abs(e.radius - c.radius) < 1e-4, JSON.stringify(e));
    await ok('undo'); // the reset
    await ok('undo'); // the size
    e = (await ok('posing.get', { id })).colliders.find((x) => x.path === c.path);
    check('undo back to the start', !e.edited && Math.abs(e.radius - c.radius) < 1e-4, JSON.stringify(e));
    const bad = await req('posing.collider', { id, path: 'nope/none', radius: 1 });
    check('an unknown collider is refused', !bad.ok);
  });

  await t.step('every bone', async () => {
    const bones = await ok('posing.bones', { id });
    t.metric('bones listed', bones.length, '');
    check('a long list with the hand in it', bones.length > 100 && bones.some((b) => b.name === 'cf_j_hand_L'), String(bones.length));
    await ok('face.set', { id, bone: 'cf_s_spine02', scale: [1.1, 1, 1], mirror: false });
    const again = await ok('posing.bones', { id });
    check('a changed bone shows as changed', again.find((b) => b.name === 'cf_s_spine02')?.edited === true);
    await ok('undo');
  });
}

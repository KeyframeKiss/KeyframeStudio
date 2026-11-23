export const name = 'Studio animation clips on the timeline: put on, a second clip, undo, bake to FK keys';

export default async function (t) {
  const { ok, req, check, sleep, near, studio } = t;
  const { chara } = await t.loadSample();
  if (!chara) t.skip('the sample scene has no character');
  const id = chara.id;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const BONES = ['cf_j_hand_L', 'cf_j_hand_R', 'cf_j_head', 'cf_j_foot_L', 'cf_j_index03_L'];

  async function sample(t0, t1, rate = 15) {
    const done = studio.waitFor('motion.sample', () => true, 60000);
    await ok('motion.sample', { id, bones: BONES, t0, t1, rate });
    const r = await done;
    if (r.error) throw new Error(r.error);
    return r;
  }
  const travel = (pts) => Math.max(...pts.map((p) => dist(p, pts[0])));
  let where = '';
  const worst = (a, b) => {
    let w = 0;
    for (const k of Object.keys(a.bones))
      for (let i = 0; i < a.bones[k].length; i++) {
        const d = dist(a.bones[k][i], b.bones[k][i]);
        if (d > w) (w = d), (where = `${k} #${i}`);
      }
    return w;
  };

  const tl0 = await ok('timeline.get');
  const st0 = await ok('chara.get', { id });
  t.defer(async () => {
    const info = await req('anim.timeline', { id });
    const tracks = info.ok ? [info.result.tracks.clip, info.result.tracks.time].filter((x) => x != null) : [];
    if (tracks.length) await req('timeline.removeTracks', { tracks });
    await req('chara.set', { ids: [id], fk: false, ik: false });
    await req('chara.loadAnime', { ids: [id], group: st0.anime.group, category: st0.anime.category, no: st0.anime.no, letPlay: false });
    await req('chara.set', { ids: [id], animeSpeed: st0.anime.speed });
    await req('timeline.setSettings', { duration: tl0.duration });
  });
  await ok('timeline.setSettings', { duration: 4 });
  await ok('chara.set', { ids: [id], fk: false, ik: false });
  await ok('timeline.seek', { t: 0 });
  await sleep(500);

  // a clip that visibly moves (a hand travels over two seconds once it's on the timeline)
  let cat = await ok('chara.animations');
  for (let i = 0; i < 20 && !cat.length; i++) (await sleep(1000), (cat = await ok('chara.animations')));
  const candidates = cat.flatMap((g) => g.categories.flatMap((c) => c.clips.slice(0, 4).map((clip) => ({ g: g.id, c: c.id, no: clip.no })))).slice(0, 40);
  let clip, base;
  await t.step('put a clip on the timeline', async () => {
    for (const cand of candidates.filter((_, i) => i % 5 === 0).slice(0, 8)) {
      await ok('chara.loadAnime', { ids: [id], group: cand.g, category: cand.c, no: cand.no });
      await sleep(400);
      const r = await ok('anim.toTimeline', { id, t: 0 });
      await sleep(300);
      const s = await sample(0, 2);
      const moved = Math.max(travel(s.bones.cf_j_hand_L), travel(s.bones.cf_j_hand_R), travel(s.bones.cf_j_head));
      if (moved > 0.05) {
        clip = { ...cand, r };
        t.metric('clip', JSON.stringify(cand), '');
        base = s;
        t.metric('hand / head travel over 2 s', moved.toFixed(3), 'units');
        break;
      }
      await ok('undo'); // the timeline keys + speed
    }
    if (!clip) t.skip('no moving clip found among the first few');
    const r = clip.r;
    check('starts at 0, runs to the end', near(r.t0, 0, 1e-3) && near(r.t1, 4, 1e-3), JSON.stringify(r));
    const info = await ok('anim.timeline', { id });
    check('the timeline drives it', info.driven && info.segments.length === 1, JSON.stringify(info));
    const st = await ok('chara.get', { id });
    check("Studio's own playback stopped (speed 0)", st.anime.speed === 0, String(st.anime.speed));
    const again = await sample(0, 2);
    check('scrubbing gives the same pose every time', worst(base, again) < 1e-3, worst(base, again).toFixed(5));
  });

  await t.step('a second clip later on: the first holds, the second starts from its beginning', async () => {
    const other = candidates.find((c) => c.no !== clip.no || c.c !== clip.c || c.g !== clip.g);
    const lr = await ok('chara.loadAnime', { ids: [id], group: other.g, category: other.c, no: other.no });
    check('picking a clip for a timeline-driven character leaves it stopped', !lr.started?.length && lr.driven?.length === 1, JSON.stringify(lr));
    await ok('anim.toTimeline', { id, t: 2 });
    const info = await ok('anim.timeline', { id });
    const seg = info.segments;
    check('two stretches: 0–2, 2–4', seg.length === 2 && near(seg[0].t1, 2, 1e-3) && near(seg[1].t0, 2, 1e-3) && near(seg[1].t1, 4, 1e-3), JSON.stringify(seg));
    // the same moments as before, up to just before the second clip starts at 2 s
    const cut = (r) => ({ bones: Object.fromEntries(Object.entries(r.bones).map(([k, v]) => [k, v.filter((_, i) => r.times[i] < 1.95)])) });
    const now = await sample(0, 2);
    const before = cut(now);
    const firstPart = cut(base);
    check('the first stretch is unchanged', worst(firstPart, before) < 1e-3, `${worst(firstPart, before).toFixed(5)} at ${where}`);
    await ok('undo');
    const back = await ok('anim.timeline', { id });
    check('one undo takes the second stretch off', back.segments.length === 1, JSON.stringify(back.segments));
    await ok('undo'); // the clip change
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
  });

  await t.step('bake to FK keys: same motion, editable keys, one undo', async () => {
    const before = await sample(0, 2);
    check('before the bake the clip still plays as it did', worst(base, before) < 1e-3, `${worst(base, before).toFixed(5)} at ${where}`);
    const tracksBefore = (await ok('timeline.get')).tracks.length;
    const r = await ok('anim.bake', { id, t0: 0, t1: 2 });
    t.metric('bake', `${r.keys} keys on ${r.bones} bones from ${r.samples} samples`, '');
    check('baked keys on the body, neck and fingers', r.bones > 30 && r.keys > r.bones * 2, JSON.stringify(r));
    check('fewer keys than samples (only as many as needed)', r.keys < r.bones * r.samples * 0.6, `${r.keys} of ${r.bones * r.samples}`);
    const tl = await ok('timeline.get');
    check('new rotation tracks, in a "(baked)" folder', tl.tracks.length - tracksBefore === r.tracks && JSON.stringify(tl.groups ?? []).includes('(baked)'), `${tl.tracks.length - tracksBefore} new`);
    const st = await ok('chara.get', { id });
    check('FK is on (it drives the baked parts)', st.kinematics.fk === true);
    const st2 = await ok('timeline.state');
    check('playhead put back', near(st2.time, 0.5, 2e-3), String(st2.time));
    const after = await sample(0, 2);
    // about the character's height: the furthest the head gets from a foot over the clip
    const h = Math.max(...base.bones.cf_j_head.map((p, i) => dist(p, base.bones.cf_j_foot_L[i])));
    const w = worst(base, after);
    t.metric('worst bone off after the bake', w.toFixed(4), 'units');
    check('the baked motion matches the clip (within 2% of body height)', w < 0.02 * h, `${w.toFixed(4)} vs ${(0.02 * h).toFixed(4)} at ${where}`);

    // muting the baked keys shows the clip again (not a body frozen in its last baked pose); unmuting brings them back
    const bakedIds = (await ok('timeline.get')).tracks.filter((x) => x.model === 'guideObjectRot' && x.oci === id).map((x) => x.id);
    await ok('timeline.setTracksEnabled', { tracks: bakedIds, enabled: false });
    await sleep(300);
    const fkMuted = (await ok('chara.get', { id })).kinematics;
    check('all baked keys muted: FK lets go of those parts', !fkMuted.fk || !fkMuted.fkParts.find((p) => p.name === 'Body').on, JSON.stringify(fkMuted.fkParts));
    const shown = await sample(0, 2);
    check('…and the clip plays as it did', worst(base, shown) < 1e-3, `${worst(base, shown).toFixed(5)} at ${where}`);
    await ok('undo');
    await sleep(300);
    check('one undo: keys and FK back', (await ok('chara.get', { id })).kinematics.fk === true && (await ok('timeline.get')).tracks.filter((x) => bakedIds.includes(x.id)).every((x) => x.enabled));
    await ok('timeline.setTrack', { track: bakedIds[0], enabled: false });
    check('muting one bone keeps FK on its part', (await ok('chara.get', { id })).kinematics.fk === true);
    await ok('undo');

    // the clip muted, Studio's playback started, then unmuted: the timeline drives it again (stopped in between)
    const info = await ok('anim.timeline', { id });
    const clipIds = [info.tracks.clip, info.tracks.time];
    await ok('timeline.setTracksEnabled', { tracks: clipIds, enabled: false });
    await ok('chara.set', { ids: [id], animeSpeed: 1 });
    await sleep(400);
    await ok('timeline.setTracksEnabled', { tracks: clipIds, enabled: true });
    check('unmuted clip: speed back to 0', (await ok('chara.get', { id })).anime.speed === 0);
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const again = await sample(0, 2);
    check('…and baked + clip play as before', worst(after, again) < 1e-3, `${worst(after, again).toFixed(5)} at ${where}`);
    await ok('undo');
    await ok('undo');
    await ok('undo');
    await sleep(300);

    await ok('undo');
    await sleep(300);
    const un = await ok('timeline.get');
    check('one undo removes the baked tracks', un.tracks.length === tracksBefore, `${un.tracks.length} vs ${tracksBefore}`);
    check('…and FK goes back off', (await ok('chara.get', { id })).kinematics.fk === false);
  });
}

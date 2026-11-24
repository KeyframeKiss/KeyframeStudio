export const name = 'Studio animation clips on the timeline: put on, a second clip, undo, muting, a longer timeline';

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
    // a walk first (its bob and travel are what a bake has to carry), then whatever moves
    const walk = cat.find((g) => g.id === 0)?.categories.find((c) => c.id === 3)?.clips.find((x) => x.no === 0);
    const tries = [...(walk ? [{ g: 0, c: 3, no: 0 }] : []), ...candidates.filter((_, i) => i % 5 === 0).slice(0, 8)];
    for (const cand of tries) {
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
    const tv = Object.values(await ok('timeline.keyValues', { tracks: [info.tracks.time] }))[0];
    check('the second clip runs (picked with playback stopped, its length still read right)', tv[tv.length - 1][1].value > 0.2, JSON.stringify(tv));
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

  await t.step("muting the clip: Studio's own playback stops again when it's unmuted", async () => {
    const info = await ok('anim.timeline', { id });
    const clipIds = [info.tracks.clip, info.tracks.time];
    await ok('timeline.setTracksEnabled', { tracks: clipIds, enabled: false });
    await ok('chara.set', { ids: [id], animeSpeed: 1 });
    await sleep(400);
    await ok('timeline.setTracksEnabled', { tracks: clipIds, enabled: true });
    check('unmuted clip: speed back to 0 (the timeline drives it)', (await ok('chara.get', { id })).anime.speed === 0);
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const again = await sample(0, 2);
    check('…and it plays as before', worst(base, again) < 1e-3, `${worst(base, again).toFixed(5)} at ${where}`);
    await ok('undo');
    await ok('undo');
    await ok('undo');
    await sleep(300);
  });

  await t.step('walk, then a run later: the run plays (not stuck on its first frame)', async () => {
    const run = cat.find((g) => g.id === 0)?.categories.find((c) => c.id === 3)?.clips.find((x) => x.no === 3) ? { g: 0, c: 3, no: 3 } : candidates.find((c) => c.no !== clip.no || c.c !== clip.c);
    await ok('chara.loadAnime', { ids: [id], group: run.g, category: run.c, no: run.no });
    await ok('anim.toTimeline', { id, t: 2 });
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const ref = await sample(0, 4);
    const runTravel = Math.max(...['cf_j_foot_L', 'cf_j_hand_L'].map((b) => travel(ref.bones[b].filter((_, i) => ref.times[i] > 2.05))));
    check('the run moves', runTravel > 0.1, runTravel.toFixed(3));
    await ok('undo');
    await ok('undo');
    await sleep(300);
  });

  await t.step('a longer timeline: a clip that ran to the end runs on (also after shortening it first); one undo step', async () => {
    const len0 = (await ok('timeline.get')).duration;
    const runsOn = async (from, to) => {
      await ok('timeline.seek', { t: 0.5 });
      await sleep(300);
      const sm = await sample(from, to);
      return travel(sm.bones.cf_j_foot_L);
    };
    await ok('timeline.setSettings', { duration: len0 + 3 });
    const on1 = await runsOn(len0 + 0.05, len0 + 2.5);
    check('made longer: the walk carries on past the old end', on1 > 0.05, on1.toFixed(3));
    await ok('undo');
    check('one undo puts the length back', near((await ok('timeline.get')).duration, len0, 1e-3));
    // shorter first (the clip's end is now past the end), then longer than it was
    await ok('timeline.setSettings', { duration: len0 - 1 });
    await ok('timeline.setSettings', { duration: len0 + 3 });
    const on2 = await runsOn(len0 + 0.05, len0 + 2.5);
    check('shortened, then made longer: the walk still carries on', on2 > 0.05, on2.toFixed(3));
    await ok('undo');
    await ok('undo');
    check('…and two undos put it back as it was', near((await ok('timeline.get')).duration, len0, 1e-3));
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const back = await sample(0, 2);
    check('…with the clip as it was', worst(base, back) < 1e-3, `${worst(base, back).toFixed(5)} at ${where}`);
  });
}

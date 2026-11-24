export const name = 'Motion builder: clips and poses in a row, blended, built into keys; undo, redo, edits';

export default async function (t) {
  const { ok, req, check, sleep, studio } = t;
  const { chara } = await t.loadSample();
  if (!chara) t.skip('the sample scene has no character');
  const id = chara.id;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const BONES = ['cf_j_hand_L', 'cf_j_hand_R', 'cf_j_head', 'cf_j_foot_L', 'cf_j_foot_R', 'cf_j_hips'];
  async function sample(t0, t1, rate = 15, bones = BONES) {
    const done = studio.waitFor('motion.sample', () => true, 60000);
    await ok('motion.sample', { id, bones, t0, t1, rate });
    const r = await done;
    if (r.error) throw new Error(r.error);
    return r;
  }
  let where = '';
  const worstIn = (a, b, keep) => {
    let w = 0;
    for (const k of Object.keys(a.bones))
      for (let i = 0; i < a.bones[k].length; i++) {
        if (!keep(a.times[i])) continue;
        const d = dist(a.bones[k][i], b.bones[k][i]);
        if (d > w) (w = d), (where = `${k} @${a.times[i]}s`);
      }
    return w;
  };
  async function build(seq, label) {
    const done = studio.waitFor('motion.build', (d) => d.done && d.id === id, 120000);
    await ok('motion.seq.set', { id, seq, label });
    const r = await done;
    if (r.error) throw new Error(r.error);
    await sleep(300);
    return r;
  }

  const tl0 = await ok('timeline.get');
  const st0 = await ok('chara.get', { id });
  t.defer(async () => {
    await req('motion.seq.clear', { id });
    await req('chara.set', { ids: [id], fk: false, ik: false });
    await req('chara.loadAnime', { ids: [id], group: st0.anime.group, category: st0.anime.category, no: st0.anime.no, letPlay: false });
    await req('chara.set', { ids: [id], animeSpeed: st0.anime.speed });
    await req('timeline.setSettings', { duration: tl0.duration });
  });
  await ok('timeline.setSettings', { duration: 4 });
  await ok('chara.set', { ids: [id], fk: false, ik: false });
  await ok('timeline.seek', { t: 0 });
  await sleep(400);

  let cat = await ok('chara.animations');
  for (let i = 0; i < 20 && !cat.length; i++) (await sleep(1000), (cat = await ok('chara.animations')));
  const has = (g, c, no) => !!cat.find((x) => x.id === g)?.categories.find((x) => x.id === c)?.clips.find((x) => x.no === no);
  if (!has(0, 3, 0) || !has(0, 3, 3)) t.skip('Walking 1 / Running 2 not in the catalog');
  const walk = { group: 0, category: 3, no: 0, name: 'Walking 1' };
  const run = { group: 0, category: 3, no: 3, name: 'Running 2' };

  // the clips on their own (Timeline's animation tracks, no FK): walk from 0, run from 2
  let ref;
  await t.step('reference: the clips alone', async () => {
    await ok('chara.loadAnime', { ids: [id], ...walk });
    await ok('anim.toTimeline', { id, t: 0 });
    await ok('chara.loadAnime', { ids: [id], ...run });
    await ok('anim.toTimeline', { id, t: 2 });
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    ref = await sample(0, 4);
    for (let i = 0; i < 4; i++) await ok('undo');
    const info = await ok('anim.timeline', { id });
    if (info.tracks.clip != null || info.tracks.time != null) await ok('timeline.removeTracks', { tracks: [info.tracks.clip, info.tracks.time].filter((x) => x != null) });
    await ok('chara.loadAnime', { ids: [id], ...walk });
    await sleep(300);
  });

  const seq = {
    blocks: [
      { id: 'w', kind: 'clip', start: 0, len: 2, blend: 0, ease: 'smooth', speed: 1, offset: 0, clip: walk },
      { id: 'r', kind: 'clip', start: 2, len: 2, blend: 0.4, ease: 'smooth', speed: 1, offset: 0, clip: run },
    ],
  };
  let built, got;
  const h = () => Math.max(...ref.bones.cf_j_head.map((p, i) => dist(p, ref.bones.cf_j_foot_L[i])));
  await t.step('walk then run, blended: built into keys', async () => {
    const tracksBefore = (await ok('timeline.get')).tracks.length;
    built = await build(seq, 'Walk then run');
    t.metric('build', `${built.keys} keys on ${built.bones} bones, ${built.samples} samples`, '');
    check('keys written for the body, head and fingers', built.bones > 30 && built.keys > built.bones * 2, JSON.stringify(built));
    check('the clips’ natural lengths reported', built.lengths?.w > 0.3 && built.lengths?.r > 0.3, JSON.stringify(built.lengths));
    const tl = await ok('timeline.get');
    const folder = (tl.groups ?? []).find((g) => g.name.startsWith('Motion: '));
    const inFolder = tl.tracks.filter((x) => x.group === folder?.id);
    check('everything in one "Motion" folder (bones, position, the held clip)', !!folder && inFolder.length === built.tracks && inFolder.some((x) => x.model === 'guideObjectPos') && inFolder.some((x) => x.model === 'charAnimationTime'), `${inFolder.length} of ${built.tracks}`);
    check('one folder’s worth of new tracks', tl.tracks.length - tracksBefore === built.made, `${tl.tracks.length - tracksBefore} vs ${built.made}`);
    const st = await ok('chara.get', { id });
    check('FK on, IK off, Studio’s playback stopped', st.kinematics.fk && !st.kinematics.ik && st.anime.speed === 0, JSON.stringify({ fk: st.kinematics.fk, ik: st.kinematics.ik, speed: st.anime.speed }));
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    got = await sample(0, 4);
    const walkOff = worstIn(ref, got, (x) => x < 1.99);
    t.metric('walk part: worst bone off', walkOff.toFixed(4), 'units');
    check('the walk follows the clip (within 2% of body height)', walkOff < 0.02 * h(), `${walkOff.toFixed(4)} at ${where}`);
    const runOff = worstIn(ref, got, (x) => x > 2.45);
    t.metric('run part: worst bone off', runOff.toFixed(4), 'units');
    check('after the blend the run follows its clip', runOff < 0.02 * h(), `${runOff.toFixed(4)} at ${where}`);
    // the blend: no jump — no frame moves much further than the motion around it does
    const steps = (lo, hi) => {
      let m = 0;
      for (const k of ['cf_j_foot_L', 'cf_j_foot_R', 'cf_j_hand_L', 'cf_j_head'])
        for (let i = 1; i < got.times.length; i++) if (got.times[i] > lo && got.times[i] <= hi) m = Math.max(m, dist(got.bones[k][i], got.bones[k][i - 1]));
      return m;
    };
    const inBlend = steps(1.95, 2.45), around = Math.max(steps(1, 1.95), steps(2.45, 3.5));
    t.metric('largest step in the blend / around it', `${inBlend.toFixed(4)} / ${around.toFixed(4)}`, 'units');
    check('the blend is smooth (no step bigger than the running around it)', inBlend <= around * 1.25 + 0.005, `${inBlend.toFixed(4)} vs ${around.toFixed(4)}`);
  });

  await t.step('undo / redo: the sequence and its keys together', async () => {
    await ok('undo');
    await sleep(400);
    const s1 = await ok('motion.seq.get', { id });
    const tl = await ok('timeline.get');
    check('undo: no sequence, no Motion folder', s1 == null && !(tl.groups ?? []).some((g) => g.name.startsWith('Motion: ')), JSON.stringify(s1));
    await ok('redo');
    await sleep(400);
    const s2 = await ok('motion.seq.get', { id });
    const tl2 = await ok('timeline.get');
    const f2 = (tl2.groups ?? []).find((g) => g.name.startsWith('Motion: '));
    check('redo: both back', s2?.blocks?.length === 2 && !!f2 && tl2.tracks.filter((x) => x.group === f2.id).length === built.tracks, JSON.stringify({ blocks: s2?.blocks?.length, folder: !!f2, inFolder: f2 ? tl2.tracks.filter((x) => x.group === f2.id).length : 0, groups: (tl2.groups ?? []).map((g) => g.name), tracks: tl2.tracks.length }));
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const again = await sample(0, 4);
    check('…and the same motion', worstIn(got, again, () => true) < 1e-3, `${worstIn(got, again, () => true).toFixed(5)} at ${where}`);
  });

  await t.step('an edit rebuilds: the run twice as fast', async () => {
    const fast = { ...seq, blocks: seq.blocks.map((b) => (b.id === 'r' ? { ...b, speed: 2 } : b)) };
    await build(fast, 'Change speed');
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const s = await sample(0, 4);
    check('the walk is unchanged', worstIn(got, s, (x) => x < 1.99) < 0.005, `${worstIn(got, s, (x) => x < 1.99).toFixed(5)} at ${where}`);
    check('the run changed', worstIn(got, s, (x) => x > 2.5) > 0.05, worstIn(got, s, (x) => x > 2.5).toFixed(4));
    await ok('undo');
    await sleep(300);
  });

  await t.step('a pose at the end: held, blended into, the timeline grows', async () => {
    const poses = await ok('pose.list');
    const pose = poses.find((p) => /\.dat$/i.test(p.path)) ?? poses[0];
    if (!pose) return t.metric('pose block', 'skipped: the pose library is empty', '');
    const withPose = { blocks: [...seq.blocks, { id: 'p', kind: 'pose', start: 4, len: 1.5, blend: 0.5, ease: 'smooth', pose: { path: pose.path, name: pose.name } }] };
    const r = await build(withPose, 'Add pose');
    check('built to 5.5 s', Math.abs(r.end - 5.5) < 1e-3, String(r.end));
    check('the timeline grew to fit', (await ok('timeline.get')).duration >= 5.5 - 1e-3);
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const s = await sample(4.6, 5.5, 10);
    const still = Math.max(...BONES.map((b) => Math.max(...s.bones[b].map((p) => dist(p, s.bones[b][0])))));
    check('after the blend the pose holds still', still < 0.002, still.toFixed(4));
    await ok('undo');
    await sleep(300);
  });

  await t.step('a saved Motion clip as a block: plays back the motion it was saved from', async () => {
    const tl = await ok('timeline.get');
    const folder = (tl.groups ?? []).find((g) => g.name.startsWith('Motion: '));
    const tracks = tl.tracks.filter((x) => x.group === folder?.id && (x.model === 'guideObjectRot' || x.model === 'guideObjectPos')).map((x) => x.id);
    const name = 'kf-test-walk';
    await ok('clips.save', { name, tracks, t0: 0, t1: 2 });
    t.defer(() => req('clips.delete', { file: name }));
    const r = await build({ blocks: [{ id: 'm', kind: 'mclip', start: 0, len: 2, blend: 0, ease: 'smooth', speed: 1, offset: 0, mclip: { file: name, name } }] }, 'Motion clip');
    check('its length reported', Math.abs((r.lengths?.m ?? 0) - 2) < 0.02, JSON.stringify(r.lengths));
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const s = await sample(0, 2);
    const w = worstIn(got, s, (x) => x < 1.99);
    t.metric('motion clip vs the walk it came from: worst bone off', w.toFixed(4), 'units');
    check('the motion clip plays the walk back (within 2% of body height)', w < 0.02 * h(), `${w.toFixed(4)} at ${where}`);
    await ok('undo');
    await sleep(300);
  });

  await t.step('a mirrored block: left and right swapped across her middle', async () => {
    await build({ blocks: [{ ...seq.blocks[0], mirror: true }] }, 'Mirror');
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const m = await sample(0, 2);
    // her middle: the plane through her root with her right-hand axis as its normal (Unity's Euler: Z, then X, then Y)
    const o = await ok('object.get', { id });
    const [rx, ry, rz] = o.transform.rot.map((d) => (d * Math.PI) / 180);
    const rotate = (v) => {
      let [x, y, z] = v;
      [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
      [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
      [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
      return [x, y, z];
    };
    const n = rotate([1, 0, 0]);
    const P = (await ok('motion.seq.get', { id })).anchor; // where the motion stands (her position now is moved by it)
    const reflect = (p) => {
      const d = (p[0] - P[0]) * n[0] + (p[1] - P[1]) * n[1] + (p[2] - P[2]) * n[2];
      return [p[0] - 2 * d * n[0], p[1] - 2 * d * n[1], p[2] - 2 * d * n[2]];
    };
    let w = 0, at = '';
    const pairs = [['cf_j_foot_L', 'cf_j_foot_R'], ['cf_j_foot_R', 'cf_j_foot_L'], ['cf_j_hand_L', 'cf_j_hand_R'], ['cf_j_hand_R', 'cf_j_hand_L'], ['cf_j_head', 'cf_j_head'], ['cf_j_hips', 'cf_j_hips']];
    for (const [a, b] of pairs)
      for (let i = 0; i < m.times.length; i++) {
        if (m.times[i] > 1.99) continue;
        const d = dist(m.bones[a][i], reflect(got.bones[b][i]));
        if (d > w) (w = d), (at = `${a} @${m.times[i]}s`);
      }
    t.metric('mirrored walk vs the walk reflected: worst bone off', w.toFixed(4), 'units');
    check('mirrored: each side lands where the other side was, reflected (within 3% of body height)', w < 0.03 * h(), `${w.toFixed(4)} at ${at}`);
    await ok('undo');
    await sleep(300);
  });

  await t.step('hand edits to the built keys survive a rebuild (and can be cleared)', async () => {
    // the built walk + run again, then a key on the left upper arm turned by 35° near 1 s
    await build(seq, 'Walk then run');
    const tl = await ok('timeline.get');
    const arm = tl.tracks.find((x) => x.model === 'guideObjectRot' && /cf_j_arm00_L/.test(x.name));
    if (!arm) throw new Error('no upper-arm track in the Motion folder: ' + tl.tracks.filter((x) => x.model === 'guideObjectRot').slice(0, 3).map((x) => x.name).join(', '));
    const kv = Object.values(await ok('timeline.keyValues', { tracks: [arm.id] }))[0];
    const key = kv.reduce((best, k) => (Math.abs(k[0] - 1) < Math.abs(best[0] - 1) ? k : best));
    const q = [key[1].valueX, key[1].valueY, key[1].valueZ, key[1].valueW];
    const h2 = (35 / 2) * (Math.PI / 180);
    const r = [Math.sin(h2), 0, 0, Math.cos(h2)]; // q * r: turned about the bone's own x
    const m = [q[3] * r[0] + q[0] * r[3] + q[1] * r[2] - q[2] * r[1], q[3] * r[1] - q[0] * r[2] + q[1] * r[3] + q[2] * r[0], q[3] * r[2] + q[0] * r[1] - q[1] * r[0] + q[2] * r[3], q[3] * r[3] - q[0] * r[0] - q[1] * r[1] - q[2] * r[2]];
    await ok('timeline.setKeyValue', { track: arm.id, t: key[0], value: { valueX: m[0], valueY: m[1], valueZ: m[2], valueW: m[3] } });
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const edited = await sample(0, 4);
    const moved = worstIn(got, edited, (x) => x < 1.99); // the walk part, around the edited key
    check('the edit moves the hand', moved > 0.015, moved.toFixed(4));

    // something else changes: the run twice as fast → rebuilt, the edit kept with the walk block
    const fast = { ...seq, blocks: seq.blocks.map((b) => (b.id === 'r' ? { ...b, speed: 2 } : b)) };
    const res = await build(fast, 'Change speed');
    const kept = (await ok('motion.seq.get', { id })).blocks.find((b) => b.id === 'w');
    check('the edit is kept with its block', res.tweaked >= 1 && !!kept?.tweaks?.cf_j_arm00_L, JSON.stringify({ tweaked: res.tweaked, bones: Object.keys(kept?.tweaks ?? {}) }));
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const after = await sample(0, 4);
    const still = worstIn(edited, after, (x) => x < 1.99);
    t.metric('walk with the edit, after a rebuild: worst bone off', still.toFixed(4), 'units');
    check('after the rebuild the walk still has the edit', still < 0.015, `${still.toFixed(4)} at ${where}`);
    check('…and the run did change', worstIn(edited, after, (x) => x > 2.5) > 0.05);

    // the page's copy can be a build behind (sent before the kept edit reached it): the edit stays anyway
    const stale = { ...seq, blocks: seq.blocks.map((b) => (b.id === 'r' ? { ...b, speed: 1.5 } : b)) }; // no tweaks in it
    await build(stale, 'Change speed (from an older copy)');
    check('an edit sent from an older copy keeps the hand edit', !!(await ok('motion.seq.get', { id })).blocks.find((b) => b.id === 'w')?.tweaks?.cf_j_arm00_L);
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const after2 = await sample(0, 4);
    check('…and the walk still shows it', worstIn(edited, after2, (x) => x < 1.99) < 0.015, `${worstIn(edited, after2, (x) => x < 1.99).toFixed(4)} at ${where}`);

    // cleared (the page asks once): back to the plain walk
    const cleared = { ...fast, blocks: (await ok('motion.seq.get', { id })).blocks.map((b) => (b.id === 'w' ? { ...b, tweaks: undefined, clearTweaks: true } : b)) };
    await build(cleared, 'Clear key edits');
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const plain = await sample(0, 4);
    check('cleared: the walk is as built', worstIn(got, plain, (x) => x < 1.99) < 0.005, `${worstIn(got, plain, (x) => x < 1.99).toFixed(4)} at ${where}`);
    check('…and stays cleared', !(await ok('motion.seq.get', { id })).blocks.find((b) => b.id === 'w')?.tweaks);
  });

  await t.step('a Motion clip saved again is used as it is now, not taken for a key edit', async () => {
    await build(seq, 'Walk then run');
    const tl = await ok('timeline.get');
    const folder = (tl.groups ?? []).find((g) => g.name.startsWith('Motion: '));
    const tracks = tl.tracks.filter((x) => x.group === folder?.id && (x.model === 'guideObjectRot' || x.model === 'guideObjectPos')).map((x) => x.id);
    const name = 'kf-test-resave';
    await ok('clips.save', { name, tracks, t0: 0, t1: 2 });
    t.defer(() => req('clips.delete', { file: name }));
    const block = { id: 'm', kind: 'mclip', start: 0, len: 2, blend: 0, ease: 'smooth', speed: 1, offset: 0, mclip: { file: name, name } };
    await build({ blocks: [block] }, 'Motion clip');
    // saved again, different: the same walk from 0.6 s on (its keys are this build's)
    await sleep(1100); // a new file date
    const tl2 = await ok('timeline.get');
    const f2 = (tl2.groups ?? []).find((g) => g.name.startsWith('Motion: '));
    await ok('clips.save', { name, tracks: tl2.tracks.filter((x) => x.group === f2?.id && (x.model === 'guideObjectRot' || x.model === 'guideObjectPos')).map((x) => x.id), t0: 0.6, t1: 2 });
    // an unrelated edit (the block a frame longer): rebuilt from the clip as it is now
    const r = await build({ blocks: [{ ...block, len: 2 + 1 / 30 }] }, 'Longer');
    const b = (await ok('motion.seq.get', { id })).blocks[0];
    check('no key edits made up from the clip saved again', r.tweaked === 0 && !b.tweaks, JSON.stringify({ tweaked: r.tweaked, bones: Object.keys(b.tweaks ?? {}) }));
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const s = await sample(0, 2);
    // the walk 0.6 s on: got at t + 0.6 (0.6 s is on the 15 fps sample grid)
    const off = Math.round(0.6 * 15);
    // relative to the hips: the clip's travel starts from where it starts, the walk's 0.6 s further on
    const rel = (a) => ({ times: a.times, bones: Object.fromEntries(Object.entries(a.bones).map(([k, v]) => [k, v.map((p, i) => [p[0] - a.bones.cf_j_hips[i][0], p[1] - a.bones.cf_j_hips[i][1], p[2] - a.bones.cf_j_hips[i][2]])])) });
    const ahead = rel({ times: got.times.slice(0, got.times.length - off), bones: Object.fromEntries(Object.entries(got.bones).map(([k, v]) => [k, v.slice(off)])) });
    const w = worstIn(ahead, rel(s), (x) => x < 1.39);
    check('the block plays the clip as saved again', w < 0.02 * h(), `${w.toFixed(4)} at ${where}`);
  });

  await t.step('feet planted: a foot on the ground stays put, the rest of the body as it was', async () => {
    const walkOnly = (feet) => ({ blocks: [{ id: 'w', kind: 'clip', start: 0, len: 2, blend: 0, ease: 'smooth', speed: 1, offset: 0, clip: walk, feet }] });
    const footSlide = (sm) => {
      // the most an ankle slides across the floor while it's down (low: near its lowest). (The foot itself turns
      // about the ankle as it lands flat and as the heel lifts, as in a real step.)
      let worst = 0, at = '';
      for (const f of ['cf_j_leg03_L', 'cf_j_leg03_R']) {
        const ps = sm.bones[f];
        const low = Math.min(...ps.map((p) => p[1]));
        let s0 = -1;
        for (let i = 0; i <= ps.length; i++) {
          const down = i < ps.length && ps[i][1] < low + 0.012;
          if (down && s0 < 0) s0 = i;
          if (!down && s0 >= 0) {
            for (let j = s0; j < i; j++) {
              const d = Math.hypot(ps[j][0] - ps[s0][0], ps[j][2] - ps[s0][2]);
              if (d > worst) (worst = d), (at = `${f} ${sm.times[s0]}–${sm.times[i - 1]}s`);
            }
            s0 = -1;
          }
        }
      }
      return { worst, at };
    };
    await build(walkOnly(false), 'Walk');
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const FEET = [...BONES, 'cf_j_leg03_L', 'cf_j_leg03_R'];
    const off = await sample(0, 2, 30, FEET);
    const r = await build(walkOnly(true), 'Plant feet');
    check('built with feet planted', !r.error && (await ok('motion.seq.get', { id })).blocks[0].feet === true);
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const on = await sample(0, 2, 30, FEET);
    const a = footSlide(off), b = footSlide(on);
    t.metric('foot slide while down: off / planted', `${a.worst.toFixed(4)} / ${b.worst.toFixed(4)}`, 'units');
    check('planted feet slide less', b.worst < a.worst * 0.5 || b.worst < 0.004, `off ${a.worst.toFixed(4)} (${a.at}), planted ${b.worst.toFixed(4)} (${b.at})`);
    check('…and hardly at all (under 4 mm)', b.worst < 0.004, `${b.worst.toFixed(4)} at ${b.at}`);
    // Studio's walk is on the spot: with the feet held, the body walks forward instead
    const travel = (sm) => Math.hypot(sm.bones.cf_j_hips.at(-1)[0] - sm.bones.cf_j_hips[0][0], sm.bones.cf_j_hips.at(-1)[2] - sm.bones.cf_j_hips[0][2]);
    t.metric('distance walked in 2 s: off / planted', `${travel(off).toFixed(3)} / ${travel(on).toFixed(3)}`, 'units');
    check('the walk on the spot now travels', travel(on) > 0.5 && travel(off) < 0.1, `${travel(off).toFixed(3)} → ${travel(on).toFixed(3)}`);
    // above the hips the pose is as it was (only the legs bend, and the whole body moves)
    let upper = 0;
    for (const k of ['cf_j_head', 'cf_j_hand_L', 'cf_j_hand_R'])
      for (let i = 0; i < on.times.length; i++) {
        const ro = on.bones[k][i].map((v, j) => v - on.bones.cf_j_hips[i][j]), rf = off.bones[k][i].map((v, j) => v - off.bones.cf_j_hips[i][j]);
        upper = Math.max(upper, dist(ro, rf));
      }
    check('the upper body moves with the hips, pose unchanged', upper < 0.002, upper.toFixed(4));

    // a run (both feet off the ground at times): it keeps going through the air instead of stalling there
    await build({ blocks: [{ id: 'r', kind: 'clip', start: 0, len: 2, blend: 0, ease: 'smooth', speed: 1, offset: 0, clip: run, feet: true }] }, 'Run, feet planted');
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    const rs = await sample(0.3, 1.9, 30, FEET);
    const hp = rs.bones.cf_j_hips;
    const speeds = hp.slice(1).map((p, i) => Math.hypot(p[0] - hp[i][0], p[2] - hp[i][2]) * 30);
    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    t.metric('run, feet planted: speed slowest / mean / fastest', `${Math.min(...speeds).toFixed(2)} / ${mean.toFixed(2)} / ${Math.max(...speeds).toFixed(2)}`, 'units/s');
    check('the run travels steadily (no stall in the air, no surge)', mean > 0.5 && Math.min(...speeds) > 0.4 * mean && Math.max(...speeds) < 2 * mean, speeds.map((v) => v.toFixed(2)).join(' '));
  });

  await t.step('Clear while a build is still reading poses: nothing comes back', async () => {
    const all = await ok('pose.list');
    const usedBefore = (all.find((p) => /\.dat$/i.test(p.path)) ?? all[0])?.path; // the pose step's
    const poses = all.filter((p) => /\.(dat|png)$/i.test(p.path) && p.path !== usedBefore);
    if (!poses.length) return t.metric('clear during a build', 'skipped: no second pose in the library', '');
    await build(seq, 'Walk then run');
    // a pose not read before, so the build waits a frame for it
    const pose = poses[poses.length - 1];
    const done = studio.waitFor('motion.build', (d) => d.done && d.id === id, 120000);
    // sent together, so the clear lands while the build waits for the pose
    const setting = req('motion.seq.set', { id, seq: { blocks: [...seq.blocks, { id: 'p2', kind: 'pose', start: 4, len: 1, blend: 0.4, ease: 'smooth', pose: { path: pose.path, name: pose.name } }] }, label: 'Add pose' });
    const clearing = req('motion.seq.clear', { id });
    check('both accepted', (await setting).ok && (await clearing).ok);
    const r = await done;
    await sleep(400);
    const tl = await ok('timeline.get');
    const left = await ok('motion.seq.get', { id });
    // (requests wait while a pose loads, so the clear usually comes after the build; either way nothing may be left)
    if (!r.cancelled) t.metric('clear during a build', 'requests waited for the pose: cleared after the build', '');
    check('the build was stopped, or finished first and was cleared', r.cancelled === true || !r.error, JSON.stringify(r));
    check('cleared: no sequence and no Motion folder afterwards', left == null && !(tl.groups ?? []).some((g) => g.name.startsWith('Motion: ')), JSON.stringify({ left: !!left, groups: (tl.groups ?? []).map((g) => g.name) }));
  });
}

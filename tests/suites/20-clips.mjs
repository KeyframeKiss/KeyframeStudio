import fs from 'node:fs';
import path from 'node:path';

export const name = 'Motion clips: save, apply, retarget, replace/add/blend, speed and loops, undo';

const quatY = (deg) => {
  const r = (deg * Math.PI) / 360;
  return { valueX: 0, valueY: Math.sin(r), valueZ: 0, valueW: Math.cos(r) };
};
/** rotation angle (degrees) of a quaternion */
const angle = (v) => (2 * Math.acos(Math.min(1, Math.abs(Number(v.valueW)))) * 180) / Math.PI;

export default async function (t) {
  t.needs('timeline');
  const { ok, req, check, near, sleep } = t;
  const { chara } = await t.loadSample();
  const dir = path.join(t.paths.userData, 'StudioEX', 'clips');
  t.defer(async () => {
    for (const c of (await ok('clips.list')).filter((c) => c.name.startsWith('StudioEX Test'))) await ok('clips.delete', { file: c.file });
  });
  await ok('timeline.setSettings', { duration: 12 });

  const tracks = async () => (await ok('timeline.get')).tracks;
  const keysOf = async (id) => (await tracks()).find((x) => x.id === id)?.keys.map((k) => k[0]) ?? [];
  const value = async (track, at) => (await ok('timeline.keyInfo', { track, t: at })).value;

  // source animation on the character: body turn (rotation) and mouth, 1 s → 2 s
  const rot = await ok('timeline.addTrack', { owner: 'Timeline', model: 'guideObjectRot', oci: chara.id, keyAt: 0 });
  const mouth = await ok('timeline.addTrack', { owner: 'Timeline', model: 'characterMouthOpen', oci: chara.id, keyAt: 0 });
  await ok('timeline.writeKeys', { track: mouth, keys: [{ t: 0, value: { value: 0 } }, { t: 1, value: { value: 0 } }, { t: 1.5, value: { value: 1 } }, { t: 2, value: { value: 0 } }] });
  await ok('timeline.writeKeys', { track: rot, keys: [{ t: 0, value: quatY(0) }, { t: 1, value: quatY(0) }, { t: 2, value: quatY(90) }] });

  let clip;
  await t.step('save', async () => {
    const list = await ok('clips.save', { name: 'StudioEX Test Wave', tracks: [rot, mouth], t0: 1, t1: 2 });
    clip = list.find((c) => c.name === 'StudioEX Test Wave');
    check('saved with length, tracks and thumbnail', clip && near(clip.length, 1) && clip.tracks === 2 && clip.keys === 5 && !!clip.thumb, JSON.stringify(clip && { ...clip, thumb: !!clip.thumb }));
    const xml = fs.readFileSync(path.join(dir, `${clip.file}.xml`), 'utf8');
    check("tracks stored with Timeline's own owner/id", /<track [^>]*owner="Timeline"[^>]*id="guideObjectRot"/.test(xml) || /<track [^>]*id="guideObjectRot"[^>]*owner="Timeline"/.test(xml));
    const item = (await ok('scene.get')).nodes.find((n) => n.type === 'Item');
    if (item) {
      const itemTrack = await ok('timeline.addTrack', { owner: 'Timeline', model: 'guideObjectPos', oci: item.id, keyAt: 0 });
      await ok('timeline.addKeys', { tracks: [itemTrack], t: 1 });
      check('two objects in one clip refused', !(await req('clips.save', { name: 'StudioEX Test Bad', tracks: [rot, itemTrack], t0: 0, t1: 1 })).ok);
    }
  });

  await t.step('apply (replace) and undo', async () => {
    const r = await ok('clips.apply', { file: clip.file, oci: chara.id, t: 5 });
    check('both tracks written', r.tracks === 2 && r.created === 0 && r.skipped.length === 0, JSON.stringify(r));
    const mk = await keysOf(mouth);
    check('mouth keys re-timed to 5–6 s', [5, 5.5, 6].every((x) => mk.some((k) => near(k, x))), mk.join(','));
    check('values carried over', near(Number((await value(mouth, 5.5)).value), 1, 0.01) && near(angle(await value(rot, 6)), 90, 1));
    await ok('undo');
    const after = await keysOf(mouth);
    check('undo removes them', !after.some((k) => k > 4), after.join(','));
  });

  await t.step('strength, add on top, blend', async () => {
    await ok('clips.apply', { file: clip.file, oci: chara.id, t: 5, strength: 0.5 });
    check('half strength mixes with what was there (0 → 1 becomes 0.5)', near(Number((await value(mouth, 5.5)).value), 0.5, 0.02));
    await ok('undo');
    // after 2 s the body is turned 90°; adding the clip's turn on top makes 180°
    await ok('clips.apply', { file: clip.file, oci: chara.id, t: 5, mode: 'add' });
    check('add on top: 90° + 90° turn', near(angle(await value(rot, 6)), 180, 2), String(angle(await value(rot, 6))));
    await ok('undo');
    await ok('clips.apply', { file: clip.file, oci: chara.id, t: 5, blend: 0.25 });
    const v5 = Number((await value(mouth, 5)).value);
    check('blend starts from what was there', near(v5, 0, 0.01));
    await ok('undo');
  });

  await t.step('speed and loops', async () => {
    const r = await ok('clips.apply', { file: clip.file, oci: chara.id, t: 3, speed: 2, loops: 3 });
    const mk = (await keysOf(mouth)).filter((k) => k >= 3 - 1e-3 && k <= 4.5 + 1e-3);
    check('3 loops at 2× fill 3–4.5 s', near(r.end, 4.5) && mk.length === 7, `${r.end} ${mk.join(',')}`);
    await ok('undo');
    const past = await ok('clips.apply', { file: clip.file, oci: chara.id, t: 11.5 });
    check('cut at the end of the timeline', past.trimmed === true && near(past.end, 12));
    await ok('undo');
  });

  await t.step('retarget onto another character', async () => {
    const cards = (await ok('cards.list')).filter((c) => c.sex === 1);
    if (!cards.length) return check('another character (skipped: no female cards)', true);
    const other = await ok('cards.add', { path: cards[0].path });
    await sleep(1500);
    const before = (await tracks()).length;
    const r = await ok('clips.apply', { file: clip.file, oci: other, t: 0 });
    const mine = (await tracks()).filter((x) => x.oci === other);
    check('new tracks on the other character', r.created === 2 && mine.length === 2 && (await tracks()).length === before + 2, JSON.stringify(r));
    await ok('undo');
    check('undo removes the created tracks', (await tracks()).filter((x) => x.oci === other).length === 0);
    const item = (await ok('scene.get')).nodes.find((n) => n.type === 'Item');
    if (item) check("a character's clip refuses an item", !(await req('clips.apply', { file: clip.file, oci: item.id, t: 0 })).ok);
    await ok('undo'); // the added character
  });

  await t.step('delete', async () => {
    const left = await ok('clips.delete', { file: clip.file });
    check('deleted with its thumbnail', !left.some((c) => c.file === clip.file) && !fs.existsSync(path.join(dir, `${clip.file}.jpg`)));
  });
}

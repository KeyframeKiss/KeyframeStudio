export const name = 'Face Studio: parts, saved faces, shapes, expressions, picking';

export default async function (t) {
  t.needs('faceParts');
  const { ok, req, check, near, sleep } = t;
  const { chara } = await t.loadSample();
  const id = chara.id;
  const B = ['cf_J_Eye_tx_L', 'cf_J_Eye_tx_R', 'cf_J_Nose_tip', 'cf_J_MouthLow'];
  const get = async () => Object.fromEntries((await ok('face.get', { id, bones: B })).bones.map((b) => [b.name, b]));
  t.defer(async () => {
    await req('face.reset', { id, bones: B, mirror: false });
    for (const kind of ['face', 'expr']) {
      const list = (await req(`${kind}.presets`)).result ?? [];
      const mine = list.filter((p) => p.name.startsWith('ZZ Test')).map((p) => p.file);
      if (mine.length) await req(`${kind}.deletePreset`, { files: mine });
    }
  });

  await t.step('face parts', async () => {
    const g = await ok('face.get', { id, bones: ['cf_J_Eye_tx_L', 'cf_J_Eye_tx_R', 'cf_J_Nose_tip', 'cf_J_NoSuchBone'] });
    check('face.get returns existing bones only', g.bones.length === 3);
    for (const a of [0, 35, 90]) {
      const url = await ok('face.view', { id, angle: a, zoom: 1, size: 256 });
      check(`close-up renders at ${a}°`, typeof url === 'string' && url.startsWith('data:image/jpeg'));
    }
    await ok('face.set', { id, bone: 'cf_J_Eye_tx_L', scale: [1.3, 1.3, 1.3], mirror: true });
    await sleep(300);
    let f = await get();
    check('mirror: both eyes scaled', [f.cf_J_Eye_tx_L, f.cf_J_Eye_tx_R].every((b) => near(b.scale[0], 1.3, 0.01) && b.edited));
    await ok('face.set', { id, bone: 'cf_J_Nose_tip', pos: [0, 0.01, 0] });
    check('position offset stored', near((await get()).cf_J_Nose_tip.pos[1], 0.01, 1e-4));
    await ok('undo');
    await sleep(200);
    check('undo nose', !(await get()).cf_J_Nose_tip.edited);
    await ok('undo');
    await sleep(200);
    f = await get();
    check('undo eyes (both sides)', [f.cf_J_Eye_tx_L, f.cf_J_Eye_tx_R].every((b) => near(b.scale[0], 1, 0.01) && !b.edited));
    await ok('redo');
    await sleep(200);
    check('redo eyes', near((await get()).cf_J_Eye_tx_L.scale[0], 1.3, 0.01));
    await ok('face.reset', { id, bones: ['cf_J_Eye_tx_L'], mirror: true });
    f = await get();
    check('reset both eyes', [f.cf_J_Eye_tx_L, f.cf_J_Eye_tx_R].every((b) => !b.edited));
  });

  await t.step('saved faces', async () => {
    await ok('face.set', { id, bone: 'cf_J_Eye_tx_L', scale: [1.3, 1.3, 1.3], mirror: true });
    await ok('face.set', { id, bone: 'cf_J_Nose_tip', pos: [0, 0.01, 0] });
    const saved = (await ok('face.savePreset', { id, name: 'ZZ Test Face', bones: B })).find((p) => p.name === 'ZZ Test Face');
    check('saved with thumbnail and 3 edited parts', saved?.thumb?.startsWith('data:image/jpeg') && saved.bones.length === 3);
    await ok('face.reset', { id, bones: B, mirror: false });
    await ok('face.set', { id, bone: 'cf_J_MouthLow', scale: [0.8, 0.8, 0.8] });
    await ok('face.applyPreset', { ids: [id], file: saved.file, bones: B, strength: 1, clear: true });
    await sleep(200);
    let f = await get();
    check('apply: eyes and nose', near(f.cf_J_Eye_tx_R.scale[0], 1.3, 0.002) && near(f.cf_J_Nose_tip.pos[1], 0.01, 1e-4));
    check('apply (replace): mouth reset', !f.cf_J_MouthLow.edited);
    await ok('undo');
    await sleep(200);
    f = await get();
    check('undo apply', near(f.cf_J_MouthLow.scale[0], 0.8, 0.002) && !f.cf_J_Eye_tx_L.edited);
    await ok('face.applyPreset', { ids: [id], file: saved.file, bones: B, strength: 0.5, clear: false });
    await sleep(200);
    f = await get();
    check('strength 50%, blend keeps mouth', near(f.cf_J_Eye_tx_L.scale[0], 1.15, 0.002) && near(f.cf_J_MouthLow.scale[0], 0.8, 0.002));
    await ok('face.reset', { id, bones: B, mirror: false });
    await ok('face.applyPreset', { ids: [id], file: saved.file, bones: ['cf_J_Eye_tx_L', 'cf_J_Eye_tx_R'], strength: 1, clear: true });
    check('partial apply (eyes only)', !(await get()).cf_J_Nose_tip.edited);
    const l = await ok('face.updatePreset', { file: saved.file, favorite: true, tags: ['soft', 'test'] });
    const u = l.find((p) => p.name === 'ZZ Test Face');
    check('favorite + tags', u.favorite && u.tags.join() === 'soft,test');
    check('apply records lastUsed', u.lastUsed > 0);
    const r = await ok('face.updatePreset', { file: u.file, name: 'ZZ Test Face renamed' });
    check('rename', r.some((p) => p.name === 'ZZ Test Face renamed' && p.thumb));
    await ok('face.reset', { id, bones: B, mirror: false });
  });

  if (t.has('faceShapes'))
    await t.step('shapes', async () => {
      await ok('chara.set', { ids: [id], blink: false });
      const sets = await ok('face.shapes', { id });
      const face = sets.find((s) => /face/i.test(s.name)) ?? sets[0];
      check('blendshape sets', sets.length > 0 && face.shapes.length > 0);
      const target = face.shapes.find((s) => /kuti|mouth/i.test(s.name) && s.weight < 10) ?? face.shapes[1];
      const shape = async () => (await ok('face.shapes', { id })).find((s) => s.key === face.key).shapes.find((s) => s.i === target.i);
      await ok('face.setShape', { id, key: face.key, i: target.i, weight: 90 });
      await sleep(400);
      let s = await shape();
      check('shape set', s.edited && Math.round(s.weight) === 90);
      const before = await ok('face.view', { id, size: 128, plain: true, original: true });
      check('before/after render', typeof before === 'string');
      await ok('undo');
      await sleep(400);
      check('undo shape', !(await shape()).edited);
      await ok('redo');
      await sleep(300);
      check('redo shape', (await shape()).edited);
      await ok('face.resetShapes', { id });
      await sleep(300);
      s = await shape();
      check('reset all shapes', !s.edited);
      await ok('chara.set', { ids: [id], blink: true });
    });

  await t.step('expressions', async () => {
    const before = (await ok('chara.get', { id })).face;
    await ok('chara.set', { ids: [id], mouthPtn: 3, eyebrowPtn: 2, blush: 0.6 });
    const vals = (await ok('chara.get', { id })).face;
    const keys = ['eyebrowPtn', 'eyesPtn', 'mouthPtn', 'eyesOpen', 'mouthOpen', 'blink', 'lipSync', 'eyesLook', 'neckLook', 'tears', 'blush'];
    const values = Object.fromEntries(keys.map((k) => [k, vals[k]]));
    const e = (await ok('expr.savePreset', { id, name: 'ZZ Test Smile', values })).find((p) => p.name === 'ZZ Test Smile');
    check('expression saved with thumbnail', e?.thumb && e.values.mouthPtn === 3);
    await ok('chara.set', { ids: [id], mouthPtn: 0, eyebrowPtn: 0, blush: 0 });
    await ok('chara.set', { ids: [id], ...e.values });
    const now = (await ok('chara.get', { id })).face;
    check('expression applied', now.mouthPtn === 3 && now.eyebrowPtn === 2 && near(now.blush, 0.6, 0.01));
    await ok('expr.updatePreset', { file: e.file, favorite: true, tags: ['smile'] });
    const e2 = (await ok('expr.presets')).find((p) => p.file === e.file);
    check('expression favorite/tags', e2.favorite && e2.tags[0] === 'smile');
    check('expression deleted', !(await ok('expr.deletePreset', { files: [e.file] })).some((p) => p.file === e.file));
    await ok('chara.set', { ids: [id], eyebrowPtn: before.eyebrowPtn, mouthPtn: before.mouthPtn, blush: before.blush });
  });

  await t.step('hover picking and markers', async () => {
    await ok('face.view', { id, size: 320, plain: true, angle: 0, zoom: 1 });
    await sleep(300);
    const a = await ok('face.anchors', { id, bones: ['cf_J_Eye_tx_L', 'cf_J_Eye_tx_R', 'cf_J_Nose_tip'] });
    check('anchors for 3 parts', a.length === 3 && a.every((p) => p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1));
    const L = a.find((p) => p.bone === 'cf_J_Eye_tx_L'),
      R = a.find((p) => p.bone === 'cf_J_Eye_tx_R');
    check('eyes mirrored around the centre', near(L.x + R.x, 1, 0.03) && near(L.y, R.y, 0.02));
    const nose = a.find((p) => p.bone === 'cf_J_Nose_tip');
    const pick = await ok('face.pick', { id, x: nose.x, y: nose.y, bones: ['cf_J_Nose_tip', 'cf_J_NoseBase', 'cf_J_Eye_tx_L', 'cf_J_Eye_tx_R', 'cf_J_MouthLow'] });
    check('pick at the nose marker finds the nose', /Nose/.test(pick?.bone ?? ''), JSON.stringify(pick));
  });
}

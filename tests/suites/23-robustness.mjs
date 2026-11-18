import fs from 'node:fs';
import path from 'node:path';

export const name = 'Robustness: undo next to outside changes, everything survives save + load';

export default async function (t) {
  t.needs('timeline');
  const { ok, check, near, sleep } = t;
  const { chara } = await t.loadSample();

  await t.step('character undo keeps changes made elsewhere', async () => {
    const c0 = await ok('chara.get', { id: chara.id });
    await ok('chara.set', { ids: [chara.id], blush: 0.8 });
    // as if picked in Studio's own window or by another plugin: not in Keyframe Studio's history
    const other = (c0.face.mouthPtn + 3) % c0.face.mouthCount;
    await ok('chara.set', { ids: [chara.id], mouthPtn: other, noUndo: true });
    await ok('undo');
    const c1 = await ok('chara.get', { id: chara.id });
    check('blush undone', near(c1.face.blush, c0.face.blush, 0.01));
    check('the outside mouth change stays', c1.face.mouthPtn === other, `${c1.face.mouthPtn} vs ${other}`);
    await ok('chara.set', { ids: [chara.id], mouthPtn: c0.face.mouthPtn, noUndo: true });
  });

  await t.step('look undo keeps changes made elsewhere', async () => {
    const l0 = await ok('look.get');
    await ok('look.set', { effects: { bloomIntensity: l0.effects.bloomIntensity + 0.9 } });
    await ok('look.set', { effects: { vignette: !l0.effects.vignette }, noUndo: true });
    await ok('undo');
    const l1 = await ok('look.get');
    check('bloom undone', near(l1.effects.bloomIntensity, l0.effects.bloomIntensity, 0.01));
    check('the outside vignette change stays', l1.effects.vignette === !l0.effects.vignette);
    await ok('look.set', { effects: { vignette: l0.effects.vignette }, noUndo: true });
  });

  await t.step('everything Keyframe Studio adds survives save + load', async () => {
    const sceneDir = path.join(t.paths.userData, 'studio', 'scene');
    const before = new Set(fs.readdirSync(sceneDir));
    // animation with a folder and a renamed track, shots, a face adjustment
    const tr = await ok('timeline.addTrack', { owner: 'Timeline', model: 'characterMouthOpen', oci: chara.id, keyAt: 0 });
    await ok('timeline.writeKeys', { track: tr, keys: [{ t: 1, value: { value: 0.6 } }, { t: 2, value: { value: 0 } }] });
    await ok('timeline.setTrack', { track: tr, alias: 'StudioEX test mouth' });
    const folder = await ok('timeline.groupCreate', { tracks: [tr], name: 'StudioEX test folder' });
    await ok('shots.set', { shots: [{ id: 'rt', name: 'StudioEX test shot', start: 0, end: 2 }] });
    // a KKPE face adjustment (saved by KKPE in the scene)
    const nose = async (id) => (await ok('face.get', { id, bones: ['cf_J_Nose_tip'] })).bones[0];
    const nose0 = await nose(chara.id);
    await ok('face.set', { id: chara.id, bone: 'cf_J_Nose_tip', pos: [0, 0.012, 0] });

    await ok('scene.save');
    let file;
    for (let i = 0; i < 20 && !file; i++) {
      await sleep(500);
      file = fs.readdirSync(sceneDir).find((f) => !before.has(f) && f.endsWith('.png'));
    }
    check('saved a new scene file', !!file);
    if (!file) return;
    t.defer(async () => fs.rmSync(path.join(sceneDir, file), { force: true }));

    await ok('scene.new');
    await sleep(1500);
    await ok('scene.load', { path: path.join(sceneDir, file) });
    let tl;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      tl = await ok('timeline.get').catch(() => null);
      if (tl?.tracks?.some((x) => x.alias === 'StudioEX test mouth')) break;
    }
    const back = tl?.tracks?.find((x) => x.alias === 'StudioEX test mouth');
    check('track, its name and keys', back && back.keys.length === 3 && near(back.keys[1][0], 1), JSON.stringify(back?.keys));
    check('folder', !!tl?.groups?.some((g) => g.name === 'StudioEX test folder'), JSON.stringify(tl?.groups?.map((g) => g.name)));
    check('shots', (await ok('shots.get')).some((s) => s.name === 'StudioEX test shot'));
    const loaded = (await ok('scene.get')).nodes.find((n) => n.type === 'Char');
    const n1 = loaded && (await nose(loaded.id));
    check('face adjustment (KKPE)', n1 && JSON.stringify(n1) !== JSON.stringify(nose0), JSON.stringify({ before: nose0, after: n1 }));
    void folder;
  });
}

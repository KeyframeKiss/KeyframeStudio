import fs from 'node:fs';
import path from 'node:path';

export const name = 'Lighting: projectors (shapes, modes, undo, saved), aimed lights (ours and LightManager)';

export default async function (t) {
  const { ok, req, check, sleep } = t;
  if (!t.hello.commands.includes('proj.list')) t.skip('bridge without projectors');
  const { chara } = await t.loadSample();
  const snap = () => ok('camera.snapshot', { width: 320 });

  let id;
  await t.step('projectors', async () => {
    const before = await snap();
    id = await ok('proj.add', { values: { shape: 'circle', mode: 'light', color: [1, 0.3, 0.2, 1], angle: 60 } });
    let list = (await ok('proj.list')).items;
    const p = list.find((x) => x.id === id);
    check('added as a folder in the scene', !!p && p.visible && p.name === 'Projector · Circle');
    check('it is in the scene list', (await ok('scene.get')).nodes.some((n) => n.id === id && n.type === 'Folder'));
    // an obvious one: a big black paint circle over the view must change the picture a lot
    await ok('proj.set', { id, values: { mode: 'paint', color: [0, 0, 0, 1], angle: 110, soft: 0, falloff: 0 } });
    await sleep(400);
    const dark = await snap();
    check('it really reaches the picture', Math.abs(dark.length - before.length) > before.length * 0.1, `${before.length} → ${dark.length}`);
    await ok('proj.set', { id, values: { mode: 'light', color: [1, 0.3, 0.2, 1], angle: 60, soft: 0.3, falloff: 0.4 } });
    const v = await ok('proj.set', { id, values: { shape: 'heart', mode: 'shadow', count: 7 } });
    check('values set', v.shape === 'heart' && v.mode === 'shadow' && v.count === 7);
    list = (await ok('proj.list')).items;
    check('its automatic name follows', list.find((x) => x.id === id).name === 'Projector · Heart shadow');
    for (const shape of ['ring', 'star', 'blinds', 'window', 'leaves']) await ok('proj.set', { id, values: { shape } });
    check('every shape accepted', true);
    check('unknown shapes refused', !(await req('proj.set', { id, values: { shape: 'nope' } })).ok);
    await ok('undo');
    // quick changes to the same value merge into one step (like a slider drag): back to before the run of shapes
    check('undo a change', (await ok('proj.list')).items.find((x) => x.id === id).values.shape === 'heart');
  });

  await t.step('undo / redo adding', async () => {
    const n = (await ok('proj.list')).items.length;
    const id2 = await ok('proj.add', { values: { shape: 'star' } });
    await ok('undo');
    check('undo removes it', (await ok('proj.list')).items.length === n && !(await ok('scene.get')).nodes.some((x) => x.id === id2));
    await ok('redo');
    const l = (await ok('proj.list')).items;
    check('redo brings it back', l.length === n + 1 && l.some((x) => x.values.shape === 'star'));
  });

  let light;
  await t.step('aim lights (ours)', async () => {
    const st = await ok('aim.list');
    light = st.lights.find((l) => l.type === 'Spot') ?? st.lights[0];
    if (!light) return check('a spot or directional light in the sample', false);
    let s = await ok('aim.set', { useLightManager: false, id: light.id, target: chara.id, bone: 'head', speed: 30 });
    let l = s.lights.find((x) => x.id === light.id);
    check('aimed by Keyframe Studio', l.target === chara.id && l.bone === 'head' && l.provider === 'Keyframe Studio');
    await sleep(800);
    l = (await ok('aim.list')).lights.find((x) => x.id === light.id);
    check('points at the head', l.offAngle >= 0 && l.offAngle < 3, String(l.offAngle));
    const o = await ok('object.get', { id: chara.id });
    await ok('object.set', { ids: [chara.id], pos: [o.transform.pos[0] + 1, null, null] });
    await sleep(800);
    l = (await ok('aim.list')).lights.find((x) => x.id === light.id);
    check('follows when the character moves', l.offAngle < 3, String(l.offAngle));
    await ok('undo'); // move
    s = await ok('aim.set', { id: light.id, target: -1 });
    check('stop aiming', s.lights.find((x) => x.id === light.id).target === -1);
    await ok('undo');
    check('undo puts the aim back', (await ok('aim.list')).lights.find((x) => x.id === light.id).target === chara.id);
  });

  if (light && (await ok('aim.list')).lightManager && light.type === 'Spot')
    await t.step('aim lights (LightManager)', async () => {
      const s = await ok('aim.set', { useLightManager: true, id: light.id, target: chara.id, bone: 'body' });
      const l = s.lights.find((x) => x.id === light.id);
      check('LightManager does body aiming when installed', l.provider === 'LightManager' && l.target === chara.id, JSON.stringify(l));
      await ok('aim.set', { id: light.id, bone: 'head' });
      check('other parts use ours', (await ok('aim.list')).lights.find((x) => x.id === light.id).provider === 'Keyframe Studio');
    });

  await t.step('saved with the scene', async () => {
    const sceneDir = path.join(t.paths.userData, 'studio', 'scene');
    const before = new Set(fs.readdirSync(sceneDir));
    await ok('scene.save');
    let file;
    for (let i = 0; i < 20 && !file; i++) {
      await sleep(500);
      file = fs.readdirSync(sceneDir).find((f) => !before.has(f) && f.endsWith('.png'));
    }
    check('saved', !!file);
    if (!file) return;
    t.defer(async () => fs.rmSync(path.join(sceneDir, file), { force: true }));
    await ok('scene.new');
    await sleep(1500);
    check('new scene: none', (await ok('proj.list')).items.length === 0);
    await ok('scene.load', { path: path.join(sceneDir, file) });
    let list = [];
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      list = (await ok('proj.list')).items;
      if (list.length >= 2) break;
    }
    check('projectors back, with their values', list.length === 2 && list.some((x) => x.values.shape === 'heart' && x.values.mode === 'shadow' && x.values.count === 7), JSON.stringify(list.map((x) => x.values.shape)));
    const aimed = (await ok('aim.list')).lights.filter((l) => l.target >= 0);
    check('aimed light back', aimed.length === 1 && aimed[0].bone === 'head', JSON.stringify(aimed));
  });
}

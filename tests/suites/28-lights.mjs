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

  if (t.hello.timeline)
    await t.step('projector tracks', async () => {
      const models = await ok('timeline.models', { oci: id });
      check('projector values are track types on its folder', ['proj.angle', 'proj.spin', 'proj.color'].every((m) => models.some((x) => x.owner === 'Keyframe Studio' && x.id === m)));
      check('not offered on other objects', !(await ok('timeline.models', { oci: chara.id })).some((x) => x.id === 'proj.angle'));
      await ok('timeline.setSettings', { duration: 10 });
      await ok('timeline.seek', { t: 0 });
      await ok('proj.set', { id, values: { angle: 20 } });
      const tr = await ok('timeline.addTrack', { owner: 'Keyframe Studio', model: 'proj.angle', oci: id, keyAt: 0 });
      await ok('proj.set', { id, values: { angle: 80 } });
      await ok('timeline.addKeys', { tracks: [tr], t: 2 });
      await ok('timeline.seek', { t: 1 });
      await sleep(400);
      const mid = (await ok('proj.list')).items.find((x) => x.id === id).values.angle;
      check('animates between keys', mid > 35 && mid < 65, String(mid));
      await ok('timeline.removeTracks', { tracks: [tr] });
      await ok('timeline.seek', { t: 0 });
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

  if (!t.hello.commands.includes('fx.charaLightDebug')) return;
  await t.step('scene lights on characters: ours (any shader), the shaders, Az Standard', async () => {
    const lights = await ok('light.charaList');
    if (!lights.length) t.skip('no scene lights');
    const ids = lights.map((l) => l.id);
    const mean = async () => ok('camera.mean', { width: 96 });
    const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
    const litChara = async () => (await ok('diag.lighting', {})).lights.filter((l) => /Spotlight|Pointlight/i.test(l.name)).map((l) => l.litChara);
    t.defer(async () => {
      await req('light.lightsChara', { ids, on: false });
      await req('fx.reset', { effect: 'charaLight' });
    });
    await ok('fx.set', { effect: 'charaLight', values: { on: false } });
    await ok('light.lightsChara', { ids, on: false });
    await sleep(300);
    const m0 = await mean();
    await ok('light.lightsChara', { ids, on: true });
    await sleep(500);
    check('switching lights on turns our character lights on', (await ok('fx.get')).effects.charaLight.on === true);
    check('drawn by us: the lights stay off the characters\' layer (no double light)', (await litChara()).every((x) => !x), JSON.stringify(await litChara()));
    const dbg = await ok('fx.charaLightDebug', { width: 96 });
    check('the characters are in our surface picture', dbg.ready && dbg.lights >= 1 && dbg.geoCover > 0.02 && dbg.albCover > 0.02, `lights ${dbg.lights}, cover ${dbg.geoCover?.toFixed(3)} / ${dbg.albCover?.toFixed(3)}`);
    const m1 = await mean();
    check('the character picks up the light', diff(m0, m1) > 0.01, diff(m0, m1).toFixed(4));
    await ok('fx.set', { effect: 'charaLight', values: { toon: true } });
    await sleep(300);
    check('toon edge changes the look', diff(m1, await mean()) > 0.001);
    await ok('fx.set', { effect: 'charaLight', values: { toon: false, strength: 0 } });
    await sleep(300);
    check('strength 0 = as without', diff(m0, await mean()) < 0.003);
    await ok('fx.set', { effect: 'charaLight', values: { strength: 1, on: false } });
    await sleep(300);
    check('drawn by the shaders: the lights reach the characters\' layer', (await litChara()).every((x) => x), JSON.stringify(await litChara()));

    if (!t.has('materials')) return;
    const shaders = async () => {
      const tree = await ok('me.tree', { id: chara.id });
      return tree.parts.flatMap((p) => p.renderers.flatMap((r) => r.materials.map((m) => m.shader)));
    };
    const r = await req('me.shaderSwap', { id: chara.id, to: 'az' });
    if (!r.ok) { check('Az Standard missing: a clear message', /Az Standard/.test(r.error ?? ''), r.error); return; }
    t.defer(async () => { await req('me.shaderSwap', { id: chara.id, to: 'original' }); });
    await sleep(600);
    const az = await shaders();
    check('Az Standard on skin, hair and clothes; helper parts kept', r.result.changed > 0 && az.includes('Az/StandardSkin') && az.some((x) => /^Az\/StandardHair/.test(x)) && az.includes('Custom/Silhouette'), JSON.stringify(r.result));
    await ok('undo');
    await sleep(600);
    check('one undo puts every original back', !(await shaders()).some((x) => x.startsWith('Az/')));
    await ok('redo');
    await sleep(600);
    const back = await ok('me.shaderSwap', { id: chara.id, to: 'original' });
    await sleep(600);
    check('"Back to original" removes only our Az edits', back.changed === r.result.changed && !(await shaders()).some((x) => x.startsWith('Az/')), JSON.stringify(back));
  });
}

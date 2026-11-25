export const name = 'Lighting rigs: apply, compare, undo, save';

export default async function (t) {
  const { ok, req, check, near } = t;
  const { chara } = await t.loadSample();
  const lightCount = async () => (await ok('scene.get')).nodes.filter((n) => n.type === 'Light').length;
  t.defer(async () => {
    const rigs = (await req('light.rigs')).result ?? [];
    for (const r of rigs.filter((x) => !x.builtin && x.name.startsWith('StudioEX Test'))) await req('light.deleteRig', { file: r.file });
  });

  const rigs = await ok('light.rigs');
  const three = rigs.find((r) => r.name === 'Three-point');
  check('built-in rigs listed', rigs.filter((r) => r.builtin).length >= 6 && three?.lights.length === 3);

  const before = await lightCount();
  const r = await ok('light.applyRig', { id: chara.id, rig: 'Three-point' });
  check('rig applied: 3 lights', r.lights === 3 && (await lightCount()) === before + 3, `${before} → ${await lightCount()}`);
  let scene = await ok('light.sceneRigs');
  check('listed in the scene, switched on', scene.length === 1 && scene[0].name === 'Three-point' && scene[0].lights === 3 && scene[0].enabled);

  await t.step('placement fits the character', async () => {
    const nodes = (await ok('scene.get')).nodes.filter((n) => n.type === 'Light');
    const pos = [];
    for (const n of nodes) pos.push((await ok('object.get', { id: n.id })).transform.pos);
    const c = (await ok('object.get', { id: chara.id })).transform.pos;
    const dists = pos.map((p) => Math.hypot(p[0] - c[0], p[2] - c[2]));
    check('rig lights sit around the character (not at the origin or far away)', dists.filter((d) => d > 0.3 && d < 50).length >= 3, dists.map((d) => d.toFixed(2)).join(', '));
  });

  scene = await ok('light.setRigEnabled', { folder: scene[0].folder, enabled: false });
  check('switched off', scene[0].enabled === false);
  scene = await ok('light.setRigEnabled', { folder: scene[0].folder, enabled: true });
  check('switched back on', scene[0].enabled === true);

  await ok('undo');
  check('undo removes the rig and its lights', (await ok('light.sceneRigs')).length === 0 && (await lightCount()) === before);
  await ok('redo');
  check('redo puts it back', (await ok('light.sceneRigs')).length === 1 && (await lightCount()) === before + 3);

  await t.step('save and reuse', async () => {
    const list = await ok('light.saveRig', { name: 'StudioEX Test Rig', id: chara.id });
    const mine = list.find((x) => x.name === 'StudioEX Test Rig');
    check('saved rig has every scene light', mine && mine.lights.length === before + 3, String(mine?.lights.length));
    const key = mine.lights.find((l) => l.type === 'spot');
    check('saved relative to the character (distance in heights)', key && key.dist > 0.5 && key.dist < 5, JSON.stringify(key));
    const rigsNow = await ok('light.sceneRigs');
    await ok('light.removeRig', { folder: rigsNow[0].folder });
    check('remove deletes the rig', (await ok('light.sceneRigs')).length === 0 && (await lightCount()) === before);
    const re = await ok('light.applyRig', { id: chara.id, rig: 'StudioEX Test Rig' });
    check('saved rig applies', re.lights === before + 3);
    const del = await ok('light.deleteRig', { file: mine.file });
    check('saved rig deleted', !del.some((x) => x.name === 'StudioEX Test Rig'));
  });

  if (t.hello.commands.includes('light.rigGet'))
    await t.step('lighting maker: drop lights in, place them, retype, save', async () => {
      const close = (a, b, e = 0.5) => Math.abs(a - b) <= e;
      const r = await ok('light.rigAdd', { id: chara.id, name: 'StudioEX Test Maker' });
      t.defer(async () => { await req('light.removeRig', { folder: r.folder }); });
      let g = await ok('light.rigGet', { id: chara.id, folder: r.folder });
      const key = g.lights[0];
      check('a new rig starts with a key light, named', g.name === 'StudioEX Test Maker' && g.lights.length === 1 && key.type === 'spot' && key.name === 'Key', JSON.stringify(key));
      check('read back where it was put (40°, 30° up, 1.6 heights)', close(key.az, 40) && close(key.el, 30) && close(key.dist, 1.6, 0.02), `${key.az} ${key.el} ${key.dist}`);
      await ok('light.rigPlace', { id: chara.id, light: key.id, spec: { az: -90, el: 10, dist: 1.2 }, drag: 'test-drag' });
      const p = await ok('light.rigPlace', { id: chara.id, light: key.id, spec: { az: -100 }, drag: 'test-drag' });
      check('placed', close(p.az, -100) && close(p.el, 10) && close(p.dist, 1.2, 0.02));
      await ok('undo');
      g = await ok('light.rigGet', { id: chara.id, folder: r.folder });
      check('one undo for the whole drag', close(g.lights[0].az, 40, 1), g.lights[0].az);
      await ok('light.rigPlace', { id: chara.id, light: key.id, spec: { aim: 'chest', el: -10, dist: 1 } });
      g = await ok('light.rigGet', { id: chara.id, folder: r.folder });
      check('aiming at the chest reads back', g.lights[0].aim === 'chest' && close(g.lights[0].el, -10));
      const fill = await ok('light.rigAdd', { id: chara.id, folder: r.folder, spec: { role: 'Fill', type: 'point', az: -50, el: 10, dist: 1.4, aim: 'head', color: [0.8, 0.9, 1], intensity: 0.7, range: 3, angle: 45, shadow: false } });
      const re = await ok('light.rigRetype', { id: chara.id, light: fill.light, type: 'spot' });
      g = await ok('light.rigGet', { id: chara.id, folder: r.folder });
      const f2 = g.lights.find((l) => l.id === re.light);
      check('retyped in place, settings kept', g.lights.length === 2 && f2?.type === 'spot' && f2.name === 'Fill' && close(f2.az, -50, 1) && close(f2.intensity, 0.7, 0.01), JSON.stringify(f2));
      const saved = await ok('light.saveRig', { name: 'StudioEX Test Maker rig', id: chara.id, folder: r.folder });
      const sr = saved.find((x) => x.name === 'StudioEX Test Maker rig');
      check('saved with names, kinds and aim', sr?.lights.length === 2 && sr.lights.some((l) => l.role === 'Fill') && sr.lights.some((l) => l.aim === 'chest'), JSON.stringify(sr?.lights.map((l) => [l.role, l.type, l.aim])));
      const third = await ok('light.rigAdd', { id: chara.id, folder: r.folder, spec: { role: 'Rim', type: 'spot', az: 160, el: 35, dist: 1.5 } });
      await ok('undo');
      g = await ok('light.rigGet', { id: chara.id, folder: r.folder });
      check('undo takes a dropped light away', g.lights.length === 2 && !g.lights.some((l) => l.id === third.light));
    });

  const bad = await req('light.applyRig', { id: chara.id, rig: 'No such rig' });
  check('unknown rig refused', !bad.ok);
  void near;
}

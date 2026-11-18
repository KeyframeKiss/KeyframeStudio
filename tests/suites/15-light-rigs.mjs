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

  const bad = await req('light.applyRig', { id: chara.id, rig: 'No such rig' });
  check('unknown rig refused', !bad.ok);
  void near;
}

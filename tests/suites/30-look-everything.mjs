export const name = 'Looks carry effects, projectors and xukmi FX items (one undo step)';

export default async function (t) {
  const { ok, req, check, near, sleep } = t;
  if (!t.hello.commands.includes('fx.get') || !t.hello.commands.includes('proj.add')) t.skip('bridge without effects / projectors');
  await t.loadSample();
  t.defer(() => req('fx.reset'));
  const xk = await ok('fx.xukmi');
  const xFog = xk.installed && t.has('materials') ? xk.catalog.find((c) => /two tone fog/i.test(c.name)) : null;
  const meTarget = async (id) => {
    const tree = await ok('me.tree', { id });
    const p = tree.parts[0];
    const r = p.renderers[0];
    return { id, part: p.key, renderer: r.name, material: r.materials[0].name };
  };

  // the scene's look: our fog, a projector, xukmi's fog with a changed value
  await ok('fx.set', { effect: 'fog', values: { on: true, density: 0.17 } });
  await ok('proj.add', { values: { shape: 'leaves', mode: 'shadow', count: 9 } });
  if (xFog) {
    const xId = await ok('fx.addXukmi', { group: xFog.group, category: xFog.category, no: xFog.no });
    await sleep(500);
    await ok('me.set', { ...(await meTarget(xId)), kind: 'float', prop: 'Density', value: 0.077 });
  }
  const saved = await ok('look.savePreset', { name: 'StudioEX Test Everything', groups: ['effects', 'fx', 'projectors', 'xukmi'] });
  const mine = saved.find((p) => p.name === 'StudioEX Test Everything');
  t.defer(() => req('look.deletePreset', { file: mine.file }));
  check('saved with the new parts', ['fx', 'projectors'].every((g) => mine.groups.includes(g)) && (!xFog || mine.groups.includes('xukmi')), mine.groups.join(','));

  // a clean copy of the scene, then apply
  await t.loadSample();
  check('fresh scene has none of it', !(await ok('fx.get')).effects.fog.on && (await ok('proj.list')).items.length === 0);
  await ok('look.applyPreset', { file: mine.file, groups: ['fx', 'projectors', 'xukmi'], strength: 1 });
  await sleep(500);
  const fog = (await ok('fx.get')).effects.fog;
  check('built-in fog back', fog.on && near(fog.density, 0.17));
  const projs = (await ok('proj.list')).items;
  check('projector back', projs.length === 1 && projs[0].values.shape === 'leaves' && projs[0].values.count === 9);
  if (xFog) {
    const items = (await ok('fx.xukmi')).items.filter((i) => i.effect === 'TwoToneFog');
    let dens = null;
    if (items.length) dens = (await ok('me.material', await meTarget(items[0].id))).floats.find((f) => f.name === 'Density')?.value;
    check('xukmi fog added, with its value', items.length === 1 && near(dens, 0.077), String(dens));
  }
  await ok('look.applyPreset', { file: mine.file, groups: ['projectors', 'xukmi'] });
  check('applying again does not duplicate', (await ok('proj.list')).items.length === 1 && (!xFog || (await ok('fx.xukmi')).items.length === 1));
  await ok('undo'); // the second apply
  await ok('undo'); // the first apply: one step for everything
  await sleep(500);
  check('one undo takes it all back', !(await ok('fx.get')).effects.fog.on && (await ok('proj.list')).items.length === 0 && (!xFog || (await ok('fx.xukmi')).items.length === 0));
  await ok('redo');
  await sleep(500);
  check('redo brings the fog and projector back', (await ok('fx.get')).effects.fog.on && (await ok('proj.list')).items.length === 1);
  if (xFog) {
    const items = (await ok('fx.xukmi')).items.filter((i) => i.effect === 'TwoToneFog');
    const dens = items.length ? (await ok('me.material', await meTarget(items[0].id))).floats.find((f) => f.name === 'Density')?.value : null;
    check('redo re-adds the xukmi fog with its value', items.length === 1 && near(dens, 0.077), String(dens));
  }
}

export const name = 'Core: scene, objects, rename, character';

export default async function (t) {
  const { ok, req, check, near, sleep } = t;

  check('hello lists core commands', ['scene.get', 'object.set', 'chara.get', 'undo', 'diag.info'].every((c) => t.hello.commands.includes(c)));

  const scenes = await ok('scene.list');
  check('scene.list', scenes.length > 0, `${scenes.length} scenes`);
  const { scene, chara, items, light } = await t.loadSample();
  check('sample scene loaded', scene.nodes.length > 0, `${scene.nodes.length} nodes`);
  check('character type normalized to Char', !!chara);
  const sel = await ok('scene.get');
  check('scene.select', sel.selected.includes(chara.id), JSON.stringify(sel.selected));

  await t.step('object transform + undo', async () => {
    const o = await ok('object.get', { id: chara.id });
    check('object.get transform', o.transform?.pos.length === 3);
    const r = await ok('object.set', { ids: [chara.id], pos: [null, 0.5, null] });
    check('per-axis set (Y only)', near(r.transform.pos[1], 0.5) && near(r.transform.pos[0], o.transform.pos[0]), JSON.stringify(r.transform.pos));
    await ok('undo');
    const back = await ok('object.get', { id: chara.id });
    check('transform undo', near(back.transform.pos[1], o.transform.pos[1]), JSON.stringify(back.transform.pos));
  });

  if (light)
    await t.step('light properties + undo', async () => {
      const l = await ok('object.get', { id: light.id });
      check('light props', typeof l.light?.intensity === 'number');
      const l2 = await ok('object.set', { ids: [light.id], light: { intensity: 0.33 } });
      check('light intensity set', near(l2.light.intensity, 0.33));
      await ok('undo');
      check('light undo', near((await ok('object.get', { id: light.id })).light.intensity, l.light.intensity));
    });

  if (items.length >= 2)
    await t.step('rename + undo', async () => {
      const it = items[0];
      await ok('scene.rename', { ids: [it.id], name: 'Renamed by Studio EX' });
      let s = await ok('scene.get');
      check('rename applied', s.nodes.find((n) => n.id === it.id).name === 'Renamed by Studio EX');
      await ok('undo');
      s = await ok('scene.get');
      check('rename undone', s.nodes.find((n) => n.id === it.id).name === it.name);
      const two = items.slice(0, 2).map((n) => n.id);
      await ok('scene.rename', { ids: two, name: 'Prop' });
      s = await ok('scene.get');
      check('multi rename numbered', two.map((id) => s.nodes.find((n) => n.id === id).name).join('|') === 'Prop 1|Prop 2');
      await ok('undo');
      const bad = await req('scene.rename', { ids: [chara.id], name: '   ' });
      check('empty name rejected', !bad.ok);
    });

  await t.step('character panel', async () => {
    const c = await ok('chara.get', { id: chara.id });
    check('chara.get', c.face && c.clothes.length === 9 && c.hands.length === 2);
    const before = c.face.blush;
    const c2 = await ok('chara.set', { ids: [chara.id], blush: 0.77, eyesPtn: 2, mouthPtn: 3, tears: 2, clothes: { slot: 0, state: 3 } });
    check('chara.set face/clothes', near(c2.face.blush, 0.77) && c2.face.eyesPtn === 2 && c2.face.mouthPtn === 3 && c2.clothes[0].state === 3);
    for (const v of [0.2, 0.4, 0.6]) await ok('chara.set', { ids: [chara.id], blush: v }); // one slider drag
    await ok('undo');
    check('slider drag undone in one step', near((await ok('chara.get', { id: chara.id })).face.blush, 0.77));
    if (c.accessories.length) {
      const a0 = c.accessories[0];
      const c3 = await ok('chara.set', { ids: [chara.id], accessory: { slot: a0.slot, visible: !a0.visible } });
      check('accessory toggle', c3.accessories.find((x) => x.slot === a0.slot).visible === !a0.visible);
    }
    const c4 = await ok('chara.set', { ids: [chara.id], fk: true });
    check('FK on', c4.kinematics.fk === true);
    await ok('chara.set', { ids: [chara.id], blush: before, clothes: { slot: 0, state: 0 }, fk: c.kinematics.fk });
  });

  await t.step('animation catalog', async () => {
    const cat = await ok('chara.animations');
    const clips = cat.reduce((n, g) => n + g.categories.reduce((m, c) => m + c.clips.length, 0), 0);
    check('animation catalog', clips > 50, `${clips} clips`);
    const g = cat[0],
      c = g.categories[0],
      clip = c.clips[Math.min(1, c.clips.length - 1)];
    await ok('chara.loadAnime', { ids: [chara.id], group: g.id, category: c.id, no: clip.no });
    await sleep(300);
    const st = await ok('chara.get', { id: chara.id });
    check('loadAnime applied', st.anime.group === g.id && st.anime.category === c.id && st.anime.no === clip.no);
  });
}

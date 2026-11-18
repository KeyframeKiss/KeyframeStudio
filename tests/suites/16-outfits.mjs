export const name = 'Outfits: saved outfits, one-step apply, peeks stay out of undo';

export default async function (t) {
  const { ok, req, check } = t;
  const { chara } = await t.loadSample();
  const id = chara.id;
  t.defer(async () => {
    const list = (await req('store.list', { kind: 'outfits' })).result ?? [];
    for (const o of list.filter((x) => x.name.startsWith('StudioEX Test'))) await req('store.delete', { kind: 'outfits', file: o.file });
  });

  const c0 = await ok('chara.get', { id });
  const states0 = [...c0.clothes].sort((a, b) => a.slot - b.slot).map((c) => c.state);
  const vis0 = c0.accessories.map((a) => a.visible);

  await t.step('preset store', async () => {
    let list = await ok('store.save', { kind: 'outfits', name: 'StudioEX Test Outfit', data: { coordinate: c0.coordinate, clothes: states0, shoesType: c0.shoesType, accessories: [], from: 'x' } });
    const mine = list.find((o) => o.name === 'StudioEX Test Outfit');
    check('saved and listed with its data', mine?.data.clothes.length === states0.length && mine.created > 0);
    list = await ok('store.update', { kind: 'outfits', file: mine.file, favorite: true, used: true });
    const u = list.find((o) => o.file === mine.file);
    check('favorite + last used', u.favorite === true && u.lastUsed > 0);
    list = await ok('store.save', { kind: 'outfits', name: 'StudioEX Test Outfit', data: { coordinate: 0, clothes: [], shoesType: 0, accessories: [], from: 'x' } });
    check('overwrite keeps the favorite', list.find((o) => o.file === mine.file).favorite === true);
    const bad = await req('store.list', { kind: 'secrets' });
    check('unknown kind refused', !bad.ok);
  });

  await t.step('apply an outfit in one undo step', async () => {
    const other = (c0.coordinate + 1) % c0.coordinates.length;
    await ok('chara.set', { ids: [id], coordinate: other, clothesStates: states0.map(() => 3), undoLabel: 'Apply outfit' });
    const c1 = await ok('chara.get', { id });
    check('outfit switched and clothes off', c1.coordinate === other && c1.clothes.every((c) => c.state === 3));
    const label = await ok('undo');
    const c2 = await ok('chara.get', { id });
    check('one undo puts back outfit and clothes', label === 'Apply outfit' && c2.coordinate === c0.coordinate && [...c2.clothes].sort((a, b) => a.slot - b.slot).map((c) => c.state).join() === states0.join(), `${label}`);
  });

  if (c0.accessories.length)
    await t.step('peeks stay out of undo', async () => {
      await ok('chara.set', { ids: [id], blush: 0.42 }); // a real edit
      await ok('chara.set', { ids: [id], accessoriesAll: false, noUndo: true }); // peek
      check('peek hid the accessories', (await ok('chara.get', { id })).accessories.every((a) => !a.visible));
      await ok('chara.set', { ids: [id], accessoriesVisible: vis0, noUndo: true }); // release
      check('release restores them', (await ok('chara.get', { id })).accessories.map((a) => a.visible).join() === vis0.join());
      const label = await ok('undo');
      check('undo skips the peek and reverts the real edit', label === 'Character change' && Math.abs((await ok('chara.get', { id })).face.blush - c0.face.blush) < 1e-3, label);
    });
}

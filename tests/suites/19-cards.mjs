export const name = 'Character card library: list, names, add (undoable), swap';

export default async function (t) {
  const { ok, req, check, sleep, studio } = t;
  await ok('scene.new');
  await sleep(1000);
  const cards = await ok('cards.list');
  const females = cards.filter((c) => c.sex === 1);
  if (females.length < 2) t.skip('needs at least two female cards in UserData/chara/female');
  check('cards listed with paths and folders', cards.every((c) => c.path && c.rel && typeof c.sex === 'number'));

  // names: either cached already or read in the background and pushed as an event
  let named = cards.filter((c) => typeof c.name === 'string').length;
  if (named < cards.length) {
    const before = studio.events.length;
    for (let i = 0; i < 60 && named < Math.min(cards.length, 5); i++) {
      await sleep(500);
      named += studio.events.slice(before).filter((e) => e.event === 'cards.names').reduce((n, e) => n + Object.keys(e.data).length, 0);
    }
  }
  check('names read (cached or in the background)', named >= Math.min(cards.length, 5), `${named}/${cards.length}`);

  const count = async () => (await ok('scene.get')).nodes.filter((n) => n.type === 'Char').length;
  const id = await ok('cards.add', { path: females[0].path });
  check('card added as a character', typeof id === 'number' && (await count()) === 1);
  await ok('undo');
  await sleep(500);
  check('undo removes it', (await count()) === 0);
  await ok('redo');
  await sleep(500);
  check('redo adds it again', (await count()) === 1);

  const ch = (await ok('scene.get')).nodes.find((n) => n.type === 'Char');
  const before = (await ok('scene.get')).nodes.find((n) => n.id === ch.id).name;
  check('swap to another card', (await ok('cards.swap', { id: ch.id, path: females[1].path })) === true);
  await sleep(1500);
  const after = (await ok('scene.get')).nodes.find((n) => n.id === ch.id);
  check('still the same object, now another character', !!after && (after.name !== before || females[0].name === females[1].name), `${before} → ${after?.name}`);
  const bad = await req('cards.add', { path: 'C:\Windows\win.ini' });
  check('only cards from UserData/chara', !bad.ok);
}

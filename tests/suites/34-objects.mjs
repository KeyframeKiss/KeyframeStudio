import fs from 'node:fs';
import path from 'node:path';

export const name = 'Objects library: every item, pictures made out of sight, add to the scene';

export default async function (t) {
  const { ok, check, sleep } = t;
  await t.loadSample();

  let cat;
  await t.step('catalog', async () => {
    const t0 = Date.now();
    cat = await ok('items.catalog');
    check('every item Studio can add, by group and category', cat.items.length > 100 && cat.items.every((i) => typeof i.key === 'string' && i.key.length === 32), String(cat.items.length));
    check('read quickly (no name lookups for the whole catalog)', Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
    const keys = new Set(cat.items.map((i) => i.key));
    check('a key per item', keys.size === cat.items.length);
  });

  await t.step('pictures, without touching the scene', async () => {
    const before = (await ok('scene.get')).nodes.length;
    // three from Studio's own furniture-like groups: the first items of the first group
    const pick = cat.items.filter((i) => i.g === cat.items[0].g).slice(0, 3);
    const files = pick.map((i) => path.join(cat.folder, i.key + '.jpg'));
    const kept = files.filter((f) => fs.existsSync(f));
    // make them fresh: remove only the pictures this test makes
    for (const i of pick) for (const ext of ['.jpg', '.none']) fs.rmSync(path.join(cat.folder, i.key + ext), { force: true });
    t.defer(() => kept.length === 0 && files.forEach((f) => fs.rmSync(f, { force: true })));
    const seen = new Map();
    const listener = (m) => m.event === 'items.thumb' && seen.set(m.data.key, m.data.ok);
    t.studio.listeners.add(listener);
    t.defer(() => t.studio.listeners.delete(listener));
    await ok('items.thumbs', { keys: pick.map((i) => i.key) });
    for (let k = 0; k < 120 && seen.size < pick.length; k++) await sleep(250);
    check('each one answered', pick.every((i) => seen.has(i.key)), JSON.stringify([...seen]));
    const made = pick.filter((i) => seen.get(i.key));
    check('pictures written for the ones with something to see', made.length > 0 && made.every((i) => fs.statSync(path.join(cat.folder, i.key + '.jpg')).size > 1000));
    check('the scene is untouched', (await ok('scene.get')).nodes.length === before);
    const again = await ok('items.catalog');
    check('the catalog knows they have pictures now', made.every((i) => again.items.find((x) => x.key === i.key)?.thumb === 1));
  });

  await t.step('names on screen', async () => {
    const some = cat.items.slice(0, 50).map((i) => i.key);
    const names = await ok('items.names', { keys: some });
    check('answers with a key → name map', typeof names === 'object' && !Array.isArray(names));
  });

  await t.step('add to the scene', async () => {
    const before = (await ok('scene.get')).nodes.length;
    const it = cat.items.find((i) => i.thumb === 1) ?? cat.items[0];
    const id = await ok('items.add', { group: it.g, category: it.c, no: it.n });
    let after = before;
    for (let k = 0; k < 20 && after === before; k++) {
      await sleep(250);
      after = (await ok('scene.get')).nodes.length;
    }
    check('added, and selected', typeof id === 'number' && after > before && (await ok('scene.get')).selected.includes(id), `${before} → ${after}, id ${id}`);
  });
}

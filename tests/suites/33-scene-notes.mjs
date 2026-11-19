import fs from 'node:fs';
import path from 'node:path';

export const name = 'Scene notes (per-character lip-sync setups) saved with the scene';

export default async function (t) {
  const { ok, req, check, sleep } = t;
  const { chara } = await t.loadSample();
  const setup = { voice: { file: 'voice.wav', offset: 1.5 }, range: 'between', from: 1, to: 3, style: 'singing', vowels: true, vowelMap: { a: 12, closed: 0 } };

  await t.step('set and read', async () => {
    await ok('notes.set', { key: 'lipsync', id: chara.id, value: setup });
    await ok('notes.set', { key: 'test.global', value: { n: 3 } });
    const n = await ok('notes.get', { key: 'lipsync' });
    check('per character', n.objects[String(chara.id)]?.style === 'singing' && n.objects[String(chara.id)].vowelMap.a === 12, JSON.stringify(n));
    check('scene-wide', (await ok('notes.get', { key: 'test.global' })).value?.n === 3);
    await ok('notes.set', { key: 'test.global', value: null });
    check('a null value removes it', (await ok('notes.get', { key: 'test.global' })).value == null);
    const bad = await req('notes.get', {});
    check('a key is needed', !bad.ok);
  });

  await t.step('saved with the scene, following the character', async () => {
    const sceneDir = path.join(t.paths.userData, 'studio', 'scene');
    const before = new Set(fs.readdirSync(sceneDir));
    await ok('scene.save');
    let added = [];
    for (let i = 0; i < 20 && !added.length; i++) {
      await sleep(500);
      added = fs.readdirSync(sceneDir).filter((f) => !before.has(f));
    }
    t.defer(() => added.forEach((f) => /^\d{4}_\d{4}_\d{4}_\d{2}_\d{3}\.png$/.test(f) && fs.existsSync(path.join(sceneDir, f)) && fs.unlinkSync(path.join(sceneDir, f))));
    check('scene saved', added.length === 1);
    await ok('scene.new');
    await sleep(1500);
    check('a new scene has no notes', Object.keys((await ok('notes.get', { key: 'lipsync' })).objects).length === 0);
    await ok('scene.load', { path: path.join(sceneDir, added[0]) });
    let n;
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      n = await ok('notes.get', { key: 'lipsync' });
      if (Object.keys(n.objects).length) break;
    }
    const ids = Object.keys(n.objects).map(Number);
    const tree = await ok('scene.get');
    const list = Array.isArray(tree.nodes) ? tree.nodes : Object.values(tree.nodes ?? tree);
    const owner = list.find((x) => x.id === ids[0]);
    check('loading brings the setup back, on the character as loaded', ids.length === 1 && owner?.type === 'Char' && n.objects[String(ids[0])].voice.file === 'voice.wav', `${JSON.stringify(n)} → ${owner?.type}`);
  });
}

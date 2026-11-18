import fs from 'node:fs';
import path from 'node:path';

export const name = 'Mod settings, translations, scene save';

export default async function (t) {
  const { ok, check, sleep } = t;

  await t.step('mod settings', async () => {
    const list = await ok('config.list');
    const entries = list.reduce((n, p) => n + p.entries.length, 0);
    check('config.list', list.length > 20 && entries > 100, `${list.length} plugins, ${entries} settings`);
    const port = list.find((p) => p.guid === 'studioex.bridge')?.entries.find((e) => e.key === 'Port');
    check('own setting visible', port?.kind === 'int');
    check('config.set round-trips', (await ok('config.set', { guid: 'studioex.bridge', section: 'Connection', key: 'Port', value: port.value })).value === port.value);
  });

  await t.loadSample();

  if (t.hello.translator)
    await t.step('translation overrides', async () => {
      const ovFile = path.join(t.paths.game, 'BepInEx', 'Translation', 'en', 'Text', 'zz_StudioEX_Overrides.txt');
      const existed = fs.existsSync(ovFile);
      const original = existed ? fs.readFileSync(ovFile) : null;
      t.defer(() => {
        if (original) fs.writeFileSync(ovFile, original);
        else if (fs.existsSync(ovFile)) fs.unlinkSync(ovFile);
      });
      const list = await ok('translation.list');
      check('translation.list', list.length > 0);
      const sample = list.find((e) => e.context === 'Scene object') ?? list[0];
      await ok('translation.set', { text: sample.text, value: 'StudioEX Test Name' });
      const e2 = (await ok('translation.list')).find((e) => e.text === sample.text);
      check('override applied', e2.override && e2.translation === 'StudioEX Test Name');
      check('override written to file', fs.readFileSync(ovFile, 'utf8').includes('StudioEX Test Name'));
      await ok('translation.set', { text: sample.text, value: '' });
      const e3 = (await ok('translation.list')).find((e) => e.text === sample.text);
      check('override removed', !e3.override && e3.translation !== 'StudioEX Test Name');
    });

  await t.step('scene save / new', async () => {
    const sceneDir = path.join(t.paths.userData, 'studio', 'scene');
    const before = new Set(fs.readdirSync(sceneDir));
    await ok('scene.save');
    await sleep(2500);
    const added = fs.readdirSync(sceneDir).filter((f) => !before.has(f));
    // only Studio's own timestamped save names, only files that appeared during this test
    for (const f of added) if (/^\d{4}_\d{4}_\d{4}_\d{2}_\d{3}\.png$/.test(f)) fs.unlinkSync(path.join(sceneDir, f));
    check('scene.save wrote one file', added.length === 1, added.join(','));
    await ok('scene.new');
    await sleep(1500);
    check('scene.new cleared the scene', (await ok('scene.get')).nodes.length === 0);
  });
}

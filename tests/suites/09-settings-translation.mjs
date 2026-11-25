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

  if (t.hello.commands.includes('scene.backups'))
    await t.step('Ctrl+S: save over the open scene, the old version kept as a backup', async () => {
      const sceneDir = path.join(t.paths.userData, 'studio', 'scene');
      const stamp = /^\d{4}_\d{4}_\d{4}_\d{2}_\d{3}\.png$/;
      const made = [];
      let backupDir = null;
      t.defer(() => {
        for (const f of made) if (stamp.test(path.basename(f)) && fs.existsSync(f)) fs.unlinkSync(f);
        if (backupDir && fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
      });
      // a scene of our own to save over: a new-file save of the sample (never the sample or anything of the user's)
      const before = new Set(fs.readdirSync(sceneDir));
      await ok('scene.save', { returnName: true });
      await sleep(1500);
      const added = fs.readdirSync(sceneDir).filter((f) => !before.has(f));
      added.forEach((f) => made.push(path.join(sceneDir, f)));
      check('a copy to work on', added.length === 1 && stamp.test(added[0]), added.join(','));
      if (added.length !== 1 || !stamp.test(added[0])) return;
      const own = path.join(sceneDir, added[0]);
      await ok('scene.load', { path: own });
      await sleep(2500);
      const size0 = fs.statSync(own).size;
      const names0 = (await ok('scene.get')).nodes.length;
      // change the scene a little (delete nothing of value: it's our copy) and save over it
      const r = await ok('scene.save', { returnName: true, overwrite: true });
      await sleep(1500);
      const after = fs.readdirSync(sceneDir).filter((f) => !before.has(f));
      after.forEach((f) => made.includes(path.join(sceneDir, f)) || made.push(path.join(sceneDir, f)));
      check('saved over the open file', r?.overwritten === true && r.file === path.basename(own), JSON.stringify(r));
      check('no new file in the scene folder', after.length === 1, after.join(','));
      const backups = await ok('scene.backups', { path: own });
      backupDir = backups[0] ? path.dirname(backups[0].path) : null;
      check('the old version is in backups', backups.length === 1 && fs.existsSync(backups[0].path) && backups[0].size === size0, JSON.stringify(backups));
      check('the scene still loads', (await ok('scene.get')).nodes.length === names0 && (await ok('scene.get')).fileName === path.basename(own));
      // a new scene has no file: Ctrl+S makes a new one
      await ok('scene.new');
      await sleep(1000);
      const b2 = new Set(fs.readdirSync(sceneDir));
      const r2 = await ok('scene.save', { returnName: true, overwrite: true });
      await sleep(1500);
      const added2 = fs.readdirSync(sceneDir).filter((f) => !b2.has(f));
      added2.forEach((f) => made.push(path.join(sceneDir, f)));
      check('a new scene gets a new file', r2?.overwritten === false && added2.length === 1, JSON.stringify(r2));
      await t.loadSample();
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

import fs from 'node:fs';
import path from 'node:path';

export const name = 'Character: ABMX, poses, pose library';

export default async function (t) {
  const { ok, req, check } = t;
  const { chara } = await t.loadSample();
  const poseDir = path.join(t.paths.userData, 'studio', 'pose');

  if (t.has('abmx')) await t.step('ABMX', async () => {
    const r = await ok('abmx.get', { id: chara.id, all: true });
    check('abmx.get', Array.isArray(r.modifiers) && r.bones.length > 50);
    const r2 = await ok('abmx.set', { id: chara.id, bone: 'cf_j_head', location: 1, scale: [1.2, 1.2, 1.2] });
    check('abmx.set scale', t.near(r2.modifiers.find((x) => x.bone === 'cf_j_head')?.scale[0], 1.2, 1e-4));
    await ok('undo');
    check('abmx undo', !(await ok('abmx.get', { id: chara.id })).modifiers.some((m) => m.bone === 'cf_j_head'));
    await ok('abmx.set', { id: chara.id, bone: 'cf_j_head', location: 1, scale: [1.2, 1.2, 1.2] });
    const r3 = await ok('abmx.set', { id: chara.id, bone: 'cf_j_head', location: 1, reset: true });
    check('abmx reset', !r3.modifiers.find((x) => x.bone === 'cf_j_head'));
  });

  await t.step('poses', async () => {
    const NAME = 'StudioEX test pose';
    const before = await ok('pose.list');
    await ok('chara.set', { ids: [chara.id], fk: true });
    const after = await ok('pose.save', { id: chara.id, name: NAME });
    const mine = after.find((p) => p.name === NAME);
    t.defer(() => {
      // only ever delete the file this test created
      if (mine && mine.path.toLowerCase().startsWith(poseDir.toLowerCase()) && /StudioEX test pose/.test(mine.path) && fs.existsSync(mine.path)) fs.unlinkSync(mine.path);
    });
    check('pose.save + list', after.length === before.length + 1 && !!mine);
    check('pose.load', (await ok('pose.load', { ids: [chara.id], path: mine.path })) === 1);
    check('pose.mirror', (await ok('pose.mirror', { ids: [chara.id] })) === 1);
    await ok('pose.mirror', { ids: [chara.id] });
    const copyErr = await req('pose.copy', { from: chara.id, ids: [chara.id] });
    check('pose.copy to self rejected', !copyErr.ok);
    await ok('pose.setMeta', { path: mine.path, favorite: true, tags: ['test tag'] });
    const m = (await ok('pose.list')).find((p) => p.path === mine.path);
    check('favorite + tags stored', m.favorite === true && m.tags?.[0] === 'test tag');
    check('load stamps lastUsed', m.lastUsed > 0);
    await ok('pose.setMeta', { path: mine.path, favorite: false, tags: [] });
  });
}

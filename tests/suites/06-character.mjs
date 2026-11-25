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

    // Character › Body: both sides of a part in one call (mirrored), one undo step; a drag merges; a region resets at once
    const L = 'cf_s_thigh01_L', R = 'cf_s_thigh01_R';
    const was = (await ok('abmx.get', { id: chara.id })).modifiers;
    const find = (list, b) => list.find((x) => x.bone === b);
    const both = (s, px) => ok('abmx.set', { id: chara.id, items: [{ bone: L, location: 1, scale: [s, 1, s], position: [px, 0, 0] }, { bone: R, location: 1, scale: [s, 1, s], position: [-px, 0, 0] }] });
    let r4 = await both(1.3, 0.01);
    check('both sides changed in one call', t.near(find(r4.modifiers, L)?.scale[0], 1.3, 1e-4) && t.near(find(r4.modifiers, R)?.scale[0], 1.3, 1e-4) && t.near(find(r4.modifiers, R)?.position[0], -0.01, 1e-5));
    await both(1.35, 0.012); // the same part again, as while dragging: merges
    r4 = await both(1.4, 0.014);
    await ok('undo');
    const back = (await ok('abmx.get', { id: chara.id })).modifiers;
    const same = (a, b) => (!a && !b) || (a && b && a.scale.every((v, i) => t.near(v, b.scale[i], 1e-4)));
    check('one undo puts both sides back, the whole drag at once', same(find(back, L), find(was, L)) && same(find(back, R), find(was, R)), JSON.stringify([find(back, L)?.scale, find(was, L)?.scale]));
    await both(1.3, 0.01);
    await ok('abmx.set', { id: chara.id, bone: 'cf_j_head', location: 1, scale: [1.1, 1.1, 1.1] });
    const r5 = await ok('abmx.set', { id: chara.id, items: [L, R, 'cf_j_head'].map((bone) => ({ bone, location: 1, reset: true })) });
    check('reset several parts at once', ![L, R, 'cf_j_head'].some((b) => find(r5.modifiers, b)));
    await ok('undo');
    const r6 = (await ok('abmx.get', { id: chara.id })).modifiers;
    check('one undo brings all of them back', [L, R, 'cf_j_head'].every((b) => find(r6, b)));
    await ok('undo');
    await ok('undo');
    const end = (await ok('abmx.get', { id: chara.id })).modifiers;
    check('and back to how the character came', same(find(end, L), find(was, L)) && !find(end, 'cf_j_head'), JSON.stringify(find(end, L)?.scale));
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

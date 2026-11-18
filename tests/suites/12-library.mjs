export const name = 'Library: favorites/tags, pose preview and undo, faces with shapes';

export default async function (t) {
  const { ok, req, check, sleep } = t;
  const { chara } = await t.loadSample();
  const id = chara.id;

  await t.step('favorites, tags, recent (scenes, animations, looks)', async () => {
    const KEY = 'StudioEX test item';
    for (const kind of ['scenes', 'animations', 'looks']) {
      t.defer(() => req('lib.setMeta', { kind, key: KEY, remove: true }));
      await ok('lib.setMeta', { kind, key: KEY, favorite: true, tags: ['a', 'b', 'a'] });
      const m = await ok('lib.setMeta', { kind, key: KEY, used: true });
      check(`${kind}: favorite, tags (deduplicated), last used`, m.favorite === true && m.tags.join() === 'a,b' && m.lastUsed > 0);
      check(`${kind}: listed`, !!(await ok('lib.meta', { kind }))[KEY]);
      // only lastUsed left after clearing the rest
      const left = await ok('lib.setMeta', { kind, key: KEY, favorite: false, tags: [] });
      check(`${kind}: clearing keeps only last used`, left && !left.favorite && !left.tags && left.lastUsed > 0);
    }
    const bad = await req('lib.meta', { kind: 'nope' });
    check('unknown library refused', !bad.ok);
  });

  const poses = (await ok('pose.list')).filter((p) => p.sex === -1 || p.sex === 1 || p.sex === 0);
  if (poses.length < 2) t.skip('needs at least two poses');
  const [p1, p2] = poses;

  await t.step('pose hover preview', async () => {
    await ok('chara.set', { ids: [id], fk: true });
    const own = await ok('pose.fingerprint', { id });
    check('preview applies', (await ok('pose.preview', { ids: [id], path: p1.path })) === 1);
    const shown = await ok('pose.fingerprint', { id });
    check('pose changes while previewing', shown !== own);
    await ok('pose.preview', { ids: [id], path: p2.path });
    await ok('pose.previewEnd');
    check('ending the preview restores the own pose', (await ok('pose.fingerprint', { id })) === own);
    await sleep(800);
    check('a preview is not an unkeyed change', (await ok('timeline.state')).pending === 0);
  });

  await t.step('pose load / mirror undo (after a preview)', async () => {
    const own = await ok('pose.fingerprint', { id });
    await ok('pose.preview', { ids: [id], path: p1.path });
    await ok('pose.load', { ids: [id], path: p1.path }); // click while previewing
    const loaded = await ok('pose.fingerprint', { id });
    check('click keeps the previewed pose', loaded !== own);
    await ok('undo');
    check('undo goes back to the pose before the preview', (await ok('pose.fingerprint', { id })) === own);
    await ok('redo');
    check('redo', (await ok('pose.fingerprint', { id })) === loaded);
    await ok('pose.mirror', { ids: [id] });
    await ok('undo');
    check('mirror undo', (await ok('pose.fingerprint', { id })) === loaded);
  });

  if (t.has('faceParts') && t.has('faceShapes'))
    await t.step('saved face carries shape edits', async () => {
      t.defer(async () => {
        await req('face.reset', { id, bones: ['cf_J_Nose_tip'], mirror: false });
        await req('face.resetShapes', { id });
        const list = (await req('face.presets')).result ?? [];
        const mine = list.filter((p) => p.name.startsWith('ZZ Test Shapes')).map((p) => p.file);
        if (mine.length) await req('face.deletePreset', { files: mine });
      });
      await ok('chara.set', { ids: [id], blink: false });
      const sets = await ok('face.shapes', { id });
      const face = sets.find((s) => /face/i.test(s.name)) ?? sets[0];
      const target = face.shapes.find((s) => s.weight < 10) ?? face.shapes[1];
      const weight = async () => (await ok('face.shapes', { id })).find((s) => s.key === face.key).shapes.find((s) => s.i === target.i);
      await ok('face.set', { id, bone: 'cf_J_Nose_tip', pos: [0, 0.01, 0] });
      await ok('face.setShape', { id, key: face.key, i: target.i, weight: 80 });
      await sleep(300);
      const saved = (await ok('face.savePreset', { id, name: 'ZZ Test Shapes', bones: ['cf_J_Nose_tip'] })).find((p) => p.name === 'ZZ Test Shapes');
      check('saved face lists its shape edits', saved?.shapes === 1, JSON.stringify(saved?.shapes));
      await ok('face.resetShapes', { id });
      await ok('face.reset', { id, bones: ['cf_J_Nose_tip'], mirror: false });
      await sleep(300);
      check('shape cleared before applying', !(await weight()).edited);
      await ok('face.applyPreset', { ids: [id], file: saved.file, bones: ['cf_J_Nose_tip'], shapes: true, strength: 1, clear: true });
      await sleep(300);
      const w = await weight();
      check('apply restores the shape', w.edited && Math.round(w.weight) === 80, JSON.stringify(w));
      await ok('undo');
      await sleep(300);
      check('one undo removes bones and shapes together', !(await weight()).edited && !(await ok('face.get', { id, bones: ['cf_J_Nose_tip'] })).bones[0].edited);
      await ok('face.applyPreset', { ids: [id], file: saved.file, bones: ['cf_J_Nose_tip'], shapes: false, strength: 1, clear: true });
      await sleep(300);
      check('shapes left alone when not chosen', !(await weight()).edited);
      await ok('chara.set', { ids: [id], blink: true });
    });
}

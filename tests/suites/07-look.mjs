import fs from 'node:fs';
import path from 'node:path';

export const name = 'Look: effects, presets, materials';

export default async function (t) {
  const { ok, check, near } = t;
  const { chara } = await t.loadSample();
  const looksDir = path.join(t.paths.userData, 'StudioEX', 'looks');
  t.defer(async () => {
    // remove any preset this suite saved (also if a check failed half-way)
    const list = await ok('look.presets');
    for (const p of list.filter((p) => p.name.startsWith('StudioEX Test'))) await ok('look.deletePreset', { file: p.file });
    });

  const base = await ok('look.get');
  check('look state', base.effects && base.toon && base.lights);
  check('LUT and ramp lists', base.luts.length > 1 && base.ramps.length > 1);

  await t.step('set + undo', async () => {
    for (const v of [1.0, 1.5, 2.2]) await ok('look.set', { effects: { bloomIntensity: v } });
    const r = await ok('look.set', { toon: { lineWidth: 0.9 }, lights: { charaColor: [1, 0.5, 0.5, 1], charaRot: [20, 45] } });
    check('values applied', near(r.effects.bloomIntensity, 2.2) && near(r.toon.lineWidth, 0.9) && near(r.lights.charaRot[1], 45));
    await ok('undo');
    await ok('undo');
    const u = await ok('look.get');
    check('undo restores (a slider drag is one step)', near(u.effects.bloomIntensity, base.effects.bloomIntensity) && near(u.toon.lineWidth, base.toon.lineWidth));
    if (base.twoLut && t.has('twoLut')) {
      const other = base.luts.find((l) => l.id !== base.effects.lut2) ?? base.luts[1];
      check('second LUT (TwoLut)', (await ok('look.set', { effects: { lut2: other.id } })).effects.lut2 === other.id);
      await ok('undo');
    }
  });

  await t.step('presets', async () => {
    const list = await ok('look.presets');
    check('starter presets', list.filter((p) => p.builtin).length >= 6);
    const before = await ok('look.get');
    const warm = list.find((p) => p.name === 'Cinematic Warm');
    const half = await ok('look.applyPreset', { file: warm.file, groups: ['effects', 'lights'], strength: 0.5 });
    check('partial apply at 50%', near(half.effects.bloomIntensity, (before.effects.bloomIntensity + 0.7) / 2, 0.01) && near(half.toon.lineColor, before.toon.lineColor));
    await ok('undo');
    check('preset undo', near((await ok('look.get')).effects.bloomIntensity, before.effects.bloomIntensity));
    const saved = await ok('look.savePreset', { name: 'StudioEX Test Look', groups: ['effects', 'toon'], materials: [] });
    const mine = saved.find((p) => p.name === 'StudioEX Test Look');
    check('save with thumbnail', mine?.thumb && mine.groups.join() === 'effects,toon');
    // look.thumb: a look without a picture (like the starters) gets one from the current view, settings untouched
    const json = path.join(looksDir, `${mine.file}.json`);
    const settings = fs.readFileSync(json, 'utf8');
    fs.rmSync(path.join(looksDir, `${mine.file}.jpg`), { force: true });
    check('thumbnail removed', !(await ok('look.presets')).find((p) => p.file === mine.file).thumb);
    const withThumb = (await ok('look.thumb', { file: mine.file })).find((p) => p.file === mine.file);
    check('look.thumb captures a thumbnail', !!withThumb.thumb && fs.existsSync(path.join(looksDir, `${mine.file}.jpg`)));
    check('look.thumb leaves the settings alone', fs.readFileSync(json, 'utf8') === settings);
    check('look.thumb refuses unknown looks', !(await t.req('look.thumb', { file: 'no such look' })).ok);
    check('delete', !(await ok('look.deletePreset', { file: mine.file })).some((p) => p.name === 'StudioEX Test Look'));
    await ok('look.resetDefault');
    const d = await ok('look.get');
    check('reset to Studio default', d.effects.bloom === true && near(d.effects.bloomIntensity, 0.4));
    await ok('undo');
  });

  if (t.has('materials'))
    await t.step('materials', async () => {
      const list = await ok('material.list', { ids: [chara.id] });
      check('material.list', list.length > 0);
      const sh = list.find((s) => s.props.some((p) => p.type === 'float'));
      const prop = sh.props.find((p) => p.type === 'float');
      const target = prop.value + 0.25;
      const valueOf = async () => (await ok('material.list', { ids: [chara.id] })).find((s) => s.shader === sh.shader).props.find((p) => p.name === prop.name).value;
      const n = await ok('material.set', { ids: [chara.id], shader: sh.shader, prop: prop.name, type: 'float', value: target });
      check('material.set via MaterialEditor', n > 0 && near(await valueOf(), target));
      await ok('undo');
      check('material undo', near(await valueOf(), prop.value));
      const saved = await ok('look.savePreset', { name: 'StudioEX Test Mat', groups: ['materials'], materials: [{ shader: sh.shader, prop: prop.name, type: 'float', value: target }] });
      const mine = saved.find((p) => p.name === 'StudioEX Test Mat');
      await ok('look.applyPreset', { file: mine.file, groups: ['materials'], strength: 1, ids: [chara.id] });
      check('preset material rule applied', near(await valueOf(), target));
      const reset = await ok('material.reset', { ids: [chara.id], shader: sh.shader, prop: prop.name, type: 'float' });
      check('material.reset removes the override', reset > 0 && near(await valueOf(), prop.value));
    });

}

import fs from 'node:fs';
import path from 'node:path';

export const name = 'Effects: built-in fog / grade / sharpen / lens, undo, scene save, Timeline tracks, xukmi FX';

export default async function (t) {
  const { ok, req, check, near, sleep } = t;
  if (!t.hello.commands.includes('fx.get')) t.skip('bridge without effects');
  await t.loadSample();
  t.defer(() => req('fx.reset'));
  const snap = async () => (await ok('camera.snapshot', { width: 320 })).length;

  await t.step('built in', async () => {
    const s = await ok('fx.get');
    check('shaders loaded', s.ready === true, s.error);
    check('all off to start', Object.values(s.effects).every((e) => e.on === false));
    const plain = await snap();
    let after = await ok('fx.set', { effect: 'grade', values: { on: true, exposure: -3.5 } });
    check('values set', after.effects.grade.on === true && near(after.effects.grade.exposure, -3.5));
    await sleep(300);
    const dark = await snap();
    check('the picture really changes (much darker → much smaller JPEG)', dark < plain * 0.7, `${plain} → ${dark}`);
    await ok('undo');
    after = await ok('fx.get');
    check('undo', after.effects.grade.on === false && near(after.effects.grade.exposure, 0));
    await sleep(300);
    check('and the picture is back', Math.abs((await snap()) - plain) < plain * 0.1);

    for (const [effect, values] of [
      ['fog', { on: true, density: 0.3, near: [1, 0.5, 0.2, 0.9], far: [0.1, 0.2, 0.8, 1] }],
      ['sharpen', { on: true, amount: 1 }],
      ['vignette', { on: true, intensity: 0.8 }],
      ['aberration', { on: true, amount: 1.5 }],
      ['grain', { on: true, amount: 0.6 }],
    ]) {
      await ok('fx.set', { effect, values });
      await sleep(200);
      check(`${effect} renders`, (await snap()) !== plain);
    }
    check('unknown values are refused', !(await req('fx.set', { effect: 'fog', values: { nope: 1 } })).ok);
    const r = await ok('fx.reset');
    check('reset all', Object.values(r.effects).every((e) => e.on === false));
  });

  await t.step('saved with the scene', async () => {
    await ok('fx.set', { effect: 'fog', values: { on: true, density: 0.123, far: [0.2, 0.3, 0.9, 0.5] } });
    const sceneDir = path.join(t.paths.userData, 'studio', 'scene');
    const before = new Set(fs.readdirSync(sceneDir));
    await ok('scene.save');
    let file;
    for (let i = 0; i < 20 && !file; i++) {
      await sleep(500);
      file = fs.readdirSync(sceneDir).find((f) => !before.has(f) && f.endsWith('.png'));
    }
    check('saved', !!file);
    if (!file) return;
    t.defer(async () => fs.rmSync(path.join(sceneDir, file), { force: true }));
    await ok('scene.new');
    await sleep(1500);
    check('a new scene starts without them', (await ok('fx.get')).effects.fog.on === false);
    await ok('scene.load', { path: path.join(sceneDir, file) });
    let fog;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      fog = (await ok('fx.get')).effects.fog;
      if (fog.on) break;
    }
    check('loaded back', fog.on === true && near(fog.density, 0.123) && near(fog.far[2], 0.9), JSON.stringify(fog));
    await ok('fx.reset');
  });

  if (t.hello.timeline)
    await t.step('Timeline tracks', async () => {
      const models = await ok('timeline.models', {});
      check('effect values are track types', models.some((m) => m.owner === 'Keyframe Studio' && m.id === 'fx.fog.density') && models.some((m) => m.id === 'fx.grade.filter'));
      // the scene loaded above has its own timeline length: make room for the keys
      await ok('timeline.setSettings', { duration: 10 });
      await ok('timeline.seek', { t: 0 });
      await ok('fx.set', { effect: 'fog', values: { on: true, density: 0.05 } });
      const tr = await ok('timeline.addTrack', { owner: 'Keyframe Studio', model: 'fx.fog.density', keyAt: 0 });
      t.defer(() => req('timeline.removeTracks', { tracks: [tr] }));
      await ok('fx.set', { effect: 'fog', values: { density: 0.25 } });
      await ok('timeline.addKeys', { tracks: [tr], t: 2 });
      await ok('timeline.seek', { t: 1 });
      await sleep(400);
      const mid = (await ok('fx.get')).effects.fog.density;
      check('animates between keys', mid > 0.08 && mid < 0.22, String(mid));
      await ok('timeline.seek', { t: 2 });
      await sleep(300);
      check('reaches the key', near((await ok('fx.get')).effects.fog.density, 0.25));
      await ok('timeline.removeTracks', { tracks: [tr] });
      await ok('fx.reset');
    });

  const xk = await ok('fx.xukmi');
  if (xk.installed)
    await t.step('xukmi FX (installed)', async () => {
      const fog = xk.catalog.find((c) => /two tone fog/i.test(c.name));
      check('its effects are listed', xk.catalog.length > 5 && !!fog);
      const id = await ok('fx.addXukmi', { group: fog.group, category: fog.category, no: fog.no });
      await sleep(500);
      let now = await ok('fx.xukmi');
      check('added to the scene, recognised as its fog', now.items.some((i) => i.id === id && i.effect === 'TwoToneFog' && i.visible));
      await ok('undo');
      await sleep(500);
      now = await ok('fx.xukmi');
      check('undo removes it', !now.items.some((i) => i.id === id));
    });
}

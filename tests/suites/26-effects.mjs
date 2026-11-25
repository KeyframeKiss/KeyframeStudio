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
      await ok('fx.reset');
      await sleep(250);
      const base = await snap();
      await ok('fx.set', { effect, values });
      await sleep(250);
      const withIt = await snap();
      check(`${effect} renders`, Math.abs(withIt - base) > base * 0.02, `${base} → ${withIt}`);
    }
    check('unknown values are refused', !(await req('fx.set', { effect: 'fog', values: { nope: 1 } })).ok);
    const r = await ok('fx.reset');
    check('reset all', Object.values(r.effects).every((e) => e.on === false));
  });

  // white balance in kelvin, LUT files, lens distortion and natural falloff (YuppiEffects-style, our own)
  if (t.hello.commands.includes('fx.luts') && t.hello.commands.includes('camera.mean'))
    await t.step('white balance (K), LUT files, distortion, lens falloff', async () => {
      const mean = () => ok('camera.mean', { width: 96 });
      await ok('fx.reset');
      await sleep(250);
      const m0 = await mean();
      await ok('fx.set', { effect: 'grade', values: { on: true, kelvin: 3200 } });
      await sleep(250);
      const cool = await mean();
      await ok('fx.set', { effect: 'grade', values: { kelvin: 10000 } });
      await sleep(250);
      const warm = await mean();
      check('3200 K cools the picture (bluer than red)', cool[2] - cool[0] > m0[2] - m0[0] + 0.02, JSON.stringify({ m0, cool }));
      check('10000 K warms it', warm[0] - warm[2] > m0[0] - m0[2] + 0.02, JSON.stringify({ m0, warm }));
      await ok('fx.reset');

      // a tiny LUT that inverts colours, made for the test and removed after
      const lut = await ok('fx.luts');
      const file = path.join(lut.folder, 'kf-test-invert.cube');
      const lines = ['TITLE "kf test invert"', 'LUT_3D_SIZE 2'];
      for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${1 - r} ${1 - g} ${1 - b}`);
      fs.writeFileSync(file, lines.join(String.fromCharCode(10)));
      t.defer(() => fs.existsSync(file) && fs.unlinkSync(file));
      const listed = (await ok('fx.luts')).files.find((f) => f.name === 'kf-test-invert.cube');
      check('a .cube in the LUT folder is listed with its size', listed?.size === 2 && !listed.error, JSON.stringify(listed));
      await sleep(250);
      const before = await mean();
      await ok('fx.set', { effect: 'lut', values: { on: true, a: 'kf-test-invert.cube', aAmount: 1, aMode: 0 } });
      await sleep(250);
      const inv = await mean();
      check('the LUT applies (colours inverted)', [0, 1, 2].every((i) => near(inv[i], 1 - before[i], 0.06)), JSON.stringify({ before, inv }));
      await ok('fx.set', { effect: 'lut', values: { aAmount: 0.5 } });
      await sleep(250);
      const half = await mean();
      check('half strength: halfway', [0, 1, 2].every((i) => near(half[i], 0.5, 0.06)), JSON.stringify(half));
      await ok('fx.set', { effect: 'lut', values: { aAmount: 1, aMode: 2 } });
      await sleep(250);
      const colourOnly = await mean();
      const L = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      check('colour only: the picture keeps its brightness', near(L(colourOnly), L(before), 0.05), `${L(before).toFixed(3)} → ${L(colourOnly).toFixed(3)}`);
      check('a missing LUT file is no harm', (await req('fx.set', { effect: 'lut', values: { a: 'nope.cube' } })).ok);
      const starters = (await ok('fx.luts')).files.filter((f) => f.name.startsWith('Keyframe Studio/'));
      check('the starter LUTs are there (made by Keyframe Studio)', starters.length >= 8 && starters.every((f) => f.size === 33 && !f.error), starters.map((f) => f.name).join(', '));
      await ok('fx.set', { effect: 'lut', values: { a: 'Keyframe Studio/Black and white.cube', aAmount: 1, aMode: 0 } });
      await sleep(250);
      const bw = await mean();
      check('…and work: Black and white takes the colour out', Math.max(...bw) - Math.min(...bw) < 0.02, JSON.stringify(bw));
      await ok('fx.reset');

      await sleep(250);
      const plain = await snap();
      await ok('fx.set', { effect: 'distortion', values: { on: true, amount: 0.4 } });
      await sleep(250);
      check('distortion renders', Math.abs((await snap()) - plain) > plain * 0.01);
      await ok('fx.reset');
      await ok('fx.set', { effect: 'vignette', values: { on: true, intensity: 0, natural: 1 } });
      await sleep(250);
      const fall = await mean();
      check('lens falloff darkens (with the shaped vignette at 0)', L(fall) < L(before) - 0.005, `${L(before).toFixed(3)} → ${L(fall).toFixed(3)}`);
      await ok('fx.reset');
    });

  // Grading (curves, colour by colour, split toning, film) baked into a colour table
  if (t.hello.commands.includes('fx.luts') && t.hello.commands.includes('camera.mean'))
    await t.step('grading: curves, split toning, bleach bypass, undo', async () => {
      const mean = () => ok('camera.mean', { width: 96 });
      const spread = (c) => Math.max(...c) - Math.min(...c);
      await ok('fx.reset');
      await sleep(250);
      const before = await mean();
      await ok('fx.set', { effect: 'grading', values: { on: true, curveAll: '0,1 1,0' } });
      await sleep(300);
      const inv = await mean();
      check('an upside-down curve inverts the picture', [0, 1, 2].every((i) => near(inv[i], 1 - before[i], 0.06)), JSON.stringify({ before, inv }));
      await ok('undo');
      await sleep(250);
      const back = await mean();
      check('undo: the curve is straight again', [0, 1, 2].every((i) => near(back[i], before[i], 0.02)), JSON.stringify(back));
      await ok('fx.set', { effect: 'grading', values: { on: true, curveAll: '0,0 1,1', shadowHue: 220, shadowAmount: 1, highlightHue: 220, highlightAmount: 1 } });
      await sleep(300);
      const blue = await mean();
      check('split toning in blue: the picture turns blue', blue[2] - blue[0] > before[2] - before[0] + 0.03, JSON.stringify({ before, blue }));
      await ok('fx.reset', { effect: 'grading' });
      await ok('fx.set', { effect: 'grading', values: { on: true, bleach: 1 } });
      await sleep(300);
      const bleached = await mean();
      check('bleach bypass: less colour', spread(bleached) < spread(before) * 0.85 + 0.005, JSON.stringify({ before, bleached }));
      const g = (await ok('fx.get')).effects.grading;
      check('grading values come back from the bridge (curves as text)', g.on === true && g.curveAll === '0,0 1,1' && near(g.bleach, 1), JSON.stringify({ on: g.on, curveAll: g.curveAll, bleach: g.bleach }));
      await ok('fx.reset');
    });

  if (t.hello.commands.includes('camera.mean'))
    await t.step('our bloom and ambient occlusion', async () => {
      const mean = () => ok('camera.mean', { width: 96 });
      const L = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      await ok('fx.reset');
      await sleep(250);
      const m0 = await mean();
      const st = await ok('fx.set', { effect: 'bloom', values: { on: true, intensity: 1.5, threshold: 0.2 } });
      check('bloom is one of the effects', st.effects.bloom?.on === true);
      await sleep(300);
      const glow = await mean();
      check('bloom brightens', L(glow) > L(m0) + 0.01, `${L(m0).toFixed(3)} → ${L(glow).toFixed(3)}`);
      await ok('fx.reset');
      await ok('fx.set', { effect: 'ao', values: { on: true, intensity: 2.5, radius: 0.6 } });
      await sleep(300);
      const shade = await mean();
      check('ambient occlusion darkens where things meet', L(shade) < L(m0) - 0.003, `${L(m0).toFixed(4)} → ${L(shade).toFixed(4)}`);
      await ok('fx.set', { effect: 'ao', values: { color: [0, 0, 1, 1] } });
      await sleep(300);
      const blue = await mean();
      check('…in its shade colour (blue: the shade keeps its blue)', blue[2] - blue[0] > shade[2] - shade[0] + 0.002, JSON.stringify({ shade, blue }));
      await ok('fx.reset');
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
    // Timeline reads the scene's own data a moment after us: let the load finish before the next step
    let last = -1;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const d = (await ok('timeline.get').catch(() => null))?.duration ?? -1;
      if (d === last && d > 0) break;
      last = d;
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
      const end = (await ok('fx.get')).effects.fog.density;
      const st = await ok('timeline.get');
      check('reaches the key', near(end, 0.25), JSON.stringify({ end, time: st.time, duration: st.duration, keys: st.tracks.find((x) => x.id === tr)?.keys }));
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

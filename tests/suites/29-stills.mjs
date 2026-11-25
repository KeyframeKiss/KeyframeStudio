import fs from 'node:fs';

export const name = 'Stills: supersampled pictures (ours and Screencap), transparency, batches per saved view / shot';

// PNG colour type: 2 = RGB, 6 = RGBA
const pngType = (file) => fs.readFileSync(file)[25];

export default async function (t) {
  const { ok, req, check, near, sleep } = t;
  if (!t.hello.commands.includes('still.capture')) t.skip('bridge without stills');
  await t.loadSample();
  const made = [];
  t.defer(() => {
    for (const f of made) fs.rmSync(f, { force: true });
    return req('still.set', { useScreencap: st.useScreencap });
  });
  const st = await ok('still.status');

  await t.step('one picture (ours)', async () => {
    await ok('still.set', { useScreencap: false });
    const r = await ok('still.capture', { width: 640, height: 360, supersample: 2, format: 'png' });
    made.push(r.path);
    check('saved at the size asked for', fs.existsSync(r.path) && r.width === 640 && r.height === 360 && r.provider === 'Keyframe Studio', JSON.stringify({ w: r.width, h: r.height, p: r.provider }));
    check('a real picture (not blank)', fs.statSync(r.path).size > 50000, String(fs.statSync(r.path).size));
    check('with a thumbnail', typeof r.thumb === 'string' && r.thumb.startsWith('data:image/jpeg'));
    const j = await ok('still.capture', { width: 400, height: 400, supersample: 1, format: 'jpg', quality: 80 });
    made.push(j.path);
    check('JPG, square', j.path.endsWith('.jpg') && j.width === 400 && j.height === 400);
    check('JPG can not be transparent', !(await req('still.capture', { width: 400, height: 400, format: 'jpg', transparent: true })).ok);
    check('absurd sizes refused', !(await req('still.capture', { width: 8000, height: 8000, supersample: 4 })).ok);
  });

  // quality stills: many renders averaged, a real lens, 16-bit PNG (YuppiEffects-style, our own)
  await t.step('quality stills: smooth, real lens, 16-bit PNG', async () => {
    const t0 = Date.now();
    const a = await t.studio.req('still.capture', { width: 480, height: 270, supersample: 1, format: 'png', samples: 16 }, 120000);
    check('16 renders averaged: saved', a.ok && fs.existsSync(a.result.path) && a.result.provider === 'Keyframe Studio', JSON.stringify(a.error ?? a.result?.provider));
    if (a.ok) made.push(a.result.path);
    t.metric('16 renders at 480 × 270', ((Date.now() - t0) / 1000).toFixed(1), 's');
    const b = await t.studio.req('still.capture', { width: 480, height: 270, supersample: 1, format: 'png', samples: 32, lens: true, fstop: 1.4, bits16: true }, 120000);
    check('a lens still at 16 bits: saved', b.ok && fs.existsSync(b.result.path), JSON.stringify(b.error));
    if (b.ok) {
      made.push(b.result.path);
      const buf = fs.readFileSync(b.result.path);
      check('a 16-bit RGB PNG', buf[24] === 16 && buf[25] === 2, `bit depth ${buf[24]}, colour type ${buf[25]}`);
      check('it says how it was made', buf.includes(Buffer.from('Keyframe Studio')) && buf.includes(Buffer.from('lens f/1.4')));
      check('a real picture (not blank)', buf.length > 100000, String(buf.length));
    }
    check('16 bits is PNG only', !(await req('still.capture', { width: 320, height: 180, format: 'jpg', bits16: true })).ok);
    const sc = await ok('camera.mean', { width: 64 });
    check('Studio’s view is untouched afterwards', sc.every((v) => v > 0 && v < 1));
  });

  if (st.screencap)
    await t.step('Screencap (installed)', async () => {
      await ok('still.set', { useScreencap: true });
      const r = await ok('still.capture', { width: 640, height: 360, supersample: 2 });
      made.push(r.path);
      check('Screencap takes it', r.provider === 'Screencap' && r.width === 640 && r.height === 360);
      const a = await ok('still.capture', { width: 640, height: 360, supersample: 1, transparent: true });
      made.push(a.path);
      check('transparent PNG has an alpha channel', a.provider === 'Screencap' && pngType(a.path) === 6, String(pngType(a.path)));
    });

  await t.step('several versions with one press', async () => {
    const list = await ok('still.capture', {
      width: 640,
      height: 360,
      supersample: 1,
      format: 'jpg',
      versions: [
        { label: 'Wide', width: 320, height: 180, framing: { mode: 'timeline' } },
        { label: 'Tall', width: 180, height: 320, framing: { mode: 'adjust', x: 0.2, y: 0, zoom: 1.3 } },
      ],
    });
    for (const r of list ?? []) made.push(r.path);
    check('one picture per version', Array.isArray(list) && list.length === 2, JSON.stringify(list?.map?.((r) => r.path)));
    check('…each at its own size', list[0].width === 320 && list[0].height === 180 && list[1].width === 180 && list[1].height === 320);
    check('…named after it', /Wide\.jpg$/.test(list[0].path) && /Tall\.jpg$/.test(list[1].path), list.map((r) => r.path.replace(/^.*[\\/]/, '')).join(', '));
    check('the framing is only used for that picture', (await ok('render.framingPreview', { framing: null })) === false);
  });

  const wait = async () => {
    let s;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      s = await ok('still.status');
      if (!s.batch.running) break;
    }
    return s;
  };

  await t.step('one per saved view', async () => {
    const cam = await ok('camera.get');
    const used = cam.slots.filter((x) => x.used).length;
    const fovBefore = cam.fov;
    await ok('camera.setFov', { fov: fovBefore + 3 });
    await sleep(300);
    const before = await ok('camera.activeSlot');
    await ok('still.batch', { kind: 'views', width: 320, height: 180, supersample: 1 });
    const s = await wait();
    for (const r of s.batch.results) made.push(r.path);
    check('a picture per saved view', used > 0 && s.batch.results.length === used && !s.batch.error, `${s.batch.results.length} of ${used} ${s.batch.error ?? ''}`);
    await sleep(300);
    // a view the batch didn't leave on one of the saved ones (its FOV differs from all of them)
    check('the view is put back', near((await ok('camera.get')).fov, fovBefore + 3) && JSON.stringify(await ok('camera.activeSlot')) === JSON.stringify(before), JSON.stringify(before));
  });

  if (t.hello.timeline)
    await t.step('one per shot', async () => {
      await ok('shots.set', { shots: [{ id: 'a', name: 'Opening', start: 0, end: 1 }, { id: 'b', name: 'Close up', start: 1, end: 2 }] });
      t.defer(() => req('shots.set', { shots: [] }));
      await ok('shots.captureCamera', { id: 'a' });
      await ok('camera.setFov', { fov: 30 });
      await ok('shots.captureCamera', { id: 'b' });
      await ok('timeline.seek', { t: 0.5 });
      await ok('still.batch', { kind: 'shots', width: 320, height: 180, supersample: 1 });
      const s = await wait();
      for (const r of s.batch.results) made.push(r.path);
      check('a picture per shot, named after it', s.batch.results.length === 2 && s.batch.results.some((r) => /Close up/.test(r.path)));
      check('the playhead is put back', near((await ok('timeline.state')).time, 0.5));
    });
}

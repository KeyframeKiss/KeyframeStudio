export const name = 'Shots: undo, live cuts, still vs camera-key shots, saved views, pictures, frame guides, baked cuts';

export default async function (t) {
  const { ok, req, check, sleep, near, studio } = t;
  await t.loadSample();
  const fovNow = async () => (await ok('camera.get')).fov;
  const state = () => ok('shots.state');
  const shot = async (id) => (await state()).shots.find((s) => s.id === id);
  const changed = () => studio.waitFor('shots.changed', () => true, 5000);
  t.defer(async () => {
    await req('shots.setLiveCuts', { on: false });
    await req('shots.set', { shots: [] });
    await req('camtools.set', { guides: { aspect: 0 } });
  });

  await ok('timeline.stop');
  await ok('timeline.seek', { t: 0 });
  await sleep(500);

  await t.step('edits are undoable and announced', async () => {
    const heard = changed();
    await ok('shots.set', { shots: [{ id: 'A', name: 'Wide', start: 0, end: 2 }, { id: 'B', name: 'Close', start: 2, end: 4, status: 'framed', camMode: 'still' }], label: 'Add shots' });
    check('the app hears about it', !!(await heard.then(() => true).catch(() => false)));
    const s = await state();
    check('two shots, defaults filled in', s.shots.length === 2 && s.shots[0].status === 'idea' && s.shots[0].camMode === 'still' && s.shots[1].status === 'framed', JSON.stringify(s.shots.map((x) => [x.status, x.camMode])));
    await ok('shots.set', { shots: s.shots.map((x) => (x.id === 'A' ? { ...x, end: 1.5 } : x)), label: 'Trim shot' });
    check('trimmed', near((await shot('A')).end, 1.5));
    await ok('undo');
    check('undo puts the end back', near((await shot('A')).end, 2));
    await ok('redo');
    check('redo trims it again', near((await shot('A')).end, 1.5));
    await ok('undo');
  });

  await t.step('cameras: Studio’s view, saved views, pictures', async () => {
    await ok('camera.setFov', { fov: 23 });
    await sleep(200);
    await ok('shots.captureCamera', { id: 'A' });
    await ok('camera.saveSlot', { index: 7 });
    await ok('camera.setFov', { fov: 50 });
    await sleep(200);
    await ok('shots.captureCamera', { id: 'B' });
    await ok('camera.saveSlot', { index: 8 });
    const a = await shot('A');
    const b = await shot('B');
    check('each shot keeps its camera and a picture', near(a.cam.fov, 23, 0.01) && near(b.cam.fov, 50, 0.01) && a.thumb?.startsWith('data:image') && b.thumb?.startsWith('data:image'));
    await ok('shots.fromView', { id: 'B', slot: 7 });
    check('a saved view becomes the shot’s camera', near((await shot('B')).cam.fov, 23, 0.01));
    await ok('undo');
    check('…one undo step', near((await shot('B')).cam.fov, 50, 0.01));
    const cams = await ok('camera.get');
    const empty = cams.slots.find((x) => !x.used);
    if (empty) {
      const bad = await req('shots.fromView', { id: 'B', slot: empty.index });
      check('an empty saved view is refused', !bad.ok, bad.error);
    }
    const n = await ok('shots.thumbs', {});
    check('new pictures for the still shots', n === 2, String(n));
  });

  await t.step('live cuts switch cameras at the cuts', async () => {
    await ok('shots.setLiveCuts', { on: true });
    check('on, and saved in the state', (await state()).liveCuts === true);
    await ok('timeline.seek', { t: 0.5 });
    await sleep(400);
    check('in shot A: its camera', near(await fovNow(), 23, 0.05), String(await fovNow()));
    check('…at saved view 8', (await ok('camera.activeSlot')).includes(7));
    await ok('timeline.seek', { t: 3 });
    await sleep(400);
    check('in shot B: its camera', near(await fovNow(), 50, 0.05), String(await fovNow()));
    // paused, scrubbing inside the same shot leaves your framing alone
    await ok('camera.setFov', { fov: 33 });
    await ok('timeline.seek', { t: 3.4 });
    await sleep(400);
    check('scrubbing inside a shot keeps your framing', near(await fovNow(), 33, 0.05), String(await fovNow()));
    // while playing, the shot's camera wins every frame
    await ok('timeline.seek', { t: 0.2 });
    await sleep(300);
    await ok('camera.setFov', { fov: 61 });
    await ok('timeline.play');
    await sleep(500);
    const playing = await fovNow();
    await ok('timeline.pause');
    check('while playing the shot’s camera holds', near(playing, 23, 0.05), String(playing));
  });

  await t.step('a shot on camera keys keeps its keys', async () => {
    const s = await state();
    await ok('shots.set', { shots: s.shots.map((x) => (x.id === 'B' ? { ...x, camMode: 'keys' } : x)), label: 'Shot camera: keys' });
    await ok('timeline.seek', { t: 0.5 });
    await sleep(300);
    await ok('camera.setFov', { fov: 44 });
    await ok('timeline.seek', { t: 3 });
    await sleep(400);
    check('entering it doesn’t switch the camera', near(await fovNow(), 44, 0.05), String(await fovNow()));
    await ok('undo');
  });

  await t.step('a shot’s frame guide', async () => {
    const s = await state();
    await ok('shots.set', { shots: s.shots.map((x) => (x.id === 'A' ? { ...x, aspect: 2.39 } : x)), label: 'Shot frame' });
    await ok('timeline.seek', { t: 3 });
    await sleep(300);
    await ok('camtools.set', { guides: { aspect: 0 } });
    await ok('timeline.seek', { t: 0.5 });
    await sleep(400);
    const g = (await ok('camtools.get')).guides;
    check('entering the shot shows its frame', near(g.aspect, 2.39, 0.01), String(g.aspect));
    await ok('shots.view', { id: 'B' });
    check('looking through a shot without a frame leaves the guides alone', near((await ok('camtools.get')).guides.aspect, 2.39, 0.01));
  });

  await t.step('looping a shot (frame-accurate, in the bridge)', async () => {
    const r = await ok('timeline.loopRange', { start: 1, end: 2 });
    check('loop range set', r.on && near(r.start, 1) && near(r.end, 2));
    await ok('timeline.seek', { t: 1 });
    await ok('timeline.play');
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      const tm = (await ok('timeline.state')).time;
      lo = Math.min(lo, tm);
      hi = Math.max(hi, tm);
    }
    check('3 s of playing stays inside 1 … 2 s', lo >= 0.99 && hi <= 2.05, `${lo.toFixed(3)} … ${hi.toFixed(3)}`);
    await ok('timeline.loopRange', {});
    await sleep(1500);
    const past = (await ok('timeline.state')).time;
    await ok('timeline.pause');
    check('cleared: it plays on past the shot', past > 2.05 || past < 1, past.toFixed(3));
  });

  await t.step('bake cuts', async () => {
    const n = await ok('shots.buildCuts', {});
    check('a cut keyed per still shot', n === 2, String(n));
    await ok('undo');
  });

  await ok('shots.setLiveCuts', { on: false });
  check('live cuts off', (await state()).liveCuts === false);
}

import fs from 'node:fs';
import path from 'node:path';

export const name = 'Render (VideoExport) and shot sequencer';

export default async function (t) {
  t.needs('timeline');
  const { ok, req, check, sleep, near } = t;
  const { chara } = await t.loadSample();
  void chara;
  const hasRender = t.has('render');
  let original = null;
  if (hasRender) {
    original = (await ok('render.status')).settings;
    t.defer(() => req('render.set', { fps: original.fps, exportFps: original.exportFps, limit: original.limit, limitNumber: original.limitNumber, format: original.format, resize: original.resize, width: original.width, height: original.height, autoEncode: original.autoEncode, deleteFrames: original.deleteFrames, prewarm: original.prewarm }));
  }

  /** wait until VideoExport is idle; the frames folder made during `fn`, if any */
  const framesMadeBy = async (fn) => {
    const st = await ok('render.status');
    const dir = st.framesFolder;
    const before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
    await fn();
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const s = await ok('render.status');
      const q = await ok('render.queueStatus');
      if (!s.recording && !s.encoding && !q.running) break;
    }
    const made = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => !before.has(f) && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(f));
    // only folders VideoExport created during this test, inside its frames folder
    t.defer(() => made.forEach((f) => fs.rmSync(path.join(dir, f), { recursive: true, force: true })));
    return made.map((f) => path.join(dir, f));
  };

  if (hasRender)
    await t.step('render settings and a short recording', async () => {
      let s = await ok('render.set', { fps: 30, format: 'MP4', limit: 'Timeline', limitNumber: 0 });
      check('settings applied (Timeline mode plays at least once)', s.settings.fps === 30 && s.settings.format === 'MP4' && s.settings.limit === 'Timeline' && s.settings.limitNumber >= 1, JSON.stringify(s.settings));
      check('formats and length modes listed', s.formats.includes('MP4') && s.limits.includes('Timeline'));
      s = await ok('render.set', { fps: 10, limit: 'Seconds', limitNumber: 0.3, autoEncode: false, deleteFrames: false, resize: true, width: 320, height: 180 });
      const made = await framesMadeBy(() => ok('render.start', {}));
      const frames = made.length ? fs.readdirSync(made[0]).length : 0;
      check('3 frames captured', made.length === 1 && frames === 3, `${made.length} folders, ${frames} frames`);
      const bad = await req('render.set', { format: 'MOV' });
      check('unknown format refused', !bad.ok);
    });

  await t.step('shots, camera cuts', async () => {
    let shots = await ok('shots.set', { shots: [{ id: 'a', name: 'Wide', start: 0, end: 1 }, { id: 'b', name: 'Close', start: 1, end: 2 }] });
    check('two shots, sorted', shots.length === 2 && shots[0].name === 'Wide');
    await ok('shots.captureCamera', { id: 'a' });
    await ok('camera.move', { preset: 'dolly', amount: 0.5, duration: 0.1, t0: 0 }); // change the view a bit…
    await ok('undo');
    shots = await ok('shots.captureCamera', { id: 'b' });
    check('cameras + thumbnails remembered', shots.every((s) => s.cam && s.thumb?.startsWith('data:image/jpeg')));
    const bad = await req('shots.set', { shots: [{ id: 'x', name: 'Bad', start: 1, end: 1 }] });
    check('a shot needs an end after its start', !bad.ok);
    check('cuts keyed for 2 shots', (await ok('shots.buildCuts')) === 2);
    const tl = await ok('timeline.get');
    const rot = tl.tracks.find((x) => x.model === 'cameraORot' && x.oci === -1);
    check('camera keys at both shot starts', rot && [0, 1].every((s) => rot.keys.some((k) => near(k[0], s))), rot ? rot.keys.map((k) => k[0]).join() : 'no track');
    const first = rot.keys.find((k) => near(k[0], 0));
    check('the key before the second shot holds (a cut)', first[1] && first[1][6] === Infinity, JSON.stringify(first));
    await ok('undo');
    check('one undo removes the cuts', !(await ok('timeline.get')).tracks.find((x) => x.model === 'cameraORot' && x.oci === -1)?.keys.length);
  });

  await t.step('shots saved with the scene', async () => {
    const sceneDir = path.join(t.paths.userData, 'studio', 'scene');
    const before = new Set(fs.readdirSync(sceneDir));
    await ok('scene.save');
    let added = [];
    for (let i = 0; i < 20 && !added.length; i++) {
      await sleep(500);
      added = fs.readdirSync(sceneDir).filter((f) => !before.has(f));
    }
    t.defer(() => added.forEach((f) => /^\d{4}_\d{4}_\d{4}_\d{2}_\d{3}\.png$/.test(f) && fs.existsSync(path.join(sceneDir, f)) && fs.unlinkSync(path.join(sceneDir, f))));
    await ok('scene.new');
    await sleep(1500);
    check('new scene: no shots', (await ok('shots.get')).length === 0);
    await ok('scene.load', { path: path.join(sceneDir, added[0]) });
    let shots = [];
    for (let i = 0; i < 20 && !shots.length; i++) {
      await sleep(700);
      shots = await ok('shots.get');
    }
    check('loading the scene brings its shots back', shots.length === 2 && shots[1].name === 'Close' && !!shots[1].cam);
  });

  if (hasRender)
    await t.step('render queue', async () => {
      await ok('shots.set', { shots: [{ id: 'q', name: 'Queue test', start: 0.5, end: 0.8 }] });
      await ok('render.set', { fps: 10, autoEncode: false, deleteFrames: false, resize: true, width: 320, height: 180 });
      const made = await framesMadeBy(() => ok('render.queue', { ids: ['q'] }));
      const q = await ok('render.queueStatus');
      check('queue rendered the shot', !q.running && q.done === 1 && !q.error, JSON.stringify(q));
      check('its frames were captured', made.length === 1 && fs.readdirSync(made[0]).length >= 2, `${made.length} folders`);
    });
}

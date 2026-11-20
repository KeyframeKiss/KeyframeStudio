import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 16-bit mono WAV, a steady 330 Hz tone. */
function makeTone(file, secs, rate = 22050) {
  const n = Math.floor(secs * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

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
      // "from the playhead": the timeline has to play while it records, not stand still
      await ok('timeline.seek', { t: 1 });
      await sleep(300);
      const times = [];
      const made = await framesMadeBy(async () => {
        await ok('render.start', {});
        for (let i = 0; i < 40; i++) {
          const st = await ok('render.status');
          const q = await ok('render.queueStatus');
          if (!st.recording && !q.running) break;
          if (st.recording) times.push((await ok('timeline.state')).time);
          await sleep(30);
        }
      });
      const frames = made.length ? fs.readdirSync(made[0]).length : 0;
      check('3 frames captured', made.length === 1 && frames === 3, `${made.length} folders, ${frames} frames`);
      check('the animation plays while recording (from the playhead)', times.length > 0 && Math.max(...times) > 1.05, times.map((x) => x.toFixed(2)).join(' '));
      const after = await ok('timeline.state');
      check('the playhead goes back to where the render started', near(after.time, 1, 0.02) && !after.playing, String(after.time));
      // "to the end": from the playhead to the end of the timeline; the chosen length mode stays chosen
      const tl = await ok('timeline.state');
      await ok('render.set', { limit: 'none' });
      await ok('timeline.seek', { t: tl.duration - 0.3 });
      await sleep(300);
      const made2 = await framesMadeBy(() => ok('render.start', {}));
      const frames2 = made2.length ? fs.readdirSync(made2[0]).length : 0;
      check('"to the end" records the rest of the timeline', made2.length === 1 && frames2 >= 2 && frames2 <= 4, `${frames2} frames`);
      check('the length mode comes back after', (await ok('render.status')).settings.limit === 'none');
      // "all of it": the whole timeline from 0, after a warm-up play (VideoExport's own Timeline mode doesn't play it)
      await ok('timeline.setSettings', { duration: 1 });
      t.defer(() => req('timeline.setSettings', { duration: tl.duration }));
      await ok('render.set', { limit: 'Timeline', limitNumber: 1, prewarm: 1 });
      await ok('timeline.seek', { t: 0.6 });
      await sleep(300);
      const times3 = [];
      let warmed = false;
      const made3 = await framesMadeBy(async () => {
        await ok('render.start', {});
        for (let i = 0; i < 120; i++) {
          const st = await ok('render.status');
          const q = await ok('render.queueStatus');
          if (q.phase) warmed = true;
          if (!st.recording && !q.running) break;
          if (st.recording) times3.push((await ok('timeline.state')).time);
          await sleep(30);
        }
      });
      const frames3 = made3.length ? fs.readdirSync(made3[0]).length : 0;
      check('"all of it": warm-up first, then the whole timeline plays while recording', warmed && frames3 === 10 && times3.length > 0 && Math.min(...times3) < 0.3 && Math.max(...times3) > 0.5, `${frames3} frames, warm-up ${warmed}, ${times3.map((x) => x.toFixed(2)).join(' ')}`);
      await ok('timeline.setSettings', { duration: tl.duration });
      await ok('render.set', { limit: 'Seconds', limitNumber: 0.3, prewarm: 0 });

      // audio: silent while recording, then mixed into the finished video
      const wav = path.join(t.paths.userData, 'audio', 'StudioEX render tone.wav');
      makeTone(wav, 2);
      t.defer(() => fs.existsSync(wav) && fs.unlinkSync(wav));
      await ok('audio.clear');
      t.defer(() => req('audio.clear'));
      await ok('audio.add', { file: 'StudioEX render tone.wav', offset: 0 });
      await ok('render.set', { limit: 'Seconds', limitNumber: 1, prewarm: 1, autoEncode: true, deleteFrames: true, format: 'MP4', audio: true });
      const outDir = (await ok('render.status')).outputFolder;
      const outBefore = new Set(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []);
      await ok('timeline.seek', { t: 0.2 });
      await sleep(300);
      let heard = false,
        warmed4 = false;
      await framesMadeBy(async () => {
        await ok('render.start', {});
        for (let i = 0; i < 300; i++) {
          const st = await ok('render.status');
          const q = await ok('render.queueStatus');
          if (q.phase && /Warm/.test(q.phase)) warmed4 = true;
          if ((await ok('audio.get')).clips.some((c) => c.playing)) heard = true;
          if (!st.recording && !st.encoding && !q.running) break;
          await sleep(50);
        }
      });
      const q4 = await ok('render.queueStatus');
      const videos = (fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).filter((f) => !outBefore.has(f) && /\.mp4$/.test(f));
      t.defer(() => videos.forEach((f) => fs.rmSync(path.join(outDir, f), { force: true })));
      check('warm-up works for "from the playhead" too', warmed4);
      check('the audio stays silent while rendering', !heard);
      let info = '';
      if (videos.length) {
        const ffmpeg = path.join(path.dirname(t.paths.userData), 'BepInEx', 'plugins', 'VideoExport', 'ffmpeg', 'ffmpeg-64.exe');
        const r = spawnSync(ffmpeg, ['-hide_banner', '-i', path.join(outDir, videos[0])], { encoding: 'utf8' });
        info = r.stderr ?? '';
      }
      check('the video has the audio in it', videos.length === 1 && /Audio: aac/.test(info) && /Video: h264/.test(info) && !q4.audioError, `${videos.join()} ${q4.audioError ?? ''} ${info.split('\n').filter((l) => /Stream|Duration/.test(l)).join(' | ')}`);
      const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
      check('…as long as the render', !!dur && Math.abs(Number(dur[3]) - 1) < 0.15, dur?.[0]);

      // another shape (vertical): rendered at that size, not the window stretched into it
      const cap0 = await ok('render.capture');
      await ok('audio.clear');
      await ok('render.set', { limit: 'Seconds', limitNumber: 0.5, prewarm: 0, autoEncode: true, deleteFrames: true, format: 'MP4', resize: true, width: 180, height: 320 });
      const outBefore2 = new Set(fs.readdirSync(outDir));
      await ok('timeline.seek', { t: 0 });
      await sleep(300);
      await framesMadeBy(() => ok('render.start', {}));
      const videos2 = fs.readdirSync(outDir).filter((f) => !outBefore2.has(f) && /\.mp4$/.test(f));
      t.defer(() => videos2.forEach((f) => fs.rmSync(path.join(outDir, f), { force: true })));
      let info2 = '';
      if (videos2.length) {
        const ffmpeg = path.join(path.dirname(t.paths.userData), 'BepInEx', 'plugins', 'VideoExport', 'ffmpeg', 'ffmpeg-64.exe');
        info2 = spawnSync(ffmpeg, ['-hide_banner', '-i', path.join(outDir, videos2[0])], { encoding: 'utf8' }).stderr ?? '';
      }
      const stream = info2.split('\n').find((l) => /Video:/.test(l)) ?? '';
      check('vertical 180×320 comes out 180×320', /\b180x320\b/.test(stream), `${videos2.join()} ${stream.trim()} — capture ${JSON.stringify(cap0)}`);
      check('…with square pixels (cut to shape, not squished)', !/SAR (?!1:1)\d+:\d+/.test(stream), stream.trim());
      const cap1 = await ok('render.capture');
      check('VideoExport\'s capture and Screencap size are put back after', cap1.selected === cap0.selected && JSON.stringify(cap1.screencapSize) === JSON.stringify(cap0.screencapSize) && (await ok('render.status')).settings.resize === true, `${JSON.stringify(cap0)} → ${JSON.stringify(cap1)}`);
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
      await ok('render.set', { fps: 10, autoEncode: false, deleteFrames: false, resize: true, width: 320, height: 180, limit: 'Timeline', limitNumber: 1 });
      const made = await framesMadeBy(() => ok('render.queue', { ids: ['q'] }));
      check('the queue leaves the length mode as it was', (await ok('render.status')).settings.limit === 'Timeline');
      const q = await ok('render.queueStatus');
      check('queue rendered the shot', !q.running && q.done === 1 && !q.error, JSON.stringify(q));
      check('its frames were captured', made.length === 1 && fs.readdirSync(made[0]).length >= 2, `${made.length} folders`);
    });
}

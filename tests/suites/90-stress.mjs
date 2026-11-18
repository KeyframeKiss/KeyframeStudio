import fs from 'node:fs';
import path from 'node:path';
import { connectRenderer, stats } from '../lib/cdp.mjs';

export const name = 'Stress: large scene (200+ objects, 100+ tracks, 5,000+ keys)';
export const optIn = true; // slow: run with `node tests/run.mjs stress`

const OBJECTS = 210; // import the sample scene until there are this many objects
const TRACK_OBJECTS = 60; // × position + rotation = 120 tracks
const KEY_TIMES = 45; // keys per track → 5,400 keys

/**
 * Builds a heavy scene and measures what a user feels: bridge round trips, change detection (runs on Studio's
 * main thread every 0.4 s), undo of a big edit, Studio's frame rate idle and playing, and — when the app runs
 * with KF_DEBUG_PORT — how long the app's dope sheet / graph take to draw and to take in a timeline refresh.
 * Checks use generous limits; the printed numbers are the point.
 */
export default async function (t) {
  t.needs('timeline');
  const { ok, check, sleep, metric } = t;
  const time = async (fn) => {
    const t0 = performance.now();
    const r = await fn();
    return [performance.now() - t0, r];
  };
  const avg = async (n, fn) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += (await time(fn))[0];
    return sum / n;
  };
  const fps = async (secs = 3) => {
    const v = [];
    for (let i = 0; i < secs * 2; i++) {
      await sleep(500);
      v.push((await ok('diag.info')).scene.fps);
    }
    return v.reduce((a, b) => a + b, 0) / v.length;
  };

  // ---------------- baseline: the sample scene ----------------
  const { scene } = await t.loadSample();
  await sleep(1500);
  const baseFps = metric('Studio fps, sample scene, idle', await fps(), 'fps');
  metric('change scan (timeline.changes), sample scene', await avg(5, () => ok('timeline.changes')));

  // ---------------- build the heavy scene ----------------
  const sample = (await ok('scene.list')).find((s) => /sample_00\.png$/i.test(s.rel));
  // each import finishes over several frames: wait for the object count to grow before the next one
  const count = async () => (await ok('diag.info')).scene.objects;
  for (let i = 0; i < 40 && (await count()) < OBJECTS; i++) {
    const before = await count();
    await ok('scene.import', { path: sample.path });
    for (let w = 0; w < 30 && (await count()) <= before; w++) await sleep(500);
    await sleep(1000);
  }
  let nodes = [];
  for (let i = 0; i < 20; i++) {
    nodes = (await ok('scene.get')).nodes;
    if (nodes.length > scene.nodes.length) break;
    await sleep(1000);
  }
  const objects = (await ok('diag.info')).scene.objects;
  check('heavy scene built (200+ objects)', objects >= 200, `${objects} objects`);
  metric('objects in scene', objects, '');

  const targets = nodes.filter((n) => n.type === 'Item' || n.type === 'Char' || n.type === 'Light').slice(0, TRACK_OBJECTS);
  const tracks = [];
  for (const n of targets) {
    for (const model of ['guideObjectPos', 'guideObjectRot']) {
      const r = await t.req('timeline.addTrack', { owner: 'Timeline', model, oci: n.id, keyAt: 0 });
      if (r.ok) tracks.push(r.result);
    }
  }
  const [keyMs] = await time(async () => {
    for (let k = 1; k < KEY_TIMES; k++) await ok('timeline.addKeys', { tracks, t: k * 0.2 });
  });
  const tl = await ok('timeline.get');
  const keys = tl.tracks.reduce((n, x) => n + x.keys.length, 0);
  check('100+ tracks and 5,000+ keys', tl.tracks.length >= 100 && keys >= 5000, `${tl.tracks.length} tracks, ${keys} keys`);
  metric('tracks', tl.tracks.length, '');
  metric('keys', keys, '');
  metric(`adding ${tracks.length} keys at a time, average per call`, keyMs / (KEY_TIMES - 1));

  // ---------------- bridge round trips ----------------
  const getMs = metric('timeline.get (whole timeline)', await avg(3, () => ok('timeline.get')));
  metric('timeline.get size', JSON.stringify(tl).length / 1024, 'KB');
  check('timeline.get under 1.5 s', getMs < 1500);
  const sceneMs = metric('scene.get (object tree)', await avg(3, () => ok('scene.get')));
  check('scene.get under 500 ms', sceneMs < 500);
  // (a round trip waits for Studio's next frame, so it mostly measures Studio's frame time)
  metric('change scan round trip (timeline.changes)', await avg(5, () => ok('timeline.changes')));

  // ---------------- big edits and undo ----------------
  const refs = tl.tracks.flatMap((x) => x.keys.filter((k) => k[0] > 0).map((k) => ({ track: x.id, t: k[0] })));
  const [moveMs] = await time(() => ok('timeline.moveKeys', { keys: refs, dt: 0.01 }));
  metric(`move ${refs.length} keys`, moveMs);
  const [undoMs] = await time(() => ok('undo'));
  metric('undo that move', undoMs);
  const [redoMs] = await time(() => ok('redo'));
  metric('redo', redoMs);
  await ok('undo');
  check('big move/undo/redo each under 3 s', moveMs < 3000 && undoMs < 3000 && redoMs < 3000);
  const [rmMs] = await time(() => ok('timeline.removeTracks', { tracks }));
  const [rmUndoMs] = await time(() => ok('undo'));
  metric(`delete ${tracks.length} tracks`, rmMs);
  metric('undo the delete', rmUndoMs);
  check('every track back after undo', (await ok('timeline.get')).tracks.length >= tracks.length);

  // ---------------- Studio frame rate ----------------
  await ok('timeline.seek', { t: 0 });
  await sleep(1500);
  const idleFps = metric('Studio fps, heavy scene, idle (bridge watching for changes)', await fps(), 'fps');
  // steady state: the latest scan, sampled a few times (the very first scan after a restart also pays for
  // compiling the code, a one-off)
  const scans = [];
  for (let i = 0; i < 8; i++) {
    await sleep(450);
    const sc = (await ok('diag.info')).changeScan;
    if (sc) scans.push(sc.last);
  }
  if (scans.length) {
    const sorted = [...scans].sort((a, b) => a - b);
    metric('change scan inside Studio, typical (every 0.4 s)', sorted[Math.floor(sorted.length / 2)]);
    metric('change scan inside Studio, slowest sampled', sorted[sorted.length - 1]);
    check('change scan inside Studio under 8 ms', sorted[Math.floor(sorted.length / 2)] < 8, JSON.stringify(scans));
  }
  await ok('timeline.play');
  const playFps = metric('Studio fps, heavy scene, playing', await fps(4), 'fps');
  const bridgeFrame = (await ok('diag.info')).bridgeFrame;
  if (bridgeFrame) {
    metric('Keyframe Studio plugin, time per Studio frame (average)', bridgeFrame.avg);
    metric("Keyframe Studio plugin, worst frame in 30 s (incl. Studio's own scene import/save)", bridgeFrame.max30s);
    check('plugin uses under 2 ms per frame on average', bridgeFrame.avg < 2, JSON.stringify(bridgeFrame));
  }
  await ok('timeline.stop');
  check('playback keeps at least 20 fps', playFps >= 20, `${playFps.toFixed(1)} fps (sample scene idle: ${baseFps.toFixed(1)}, heavy idle: ${idleFps.toFixed(1)})`);

  // ---------------- the app window (optional) ----------------
  const port = process.env.KF_DEBUG_PORT;
  if (port) {
    await t.step('app window timings', async () => {
      const app = await connectRenderer(port);
      t.defer(() => app.close());
      // Animate workspace, dope sheet, every track shown
      await app.eval(`(() => { const tabs=[...document.querySelectorAll('.ws-tab')]; tabs[0]?.click(); })()`);
      await sleep(800);
      await app.eval(`(() => { const b=[...document.querySelectorAll('.sheet-toolbar button')]; b.find(x=>x.textContent.trim()==='Dope Sheet')?.click(); b.find(x=>x.textContent.trim()==='All')?.click(); })()`);
      await sleep(1500);
      await app.eval(`(() => { for (const k in window.__kfPerf) window.__kfPerf[k].length = 0; })()`);
      // a timeline refresh: any edit makes the app re-read the whole timeline
      await ok('timeline.addKeys', { tracks: [tracks[0]], t: 9.5 });
      await sleep(3000);
      const frameProbe = `new Promise((res) => { const d=[]; let last=performance.now(); const end=last+3000; const f=(now)=>{ d.push(now-last); last=now; if (now<end) requestAnimationFrame(f); else res(d); }; requestAnimationFrame(f); })`;
      await ok('timeline.play');
      const frames = stats(await app.eval(frameProbe));
      await ok('timeline.stop');
      const perf = await app.eval('JSON.parse(JSON.stringify(window.__kfPerf))');
      const dope = stats(perf.dopeDraw);
      const fetchT = stats(perf.timelineFetch),
        applyT = stats(perf.timelineApply);
      metric('app: timeline refresh — fetch + parse', fetchT.max);
      metric('app: timeline refresh — store update + render', applyT.max);
      metric('app: dope sheet draw while playing, p50', dope.p50);
      metric('app: dope sheet draw while playing, p95', dope.p95);
      metric('app: frame interval while playing, p95 (16.7 = 60 fps)', frames.p95);
      check('dope sheet draws in under 12 ms (p95)', dope.n > 0 && dope.p95 < 12, JSON.stringify(dope));
      check('app keeps 30+ fps while playing (p95 frame < 34 ms)', frames.p95 < 34, JSON.stringify(frames));

      // graph editor with every key selected
      await app.eval(`(() => { const b=[...document.querySelectorAll('.sheet-toolbar button')]; b.find(x=>x.textContent.trim()==='Graph')?.click(); })()`);
      await sleep(800);
      await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))`);
      await sleep(2500);
      await app.eval(`(() => { window.__kfPerf.graphDraw && (window.__kfPerf.graphDraw.length = 0); })()`);
      await ok('timeline.play');
      await sleep(3000);
      await ok('timeline.stop');
      const graph = stats((await app.eval('window.__kfPerf.graphDraw || []')) ?? []);
      metric('app: graph editor draw while playing (all keys), p95', graph.p95);
      check('graph editor draws in under 25 ms (p95)', graph.n > 0 && graph.p95 < 25, JSON.stringify(graph));
      await app.eval(`(() => { const b=[...document.querySelectorAll('.sheet-toolbar button')]; b.find(x=>x.textContent.trim()==='Dope Sheet')?.click(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); })()`);
    });
  } else t.say('app timings skipped: start the app with KF_DEBUG_PORT=9333 to include them');

  // ---------------- saving a heavy scene ----------------
  await t.step('save the heavy scene', async () => {
    const sceneDir = path.join(t.paths.userData, 'studio', 'scene');
    const before = new Set(fs.readdirSync(sceneDir));
    const t0 = performance.now();
    await ok('scene.save', {}, 120000);
    let added = [];
    for (let i = 0; i < 60 && !added.length; i++) {
      await sleep(500);
      added = fs.readdirSync(sceneDir).filter((f) => !before.has(f));
    }
    metric('scene save (until the file exists)', performance.now() - t0);
    if (added.length) metric('saved scene size', fs.statSync(path.join(sceneDir, added[0])).size / 1024 / 1024, 'MB');
    await sleep(2000);
    // only Studio's own timestamped save names, only files that appeared during this test
    for (const f of added) if (/^\d{4}_\d{4}_\d{4}_\d{2}_\d{3}\.png$/.test(f)) fs.unlinkSync(path.join(sceneDir, f));
    check('scene saved', added.length === 1);
  });
}

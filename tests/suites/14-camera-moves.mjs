export const name = 'Camera moves: orbit, dolly, zoom, pan, crane, truck';

// rotate vector v by quaternion q = [x, y, z, w]
function rotate([x, y, z, w], [vx, vy, vz]) {
  const ix = w * vx + y * vz - z * vy,
    iy = w * vy + z * vx - x * vz,
    iz = w * vz + x * vy - y * vx,
    iw = -x * vx - y * vy - z * vz;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
const angle = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI;

export default async function (t) {
  t.needs('timeline');
  const { ok, req, check, near } = t;
  await t.loadSample();
  await ok('camera.view', { id: -1 }).catch(() => {}); // main camera

  const camTracks = async () => {
    const tl = await ok('timeline.get');
    const by = (m) => tl.tracks.find((x) => x.model === m && x.oci === -1);
    return { pos: by('cameraOPos'), rot: by('cameraORot'), zoom: by('cameraOZoom'), fov: by('cameraFOV') };
  };
  const keysOf = async (track) => (await ok('timeline.keyValues', { tracks: [track.id] }))[String(track.id)];
  const v3 = (a) => [a.valueX, a.valueY, a.valueZ];
  const quat = (a) => [a.valueX, a.valueY, a.valueZ, a.valueW];
  const camPos = (pos, rot, z) => {
    const r = rotate(rot, [0, 0, z]);
    return [pos[0] + r[0], pos[1] + r[1], pos[2] + r[2]];
  };

  await t.step('orbit 180° (keys every 45°, replaces keys inside)', async () => {
    await ok('camera.key', { t: 1.5 }); // a key inside the move's range
    const r = await ok('camera.move', { preset: 'orbit', amount: 180, duration: 2, t0: 1 });
    check('5 keys written, the one inside replaced', r.keys === 5 && r.replaced >= 4, JSON.stringify(r));
    const c = await camTracks();
    const rot = (await keysOf(c.rot)).filter((k) => k[0] >= 1 - 1e-3 && k[0] <= 3 + 1e-3);
    check('rotation keys at 1, 1.5, 2, 2.5, 3', rot.length === 5 && rot.every((k, i) => near(k[0], 1 + i * 0.5)), rot.map((k) => k[0]).join());
    check('start to end turns 180°', near(angle(quat(rot[0][1]), quat(rot[4][1])), 180, 0.5));
    check('every step under 90° (no shortcut)', rot.slice(1).every((k, i) => angle(quat(rot[i][1]), quat(k[1])) < 90));
    await ok('undo');
    const after = await keysOf((await camTracks()).rot);
    check('undo puts back the camera keys as they were', after.length === 1 && near(after[0][0], 1.5), after.map((k) => k[0]).join());
  });

  // the camera's route in Studio's view: a handle on each key; drag one to put the camera elsewhere at that moment
  if (t.hello.commands.includes('scene.backups'))
    await t.step('camera route: drag a key in Studio’s view, one undo', async () => {
      const sim = (a) => ok('gizmo.simulate', a);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const g0 = await ok('gizmo.get');
      t.defer(async () => {
        await sim({ end: true });
        await ok('gizmo.set', { overlays: { on: g0.overlays.on, cameraRoute: g0.overlays.cameraRoute ?? true } });
      });
      await ok('gizmo.set', { overlays: { on: true, cameraRoute: true } });
      await ok('timeline.seek', { t: 0 });
      // a dolly from 1 s to 2 s: seen from the playhead (the first key), the second key is straight ahead
      await ok('camera.move', { preset: 'dolly', amount: 0.5, duration: 1, t0: 1 });
      await ok('timeline.seek', { t: 0 });
      await sleep(400);
      let r = await sim({ cameraKeys: true });
      check('route and keys shown', r.shown && r.route > 8 && r.keys.length === 2, JSON.stringify({ shown: r.shown, route: r.route, keys: r.keys.length }));
      const k = r.keys[1];
      const k0 = r.keys[0];
      const at = [k.screen[0], k.screen[1]];
      check('the second key is on screen', k.screen[2] > 0 && at[0] > 50 && at[1] > 50, JSON.stringify(k.screen));
      await sim({ at });
      await sleep(150);
      const h = await sim({ at });
      check('hovering it: the camera key, and Studio’s camera held still', h.hover === 'CamKey' && h.cameraBlocked === true, JSON.stringify({ hover: h.hover, blocked: h.cameraBlocked }));
      await sim({ at, press: true });
      await sleep(150);
      for (let i = 1; i <= 6; i++) {
        await sim({ at: [at[0] + i * 12, at[1] + i * 4] });
        await sleep(60);
      }
      await sim({ release: true });
      await sleep(300);
      r = await sim({ cameraKeys: true });
      const k2 = r.keys[1];
      const moved = Math.hypot(k2.eye[0] - k.eye[0], k2.eye[1] - k.eye[1], k2.eye[2] - k.eye[2]);
      t.metric('camera moved', moved.toFixed(3), 'units');
      check('the camera at that key moved', moved > 0.01, String(moved));
      check('…still aimed at the same subject (pivot unchanged)', Math.hypot(k2.pivot[0] - k.pivot[0], k2.pivot[1] - k.pivot[1], k2.pivot[2] - k.pivot[2]) < 1e-4);
      check('the other key untouched', Math.hypot(r.keys[0].eye[0] - k0.eye[0], r.keys[0].eye[1] - k0.eye[1], r.keys[0].eye[2] - k0.eye[2]) < 1e-5);
      // the keyed values agree with the drawn handle: pivot + turn * distance = where the handle is
      const c = await camTracks();
      const rot = (await keysOf(c.rot)).find((x) => near(x[0], 2, 1e-3));
      const zoom = (await keysOf(c.zoom)).find((x) => near(x[0], 2, 1e-3));
      const pos = (await keysOf(c.pos)).find((x) => near(x[0], 2, 1e-3));
      const eye = camPos(v3(pos[1]), quat(rot[1]), zoom[1].value ?? zoom[1]);
      check('the keys say the camera stands where the handle was dropped', Math.hypot(eye[0] - k2.eye[0], eye[1] - k2.eye[1], eye[2] - k2.eye[2]) < 1e-3, JSON.stringify({ eye, k2: k2.eye }));
      await ok('undo');
      r = await sim({ cameraKeys: true });
      check('one undo puts the key back', Math.hypot(r.keys[1].eye[0] - k.eye[0], r.keys[1].eye[1] - k.eye[1], r.keys[1].eye[2] - k.eye[2]) < 1e-4, JSON.stringify(r.keys[1].eye));
      await ok('undo'); // the dolly
    });

  // Play the edit without "In Studio's view too": camera keys don't move Studio's view either (a free work camera),
  // the edit's camera is still worked out — for the monitor and the camera drawn in Studio's view
  if (t.hello.commands.includes('scene.backups'))
    await t.step('free work camera: camera keys play without moving Studio’s view', async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const look = () => ok('gizmo.simulate', { cameraKeys: true });
      const st0 = await ok('shots.state');
      t.defer(async () => {
        await ok('shots.setStudioEdit', { on: !!st0.studioEdit });
        await ok('shots.setLiveCuts', { on: !!st0.liveCuts });
        await ok('shots.set', { shots: st0.shots ?? [] });
      });
      const tl = await ok('timeline.get');
      await ok('shots.set', { shots: [{ id: 'fv', name: 'Keys', start: 0, end: tl.duration, camMode: 'still' }] });
      await ok('camera.move', { preset: 'dolly', amount: 0.5, duration: 1, t0: 0.5 });
      await ok('shots.setLiveCuts', { on: true });
      await ok('shots.setStudioEdit', { on: false });
      await ok('timeline.seek', { t: 0.5 });
      await sleep(300);
      const a = await look();
      await ok('timeline.seek', { t: 1.5 });
      await sleep(300);
      const b = await look();
      const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      check('free while Play the edit is on and Studio’s view is yours', a.free === true && b.free === true, JSON.stringify([a.free, b.free]));
      check('Studio’s view stays put across the camera keys', d(a.view, b.view) < 1e-4, `${d(a.view, b.view).toFixed(5)} m`);
      check('the edit’s camera still follows the keys (dollies in)', a.edit && b.edit && d(a.edit.eye, b.edit.eye) > 0.05, JSON.stringify([a.edit?.eye, b.edit?.eye]));
      check('…ending where the keys say', d(b.edit.eye, b.keys[1].eye) < 1e-3, JSON.stringify([b.edit.eye, b.keys[1].eye]));
      await ok('timeline.play');
      await sleep(600);
      const c = await look();
      await ok('timeline.pause').catch(() => ok('timeline.stop'));
      check('playing: still Studio’s view untouched', d(c.view, b.view) < 1e-4, `${d(c.view, b.view).toFixed(5)} m`);
      // with "In Studio's view too", the keys drive Studio's view as before
      await ok('shots.setStudioEdit', { on: true });
      await ok('timeline.seek', { t: 0.5 });
      await sleep(300);
      const e = await look();
      check('In Studio’s view too: Studio’s view is the keyed camera again', !e.free && d(e.view, a.edit.eye) < 1e-3, JSON.stringify([e.view, a.edit.eye]));
      await ok('undo'); // the dolly
    });

  await t.step('dolly and zoom', async () => {
    await ok('camera.move', { preset: 'dolly', amount: 0.5, duration: 1, t0: 0.5 });
    let c = await camTracks();
    const z = (await keysOf(c.zoom)).filter((k) => k[0] >= 0.5 - 1e-3);
    check('dolly in halves the distance', near(z[z.length - 1][1].value / z[0][1].value, 0.5, 1e-3), `${z[0][1].value} → ${z[z.length - 1][1].value}`);
    await ok('undo');
    await ok('camera.move', { preset: 'zoom', amount: 1.5, duration: 1, t0: 0.5 });
    c = await camTracks();
    const f = (await keysOf(c.fov)).filter((k) => k[0] >= 0.5 - 1e-3);
    check('zoom out widens the lens 1.5×', near(f[f.length - 1][1].value / f[0][1].value, 1.5, 1e-3));
    await ok('undo');
  });

  await t.step('pan keeps the camera in place, crane rises', async () => {
    await ok('camera.move', { preset: 'pan', amount: 30, duration: 1, t0: 0.5 });
    let c = await camTracks();
    const [p, r, z] = [await keysOf(c.pos), await keysOf(c.rot), await keysOf(c.zoom)];
    const at = (rows, tt) => rows.find((k) => near(k[0], tt, 1e-3))[1];
    const a0 = camPos(v3(at(p, 0.5)), quat(at(r, 0.5)), at(z, 0.5).value),
      a1 = camPos(v3(at(p, 1.5)), quat(at(r, 1.5)), at(z, 1.5).value);
    check('pan: camera position unchanged', Math.hypot(a0[0] - a1[0], a0[1] - a1[1], a0[2] - a1[2]) < 1e-3, JSON.stringify([a0, a1]));
    check('pan: turned 30°', near(angle(quat(at(r, 0.5)), quat(at(r, 1.5))), 30, 0.5));
    await ok('undo');
    await ok('camera.move', { preset: 'crane', amount: 0.5, duration: 1, t0: 0.5 });
    c = await camTracks();
    const [p2, r2, z2] = [await keysOf(c.pos), await keysOf(c.rot), await keysOf(c.zoom)];
    const b0 = camPos(v3(at(p2, 0.5)), quat(at(r2, 0.5)), at(z2, 0.5).value),
      b1 = camPos(v3(at(p2, 1.5)), quat(at(r2, 1.5)), at(z2, 1.5).value);
    check('crane: rises by half the camera distance', near(b1[1] - b0[1], 0.5 * Math.abs(at(z2, 0.5).value), 1e-3), `${b0[1]} → ${b1[1]}`);
    await ok('undo');
    await ok('camera.move', { preset: 'truck', amount: 0.5, duration: 1, t0: 0.5 });
    c = await camTracks();
    const r3 = await keysOf(c.rot);
    check('truck: same direction throughout', near(angle(quat(r3[0][1]), quat(r3[r3.length - 1][1])), 0, 0.1));
    await ok('undo');
  });

  await t.step('moves chain: the next starts where the last ended', async () => {
    await ok('timeline.seek', { t: 0 });
    await t.sleep(600);
    await ok('camera.move', { preset: 'orbit', amount: 90, duration: 2, t0: 0 });
    await ok('camera.move', { preset: 'dolly', amount: 0.6, duration: 1, t0: 2 });
    const c = await camTracks();
    const rot = await keysOf(c.rot);
    const at = (tt) => quat(rot.find((k) => near(k[0], tt, 1e-3))[1]);
    check('orbit end kept (90° at 2 s)', near(angle(at(0), at(2)), 90, 0.5), String(angle(at(0), at(2))));
    check('dolly keeps that direction to 3 s', near(angle(at(2), at(3)), 0, 0.1));
    await ok('undo');
    await ok('undo');
  });

  await t.step('refusals', async () => {
    const dur = (await ok('timeline.state')).duration;
    const past = await req('camera.move', { preset: 'orbit', amount: 90, duration: 5, t0: dur - 1 });
    check('a move past the end is refused', !past.ok, past.error);
    const bad = await req('camera.move', { preset: 'spin', amount: 1, duration: 1, t0: 0 });
    check('unknown move refused', !bad.ok);
  });
}

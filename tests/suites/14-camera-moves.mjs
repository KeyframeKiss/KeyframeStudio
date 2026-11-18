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

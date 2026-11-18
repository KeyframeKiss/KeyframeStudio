export const name = 'Camera tools: first person, follow (ours and RealPOV / LockOnPlugin), frame guides';

export default async function (t) {
  const { ok, req, check, sleep } = t;
  if (!t.hello.commands.includes('camtools.get')) t.skip('bridge without camera tools');
  const { chara } = await t.loadSample();
  t.defer(() => req('camtools.set', { pov: { on: false, useTheirs: true }, follow: { on: false, useTheirs: true }, guides: { thirds: false, center: false, safe: false, aspect: 0 } }));
  const st0 = await ok('camtools.get');

  await t.step('first person (ours)', async () => {
    let s = await ok('camtools.set', { pov: { useTheirs: false, on: true, id: chara.id, fov: 80 } });
    check('on, done by Keyframe Studio', s.pov.on && s.pov.provider === 'Keyframe Studio');
    await sleep(400);
    s = await ok('camtools.get');
    check('the camera is at the eyes', s.povDistance >= 0 && s.povDistance < 0.08, String(s.povDistance));
    const snap = await ok('camera.snapshot', { width: 200 });
    check('renders from there', typeof snap === 'string' && snap.length > 1000);
    s = await ok('camtools.set', { pov: { on: false } });
    check('off', !s.pov.on && s.povDistance === -1);
    check('unknown characters refused', !(await req('camtools.set', { pov: { on: true, id: 987654 } })).ok);
  });

  if (st0.pov.theirsInstalled)
    await t.step('first person (RealPOV)', async () => {
      let s = await ok('camtools.set', { pov: { useTheirs: true, on: true, id: chara.id } });
      check('RealPOV does it when installed', s.pov.on && s.pov.provider === 'RealPOV', JSON.stringify(s.pov));
      s = await ok('camtools.set', { pov: { on: false } });
      check('and lets go', !s.pov.on);
    });

  await t.step('follow (ours)', async () => {
    let s = await ok('camtools.set', { follow: { useTheirs: false, on: true, id: chara.id, bone: 'head', speed: 20 } });
    check('on, done by Keyframe Studio', s.follow.on && s.follow.provider === 'Keyframe Studio');
    const o = await ok('object.get', { id: chara.id });
    await ok('object.set', { ids: [chara.id], pos: [o.transform.pos[0] + 1.5, null, null] });
    t.defer(() => req('object.set', { ids: [chara.id], pos: o.transform.pos }));
    await sleep(1200);
    s = await ok('camtools.get');
    check('the view keeps the head centred after the character moves', s.followDistance >= 0 && s.followDistance < 0.05, String(s.followDistance));
    s = await ok('camtools.set', { follow: { bone: 'hips' } });
    await sleep(800);
    check('switching body part re-targets', s.follow.bone === 'hips' && (await ok('camtools.get')).followDistance < 0.05);
    check('first person and follow don’t fight', !(await ok('camtools.set', { pov: { useTheirs: false, on: true, id: chara.id } })).follow.on);
    await ok('camtools.set', { pov: { on: false } });
    await ok('undo'); // the object move
  });

  if (st0.follow.theirsInstalled)
    await t.step('follow (LockOnPlugin)', async () => {
      let s = await ok('camtools.set', { follow: { useTheirs: true, on: true, id: chara.id, bone: 'head' } });
      check('LockOnPlugin does it when installed', s.follow.on && s.follow.provider === 'LockOnPlugin', JSON.stringify(s.follow));
      s = await ok('camtools.set', { follow: { on: false } });
      check('and lets go', !s.follow.on);
    });

  await t.step('frame guides', async () => {
    const s = await ok('camtools.set', { guides: { thirds: true, center: true, safe: true, aspect: 9 / 16, dim: 0.5 } });
    check('set', s.guides.thirds && s.guides.center && s.guides.safe && Math.abs(s.guides.aspect - 0.5625) < 1e-3);
    const snap = await ok('camera.snapshot', { width: 200 });
    check('not in snapshots (screen overlay only)', typeof snap === 'string');
  });
}

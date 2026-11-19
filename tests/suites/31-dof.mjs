import fs from 'node:fs';

export const name = 'Depth of field: bokeh blur, focus on the view centre / a character’s eyes, tracks, stills';

export default async function (t) {
  const { ok, req, check, near, sleep } = t;
  if (!t.hello.commands.includes('fx.get')) t.skip('bridge without effects');
  const { chara } = await t.loadSample();
  t.defer(() => req('fx.reset'));
  const snap = async () => (await ok('camera.snapshot', { width: 480 })).length;

  await t.step('blur', async () => {
    const st = await ok('fx.get');
    check('depth of field is one of the effects, off', st.effects.dof && st.effects.dof.on === false);
    const sharp = await snap();
    // focus far behind everything: the whole picture goes soft (soft pictures make much smaller JPEGs)
    await ok('fx.set', { effect: 'dof', values: { on: true, autoFocus: 0, focus: 60, blur: 1, maxBlur: 0.04 } });
    await sleep(400);
    const soft = await snap();
    check('the picture really blurs', soft < sharp * 0.85, `${sharp} → ${soft}`);
    await ok('fx.set', { effect: 'dof', values: { maxBlur: 0.002 } });
    await sleep(300);
    check('a tiny blur is nearly sharp again', (await snap()) > soft * 1.1);
  });

  await t.step('auto focus', async () => {
    await ok('fx.set', { effect: 'dof', values: { autoFocus: 1, maxBlur: 0.02 } });
    await sleep(400);
    let st = await ok('fx.get');
    check('view centre: focusing at a sensible distance', st.focusNow > 0.2 && st.focusNow < 20 && near(st.effects.dof.focus, st.focusNow, 1e-3), String(st.focusNow));
    const centre = st.focusNow;
    await ok('fx.set', { effect: 'dof', values: { autoFocus: 2, chara: chara.id } });
    await sleep(400);
    st = await ok('fx.get');
    check('eyes: focusing on the character', st.focusNow > 0.1 && st.focusNow < 20, String(st.focusNow));
    const eyes = st.focusNow;
    const o = await ok('object.get', { id: chara.id });
    await ok('object.set', { ids: [chara.id], pos: [o.transform.pos[0], o.transform.pos[1] + 1.2, o.transform.pos[2]] });
    await sleep(500);
    st = await ok('fx.get');
    check('follows the eyes when the character moves', Math.abs(st.focusNow - eyes) > 0.02, `${eyes} → ${st.focusNow} (centre ${centre})`);
    await ok('undo');
  });

  if (t.hello.timeline)
    await t.step('animatable', async () => {
      const models = await ok('timeline.models', {});
      check('focus distance and blur are track types; choices are not', models.some((m) => m.id === 'fx.dof.focus') && models.some((m) => m.id === 'fx.dof.blur') && !models.some((m) => m.id === 'fx.dof.autoFocus'));
    });

  if (t.hello.commands.includes('still.capture'))
    await t.step('in stills', async () => {
      await ok('fx.set', { effect: 'dof', values: { autoFocus: 0, focus: 60, blur: 1, maxBlur: 0.03 } });
      const was = (await ok('still.status')).useScreencap;
      t.defer(() => req('still.set', { useScreencap: was }));
      await ok('still.set', { useScreencap: false });
      const r = await ok('still.capture', { width: 960, height: 540, supersample: 2 });
      check('a supersampled still with depth of field', fs.existsSync(r.path) && r.width === 960);
      fs.rmSync(r.path, { force: true });
    });
}

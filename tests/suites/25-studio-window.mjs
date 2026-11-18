export const name = "Clean Studio window: hide Studio's menus (built in or HideAllUI)";

export default async function (t) {
  const { ok, check, sleep } = t;
  if (!t.hello.commands.includes('ui.get')) t.skip('bridge without ui.get');
  const before = await ok('ui.get');
  t.defer(() => ok('ui.set', { clean: before.clean, timeline: before.timeline, handles: before.handles, useHideAllUi: before.useHideAllUi }));
  await ok('ui.set', { clean: false });

  await t.step('built in', async () => {
    const tlBefore = t.hello.timeline ? (await ok('timeline.state')).uiVisible : null;
    let s = await ok('ui.set', { useHideAllUi: false, timeline: true, handles: true, clean: true });
    check('hides Studio’s menus itself', s.clean && s.provider === 'Keyframe Studio' && s.hidden >= 3, JSON.stringify(s));
    s = await ok('ui.set', { handles: false, timeline: false });
    check('options apply while clean', s.clean && !s.handles && !s.timeline);
    if (t.hello.timeline) check('Timeline’s window hidden too', (await ok('timeline.state')).uiVisible === false);
    await sleep(1300); // the plugin sweeps for panels opened later once a second
    s = await ok('ui.set', { clean: false });
    check('everything comes back', !s.clean && s.hidden === 0, JSON.stringify(s));
    if (t.hello.timeline) check('Timeline’s window as it was (only what we hid comes back)', (await ok('timeline.state')).uiVisible === tlBefore);
    if (t.hello.timeline && !tlBefore) {
      // and an open Timeline window is closed while clean, then reopened
      await ok('timeline.setUiVisible', { visible: true });
      await ok('ui.set', { clean: true, timeline: false });
      const hid = (await ok('timeline.state')).uiVisible === false;
      await ok('ui.set', { clean: false });
      check('an open Timeline window is hidden and reopened', hid && (await ok('timeline.state')).uiVisible === true);
      await ok('timeline.setUiVisible', { visible: false });
    }
  });

  if (before.hideAllUi)
    await t.step('HideAllUI when installed', async () => {
      let s = await ok('ui.set', { useHideAllUi: true, clean: true, timeline: true, handles: true });
      check('HideAllUI does the hiding', s.provider === 'HideAllUI' && s.hidden === 1, JSON.stringify(s));
      s = await ok('ui.set', { useHideAllUi: false });
      check('switching to ours mid-way keeps it clean', s.clean && s.provider === 'Keyframe Studio' && s.hidden >= 3, JSON.stringify(s));
      s = await ok('ui.set', { clean: false, useHideAllUi: true });
      check('and shows everything again', !s.clean && s.hidden === 0, JSON.stringify(s));
    });
}

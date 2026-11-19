import { ALL_PARTS, applyTemplate, gatherTemplate } from '../../app/src/lib/templates.ts';

export const name = 'Production templates: save a scene\'s staging, apply it to another scene';

export default async function (t) {
  t.needs('timeline');
  const { ok, check, near, sleep, studio } = t;
  const req = (cmd, args) => studio.ok(cmd, args);
  await t.loadSample();
  t.defer(async () => {
    for (const p of (await ok('store.list', { kind: 'templates' })).filter((p) => p.name.startsWith('StudioEX Test'))) await ok('store.delete', { kind: 'templates', file: p.file });
  });

  // staging: timeline, two shots, a look tweak, render settings
  await ok('timeline.setSettings', { duration: 14, fps: 30 });
  await ok('shots.set', { shots: [
    { id: 'a', name: 'Opening', start: 0, end: 6 },
    { id: 'b', name: 'Close-up', start: 6, end: 14 },
  ] });
  await ok('look.set', { effects: { bloomIntensity: 1.7 } });
  const hasRender = (await t.req('render.status')).ok;
  if (hasRender) {
    const original = (await ok('render.status')).settings;
    t.defer(() => t.req('render.set', { fps: original.fps, format: original.format }));
  }
  if (hasRender) await ok('render.set', { fps: 30, format: 'WEBM' });

  const data = await gatherTemplate(req);
  check('gathered timeline, shots, look', near(data.timeline?.duration, 14) && data.timeline?.fps === 30 && data.shots?.length === 2 && near(data.look?.effects?.bloomIntensity, 1.7));
  check('render settings (when VideoExport is there)', !hasRender || data.render?.format === 'WEBM');
  const saved = await ok('store.save', { kind: 'templates', name: 'StudioEX Test Staging', data });
  const tpl = saved.find((p) => p.name === 'StudioEX Test Staging');
  check('stored', tpl && tpl.data.shots.length === 2);

  // a different scene: an empty one
  await ok('scene.new');
  await sleep(1500);
  await ok('timeline.setSettings', { duration: 5, fps: 60 });
  if (hasRender) await ok('render.set', { format: 'MP4' });
  const before = await ok('look.get');
  const { done, problems } = await applyTemplate(req, tpl.data, ALL_PARTS, []);
  const st = await ok('timeline.state');
  check('timeline length and frame rate', near(st.duration, 14) && st.fps === 30, JSON.stringify(st));
  check('shots', (await ok('shots.get')).map((s) => s.name).join() === 'Opening,Close-up');
  check('look', near((await ok('look.get')).effects.bloomIntensity, 1.7));
  check('render settings', !hasRender || (await ok('render.status')).settings.format === 'WEBM');
  check('reported what it did', done.includes('timeline') && done.includes('shots') && done.includes('look'), JSON.stringify({ done, problems }));
  await ok('undo'); // the look is undoable like any look change
  check('look change undoable', near((await ok('look.get')).effects.bloomIntensity, before.effects.bloomIntensity));
}

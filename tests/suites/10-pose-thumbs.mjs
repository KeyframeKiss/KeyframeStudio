export const name = 'Pose library thumbnails';

export default async function (t) {
  const { ok, check, studio } = t;
  const { chara } = await t.loadSample();
  const list = await ok('pose.list');
  const dats = list.filter((p) => !p.png);
  if (dats.length < 2) t.skip('needs at least two .dat poses');
  const pick = dats.slice(0, 2);
  const done = studio.waitFor('pose.thumbs', (d) => !d.running, 120000);
  const n = await ok('pose.thumbs', { id: chara.id, files: pick.map((p) => p.path), missingOnly: false });
  const job = await done;
  check('thumbnail job finished', job.done === n && n === 2, `${job.done}/${job.total}`);
  const after = await ok('pose.list');
  check('thumbnails listed', pick.every((p) => after.find((x) => x.path === p.path)?.thumb));
}

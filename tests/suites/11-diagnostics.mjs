export const name = 'Diagnostics and compatibility';

export default async function (t) {
  const { ok, req, check } = t;
  const d = await ok('diag.info');
  check('versions reported', !!d.plugin && !!d.bepinex && !!d.unity);
  check('installed plugins listed', d.plugins.length > 10 && d.plugins.every((p) => p.guid && p.version));
  check('paths reported', !!d.paths?.game && !!d.paths?.userData);
  const ids = d.features.map((f) => f.id);
  check('every feature reported', ['timeline', 'faceParts', 'faceShapes', 'abmx', 'materials', 'twoLut', 'translator'].every((x) => ids.includes(x)), ids.join(','));
  for (const f of d.features) {
    const installed = d.plugins.some((p) => p.guid === f.guid);
    check(`${f.id}: status matches what's installed`, installed ? f.status !== 'missing' : f.status === 'missing', `${f.status} ${f.reason ?? ''}`);
    if (f.status === 'off') t.say(`note: ${f.label} is off — ${f.reason}`);
  }
  const log = await ok('diag.log', { max: 50 });
  check('recent log available', Array.isArray(log));
  const hello = await ok('hello');
  check('hello carries features and paths', Array.isArray(hello.features) && !!hello.paths?.game);
  // a feature that's off answers with its reason (here: one that isn't installed, if any)
  const missing = d.features.find((f) => f.status === 'missing' && (f.id === 'abmx' || f.id === 'materials'));
  if (missing) {
    const r = await req(missing.id === 'abmx' ? 'abmx.get' : 'material.list', { id: 0, ids: [] });
    check('commands of a missing feature explain why', !r.ok && /not installed/.test(r.error));
  }
}

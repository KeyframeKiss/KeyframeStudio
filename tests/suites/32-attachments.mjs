export const name = 'Prop attachments with NodesConstraints';

export default async function (t) {
  if (!t.hello.commands.includes('attachment.get')) t.skip('bridge without attachments');
  t.needs('attachments');
  const { chara, items } = await t.loadSample();
  if (!chara) t.skip('sample needs a character');
  let item;
  for (const candidate of items) {
    if (!(await t.ok('attachment.get', { id: candidate.id })).links.length) {
      item = candidate;
      break;
    }
  }
  if (!item) t.skip('sample needs an unconstrained item');
  const id = item.id;
  const { instance } = await t.ok('attachment.get', { id });
  const args = { id, instance, parent: chara.id, bone: 'Right hand' };
  const before = (await t.ok('object.get', { id })).transform;
  t.check('self attachment rejected', !(await t.req('attachment.create', { ...args, parent: id, bone: '' })).ok);
  const created = await t.ok('attachment.create', args);
  const link = created.links[0];
  const edit = (action, value) => t.ok('attachment.edit', { id, instance, key: link.key, action, value });
  t.defer(() => t.req('attachment.edit', { id, instance, key: link.key, action: 'detach' }));
  t.check('attached to hand', link.managed && link.enabled && link.label.includes('Right hand'));
  await t.sleep(100);
  const after = (await t.ok('object.get', { id })).transform;
  t.check('kept initial position', before.pos.every((v, i) => Math.abs(v - after.pos[i]) < 0.002));
  t.check('duplicate rejected', !(await t.req('attachment.create', args)).ok);
  const offset = [0.1, 0.2, -0.3];
  const adjusted = await edit('position', offset);
  t.check('changed grip offset', adjusted.links[0].position.every((v, i) => Math.abs(v - offset[i]) < 0.001));
  t.check('paused', !(await edit('enabled', false)).links[0].enabled);
  t.check('resumed', (await edit('enabled', true)).links[0].enabled);
  t.check('detached', !(await edit('detach')).links.length);
}

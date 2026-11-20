export const name = 'Viewport overlays & handles: click a joint, turn it on the rings, move objects and IK targets, undo';

export default async function (t) {
  const { ok, check, sleep } = t;
  const { chara, items } = await t.loadSample();
  if (!chara) t.skip('the sample scene has no character');
  const id = chara.id;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // the mouse, fed to the plugin (Unity screen pixels, origin bottom-left); a frame or two between steps
  const sim = (a) => ok('gizmo.simulate', a);
  const frame = () => sleep(160);
  async function drag(points) {
    await sim({ at: points[0] });
    await frame();
    await sim({ at: points[0], press: true });
    await frame();
    for (const p of points.slice(1)) {
      await sim({ at: p });
      await sleep(70);
    }
    const mid = await sim({ at: points[points.length - 1] });
    await frame();
    await sim({ release: true });
    await frame();
    return mid;
  }
  async function click(p) {
    await sim({ at: p });
    await frame();
    const hover = await sim({ at: p });
    await sim({ press: true });
    await frame();
    await sim({ release: true });
    await frame();
    return hover;
  }
  t.defer(async () => {
    await sim({ end: true });
    await ok('gizmo.set', { overlays: { on: false }, gizmo: { on: false, world: false }, pick: { characters: true, items: true, lights: true, cameras: true } });
    await ok('gizmo.target', { kind: 'none' });
  });

  await t.step('switches', async () => {
    const st = await ok('gizmo.set', { overlays: { on: true, skeleton: true, ik: true }, gizmo: { on: true, world: false, mode: 1 }, pick: { characters: true } });
    check('overlays and handles on', st.overlays.on && st.overlays.skeleton && st.gizmo.on);
    check("Studio's rotate mode followed", st.gizmo.mode === 1);
  });

  let bone;
  await t.step('hover and click a joint', async () => {
    bone = await sim({ id, bone: 'cf_j_forearm01_L' });
    const [x, y, z] = bone.screen;
    const st = await sim({ at: [0, 0] });
    const [w, h] = st.screen;
    if (!(z > 0 && x > 20 && y > 20 && x < w - 20 && y < h - 20)) t.skip(`the left elbow isn't on screen in the sample's view (${x | 0}, ${y | 0})`);
    const hover = await click([x, y]);
    check('the joint lights up under the pointer', hover.hoverPick === `joint:${id}:${bone.index}`, hover.hoverPick);
    const after = await ok('gizmo.get');
    check('a click gives it the handles', after.target?.kind === 'bone' && after.target.index === bone.index && after.target.id === id, JSON.stringify(after.target));
    check('named like a person would', /forearm/i.test(after.target?.label ?? ''), after.target?.label);
  });

  await t.step('turn it on the view ring: FK takes over, one undo puts it back', async () => {
    const hand0 = (await sim({ id, bone: 'cf_j_hand_L' })).world;
    const st = await sim({ at: [0, 0] });
    const [cx, cy] = st.anchor.center;
    const R = 78 * 1.18;
    // a quarter turn, anticlockwise on screen
    const pts = [];
    for (let k = 0; k <= 9; k++) pts.push([cx + R * Math.cos((k * Math.PI) / 18), cy + R * Math.sin((k * Math.PI) / 18)]);
    await sim({ at: pts[0] });
    await frame();
    const over = await sim({ at: pts[0] });
    check('the view ring is under the pointer', over.hover === 'RingView', over.hover);
    const mid = await drag(pts);
    check('dragging', mid.dragging === true);
    const b = await sim({ id, bone: 'cf_j_forearm01_L' });
    const hand1 = (await sim({ id, bone: 'cf_j_hand_L' })).world;
    check('the forearm turned (the hand moved)', dist(hand0, hand1) > 0.03, `${dist(hand0, hand1).toFixed(3)} m`);
    check('the body part went to FK', b.fk && b.activeFK.some(Boolean), JSON.stringify(b.activeFK));
    check('the drag ended', (await ok('gizmo.get')).dragging === false);
    await ok('undo');
    await frame();
    const hand2 = (await sim({ id, bone: 'cf_j_hand_L' })).world;
    check('undo puts the pose back', dist(hand0, hand2) < 0.01, `${dist(hand0, hand2).toFixed(4)} m off`);
  });

  await t.step('type an angle', async () => {
    await ok('gizmo.target', { kind: 'bone', id, index: bone.index });
    const before = (await ok('gizmo.get')).target.rot;
    const r = await ok('gizmo.value', { rot: [before[0], before[1], (before[2] + 30) % 360] });
    check('the value is applied', Math.abs(((r.rot[2] - before[2] - 30 + 540) % 360) - 180) < 0.5, JSON.stringify(r.rot));
    await ok('undo');
    const back = (await ok('gizmo.get')).target.rot;
    check('and undone', Math.abs(((back[2] - before[2] + 540) % 360) - 180) < 0.5, JSON.stringify(back));
  });

  await t.step('drag an IK target', async () => {
    // a hand target: the one nearest the left hand
    const hand = (await sim({ id, bone: 'cf_j_hand_L' })).world;
    let best = null;
    for (let i = 0; i < 13; i++) {
      try {
        const k = await sim({ id, ik: i });
        if (!best || dist(k.world, hand) < dist(best.world, hand)) best = { ...k, i };
      } catch {
        break;
      }
    }
    if (!best) return check('IK targets found', false);
    // IK live for that limb (typing its own value takes it over), so its diamond wins over the hand joint under it
    await ok('gizmo.target', { kind: 'ik', id, index: best.i });
    await ok('gizmo.value', { pos: (await ok('gizmo.get')).target.pos });
    await frame();
    best = { ...(await sim({ id, ik: best.i })), i: best.i };
    check('typing a value turned IK on for the limb', best.ik && best.activeIK.some(Boolean), JSON.stringify(best.activeIK));
    const [x, y] = best.screen;
    const mid = await drag([[x, y], [x + 10, y], [x + 25, y + 10], [x + 40, y + 20]]);
    check('grabbed straight away', mid.target?.kind === 'ik' && mid.dragging, JSON.stringify(mid.target));
    const after = await sim({ id, ik: best.i });
    check('the target moved', dist(after.world, best.world) > 0.02, `${dist(after.world, best.world).toFixed(3)} m`);
    check('IK is on for that limb', after.ik && after.activeIK.some(Boolean), JSON.stringify(after.activeIK));
    await ok('undo');
    await frame();
    const back = await sim({ id, ik: best.i });
    check('undo puts it back', dist(back.world, best.world) < 0.01);
  });

  await t.step('object handles: move along an axis', async () => {
    const it = items[0];
    if (!it) return;
    await ok('scene.select', { ids: [it.id] });
    await ok('gizmo.set', { gizmo: { world: true, mode: 0 } });
    await frame();
    await frame();
    const st = await sim({ at: [0, 0] });
    check('the handles follow the selection', st.target?.kind === 'object' && st.target.id === it.id, JSON.stringify(st.target));
    if (!st.anchor) return check('handles on screen', false);
    const before = (await ok('object.get', { id: it.id })).transform.pos;
    const [cx, cy] = st.anchor.center;
    // the axis that looks longest from here (one pointing at the camera is too short to grab)
    const lens = st.anchor.ends.map(([ex, ey]) => Math.hypot(ex - cx, ey - cy));
    const ax = lens.indexOf(Math.max(...lens));
    const [ex, ey] = st.anchor.ends[ax];
    const dx = ex - cx;
    const dy = ey - cy;
    const p0 = [cx + dx * 0.6, cy + dy * 0.6];
    await sim({ at: p0 });
    await frame();
    const over = await sim({ at: p0 });
    const XYZ = 'XYZ'[ax];
    check(`the ${XYZ} arrow is under the pointer`, over.hover === `Axis${XYZ}`, over.hover);
    await drag([p0, [p0[0] + dx * 0.25, p0[1] + dy * 0.25], [p0[0] + dx * 0.5, p0[1] + dy * 0.5]]);
    const after = (await ok('object.get', { id: it.id })).transform.pos;
    check('it moved', dist(after, before) > 0.01, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    // along that arrow only: on screen the handles slid along its line (the item may hang off a turned parent,
    // so its own numbers can mix axes)
    const [nx, ny] = (await sim({ at: [0, 0] })).anchor.center;
    const len = Math.hypot(dx, dy);
    const along = ((nx - cx) * dx + (ny - cy) * dy) / len;
    const across = Math.abs((nx - cx) * dy - (ny - cy) * dx) / len;
    check(`along ${XYZ} only`, along > 5 && across < Math.max(1.5, along * 0.03), `${along.toFixed(1)} px along, ${across.toFixed(1)} px across`);
    await ok('undo');
    const back = (await ok('object.get', { id: it.id })).transform.pos;
    check('undo puts it back', dist(back, before) < 1e-3);
  });

  await t.step('click filters', async () => {
    await ok('scene.select', { ids: [id] });
    await frame();
    const b = await sim({ id, bone: 'cf_j_forearm01_L' });
    await ok('gizmo.set', { pick: { characters: false } });
    await sim({ at: b.screen });
    await frame();
    const off = await sim({ at: b.screen });
    check('joints ignored with Characters off', !String(off.hoverPick ?? '').startsWith('joint:'), off.hoverPick);
    await ok('gizmo.set', { pick: { characters: true }, overlays: { on: false } });
    await frame();
    const hidden = await sim({ at: b.screen });
    check('nothing to click with the overlays off', !String(hidden.hoverPick ?? '').startsWith('joint:'), hidden.hoverPick);
  });
}

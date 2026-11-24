import fs from 'node:fs';
import path from 'node:path';

export const name = 'Viewport overlays & handles: joints, rings, IK without jumps, accessories, focus point, guides, undo';

export default async function (t) {
  const { ok, check, sleep } = t;
  const { chara, items } = await t.loadSample();
  if (!chara) t.skip('the sample scene has no character');
  const id = chara.id;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // the mouse, fed to the plugin (Unity screen pixels, origin bottom-left); a frame or two between steps
  const sim = (a) => ok('gizmo.simulate', a);
  const frame = () => sleep(160);
  const hoverAt = async (p) => {
    await sim({ at: p });
    await frame();
    return sim({ at: p });
  };
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
    const hover = await hoverAt(p);
    await sim({ press: true });
    await frame();
    await sim({ release: true });
    await frame();
    return hover;
  }
  const fx0 = (await ok('fx.get')).effects.dof;
  t.defer(async () => {
    await sim({ end: true });
    await ok('gizmo.set', { overlays: { on: false }, gizmo: { on: false, world: false }, pick: { characters: true, accessories: true, items: true, lights: true, cameras: true } });
    await ok('gizmo.target', { kind: 'none' });
    await ok('fx.set', { effect: 'dof', values: { on: fx0.on, autoFocus: fx0.autoFocus, focus: fx0.focus } });
    await ok('camtools.set', { guides: { golden: false, diagonals: false, spiral: -1 } });
  });

  await t.step('switches', async () => {
    const st = await ok('gizmo.set', { overlays: { on: true, skeleton: true, ik: true, accessories: true, focus: true }, gizmo: { on: true, world: false, mode: 1 }, pick: { characters: true, accessories: true } });
    check('overlays and handles on', st.overlays.on && st.overlays.skeleton && st.overlays.accessories && st.gizmo.on);
    check("Studio's rotate mode followed", st.gizmo.mode === 1);
  });

  await t.step('idle IK targets are shown on their joints, not wherever they were last left', async () => {
    const all = [];
    for (let i = 0; i < 13; i++) {
      try {
        all.push(await sim({ id, ik: i }));
      } catch {
        break;
      }
    }
    const idle = all.filter((k, i) => !(k.ik && k.activeIK[[0, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1, 1][i]]));
    check('13 IK targets', all.length === 13, String(all.length));
    check('each idle one drawn on its bone', idle.length > 0 && idle.every((k) => k.boneWorld && dist(k.shownWorld, k.boneWorld) < 1e-4), `${idle.length} idle`);
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

  await t.step('turn it on the view ring: only its part goes to FK, steady, one undo', async () => {
    const before = await sim({ id, bone: 'cf_j_hand_L' });
    const foot0 = (await sim({ id, bone: 'cf_j_foot_R' })).world;
    const st = await sim({ at: [0, 0] });
    const [cx, cy] = st.anchor.center;
    const R = 78 * 1.18;
    const p0 = [cx + R, cy];
    const over = await hoverAt(p0);
    check('the view ring is under the pointer', over.hover === 'RingView', over.hover);
    check("Studio's camera holds still while the pointer is on a handle", over.cameraBlocked === true);
    // along the ring's tangent there (straight up at its right-hand side): a quarter of the ring's length ≈ a steady angle
    const pts = [p0];
    for (let k = 1; k <= 6; k++) pts.push([cx + R, cy + (k * R) / 6]);
    const mid = await drag(pts);
    check('dragging', mid.dragging === true);
    const b = await sim({ id, bone: 'cf_j_forearm01_L' });
    const hand1 = (await sim({ id, bone: 'cf_j_hand_L' })).world;
    check('the forearm turned (the hand moved)', dist(before.world, hand1) > 0.03, `${dist(before.world, hand1).toFixed(3)} m`);
    check('its part went to FK', b.fk && b.activeFK.some(Boolean), JSON.stringify(b.activeFK));
    check('nothing else moved (no jump)', dist(foot0, (await sim({ id, bone: 'cf_j_foot_R' })).world) < 0.02 && dist(before.hips, b.hips) < 0.02, `hips ${dist(before.hips, b.hips).toFixed(4)} m`);
    check('the drag ended', (await ok('gizmo.get')).dragging === false);
    await ok('undo');
    await frame();
    const back = await sim({ id, bone: 'cf_j_hand_L' });
    check('undo puts the pose back', dist(before.world, back.world) < 0.01, `${dist(before.world, back.world).toFixed(4)} m off`);
    check('…and the FK / IK state', back.fk === before.fk && back.ik === before.ik && JSON.stringify(back.activeFK) === JSON.stringify(before.activeFK), JSON.stringify([before.fk, back.fk, before.activeFK, back.activeFK]));
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

  let handIk;
  await t.step('IK on one limb: the rest of the body stays put', async () => {
    const hand = await sim({ id, bone: 'cf_j_hand_L' });
    const foot0 = (await sim({ id, bone: 'cf_j_foot_R' })).world;
    // Studio's IK targets in order: body, then left shoulder / elbow / hand, … — the left hand is 3
    // (an idle target can sit anywhere, so "the one nearest the hand" isn't a safe way to find it)
    try {
      handIk = { ...(await sim({ id, ik: 3 })), i: 3 };
    } catch {
      return check('IK targets found', false);
    }
    await ok('gizmo.target', { kind: 'ik', id, index: handIk.i });
    await ok('gizmo.value', { pos: (await ok('gizmo.get')).target.pos });
    await frame();
    const after = await sim({ id, ik: handIk.i });
    check('IK on for that limb only', after.ik && after.activeIK.filter(Boolean).length === 1, JSON.stringify(after.activeIK));
    check('FK stays on beside it', after.fk === hand.fk);
    // (Studio's IK solver lets a reaching arm tug the body a hair — a centimetre or so — as it does in Studio itself)
    const footMoved = dist(foot0, (await sim({ id, bone: 'cf_j_foot_R' })).world);
    check('the body didn’t jump', dist(after.hips, hand.hips) < 0.02 && footMoved < 0.02, `hips ${dist(after.hips, hand.hips).toFixed(4)} m, right foot ${footMoved.toFixed(4)} m`);
    const hand1 = await sim({ id, bone: 'cf_j_hand_L' });
    check('…nor the hand itself (its target starts where it is)', dist(hand1.world, hand.world) < 0.02 && dist(after.world, hand.world) < 0.02, `hand ${dist(hand1.world, hand.world).toFixed(4)} m, target ${dist(after.world, hand.world).toFixed(4)} m`);
    handIk = { ...after, i: handIk.i };
  });

  await t.step('wrist: joint in the middle, IK target on the ring around it, click again for the next', async () => {
    const hand = await sim({ id, bone: 'cf_j_hand_L' });
    const ikk = await sim({ id, ik: handIk.i });
    const [x, y] = ikk.screen;
    const gap = Math.hypot(hand.screen[0] - x, hand.screen[1] - y);
    if (gap > 12) return check(`(hand target ${gap.toFixed(1)} px off the wrist: not on the joint here)`, true);
    await ok('gizmo.target', { kind: 'none' });
    await ok('gizmo.set', { gizmo: { on: false } }); // no rings in the way for this step
    const P = [hand.screen[0], hand.screen[1]];
    // a quick look (before the fan opens)
    const quick = async (p) => {
      await sim({ at: p });
      await sleep(60);
      return sim({ at: p });
    };
    const centre = await quick(P);
    check('the middle is the wrist joint', centre.hoverPick === `joint:${id}:${hand.index}`, centre.hoverPick);
    check('with the IK target there too', centre.hoverAll.includes(`ik:${id}:${handIk.i}`), JSON.stringify(centre.hoverAll));
    const ring = await quick([P[0] + 10, P[1]]); // the ring is drawn around the joint
    check('the ring around it is the IK target', ring.hoverPick === `ik:${id}:${handIk.i}`, ring.hoverPick);

    // rest the pointer there: they fan out, left and right
    await sim({ at: P });
    await sleep(500);
    const fan = await sim({ at: P });
    const keys = (fan.spread ?? []).map((x) => x.key);
    check('resting on the overlap fans them out', keys.includes(`joint:${id}:${hand.index}`) && keys.includes(`ik:${id}:${handIk.i}`), JSON.stringify(fan.spread));
    check('each chip named', (fan.spread ?? []).every((x) => x.label && !x.label.includes(':')), (fan.spread ?? []).map((x) => x.label).join(', '));
    const chip = fan.spread?.find((x) => x.key === `ik:${id}:${handIk.i}`);
    if (!chip) return;
    const onChip = await quick(chip.at);
    check('hovering a chip picks it (and the camera holds still)', onChip.hoverPick === chip.key && onChip.cameraBlocked && onChip.spread, JSON.stringify([onChip.hoverPick, onChip.cameraBlocked]));
    await sim({ press: true });
    await frame();
    await sim({ release: true });
    await frame();
    const got = await ok('gizmo.get');
    check('clicking the chip selects that one', got.target?.kind === 'ik' && got.target.index === handIk.i, JSON.stringify(got.target));
    check('…and the fan folds away', !(await sim({ at: chip.at })).spread);

    // the old way still works for quick hands: click, then click the same spot again
    await sim({ at: [P[0] + 80, P[1] + 80] });
    await frame();
    await ok('gizmo.target', { kind: 'none' });
    await click(P);
    const first = (await ok('gizmo.get')).target?.kind;
    await click(P);
    const second = (await ok('gizmo.get')).target?.kind;
    check('quick clicks step through them', first !== second && [first, second].includes('ik'), JSON.stringify([first, second]));
    await ok('gizmo.set', { gizmo: { on: true, mode: 1 } });
  });

  await t.step('press-drag a chip: the IK target moves straight away', async () => {
    const hand = await sim({ id, bone: 'cf_j_hand_L' });
    await ok('gizmo.target', { kind: 'none' });
    await ok('gizmo.set', { gizmo: { on: true, mode: 0 } });
    const P = [hand.screen[0], hand.screen[1]];
    await sim({ at: P });
    await sleep(500);
    const fan = await sim({ at: P });
    const chip = fan.spread?.find((x) => x.key === `ik:${id}:${handIk.i}`);
    if (!chip) return check('fan opened with the IK target', false, JSON.stringify(fan.spread));
    const k0 = await sim({ id, ik: handIk.i });
    const [cx, cy] = chip.at;
    await drag([[cx, cy], [cx + 10, cy + 5], [cx + 30, cy + 15]]);
    const k1 = await sim({ id, ik: handIk.i });
    check('the IK target moved from its chip', dist(k1.world, k0.world) > 0.01, `${dist(k1.world, k0.world).toFixed(3)} m`);
    await ok('undo');
    await ok('gizmo.set', { gizmo: { mode: 1 } });
  });

  await t.step('drag an IK target', async () => {
    const best = await sim({ id, ik: handIk.i });
    await ok('gizmo.target', { kind: 'ik', id, index: handIk.i });
    await frame();
    const [x, y] = best.screen;
    const foot0 = (await sim({ id, bone: 'cf_j_foot_R' })).world;
    const mid = await drag([[x, y], [x + 10, y], [x + 25, y + 10], [x + 40, y + 20]]);
    check('grabbed straight away', mid.target?.kind === 'ik' && mid.dragging, JSON.stringify(mid.target));
    const after = await sim({ id, ik: handIk.i });
    check('the target moved', dist(after.world, best.world) > 0.02, `${dist(after.world, best.world).toFixed(3)} m`);
    check('the other foot stayed', dist(foot0, (await sim({ id, bone: 'cf_j_foot_R' })).world) < 0.01);
    await ok('undo');
    await frame();
    const back = await sim({ id, ik: handIk.i });
    check('undo puts it back', dist(back.world, best.world) < 0.01);
  });

  await t.step('object handles: the arrow follows the pointer exactly', async () => {
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
    const lens = st.anchor.ends.map(([ex, ey]) => Math.hypot(ex - cx, ey - cy));
    const ax = lens.indexOf(Math.max(...lens));
    const [ex, ey] = st.anchor.ends[ax];
    const dx = ex - cx;
    const dy = ey - cy;
    const p0 = [cx + dx * 0.6, cy + dy * 0.6];
    const XYZ = 'XYZ'[ax];
    const over = await hoverAt(p0);
    check(`the ${XYZ} arrow is under the pointer`, over.hover === `Axis${XYZ}`, over.hover);
    await drag([p0, [p0[0] + dx * 0.25, p0[1] + dy * 0.25], [p0[0] + dx * 0.5, p0[1] + dy * 0.5]]);
    const after = (await ok('object.get', { id: it.id })).transform.pos;
    check('it moved', dist(after, before) > 0.01, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    const [nx, ny] = (await sim({ at: [0, 0] })).anchor.center;
    const len = Math.hypot(dx, dy);
    const along = ((nx - cx) * dx + (ny - cy) * dy) / len;
    const across = Math.abs((nx - cx) * dy - (ny - cy) * dx) / len;
    check(`along ${XYZ} only`, across < Math.max(1.5, along * 0.03), `${along.toFixed(1)} px along, ${across.toFixed(1)} px across`);
    check('as far as the pointer went (no overshoot)', Math.abs(along - len * 0.5) < len * 0.12, `${along.toFixed(1)} px for a ${(len * 0.5).toFixed(1)} px drag`);
    await ok('undo');
    const back = (await ok('object.get', { id: it.id })).transform.pos;
    check('undo puts it back', dist(back, before) < 1e-3);
  });

  await t.step('switch Move / Rotate / Scale right on the handles', async () => {
    const it = items[0];
    if (!it) return;
    await ok('scene.select', { ids: [it.id] });
    await ok('gizmo.set', { gizmo: { on: true, mode: 0, world: false } });
    await frame();
    await frame();
    const a = (await sim({ at: [0, 0] })).anchor;
    if (!a) return check('handles on screen', false);
    const C = [a.center[0], a.center[1]];
    const pos0 = (await ok('object.get', { id: it.id })).transform.pos;
    await click(C);
    const g1 = await ok('gizmo.get');
    check('a click on the middle: Move → Rotate', g1.gizmo.mode === 1, `mode ${g1.gizmo.mode}`);
    check('…and nothing moved', dist((await ok('object.get', { id: it.id })).transform.pos, pos0) < 1e-4);
    await sim({ at: C });
    await sleep(700);
    const st = await sim({ at: C });
    check('resting on the middle brings Move / Rotate / Scale chips', st.modeRing?.length === 3 && st.modeRing.some((x) => x.ok), JSON.stringify(st.modeRing?.map((x) => [x.name, x.ok])));
    const sc = st.modeRing?.find((x) => x.name === 'Scale' && x.ok) ?? st.modeRing?.find((x) => x.name === 'Move');
    if (!sc) return;
    await sim({ at: sc.at });
    await frame();
    const on = await sim({ at: sc.at });
    check('the camera holds still over a chip', on.cameraBlocked === true);
    await sim({ press: true });
    await frame();
    await sim({ release: true });
    await frame();
    const g2 = await ok('gizmo.get');
    check(`picking ${sc.name} switches to it`, g2.gizmo.mode === sc.mode, `mode ${g2.gizmo.mode}`);
    check('…the chips fold away', !(await sim({ at: sc.at })).modeRing);
    check('…and still nothing moved', dist((await ok('object.get', { id: it.id })).transform.pos, pos0) < 1e-4);
    await sim({ at: [C[0] + 200, C[1] + 200] });
    await ok('gizmo.set', { gizmo: { mode: 0 } });
  });

  await t.step('accessories: click one, move it, undo', async () => {
    await ok('scene.select', { ids: [id] });
    await ok('gizmo.set', { gizmo: { mode: 0 } });
    await frame();
    const accs = await sim({ id, accessories: true });
    const st = await sim({ at: [0, 0] });
    const [w, h] = st.screen;
    const a = accs.find((x) => x.screen[2] > 0 && x.screen[0] > 60 && x.screen[1] > 60 && x.screen[0] < w - 60 && x.screen[1] < h - 60);
    if (!a) return check(`(no adjustable accessory on screen — ${accs.length} in all)`, true);
    check('accessories have names', accs.every((x) => typeof x.name === 'string' && x.name.length > 0), accs.map((x) => x.name).join(', '));
    await ok('gizmo.target', { kind: 'none' });
    // the click may land on a joint first; click again until the accessory has it
    for (let k = 0; k < 4 && (await ok('gizmo.get')).target?.kind !== 'accessory'; k++) await click([a.screen[0], a.screen[1]]);
    const t0 = (await ok('gizmo.get')).target;
    check('a click gives the accessory the handles', t0?.kind === 'accessory' && t0.index === a.slot, JSON.stringify(t0));
    if (t0?.kind !== 'accessory') return;
    const an = (await sim({ at: [0, 0] })).anchor;
    const [cx, cy] = an.center;
    await drag([[cx, cy], [cx + 10, cy + 5], [cx + 30, cy + 15]]);
    const t1 = (await ok('gizmo.get')).target;
    check('it moved (in its own adjustment)', dist(t1.pos, t0.pos) > 0.5 && dist(t1.world, t0.world) > 0.003, `${JSON.stringify(t0.pos)} → ${JSON.stringify(t1.pos)}`);
    await ok('undo');
    const t2 = (await ok('gizmo.get')).target;
    check('undo puts it back', dist(t2.pos, t0.pos) < 0.01 && dist(t2.world, t0.world) < 1e-3);
    const typed = await ok('gizmo.value', { rot: [t0.rot[0], (t0.rot[1] + 45) % 360, t0.rot[2]] });
    check('a typed turn', Math.abs(((typed.rot[1] - t0.rot[1] - 45 + 540) % 360) - 180) < 0.5, JSON.stringify(typed.rot));
    await ok('undo');
  });

  await t.step('focus point: drag it onto the hips, then the eyes', async () => {
    await ok('fx.set', { effect: 'dof', values: { on: true, autoFocus: 0, focus: 30 } });
    await frame();
    const f = await sim({ focus: true });
    check('the marker shows where it focuses', f.shown && f.ours && f.screen, JSON.stringify(f));
    const hips = await sim({ id, bone: 'cf_j_hips' });
    const head = await sim({ id, bone: 'cf_j_head' });
    const st = await sim({ at: [0, 0] });
    const [w, h] = st.screen;
    const onScreen = (p) => p && p[2] > 0 && p[0] > 20 && p[1] > 20 && p[0] < w - 20 && p[1] < h - 20;
    if (!onScreen(f.screen) || !onScreen(hips.screen) || !onScreen(head.screen)) return check('(marker, hips or head off screen)', true);
    const over = await hoverAt([f.screen[0], f.screen[1]]);
    check('the marker is grabbable', over.hover === 'Focus' && over.cameraBlocked, over.hover);
    const path = (a, b) => Array.from({ length: 6 }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / 5, a[1] + ((b[1] - a[1]) * k) / 5]);
    await drag(path(f.screen, [hips.screen[0] + 3, hips.screen[1]]));
    const g = await sim({ focus: true });
    check('focus moved to the hips’ distance (manual)', g.focus > 0.1 && g.focus < 29 && g.mode === 0, `${g.focus?.toFixed?.(2)} m, mode ${g.mode}`);
    check('the marker stays where it was dropped', Math.hypot(g.screen[0] - hips.screen[0], g.screen[1] - hips.screen[1]) < 12, JSON.stringify([g.screen, hips.screen]));
    await drag(path(g.screen, [head.screen[0], head.screen[1] + 4]));
    const e = await sim({ focus: true });
    check('dropped on the face: it follows the eyes', e.mode === 2, `mode ${e.mode}`);
  });

  await t.step('composition guides', async () => {
    const st = await ok('camtools.set', { guides: { golden: true, diagonals: true, spiral: 2 } });
    check('golden ratio, diagonals and a spiral', st.guides.golden && st.guides.diagonals && st.guides.spiral === 2, JSON.stringify(st.guides));
  });

  await t.step('animate a bone directly: the head’s rotation from the track list', async () => {
    const bones = await ok('timeline.bones', { oci: id });
    const head = bones.find((b) => b.kind === 'bone' && b.name === 'cf_j_head');
    check('bones listed, grouped', bones.length > 50 && head && head.group === 'Head & neck' && bones.some((b) => b.kind === 'ik' && b.group === 'IK targets'), `${bones.length} · head in ${head?.group}`);
    check('named like a person would', head?.label === 'Head', head?.label);
    const before = (await ok('timeline.get')).tracks?.length ?? 0;
    const trackId = await ok('timeline.addTrack', { owner: 'Timeline', model: 'guideObjectRot', oci: id, bone: head.index, keyAt: 0 });
    check('a track is made', typeof trackId === 'number');
    const tl = await ok('timeline.get');
    const tr = tl.tracks.find((x) => x.id === trackId);
    check('…on the head, with a key', tr && /cf_j_head/.test(tr.name ?? '') && (tr.keys?.length ?? tr.keyCount ?? 1) >= 1, JSON.stringify(tr && { name: tr.name, keys: tr.keys?.length }));
    const h = await sim({ id, bone: 'cf_j_head' });
    check('the head’s part is in FK (so the track drives it)', h.fk && h.activeFK.some(Boolean), JSON.stringify(h.activeFK));
    const again = await ok('timeline.bones', { oci: id });
    check('the list shows it animated', again.find((b) => b.kind === 'bone' && b.index === head.index)?.animated.includes('rot'));
    await ok('undo');
    const after = (await ok('timeline.get')).tracks?.length ?? 0;
    check('undo removes the track', after === before, `${before} → ${after}`);
  });

  await t.step('click filters', async () => {
    await ok('scene.select', { ids: [id] });
    await frame();
    const b = await sim({ id, bone: 'cf_j_forearm01_L' });
    await ok('gizmo.set', { pick: { characters: false } });
    const off = await hoverAt(b.screen);
    check('joints ignored with Characters off', !String(off.hoverPick ?? '').startsWith('joint:'), off.hoverPick);
    await ok('gizmo.set', { pick: { characters: true }, overlays: { on: false } });
    await frame();
    const hidden = await sim({ at: b.screen });
    check('nothing to click with the overlays off', !String(hidden.hoverPick ?? '').startsWith('joint:'), hidden.hoverPick);
  });

  await t.step('FK on the body and an IK arm together: the hand follows its target, and it survives save + load', async () => {
    // FK first (a small turn of the spine), the way people pose
    const spine = await sim({ id, bone: 'cf_j_spine02' });
    await ok('gizmo.target', { kind: 'bone', id, index: spine.index });
    const r = (await ok('gizmo.get')).target.rot;
    await ok('gizmo.value', { rot: [r[0], r[1], r[2] + 2] });
    await frame();
    const h0 = await sim({ id, bone: 'cf_j_hand_L' });
    check('FK is on for the body', h0.fk && h0.activeFK.some(Boolean), JSON.stringify(h0.activeFK));
    await ok('gizmo.target', { kind: 'ik', id, index: 3 });
    const tg = (await ok('gizmo.get')).target;
    await ok('gizmo.value', { pos: [tg.pos[0] + 0.12, tg.pos[1], tg.pos[2]] });
    await sleep(400);
    const h1 = await sim({ id, bone: 'cf_j_hand_L' });
    check('the hand follows its IK target (FK lets go of that arm)', dist(h1.world, h0.world) > 0.06, `${dist(h1.world, h0.world).toFixed(3)} m`);
    check('FK and IK both on', h1.fk && h1.ik, JSON.stringify([h1.fk, h1.ik]));
    // relative to the hips: the sample's idle animation moves the whole body around
    const rel = (b) => [b.world[0] - b.hips[0], b.world[1] - b.hips[1], b.world[2] - b.hips[2]];
    const other = rel(await sim({ id, bone: 'cf_j_hand_R' }));

    const sceneDir = path.join(t.paths.userData, 'studio', 'scene');
    const before = new Set(fs.readdirSync(sceneDir));
    await ok('scene.save');
    let added = [];
    for (let i = 0; i < 20 && !added.length; i++) {
      await sleep(500);
      added = fs.readdirSync(sceneDir).filter((f) => !before.has(f));
    }
    t.defer(() => {
      for (const f of added) if (/^\d{4}_\d{4}_\d{4}_\d{2}_\d{3}\.png$/.test(f) && fs.existsSync(path.join(sceneDir, f))) fs.unlinkSync(path.join(sceneDir, f));
    });
    if (added.length !== 1) return check('scene saved', false);
    await ok('scene.load', { path: path.join(sceneDir, added[0]) });
    let ch2;
    for (let i = 0; i < 40 && !ch2; i++) {
      await sleep(700);
      ch2 = (await ok('scene.get')).nodes.find((n) => n.type === 'Char');
    }
    await sleep(3000); // other plugins finish loading, then the bridge puts the saved FK parts back
    const l = await sim({ id: ch2.id, bone: 'cf_j_hand_L' });
    check('reloaded with FK and IK both on', l.fk && l.ik, JSON.stringify([l.fk, l.ik]));
    check('…the IK arm where it was', dist(rel(l), rel(h1)) < 0.02, `${dist(rel(l), rel(h1)).toFixed(3)} m`);
    const o2 = rel(await sim({ id: ch2.id, bone: 'cf_j_hand_R' }));
    check('…and the FK arm too', dist(o2, other) < 0.02, `${dist(o2, other).toFixed(3)} m`);
  });
}

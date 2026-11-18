import fs from 'node:fs';

export const name = 'Material Editor: parts, values, textures, shader, copy/paste, animate';

export default async function (t) {
  const { ok, req, check, near } = t;
  if (!t.has('materials')) t.skip('KK_MaterialEditor is not installed');
  const { chara, items } = await t.loadSample();

  const tree = await ok('me.tree', { id: chara.id });
  const mats = [];
  for (const p of tree.parts) for (const r of p.renderers) for (const m of r.materials) mats.push({ id: chara.id, part: p.key, renderer: r.name, material: m.name, shader: m.shader });
  const read = (tg) => ok('me.material', tg);

  await t.step('tree', async () => {
    check('parts → renderers → materials', tree.kind === 'Char' && tree.parts.length > 1 && mats.length > 3, `${tree.parts.length} parts, ${mats.length} materials`);
    check('the body comes first, then clothes / hair / accessories', tree.parts[0].key === 'Character:0' && tree.parts.slice(1).every((p) => /^(Clothing|Hair|Accessory):\d+$/.test(p.key)));
    const body = tree.parts[0].renderers.map((r) => r.name);
    const rest = new Set(tree.parts.slice(1).flatMap((p) => p.renderers.map((r) => r.name)));
    check('body renderers exclude the clothes and hair under it', body.length > 0 && !body.some((n) => rest.has(n)), body.filter((n) => rest.has(n)).join(', '));
    check('unknown objects are refused', !(await req('me.tree', { id: 987654 })).ok);
  });

  // a material with a float, a color and a texture
  let tg, m;
  for (const x of mats) {
    const mm = await read(x);
    if (mm.floats.length && mm.colors.length && mm.textures.some((tx) => tx.has)) {
      tg = { id: x.id, part: x.part, renderer: x.renderer, material: x.material };
      m = mm;
      break;
    }
  }
  if (!tg) t.skip('no material with floats, colors and a texture on the sample character');
  t.defer(async () => {
    for (const [kind, prop] of [['float', m.floats[0].name], ['color', m.colors[0].name], ['queue', ''], ['shader', ''], ['enabled', ''], ['shadowCasting', '']]) await req('me.reset', { ...tg, kind, prop });
    const tex = m.textures.find((x) => x.has);
    for (const kind of ['texture', 'offset', 'scale']) await req('me.reset', { ...tg, kind, prop: tex.name });
  });

  await t.step('values', async () => {
    const f = m.floats[0];
    const target = f.value + 0.25;
    let after = await ok('me.set', { ...tg, kind: 'float', prop: f.name, value: target });
    const fa = after.floats.find((x) => x.name === f.name);
    check('float set through MaterialEditor', near(fa.value, target) && fa.edited);
    await ok('undo');
    after = await read(tg);
    const fu = after.floats.find((x) => x.name === f.name);
    check('undo puts it back (not edited any more)', near(fu.value, f.value) && !fu.edited);

    const c = m.colors[0];
    const col = [0.2, 0.6, 0.3, c.value[3]];
    after = await ok('me.set', { ...tg, kind: 'color', prop: c.name, value: col });
    const ca = after.colors.find((x) => x.name === c.name);
    check('color set', ca.edited && ca.value.slice(0, 3).every((v, i) => near(v, col[i])));
    after = await ok('me.reset', { ...tg, kind: 'color', prop: c.name });
    const cr = after.colors.find((x) => x.name === c.name);
    check('color reset', !cr.edited && cr.value.every((v, i) => near(v, c.value[i])));
  });

  await t.step('renderer switches', async () => {
    await ok('me.set', { ...tg, kind: 'enabled', value: false });
    let r = (await read(tg)).renderer;
    const tr = await ok('me.tree', { id: chara.id });
    const inTree = tr.parts.find((p) => p.key === tg.part).renderers.find((x) => x.name === tg.renderer);
    check('hide a renderer', !r.enabled && r.enabledEdited && inTree.enabled === false);
    await ok('me.set', { ...tg, kind: 'shadowCasting', value: 'TwoSided' });
    r = (await read(tg)).renderer;
    check('shadow casting mode', r.shadowCasting === 'TwoSided' && r.shadowCastingEdited);
    await ok('me.reset', { ...tg, kind: 'enabled' });
    await ok('me.reset', { ...tg, kind: 'shadowCasting' });
    r = (await read(tg)).renderer;
    check('renderer reset', r.enabled === m.renderer.enabled && r.shadowCasting === m.renderer.shadowCasting && !r.enabledEdited);
  });

  await t.step('textures', async () => {
    const tex = m.textures.find((x) => x.has);
    check('texture thumbnail', typeof tex.thumb === 'string' && tex.thumb.startsWith('data:image/jpeg;base64,'));
    const ex = await ok('me.textureExport', { ...tg, prop: tex.name });
    check('export writes a PNG', fs.existsSync(ex.path) && fs.statSync(ex.path).size > 100, ex.path);
    let after = await ok('me.texture', { ...tg, prop: tex.name, path: ex.path });
    check('replace from an image file', after.textures.find((x) => x.name === tex.name).edited);
    check('non-images are refused', !(await req('me.texture', { ...tg, prop: tex.name, path: ex.path + '.txt' })).ok);
    after = await ok('me.reset', { ...tg, kind: 'texture', prop: tex.name });
    check('texture reset', !after.textures.find((x) => x.name === tex.name).edited);
    after = await ok('me.set', { ...tg, kind: 'scale', prop: tex.name, value: [2, 3] });
    let tt = after.textures.find((x) => x.name === tex.name);
    check('tiling', near(tt.scale[0], 2) && near(tt.scale[1], 3) && tt.scaleEdited);
    after = await ok('me.set', { ...tg, kind: 'offset', prop: tex.name, value: [0.25, 0.5] });
    tt = after.textures.find((x) => x.name === tex.name);
    check('offset', near(tt.offset[0], 0.25) && near(tt.offset[1], 0.5) && tt.offsetEdited);
    await ok('me.reset', { ...tg, kind: 'scale', prop: tex.name });
    after = await ok('me.reset', { ...tg, kind: 'offset', prop: tex.name });
    tt = after.textures.find((x) => x.name === tex.name);
    check('tiling / offset reset', !tt.scaleEdited && !tt.offsetEdited && near(tt.scale[0], tex.scale[0]) && near(tt.offset[0], tex.offset[0]));
    try {
      fs.unlinkSync(ex.path);
    } catch {
      /* gone */
    }
  });

  await t.step('shader and render queue', async () => {
    let after = await ok('me.set', { ...tg, kind: 'queue', value: 3100 });
    check('render queue', after.renderQueue === 3100 && after.renderQueueEdited);
    after = await ok('me.reset', { ...tg, kind: 'queue' });
    check('render queue reset', after.renderQueue === m.renderQueue && !after.renderQueueEdited);
    const shaders = await ok('me.shaders');
    check('MaterialEditor shader list', Array.isArray(shaders) && shaders.length > 3);
    const other = shaders.find((s) => s !== m.shader && /toon|main/i.test(s)) ?? shaders.find((s) => s !== m.shader);
    after = await ok('me.set', { ...tg, kind: 'shader', value: other });
    check('swap shader', after.shader === other && after.shaderEdited, other);
    after = await ok('me.reset', { ...tg, kind: 'shader' });
    check('shader reset', after.shader === m.shader && !after.shaderEdited);
    check('unknown shaders are refused', !(await req('me.set', { ...tg, kind: 'shader', value: 'No/Such Shader' })).ok);
  });

  await t.step('copy / paste', async () => {
    const f = m.floats[0];
    // another material with the same value to paste onto
    let dst;
    for (const x of mats) {
      if (x.material === tg.material) continue;
      const mm = await read(x);
      if (mm.floats.some((y) => y.name === f.name)) {
        dst = { id: x.id, part: x.part, renderer: x.renderer, material: x.material };
        break;
      }
    }
    if (!dst) return check('a second material to paste onto', false);
    t.defer(() => req('me.reset', { ...dst, kind: 'float', prop: f.name }));
    await ok('me.set', { ...tg, kind: 'float', prop: f.name, value: f.value + 0.5 });
    const copied = await ok('me.copy', tg);
    check('copy names the material', copied === tg.material);
    const after = await ok('me.paste', dst);
    const pf = after.floats.find((x) => x.name === f.name);
    check('paste copies the edits', near(pf.value, f.value + 0.5) && pf.edited);
    check('the clipboard shows', after.clipboard === tg.material);
    await ok('me.reset', { ...tg, kind: 'float', prop: f.name });
    await ok('me.reset', { ...dst, kind: 'float', prop: f.name });
  });

  if (t.hello.timeline)
    await t.step('animate', async () => {
      const f = m.floats[0];
      const track = await ok('me.animate', { ...tg, kind: 'float', prop: f.name });
      check('a MaterialEditor track is added', typeof track === 'number');
      const st = await ok('timeline.get');
      const tr = (st.tracks ?? []).find((x) => x.id === track);
      check('it is a MaterialEditor track on the character, keyed', !!tr && tr.oci === chara.id && /material/i.test(`${tr.owner} ${tr.model ?? ''} ${tr.name}`) && (tr.keys?.length ?? tr.keyCount ?? 1) >= 1, JSON.stringify(tr && { owner: tr.owner, name: tr.name, oci: tr.oci }));
      await ok('timeline.removeTracks', { tracks: [track] });
      const c = await ok('me.animate', { ...tg, kind: 'color', prop: m.colors[0].name });
      check('color track', typeof c === 'number' && c !== track);
      await ok('timeline.removeTracks', { tracks: [c] });
      check("keywords can't be animated", !(await req('me.animate', { ...tg, kind: 'keyword', prop: 'x' })).ok);
    });

  if (items?.length)
    await t.step('items', async () => {
      let it;
      for (const n of items) {
        const r = await req('me.tree', { id: n.id });
        if (r.ok && r.result.parts.length) {
          it = { n, tree: r.result };
          break;
        }
      }
      if (!it) return check('an item with materials', false);
      const p = it.tree.parts[0];
      const r = p.renderers[0];
      const tgi = { id: it.n.id, part: p.key, renderer: r.name, material: r.materials[0].name };
      const mi = await read(tgi);
      check('item tree + material', it.tree.kind === 'Item' && p.key === 'Item:0' && mi.material === tgi.material);
      if (mi.floats.length) {
        const f = mi.floats[0];
        const after = await ok('me.set', { ...tgi, kind: 'float', prop: f.name, value: f.value + 0.3 });
        check('item float set', near(after.floats.find((x) => x.name === f.name).value, f.value + 0.3));
        const back = await ok('me.reset', { ...tgi, kind: 'float', prop: f.name });
        check('item float reset', near(back.floats.find((x) => x.name === f.name).value, f.value));
      }
    });
}

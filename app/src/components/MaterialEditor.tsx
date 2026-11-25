import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { call, displayName, refreshTimeline, toast, useStore } from '../state/store';
import { Slider } from './CharacterPanel';
import { ColorInput, Switch } from './LookPanel';
import { Help } from './Help';
import { Icon } from './Icon';
import { BODY_GROUPS, type BodyGroup, materialName, partName, rendererName } from '../lib/kkNames';
import { TOPICS, isSwitch, nice, topicOf } from '../lib/materialProps';

// ---------------------------------------------------------------------------
// Look › Materials: MaterialEditor for the selected character or item. Parts → renderers → materials on the left,
// one material's values on the right. Every edit goes through KK_MaterialEditor, so it's saved with the scene.
// ---------------------------------------------------------------------------

type RGBA = [number, number, number, number];
type Vec2 = [number, number];

interface TreeMat {
  name: string;
  shader: string;
}
interface TreeRenderer {
  name: string;
  enabled: boolean;
  materials: TreeMat[];
}
interface TreePart {
  key: string;
  label: string;
  renderers: TreeRenderer[];
}
interface Tree {
  name: string;
  kind: 'Char' | 'Item';
  clipboard: string | null;
  parts: TreePart[];
}

interface FloatProp {
  name: string;
  value: number;
  edited: boolean;
  min?: number;
  max?: number;
}
interface ColorProp {
  name: string;
  value: RGBA;
  edited: boolean;
}
interface TexProp {
  name: string;
  has: boolean;
  size: string;
  thumb: string | null;
  offset: Vec2;
  scale: Vec2;
  edited: boolean;
  offsetEdited: boolean;
  scaleEdited: boolean;
}
interface KeywordProp {
  name: string;
  on: boolean;
  edited: boolean;
}
interface Mat {
  material: string;
  shader: string;
  shaderEdited: boolean;
  renderQueue: number;
  renderQueueEdited: boolean;
  floats: FloatProp[];
  colors: ColorProp[];
  textures: TexProp[];
  keywords: KeywordProp[];
  renderer: { enabled: boolean; shadowCasting: string; receiveShadows: boolean; enabledEdited: boolean; shadowCastingEdited: boolean; receiveShadowsEdited: boolean };
  clipboard: string | null;
}

/** The tree as shown: renderers with the same name merged (MaterialEditor addresses them by name anyway), empty ones
 * dropped, plain-English names added, and the body sorted into Eyes / Face / Mouth / Body / Hidden. */
interface ViewMat extends TreeMat {
  nice: string | null;
}
interface ViewRenderer {
  name: string;
  nice: string | null;
  group?: BodyGroup;
  enabled: boolean;
  materials: ViewMat[];
}
interface ViewPart {
  key: string;
  label: string;
  renderers: ViewRenderer[];
}

function tidy(t: Tree): ViewPart[] {
  return t.parts
    .map((p) => {
      const byName = new Map<string, ViewRenderer>();
      for (const r of p.renderers) {
        let v = byName.get(r.name);
        if (!v) {
          const f = rendererName(r.name, p.key);
          v = { name: r.name, nice: f.label, group: p.key.startsWith('Character') ? f.group : undefined, enabled: r.enabled, materials: [] };
          byName.set(r.name, v);
        } else v.enabled = v.enabled || r.enabled;
        for (const m of r.materials) if (!v.materials.some((x) => x.name === m.name)) v.materials.push({ ...m, nice: materialName(m.name) });
      }
      let renderers = [...byName.values()].filter((r) => r.materials.length > 0);
      if (p.key.startsWith('Character')) renderers = renderers.map((r, i) => ({ r, i })).sort((a, b) => BODY_GROUPS.indexOf(a.r.group ?? 'Body') - BODY_GROUPS.indexOf(b.r.group ?? 'Body') || a.i - b.i).map((x) => x.r);
      return { key: p.key, label: partName(p.label, p.key, renderers.map((r) => r.name)), renderers };
    })
    .filter((p) => p.renderers.length > 0);
}

/** What a material is called in the editor's heading: its own plain name, else its renderer's, else the raw name. */
export function materialTitle(sel: { part: string; renderer: string; material: string }) {
  return materialName(sel.material) ?? rendererName(sel.renderer, sel.part).label ?? sel.material;
}

interface Sel {
  part: string;
  renderer: string;
  material: string;
}

type Kind = 'float' | 'color' | 'keyword' | 'offset' | 'scale' | 'shader' | 'queue' | 'enabled' | 'shadowCasting' | 'receiveShadows' | 'texture';

const SHADOW_MODES = ['Off', 'On', 'TwoSided', 'ShadowsOnly'];
const SHADOW_LABELS: Record<string, string> = { Off: 'Off', On: 'On', TwoSided: 'Two-sided', ShadowsOnly: 'Shadow only' };

/** A group's state in a few words: how many switches are on, the colours as dots. */
function summaryOf(cs: ColorProp[], fs: FloatProp[]) {
  const sw = fs.filter(isSwitch);
  const on = sw.filter((x) => x.value >= 0.5).length;
  const parts: string[] = [];
  if (sw.length) parts.push(`${on} of ${sw.length} on`);
  const n = fs.length - sw.length;
  if (n) parts.push(`${n} value${n > 1 ? 's' : ''}`);
  if (cs.length) parts.push(`${cs.length} color${cs.length > 1 ? 's' : ''}`);
  return parts.join(', ');
}


/** The character / item the page edits: the first one selected in Studio. */
function useTarget() {
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  const id = selection.find((i) => nodes[i] && (nodes[i].type === 'Char' || nodes[i].type === 'Item'));
  return id === undefined ? null : { id, name: displayName(nodes[id]), others: selection.filter((i) => i !== id && nodes[i] && (nodes[i].type === 'Char' || nodes[i].type === 'Item')).length };
}

export function MaterialEditorPage() {
  const target = useTarget();
  const [tree, setTree] = useState<Tree | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Sel | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const id = target?.id;

  const loadTree = useCallback(() => {
    if (id === undefined) return;
    bridge
      .request<Tree>('me.tree', { id })
      .then((t) => {
        setErr('');
        setTree(t);
        // keep the selection if it's still there; otherwise the first material
        setSel((cur) => {
          const has = cur && t.parts.some((p) => p.key === cur.part && p.renderers.some((r) => r.name === cur.renderer && r.materials.some((m) => m.name === cur.material)));
          if (has) return cur;
          const p = tidy(t)[0];
          const r = p?.renderers[0];
          const m = r?.materials[0];
          return p && r && m ? { part: p.key, renderer: r.name, material: m.name } : null;
        });
      })
      .catch((e) => {
        setTree(null);
        setErr((e as Error).message);
      });
  }, [id]);

  useEffect(() => {
    setTree(null);
    setSel(null);
    setOpen({});
    loadTree();
  }, [id, loadTree]);
  // stuck on an error (e.g. MaterialEditor not ready right after a load): try again when the window comes back
  useEffect(() => {
    if (!err) return;
    window.addEventListener('focus', loadTree);
    return () => window.removeEventListener('focus', loadTree);
  }, [err, loadTree]);

  if (!target) return <Empty text="Select a character or an item in the scene to edit its materials." />;
  if (err) return <Empty text={err} onRetry={loadTree} />;
  if (!tree) return <Empty text="Reading materials…" />;

  const parts = tidy(tree);
  const q = query.trim().toLowerCase();
  const matches = (...xs: (string | null | undefined)[]) => !q || xs.some((s) => !!s && s.toLowerCase().includes(q));

  return (
    <div className="me">
      <aside className="me-tree">
        <div className="me-tree-head">
          <b title={tree.name}>{tree.name}</b>
          {target.others > 0 && <span className="me-muted" title="Materials are edited one object at a time — the first one selected">+{target.others} more selected</span>}
          <button className="btn icon" title="Read the materials again" onClick={loadTree}>
            <Icon name="redo" size={14} />
          </button>
        </div>
        <div className="me-search">
          <Icon name="search" size={13} />
          <input placeholder="Find: eyes, hair, cf_m_body, a shader…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="me-tree-list">
          {parts.map((p) => {
            const partHit = matches(p.label);
            const rs = p.renderers.filter((r) => partHit || matches(r.name, r.nice, r.group) || r.materials.some((m) => matches(m.name, m.nice, m.shader)));
            if (!rs.length) return null;
            const isOpen = q ? true : (open[p.key] ?? (p.key === sel?.part || parts.length <= 3));
            const count = p.renderers.reduce((n, r) => n + r.materials.length, 0);
            return (
              <div key={p.key} className="me-part">
                <button className="me-part-head" onClick={() => setOpen((o) => ({ ...o, [p.key]: !isOpen }))} title={p.label}>
                  <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                  <span>{p.label}</span>
                  <small>{count}</small>
                </button>
                {isOpen &&
                  rs.map((r, i) => {
                    const rHit = partHit || matches(r.name, r.nice, r.group);
                    const ms = r.materials.filter((m) => rHit || matches(m.name, m.nice, m.shader));
                    // one material on the renderer: one row, named in words; the raw names in the tooltip
                    const single = r.materials.length === 1 && ms.length === 1 ? ms[0] : null;
                    return (
                      <div key={r.name}>
                        {r.group && r.group !== rs[i - 1]?.group && (
                          <div className="me-group">
                            {r.group}
                            {r.group === 'Hidden' && <Help text="Parts the game normally doesn't show: the see-through silhouette used in H scenes and the invisible mesh that casts the body's shadow." />}
                          </div>
                        )}
                        <div className={`me-renderer ${r.enabled ? '' : 'hidden'} ${single ? 'single' : ''}`}>
                          {single ? (
                            <button
                              className={`me-mat ${sel?.part === p.key && sel.renderer === r.name && sel.material === single.name ? 'on' : ''}`}
                              onClick={() => setSel({ part: p.key, renderer: r.name, material: single.name })}
                              title={`${r.nice ?? single.nice ?? r.name}
Renderer ${r.name}${r.enabled ? '' : ' (hidden)'}
Material ${single.name}
${single.shader}`}
                            >
                              <span>
                                {!r.enabled && <Icon name="eyeOff" size={11} />} {r.nice ?? single.nice ?? r.name}
                              </span>
                              <small>{single.shader.replace(/^.*\//, '')}</small>
                            </button>
                          ) : (
                          <div className="me-renderer-name" title={`Renderer ${r.name}${r.enabled ? '' : ' (hidden)'}`}>
                            {!r.enabled && <Icon name="eyeOff" size={11} />}
                            {r.nice ? <b>{r.nice}</b> : <code className="raw">{r.name}</code>}
                          </div>
                          )}
                          {!single && ms
                            .map((m) => {
                              const on = sel?.part === p.key && sel.renderer === r.name && sel.material === m.name;
                              // the plain name only when it says more than the renderer's already does
                              const nice = m.nice && !r.nice?.startsWith(m.nice) ? m.nice : null;
                              return (
                                <button key={m.name} className={`me-mat ${on ? 'on' : ''}`} onClick={() => setSel({ part: p.key, renderer: r.name, material: m.name })} title={[m.nice, m.name, m.shader].filter(Boolean).join('\n')}>
                                  <span>{nice ?? (m.nice ? 'Main' : m.name)}</span>
                                  <small>{m.shader.replace(/^.*\//, '')}</small>
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    );
                  })}
              </div>
            );
          })}
          {parts.length === 0 && <div className="me-muted" style={{ padding: 12 }}>Nothing with materials here.</div>}
        </div>
      </aside>
      <section className="me-main">
        {sel && id !== undefined ? <MaterialView key={`${id}|${sel.part}|${sel.renderer}|${sel.material}`} id={id} sel={sel} onTreeChange={loadTree} /> : <Empty text="Pick a material on the left." />}
      </section>
    </div>
  );
}

function Empty({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="me-empty">
      <Icon name="look" size={22} />
      <span>{text}</span>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One material
// ---------------------------------------------------------------------------

function MaterialView({ id, sel, onTreeChange }: { id: number; sel: Sel; onTreeChange: () => void }) {
  const [mat, setMat] = useState<Mat | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [shaders, setShaders] = useState<string[]>([]);
  // which value groups are open: remembered across materials (Colors open to start)
  const [openTopics, setOpenTopics] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('kf.me.open') || '["Colors"]'));
    } catch {
      return new Set(['Colors']);
    }
  });
  const toggleTopic = (t: string, open: boolean) => {
    if (open === openTopics.has(t) || filter.trim() || changedOnly) return; // forced open while filtering: not a choice
    const next = new Set(openTopics);
    if (open) next.add(t);
    else next.delete(t);
    setOpenTopics(next);
    try {
      localStorage.setItem('kf.me.open', JSON.stringify([...next]));
    } catch {
      /* not remembered; fine */
    }
  };
  const target = useMemo(() => ({ id, ...sel }), [id, sel]);

  // live edits: one request per frame per value; replies are ignored while a drag is still sending
  const pending = useRef(new Map<string, { kind: Kind; prop: string; value: unknown }>());
  const inflight = useRef(0);
  const frame = useRef(0);

  const load = useCallback(() => {
    bridge
      .request<Mat>('me.material', target)
      .then((m) => {
        setErr('');
        setMat(m);
      })
      .catch((e) => setErr((e as Error).message));
  }, [target]);
  useEffect(load, [load]);
  // undo / redo and Studio-side changes: read again
  useEffect(() => {
    const h = () => load();
    window.addEventListener('kf:history', h);
    window.addEventListener('focus', h);
    return () => {
      window.removeEventListener('kf:history', h);
      window.removeEventListener('focus', h);
    };
  }, [load]);
  useEffect(() => {
    call<string[]>('me.shaders').then((s) => s && setShaders(s));
  }, []);

  const send = (cmd: string, args: Record<string, unknown>, after?: () => void) => {
    inflight.current++;
    return bridge
      .request<Mat | boolean>(cmd, { ...target, ...args })
      .then((m) => {
        inflight.current--;
        if (m && typeof m === 'object' && inflight.current === 0 && pending.current.size === 0) setMat(m);
        after?.();
        return m;
      })
      .catch((e) => {
        inflight.current--;
        toast((e as Error).message, 'error');
        load();
      });
  };

  const set = (kind: Kind, prop: string, value: unknown, patch: (m: Mat) => Mat) => {
    setMat((m) => m && patch(m));
    pending.current.set(`${kind}|${prop}`, { kind, prop, value });
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const batch = [...pending.current.values()];
      pending.current.clear();
      for (const b of batch) send('me.set', b, b.kind === 'enabled' ? onTreeChange : undefined);
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const reset = (kind: Kind, prop = '') => send('me.reset', { kind, prop }, kind === 'shader' || kind === 'enabled' ? onTreeChange : undefined);

  const animate = async (kind: Kind, prop = '') => {
    try {
      await bridge.request('me.animate', { ...target, kind, prop });
      await refreshTimeline();
      toast(`Track added and keyed at the playhead: ${nice(prop || kind)} on ${sel.material}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (err) return <Empty text={err} />;
  if (!mat) return <Empty text="Reading the material…" />;

  const f = filter.trim().toLowerCase();
  const show = (p: string, edited: boolean) => (!changedOnly || edited) && (!f || p.toLowerCase().includes(f) || nice(p).toLowerCase().includes(f));
  const colors = mat.colors.filter((c) => show(c.name, c.edited));
  const floats = mat.floats.filter((c) => show(c.name, c.edited));
  const textures = mat.textures.filter((c) => show(c.name, c.edited || c.offsetEdited || c.scaleEdited));
  const keywords = mat.keywords.filter((c) => show(c.name, c.edited));
  const edits = [mat.shaderEdited, mat.renderQueueEdited, ...mat.colors.map((c) => c.edited), ...mat.floats.map((c) => c.edited), ...mat.keywords.map((c) => c.edited), ...mat.textures.map((c) => c.edited || c.offsetEdited || c.scaleEdited)].filter(Boolean).length;
  const r = mat.renderer;

  const copy = async () => {
    const name = await call<string>('me.copy', target);
    if (name) {
      setMat((m) => m && { ...m, clipboard: name });
      toast(`Copied ${name}'s edits — paste them onto other materials`);
    }
  };

  return (
    <div className="me-view">
      <header className="me-head">
        <div className="me-title">
          <h2 title={mat.material}>{materialTitle(sel)}</h2>
          <span className="me-muted">
            <code>{mat.material}</code> on <code>{sel.renderer}</code>
            {edits > 0 && <em className="me-badge">{edits} edited</em>}
          </span>
        </div>
        <div className="me-head-actions">
          <button className="btn" onClick={copy} title="Copy this material's edits (MaterialEditor's clipboard)">
            Copy edits
          </button>
          <button className="btn" disabled={!mat.clipboard} onClick={() => send('me.paste', {}, onTreeChange)} title={mat.clipboard ? `Paste the edits copied from ${mat.clipboard}` : 'Copy a material’s edits first'}>
            Paste{mat.clipboard ? ` from ${mat.clipboard}` : ''}
          </button>
        </div>
      </header>

      <details className="me-group-box" open={mat.shaderEdited || mat.renderQueueEdited || r.enabledEdited || r.shadowCastingEdited || r.receiveShadowsEdited || undefined}>
        <summary>
          <b>Shader and drawing</b>
          <span className="me-sum">
            {mat.shader.replace(/^.*\//, '')} · queue {mat.renderQueue} · {r.enabled ? 'visible' : 'hidden'} · shadows {SHADOW_LABELS[r.shadowCasting]?.toLowerCase() ?? r.shadowCasting}
          </span>
          {(mat.shaderEdited || mat.renderQueueEdited || r.enabledEdited || r.shadowCastingEdited || r.receiveShadowsEdited) && <em className="me-badge">changed</em>}
        </summary>
      <div className="me-cards">
        <div className="look-card">
          <div className="look-card-head">
            <div>
              <b>
                Shader
                <Help text="Swapping the shader keeps the values both shaders share. Render queue decides drawing order: transparent things draw after opaque ones (2000 = opaque, 2450 = cut-out, 3000+ = transparent)." />
              </b>
            </div>
          </div>
          <div className="look-card-body">
            <div className="me-row">
              <label>Shader</label>
              <ShaderPicker value={mat.shader} shaders={shaders} onPick={(s) => send('me.set', { kind: 'shader', prop: '', value: s }, onTreeChange)} />
              <RowTools edited={mat.shaderEdited} onReset={() => reset('shader')} onAnimate={() => animate('shader')} />
            </div>
            <div className="me-row">
              <label>Render queue</label>
              <NumberBox value={mat.renderQueue} step={1} min={0} max={5000} onChange={(v) => set('queue', '', Math.round(v), (m) => ({ ...m, renderQueue: Math.round(v), renderQueueEdited: true }))} />
              <RowTools edited={mat.renderQueueEdited} onReset={() => reset('queue')} onAnimate={() => animate('queue')} />
            </div>
          </div>
        </div>

        <div className="look-card">
          <div className="look-card-head">
            <div>
              <b>
                Renderer
                <Help text={`Switches for the renderer “${sel.renderer}” — they apply to every material on it.`} />
              </b>
            </div>
          </div>
          <div className="look-card-body">
            <div className="me-row">
              <label>Visible</label>
              <span className="me-grow">
                <Switch on={r.enabled} onChange={(v) => set('enabled', '', v, (m) => ({ ...m, renderer: { ...m.renderer, enabled: v, enabledEdited: true } }))} />
              </span>
              <RowTools edited={r.enabledEdited} onReset={() => reset('enabled')} onAnimate={() => animate('enabled')} />
            </div>
            <div className="me-row">
              <label>Casts shadows</label>
              <select className="input me-grow" value={r.shadowCasting} onChange={(e) => set('shadowCasting', '', e.target.value, (m) => ({ ...m, renderer: { ...m.renderer, shadowCasting: e.target.value, shadowCastingEdited: true } }))}>
                {SHADOW_MODES.map((s) => (
                  <option key={s} value={s}>
                    {SHADOW_LABELS[s]}
                  </option>
                ))}
              </select>
              <RowTools edited={r.shadowCastingEdited} onReset={() => reset('shadowCasting')} onAnimate={() => animate('shadowCasting')} />
            </div>
            <div className="me-row">
              <label>Receives shadows</label>
              <span className="me-grow">
                <Switch on={r.receiveShadows} onChange={(v) => set('receiveShadows', '', v, (m) => ({ ...m, renderer: { ...m.renderer, receiveShadows: v, receiveShadowsEdited: true } }))} />
              </span>
              <RowTools edited={r.receiveShadowsEdited} onReset={() => reset('receiveShadows')} onAnimate={() => animate('receiveShadows')} />
            </div>
          </div>
        </div>
      </div>
      </details>

      <div className="me-filter-bar">
        <div className="me-filter">
          <Icon name="search" size={13} />
          <input placeholder={`Find a value (${mat.colors.length + mat.floats.length + mat.textures.length + mat.keywords.length})`} value={filter} onChange={(e) => setFilter(e.target.value)} />
          {f && (
            <button className="btn icon" title="Clear" onClick={() => setFilter('')}>
              ×
            </button>
          )}
        </div>
        <button className={`btn chip ${changedOnly ? 'on' : ''}`} aria-pressed={changedOnly} onClick={() => setChangedOnly(!changedOnly)} title="Only values changed from the material's own">
          Changed only
        </button>
      </div>

      {TOPICS.map((topic) => {
        const cs = colors.filter((c) => topicOf(c.name) === topic);
        const fs = floats.filter((x) => topicOf(x.name) === topic);
        const n = cs.length + fs.length;
        if (!n) return null;
        const changedN = cs.filter((c) => c.edited).length + fs.filter((x) => x.edited).length;
        const switches = fs.filter(isSwitch);
        const sliders = fs.filter((x) => !isSwitch(x));
        return (
          <details key={topic} className="me-group-box" open={!!f || changedOnly || openTopics.has(topic) || undefined} onToggle={(e) => toggleTopic(topic, (e.target as HTMLDetailsElement).open)}>
            <summary>
              <b>{topic}</b>
              <small>{n}</small>
              {changedN > 0 && <em className="me-badge">{changedN} changed</em>}
              <span className="me-sum">{summaryOf(cs, fs)}</span>
            </summary>
            <div className="me-section-body">
              {switches.length > 0 && (
                <div className="me-switches">
                  {switches.map((x) => (
                    <div key={x.name} className={`me-switch ${x.edited ? 'edited' : ''}`}>
                      <Switch on={x.value >= 0.5} onChange={(v) => set('float', x.name, v ? 1 : 0, (m) => ({ ...m, floats: m.floats.map((y) => (y.name === x.name ? { ...y, value: v ? 1 : 0, edited: true } : y)) }))} />
                      <span title={x.name}>{nice(x.name)}</span>
                      <RowTools edited={x.edited} onReset={() => reset('float', x.name)} onAnimate={() => animate('float', x.name)} />
                    </div>
                  ))}
                </div>
              )}
              {cs.map((c) => (
                <div key={c.name} className={`me-row ${c.edited ? 'edited' : ''}`}>
                  <label title={c.name}>{nice(c.name)}</label>
                  <span className="me-grow me-color">
                    <ColorInput value={c.value} onChange={(v) => set('color', c.name, v, (m) => ({ ...m, colors: m.colors.map((x) => (x.name === c.name ? { ...x, value: v, edited: true } : x)) }))} />
                    <span className="me-alpha" title="Alpha (opacity)">
                      <Slider
                        value={c.value[3] ?? 1}
                        min={0}
                        max={Math.max(1, Math.ceil(c.value[3] ?? 1))}
                        step={0.01}
                        onChange={(a) => {
                          const v: RGBA = [c.value[0], c.value[1], c.value[2], a];
                          set('color', c.name, v, (m) => ({ ...m, colors: m.colors.map((x) => (x.name === c.name ? { ...x, value: v, edited: true } : x)) }));
                        }}
                      />
                    </span>
                  </span>
                  <RowTools edited={c.edited} onReset={() => reset('color', c.name)} onAnimate={() => animate('color', c.name)} />
                </div>
              ))}
              {sliders.map((x) => (
                <FloatRow key={x.name} p={x} onChange={(v) => set('float', x.name, v, (m) => ({ ...m, floats: m.floats.map((y) => (y.name === x.name ? { ...y, value: v, edited: true } : y)) }))} onReset={() => reset('float', x.name)} onAnimate={() => animate('float', x.name)} />
              ))}
            </div>
          </details>
        );
      })}

      {textures.length > 0 && (
        <details className="me-group-box" open={!!f || changedOnly || openTopics.has('Textures') || undefined} onToggle={(e) => toggleTopic('Textures', (e.target as HTMLDetailsElement).open)}>
          <summary>
            <b>Textures</b>
            <small>{textures.length}</small>
            {textures.some((t) => t.edited || t.offsetEdited || t.scaleEdited) && <em className="me-badge">{textures.filter((t) => t.edited || t.offsetEdited || t.scaleEdited).length} changed</em>}
            <span className="me-sum">{textures.filter((t) => t.has).length} in use</span>
            <Help text="Replace a texture with a PNG or JPG — it's stored in the scene. Export saves the current one as a PNG (MaterialEditor's export folder). Tiling repeats it; offset slides it." />
          </summary>
          <div className="me-textures">
            {textures.map((t) => (
              <TextureTile
                key={t.name}
                t={t}
                onReplace={async () => {
                  const path = await window.studioEx?.openImage?.();
                  if (path) send('me.texture', { prop: t.name, path });
                }}
                onExport={async () => {
                  try {
                    const r = await bridge.request<{ path: string; folder: string }>('me.textureExport', { ...target, prop: t.name });
                    toast(`Exported ${r.path.replace(/^.*[\\/]/, '')}`);
                    window.studioEx?.openFolder?.(r.folder);
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
                onReset={() => reset('texture', t.name)}
                onVec={(kind, v) => set(kind, t.name, v, (m) => ({ ...m, textures: m.textures.map((x) => (x.name === t.name ? { ...x, [kind]: v, [`${kind}Edited`]: true } : x)) }))}
                onResetVec={(kind) => reset(kind, t.name)}
                onAnimate={(kind) => animate(kind, t.name)}
              />
            ))}
          </div>
        </details>
      )}

      {keywords.length > 0 && (
        <details className="me-group-box" open={!!f || changedOnly || openTopics.has('Features') || undefined} onToggle={(e) => toggleTopic('Features', (e.target as HTMLDetailsElement).open)}>
          <summary>
            <b>Shader features</b>
            <small>{keywords.length}</small>
            {keywords.some((k) => k.edited) && <em className="me-badge">{keywords.filter((k) => k.edited).length} changed</em>}
            <span className="me-sum">{keywords.filter((k) => k.on).length} on</span>
          </summary>
          <div className="me-switches">
            {keywords.map((k) => (
              <div key={k.name} className={`me-switch ${k.edited ? 'edited' : ''}`}>
                <Switch on={k.on} onChange={(v) => set('keyword', k.name, v, (m) => ({ ...m, keywords: m.keywords.map((x) => (x.name === k.name ? { ...x, on: v, edited: true } : x)) }))} />
                <span title={k.name}>{nice(k.name)}</span>
                <RowTools edited={k.edited} onReset={() => reset('keyword', k.name)} />
              </div>
            ))}
          </div>
        </details>
      )}

      {(f || changedOnly) && !colors.length && !floats.length && !textures.length && !keywords.length && <div className="me-muted" style={{ padding: '12px 4px' }}>{f ? `No value matches “${filter}”.` : 'Nothing changed on this material.'}</div>}
      {!f && !mat.colors.length && !mat.floats.length && !mat.textures.length && !mat.keywords.length && (
        <div className="me-muted" style={{ padding: '12px 4px' }}>
          MaterialEditor doesn't list any values for {mat.shader}.
        </div>
      )}
    </div>
  );
}

/** ↺ (only when edited) and ◆ (add as a Timeline track). Space is kept so rows line up. */
function RowTools({ edited, onReset, onAnimate }: { edited: boolean; onReset: () => void; onAnimate?: () => void }) {
  const hasTimeline = useStore((s) => !!s.tl);
  return (
    <span className="me-tools">
      <button className={`btn icon ${edited ? '' : 'me-invisible'}`} title="Back to the original value" onClick={onReset} tabIndex={edited ? 0 : -1}>
        <Icon name="undo" size={13} />
      </button>
      {onAnimate && hasTimeline ? (
        <button className="btn icon" title="Animate: add a Timeline track for this value, keyed at the playhead" onClick={onAnimate}>
          <Icon name="key" size={13} />
        </button>
      ) : (
        <span className="me-tool-gap" />
      )}
    </span>
  );
}

// slider range for values MaterialEditor gives no range for: fixed per name once seen, so it doesn't grow under the cursor
const ranges = new Map<string, [number, number]>();
function rangeFor(p: FloatProp): [number, number] {
  if (p.min !== undefined && p.max !== undefined && p.max > p.min) return [p.min, p.max];
  let r = ranges.get(p.name);
  if (!r) {
    const m = Math.max(1, Math.ceil(Math.abs(p.value) * 2));
    r = [p.value < 0 ? -m : 0, m];
    ranges.set(p.name, r);
  }
  return [Math.min(r[0], p.value), Math.max(r[1], p.value)];
}

function FloatRow({ p, onChange, onReset, onAnimate }: { p: FloatProp; onChange: (v: number) => void; onReset: () => void; onAnimate: () => void }) {
  const [lo, hi] = rangeFor(p);
  const step = hi - lo > 20 ? 1 : hi - lo > 2 ? 0.01 : 0.001;
  return (
    <div className={`me-row ${p.edited ? 'edited' : ''}`}>
      <label title={p.name}>{nice(p.name)}</label>
      <span className="me-grow me-float">
        <input type="range" min={lo} max={hi} step={step} value={p.value} onChange={(e) => onChange(Number(e.target.value))} />
        <NumberBox value={p.value} step={step} onChange={onChange} />
      </span>
      <RowTools edited={p.edited} onReset={onReset} onAnimate={onAnimate} />
    </div>
  );
}

/** A number field that only commits on Enter / blur (typing "0." shouldn't send 0). */
export function NumberBox({ value, step, min, max, onChange }: { value: number; step: number; min?: number; max?: number; onChange: (v: number) => void }) {
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4))));
  const [text, setText] = useState(fmt(value));
  const focused = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(value));
  }, [value]);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      setText(fmt(value));
      return;
    }
    const v = Number(text);
    // unchanged (or only re-typed the shown, rounded number): don't send, don't round the real value
    if (text.trim() === fmt(value) || (Number.isFinite(v) && v === value)) return;
    if (Number.isFinite(v)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
    else setText(fmt(value));
  };
  return (
    <input
      className="input mono me-num"
      type="number"
      step={step}
      value={text}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function ShaderPicker({ value, shaders, onPick }: { value: string; shaders: string[]; onPick: (s: string) => void }) {
  const list = shaders.includes(value) ? shaders : [value, ...shaders];
  return (
    <select className="input me-grow" value={value} onChange={(e) => onPick(e.target.value)} title={value}>
      {list.map((s) => (
        <option key={s} value={s} disabled={!shaders.includes(s)}>
          {s}
          {!shaders.includes(s) ? ' (built in)' : ''}
        </option>
      ))}
    </select>
  );
}

function TextureTile({
  t,
  onReplace,
  onExport,
  onReset,
  onVec,
  onResetVec,
  onAnimate,
}: {
  t: TexProp;
  onReplace: () => void;
  onExport: () => void;
  onReset: () => void;
  onVec: (kind: 'offset' | 'scale', v: Vec2) => void;
  onResetVec: (kind: 'offset' | 'scale') => void;
  onAnimate: (kind: 'offset' | 'scale' | 'texture') => void;
}) {
  const hasTimeline = useStore((s) => !!s.tl);
  return (
    <div className={`me-tex ${t.edited || t.offsetEdited || t.scaleEdited ? 'edited' : ''}`}>
      <div className="me-tex-top">
        <div className="me-tex-thumb" title={t.has ? `${t.name} · ${t.size}` : 'No texture'}>
          {t.thumb ? <img src={t.thumb} alt="" /> : <span>none</span>}
        </div>
        <div className="me-tex-info">
          <b title={t.name}>{nice(t.name)}</b>
          <span className="me-muted">{t.has ? t.size : 'empty'}</span>
          <div className="me-tex-btns">
            {window.studioEx?.openImage && (
              <button className="btn" onClick={onReplace} title="Use a PNG or JPG image instead">
                Replace…
              </button>
            )}
            <button className="btn" disabled={!t.has} onClick={onExport} title="Save this texture as a PNG">
              Export
            </button>
            {t.edited && (
              <button className="btn icon" onClick={onReset} title="Back to the original texture">
                <Icon name="undo" size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
      {(['scale', 'offset'] as const).map((kind) => {
        const v = t[kind];
        const edited = kind === 'scale' ? t.scaleEdited : t.offsetEdited;
        return (
          <div key={kind} className="me-vec">
            <label>{kind === 'scale' ? 'Tiling' : 'Offset'}</label>
            <NumberBox value={v[0]} step={0.01} onChange={(x) => onVec(kind, [x, v[1]])} />
            <NumberBox value={v[1]} step={0.01} onChange={(y) => onVec(kind, [v[0], y])} />
            <button className={`btn icon ${edited ? '' : 'me-invisible'}`} title="Back to the original" onClick={() => onResetVec(kind)} tabIndex={edited ? 0 : -1}>
              <Icon name="undo" size={13} />
            </button>
            {hasTimeline ? (
              <button className="btn icon" title="Animate: add a Timeline track, keyed at the playhead" onClick={() => onAnimate(kind)}>
                <Icon name="key" size={13} />
              </button>
            ) : (
              <span className="me-tool-gap" />
            )}
          </div>
        );
      })}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { call, displayName, toast, useStore } from '../state/store';
import { CollapsibleSection, Slider } from './CharacterPanel';
import { LookPresets } from './LookPresets';

type RGBA = [number, number, number, number];
type Named = { id: number; name: string; nameEn?: string | null };
interface Look {
  effects: {
    lut: number; lut2: number; lutBlend: number;
    ssao: boolean; ssaoColor: RGBA; ssaoRadius: number;
    bloom: boolean; bloomIntensity: number; bloomThreshold: number; bloomBlur: number;
    dof: boolean; dofFocal: number; dofAperture: number;
    vignette: boolean;
    fog: boolean; fogColor: RGBA; fogHeight: number; fogStart: number;
    sunShafts: boolean; sunColor: RGBA; sunThreshold: RGBA;
    shadow: boolean;
  };
  toon: { ramp: number; lineColor: number; lineWidth: number; ambientShadow: RGBA; ambientShadowG: number; faceNormal: boolean; faceShadow: boolean };
  lights: {
    charaColor: RGBA; charaIntensity: number; charaRot: [number, number]; charaShadow: boolean;
    mapColor: RGBA; mapIntensity: number; mapRot: [number, number]; mapShadow: boolean;
  };
  luts: Named[];
  ramps: Named[];
  twoLut: boolean;
  materialEditor: boolean;
}
export interface MatRule {
  shader: string;
  prop: string;
  type: 'float' | 'color';
  value: number | RGBA;
  parts?: string[];
}

const hex = (c: number[]) => '#' + c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (h: string, a = 1): RGBA => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a];

export function LookPanel({ showPresets = true }: { showPresets?: boolean }) {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  const [look, setLook] = useState<Look | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({ presets: true, grade: true, bloom: true, dof: false, ssao: false, vignette: false, fog: false, sun: false, toon: true, lights: true, materials: false });
  const tog = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  const load = useCallback(() => {
    call<Look>('look.get').then((l) => l && setLook(l));
  }, []);
  useEffect(() => {
    if (status !== 'open') return;
    load();
  }, [status, revision, load]);
  useEffect(() => {
    window.addEventListener('studioex:look-changed', load);
    return () => window.removeEventListener('studioex:look-changed', load);
  }, [load]);

  // rAF-coalesced patch sending (sliders fire continuously)
  const pending = useRef<Record<string, Record<string, unknown>>>({});
  const raf = useRef(0);
  const patch = (group: 'effects' | 'toon' | 'lights', values: Record<string, unknown>) => {
    setLook((l) => (l ? { ...l, [group]: { ...l[group], ...values } } : l));
    pending.current[group] = { ...(pending.current[group] ?? {}), ...values };
    if (raf.current) return;
    raf.current = requestAnimationFrame(async () => {
      raf.current = 0;
      const p = pending.current;
      pending.current = {};
      try {
        await bridge.request('look.set', p);
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    });
  };

  if (!look) return <div className="empty">Loading look…</div>;
  const e = look.effects;
  const t = look.toon;
  const l = look.lights;
  const lutName = (n: Named) => displayName({ name: n.name, nameEn: n.nameEn ?? undefined });

  return (
    <div className="panel-body">
      {showPresets && (
        <CollapsibleSection title="Looks" open={open.presets} onToggle={() => tog('presets')}>
          <LookPresets />
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Color grade" open={open.grade} onToggle={() => tog('grade')}>
        <div className="kv">
          <label>LUT</label>
          <select className="input" value={e.lut} onChange={(ev) => patch('effects', { lut: Number(ev.target.value) })}>
            {look.luts.map((x) => (
              <option key={x.id} value={x.id}>
                {lutName(x)}
              </option>
            ))}
          </select>
          {look.twoLut && (
            <>
              <label title="Second LUT (KK_TwoLut) — Blend fades from LUT to LUT 2">LUT 2</label>
              <select className="input" value={e.lut2} onChange={(ev) => patch('effects', { lut2: Number(ev.target.value) })}>
                {look.luts.map((x) => (
                  <option key={x.id} value={x.id}>
                    {lutName(x)}
                  </option>
                ))}
              </select>
            </>
          )}
          <label>Blend</label>
          <Slider value={e.lutBlend} min={0} max={1} step={0.01} onChange={(v) => patch('effects', { lutBlend: v })} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Bloom" open={open.bloom} onToggle={() => tog('bloom')} extra={<Switch on={e.bloom} onChange={(v) => patch('effects', { bloom: v })} />}>
        <div className="kv" style={{ opacity: e.bloom ? 1 : 0.5 }}>
          <label>Intensity</label>
          <Slider value={e.bloomIntensity} min={0} max={5} step={0.01} onChange={(v) => patch('effects', { bloomIntensity: v })} />
          <label>Threshold</label>
          <Slider value={e.bloomThreshold} min={0.5} max={1} step={0.01} onChange={(v) => patch('effects', { bloomThreshold: v })} />
          <label>Softness</label>
          <Slider value={e.bloomBlur} min={0.1} max={10} step={0.05} onChange={(v) => patch('effects', { bloomBlur: v })} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Depth of field" open={open.dof} onToggle={() => tog('dof')} extra={<Switch on={e.dof} onChange={(v) => patch('effects', { dof: v })} />}>
        <div className="kv" style={{ opacity: e.dof ? 1 : 0.5 }}>
          <label>Focal size</label>
          <Slider value={e.dofFocal} min={0} max={2} step={0.01} onChange={(v) => patch('effects', { dofFocal: v })} />
          <label>Aperture</label>
          <Slider value={e.dofAperture} min={0} max={1} step={0.01} onChange={(v) => patch('effects', { dofAperture: v })} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Ambient occlusion" open={open.ssao} onToggle={() => tog('ssao')} extra={<Switch on={e.ssao} onChange={(v) => patch('effects', { ssao: v })} />}>
        <div className="kv" style={{ opacity: e.ssao ? 1 : 0.5 }}>
          <label>Color</label>
          <ColorInput value={e.ssaoColor} onChange={(c) => patch('effects', { ssaoColor: c })} />
          <label>Radius</label>
          <Slider value={e.ssaoRadius} min={0} max={1} step={0.005} onChange={(v) => patch('effects', { ssaoRadius: v })} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Vignette" open={open.vignette} onToggle={() => tog('vignette')} extra={<Switch on={e.vignette} onChange={(v) => patch('effects', { vignette: v })} />}>
        <div className="hint" style={{ marginTop: 0 }}>
          Darkened corners. Studio exposes only on/off.
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Fog" open={open.fog} onToggle={() => tog('fog')} extra={<Switch on={e.fog} onChange={(v) => patch('effects', { fog: v })} />}>
        <div className="kv" style={{ opacity: e.fog ? 1 : 0.5 }}>
          <label>Color</label>
          <ColorInput value={e.fogColor} onChange={(c) => patch('effects', { fogColor: c })} />
          <label>Height</label>
          <Slider value={e.fogHeight} min={0} max={50} step={0.1} onChange={(v) => patch('effects', { fogHeight: v })} />
          <label>Start</label>
          <Slider value={e.fogStart} min={0} max={50} step={0.1} onChange={(v) => patch('effects', { fogStart: v })} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Sun shafts" open={open.sun} onToggle={() => tog('sun')} extra={<Switch on={e.sunShafts} onChange={(v) => patch('effects', { sunShafts: v })} />}>
        <div className="kv" style={{ opacity: e.sunShafts ? 1 : 0.5 }}>
          <label>Color</label>
          <ColorInput value={e.sunColor} onChange={(c) => patch('effects', { sunColor: c })} />
          <label>Threshold</label>
          <ColorInput value={e.sunThreshold} onChange={(c) => patch('effects', { sunThreshold: c })} />
        </div>
        <div className="hint">The light source is set in Studio (an item as sun caster).</div>
      </CollapsibleSection>

      <CollapsibleSection title="Toon shading (all characters)" open={open.toon} onToggle={() => tog('toon')}>
        <div className="kv">
          <label>Ramp</label>
          <select className="input" value={t.ramp} onChange={(ev) => patch('toon', { ramp: Number(ev.target.value) })}>
            {look.ramps.map((x) => (
              <option key={x.id} value={x.id}>
                {lutName(x)}
              </option>
            ))}
          </select>
          <label>Outline dark</label>
          <Slider value={t.lineColor} min={0} max={1} step={0.01} onChange={(v) => patch('toon', { lineColor: v })} />
          <label>Outline width</label>
          <Slider value={t.lineWidth} min={0} max={1} step={0.01} onChange={(v) => patch('toon', { lineWidth: v })} />
          <label>Shadow color</label>
          <ColorInput value={t.ambientShadow} onChange={(c) => patch('toon', { ambientShadow: c })} />
          <label>Shadow depth</label>
          <Slider value={t.ambientShadowG} min={0} max={1} step={0.01} onChange={(v) => patch('toon', { ambientShadowG: v })} />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button className={`btn solid ${t.faceNormal ? 'on' : ''}`} style={{ flex: 1 }} onClick={() => patch('toon', { faceNormal: !t.faceNormal })}>
            Face normals
          </button>
          <button className={`btn solid ${t.faceShadow ? 'on' : ''}`} style={{ flex: 1 }} onClick={() => patch('toon', { faceShadow: !t.faceShadow })}>
            Face shadow
          </button>
          <button className={`btn solid ${e.shadow ? 'on' : ''}`} style={{ flex: 1 }} title="Self shadows" onClick={() => patch('effects', { shadow: !e.shadow })}>
            Shadows
          </button>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Lights" open={open.lights} onToggle={() => tog('lights')}>
        <LightRows label="Character light" prefix="chara" lights={l} onPatch={(v) => patch('lights', v)} />
        <div className="menu-sep" style={{ margin: '10px 0' }} />
        <LightRows label="Map light" prefix="map" lights={l} onPatch={(v) => patch('lights', v)} />
      </CollapsibleSection>

      {look.materialEditor && (
        <CollapsibleSection title="Materials (MaterialEditor)" open={open.materials} onToggle={() => tog('materials')}>
          {open.materials && (
            <MaterialsSection
              onRule={(r) => {
                const rs = useStore.getState().lookRules;
                useStore.setState({ lookRules: [...rs.filter((x) => !(x.shader === r.shader && x.prop === r.prop)), r] });
                toast(`“${r.prop}” will be saved with the next look`);
              }}
            />
          )}
        </CollapsibleSection>
      )}

    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} title={on ? 'On' : 'Off'}>
      <span />
    </button>
  );
}

function ColorInput({ value, onChange }: { value: number[]; onChange: (c: RGBA) => void }) {
  return <input type="color" value={hex(value)} onChange={(ev) => onChange(fromHex(ev.target.value, value[3] ?? 1))} style={{ width: '100%', height: 24, background: 'none', border: 0, padding: 0 }} />;
}

function LightRows({ label, prefix, lights, onPatch }: { label: string; prefix: 'chara' | 'map'; lights: Look['lights']; onPatch: (v: Record<string, unknown>) => void }) {
  const color = lights[`${prefix}Color`];
  const intensity = lights[`${prefix}Intensity`];
  const rot = lights[`${prefix}Rot`];
  const shadow = lights[`${prefix}Shadow`];
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <b style={{ flex: 1 }}>{label}</b>
        <button className={`btn solid ${shadow ? 'on' : ''}`} style={{ height: 22, fontSize: 11 }} onClick={() => onPatch({ [`${prefix}Shadow`]: !shadow })}>
          Shadows
        </button>
      </div>
      <div className="kv">
        <label>Color</label>
        <ColorInput value={color} onChange={(c) => onPatch({ [`${prefix}Color`]: c })} />
        <label>Intensity</label>
        <Slider value={intensity} min={0} max={2} step={0.01} onChange={(v) => onPatch({ [`${prefix}Intensity`]: v })} />
        <label>Pitch</label>
        <Slider value={rot[0]} min={-90} max={90} step={1} onChange={(v) => onPatch({ [`${prefix}Rot`]: [v, rot[1]] })} />
        <label>Yaw</label>
        <Slider value={rot[1]} min={-180} max={180} step={1} onChange={(v) => onPatch({ [`${prefix}Rot`]: [rot[0], v] })} />
      </div>
    </div>
  );
}

interface ShaderInfo {
  shader: string;
  materials: number;
  parts: string[];
  props: { name: string; type: 'float' | 'color'; value: number | RGBA; mixed: boolean; min?: number; max?: number }[];
}

/** Shader properties of the selected characters/items, editable in bulk through MaterialEditor. */
function MaterialsSection({ onRule }: { onRule: (r: MatRule) => void }) {
  const selection = useStore((s) => s.studioSelection);
  const [list, setList] = useState<ShaderInfo[] | null>(null);
  const [openShader, setOpenShader] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [parts, setParts] = useState<string[]>([]);
  const timer = useRef(0);
  // Slider range for props without a declared range: fixed when first seen (a range computed from the live
  // value would grow under the cursor while dragging). Negative starting values get a symmetric range.
  const ranges = useRef(new Map<string, number>());
  const rangeFor = (key: string, v: number, sign: 1 | -1) => {
    let r = ranges.current.get(key);
    if (r === undefined) {
      r = Math.max(1, Math.ceil(Math.abs(v) * 2));
      ranges.current.set(key, r);
    }
    return sign * (sign < 0 && v >= 0 ? 0 : r);
  };
  const pendingMat = useRef(new Map<string, { shader: string; prop: string; type: string; value: number | RGBA }>());

  const load = useCallback(() => {
    call<ShaderInfo[]>('material.list', { ids: useStore.getState().studioSelection }).then((r) => r && setList(r));
  }, []);
  useEffect(load, [selection.join(','), load]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (shader: string, p: ShaderInfo['props'][number], value: number | RGBA) => {
    setList((ls) => ls && ls.map((s) => (s.shader !== shader ? s : { ...s, props: s.props.map((x) => (x.name === p.name ? { ...x, value, mixed: false } : x)) })));
    // Per-property pending values, flushed once per frame (live while dragging; no dropped edits).
    pendingMat.current.set(`${shader}|${p.name}`, { shader, prop: p.name, type: p.type, value });
    if (timer.current) return;
    timer.current = requestAnimationFrame(() => {
      timer.current = 0;
      const batch = [...pendingMat.current.values()];
      pendingMat.current.clear();
      const ids = useStore.getState().studioSelection;
      for (const b of batch) bridge.request('material.set', { ids, ...b, parts }).catch((e) => toast((e as Error).message, 'error'));
    });
  };

  if (!selection.length) return <div className="hint" style={{ marginTop: 0 }}>Select characters or items to edit their materials. Tweaks are saved like MaterialEditor edits.</div>;
  if (!list) return <div className="hint">Reading materials…</div>;
  const q = query.trim().toLowerCase();

  return (
    <div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
        {['body', 'clothes', 'hair', 'accessory', 'item'].map((p) => (
          <button
            key={p}
            className={`btn solid ${parts.includes(p) ? 'on' : ''}`}
            style={{ height: 20, fontSize: 10, padding: '0 6px' }}
            title="Limit edits to these parts (none selected = all parts)"
            onClick={() => setParts((ps) => (ps.includes(p) ? ps.filter((x) => x !== p) : [...ps, p]))}
          >
            {p}
          </button>
        ))}
      </div>
      <input className="input search" placeholder="Filter shaders / properties…" value={query} onChange={(ev) => setQuery(ev.target.value)} style={{ marginBottom: 6 }} />
      {list
        .filter((s) => !q || s.shader.toLowerCase().includes(q) || s.props.some((p) => p.name.toLowerCase().includes(q)))
        .map((s) => {
          const isOpen = openShader === s.shader || !!q;
          return (
            <div key={s.shader} style={{ borderBottom: '1px solid var(--line-soft)' }}>
              <div className="tree-row" style={{ paddingLeft: 0 }} onClick={() => setOpenShader(isOpen && !q ? null : s.shader)}>
                <span className="chev">{isOpen ? '▾' : '▸'}</span>
                <span className="name" style={{ fontFamily: 'var(--mono)', fontSize: 11 }} title={s.shader}>
                  {s.shader.replace(/^Shader Forge\//, '')}
                </span>
                <span className="sub">
                  {s.materials} · {s.parts.join('/')}
                </span>
              </div>
              {isOpen && (
                <div style={{ padding: '2px 0 8px 14px', display: 'grid', gap: 4 }}>
                  {s.props
                    .filter((p) => !q || s.shader.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
                    .map((p) => (
                      <div key={p.name} style={{ display: 'grid', gridTemplateColumns: '92px 1fr auto', gap: 6, alignItems: 'center' }}>
                        <span style={{ color: p.mixed ? 'var(--accent)' : 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${p.name}${p.mixed ? ' (differs between materials)' : ''}`}>
                          {p.name}
                        </span>
                        {p.type === 'color' ? (
                          <ColorInput value={p.value as RGBA} onChange={(c) => set(s.shader, p, c)} />
                        ) : (
                          <Slider value={p.value as number} min={p.min ?? Math.min(0, rangeFor(`${s.shader}|${p.name}`, p.value as number, -1))} max={p.max ?? rangeFor(`${s.shader}|${p.name}`, p.value as number, 1)} step={0.005} onChange={(v) => set(s.shader, p, v)} />
                        )}
                        <span style={{ display: 'flex', gap: 2 }}>
                          <button className="btn icon" style={{ width: 20, height: 20 }} title="Add this value to the look you save next" onClick={() => onRule({ shader: s.shader, prop: p.name, type: p.type, value: p.value, parts: parts.length ? parts : undefined })}>
                            +
                          </button>
                          <button
                            className="btn icon"
                            style={{ width: 20, height: 20 }}
                            title="Remove the override (back to the material's original value)"
                            onClick={() => call('material.reset', { ids: useStore.getState().studioSelection, shader: s.shader, prop: p.name, type: p.type }).then(load)}
                          >
                            ↺
                          </button>
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      {!list.length && <div className="hint">No editable materials on the selection.</div>}
    </div>
  );
}

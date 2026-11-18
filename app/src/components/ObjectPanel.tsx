import { useCallback, useEffect, useRef, useState } from 'react';
import { Help } from './Help';
import { bridge } from '../bridge/client';
import { displayName, toast, useStore } from '../state/store';
import { Num, Vec } from './AbmxSection';
import { Slider } from './CharacterPanel';
import { TypeIcon } from './Icon';

type V3 = [number, number, number];
type RGBA = [number, number, number, number];
interface ObjState {
  id: number;
  type: string;
  name: string;
  transform?: { pos: V3; rot: V3; scale: V3; canPos: boolean; canRot: boolean; canScale: boolean };
  item?: {
    colors: { index: number; rgba: RGBA; used: boolean }[];
    alpha: number;
    hasAlpha: boolean;
    emissionColor: RGBA;
    emissionPower: number;
    hasEmission: boolean;
    fk: boolean;
    hasFk: boolean;
    animeSpeed: number;
    hasAnime: boolean;
  };
  light?: { kind: string; color: RGBA; intensity: number; range: number; spotAngle: number; shadow: boolean; enable: boolean; hasRange: boolean; hasSpot: boolean };
  folder?: { name: string };
  camera?: { name: string; active: boolean };
}

const hex = (c: number[]) => '#' + c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (h: string, a: number): RGBA => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a];

/** Deep-merge a patch: objects merge, arrays merge element-wise (null = keep), primitives replace. */
function mergePatch(base: unknown, patch: unknown): unknown {
  if (Array.isArray(patch)) {
    const b = Array.isArray(base) ? [...base] : [];
    patch.forEach((v, i) => {
      if (v !== null && v !== undefined) b[i] = mergePatch(b[i], v);
    });
    return b;
  }
  if (patch && typeof patch === 'object') {
    const b: Record<string, unknown> = base && typeof base === 'object' && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) b[k] = mergePatch(b[k], v);
    return b;
  }
  return patch;
}

/** Transform, name, colors, light… of the selected object. `bare`: the name row is shown by the panel around it. */
export function ObjectPanel({ bare }: { bare?: boolean } = {}) {
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  const revision = useStore((s) => s.revision);
  const ids = selection.filter((id) => id >= 0 && nodes[id] && nodes[id].type !== 'node');
  const primary = ids[0];
  const [st, setSt] = useState<ObjState | null>(null);

  const want = useRef(primary);
  want.current = primary;
  const lastEdit = useRef(-1e9); // "long ago" (performance.now() starts at 0 when the page loads)
  const refresh = useCallback(() => {
    if (primary == null) return setSt(null);
    const id = primary;
    bridge
      .request<ObjState>('object.get', { id })
      .then((r) => want.current === id && performance.now() - lastEdit.current > 800 && setSt(r))
      .catch(() => want.current === id && setSt(null));
  }, [primary]);
  useEffect(refresh, [refresh, revision]);

  // While the user drags in Studio, keep transform numbers live (paused while editing here).
  useEffect(() => {
    if (primary == null) return;
    const h = window.setInterval(refresh, 700);
    return () => window.clearInterval(h);
  }, [primary, refresh]);

  // Slider drags: apply locally at once, send merged patches at most once per frame (live in Studio).
  const pending = useRef<Record<string, unknown> | null>(null);
  const raf = useRef(0);
  const send = (patch: Record<string, unknown>) => {
    lastEdit.current = performance.now();
    setSt((cur) => (cur ? (mergePatch(cur, patch) as ObjState) : cur));
    pending.current = mergePatch(pending.current ?? {}, patch) as Record<string, unknown>;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const p = pending.current;
      pending.current = null;
      if (!p) return;
      bridge
        .request<ObjState>('object.set', { ids, ...p })
        .then((r) => typeof r === 'object' && !pending.current && performance.now() - lastEdit.current > 150 && setSt(r))
        .catch((e) => toast((e as Error).message, 'error'));
    });
  };

  if (primary == null || !st) {
    return (
      <div className="panel-body">
        <div className="empty">
          <strong>No object selected</strong>
          Select anything in the Scene list or in Studio to edit its transform, colors or light.
        </div>
      </div>
    );
  }

  /** Only the axis the user touched goes to the plugin, so multi-selections keep their own positions. */
  const axisPatch = (field: 'pos' | 'rot' | 'scale', prev: V3, next: V3) => {
    const patch = next.map((v, i) => (Math.abs(v - prev[i]) > 1e-7 ? v : null));
    setSt((s) => (s && s.transform ? { ...s, transform: { ...s.transform, [field]: next } } : s));
    send({ [field]: patch });
  };

  const tr = st.transform;
  const multi = ids.length > 1;
  const node = nodes[primary];

  return (
    <div className="panel-body">
      {!bare && (
        <div className="section" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TypeIcon type={st.type} sex={node?.sex} />
          <b style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(node ?? { name: st.name })}</b>
          {multi && <span className="kbd">+{ids.length - 1} more</span>}
        </div>
      )}

      {tr && (
        <div className="section">
          <h3>
            Transform
            <Help text="Drag a number to scrub (Shift = fine), click to type. With several objects selected, only the axis you change is applied to each." />
          </h3>
          <div style={{ display: 'grid', gap: 6 }}>
            {tr.canPos && <Vec label="Position" v={tr.pos} step={0.01} onChange={(v) => axisPatch('pos', tr.pos, v)} />}
            {tr.canRot && <Vec label="Rotation" v={tr.rot} step={0.5} onChange={(v) => axisPatch('rot', tr.rot, v)} />}
            {tr.canScale && <Vec label="Scale" v={tr.scale} step={0.01} onChange={(v) => axisPatch('scale', tr.scale, v)} />}
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
            {tr.canPos && (
              <button className="btn solid" style={{ flex: 1, height: 24, fontSize: 11 }} onClick={() => send({ pos: [0, 0, 0] })}>
                Reset pos
              </button>
            )}
            {tr.canRot && (
              <button className="btn solid" style={{ flex: 1, height: 24, fontSize: 11 }} onClick={() => send({ rot: [0, 0, 0] })}>
                Reset rot
              </button>
            )}
            {tr.canScale && (
              <button className="btn solid" style={{ flex: 1, height: 24, fontSize: 11 }} onClick={() => send({ scale: [1, 1, 1] })}>
                Reset scale
              </button>
            )}
          </div>
        </div>
      )}

      {(st.folder || st.camera) && (
        <div className="section">
          <h3>Name</h3>
          <input
            className="input search"
            key={st.id}
            defaultValue={st.folder?.name ?? st.camera?.name}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            onBlur={(e) => e.target.value !== (st.folder?.name ?? st.camera?.name) && send({ name: e.target.value })}
          />
        </div>
      )}

      {st.camera && (
        <div className="section">
          <h3>Camera</h3>
          <button className={`btn solid ${st.camera.active ? 'on' : ''}`} style={{ width: '100%' }} onClick={() => send({ cameraActive: !st.camera!.active })}>
            {st.camera.active ? 'Viewing through this camera — click to exit' : 'View through this camera'}
          </button>
        </div>
      )}

      {st.light && (
        <div className="section">
          <h3>
            Light <span className="spacer" />
            <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)' }}>{st.light.kind}</span>
          </h3>
          <div className="kv">
            <label>On</label>
            <div>
              <button className={`btn solid ${st.light.enable ? 'on' : ''}`} onClick={() => send({ light: { enable: !st.light!.enable } })}>
                {st.light.enable ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            <label>Color</label>
            <input type="color" value={hex(st.light.color)} onChange={(e) => send({ light: { color: fromHex(e.target.value, 1) } })} style={{ width: '100%', height: 26, background: 'none', border: 0 }} />
            <label>Intensity</label>
            <Slider value={st.light.intensity} min={0} max={2} step={0.01} onChange={(v) => { setSt({ ...st, light: { ...st.light!, intensity: v } }); send({ light: { intensity: v } }); }} />
            {st.light.hasRange && (
              <>
                <label>Range</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  <Num v={st.light.range} step={0.1} onChange={(v) => { setSt({ ...st, light: { ...st.light!, range: v } }); send({ light: { range: v } }); }} />
                </div>
              </>
            )}
            {st.light.hasSpot && (
              <>
                <label>Spot angle</label>
                <Slider value={st.light.spotAngle} min={1} max={179} step={1} onChange={(v) => { setSt({ ...st, light: { ...st.light!, spotAngle: v } }); send({ light: { spotAngle: v } }); }} />
              </>
            )}
            <label>Shadows</label>
            <div>
              <button className={`btn solid ${st.light.shadow ? 'on' : ''}`} onClick={() => send({ light: { shadow: !st.light!.shadow } })}>
                {st.light.shadow ? 'On' : 'Off'}
              </button>
            </div>
          </div>
        </div>
      )}

      {st.item && (
        <div className="section">
          <h3>Item</h3>
          <div className="kv">
            {st.item.colors
              .filter((c) => c.used)
              .map((c) => (
                <div key={c.index} style={{ display: 'contents' }}>
                  <label>Color {c.index + 1}</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="color"
                      value={hex(c.rgba)}
                      onChange={(e) => send({ item: { color: { index: c.index, rgba: fromHex(e.target.value, c.rgba[3]) } } })}
                      style={{ width: 44, height: 24, background: 'none', border: 0 }}
                    />
                    <span className="hint" style={{ margin: 0 }}>
                      α
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={c.rgba[3]}
                      style={{ flex: 1, accentColor: 'var(--accent)' }}
                      onChange={(e) => send({ item: { color: { index: c.index, rgba: [c.rgba[0], c.rgba[1], c.rgba[2], Number(e.target.value)] } } })}
                    />
                  </div>
                </div>
              ))}
            {st.item.hasAlpha && (
              <>
                <label>Opacity</label>
                <Slider value={st.item.alpha} min={0} max={1} step={0.01} onChange={(v) => { setSt({ ...st, item: { ...st.item!, alpha: v } }); send({ item: { alpha: v } }); }} />
              </>
            )}
            {st.item.hasEmission && (
              <>
                <label>Glow color</label>
                <input type="color" value={hex(st.item.emissionColor)} onChange={(e) => send({ item: { emissionColor: fromHex(e.target.value, 1) } })} style={{ width: '100%', height: 24, background: 'none', border: 0 }} />
                <label>Glow</label>
                <Slider value={st.item.emissionPower} min={0} max={1} step={0.01} onChange={(v) => { setSt({ ...st, item: { ...st.item!, emissionPower: v } }); send({ item: { emissionPower: v } }); }} />
              </>
            )}
            {st.item.hasAnime && (
              <>
                <label>Anim speed</label>
                <Slider value={st.item.animeSpeed} min={0} max={3} step={0.01} onChange={(v) => { setSt({ ...st, item: { ...st.item!, animeSpeed: v } }); send({ item: { animeSpeed: v } }); }} />
              </>
            )}
            {st.item.hasFk && (
              <>
                <label>Item FK</label>
                <div>
                  <button className={`btn solid ${st.item.fk ? 'on' : ''}`} onClick={() => send({ item: { fk: !st.item!.fk } })}>
                    {st.item.fk ? 'FK on — bones movable' : 'FK off'}
                  </button>
                </div>
              </>
            )}
          </div>
          {!st.item.colors.some((c) => c.used) && !st.item.hasAlpha && !st.item.hasEmission && <div className="hint">This item has no editable colors.</div>}
        </div>
      )}
    </div>
  );
}

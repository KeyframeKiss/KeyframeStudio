import { useEffect, useMemo, useRef, useState } from 'react';
import { curvesEqual, fromFlat, toFlat, type Curve } from '../lib/curve';
import { eulerFromQuat, quatFromEuler, type Quat } from '../lib/rotation';
import { applyCurveToSelected, call, editTimeline, liveTime, seekNow, toast, useStore } from '../state/store';
import { CurveThumb } from './CurveEditor';
import { DragNumber } from './DragNumber';
import { Icon } from './Icon';

const AXIS = [
  ['X', '#f0545c'],
  ['Y', '#72d95a'],
  ['Z', '#5599ff'],
] as const;

/**
 * A key's value, editable: rotations as degrees around X / Y / Z (stored as quaternions), positions and scales
 * per axis, any other number on its own. Drag to change (Studio follows live), click to type. One drag is one undo.
 */
export function KeyValueEditor({ track, model, t, value, onValue }: { track: number; model: string; t: number; value: Record<string, string>; onValue: (v: Record<string, string>) => void }) {
  const previewed = useRef(false);
  const pending = useRef<{ value: Record<string, number>; first: boolean } | null>(null);
  const timer = useRef(0);

  const num = (k: string) => Number(value[k]);
  const has = (...ks: string[]) => ks.every((k) => k in value && value[k].trim() !== '' && Number.isFinite(num(k)));
  const isRot = has('valueX', 'valueY', 'valueZ', 'valueW');
  const isVec = !isRot && has('valueX', 'valueY', 'valueZ');
  const euler = useMemo(() => (isRot ? eulerFromQuat([num('valueX'), num('valueY'), num('valueZ'), num('valueW')] as Quat) : null), [value]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const flush = () => {
    const p = pending.current;
    pending.current = null;
    timer.current = 0;
    if (p) call('timeline.setKeyValue', { track, t, value: p.value, noHistory: !p.first }).catch(() => {});
  };
  const preview = (v: Record<string, number>, first: boolean) => {
    if (first) {
      previewed.current = true;
      // show it: Studio follows the key at the playhead
      if (Math.abs(liveTime() - t) > 1e-3) seekNow(t);
      pending.current = { value: v, first: true };
      flush();
      return;
    }
    pending.current = { value: v, first: false };
    if (!timer.current) timer.current = window.setTimeout(flush, 40);
  };
  const commit = async (v: Record<string, number>) => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    pending.current = null;
    const r = await editTimeline<Record<string, string>>('timeline.setKeyValue', { track, t, value: v, noHistory: previewed.current });
    previewed.current = false;
    if (r) onValue(r);
  };

  if (isRot && euler) {
    const q = (i: number, d: number) => {
      const e = [...euler] as [number, number, number];
      e[i] = d;
      const [x, y, z, w] = quatFromEuler(e);
      return { valueX: x, valueY: y, valueZ: z, valueW: w };
    };
    return (
      <div className="kv-axes">
        {AXIS.map(([l, c], i) => (
          <DragNumber key={l} label={l} color={c} value={euler[i]} step={0.5} digits={1} unit="°" title={`Turn around ${l} (degrees) — drag sideways (Shift fine, Ctrl coarse) · click to type`} onPreview={(d, first) => preview(q(i, d), first)} onCommit={(d) => commit(q(i, d))} />
        ))}
      </div>
    );
  }
  if (isVec) {
    const scale = /scale/i.test(model);
    const keys = ['valueX', 'valueY', 'valueZ'];
    const vec = (i: number, d: number) => Object.fromEntries(keys.map((k, j) => [k, j === i ? d : num(k)]));
    return (
      <div className="kv-axes">
        {AXIS.map(([l, c], i) => (
          <DragNumber key={l} label={l} color={c} value={num(keys[i])} step={scale ? 0.005 : 0.002} digits={3} min={scale ? 0.001 : undefined} onPreview={(d, first) => preview(vec(i, d), first)} onCommit={(d) => commit(vec(i, d))} />
        ))}
      </div>
    );
  }
  const entries = Object.entries(value).filter(([k]) => !k.startsWith('_'));
  if (!entries.length) return <span className="value">{value._text ?? '—'}</span>;
  return (
    <div className="kv-axes kv-list">
      {entries.slice(0, 16).map(([k, v]) => {
        const n = Number(v);
        const label = k.replace(/^value/, '') || '';
        if (v.trim() === '' || !Number.isFinite(n))
          return (
            <span key={k} className="value" title={v}>
              {label && <b className="dn-label">{label}</b>} {v}
            </span>
          );
        const step = Math.abs(n) >= 10 ? 0.1 : Math.abs(n) >= 1 ? 0.01 : 0.005;
        return <DragNumber key={k} label={label || undefined} value={n} step={step} digits={Math.abs(n) >= 100 ? 1 : 3} onPreview={(d, first) => preview({ [k]: d }, first)} onCommit={(d) => commit({ [k]: d })} />;
      })}
    </div>
  );
}

interface Saved {
  file: string;
  name: string;
  data: { curve?: number[] };
}

const OPEN_KEY = 'kf.myEasingsOpen';

/** Easings you saved: click to apply, rename, delete — kept in UserData/StudioEX/easings next to the other presets. */
export function MyEasings({ curve }: { curve: Curve }) {
  const status = useStore((s) => s.status);
  const [list, setList] = useState<Saved[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [naming, setNaming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ file: string; text: string } | null>(null);

  useEffect(() => {
    if (status !== 'open') return;
    call<Saved[]>('store.list', { kind: 'easings' })
      .then((r) => {
        if (r) setList(r);
        else setUnavailable(true);
      })
      .catch(() => setUnavailable(true));
  }, [status]);

  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? '0' : '1');
      } catch {
        /* private mode */
      }
      return !o;
    });
  };
  const save = async (name: string) => {
    const n = name.trim();
    if (!n) return;
    const r = await call<Saved[]>('store.save', { kind: 'easings', name: n, data: { curve: toFlat(curve) } });
    if (r) {
      setList(r);
      toast(`Saved easing “${n}”`, 'done');
      setOpen(true);
    }
  };
  const rename = async (file: string, name: string) => {
    const item = list?.find((x) => x.file === file);
    const n = name.trim();
    if (!item || !n || n === item.name) return;
    const r = await call<Saved[]>('store.save', { kind: 'easings', name: n, data: item.data });
    if (r && r.some((x) => x.name === n)) {
      const after = await call<Saved[]>('store.delete', { kind: 'easings', file });
      setList(after ?? r);
    }
  };
  const remove = async (item: Saved) => {
    const r = await call<Saved[]>('store.delete', { kind: 'easings', file: item.file });
    if (r) setList(r);
    toast(`Deleted easing “${item.name}”`);
  };

  const count = list?.length ?? 0;
  return (
    <div className="my-easings">
      <div className="my-easings-head">
        <button className="my-easings-toggle" aria-expanded={open} onClick={toggle}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
          My easings
          <span className="sub">{count}</span>
        </button>
        {naming === null ? (
          <button className="btn small solid" disabled={unavailable} onClick={() => setNaming('')} title="Save the curve above under a name">
            <Icon name="plus" size={11} /> Save current
          </button>
        ) : (
          <form
            className="my-easings-name"
            onSubmit={(e) => {
              e.preventDefault();
              save(naming);
              setNaming(null);
            }}
          >
            <input className="input" autoFocus placeholder="Name it…" value={naming} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} onBlur={() => !naming.trim() && setNaming(null)} />
            <button className="btn small primary" type="submit" disabled={!naming.trim()}>
              Save
            </button>
          </form>
        )}
      </div>
      {open &&
        (unavailable ? (
          <div className="hint">Saving easings needs the updated bridge — restart CharaStudio once.</div>
        ) : count === 0 ? (
          <div className="hint">Shape a curve above (drag its handles), then Save current — it shows up here for any key.</div>
        ) : (
          <div className="preset-grid">
            {list!.map((item) => {
              const c = fromFlat(item.data.curve);
              const on = curvesEqual(c, curve);
              return (
                <div key={item.file} className={`preset my-easing ${on ? 'on' : ''}`} role="button" tabIndex={0} title={`${item.name} — click to apply`} onClick={() => !renaming && applyCurveToSelected(toFlat(c))} onKeyDown={(e) => e.key === 'Enter' && applyCurveToSelected(toFlat(c))}>
                  <CurveThumb curve={c} />
                  {renaming?.file === item.file ? (
                    <input
                      className="input my-easing-rename"
                      autoFocus
                      value={renaming.text}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming({ file: item.file, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={() => {
                        rename(item.file, renaming.text);
                        setRenaming(null);
                      }}
                    />
                  ) : (
                    <span className="my-easing-name">{item.name}</span>
                  )}
                  <span className="my-easing-actions">
                    <button className="btn icon" title="Rename" onClick={(e) => (e.stopPropagation(), setRenaming({ file: item.file, text: item.name }))}>
                      ✎
                    </button>
                    <button className="btn icon danger" title="Delete" onClick={(e) => (e.stopPropagation(), remove(item))}>
                      <Icon name="trash" size={11} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
    </div>
  );
}

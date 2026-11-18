import { useEffect, useState } from 'react';
import { Help } from './Help';
import { ask } from './Dialogs';
import { call, editTimeline, liveTime, refreshShots, seekNow, showTab, toast, useStore, type Shot } from '../state/store';

/**
 * Shoot › Shots: a storyboard of shots (time ranges with their own camera and notes). Click a shot to edit it
 * and jump there; camera cuts and rendering come from the shots.
 */
export function ShotsPanel() {
  const status = useStore((s) => s.status);
  const shots = useStore((s) => s.shots);
  const tl = useStore((s) => s.tl);
  const hello = useStore((s) => s.hello);
  const canRender = hello?.features?.some((f) => f.id === 'render' && (f.status === 'ok' || f.status === 'untested'));
  const [sel, setSel] = useState<string | null>(null);
  const time = tl?.time ?? 0;

  useEffect(() => {
    if (status === 'open') refreshShots();
  }, [status]);

  const save = async (next: Shot[]) => {
    const r = await call<Shot[]>('shots.set', { shots: next });
    if (r) useStore.setState({ shots: r });
  };
  const patch = (id: string, p: Partial<Shot>) => save(shots.map((s) => (s.id === id ? { ...s, ...p } : s)));

  const add = async () => {
    const dur = tl?.duration ?? 10;
    const start = Math.round(liveTime() * 100) / 100;
    const nextStart = shots.map((s) => s.start).filter((x) => x > start + 0.05).sort((a, b) => a - b)[0];
    const end = Math.min(dur, nextStart ?? start + 3);
    if (end - start < 0.1) return toast('No room for a shot here — move the playhead or make the timeline longer');
    const id = Math.random().toString(36).slice(2, 10);
    await save([...shots, { id, name: `Shot ${shots.length + 1}`, start, end, notes: '' }]);
    const r = await call<Shot[]>('shots.captureCamera', { id });
    if (r) useStore.setState({ shots: r });
    setSel(id);
    toast(`Shot added ${start.toFixed(2)}–${end.toFixed(2)}s with the current camera`);
  };

  const buildCuts = async () => {
    const n = await editTimeline<number>('shots.buildCuts', {});
    if (n) toast(`Camera cuts keyed for ${n} shot${n > 1 ? 's' : ''} — Ctrl+Z to undo`);
  };

  const ordered = [...shots].sort((a, b) => a.start - b.start);
  const cur = shots.find((s) => s.id === sel) ?? null;
  const fps = tl?.fps ?? 60;
  const n = (s: Shot) => ordered.indexOf(s) + 1;

  return (
    <div className="look-card shots-board">
      <div className="look-card-head">
        <div>
          <b>
            Shots
            <Help text="A shot is a time range with its own camera and notes; shots also show along the top of the timeline. Click a shot to edit it and go there, double-click to look through its camera. Build camera cuts switches the camera at each shot; Render can make one video per shot." />
          </b>
        </div>
        {shots.length > 0 && (
          <>
            <button className="btn small solid" onClick={buildCuts} title="Keys a hard cut to each shot's camera at its start">
              Build camera cuts
            </button>
            {canRender && (
              <button className="btn small solid" onClick={() => showTab('shoot', 'render')} title="Each shot as its own video">
                Render shots ›
              </button>
            )}
          </>
        )}
        <button className="btn small primary" onClick={add} title="A shot from the playhead to the next shot (or 3 s), with Studio's camera as it is now">
          + Shot at playhead
        </button>
      </div>
      <div className="look-card-body">
        {!shots.length ? (
          <div className="shots-empty">No shots yet — frame a view in Studio, put the playhead where it starts, press + Shot at playhead.</div>
        ) : (
          <div className="shot-strip">
            {ordered.map((s) => {
              const here = time >= s.start - 1e-3 && time < s.end - 1e-3;
              return (
                <button
                  key={s.id}
                  className={`shot-tile ${sel === s.id ? 'sel' : ''} ${here ? 'here' : ''}`}
                  onClick={() => {
                    setSel(sel === s.id ? null : s.id);
                    seekNow(s.start);
                  }}
                  onDoubleClick={() => s.cam && call('shots.view', { id: s.id })}
                  title={`${s.name}\n${s.start.toFixed(2)}–${s.end.toFixed(2)}s${s.notes ? `\n${s.notes}` : ''}\nClick to edit and go there · double-click to look through its camera`}
                >
                  <span className="shot-tile-img">
                    {s.thumb ? <img src={s.thumb} alt="" /> : <span>no camera</span>}
                    <i>{n(s)}</i>
                  </span>
                  <b>{s.name}</b>
                  <small>
                    {s.start.toFixed(2)}–{s.end.toFixed(2)}s · {(s.end - s.start).toFixed(1)}s
                  </small>
                </button>
              );
            })}
          </div>
        )}
        {cur && (
          <div className="shot-edit">
            <span className="shot-edit-n">#{n(cur)}</span>
            <input className="input" value={cur.name} onChange={(e) => useStore.setState({ shots: shots.map((x) => (x.id === cur.id ? { ...x, name: e.target.value } : x)) })} onBlur={(e) => patch(cur.id, { name: e.target.value || `Shot ${n(cur)}` })} style={{ width: 150 }} title="Name" />
            <input className="input mono" type="number" step={1 / fps} value={cur.start} onChange={(e) => patch(cur.id, { start: Number(e.target.value) })} title="Start (s)" style={{ width: 76 }} />
            <span className="hint" style={{ margin: 0 }}>
              to
            </span>
            <input className="input mono" type="number" step={1 / fps} value={cur.end} onChange={(e) => patch(cur.id, { end: Number(e.target.value) })} title="End (s)" style={{ width: 76 }} />
            <input key={cur.id} className="input" placeholder="Notes…" defaultValue={cur.notes} onBlur={(e) => e.target.value !== cur.notes && patch(cur.id, { notes: e.target.value })} style={{ flex: 1, minWidth: 120 }} />
            <button className="btn small solid" onClick={() => call<Shot[]>('shots.captureCamera', { id: cur.id }).then((r) => r && useStore.setState({ shots: r }))} title="Remember Studio's current camera for this shot (and its thumbnail)">
              Set camera
            </button>
            <button className="btn small solid" disabled={!cur.cam} onClick={() => call('shots.view', { id: cur.id })} title="Look through this shot's camera">
              View
            </button>
            <button
              className="btn small"
              title="Delete this shot"
              onClick={async () => {
                if (!(await ask(`Delete “${cur.name}”?`))) return;
                await save(shots.filter((x) => x.id !== cur.id));
                setSel(null);
              }}
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

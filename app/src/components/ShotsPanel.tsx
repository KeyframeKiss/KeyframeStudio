import { useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { call, editTimeline, liveTime, refreshShots, seekNow, toast, useStore, type Shot } from '../state/store';

/** Shot sequencer: time ranges with their own camera and notes; camera cuts and a render queue from them. */
export function ShotsPanel() {
  const status = useStore((s) => s.status);
  const shots = useStore((s) => s.shots);
  const tl = useStore((s) => s.tl);
  const hello = useStore((s) => s.hello);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<{ running: boolean; done?: number; total?: number; shot?: string; error?: string | null } | null>(null);
  const poll = useRef(0);
  const canRender = hello?.features?.some((f) => f.id === 'render' && (f.status === 'ok' || f.status === 'untested'));

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
    toast(`Shot added ${start.toFixed(2)}–${end.toFixed(2)}s with the current camera`);
  };

  const buildCuts = async () => {
    const n = await editTimeline<number>('shots.buildCuts', {});
    if (n) toast(`Camera cuts keyed for ${n} shot${n > 1 ? 's' : ''} — Ctrl+Z to undo`);
  };

  const render = async () => {
    const ids = shots.filter((s) => pick.has(s.id)).map((s) => s.id);
    const r = await call<{ running: boolean }>('render.queue', { ids });
    if (!r) return;
    setQueue(r);
    poll.current = window.setInterval(async () => {
      const q = await bridge.request<NonNullable<typeof queue>>('render.queueStatus').catch(() => null);
      if (!q) return;
      setQueue(q);
      if (!q.running) {
        window.clearInterval(poll.current);
        toast(q.error ? `Render queue stopped: ${q.error}` : `Rendered ${q.done} of ${q.total} shot${q.total === 1 ? '' : 's'}`);
      }
    }, 1000);
  };
  useEffect(() => () => window.clearInterval(poll.current), []);

  const fps = tl?.fps ?? 60;
  return (
    <div className="panel-body shots">
      <div className="section">
        <h3>
          Shots <span className="spacer" />
          <button className="btn small" onClick={add} title="A shot from the playhead to the next shot (or 3 s), with the camera as it is now">
            + Shot at playhead
          </button>
        </h3>
        {!shots.length && <div className="hint" style={{ marginTop: 0 }}>Frame a view in Studio, put the playhead where the shot starts, and add it. Shots also show along the top of the dope sheet.</div>}
        <div className="shot-list">
          {shots.map((s, i) => (
            <div key={s.id} className="shot-card">
              <div className="shot-thumb" onClick={() => seekNow(s.start)} title="Go to the shot's start">
                {s.thumb ? <img src={s.thumb} alt="" /> : <span>#{i + 1}</span>}
              </div>
              <div className="shot-body">
                <div className="shot-row">
                  <input type="checkbox" checked={pick.has(s.id)} onChange={(e) => setPick((p) => { const n = new Set(p); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n; })} title="Include in the render queue" />
                  <input className="input shot-name" value={s.name} onChange={(e) => useStore.setState({ shots: shots.map((x) => (x.id === s.id ? { ...x, name: e.target.value } : x)) })} onBlur={(e) => patch(s.id, { name: e.target.value || `Shot ${i + 1}` })} />
                </div>
                <div className="shot-row">
                  <input className="input mono" type="number" step={1 / fps} value={s.start} onChange={(e) => patch(s.id, { start: Number(e.target.value) })} title="Start (s)" />
                  <span>–</span>
                  <input className="input mono" type="number" step={1 / fps} value={s.end} onChange={(e) => patch(s.id, { end: Number(e.target.value) })} title="End (s)" />
                  <small>{(s.end - s.start).toFixed(2)}s</small>
                </div>
                <textarea className="input shot-notes" placeholder="Notes…" defaultValue={s.notes} onBlur={(e) => e.target.value !== s.notes && patch(s.id, { notes: e.target.value })} rows={1} />
                <div className="shot-row">
                  <button className="btn small" onClick={() => call<Shot[]>('shots.captureCamera', { id: s.id }).then((r) => r && useStore.setState({ shots: r }))} title="Remember Studio's current camera for this shot">
                    Set camera
                  </button>
                  <button className="btn small" disabled={!s.cam} onClick={() => call('shots.view', { id: s.id })} title="Look through this shot's camera">
                    View
                  </button>
                  <span className="spacer" style={{ flex: 1 }} />
                  <button className="btn small" onClick={() => window.confirm(`Delete “${s.name}”?`) && save(shots.filter((x) => x.id !== s.id))}>
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      {shots.length > 0 && (
        <div className="section">
          <h3>From the shots</h3>
          <button className="btn solid wide" onClick={buildCuts} title="Keys a hard cut to each shot's camera at its start">
            Build camera cuts
          </button>
          {canRender && (
            <>
              {queue?.running ? (
                <>
                  <div className="hint">
                    Rendering {queue.shot} ({(queue.done ?? 0) + 1} of {queue.total})…
                  </div>
                  <button className="btn solid wide" onClick={() => call('render.queueCancel')}>
                    Stop the queue
                  </button>
                </>
              ) : (
                <button className="btn primary wide" disabled={!pick.size} onClick={render} title="Each ticked shot becomes its own video (settings from Render on the right)">
                  Render {pick.size ? `${pick.size} shot${pick.size > 1 ? 's' : ''}` : 'ticked shots'}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { call, renderShots, saveShots, seekNow, toast, togglePlay, useStore, type Shot } from '../../state/store';
import { MIN_SHOT, trimShot, moveShot } from '../../lib/shots';
import { DragNumber } from '../DragNumber';
import { Slider } from '../CharacterPanel';
import { Help } from '../Help';
import { Icon } from '../Icon';
import { CameraMoves } from '../CameraMoves';
import { ASPECTS, setCamTools } from '../CameraToolsCards';
import { CamKeyList, keyCamera, reloadCam, useCam, VIEW_DRAG } from '../CameraPanel';
import { canRender, deleteShot, duplicate, fromView, lookThrough, patchShot, playShot, splitAtPlayhead, STATUSES, useCurrentView, workOn } from './actions';

/** Shoot › Shots: everything about the picked shot — its picture, name, status, timing, camera, frame and notes. */
export function ShotInspector({ shot, index }: { shot: Shot; index: number }) {
  const duration = useStore((s) => s.tl?.duration ?? 10);
  const fps = useStore((s) => s.tl?.fps ?? 30);
  const shots = useStore((s) => s.shots);
  const loop = useStore((s) => s.loopShot && s.workingShotId === shot.id);
  const playing = useStore((s) => !!s.tl?.playing);
  const { st, keys } = useCam();
  const [name, setName] = useState(shot.name);
  const [notes, setNotes] = useState(shot.notes);
  const [drop, setDrop] = useState(false);
  useEffect(() => {
    setName(shot.name);
    setNotes(shot.notes);
  }, [shot.id, shot.name, shot.notes]);

  const len = shot.end - shot.start;
  const mode = shot.camMode ?? 'still';
  const inKeys = keys.filter((k) => k.t >= shot.start - 1e-4 && k.t < shot.end - 1e-4);
  const fov = shot.cam?.fov ?? st?.fov ?? 23;
  const frame = shot.aspect ?? 0;

  const setTime = (edge: 'start' | 'end', v: number) => saveShots(trimShot(shots, shot.id, edge, v, duration), 'Trim shot');
  const setLength = (v: number) => saveShots(trimShot(shots, shot.id, 'end', shot.start + Math.max(MIN_SHOT, v), duration), 'Trim shot');
  const moveTo = (v: number) => saveShots(moveShot(shots, shot.id, v, duration), 'Move shot');

  const setMode = async (m: 'still' | 'keys') => {
    if (m === mode) return;
    if (!(await patchShot(shot.id, { camMode: m }, m === 'keys' ? 'Shot camera: keys' : 'Shot camera: still'))) return;
    if (m === 'keys' && shot.cam && inKeys.length === 0 && st?.timeline) {
      // start the shot's camera keys from its still camera, so nothing jumps
      await seekNow(shot.start);
      await call('shots.view', { id: shot.id });
      await keyCamera(true, shot.start);
      toast('The shot’s camera is keyed at its start — move the playhead, frame, and Key camera (or add a camera move)');
    }
  };

  const setFov = (v: number) => {
    if (!shot.cam) return;
    useStore.setState({ shots: shots.map((s) => (s.id === shot.id ? { ...s, cam: { ...s.cam!, fov: v } } : s)) });
  };
  const commitFov = async (v: number) => {
    if (!shot.cam) return;
    await patchShot(shot.id, { cam: { ...shot.cam, fov: v } }, 'Shot lens');
    await call('shots.view', { id: shot.id });
  };

  const setFrame = async (a: number) => {
    await patchShot(shot.id, { aspect: a }, 'Shot frame');
    if (a > 0) setCamTools({ guides: { aspect: a } });
  };

  return (
    <div className="sq-insp">
      <div
        className={`sq-insp-pic ${drop ? 'drop' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(VIEW_DRAG)) return;
          e.preventDefault();
          setDrop(true);
        }}
        onDragLeave={() => setDrop(false)}
        onDrop={(e) => {
          setDrop(false);
          const v = e.dataTransfer.getData(VIEW_DRAG);
          if (v !== '') void fromView(shot.id, Number(v));
        }}
      >
        <button className="sq-insp-img" onClick={() => lookThrough(shot.id)} title={mode === 'keys' ? 'Go to the shot’s start' : 'Look through this shot’s camera'}>
          {shot.thumb ? <img src={shot.thumb} alt="" draggable={false} /> : <span>{mode === 'keys' ? 'Camera keys' : 'No camera yet'}</span>}
          <i>{index + 1}</i>
        </button>
        <div className="sq-insp-pic-actions">
          <button className="btn small primary" onClick={() => useCurrentView(shot.id)} title="The shot takes Studio's camera as it is now">
            Use current view
          </button>
          <button className="btn small solid" onClick={() => lookThrough(shot.id)} disabled={mode === 'still' && !shot.cam}>
            Look through
          </button>
          <button
            className="btn small solid"
            disabled={mode === 'keys' || !shot.cam}
            onClick={() => call<number>('shots.thumbs', { ids: [shot.id] })}
            title="Take its picture again (after changing the scene)"
          >
            New picture
          </button>
        </div>
      </div>

      <div className="sq-insp-main">
        <div className="sq-insp-row">
          <input
            className="input sq-insp-name"
            value={name}
            aria-label="Shot name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() !== shot.name && patchShot(shot.id, { name: name.trim() || `Shot ${index + 1}` }, 'Rename shot')}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <div className="seg sq-status" role="radiogroup" aria-label="Status">
            {STATUSES.map((s) => (
              <button key={s.id} role="radio" aria-checked={(shot.status ?? 'idea') === s.id} className={`st-${s.id} ${(shot.status ?? 'idea') === s.id ? 'on' : ''}`} title={s.hint} onClick={() => patchShot(shot.id, { status: s.id }, 'Shot status')}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="sq-insp-row sq-times">
          <label>
            <span>Start</span>
            <DragNumber value={shot.start} step={1 / fps} digits={2} unit=" s" min={0} max={duration} onCommit={(v) => setTime('start', v)} title="Drag or type. The cut with the shot before moves too when they touch." />
          </label>
          <label>
            <span>End</span>
            <DragNumber value={shot.end} step={1 / fps} digits={2} unit=" s" min={0} max={duration} onCommit={(v) => setTime('end', v)} />
          </label>
          <label>
            <span>Length</span>
            <DragNumber value={len} step={1 / fps} digits={2} unit=" s" min={MIN_SHOT} max={duration} onCommit={setLength} />
          </label>
          <label>
            <span>Move to</span>
            <DragNumber value={shot.start} step={1 / fps} digits={2} unit=" s" min={0} max={duration} onCommit={moveTo} title="Move the whole shot, keeping its length" />
          </label>
          <div className="sq-play">
            {playing ? (
              <button className="btn small solid" onClick={togglePlay} title="Stop playing (the playhead stays where it is)">
                <Icon name="stop" size={12} /> Stop
              </button>
            ) : (
              <button className="btn small solid" onClick={() => playShot(shot.id, loop)} title={loop ? 'Play the shot over and over' : "Play from the shot's start"}>
                <Icon name="play" size={12} /> Play
              </button>
            )}
            <button
              className={`btn small solid ${loop ? 'on' : ''}`}
              aria-pressed={loop}
              onClick={() => (loop ? useStore.setState({ loopShot: false }) : playShot(shot.id, true))}
              title={loop ? 'Looping this shot — click to play on past its end' : 'Play this shot over and over'}
            >
              <Icon name="redo" size={12} /> Loop
            </button>
          </div>
        </div>

        <div className="sq-insp-cols">
          <div className="sq-insp-block">
            <div className="sq-insp-h">
              Camera
              <Help text="Still: the shot has its own camera; with live cuts on, Studio switches to it as the shot starts. Camera keys: the camera moves inside the shot by its keys (key it, or add a camera move across the shot)." />
            </div>
            <div className="seg sq-mode">
              <button className={mode === 'still' ? 'on' : ''} onClick={() => setMode('still')}>
                Still camera
              </button>
              <button className={mode === 'keys' ? 'on' : ''} onClick={() => setMode('keys')} disabled={!st?.timeline}>
                Camera keys
              </button>
            </div>
            {mode === 'still' ? (
              <>
                <div className="sq-field">
                  <span>Lens</span>
                  <Slider value={fov} min={10} max={90} step={0.5} onChange={(v) => (setFov(v), commitFovDebounced(v, commitFov))} />
                </div>
                <div className="sq-field">
                  <span>From view</span>
                  <div className="sq-views">
                    {(st?.slots ?? []).map((v) => (
                      <button key={v.index} className="sq-view" disabled={!v.used} onClick={() => fromView(shot.id, v.index)} title={v.used ? `Use saved view ${v.index + 1}` : `View ${v.index + 1} is empty`}>
                        {v.thumb && v.used ? <img src={v.thumb} alt="" /> : null}
                        <i>{v.index + 1}</i>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sq-tip">Tip: drag a saved view from the right onto any shot.</div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <button className="btn small primary" style={{ flex: 1 }} onClick={() => keyCamera(false)} title="Key Studio's camera at the playhead">
                    Key camera at playhead
                  </button>
                  <button className="btn small solid" onClick={() => keyCamera(true)} title="Key it and make it jump there">
                    ✂ Cut
                  </button>
                </div>
                <CamKeyList keys={inKeys} fps={fps} empty="No camera keys in this shot yet." />
                <details className="sq-moves">
                  <summary>Camera move across the shot</summary>
                  <CameraMoves start={shot.start} length={len} onDone={reloadCam} bare />
                </details>
              </>
            )}
          </div>

          <div className="sq-insp-block">
            <div className="sq-insp-h">
              Frame
              <Help text="The picture shape shown in Studio's window when the shot is on screen (with live cuts, or when you look through it). Off leaves the frame guides as they are." />
            </div>
            <div className="ct-chips sq-frames">
              {ASPECTS.filter((a) => typeof a.v === 'number').map((a) => {
                const v = a.v as number;
                return (
                  <button key={a.label} className={`btn chip ${Math.abs(frame - v) < 1e-3 ? 'on' : ''}`} onClick={() => setFrame(v)}>
                    {a.label}
                  </button>
                );
              })}
            </div>
            <div className="sq-insp-h" style={{ marginTop: 10 }}>
              Notes
            </div>
            <textarea className="input sq-notes" value={notes} placeholder="What happens, the mood, dialogue, what to fix…" rows={4} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== shot.notes && patchShot(shot.id, { notes }, 'Shot notes')} />
          </div>
        </div>

        <div className="sq-insp-foot">
          <button className="btn small primary" onClick={() => workOn(shot.id)} title="Animate › Timeline, framed on this shot">
            Work on this shot
          </button>
          {canRender() && (
            <button className="btn small solid" onClick={() => renderShots([shot.id])}>
              Render this shot
            </button>
          )}
          <span className="sq-foot-gap" />
          <button className="btn small solid" onClick={() => splitAtPlayhead(shot.id)} title="Split into two at the playhead (S)">
            Split at playhead
          </button>
          <button className="btn small solid" onClick={() => duplicate(shot.id)} title="A copy right after it (D)">
            Duplicate
          </button>
          <button className="btn small solid danger" onClick={() => deleteShot(shot.id)} title="Delete (Del) — Ctrl+Z brings it back">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// the lens slider previews at once and saves once it rests (a drag is one undo step)
let fovTimer = 0;
function commitFovDebounced(v: number, commit: (v: number) => void) {
  window.clearTimeout(fovTimer);
  fovTimer = window.setTimeout(() => commit(v), 350);
}

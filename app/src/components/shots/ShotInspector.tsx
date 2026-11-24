import { useEffect, useState } from 'react';
import { call, displayName, renderShots, saveShots, seekNow, toast, togglePlay, useStore, type Shot, type ShotCamMode } from '../../state/store';
import { MIN_SHOT, trimShot, moveShot } from '../../lib/shots';
import { DragNumber } from '../DragNumber';
import { Slider } from '../CharacterPanel';
import { Help } from '../Help';
import { Icon } from '../Icon';
import { CameraMoves } from '../CameraMoves';
import { ASPECTS, BONE_LABEL, setCamTools } from '../CameraToolsCards';
import { ANGLE_DRAG, CamKeyList, keyCamera, reloadCam, useCam } from '../CameraPanel';
import { canRender, deleteShot, duplicate, fromAngle, lookThrough, patchShot, playShot, setTrans, splitAtPlayhead, STATUSES, TRANSITIONS, transProblem, useCurrentView, workOn } from './actions';

const MODES: { id: ShotCamMode; label: string; hint: string }[] = [
  { id: 'still', label: 'Still', hint: 'Its own camera: Studio’s view or an angle. With Play the edit on, Studio switches to it as the shot starts. (Camera keys in the shot win over it.)' },
  { id: 'keys', label: 'Keys', hint: 'The camera moves inside the shot by its camera keys (key it, or add a camera move across the shot).' },
  { id: 'pov', label: 'First person', hint: 'Through a character’s eyes, turning with the head. With Play the edit on, Studio switches to it for this shot.' },
  { id: 'follow', label: 'Follow', hint: 'Starts from the shot’s camera and keeps a body part in view as it moves.' },
];
const BONES = ['head', 'eyes', 'chest', 'hips', 'handL', 'handR', 'feet'];

/** Shoot › Shots: everything about the picked shot — its picture, name, status, timing, camera, frame and notes. */
export function ShotInspector({ shot, index }: { shot: Shot; index: number }) {
  const duration = useStore((s) => s.tl?.duration ?? 10);
  const fps = useStore((s) => s.tl?.fps ?? 30);
  const shots = useStore((s) => s.shots);
  const angles = useStore((s) => s.angles);
  const nodes = useStore((s) => s.nodes);
  const selection = useStore((s) => s.studioSelection);
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
  const keyed = useStore((s) => mode === 'still' && s.keyedShots.includes(shot.id));
  const inKeys = keys.filter((k) => k.t >= shot.start - 1e-4 && k.t < shot.end - 1e-4);
  const fov = shot.cam?.fov ?? st?.fov ?? 23;
  const frame = shot.aspect ?? 0;

  const setTime = (edge: 'start' | 'end', v: number) => saveShots(trimShot(shots, shot.id, edge, v, duration), 'Trim shot');
  const setLength = (v: number) => saveShots(trimShot(shots, shot.id, 'end', shot.start + Math.max(MIN_SHOT, v), duration), 'Trim shot');
  const moveTo = (v: number) => saveShots(moveShot(shots, shot.id, v, duration), 'Move shot');

  const charas = Object.values(nodes).filter((n) => n.type === 'Char');
  const setMode = async (m: ShotCamMode) => {
    if (m === mode) return;
    // first person / follow are about a character: the picked one, else the one picked in Studio, else the first
    const who = m === 'pov' || m === 'follow' ? (shot.who != null && nodes[shot.who] ? shot.who : (selection.find((id) => nodes[id]?.type === 'Char') ?? charas[0]?.id)) : shot.who;
    if ((m === 'pov' || m === 'follow') && who == null) return toast('Add a character to the scene first', 'error');
    if (!(await patchShot(shot.id, { camMode: m, who, bone: m === 'follow' ? shot.bone ?? 'head' : shot.bone }, `Shot camera: ${MODES.find((x) => x.id === m)!.label.toLowerCase()}`))) return;
    if (m === 'pov' || m === 'follow') await call('shots.view', { id: shot.id }); // see it now
    if (m === 'keys' && shot.cam && inKeys.length === 0 && st?.timeline) {
      // start the shot's camera keys from its still camera, so nothing jumps
      await seekNow(shot.start);
      await call('shots.view', { id: shot.id });
      await keyCamera(true, shot.start);
      toast('Camera keyed at the shot’s start. Move on, frame, and Key camera again');
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
    setCamTools({ guides: { aspect: a } }); // shown in Studio's window now (Off takes the frame away)
  };

  return (
    <div className="sq-insp">
      <div
        className={`sq-insp-pic ${drop ? 'drop' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(ANGLE_DRAG)) return;
          e.preventDefault();
          setDrop(true);
        }}
        onDragLeave={() => setDrop(false)}
        onDrop={(e) => {
          setDrop(false);
          const a = e.dataTransfer.getData(ANGLE_DRAG);
          if (a) void fromAngle(shot.id, a);
        }}
      >
        <button className="sq-insp-img" onClick={() => lookThrough(shot.id)} title={mode === 'keys' ? 'Go to the shot’s start' : 'Look through this shot’s camera'}>
          {shot.thumb && (mode === 'still' || mode === 'keys') ? <img src={shot.thumb} alt="" draggable={false} /> : <span>{MODES.find((x) => x.id === mode)!.label === 'Still' ? 'No camera yet — drop an angle here' : MODES.find((x) => x.id === mode)!.label}</span>}
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
            disabled={mode !== 'still' || !shot.cam}
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

        <div className="sq-insp-row sq-trans-row">
          <span className="sq-trans-label">
            Into this shot
            <Help text="How the edit gets into this shot from the one before. Cut: at once. Glide: the camera travels between the two shots' cameras. Dips: fade to a colour and back. Dissolve: the shot before fades into this one. Centred on the cut; plays with Play the edit: in Studio, on the monitor and in renders." />
          </span>
          <div className="seg" role="radiogroup" aria-label="Transition into this shot">
            {TRANSITIONS.map((t) => (
              <button key={t.id} role="radio" aria-checked={(shot.trans?.type ?? 'cut') === t.id} className={(shot.trans?.type ?? 'cut') === t.id ? 'on' : ''} title={t.hint} onClick={() => setTrans(shot.id, { type: t.id })}>
                <span className="sq-glyph">{t.glyph}</span> {t.label}
              </button>
            ))}
          </div>
          {shot.trans && shot.trans.type !== 'cut' && (
            <>
              <label className="sq-trans-len">
                <span>Length</span>
                <DragNumber value={shot.trans.dur} step={1 / fps} digits={2} unit=" s" min={0.05} max={5} onCommit={(v) => setTrans(shot.id, { dur: v })} title="How long the transition takes, centred on the cut" />
              </label>
              <div className="seg">
                <button className={shot.trans.ease !== 'linear' ? 'on' : ''} onClick={() => setTrans(shot.id, { ease: 'smooth' })} title="Ease in and out">
                  Smooth
                </button>
                <button className={shot.trans.ease === 'linear' ? 'on' : ''} onClick={() => setTrans(shot.id, { ease: 'linear' })} title="An even pace">
                  Linear
                </button>
              </div>
            </>
          )}
          {transProblem(shot) && <span className="sq-trans-warn">{transProblem(shot)}</span>}
        </div>

        <div className="sq-insp-cols">
          <div className="sq-insp-block">
            <div className="sq-insp-h">
              Camera
              <Help text="How this shot's camera works. Still: its own camera (Studio's view or an angle). Keys: it moves by camera keys. First person: through a character's eyes. Follow: keeps a body part in view. Play the edit switches to it as the shot starts." />
            </div>
            <div className="seg sq-mode" role="radiogroup" aria-label="Camera type">
              {MODES.map((m) => (
                <button key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} title={m.hint} disabled={m.id === 'keys' && !st?.timeline} onClick={() => setMode(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
            {mode === 'pov' || mode === 'follow' ? (
              <>
                <div className="sq-field">
                  <span>Character</span>
                  <select className="input" value={shot.who ?? ''} onChange={(e) => patchShot(shot.id, { who: Number(e.target.value) }, 'Shot character').then(() => call('shots.view', { id: shot.id }))}>
                    {charas.map((c) => (
                      <option key={c.id} value={c.id}>
                        {displayName(c)}
                      </option>
                    ))}
                  </select>
                </div>
                {mode === 'follow' && (
                  <div className="sq-field">
                    <span>Keep in view</span>
                    <div className="ct-chips" style={{ margin: 0 }}>
                      {BONES.map((b) => (
                        <button key={b} className={`btn chip ${(shot.bone ?? 'head') === b ? 'on' : ''}`} onClick={() => patchShot(shot.id, { bone: b }, 'Shot follows').then(() => call('shots.view', { id: shot.id }))}>
                          {BONE_LABEL[b] ?? b}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="sq-tip">{mode === 'pov' ? 'With Play the edit on, Studio looks through the character’s eyes for this shot, and back out at the next cut.' : 'It starts from the shot’s camera (Use current view sets it) and keeps the body part in view while you orbit.'}</div>
              </>
            ) : mode === 'still' ? (
              <>
                {keyed && (
                  <div className="sq-keyed">
                    This shot has camera keys, so it plays them — its still camera is only used where the camera isn’t keyed. Delete the keys in this shot (or set it to Keys) to make that clear.
                  </div>
                )}
                <div className="sq-field">
                  <span>Lens</span>
                  <Slider value={fov} min={10} max={90} step={0.5} onChange={(v) => (setFov(v), commitFovDebounced(v, commitFov))} />
                </div>
                <div className="sq-field top">
                  <span>Angle</span>
                  {angles.length ? (
                    <div className="sq-angles">
                      {angles.map((a) => (
                        <button key={a.id} className={`sq-angle ${shot.angle === a.id ? 'on' : ''}`} onClick={() => fromAngle(shot.id, a.id)} title={`Use the angle “${a.name}”`}>
                          {a.thumb ? <img src={a.thumb} alt="" draggable={false} /> : null}
                          <span>{a.name}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="sq-tip">Keep framings as angles (Angles, on the right) to reuse them across shots.</div>
                  )}
                </div>
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
              <Help text="The picture shape shown in Studio's window while this shot is on screen (with Play the edit on, or when you look through it). Off: no frame." />
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

import { useEffect, useMemo, useState } from 'react';
import { call, editTimeline, refreshShots, renderShots, saveShots, setLiveCuts, setSettings, toast, useStore } from '../../state/store';
import { byStart, covered, fixOverlaps, pastEnd, problems, trimToEnd } from '../../lib/shots';
import { ContextMenu, type MenuItem } from '../ContextMenu';
import { Help } from '../Help';
import { Icon } from '../Icon';
import { useCamLoader } from '../CameraPanel';
import { Monitor } from './Monitor';
import { AnglesBin } from './AnglesBin';
import { ShotTrack } from './ShotTrack';
import { ShotInspector } from './ShotInspector';
import { Storyboard, storyboardImage } from './Storyboard';
import { addShotAt, canRender } from './actions';

type View = 'track' | 'board';
const VIEW_KEY = 'kf.shots.view';

/**
 * Shoot › Shots & camera. The shots (a track along the timeline, or a storyboard), the picked shot's inspector
 * under them, and Studio's camera tools in a column on the right.
 */
export function ShotsPage() {
  const status = useStore((s) => s.status);
  const shots = useStore((s) => s.shots);
  const sel = useStore((s) => s.selShotId);
  const live = useStore((s) => s.liveCuts);
  const sceneName = useStore((s) => s.sceneName);
  const duration = useStore((s) => s.tl?.duration ?? 10);
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'track';
    } catch {
      return 'track';
    }
  });
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  useCamLoader();

  useEffect(() => {
    if (status === 'open') void refreshShots();
  }, [status]);

  const pick = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage blocked */
    }
  };

  const sorted = useMemo(() => byStart(shots), [shots]);
  const issues = useMemo(() => problems(shots), [shots]);
  const gaps = issues.filter((p) => p.kind === 'gap').length;
  const overlaps = issues.filter((p) => p.kind === 'overlap').length;
  const cur = sorted.find((s) => s.id === sel) ?? null;

  const bake = async () => {
    const n = await editTimeline<number>('shots.buildCuts', {});
    const live = shots.filter((s) => s.trans && (s.trans.type === 'dipBlack' || s.trans.type === 'dipWhite' || s.trans.type === 'dissolve')).length;
    if (n)
      toast(
        `Camera keys written for ${n} cut${n > 1 ? 's' : ''}.${live ? ` Dips and dissolves still need Play the edit.` : ''}`,
      );
    else if (n === 0) toast('The cuts are already in camera keys');
  };
  const exportBoard = async () => {
    if (!shots.length) return;
    const title = (sceneName ?? 'Storyboard').replace(/\.png$/i, '');
    const png = await storyboardImage(shots, title);
    const save = window.studioEx?.savePng;
    if (!save) return toast('Saving pictures works in the Keyframe Studio window');
    try {
      const path = await save(`${title} - storyboard`, png);
      if (path) toast(`Storyboard saved: ${path}`, 'done');
    } catch (e) {
      toast(`Couldn’t save the storyboard: ${(e as Error).message}`, 'error');
    }
  };
  const moreItems: MenuItem[] = [
    { label: 'Bake cuts into camera keys', action: bake },
    ...(canRender() ? [{ label: 'Render every shot', action: () => renderShots(sorted.map((s) => s.id)) }] : []),
    { label: 'Save the storyboard as a picture…', action: exportBoard },
    { label: 'New pictures for every shot', action: () => call<number>('shots.thumbs', {}).then((n) => n != null && toast(n ? `${n} picture${n > 1 ? 's' : ''} updated` : 'No still shots with a camera to take pictures of')) },
    ...(overlaps ? [{ label: 'Fix overlaps (each shot ends where the next starts)', action: () => saveShots(fixOverlaps(shots), 'Fix overlaps') }] : []),
  ];

  const past = pastEnd(shots, duration);
  const lastEnd = Math.max(0, ...shots.map((s) => s.end));
  const total = covered(trimToEnd(shots, duration));
  return (
    <div className="sq-page">
      <div className="sq-main">
        <header className="sq-head">
          <h2>
            Shots
            <Help text="A shot is a stretch of the timeline with its own camera. Lay them out on the track, give each a camera (Studio's current view, a saved view, or camera keys), and play: with Play the edit on, Studio switches cameras at every cut. Render can make one video per shot." />
          </h2>
          <span className="sq-sum">
            {shots.length ? (
              <>
                {shots.length} shot{shots.length === 1 ? '' : 's'} · {total.toFixed(1)} of {duration.toFixed(1)} s
                {gaps > 0 && <span className="sq-warn gap"> · {gaps} gap{gaps > 1 ? 's' : ''}</span>}
                {past.length > 0 && (
                  <span className="sq-warn past">
                    {' · '}
                    {past.length === 1 ? `${past[0].name} runs` : `${past.length} shots run`} past the end —{' '}
                    <button className="sq-fix" onClick={() => saveShots(trimToEnd(shots, duration), 'Trim shots to the timeline')} title="Each shot ends by the end of the timeline; shots that would start past it are removed (Ctrl+Z brings them back)">
                      trim to {duration.toFixed(1)} s
                    </button>{' '}
                    or{' '}
                    <button className="sq-fix" onClick={() => setSettings({ duration: Math.ceil(lastEnd * 10) / 10 })} title="Make the timeline long enough for every shot">
                      make the timeline {(Math.ceil(lastEnd * 10) / 10).toFixed(1)} s
                    </button>
                  </span>
                )}
                {overlaps > 0 && (
                  <button className="sq-warn overlap" onClick={() => saveShots(fixOverlaps(shots), 'Fix overlaps')} title="Two shots claim the same time. Click to make each end where the next starts">
                    · {overlaps} overlap{overlaps > 1 ? 's' : ''} — fix
                  </button>
                )}
              </>
            ) : (
              'No shots yet'
            )}
          </span>
          <span className="sq-head-gap" />
          <div className="seg sq-viewpick" role="tablist" aria-label="Show shots as">
            <button role="tab" aria-selected={view === 'track'} className={view === 'track' ? 'on' : ''} onClick={() => pick('track')} title="Along the timeline: move, trim and cut">
              <Icon name="tracks" size={13} /> Track
            </button>
            <button role="tab" aria-selected={view === 'board'} className={view === 'board' ? 'on' : ''} onClick={() => pick('board')} title="Big pictures with notes: plan and reorder">
              <Icon name="grid" size={13} /> Storyboard
            </button>
          </div>
          <button
            className={`sq-live ${live ? 'on' : ''}`}
            role="switch"
            aria-checked={live}
            disabled={status !== 'open'}
            onClick={() => setLiveCuts(!live)}
            title={
              live
                ? 'Play the edit is on: Studio’s view (playing and scrubbing), the monitor and renders all follow the shots — their cameras, cuts and transitions. Shots with camera keys play their keys. Click to turn off'
                : 'Play the edit is off: Studio, the monitor and renders play the timeline’s own camera and ignore the shots. Click to turn on'
            }
          >
            <span className="sq-live-dot" />
            Play the edit
          </button>
          <button className="btn small primary" disabled={status !== 'open'} onClick={() => addShotAt()} title="A shot from the playhead to the next shot (or 3 s), with Studio's camera as it is now">
            <Icon name="plus" size={12} /> Shot at playhead
          </button>
          <button className="btn small solid icon-only" aria-label="More shot actions" disabled={!shots.length} onClick={(e) => setMore({ x: e.clientX, y: e.clientY })} title="Bake cuts, render, save the storyboard…">
            <Icon name="more" size={14} />
          </button>
        </header>

        {view === 'track' ? <ShotTrack /> : <Storyboard />}

        {cur ? (
          <ShotInspector key={cur.id} shot={cur} index={sorted.indexOf(cur)} />
        ) : (
          shots.length > 0 && (
            <div className="sq-nopick">
              Pick a shot to edit it. <span>Drag shots to move them, drag an edge to trim, drag past a neighbour to swap. Double-click a shot to look through it; drag an angle onto a shot to give it that camera, or onto the empty track for a new shot.</span>
            </div>
          )
        )}
        {!shots.length && status === 'open' && (
          <div className="sq-start">
            <b>Plan the edit</b>
            <ol>
              <li>
                Frame a view in Studio and keep it as an angle (<b>Angles › + From Studio’s view</b>). Make one for each camera position.
              </li>
              <li>Drag an angle onto the track where the shot should be — or put the playhead there and press <b>+ Shot at playhead</b>.</li>
              <li>Press play: with Play the edit on, Studio, the monitor and renders switch cameras at every cut.</li>
            </ol>
          </div>
        )}
      </div>
      <aside className="sq-side">
        <Monitor />
        <AnglesBin />
      </aside>
      {more && <ContextMenu x={more.x} y={more.y} items={moreItems} onClose={() => setMore(null)} />}
    </div>
  );
}

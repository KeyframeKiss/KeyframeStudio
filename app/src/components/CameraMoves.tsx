import { useEffect, useState } from 'react';
import { Field, Panel } from './Page';
import { call, liveTime, refreshTimeline, seekNow, toast, togglePlay, useStore } from '../state/store';
import { Slider } from './CharacterPanel';

type Move = 'orbit' | 'dolly' | 'zoom' | 'pan' | 'crane' | 'truck';

/** Each move: two directions, the amount slider and how it maps to the plugin's `amount`. */
const MOVES: Record<Move, { label: string; hint: string; dirs: [string, string]; min: number; max: number; step: number; def: number; unit: string; amount: (v: number, first: boolean) => number }> = {
  orbit: { label: 'Orbit', hint: 'Circle around the subject', dirs: ['Left', 'Right'], min: 15, max: 360, step: 15, def: 90, unit: '°', amount: (v, l) => (l ? v : -v) },
  dolly: { label: 'Dolly', hint: 'Move the camera closer or further', dirs: ['In', 'Out'], min: 10, max: 80, step: 5, def: 35, unit: '%', amount: (v, i) => (i ? 1 - v / 100 : 1 + v / 100) },
  zoom: { label: 'Zoom', hint: 'Change the lens; the camera stays put (flatter look than a dolly)', dirs: ['In', 'Out'], min: 10, max: 80, step: 5, def: 35, unit: '%', amount: (v, i) => (i ? 1 - v / 100 : 1 + v / 100) },
  pan: { label: 'Pan', hint: 'Turn the camera where it stands', dirs: ['Left', 'Right'], min: 5, max: 120, step: 5, def: 30, unit: '°', amount: (v, l) => (l ? v : -v) },
  crane: { label: 'Crane', hint: 'Rise or sink while keeping the subject in frame', dirs: ['Up', 'Down'], min: 10, max: 150, step: 10, def: 50, unit: '%', amount: (v, u) => (u ? v / 100 : -v / 100) },
  truck: { label: 'Truck', hint: 'Slide sideways, looking the same way', dirs: ['Left', 'Right'], min: 10, max: 150, step: 10, def: 50, unit: '%', amount: (v, l) => (l ? -v / 100 : v / 100) },
};

/**
 * Camera move presets: frame the start in Studio, pick a move, and the keys are written for you. With `start` (a
 * shot's start) the move begins there instead of at the playhead, and `length` sets its default length.
 */
export function CameraMoves({ onDone, start, length, title = 'Camera moves', bare }: { onDone: () => void; start?: number; length?: number; title?: string; bare?: boolean }) {
  const duration = useStore((s) => s.tl?.duration ?? 10);
  const [move, setMove] = useState<Move>('orbit');
  const [first, setFirst] = useState(true);
  const [amounts, setAmounts] = useState<Record<Move, number>>(() => Object.fromEntries(Object.entries(MOVES).map(([k, m]) => [k, m.def])) as Record<Move, number>);
  const [secs, setSecs] = useState(length ? Math.round(length * 100) / 100 : 3);
  useEffect(() => {
    if (length) setSecs(Math.round(length * 100) / 100);
  }, [length]);
  const [smooth, setSmooth] = useState(true);
  const [last, setLast] = useState<{ t0: number; t1: number } | null>(null);
  const m = MOVES[move];

  const add = async () => {
    const t0 = start ?? liveTime();
    const r = await call<{ t0: number; t1: number; keys: number; replaced: number }>('camera.move', { preset: move, amount: m.amount(amounts[move], first), duration: secs, t0, ease: smooth ? 'smooth' : 'linear' });
    if (!r) return;
    setLast({ t0: r.t0, t1: r.t1 });
    toast(`${m.label} ${m.dirs[first ? 0 : 1].toLowerCase()} keyed ${r.t0.toFixed(2)}s → ${r.t1.toFixed(2)}s${r.replaced ? ` (replaced ${r.replaced} camera keys in between)` : ''} — Ctrl+Z to undo`);
    await refreshTimeline();
    onDone();
  };

  const preview = async () => {
    if (!last) return;
    await seekNow(last.t0);
    if (!useStore.getState().tl?.playing) togglePlay();
  };

  const help = `A ready-made move starting from the camera as it is ${start != null ? 'at the shot\'s start' : 'now'}. ${m.hint}. ${move === 'crane' || move === 'truck' ? 'Distance is relative to how far the camera is from its subject. ' : ''}Camera keys inside the move are replaced.`;
  const body = (
    <>
      <div className="cam-moves">
        {(Object.keys(MOVES) as Move[]).map((k) => (
          <button key={k} className={`btn solid ${move === k ? 'on' : ''}`} title={MOVES[k].hint} onClick={() => setMove(k)}>
            {MOVES[k].label}
          </button>
        ))}
      </div>
      <Field label="Direction">
        <div className="seg">
          {m.dirs.map((d, i) => (
            <button key={d} className={(i === 0) === first ? 'on' : ''} onClick={() => setFirst(i === 0)}>
              {d}
            </button>
          ))}
        </div>
      </Field>
      <Field label={`${move === 'crane' || move === 'truck' ? 'Distance' : 'Amount'} (${m.unit})`}>
        <Slider value={amounts[move]} min={m.min} max={m.max} step={m.step} onChange={(v) => setAmounts((a) => ({ ...a, [move]: v }))} />
      </Field>
      <Field label="Length (s)">
        <input className="input mono" type="number" min={0.2} max={duration} step={0.5} value={secs} onChange={(e) => setSecs(Number(e.target.value))} style={{ width: 64, flex: 'none' }} />
        <div className="seg">
          <button className={smooth ? 'on' : ''} onClick={() => setSmooth(true)} title="Ease in and out">
            Smooth
          </button>
          <button className={!smooth ? 'on' : ''} onClick={() => setSmooth(false)} title="Constant speed">
            Linear
          </button>
        </div>
      </Field>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn primary" style={{ flex: 1 }} disabled={!(secs > 0)} onClick={add} title={start != null ? 'Starts at the shot\'s start, from the camera there' : 'Starts from the camera as it is now, at the playhead'}>
          Add {m.label.toLowerCase()} {start != null ? 'across the shot' : 'at playhead'}
        </button>
        <button className="btn solid" disabled={!last} onClick={preview} title="Play the last move from its start">
          ▶ Preview
        </button>
      </div>
    </>
  );
  return bare ? (
    body
  ) : (
    <Panel title={title} help={help}>
      {body}
    </Panel>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { bridge } from '../bridge/client';
import { call, displayName, liveTime, parseKeyId, refreshTimeline, selectedCharacters, toast, useStore } from '../state/store';
import { NumberField } from './TopBar';
import { IconTile, SwitchCard } from './EditorBits';

export type Limb = 'footL' | 'footR' | 'handL' | 'handR';
export const LIMBS: { id: Limb; label: string }[] = [
  { id: 'footL', label: 'Left foot' },
  { id: 'footR', label: 'Right foot' },
  { id: 'handL', label: 'Left hand' },
  { id: 'handR', label: 'Right hand' },
];
const limbLabel = (l: Limb) => LIMBS.find((x) => x.id === l)?.label ?? l;

/** The foot a sliding bone belongs to (foot or toes, left or right). */
export const limbOfBone = (bone: string): Limb | null => (bone.endsWith('_L') ? 'footL' : bone.endsWith('_R') ? 'footR' : null);

interface LockState {
  running: Limb | null;
  progress: number;
}
const useLock = create<LockState>(() => ({ running: null, progress: 0 }));

/** Listen once for the bridge's lock progress and result. */
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  bridge.on('motion.lock', (d) => {
    const r = d as { progress?: number; done?: boolean; error?: string; keys?: number; converted?: boolean; limb?: Limb; outOfReach?: { from: number; short: number } };
    if (!r.done) return useLock.setState({ progress: r.progress ?? 0 });
    const limb = useLock.getState().running;
    useLock.setState({ running: null, progress: 0 });
    if (r.error) return toast(r.error, 'error');
    void refreshTimeline();
    const l = r.limb ?? limb ?? 'footL';
    const what = limbLabel(l);
    if (r.outOfReach) {
      const part = l.startsWith('hand') ? 'arm' : 'leg';
      return toast(
        `${what} locked, but out of the ${part}'s reach from ${r.outOfReach.from.toFixed(2)} s. Try a shorter range`,
        'error',
      );
    }
    toast(
      r.converted
        ? `${what} locked (${r.keys} keys), switched from FK to IK`
        : `${what} locked (${r.keys} keys)`,
      'done',
    );
  });
}

/** Start a lock: the limb stays where it is at `at` (default t0) from t0 to t1. */
export async function lockLimb(args: { id: number; limb: Limb; t0: number; t1: number; at?: number; rotation?: boolean; blend?: number }) {
  listen();
  if (useLock.getState().running) return;
  useLock.setState({ running: args.limb, progress: 0 });
  const r = await call<{ samples: number; convert: boolean }>('motion.lock', args);
  if (!r) useLock.setState({ running: null, progress: 0 });
}

/** The range of the selected keys, if any. */
function selectedRange(): [number, number] | null {
  const ids = [...useStore.getState().selKeys];
  if (ids.length < 2) return null;
  const ts = ids.map((id) => parseKeyId(id).t);
  const a = Math.min(...ts);
  const b = Math.max(...ts);
  return b - a > 1e-3 ? [a, b] : null;
}

/** Animate › Cleanup › Lock a foot or hand (a tool row, like the others on the page). */
export function LimbLockSection() {
  const status = useStore((s) => s.status);
  const tl = useStore((s) => s.tl);
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  const selKeys = useStore((s) => s.selKeys);
  useStore((s) => s.showEnglish);
  const chars = useMemo(() => selectedCharacters(), [selection, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const { running, progress } = useLock();
  const [limb, setLimb] = useState<Limb>('footL');
  const [t0, setT0] = useState(0);
  const [t1, setT1] = useState(1);
  const [rotation, setRotation] = useState(true);
  const [blend, setBlend] = useState(0.25);
  const fps = tl?.fps ?? 30;
  const dur = tl?.duration ?? 10;
  const snap = (t: number) => Math.min(dur, Math.max(0, Math.round(t * fps) / fps));

  useEffect(listen, []);
  // start from the selected keys' range when there is one
  useEffect(() => {
    const r = selectedRange();
    if (r) {
      setT0(snap(r[0]));
      setT1(snap(r[1]));
    }
  }, [selKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  const fromPlayhead = () => {
    const t = snap(liveTime());
    setT0(t);
    if (t1 <= t) setT1(snap(Math.min(dur, t + 1)));
  };
  const toPlayhead = () => {
    const t = snap(liveTime());
    setT1(t);
    if (t0 >= t) setT0(snap(Math.max(0, t - 1)));
  };
  const range = selectedRange();
  const valid = t1 - t0 >= 1 / fps - 1e-6;
  const who = chars.length ? displayName(nodes[chars[0]]) : null;
  const disabled = status !== 'open' || !tl || !chars.length || !valid || !!running;
  const fmt = (v: number) => `${v.toFixed(2)} s`;
  const parse = (s: string) => {
    const v = Number(s.replace(/s$/i, '').trim());
    return Number.isFinite(v) ? snap(v) : null;
  };

  return (
    <section className="tool">
      <div className="tool-about">
        <IconTile name="pin" />
        <div>
          <h3>Lock a foot or hand</h3>
          <p>Keeps it on one spot while the body moves: no sliding feet, a hand that stays on the table. Keys its IK target; a limb posed with FK switches to IK with its motion kept.</p>
        </div>
      </div>
      <div className="tool-body">
        <div className="ed-fields">
          <label>
            Limb
            <div className="seg">
              {LIMBS.map((l) => (
                <button key={l.id} className={limb === l.id ? 'on' : ''} onClick={() => setLimb(l.id)}>
                  {l.label}
                </button>
              ))}
            </div>
          </label>
        </div>
        <div className="ed-fields">
          <label>
            From
            <div className="ed-pair">
              <NumberField value={t0} format={fmt} parse={parse} onCommit={(v) => setT0(Math.min(v, t1))} />
              <button className="btn small solid" onClick={fromPlayhead} title="Start at the playhead">
                Playhead
              </button>
            </div>
          </label>
          <label>
            To
            <div className="ed-pair">
              <NumberField value={t1} format={fmt} parse={parse} onCommit={(v) => setT1(Math.max(v, t0))} />
              <button className="btn small solid" onClick={toPlayhead} title="End at the playhead">
                Playhead
              </button>
            </div>
          </label>
          {range && (
            <button className="btn small solid" onClick={() => (setT0(snap(range[0])), setT1(snap(range[1])))} title="Use the first and last selected key">
              Selected keys ({range[0].toFixed(2)}–{range[1].toFixed(2)} s)
            </button>
          )}
        </div>
        <div className="ed-fields">
          <label>
            Let go
            <div className="seg">
              {[
                [0, 'At once'],
                [0.1, '0.1 s'],
                [0.25, '0.25 s'],
                [0.5, '0.5 s'],
              ].map(([v, label]) => (
                <button key={v} className={blend === v ? 'on' : ''} onClick={() => setBlend(v as number)} title={v ? `After the range, ease back into its own motion over ${label}` : 'Jump straight back to its own motion after the range'}>
                  {label}
                </button>
              ))}
            </div>
          </label>
          <SwitchCard on={rotation} label="Keep its angle too" hint="Holds how it's turned, not only where it is" onChange={setRotation} />
        </div>
        <div className="tool-actions">
          <button
            className="btn solid"
            disabled={disabled}
            onClick={() => chars.length && lockLimb({ id: chars[0], limb, t0, t1, rotation, blend })}
            title={who ? `${who}'s ${limbLabel(limb).toLowerCase()} stays where it is at ${t0.toFixed(2)} s until ${t1.toFixed(2)} s` : 'Select a character first'}
          >
            {running ? `Locking ${limbLabel(running).toLowerCase()}… ${Math.round(progress * 100)}%` : !chars.length ? 'Select a character to lock' : `Lock ${limbLabel(limb).toLowerCase()}, ${t0.toFixed(2)}–${t1.toFixed(2)} s`}
          </button>
        </div>
      </div>
    </section>
  );
}

/** Small "Lock" button for a foot-sliding range found by the check. */
export function LockSlideButton({ id, bone, t0, t1 }: { id: number; bone: string; t0: number; t1: number }) {
  const running = useLock((s) => s.running);
  const limb = limbOfBone(bone);
  if (!limb) return null;
  return (
    <button className="btn small solid" disabled={!!running} onClick={() => lockLimb({ id, limb, t0, t1, at: t0 })} title={`Keep the ${limbLabel(limb).toLowerCase()} where it is at ${t0.toFixed(2)} s until ${t1.toFixed(2)} s`}>
      Lock
    </button>
  );
}

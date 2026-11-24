import { useEffect, useMemo, useState } from 'react';
import { Help } from './Help';
import { Icon } from './Icon';
import { bridge } from '../bridge/client';
import type { WireTrack } from '../bridge/types';
import { findPops, footSlides, popCulprits, smoothKeys, type Attrs, type KeyVal, type SlideRange } from '../lib/motion';
import { call, displayName, editTimeline, keyId, liveTime, parseKeyId, seek, selectedCharacters, selectKeys, selectTracks, showTab, toast, useStore } from '../state/store';
import { Slider } from './CharacterPanel';
import { LimbLockSection, LockSlideButton } from './LimbLock';
import { IconTile } from './EditorBits';

type Values = Record<string, [number, Attrs][]>;

/** The keys the tools work on: selected keys, else every key of the selected tracks. */
function useScope() {
  const selKeys = useStore((s) => s.selKeys);
  const selTracks = useStore((s) => s.selTracks);
  const tracks = useStore((s) => s.tracks);
  return useMemo(() => {
    const byTrack = new Map<number, Set<number>>(); // track → chosen key times
    if (selKeys.size) {
      for (const id of selKeys) {
        const r = parseKeyId(id);
        if (!byTrack.has(r.track)) byTrack.set(r.track, new Set());
        byTrack.get(r.track)!.add(r.t);
      }
    } else for (const id of selTracks) byTrack.set(id, new Set(tracks.find((t) => t.id === id)?.keys.map((k) => k[0]) ?? []));
    const list = [...byTrack].map(([id, times]) => ({ track: tracks.find((t) => t.id === id), times })).filter((x): x is { track: WireTrack; times: Set<number> } => !!x.track);
    const keys = list.reduce((n, x) => n + x.times.size, 0);
    return { list, keys, fromKeys: selKeys.size > 0 };
  }, [selKeys, selTracks, tracks]);
}

const loadValues = (ids: number[]) => call<Values>('timeline.keyValues', { tracks: ids });
const toKeys = (rows: [number, Attrs][] | undefined): KeyVal[] => (rows ?? []).map(([t, attrs]) => ({ t, attrs }));
const sameT = (a: number, b: number) => Math.abs(a - b) < 1e-4;
const numeric = (k: KeyVal[]) => k.length > 0 && Object.keys(k[0].attrs).length > 0;

/**
 * Animate › Cleanup: lock a foot or hand, smooth, retime, make loops, find sudden moves and foot sliding.
 * Each tool is a row: what it does on the left, its settings and button on the right. Every fix is one undo step.
 */
export function CleanupPanel() {
  const scope = useScope();
  const tl = useStore((s) => s.tl);
  const status = useStore((s) => s.status);
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  useStore((s) => s.showEnglish);
  const chars = useMemo(() => selectedCharacters(), [selection, nodes]); // eslint-disable-line react-hooks/exhaustive-deps

  const [strength, setStrength] = useState(0.5);
  const [passes, setPasses] = useState(1);
  const [factor, setFactor] = useState(150);
  const [pivotAt, setPivotAt] = useState<'first' | 'playhead'>('first');
  const [loopEnd, setLoopEnd] = useState<'last' | 'end'>('last');
  const [pops, setPops] = useState<{ track: WireTrack; t: number; ratio: number }[] | null>(null);
  const [slides, setSlides] = useState<SlideRange[] | null>(null);
  const [sampling, setSampling] = useState(false);
  const [sampledFor, setSampledFor] = useState<number | null>(null);
  const busy = status !== 'open' || !tl;

  // ---------------- smooth ----------------
  const smooth = async (only?: { track: number; times: number[] }[], fix = false) => {
    const targets = only ?? scope.list.map((x) => ({ track: x.track.id, times: [...x.times] }));
    if (!targets.length) return toast('Select keys or tracks first');
    const vals = await loadValues(targets.map((x) => x.track));
    if (!vals) return;
    const edits: { track: number; t: number; value: Attrs }[] = [];
    for (const x of targets) {
      const keys = toKeys(vals[String(x.track)]);
      if (!numeric(keys)) continue;
      const chosen = new Set(keys.map((k, i) => (x.times.some((t) => sameT(t, k.t)) ? i : -1)).filter((i) => i >= 0));
      // a fix puts a stray key right back on its neighbours' line; Smooth uses the chosen strength/passes
      for (const [i, v] of smoothKeys(keys, chosen, fix ? 1 : strength, fix ? 1 : passes)) edits.push({ track: x.track, t: keys[i].t, value: v });
    }
    if (!edits.length) return toast('Pick keys between the first and last to smooth');
    const n = await editTimeline<number>('timeline.setKeyValues', { edits, label: fix ? 'Fix sudden moves' : 'Smooth keys' });
    if (n) toast(`${fix ? 'Fixed' : 'Smoothed'} ${n} key${n > 1 ? 's' : ''} — Ctrl+Z to undo`);
  };

  // ---------------- retime ----------------
  const retime = async (pct: number) => {
    if (!scope.fromKeys) return toast('Select the keys to retime (drag a box in the dope sheet)');
    const refs = scope.list.flatMap((x) => [...x.times].map((t) => ({ track: x.track.id, t })));
    const pivot = pivotAt === 'playhead' ? liveTime() : Math.min(...refs.map((r) => r.t));
    const f = pct / 100;
    const fps = tl?.fps ?? 0;
    const map = (t: number) => {
      const to = pivot + (t - pivot) * f;
      return fps ? Math.round(to * fps) / fps : to;
    };
    const n = await editTimeline<number>('timeline.scaleKeys', { keys: refs, factor: f, pivot, fps }, refs.map((r) => ({ track: r.track, t: map(r.t) })));
    if (n) toast(`${pct > 100 ? 'Slowed down' : 'Sped up'} ${n} key${n > 1 ? 's' : ''} (${pct}%) — Ctrl+Z to undo`);
  };

  // ---------------- loop ----------------
  const makeLoop = async () => {
    if (!scope.list.length) return toast('Select the tracks (or keys) to loop');
    const ids = scope.list.map((x) => x.track.id);
    const end = loopEnd === 'end' ? (tl?.duration ?? 10) : Math.max(...scope.list.map((x) => x.track.keys.slice(-1)[0]?.[0] ?? 0));
    const n = await editTimeline<number>('timeline.makeLoop', { tracks: ids, end });
    if (n) toast(`Loop closed on ${n} track${n > 1 ? 's' : ''}: the last pose matches the first`);
    else if (n === 0) toast('Nothing to loop — each track needs a key before the loop end');
  };

  // ---------------- sudden moves ----------------
  const findSudden = async () => {
    const targets = scope.list.length ? scope.list.map((x) => x.track) : useStore.getState().tracks.filter((t) => t.keys.length >= 4);
    if (!targets.length) return toast('No animated tracks to check');
    const vals = await loadValues(targets.map((t) => t.id));
    if (!vals) return;
    const found: { track: WireTrack; t: number; ratio: number }[] = [];
    for (const tr of targets) {
      const keys = toKeys(vals[String(tr.id)]);
      if (!numeric(keys)) continue;
      const pops = findPops(keys);
      // report the stray key behind each sudden move (one spike = one key, not its two segments)
      for (const i of popCulprits(keys, pops)) {
        const ratio = Math.max(...pops.filter((p) => p.index === i || p.index === i - 1).map((p) => p.ratio), 0);
        found.push({ track: tr, t: keys[i].t, ratio });
      }
    }
    found.sort((a, b) => b.ratio - a.ratio);
    setPops(found);
    if (!found.length) toast(`No sudden moves in ${targets.length} track${targets.length > 1 ? 's' : ''}`);
  };

  const fixPop = (p: { track: WireTrack; t: number }) => smooth([{ track: p.track.id, times: [p.t] }], true).then(() => setPops((l) => l?.filter((x) => x !== p) ?? null));

  // ---------------- foot sliding ----------------
  useEffect(
    () =>
      bridge.on('motion.sample', (d) => {
        const r = d as { error?: string; times: number[]; bones: Record<string, number[][]>; height: number };
        setSampling(false);
        if (r.error) return toast(r.error, 'error');
        // toes only add something when the heel is up: keep a toe range only if its foot isn't already sliding then
        const all = footSlides(r.times, r.bones, r.height);
        const feet = all.filter((x) => x.bone.startsWith('cf_j_foot'));
        const side = (b: string) => b.slice(-1);
        const found = [...feet, ...all.filter((x) => x.bone.startsWith('cf_j_toes') && !feet.some((f) => side(f.bone) === side(x.bone) && f.t0 < x.t1 && x.t0 < f.t1))].sort((a, b) => a.t0 - b.t0);
        setSlides(found);
        if (!found.length) toast('No foot sliding found');
      }),
    [],
  );
  const checkFeet = async () => {
    if (!chars.length) return toast('Select the character to check');
    setSlides(null);
    setSampledFor(chars[0]);
    const n = await call<number>('motion.sample', { id: chars[0], bones: ['cf_j_foot_L', 'cf_j_foot_R', 'cf_j_toes_L', 'cf_j_toes_R'], rate: 20 });
    if (n) setSampling(true);
  };

  const scopeTitle = scope.list.length ? `${scope.keys} key${scope.keys === 1 ? '' : 's'} on ${scope.list.length} track${scope.list.length > 1 ? 's' : ''}` : 'Nothing selected';
  const boneLabel = (b: string) => ({ cf_j_foot_L: 'Left foot', cf_j_foot_R: 'Right foot', cf_j_toes_L: 'Left toes', cf_j_toes_R: 'Right toes' })[b] ?? b;
  const slideVerb = (b: string) => (b.includes('toes') ? 'slide' : 'slides');
  const tracks = useStore((s) => s.tracks);
  const charTracks = chars.length ? tracks.filter((t) => t.oci === chars[0] && t.keys.length > 1) : [];

  return (
    <div className="cleanup-page">
      <header className="ed-head ed-scope">
        <IconTile name="key" />
        <div className="ed-title">
          <b>
            {scopeTitle}
            <Help text="Smooth, Retime and Loop work on the keys selected in the timeline, or on every key of the selected tracks (Retime needs keys). Lock and Find problems work on the selected character." />
          </b>
        </div>
        <div className="ed-pair">
          {charTracks.length > 0 && (
            <button className="btn small solid" onClick={() => selectTracks(charTracks.map((t) => t.id))} title="Select every animated track of this character">
              All of {displayName(nodes[chars[0]])}'s tracks
            </button>
          )}
          <button className="btn small solid" onClick={() => showTab('animate', 'timeline')} title="Open the timeline to select keys or tracks">
            <Icon name="tracks" size={12} />
            Select in the timeline
          </button>
        </div>
      </header>

      <LimbLockSection />

      <section className="tool">
        <div className="tool-about">
          <IconTile name="pulse" />
          <h3>
            Smooth
            <Help text="Each key moves toward the line between its neighbours, taking out jitter. A track's first and last keys stay put." />
          </h3>
        </div>
        <div className="tool-body">
          <div className="ed-fields">
            <label className="tool-slider">
              Strength
              <Slider value={strength} min={0.1} max={1} step={0.05} onChange={setStrength} />
            </label>
            <label>
              Passes
              <div className="seg">
                {[1, 2, 3, 5].map((p) => (
                  <button key={p} className={passes === p ? 'on' : ''} onClick={() => setPasses(p)}>
                    {p}
                  </button>
                ))}
              </div>
            </label>
          </div>
          <div className="tool-actions">
            <button className="btn solid" disabled={busy || !scope.list.length} onClick={() => smooth()}>
              {scope.list.length ? `Smooth ${scope.keys} key${scope.keys === 1 ? '' : 's'}` : 'Smooth (select keys first)'}
            </button>
          </div>
        </div>
      </section>

      <section className="tool">
        <div className="tool-about">
          <IconTile name="sliders" />
          <h3>
            Retime
            <Help text="Stretch or squeeze the selected keys in time, around the first key or the playhead. Over 100% is slower. Keys snap to frames. Select the keys in the timeline first (drag a box in the dope sheet)." />
          </h3>
        </div>
        <div className="tool-body">
          <div className="ed-fields">
            <label>
              Around
              <div className="seg">
                <button className={pivotAt === 'first' ? 'on' : ''} onClick={() => setPivotAt('first')} title="The first selected key stays where it is">
                  First key
                </button>
                <button className={pivotAt === 'playhead' ? 'on' : ''} onClick={() => setPivotAt('playhead')} title="Keys stretch away from or toward the playhead">
                  Playhead
                </button>
              </div>
            </label>
            <label>
              Length
              <div className="ed-pair">
                {[50, 75, 125, 150, 200].map((p) => (
                  <button key={p} className="btn small solid" disabled={busy || !scope.fromKeys} onClick={() => retime(p)} title={p > 100 ? `Take ${p / 100}× as long (slower)` : `Take ${p / 100}× as long (faster)`}>
                    {p}%
                  </button>
                ))}
              </div>
            </label>
            <label>
              Other
              <div className="ed-pair">
                <input className="input mono small" type="number" min={5} max={1000} step={5} value={factor} onChange={(e) => setFactor(Number(e.target.value))} style={{ width: 64 }} aria-label="Length in percent" />
                <button className="btn small solid" disabled={busy || !scope.fromKeys || !(factor > 0) || factor === 100} onClick={() => retime(factor)}>
                  Apply {factor > 0 ? `${factor}%` : ''}
                </button>
              </div>
            </label>
          </div>
        </div>
      </section>

      <section className="tool">
        <div className="tool-about">
          <IconTile name="redo" />
          <h3>
            Loop
            <Help text="Each track ends on the value it starts with, so the animation repeats without a jump." />
          </h3>
        </div>
        <div className="tool-body">
          <div className="ed-fields">
            <label>
              End at
              <div className="seg">
                <button className={loopEnd === 'last' ? 'on' : ''} onClick={() => setLoopEnd('last')} title="The latest key of the selected tracks">
                  Last key
                </button>
                <button className={loopEnd === 'end' ? 'on' : ''} onClick={() => setLoopEnd('end')} title="The end of the timeline">
                  Timeline end
                </button>
              </div>
            </label>
          </div>
          <div className="tool-actions">
            <button className="btn solid" disabled={busy || !scope.list.length} onClick={makeLoop}>
              {scope.list.length ? `Make ${scope.list.length} track${scope.list.length > 1 ? 's' : ''} loop` : 'Make loop (select tracks first)'}
            </button>
          </div>
        </div>
      </section>

      <section className="tool">
        <div className="tool-about">
          <IconTile name="search" />
          <h3>
            Find problems
            <Help text="Keys that jump much faster than their neighbours, and feet that drift while they're on the ground. Click one to go there." />
          </h3>
        </div>
        <div className="tool-body tool-finds">
          <div className="ed-group">
            <h4>Sudden moves</h4>
            <div className="tool-actions">
              <button className="btn solid" disabled={busy} onClick={findSudden} title="Moves much faster than the rest of that track: usually a stray key">
                {scope.list.length ? 'Check the selection' : 'Check all tracks'}
              </button>
              {pops && pops.length > 1 && (
                <button className="btn solid" onClick={() => smooth(pops.map((p) => ({ track: p.track.id, times: [p.t] })), true).then(() => setPops([]))}>
                  Fix all {pops.length}
                </button>
              )}
            </div>
            {pops && pops.length > 0 && (
              <div className="ed-list">
                {pops.slice(0, 50).map((p) => (
                  <div key={`${p.track.id}|${p.t}`} className="ed-item">
                    <button
                      className="ed-jump"
                      onClick={() => {
                        seek(p.t);
                        selectKeys([keyId(p.track.id, p.t)]);
                      }}
                      title="Go there and select the key"
                    >
                      <b>{displayName(p.track)}</b>
                      <small>
                        Key at {p.t.toFixed(2)} s, {p.ratio.toFixed(0)}× faster than usual
                      </small>
                    </button>
                    <button className="btn small solid" onClick={() => fixPop(p)} title="Put this key back on the line between its neighbours">
                      Fix
                    </button>
                  </div>
                ))}
              </div>
            )}
            {pops && pops.length === 0 && <div className="tool-hint">No sudden moves.</div>}
          </div>
          <div className="ed-group">
            <h4>Foot sliding</h4>
            <div className="tool-actions">
              <button className="btn solid" disabled={busy || sampling || !chars.length} onClick={checkFeet} title="Plays through the timeline (Studio pauses for a moment) and looks for feet that slide while on the ground">
                {sampling ? 'Checking feet…' : chars.length ? `Check ${displayName(nodes[chars[0]])}'s feet` : 'Check feet (select a character)'}
              </button>
            </div>
            {slides && slides.length > 0 && (
              <div className="ed-list">
                {slides.map((s, i) => (
                  <div key={i} className="ed-item">
                    <button className="ed-jump" onClick={() => seek(s.t0)} title="Go there">
                      <b>
                        {boneLabel(s.bone)} {slideVerb(s.bone)}
                      </b>
                      <small>
                        {s.t0.toFixed(2)} – {s.t1.toFixed(2)} s, {s.distance.toFixed(3)} units
                      </small>
                    </button>
                    {sampledFor != null && <LockSlideButton id={sampledFor} bone={s.bone} t0={s.t0} t1={s.t1} />}
                  </div>
                ))}
              </div>
            )}
            {slides && slides.length === 0 && <div className="tool-hint">No foot sliding.</div>}
          </div>
        </div>
      </section>
    </div>
  );
}

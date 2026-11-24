import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tokenRgba } from '../lib/theme';
import { Help } from './Help';
import { Slider } from './CharacterPanel';
import { Secs } from './AudioPage';
import { bridge } from '../bridge/client';
import { audioName, call, displayName, listenAudio, liveTime, pickAudio, showTab, toast, useStore, type AudioClipInfo } from '../state/store';
import { clipSpan, fileTimeAt, laneRgb, loudest } from '../lib/audioLanes';
import { type LipSyncOptions } from '../lib/lipsync';
import { DEFAULT_SETUP, generateLipSync, loadSetups, MOUTH_SLOTS, rangeOf, saveSetup, STYLES, voiceOf, voiceRef, type LipSetup, type LipStyle, type MouthPattern, type MouthSlot } from '../lib/lipsyncRun';
import { vowelPatterns } from '../lib/vowels';

/** Every character's lip-sync setup, kept in step with the scene (saved with it as scene notes). */
function useSetups() {
  const status = useStore((s) => s.status);
  const [setups, setSetups] = useState<Record<number, LipSetup>>({});
  const load = useCallback(() => {
    loadSetups().then(setSetups);
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load]);
  useEffect(() => bridge.on('notes.changed', load), [load]);
  const timers = useRef<Record<number, number>>({});
  /** Change one character's setup; saved shortly after (sliders send many changes). */
  const update = useCallback((id: number, patch: Partial<LipSetup>) => {
    setSetups((all) => {
      const next = { ...(all[id] ?? DEFAULT_SETUP), ...patch };
      window.clearTimeout(timers.current[id]);
      timers.current[id] = window.setTimeout(() => saveSetup(id, next), 250);
      return { ...all, [id]: next };
    });
  }, []);
  return { setups, update };
}

const clipLabel = (c: AudioClipInfo) => `${audioName(c)} · at ${c.offset.toFixed(1)} s`;
const report = (who: string, r: Awaited<ReturnType<typeof generateLipSync>>) =>
  typeof r === 'string' ? `${who}: ${r}` : `${who}: ${r.mouth} mouth keys${r.shapes ? `, ${r.shapes} vowel shapes` : ''}${r.note ? ` (${r.note})` : ''}`;

/** Lip-sync for one character: voice, range, style, shapes, generate. */
export function LipSyncCard({ charId }: { charId: number | undefined }) {
  const nodes = useStore((s) => s.nodes);
  const clips = useStore((s) => s.audio);
  const shots = useStore((s) => s.shots);
  const tl = useStore((s) => s.tl);
  const listen = useStore((s) => s.audioListen);
  const delay = useStore((s) => s.audioDelay.output);
  const { setups, update } = useSetups();
  const [busy, setBusy] = useState(false);
  const [patterns, setPatterns] = useState<MouthPattern[]>([]);
  const who = charId != null ? displayName(nodes[charId]) : '';
  const setup = charId != null ? setups[charId] ?? DEFAULT_SETUP : DEFAULT_SETUP;
  const voice = voiceOf(setup, clips);
  const range = voice ? rangeOf(setup, voice, shots, tl?.duration ?? 10) : null;
  const set = (patch: Partial<LipSetup>) => charId != null && update(charId, patch);
  const setOpts = (patch: Partial<LipSyncOptions>) => set({ opts: { ...setup.opts, ...patch }, style: 'custom' });

  useEffect(() => {
    if (charId == null || !setup.vowels) return;
    call<MouthPattern[]>('face.mouthPatterns', { id: charId }).then((p) => p && setPatterns(p));
  }, [charId, setup.vowels]);
  const auto = useMemo(() => vowelPatterns(patterns), [patterns]);
  const patternName = (ptn: number) => {
    const p = patterns.find((x) => x.ptn === ptn);
    return p ? `${ptn} · ${p.open.replace(/^.*?_/, '').replace(/_op$/, '')}` : `#${ptn}`;
  };

  const generate = async () => {
    if (charId == null) return toast('Select the character who speaks');
    setBusy(true);
    try {
      const r = await generateLipSync(charId, setup);
      toast(typeof r === 'string' ? r : `${report(who, r)} — press Space to watch, Ctrl+Z to undo`, typeof r === 'string' ? 'error' : 'done');
    } finally {
      setBusy(false);
    }
  };
  const listening = voice && listen?.id === voice.id;

  return (
    <div className="face-card">
      <div className="face-card-head">
        <strong>Lip-sync</strong>
        <Help text="The mouth opens with the voice's loudness and (with Vowels) takes the A / I / U / E / O shape of each sound. Rough but quick — refine the keys by hand afterwards. Only the chosen part of the timeline is replaced. Each character's choices are saved with the scene." />
        <span style={{ flex: 1 }} />
        <span className="face-tag">{who || 'no character selected'}</span>
      </div>

      {!clips.length ? (
        <div className="hint">
          Needs the voice as a WAV.{' '}
          {window.studioEx?.openAudio && (
            <button className="btn small solid" onClick={() => pickAudio(0)}>
              Add a WAV…
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="cleanup-row">
            <span>Voice</span>
            <select className="input" value={voice?.id ?? ''} onChange={(e) => set({ voice: voiceRef(clips.find((c) => c.id === Number(e.target.value))!) })} title="Which audio clip is this character's voice (remembered for them)">
              {!voice && <option value="">— pick the voice —</option>}
              {clips.map((c) => (
                <option key={c.id} value={c.id}>
                  {clipLabel(c)}
                </option>
              ))}
            </select>
            {voice && (
              <button className={`btn small ${listening ? 'on' : 'solid'}`} onClick={() => listenAudio(listening ? null : voice.id, typeof range === 'object' && range ? fileTimeAt(voice, range[0]) : voice.trimIn)} title="Listen to the part that will be lip-synced">
                {listening ? '■' : '▶'}
              </button>
            )}
          </div>
          {voice && <VoiceStrip clip={voice} index={clips.indexOf(voice)} range={typeof range === 'object' ? range : null} />}

          <div className="cleanup-row">
            <span>Part</span>
            <div className="seg">
              <button className={setup.range === 'clip' ? 'on' : ''} onClick={() => set({ range: 'clip' })} title="Everywhere the voice plays">
                Whole clip
              </button>
              <button className={setup.range === 'between' ? 'on' : ''} onClick={() => set({ range: 'between', ...(setup.to > setup.from ? {} : { from: voice?.offset ?? 0, to: (voice?.offset ?? 0) + (voice ? clipSpan(voice) : 1) }) })} title="Only between two times on the timeline">
                Between
              </button>
              <button className={setup.range === 'shot' ? 'on' : ''} disabled={!shots.length} onClick={() => set({ range: 'shot', shot: setup.shot ?? shots[0]?.id })} title={shots.length ? 'Only during one shot' : 'Add shots in Shoot › Shots & camera first'}>
                One shot
              </button>
            </div>
          </div>
          {setup.range === 'between' && (
            <div className="cleanup-row">
              <span />
              <Secs value={setup.from} onCommit={(v) => set({ from: v })} title="From (timeline seconds)" />
              <button className="btn small solid" onClick={() => set({ from: Math.round(liveTime() * 1000) / 1000 })} title="From the playhead">
                ⇤ playhead
              </button>
              <Secs value={setup.to} onCommit={(v) => set({ to: v })} title="To (timeline seconds)" />
              <button className="btn small solid" onClick={() => set({ to: Math.round(liveTime() * 1000) / 1000 })} title="To the playhead">
                playhead ⇥
              </button>
            </div>
          )}
          {setup.range === 'shot' && (
            <div className="cleanup-row">
              <span />
              <select className="input" value={setup.shot ?? ''} onChange={(e) => set({ shot: e.target.value })}>
                {shots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.start.toFixed(1)}–{s.end.toFixed(1)} s
                  </option>
                ))}
              </select>
            </div>
          )}
          {typeof range === 'string' && <div className="hint lip-warn">{range}</div>}

          <div className="cleanup-row">
            <span>Style</span>
            <div className="seg">
              {(Object.keys(STYLES) as LipStyle[]).map((k) => (
                <button key={k} className={setup.style === k ? 'on' : ''} onClick={() => set({ style: k, opts: STYLES[k].opts })} title={STYLES[k].hint}>
                  {STYLES[k].label}
                </button>
              ))}
              {setup.style === 'custom' && <button className="on" title="Your own settings (fine-tuned below)">Custom</button>}
            </div>
          </div>
          <details className="lip-more">
            <summary>Fine-tune</summary>
            <div className="cleanup-row">
              <span>Sensitivity</span>
              <Slider value={setup.opts.sensitivity} min={0.5} max={3} step={0.1} onChange={(v) => setOpts({ sensitivity: v })} />
            </div>
            <div className="cleanup-row">
              <span>Ignore below</span>
              <Slider value={setup.opts.threshold} min={0} max={0.4} step={0.02} onChange={(v) => setOpts({ threshold: v })} />
            </div>
            <div className="cleanup-row">
              <span>Smoothing</span>
              <Slider value={setup.opts.smoothing} min={0} max={1} step={0.05} onChange={(v) => setOpts({ smoothing: v })} />
            </div>
            <div className="cleanup-row">
              <span>Widest</span>
              <Slider value={setup.opts.maxOpen} min={0.2} max={1} step={0.05} onChange={(v) => setOpts({ maxOpen: v })} />
            </div>
            <div className="cleanup-row">
              <span>Keys / s</span>
              <div className="seg">
                {[10, 12, 15, 20, 30].map((k) => (
                  <button key={k} className={setup.opts.keysPerSecond === k ? 'on' : ''} onClick={() => setOpts({ keysPerSecond: k })}>
                    {k}
                  </button>
                ))}
              </div>
            </div>
          </details>

          <div className="cleanup-row">
            <span>Shapes</span>
            <div className="seg">
              <button className={!setup.vowels ? 'on' : ''} onClick={() => set({ vowels: false })} title="Only Mouth Open: the mouth opens and closes">
                Open / close
              </button>
              <button className={setup.vowels ? 'on' : ''} onClick={() => set({ vowels: true })} title="Also keys the Mouth pattern: A, I, U, E or O from the sound (works best on clear speech or singing)">
                Vowels
              </button>
            </div>
          </div>
          {setup.vowels && (
            <details className="lip-more">
              <summary>Vowel shapes{Object.keys(setup.vowelMap).length ? ` · ${Object.keys(setup.vowelMap).length} picked` : ''}</summary>
              <div className="lip-vowels">
                {MOUTH_SLOTS.map((slot) => (
                  <label key={slot}>
                    <b>{slot === 'closed' ? 'Closed' : slot.toUpperCase()}</b>
                    <select
                      className="input"
                      value={setup.vowelMap[slot] ?? ''}
                      onChange={(e) => {
                        const m = { ...setup.vowelMap };
                        if (e.target.value === '') delete m[slot as MouthSlot];
                        else m[slot as MouthSlot] = Number(e.target.value);
                        set({ vowelMap: m });
                      }}
                      title={slot === 'closed' ? 'The mouth between sounds' : `The mouth shape for “${slot.toUpperCase()}”`}
                    >
                      <option value="">{slot === 'closed' ? 'Auto (their current mouth)' : auto[slot as keyof typeof auto] != null ? `Auto (${patternName(auto[slot as keyof typeof auto]!)})` : 'Auto (none found)'}</option>
                      {patterns.map((p) => (
                        <option key={p.ptn} value={p.ptn}>
                          {patternName(p.ptn)}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </details>
          )}

          {delay === 0 && (
            <div className="hint">
              Lips look early while it plays? On Bluetooth headphones the sound arrives late — set{' '}
              <button className="btn small solid" onClick={() => showTab('shoot', 'audio')}>
                Headphone delay
              </button>{' '}
              in Shoot › Audio.
            </div>
          )}
          <button className="btn primary wide" disabled={busy || charId == null || !voice || typeof range === 'string'} onClick={generate} title="Replaces the character's mouth keys in the chosen part only">
            {busy ? 'Working…' : charId == null ? 'Select the character who speaks' : `Generate lip-sync for ${who}`}
          </button>
        </>
      )}
    </div>
  );
}

/** The voice clip's waveform (its own span), the part to lip-sync highlighted. */
function VoiceStrip({ clip, index, range }: { clip: AudioClipInfo; index: number; range: [number, number] | null }) {
  const peaks = useStore((s) => s.audioPeaks[clip.id]);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth,
      h = c.clientHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const span = clipSpan(clip);
    const xOf = (t: number) => ((t - clip.offset) / span) * w;
    if (range) {
      g.fillStyle = tokenRgba('--accent', 0.16);
      g.fillRect(xOf(range[0]), 0, xOf(range[1]) - xOf(range[0]), h);
    }
    if (!peaks) return;
    const rgb = laneRgb(index);
    const half = (h / 2 - 2) / loudest(peaks);
    for (let x = 0; x < w; x++) {
      const t = clip.offset + (x / w) * span;
      const inside = !range || (t >= range[0] && t <= range[1]);
      g.fillStyle = `rgba(${rgb},${inside ? 0.9 : 0.3})`;
      const i0 = Math.max(0, Math.floor(fileTimeAt(clip, t) * peaks.perSecond)),
        i1 = Math.min(peaks.peaks.length - 1, Math.floor(fileTimeAt(clip, clip.offset + ((x + 1) / w) * span) * peaks.perSecond));
      let p = 0;
      for (let i = i0; i <= i1; i++) p = Math.max(p, peaks.peaks[i]);
      const a = Math.max(0.5, p * half);
      g.fillRect(x, h / 2 - a, 1, a * 2);
    }
  }, [clip, peaks, range?.[0], range?.[1], index]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="lip-strip" title={`${clip.file}: plays ${clip.offset.toFixed(2)}–${(clip.offset + clipSpan(clip)).toFixed(2)} s; the highlighted part gets lip-sync`}>
      <canvas ref={ref} />
      <span>{clip.offset.toFixed(1)} s</span>
      <span>{(clip.offset + clipSpan(clip)).toFixed(1)} s</span>
    </div>
  );
}

/** Every character in the scene with their voice; one Generate for all ticked speakers. */
export function SpeakersCard() {
  const nodes = useStore((s) => s.nodes);
  const clips = useStore((s) => s.audio);
  useStore((s) => s.showEnglish);
  const { setups, update } = useSetups();
  const chars = useMemo(() => Object.values(nodes).filter((n) => n.type === 'Char'), [nodes]);
  const [ticked, setTicked] = useState<Set<number> | null>(null);
  const [busy, setBusy] = useState('');
  // ticked by default: characters that have a voice picked
  const isTicked = (id: number) => (ticked ? ticked.has(id) : !!setups[id]?.voice);
  const tick = (id: number, on: boolean) => {
    const s = new Set(chars.filter((c) => isTicked(c.id)).map((c) => c.id));
    if (on) s.add(id);
    else s.delete(id);
    setTicked(s);
  };
  if (chars.length < 2 || !clips.length) return null;
  const chosen = chars.filter((c) => isTicked(c.id));

  const run = async () => {
    const lines: string[] = [];
    try {
      for (const c of chosen) {
        setBusy(displayName(c));
        lines.push(report(displayName(c), await generateLipSync(c.id, setups[c.id] ?? DEFAULT_SETUP)));
      }
    } finally {
      setBusy('');
    }
    toast(`${lines.join(' · ')} — Ctrl+Z undoes one step at a time`, 'done');
  };

  return (
    <div className="face-card">
      <div className="face-card-head">
        <strong>All speakers</strong>
        <Help text="Pick each character's voice here, then one Generate makes everyone's mouth keys. Each uses their own part, style and vowel shapes from the Lip-sync card (select them to change those)." />
      </div>
      <div className="lip-speakers">
        {chars.map((c) => {
          const setup = setups[c.id] ?? DEFAULT_SETUP;
          const v = setup.voice ? voiceOf(setup, clips) : undefined;
          return (
            <div key={c.id} className="lip-speaker">
              <input type="checkbox" checked={isTicked(c.id)} onChange={(e) => tick(c.id, e.target.checked)} title="Include in Generate" />
              <span className="name" title={displayName(c)}>
                {displayName(c)}
              </span>
              <select
                className="input"
                value={v?.id ?? ''}
                onChange={(e) => {
                  const clip = clips.find((x) => x.id === Number(e.target.value));
                  update(c.id, { voice: clip ? voiceRef(clip) : undefined });
                  if (clip) tick(c.id, true);
                }}
              >
                <option value="">— no voice —</option>
                {clips.map((x) => (
                  <option key={x.id} value={x.id}>
                    {clipLabel(x)}
                  </option>
                ))}
              </select>
              <small>{setup.style === 'custom' ? 'Custom' : STYLES[setup.style].label}</small>
            </div>
          );
        })}
      </div>
      <button className="btn primary wide" disabled={!!busy || !chosen.length} onClick={run}>
        {busy ? `Working on ${busy}…` : `Generate for ${chosen.length} speaker${chosen.length === 1 ? '' : 's'}`}
      </button>
    </div>
  );
}

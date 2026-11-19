import { useEffect, useMemo, useState } from 'react';
import { Help } from './Help';
import { blinkKeys, LIPSYNC_DEFAULTS, lipSyncKeys, type LipSyncOptions } from '../lib/lipsync';
import { vowelKeys, vowelPatterns, vowelTrack, type Spectrum } from '../lib/vowels';
import { call, displayName, editTimeline, liveTime, pickAudio, refreshAudio, selectedCharacters, toast, useStore } from '../state/store';
import { Slider } from './CharacterPanel';
import { clipSpan, timelineTimeAt } from '../lib/audioLanes';

const FACE_MODELS = ['characterEyes', 'characterEyesOpen', 'characterEyebrows', 'characterMouth', 'characterMouthOpen', 'characterNeck'];

/** Find (or create) a character's Timeline track for a model; returns its id. */
async function trackFor(oci: number, model: string): Promise<number | undefined> {
  const existing = useStore.getState().tracks.find((t) => t.oci === oci && t.model === model);
  if (existing) return existing.id;
  return call<number>('timeline.addTrack', { owner: 'Timeline', model, oci });
}

export type AudioPart = 'track' | 'lipsync' | 'face';

/**
 * Audio track synced to Timeline, lip-sync from it, and quick facial-animation helpers. `parts` picks the
 * sections: Shoot shows the audio track, Animate › Face shows lip-sync and the face helpers.
 */
export function AudioPanel({ parts = ['track', 'lipsync', 'face'] }: { parts?: AudioPart[] }) {
  const status = useStore((s) => s.status);
  const clips = useStore((s) => s.audio);
  // which clip is the voice (several clips: music, effects, more than one speaker)
  const [voiceId, setVoiceId] = useState<number | null>(null);
  const voice = clips.find((c) => c.id === voiceId) ?? clips[0];
  const tl = useStore((s) => s.tl);
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  useStore((s) => s.showEnglish);
  const chars = useMemo(() => selectedCharacters(), [selection, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const who = chars.length ? displayName(nodes[chars[0]]) : '';
  const [opts, setOpts] = useState<LipSyncOptions>(LIPSYNC_DEFAULTS);
  const [blinkEvery, setBlinkEvery] = useState(4);
  const [busy, setBusy] = useState(false);
  const [vowels, setVowels] = useState(() => {
    try {
      return localStorage.getItem('kf.lipsync.vowels') !== '0';
    } catch {
      return true;
    }
  });
  const pickVowels = (on: boolean) => {
    setVowels(on);
    try {
      localStorage.setItem('kf.lipsync.vowels', on ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };

  useEffect(() => {
    if (status === 'open') refreshAudio();
  }, [status]);

  // ---------------- lip-sync ----------------
  const lipSync = async () => {
    if (!chars.length) return toast('Select the character who speaks');
    if (!voice) return toast('Add the voice as a WAV first');
    setBusy(true);
    try {
      const env = await call<{ id: number; rate: number; max: number; values: number[]; offset: number; duration: number }>('audio.envelope', { id: voice.id, rate: 60 });
      if (!env) return;
      // the voice as it plays: only between its trims, moved by its speed
      const begin = Math.max(0, voice.offset);
      const end = Math.min(tl?.duration ?? 10, voice.offset + clipSpan(voice));
      const inPlay = (ft: number) => ft >= voice.trimIn && ft <= voice.duration - voice.trimOut;
      const keys = lipSyncKeys(env.values, env.rate, env.max, opts)
        .filter((k) => inPlay(k.t))
        .map((k) => ({ t: Math.round(timelineTimeAt(voice, k.t) * 1000) / 1000, v: k.v }))
        .filter((k) => k.t >= begin && k.t <= end);
      const track = await trackFor(chars[0], 'characterMouthOpen');
      if (track == null) return;
      const n = await editTimeline<number>('timeline.writeKeys', {
        track,
        keys: keys.map((k) => ({ t: k.t, value: { value: k.v } })),
        clear: [begin, end],
        curve: 'linear',
        label: 'Lip-sync',
      });
      let shapes = 0;
      if (vowels) shapes = await vowelShapes(env, begin, end);
      if (n) toast(`Lip-sync: ${n} mouth keys${shapes ? ` and ${shapes} vowel shapes` : ''} for ${who} — press Space to watch. Ctrl+Z to undo`);
    } finally {
      setBusy(false);
    }
  };

  /** A / I / U / E / O mouth patterns on the Mouth track, from the voice's formants. Returns how many keys. */
  const vowelShapes = async (env: { id: number; rate: number; values: number[]; offset: number }, begin: number, end: number) => {
    const [spec, patterns, chara] = await Promise.all([
      call<Spectrum>('audio.spectrum', { id: env.id, rate: env.rate }),
      call<{ ptn: number; open: string; close: string }[]>('face.mouthPatterns', { id: chars[0] }),
      call<{ face: { mouthPtn: number } }>('chara.get', { id: chars[0] }),
    ]);
    if (!spec || !patterns || !chara) return 0;
    const map = vowelPatterns(patterns);
    if (Object.keys(map).length < 3) {
      toast(`${who}'s mouth has no vowel shapes to use — only the opening is animated`, 'info');
      return 0;
    }
    const rest = chara.face.mouthPtn;
    const labels = vowelTrack(spec, env.values);
    const v = voice!;
    const keys = vowelKeys(labels, spec.rate)
      .filter((k) => k.t >= v.trimIn && k.t <= v.duration - v.trimOut)
      .map((k) => ({ t: Math.round(timelineTimeAt(v, k.t) * 1000) / 1000, v: k.v ? map[k.v] ?? rest : rest }))
      .filter((k) => k.t >= begin && k.t <= end);
    if (!keys.length) return 0;
    const track = await trackFor(chars[0], 'characterMouth');
    if (track == null) return 0;
    return (
      (await editTimeline<number>('timeline.writeKeys', {
        track,
        keys: keys.map((k) => ({ t: k.t, value: { value: k.v } })),
        clear: [begin, end],
        curve: 'step',
        label: 'Lip-sync vowels',
      })) ?? 0
    );
  };

  // ---------------- face helpers ----------------
  const keyFace = async () => {
    if (!chars.length) return toast('Select a character');
    const ids: number[] = [];
    for (const m of FACE_MODELS) {
      const id = await trackFor(chars[0], m);
      if (id != null) ids.push(id);
    }
    const n = await editTimeline<number>('timeline.addKeys', { tracks: ids, t: liveTime() });
    if (n) toast(`Keyed ${who}'s face (eyes, brows, mouth, neck) at ${liveTime().toFixed(2)}s`);
  };
  const blink = async () => {
    if (!chars.length) return toast('Select a character');
    const face = await call<{ face: { eyesOpen: number } }>('chara.get', { id: chars[0] });
    const open = face?.face.eyesOpen ?? 1;
    const keys = blinkKeys(0, tl?.duration ?? 10, blinkEvery, open, chars[0] + 1);
    const track = await trackFor(chars[0], 'characterEyesOpen');
    if (track == null) return;
    const n = await editTimeline<number>('timeline.writeKeys', { track, keys: keys.map((k) => ({ t: k.t, value: { value: k.v } })), curve: 'smooth', label: 'Auto blink' });
    if (n) toast(`${n / 4} blinks added for ${who} — Ctrl+Z to undo`);
  };

  const o = (patch: Partial<LipSyncOptions>) => setOpts((x) => ({ ...x, ...patch }));

  return (
    <div className="audio-panel">
      {parts.includes('lipsync') && (
      <div className="face-card">
        <div className="face-card-head">
          <strong>Lip-sync</strong>
          <Help text="The mouth opens with the audio's loudness and (with Vowels) takes the A / I / U / E / O shape of each sound. Rough but quick — refine the keys by hand afterwards. Replaces the character's mouth keys where the audio plays." />
        </div>
        {!clips.length && (
          <div className="hint" style={{ marginTop: 0 }}>
            Needs the voice as a WAV (it plays with the timeline and is saved with the scene).{' '}
            {window.studioEx?.openAudio && (
              <button className="btn small solid" onClick={() => pickAudio(0)}>
                Choose a WAV…
              </button>
            )}
          </div>
        )}
        <div className="hint" style={{ marginTop: 0 }}>
          {who ? `For ${who}.` : 'Select the character who speaks.'}
        </div>
        {clips.length > 1 && (
          <div className="cleanup-row">
            <span>Voice</span>
            <select className="input" value={voice?.id ?? ''} onChange={(e) => setVoiceId(Number(e.target.value))} title="Which audio clip is this character's voice">
              {clips.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.file}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="cleanup-row">
          <span>Shapes</span>
          <div className="seg">
            <button className={!vowels ? 'on' : ''} onClick={() => pickVowels(false)} title="Only Mouth Open: the mouth opens and closes">
              Open / close
            </button>
            <button className={vowels ? 'on' : ''} onClick={() => pickVowels(true)} title="Also keys the Mouth pattern: A, I, U, E or O from the sound (works best on clear speech or singing)">
              Vowels
            </button>
          </div>
        </div>
        <div className="cleanup-row">
          <span>Sensitivity</span>
          <Slider value={opts.sensitivity} min={0.5} max={3} step={0.1} onChange={(v) => o({ sensitivity: v })} />
        </div>
        <div className="cleanup-row">
          <span>Ignore below</span>
          <Slider value={opts.threshold} min={0} max={0.4} step={0.02} onChange={(v) => o({ threshold: v })} />
        </div>
        <div className="cleanup-row">
          <span>Smoothing</span>
          <Slider value={opts.smoothing} min={0} max={1} step={0.05} onChange={(v) => o({ smoothing: v })} />
        </div>
        <div className="cleanup-row">
          <span>Widest</span>
          <Slider value={opts.maxOpen} min={0.2} max={1} step={0.05} onChange={(v) => o({ maxOpen: v })} />
        </div>
        <div className="cleanup-row">
          <span>Keys / s</span>
          <div className="seg">
            {[10, 15, 20, 30].map((k) => (
              <button key={k} className={opts.keysPerSecond === k ? 'on' : ''} onClick={() => o({ keysPerSecond: k })}>
                {k}
              </button>
            ))}
          </div>
        </div>
        <button className="btn primary wide" disabled={busy || !voice || !chars.length} onClick={lipSync} title={vowels ? "Replaces the character's Mouth Open and Mouth keys where the audio plays" : "Replaces the character's Mouth Open keys where the audio plays"}>
          {busy ? 'Working…' : 'Generate lip-sync'}
        </button>
      </div>
      )}

      {parts.includes('face') && (
      <div className="face-card">
        <div className="face-card-head">
          <strong>Blinks &amp; face keys</strong>
          <Help text="Add blinks puts natural blinks over the whole timeline on the Eyes open track. Tip: turn off the character's automatic blinking (Blink, under Eyes) so it doesn't fight the keys." />
        </div>
        <button className="btn solid wide" disabled={!chars.length} onClick={keyFace} title="Keys eyes, eyelids, eyebrows, mouth, mouth open and neck direction at the playhead">
          Key face at playhead
        </button>
        <div className="cleanup-row" style={{ marginTop: 8 }}>
          <span>Blink every (s)</span>
          <Slider value={blinkEvery} min={2} max={8} step={0.5} onChange={setBlinkEvery} />
        </div>
        <button className="btn solid wide" disabled={!chars.length} onClick={blink} title="Adds natural blinks over the whole timeline on the Eyes Open track">
          Add blinks
        </button>
      </div>
      )}
    </div>
  );
}

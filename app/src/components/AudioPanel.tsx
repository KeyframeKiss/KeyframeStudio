import { useEffect, useMemo, useState } from 'react';
import { blinkKeys, LIPSYNC_DEFAULTS, lipSyncKeys, type LipSyncOptions } from '../lib/lipsync';
import { call, displayName, editTimeline, liveTime, refreshAudio, selectedCharacters, toast, useStore } from '../state/store';
import { Slider } from './CharacterPanel';

const FACE_MODELS = ['characterEyes', 'characterEyesOpen', 'characterEyebrows', 'characterMouth', 'characterMouthOpen', 'characterNeck'];

/** Find (or create) a character's Timeline track for a model; returns its id. */
async function trackFor(oci: number, model: string): Promise<number | undefined> {
  const existing = useStore.getState().tracks.find((t) => t.oci === oci && t.model === model);
  if (existing) return existing.id;
  return call<number>('timeline.addTrack', { owner: 'Timeline', model, oci });
}

/** Audio track synced to Timeline, lip-sync from it, and quick facial-animation helpers. */
export function AudioPanel() {
  const status = useStore((s) => s.status);
  const audio = useStore((s) => s.audio);
  const tl = useStore((s) => s.tl);
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  useStore((s) => s.showEnglish);
  const chars = useMemo(() => selectedCharacters(), [selection, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const who = chars.length ? displayName(nodes[chars[0]]) : '';
  const [files, setFiles] = useState<{ file: string; size: number }[]>([]);
  const [opts, setOpts] = useState<LipSyncOptions>(LIPSYNC_DEFAULTS);
  const [blinkEvery, setBlinkEvery] = useState(4);
  const [busy, setBusy] = useState(false);

  // the folder can change any time (files copied in by hand): re-read it when the list is opened
  const loadFiles = () => call<{ file: string; size: number }[]>('audio.files').then((f) => f && setFiles(f));
  useEffect(() => {
    if (status !== 'open') return;
    loadFiles();
    refreshAudio();
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async (fileOrPath: string) => {
    const r = await call('audio.load', { file: fileOrPath, offset: audio?.offset ?? 0 });
    if (!r) return;
    await refreshAudio();
    loadFiles();
    toast('Audio loaded — it plays with the timeline and is saved with the scene');
  };
  const browse = async () => {
    const p = await window.studioEx?.openAudio?.();
    if (p) load(p);
  };
  const setA = async (patch: Record<string, unknown>) => {
    await call('audio.set', patch);
    refreshAudio();
  };

  // ---------------- lip-sync ----------------
  const lipSync = async () => {
    if (!chars.length) return toast('Select the character who speaks');
    if (!audio) return toast('Load an audio file first');
    setBusy(true);
    try {
      const env = await call<{ rate: number; max: number; values: number[]; offset: number; duration: number }>('audio.envelope', { rate: 60 });
      if (!env) return;
      const end = Math.min(tl?.duration ?? 10, env.offset + env.duration);
      const keys = lipSyncKeys(env.values, env.rate, env.max, opts)
        .map((k) => ({ t: Math.round((env.offset + k.t) * 1000) / 1000, v: k.v }))
        .filter((k) => k.t >= 0 && k.t <= end);
      const track = await trackFor(chars[0], 'characterMouthOpen');
      if (track == null) return;
      const n = await editTimeline<number>('timeline.writeKeys', {
        track,
        keys: keys.map((k) => ({ t: k.t, value: { value: k.v } })),
        clear: [Math.max(0, env.offset), end],
        curve: 'linear',
        label: 'Lip-sync',
      });
      if (n) toast(`Lip-sync: ${n} mouth keys for ${who} — press Space to watch. Ctrl+Z to undo`);
    } finally {
      setBusy(false);
    }
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
    <div className="panel-body audio-panel">
      <div className="section">
        <h3>Audio track</h3>
        <div className="cleanup-row">
          <span>File</span>
          <select className="input" value={audio?.file ?? ''} onMouseDown={loadFiles} onFocus={loadFiles} onChange={(e) => e.target.value && load(e.target.value)}>
            <option value="">{files.length ? '— choose —' : 'No WAV files yet — Browse…'}</option>
            {files.map((f) => (
              <option key={f.file} value={f.file}>
                {f.file}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {window.studioEx?.openAudio && (
            <button className="btn solid" style={{ flex: 1 }} onClick={browse} title="Pick a WAV anywhere; it's copied into UserData/audio so the scene can find it">
              Browse…
            </button>
          )}
          {audio && (
            <button className="btn" onClick={() => call('audio.clear').then(refreshAudio)} title="Remove the audio from this scene">
              Remove
            </button>
          )}
        </div>
        {audio && (
          <>
            <div className="cleanup-row" style={{ marginTop: 8 }}>
              <span>Starts at</span>
              <input className="input mono" type="number" step={0.05} value={audio.offset} onChange={(e) => setA({ offset: Number(e.target.value) || 0 })} style={{ width: 80 }} />
              <span className="hint" style={{ margin: 0 }}>
                s
              </span>
              <button className="btn small" onClick={() => setA({ offset: Math.round(liveTime() * 1000) / 1000 })} title="Start the audio at the playhead">
                At playhead
              </button>
            </div>
            <div className="cleanup-row">
              <span>Volume</span>
              <Slider value={audio.volume} min={0} max={1} step={0.05} onChange={(v) => setA({ volume: v })} />
            </div>
            <label className="rigs-opt" style={{ margin: '0 0 6px' }}>
              <input type="checkbox" checked={audio.muted} onChange={(e) => setA({ muted: e.target.checked })} /> Mute while animating
            </label>
            <div className="hint">
              {audio.duration.toFixed(1)}s long · its waveform shows in the dope sheet's time ruler. Plays with the timeline (Space) and is saved with the scene.
              {tl && audio.offset + audio.duration > tl.duration ? ` The timeline is ${tl.duration.toFixed(1)}s — make it longer to hear the end.` : ''}
            </div>
          </>
        )}
      </div>

      <div className="section">
        <h3>Lip-sync</h3>
        <div className="hint" style={{ marginTop: 0 }}>
          {who ? `${who}'s mouth opens with the audio's loudness.` : 'Select the character who speaks.'} Rough but quick — refine keys by hand afterwards.
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
        <button className="btn primary wide" disabled={busy || !audio || !chars.length} onClick={lipSync} title="Replaces the character's Mouth Open keys where the audio plays">
          {busy ? 'Working…' : 'Generate lip-sync'}
        </button>
      </div>

      <div className="section">
        <h3>Face</h3>
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
        <div className="hint">Tip: turn off the character's automatic blinking (Pose › Character › Expression & hands) so it doesn't fight the keys.</div>
      </div>
    </div>
  );
}

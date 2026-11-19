import { useEffect, useMemo, useState } from 'react';
import { Help } from './Help';
import { blinkKeys } from '../lib/lipsync';
import { trackFor } from '../lib/lipsyncRun';
import { LipSyncCard, SpeakersCard } from './LipSync';
import { call, displayName, editTimeline, liveTime, refreshAudio, selectedCharacters, toast, useStore } from '../state/store';
import { Slider } from './CharacterPanel';

const FACE_MODELS = ['characterEyes', 'characterEyesOpen', 'characterEyebrows', 'characterMouth', 'characterMouthOpen', 'characterNeck'];


export type AudioPart = 'track' | 'lipsync' | 'face';

/**
 * Audio track synced to Timeline, lip-sync from it, and quick facial-animation helpers. `parts` picks the
 * sections: Shoot shows the audio track, Animate › Face shows lip-sync and the face helpers.
 */
export function AudioPanel({ parts = ['track', 'lipsync', 'face'] }: { parts?: AudioPart[] }) {
  const status = useStore((s) => s.status);
  const tl = useStore((s) => s.tl);
  const selection = useStore((s) => s.studioSelection);
  const nodes = useStore((s) => s.nodes);
  useStore((s) => s.showEnglish);
  const chars = useMemo(() => selectedCharacters(), [selection, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const who = chars.length ? displayName(nodes[chars[0]]) : '';
  const [blinkEvery, setBlinkEvery] = useState(4);

  useEffect(() => {
    if (status === 'open') refreshAudio();
  }, [status]);

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

  return (
    <div className="audio-panel">
      {parts.includes('lipsync') && (
        <>
          <LipSyncCard charId={chars[0]} />
          <SpeakersCard />
        </>
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

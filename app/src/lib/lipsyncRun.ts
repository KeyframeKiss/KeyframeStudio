/**
 * Lip-sync for a character: which audio clip is their voice, which part of it, in what style, with which of their
 * mouth shapes for each vowel. Each character's setup is saved with the scene (scene notes, per object), so the
 * Face page and "all speakers at once" use the same choices.
 */
import { bridge } from '../bridge/client';
import { call, editTimeline, useStore, type AudioClipInfo, type Shot } from '../state/store';
import { clipSpan, timelineTimeAt } from './audioLanes';
import { LIPSYNC_DEFAULTS, lipSyncKeys, type LipSyncOptions } from './lipsync';
import { vowelKeys, vowelPatterns, vowelTrack, VOWELS, type Spectrum, type Vowel } from './vowels';

export type LipStyle = 'talking' | 'singing' | 'whisper' | 'shouting';
export const STYLES: Record<LipStyle, { label: string; hint: string; opts: LipSyncOptions }> = {
  talking: { label: 'Talking', hint: 'Everyday speech: quick, clear mouth movement', opts: { sensitivity: 1.4, threshold: 0.08, smoothing: 0.4, keysPerSecond: 15, maxOpen: 1 } },
  singing: { label: 'Singing', hint: 'Held notes: smoother, the mouth stays open through long vowels', opts: { sensitivity: 1.2, threshold: 0.05, smoothing: 0.65, keysPerSecond: 12, maxOpen: 1 } },
  whisper: { label: 'Whisper', hint: 'Quiet voice: small mouth, ignores breath noise', opts: { sensitivity: 2.4, threshold: 0.14, smoothing: 0.35, keysPerSecond: 15, maxOpen: 0.45 } },
  shouting: { label: 'Shouting', hint: 'Loud and punchy: wide and snappy', opts: { sensitivity: 1, threshold: 0.1, smoothing: 0.2, keysPerSecond: 20, maxOpen: 1 } },
};

/** The mouth shapes a vowel map can set: the five vowels and the closed (resting) mouth. */
export type MouthSlot = Vowel | 'closed';
export const MOUTH_SLOTS: MouthSlot[] = [...VOWELS, 'closed'];

export interface LipSetup {
  /** The voice clip, by file and where it starts (clip ids change when a scene loads). Unset: the first clip. */
  voice?: { file: string; offset: number };
  /** Whole clip, between two timeline times, or one shot. */
  range: 'clip' | 'between' | 'shot';
  from: number;
  to: number;
  shot?: string;
  style: LipStyle | 'custom';
  opts: LipSyncOptions;
  /** Also key the Mouth pattern (A / I / U / E / O). */
  vowels: boolean;
  /** Mouth pattern per slot; unset slots are found from the pattern names (closed: the character's current mouth). */
  vowelMap: Partial<Record<MouthSlot, number>>;
}

export const DEFAULT_SETUP: LipSetup = { range: 'clip', from: 0, to: 0, style: 'talking', opts: LIPSYNC_DEFAULTS, vowels: true, vowelMap: {} };

const NOTE = 'lipsync';

/** Every character's saved setup, by object id. */
export async function loadSetups(): Promise<Record<number, LipSetup>> {
  const r = await bridge.request<{ objects: Record<string, Partial<LipSetup>> }>('notes.get', { key: NOTE }).catch(() => null);
  const out: Record<number, LipSetup> = {};
  for (const [id, v] of Object.entries(r?.objects ?? {})) out[Number(id)] = { ...DEFAULT_SETUP, ...v, opts: { ...DEFAULT_SETUP.opts, ...(v.opts ?? {}) }, vowelMap: { ...(v.vowelMap ?? {}) } };
  return out;
}
export const saveSetup = (id: number, setup: LipSetup | null) => bridge.request('notes.set', { key: NOTE, id, value: setup }).catch(() => undefined);

/** The clip a setup names: same file, nearest start; the first clip when it names none. */
export function voiceOf(setup: LipSetup, clips: AudioClipInfo[]): AudioClipInfo | undefined {
  if (!setup.voice) return clips[0];
  const same = clips.filter((c) => c.file === setup.voice!.file);
  return same.sort((a, b) => Math.abs(a.offset - setup.voice!.offset) - Math.abs(b.offset - setup.voice!.offset))[0];
}
export const voiceRef = (c: AudioClipInfo) => ({ file: c.file, offset: c.offset });

/** The timeline range a setup lip-syncs: [begin, end], or why there's nothing to do. */
export function rangeOf(setup: LipSetup, clip: AudioClipInfo, shots: Shot[], duration: number): [number, number] | string {
  let begin = Math.max(0, clip.offset),
    end = Math.min(duration, clip.offset + clipSpan(clip));
  if (setup.range === 'between') {
    begin = Math.max(begin, Math.min(setup.from, setup.to));
    end = Math.min(end, Math.max(setup.from, setup.to));
  } else if (setup.range === 'shot') {
    const s = shots.find((x) => x.id === setup.shot);
    if (!s) return 'Pick a shot';
    begin = Math.max(begin, s.start);
    end = Math.min(end, s.end);
  }
  return end - begin > 0.05 ? [begin, end] : 'The voice doesn’t play in that part of the timeline';
}

/** Find (or create) a character's Timeline track for a model; returns its id. */
export async function trackFor(oci: number, model: string): Promise<number | undefined> {
  const existing = useStore.getState().tracks.find((t) => t.oci === oci && t.model === model);
  if (existing) return existing.id;
  return call<number>('timeline.addTrack', { owner: 'Timeline', model, oci });
}

export type MouthPattern = { ptn: number; open: string; close: string };

/**
 * Write a character's lip-sync keys: Mouth Open from the voice's loudness and (with vowels) the Mouth pattern
 * from its formants, only inside the range; keys outside it stay. Each write is one undo step.
 */
export async function generateLipSync(charId: number, setup: LipSetup): Promise<{ mouth: number; shapes: number; note?: string } | string> {
  const st = useStore.getState();
  const voice = voiceOf(setup, st.audio);
  if (!voice) return st.audio.length ? 'Its voice clip is gone — pick another' : 'Add the voice as a WAV first';
  const range = rangeOf(setup, voice, st.shots, st.tl?.duration ?? 10);
  if (typeof range === 'string') return range;
  const [begin, end] = range;
  const env = await call<{ id: number; rate: number; max: number; values: number[] }>('audio.envelope', { id: voice.id, rate: 60 });
  if (!env) return 'Couldn’t read the voice';
  // file time → timeline time, only what plays (trims, speed), only inside the range
  const place = <T extends { t: number }>(ks: T[]) =>
    ks
      .filter((k) => k.t >= voice.trimIn && k.t <= voice.duration - voice.trimOut)
      .map((k) => ({ ...k, t: Math.round(timelineTimeAt(voice, k.t) * 1000) / 1000 }))
      .filter((k) => k.t >= begin && k.t <= end);
  const keys = place(lipSyncKeys(env.values, env.rate, env.max, setup.opts));
  const track = await trackFor(charId, 'characterMouthOpen');
  if (track == null) return 'Couldn’t make the Mouth Open track';
  const mouth =
    (await editTimeline<number>('timeline.writeKeys', { track, keys: keys.map((k) => ({ t: k.t, value: { value: k.v } })), clear: [begin, end], curve: 'linear', label: 'Lip-sync' })) ?? 0;
  if (!setup.vowels) return { mouth, shapes: 0 };

  const [spec, patterns, chara] = await Promise.all([
    call<Spectrum>('audio.spectrum', { id: voice.id, rate: env.rate }),
    call<MouthPattern[]>('face.mouthPatterns', { id: charId }),
    call<{ face: { mouthPtn: number } }>('chara.get', { id: charId }),
  ]);
  if (!spec || !patterns || !chara) return { mouth, shapes: 0 };
  const map: Partial<Record<MouthSlot, number>> = { ...vowelPatterns(patterns), ...setup.vowelMap };
  if (VOWELS.filter((v) => map[v] != null).length < 3) return { mouth, shapes: 0, note: 'no vowel mouth shapes found — pick them under Vowel shapes' };
  const rest = map.closed ?? chara.face.mouthPtn;
  const vkeys = place(vowelKeys(vowelTrack(spec, env.values), spec.rate)).map((k) => ({ t: k.t, v: k.v ? map[k.v] ?? rest : rest }));
  if (!vkeys.length) return { mouth, shapes: 0 };
  const shapeTrack = await trackFor(charId, 'characterMouth');
  if (shapeTrack == null) return { mouth, shapes: 0 };
  const shapes =
    (await editTimeline<number>('timeline.writeKeys', { track: shapeTrack, keys: vkeys.map((k) => ({ t: k.t, value: { value: k.v } })), clear: [begin, end], curve: 'step', label: 'Lip-sync vowels' })) ?? 0;
  return { mouth, shapes };
}

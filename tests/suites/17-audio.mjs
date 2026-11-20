import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'Audio track, lip-sync keys, saved with the scene';

/** 16-bit mono WAV: tone bursts (0.2 s on, 0.3 s off) for `secs` seconds. */
function makeWav(file, secs = 3, rate = 22050) {
  const n = Math.floor(secs * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const on = t % 0.5 < 0.2;
    data.writeInt16LE(on ? Math.round(Math.sin(2 * Math.PI * 220 * t) * 20000) : 0, i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

export default async function (t) {
  t.needs('timeline');
  const { ok, req, check, sleep, near } = t;
  const { chara } = await t.loadSample();
  const tmp = path.join(os.tmpdir(), 'StudioEX test tone.wav');
  makeWav(tmp);
  const copied = path.join(t.paths.userData, 'audio', 'StudioEX test tone.wav');
  t.defer(async () => {
    await req('audio.clear');
    for (const f of [tmp, copied]) if (fs.existsSync(f)) fs.unlinkSync(f);
  });

  await t.step('load, waveform, envelope', async () => {
    const a = await ok('audio.load', { path: tmp, offset: 0.5 });
    check('loaded (copied into UserData/audio)', a.loaded && a.file === 'StudioEX test tone.wav' && fs.existsSync(copied) && near(a.duration, 3, 0.01), JSON.stringify(a));
    const p = await ok('audio.peaks', { perSecond: 100 });
    check('waveform: 100 peaks per second', Math.abs(p.peaks.length - 300) <= 1);
    check('bursts loud, gaps silent', p.peaks[10] > 0.5 && p.peaks[35] < 0.01, `${p.peaks[10]} / ${p.peaks[35]}`);
    const e = await ok('audio.envelope', { rate: 30 });
    check('envelope', e.values.length === 90 && e.max > 0.3 && near(e.offset, 0.5));
    const files = await ok('audio.files');
    check('listed among the scene audio files', files.some((f) => f.file === 'StudioEX test tone.wav'));
    const bad = await req('audio.load', { path: path.join(os.tmpdir(), 'nope.mp3') });
    check('non-WAV refused', !bad.ok);
  });

  await t.step('follows the playhead', async () => {
    await ok('timeline.seek', { t: 0 });
    await ok('timeline.play');
    await sleep(1200);
    check('plays with the timeline (after its 0.5 s offset)', (await ok('audio.get')).playing === true);
    await ok('timeline.pause');
    await sleep(300);
    check('pauses with it', (await ok('audio.get')).playing === false);
    await ok('timeline.stop');
    await ok('audio.set', { volume: 0.4, muted: true });
    const g = await ok('audio.get');
    check('volume and mute', near(g.volume, 0.4) && g.muted === true);
    await ok('audio.set', { muted: false, volume: 1 });
  });

  await t.step('headphone delay (plays early while the timeline plays)', async () => {
    const before = (await ok('audio.get')).outputDelay;
    t.defer(() => req('audio.setDelay', { ms: before }));
    // the clip starts at 0.5 s: from 0.3 s it's silent without a delay, and already playing 300 ms early
    await ok('audio.setDelay', { ms: 0 });
    await ok('timeline.seek', { t: 0.3 });
    await ok('timeline.play');
    await sleep(60);
    const off = (await ok('audio.get')).playing;
    await ok('timeline.stop');
    const g = await ok('audio.setDelay', { ms: 300 });
    check('delay set', g.outputDelay === 300 && typeof g.mixerDelay === 'number');
    await ok('timeline.seek', { t: 0.3 });
    await ok('timeline.play');
    await sleep(60);
    const on = (await ok('audio.get')).playing;
    await ok('timeline.stop');
    check('with a 300 ms delay the audio starts 300 ms early', off === false && on === true, `without: ${off}, with: ${on}`);
    await ok('audio.setDelay', { ms: before });
  });

  await t.step('listen (plays by itself)', async () => {
    let g = await ok('audio.preview', { on: true, from: 1 });
    check('starts where asked, timeline still', g.previewing === true && g.playing === true && near(g.previewAt, 1, 0.05));
    await sleep(400);
    g = await ok('audio.get');
    check('moves on', g.previewing && g.previewAt > 1.2, String(g.previewAt));
    g = await ok('audio.preview', { on: false });
    check('stops', !g.previewing && !g.playing);
    await ok('audio.preview', { on: true, from: 2.7 });
    await sleep(700);
    g = await ok('audio.get');
    check('stops by itself at the end', !g.previewing && !g.playing);
    await ok('audio.preview', { on: true, from: 0 });
    await ok('timeline.seek', { t: 0 });
    await ok('timeline.play');
    await sleep(200);
    check('playing the timeline takes over', (await ok('audio.get')).previewing === false);
    await ok('timeline.stop');
  });

  await t.step('write keys (lip-sync, blinks)', async () => {
    const T = await ok('timeline.addTrack', { owner: 'Timeline', model: 'characterMouthOpen', oci: chara.id });
    const keys = [0.5, 0.6, 0.7, 0.8].map((x, i) => ({ t: x, value: { value: [0, 0.8, 0.2, 0][i] } }));
    check('4 keys written', (await ok('timeline.writeKeys', { track: T, keys, curve: 'linear', label: 'Lip-sync' })) === 4);
    let v = (await ok('timeline.keyValues', { tracks: [T] }))[String(T)];
    check('values as given', v.length === 4 && near(v[1][1].value, 0.8));
    await ok('timeline.writeKeys', { track: T, keys: [{ t: 0.65, value: { value: 0.5 } }], clear: [0.5, 0.8] });
    v = (await ok('timeline.keyValues', { tracks: [T] }))[String(T)];
    check('clear range replaces old keys', v.length === 1 && near(v[0][0], 0.65));
    await ok('undo');
    check('undo restores', (await ok('timeline.keyValues', { tracks: [T] }))[String(T)].length === 4);
  });

  await t.step('several clips', async () => {
    let g = await ok('audio.add', { file: 'StudioEX test tone.wav', offset: 4 });
    const [a, b] = g.clips;
    check('a second clip', g.clips.length === 2 && a.id !== b.id && near(b.offset, 4) && near(a.offset, 0.5), JSON.stringify(g.clips));
    g = await ok('audio.set', { id: b.id, volume: 0.3 });
    check('set by id leaves the other clip alone', near(g.clips[1].volume, 0.3) && near(g.clips[0].volume, 1));
    const p = await ok('audio.peaks', { id: b.id, perSecond: 100 });
    check('waveform per clip', p.id === b.id && Math.abs(p.peaks.length - 300) <= 1);
    await ok('timeline.seek', { t: 4.3 });
    await ok('timeline.play');
    await sleep(300);
    g = await ok('audio.get');
    check('each clip follows the playhead on its own (only the second is under it)', g.clips[1].playing === true && g.clips[0].playing === false, JSON.stringify(g.clips.map((c) => c.playing)));
    await ok('timeline.stop');
    g = await ok('audio.preview', { on: true, id: b.id, from: 0.5 });
    check('listen to one clip', g.previewing && g.previewId === b.id && g.clips[1].playing && !g.clips[0].playing);
    await ok('audio.preview', { on: false });
    const c = (await ok('audio.add', { file: 'StudioEX test tone.wav', offset: 7 })).clips[2];
    g = await ok('audio.remove', { id: c.id });
    check('remove one clip', g.clips.length === 2 && !g.clips.some((x) => x.id === c.id));
  });

  await t.step('balance, speed, fades, trims', async () => {
    const id = (await ok('audio.get')).clips[1].id;
    let g = await ok('audio.set', { id, pan: -0.5, speed: 2, fadeIn: 0.2, fadeOut: 0.3, trimIn: 0.5, trimOut: 0.5 });
    let c = g.clips[1];
    check('set', near(c.pan, -0.5) && near(c.speed, 2) && near(c.fadeIn, 0.2) && near(c.fadeOut, 0.3) && near(c.trimIn, 0.5) && near(c.trimOut, 0.5), JSON.stringify(c));
    check('it plays (3 s − 1 s of trims) ÷ 2 = 1 s on the timeline', near(c.span, 1, 0.01), String(c.span));
    g = await ok('audio.set', { id, pan: 5, speed: 99, trimIn: 2.9, trimOut: 2.9 });
    c = g.clips[1];
    check('kept in range (balance ±1, speed ≤ 4, trims leave some sound)', near(c.pan, 1) && near(c.speed, 4) && c.trimIn + c.trimOut <= 2.951 && c.span > 0, JSON.stringify(c));
    await ok('audio.set', { id, pan: -0.5, speed: 2, trimIn: 0.5, trimOut: 0.5, fadeIn: 0.2, fadeOut: 0.3 });
    // plays at the trimmed, faster place: 0.25 s into its span = 0.5 s trim + 0.25 × 2
    await ok('timeline.seek', { t: 4.25 });
    await ok('timeline.play');
    await sleep(150);
    g = await ok('audio.get');
    check('plays inside its span', g.clips[1].playing === true);
    await ok('timeline.seek', { t: 5.2 });
    await sleep(200);
    g = await ok('audio.get');
    check('stops after its span (4 s + 1 s)', g.clips[1].playing === false);
    await ok('timeline.stop');
  });

  await t.step('saved with the scene', async () => {
    const sceneDir = path.join(t.paths.userData, 'studio', 'scene');
    const before = new Set(fs.readdirSync(sceneDir));
    await ok('audio.set', { offset: 1.25 });
    await ok('scene.save');
    let added = [];
    for (let i = 0; i < 20 && !added.length; i++) {
      await sleep(500);
      added = fs.readdirSync(sceneDir).filter((f) => !before.has(f));
    }
    t.defer(() => {
      for (const f of added) if (/^\d{4}_\d{4}_\d{4}_\d{2}_\d{3}\.png$/.test(f) && fs.existsSync(path.join(sceneDir, f))) fs.unlinkSync(path.join(sceneDir, f));
    });
    check('scene saved', added.length === 1);
    await ok('scene.new');
    await sleep(1500);
    check('new scene: no audio', (await ok('audio.get')).loaded === false);
    await ok('scene.load', { path: path.join(sceneDir, added[0]) });
    let g;
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      g = await ok('audio.get');
      if (g.loaded && g.clips.length === 2) break;
    }
    check('loading the scene brings its audio back', g.loaded && g.file === 'StudioEX test tone.wav' && near(g.offset, 1.25), JSON.stringify(g));
    check('…every clip, with its start and volume', g.clips.length === 2 && near(g.clips[1].offset, 4) && near(g.clips[1].volume, 0.3), JSON.stringify(g.clips));
    const c = g.clips[1];
    check('…and its balance, speed, fades, trims', near(c.pan, -0.5) && near(c.speed, 2) && near(c.fadeIn, 0.2) && near(c.fadeOut, 0.3) && near(c.trimIn, 0.5) && near(c.trimOut, 0.5), JSON.stringify(c));
  });
}

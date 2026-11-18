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
      if (g.loaded) break;
    }
    check('loading the scene brings its audio back', g.loaded && g.file === 'StudioEX test tone.wav' && near(g.offset, 1.25), JSON.stringify(g));
  });
}

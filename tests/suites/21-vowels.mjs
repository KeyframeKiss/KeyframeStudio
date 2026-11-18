import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vowelPatterns, vowelTrack } from '../../app/src/lib/vowels.ts';

export const name = 'Lip-sync vowels: spectrum from a synthetic voice, mouth patterns, Mouth keys';

/**
 * A sung "a i u e o" (16-bit mono WAV): a 220 Hz pulse train through three resonators per vowel (source-filter
 * model of the voice), each vowel 0.35 s with 0.15 s of silence after it.
 */
const VOWELS = { a: [850, 1450], i: [330, 2650], u: [370, 1550], e: [560, 2250], o: [520, 950] };
function makeVoice(file, rate = 44100) {
  const seg = 0.35,
    gap = 0.15;
  const order = ['a', 'i', 'u', 'e', 'o'];
  const n = Math.floor(order.length * (seg + gap) * rate);
  const out = new Float64Array(n);
  const res = (f, bw) => {
    const r = Math.exp((-Math.PI * bw) / rate),
      th = (2 * Math.PI * f) / rate;
    return { a1: 2 * r * Math.cos(th), a2: -r * r, g: 1 - r };
  };
  order.forEach((v, k) => {
    const [f1, f2] = VOWELS[v];
    const filters = [res(f1, 80), res(f2, 110), res(2900, 160)];
    const start = Math.floor(k * (seg + gap) * rate),
      len = Math.floor(seg * rate);
    let x = new Float64Array(len);
    for (let i = 0; i < len; i++) x[i] = i % Math.round(rate / 220) === 0 ? 1 : 0;
    for (const f of filters) {
      const y = new Float64Array(len);
      for (let i = 0; i < len; i++) y[i] = f.g * x[i] + f.a1 * (y[i - 1] ?? 0) + f.a2 * (y[i - 2] ?? 0);
      x = y;
    }
    for (let i = 0; i < len; i++) out[start + i] = x[i] * Math.min(1, i / 400, (len - i) / 400);
  });
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round((out[i] / peak) * 22000), i * 2);
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
  return { order, seg, gap };
}

export default async function (t) {
  t.needs('timeline');
  const { ok, check } = t;
  const { chara } = await t.loadSample();
  const tmp = path.join(os.tmpdir(), 'StudioEX test vowels.wav');
  const { order, seg, gap } = makeVoice(tmp);
  const copied = path.join(t.paths.userData, 'audio', 'StudioEX test vowels.wav');
  t.defer(async () => {
    await ok('audio.clear');
    fs.rmSync(tmp, { force: true });
    fs.rmSync(copied, { force: true });
  });
  await ok('audio.load', { file: tmp.split(path.sep).join('/'), offset: 0 });

  const env = await ok('audio.envelope', { rate: 60 });
  const spec = await ok('audio.spectrum', { rate: 60 });
  check('spectrum: 40 bands per window, one window per envelope value', spec.bands === 40 && Math.abs(spec.values.length / 40 - env.values.length) <= 2, `${spec.values.length / 40} vs ${env.values.length}`);
  const labels = vowelTrack(spec, env.values);
  const hits = order.map((v, k) => {
    const a = Math.floor((k * (seg + gap) + 0.08) * spec.rate),
      b = Math.floor((k * (seg + gap) + seg - 0.08) * spec.rate);
    const mid = labels.slice(a, b);
    const top = ['a', 'i', 'u', 'e', 'o'].map((x) => [x, mid.filter((l) => l === x).length]).sort((p, q) => q[1] - p[1])[0][0];
    return `${v}→${top}`;
  });
  const right = hits.filter((h) => h[0] === h[2]).length;
  check('the vowels of a synthetic voice are recognised (4 of 5 or better)', right >= 4, hits.join(' '));
  const quiet = labels.slice(Math.floor((seg + 0.04) * spec.rate), Math.floor((seg + gap - 0.04) * spec.rate));
  check('silence between vowels has no shape', quiet.every((l) => l === null), quiet.join(','));

  const patterns = await ok('face.mouthPatterns', { id: chara.id });
  const map = vowelPatterns(patterns);
  check("the character's A/I/U/E/O mouth patterns are found", Object.keys(map).length === 5, JSON.stringify(map));

  // what the app writes: Mouth pattern keys (stepped)
  const track = await ok('timeline.addTrack', { owner: 'Timeline', model: 'characterMouth', oci: chara.id });
  await ok('timeline.writeKeys', { track, keys: [{ t: 0.5, value: { value: map.a } }, { t: 1, value: { value: map.o } }], curve: 'step', label: 'Lip-sync vowels' });
  const k = await ok('timeline.keyInfo', { track, t: 1 });
  check('Mouth keys hold the pattern number', Number(k.value.value) === map.o, JSON.stringify(k.value));
  await ok('undo');
}

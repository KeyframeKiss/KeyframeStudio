// Vowel lip-sync math (no Studio needed): synthetic voice spectra with known formants.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FORMANTS, formants, nearestVowel, smooth, vowelKeys, vowelPatterns, vowelTrack, VOWELS } from '../../app/src/lib/vowels.ts';

const BANDS = 40,
  FROM = 100,
  WIDTH = 80;

/** One window's envelope (dB per band) with resonances at f1 and f2 — what the plugin's LPC analysis sends. */
function window(f1, f2) {
  const out = [];
  for (let b = 0; b < BANDS; b++) {
    const hz = FROM + (b + 0.5) * WIDTH;
    const res = (f, bw) => 1 / (1 + ((hz - f) / bw) ** 2);
    out.push(10 * Math.log10(res(f1, 110) + 0.5 * res(f2, 150) + 0.01));
  }
  return out;
}
const spectrum = (wins, rate = 60) => ({ rate, bands: BANDS, from: FROM, width: WIDTH, values: wins.flat() });

test('formants are found near the resonances', () => {
  for (const v of VOWELS) {
    const [f1, f2] = FORMANTS[v];
    const [e1, e2] = formants(spectrum([window(f1, f2)]), 0);
    assert.ok(Math.abs(e1 - f1) < 200, `${v}: F1 ${e1} vs ${f1}`);
    assert.ok(Math.abs(e2 - f2) < 300, `${v}: F2 ${e2} vs ${f2}`);
  }
});

test('each vowel is recognised from its spectrum', () => {
  for (const v of VOWELS) {
    const [f1, f2] = FORMANTS[v];
    assert.equal(nearestVowel(formants(spectrum([window(f1, f2)]), 0)), v);
  }
});

test('a deeper or higher voice still reads right (speaker normalization)', () => {
  for (const k of [0.88, 1.12]) {
    // a sentence: every vowel for 0.2 s, shifted formants
    const wins = [],
      loud = [],
      want = [];
    for (const v of ['a', 'i', 'u', 'e', 'o', 'a', 'e', 'o']) {
      const [f1, f2] = FORMANTS[v];
      for (let i = 0; i < 12; i++) wins.push(window(f1 * k, f2 * k)), loud.push(1), want.push(v);
    }
    const got = vowelTrack(spectrum(wins), loud);
    const right = got.filter((g, i) => g === want[i]).length;
    assert.ok(right / got.length > 0.8, `scale ${k}: ${right}/${got.length} right`);
  }
});

test('quiet windows have no vowel', () => {
  const [f1, f2] = FORMANTS.a;
  const wins = Array.from({ length: 30 }, () => window(f1, f2));
  const loud = wins.map((_, i) => (i < 10 || i >= 20 ? 0.01 : 1));
  const got = vowelTrack(spectrum(wins), loud);
  assert.ok(got.slice(0, 8).every((g) => g === null));
  assert.ok(got.slice(12, 18).every((g) => g === 'a'));
});

test('one-window flickers are smoothed away', () => {
  const labels = ['a', 'a', 'a', 'i', 'a', 'a', 'a', 'o', 'o', 'o', 'o', 'o'];
  const out = smooth(labels, 3);
  assert.equal(out[3], 'a');
  assert.deepEqual(out.slice(7), ['o', 'o', 'o', 'o', 'o']);
});

test('keys only where the shape changes, ending at rest', () => {
  const keys = vowelKeys(['a', 'a', 'i', 'i', null, null, 'o'], 10);
  assert.deepEqual(keys.map((k) => k.v), ['a', 'i', null, 'o', null]);
  assert.equal(keys[1].t, 0.2);
});

test('mouth patterns are matched by shape name', () => {
  const pats = [
    { ptn: 0, close: 'kuti_face.f00_def_cl', open: 'kuti_face.f00_def_op' },
    { ptn: 22, close: 'kuti_face.f00_def_cl', open: 'kuti_face.f00_a_s_op' },
    { ptn: 23, close: 'kuti_face.f00_def_cl', open: 'kuti_face.f00_a_l_op' },
    { ptn: 25, close: 'kuti_face.f00_def_cl', open: 'kuti_face.f00_i_s_op' },
  ];
  assert.deepEqual(vowelPatterns(pats), { a: 23, i: 25 });
});

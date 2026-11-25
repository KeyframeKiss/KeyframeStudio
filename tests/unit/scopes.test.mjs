// Look › Picture scopes: histogram, waveform, vectorscope maths (no Studio needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chroma, histogram, vectorscope, waveform } from '../../app/src/lib/scopes.ts';

const px = (colors) => Uint8ClampedArray.from(colors.flatMap(([r, g, b]) => [r, g, b, 255]));

test('histogram counts each channel and brightness', () => {
  const h = histogram(px([[0, 0, 0], [255, 255, 255], [255, 0, 0]]));
  assert.equal(h.r[255], 2);
  assert.equal(h.g[0], 2);
  assert.equal(h.l[0], 1);
  assert.equal(h.l[255], 1);
  assert.equal(h.l[54], 1); // pure red's brightness (0.2126 × 255)
  assert.equal(h.max, 2);
});

test('waveform: a dark left half and a bright right half', () => {
  const w = 4, h = 2;
  const img = px([[0, 0, 0], [0, 0, 0], [255, 255, 255], [255, 255, 255], [0, 0, 0], [0, 0, 0], [255, 255, 255], [255, 255, 255]]);
  const { bins, max } = waveform(img, w, h, 2, 4);
  assert.equal(bins[0 * 4 + 0], 4); // left column, bottom level
  assert.equal(bins[1 * 4 + 3], 4); // right column, top level
  assert.equal(max, 4);
  const red = waveform(px([[255, 0, 0]]), 1, 1, 1, 4, 0);
  assert.equal(red.bins[3], 1);
});

test('vectorscope: grey in the middle, colours out along their angle', () => {
  assert.deepEqual(chroma(128, 128, 128).map((v) => Math.round(v * 1000)), [0, 0]);
  const [cb, cr] = chroma(255, 0, 0);
  assert.ok(cr > 0.45 && cb < 0, 'red: up and a little left');
  const v = vectorscope(px([[128, 128, 128], [128, 128, 128]]), 8);
  assert.equal(v.bins[4 * 8 + 4], 2);
});

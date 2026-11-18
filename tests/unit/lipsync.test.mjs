// Lip-sync math (no Studio needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blinkKeys, lipSyncKeys, LIPSYNC_DEFAULTS } from '../../app/src/lib/lipsync.ts';

test('silence keeps the mouth closed', () => {
  const env = new Array(60).fill(0.001);
  const keys = lipSyncKeys(env, 30, 0.5);
  assert.ok(keys.every((k) => k.v === 0), JSON.stringify(keys.slice(0, 5)));
  assert.ok(keys.length <= 3, 'redundant keys dropped');
});

test('a loud syllable opens the mouth, then it closes', () => {
  // 2 s at 30 windows/s: quiet, one 0.3 s loud burst at 1 s, quiet
  const env = Array.from({ length: 60 }, (_, i) => (i >= 30 && i < 39 ? 0.5 : 0.002));
  const keys = lipSyncKeys(env, 30, 0.5, LIPSYNC_DEFAULTS);
  const peak = Math.max(...keys.map((k) => k.v));
  const at = (t) => keys.reduce((best, k) => (Math.abs(k.t - t) < Math.abs(best.t - t) ? k : best)).v;
  assert.ok(peak > 0.7, `opens wide, got ${peak}`);
  assert.equal(at(0.5), 0, 'closed before');
  assert.ok(at(1.15) > 0.5, 'open during');
  assert.equal(keys[keys.length - 1].v, 0, 'closed at the end');
  assert.ok(keys.every((k) => k.v >= 0 && k.v <= 1));
});

test('noise under the threshold is ignored, sensitivity scales', () => {
  const env = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.03 : 0.5)); // max 0.5, noise 6%
  const strict = lipSyncKeys(env, 30, 0.5, { ...LIPSYNC_DEFAULTS, smoothing: 0, threshold: 0.1 });
  assert.ok(strict.some((k) => k.v > 0));
  const quiet = lipSyncKeys(new Array(30).fill(0.03), 30, 0.5, { ...LIPSYNC_DEFAULTS, threshold: 0.1 });
  assert.ok(quiet.every((k) => k.v === 0), 'below threshold stays shut');
  const soft = Math.max(...lipSyncKeys(new Array(30).fill(0.1), 30, 0.5, { ...LIPSYNC_DEFAULTS, sensitivity: 0.6 }).map((k) => k.v));
  const loud = Math.max(...lipSyncKeys(new Array(30).fill(0.1), 30, 0.5, { ...LIPSYNC_DEFAULTS, sensitivity: 2.5 }).map((k) => k.v));
  assert.ok(loud > soft, `${loud} > ${soft}`);
});

test('blinks: inside the range, closed then open, same seed same blinks', () => {
  const a = blinkKeys(0, 10, 3, 1, 7);
  assert.ok(a.length >= 8 && a.length % 4 === 0, String(a.length));
  assert.ok(a.every((k) => k.t > 0 && k.t < 10));
  assert.deepEqual(a.slice(0, 4).map((k) => k.v), [1, 0, 0, 1]);
  assert.deepEqual(blinkKeys(0, 10, 3, 1, 7), a);
});

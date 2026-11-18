// Unit tests for the motion cleanup math (no Studio needed): node tests/unit/motion.test.mjs
// Node 22.6+ loads the TypeScript module directly (type stripping).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPops, footSlides, popCulprits, quatAngle, slerp, smoothKeys } from '../../app/src/lib/motion.ts';

const near = (a, b, e = 1e-4) => Math.abs(a - b) < e;
const pos = (t, x) => ({ t, attrs: { valueX: x, valueY: 0, valueZ: 0 } });
const rotY = (t, deg) => {
  const h = (deg * Math.PI) / 360;
  return { t, attrs: { valueX: 0, valueY: Math.sin(h), valueZ: 0, valueW: Math.cos(h) } };
};

test('smoothing pulls a spike toward its neighbours, ends stay put', () => {
  const keys = [pos(0, 0), pos(1, 1), pos(2, 10), pos(3, 3), pos(4, 4)];
  const out = smoothKeys(keys, new Set([0, 1, 2, 3, 4]), 1, 1);
  assert.ok(!out.has(0) && !out.has(4), 'first/last keys never move');
  assert.ok(near(out.get(2).valueX, 2), `spike → line between neighbours, got ${out.get(2).valueX}`);
  const half = smoothKeys(keys, new Set([2]), 0.5, 1);
  assert.ok(near(half.get(2).valueX, 6), 'half strength = halfway');
});

test('smoothing respects key timing (uneven spacing)', () => {
  const keys = [pos(0, 0), pos(1, 5), pos(4, 4)];
  const out = smoothKeys(keys, new Set([1]), 1);
  assert.ok(near(out.get(1).valueX, 1), `t=1 of 0..4 → 1, got ${out.get(1).valueX}`);
});

test('rotations smooth along the shortest arc and stay normalized', () => {
  const keys = [rotY(0, 0), rotY(1, 120), rotY(2, 40)];
  const out = smoothKeys(keys, new Set([1]), 1).get(1);
  const l = Math.hypot(out.valueX, out.valueY, out.valueZ, out.valueW);
  assert.ok(near(l, 1, 1e-6), 'unit quaternion');
  const angle = quatAngle([0, 0, 0, 1], [out.valueX, out.valueY, out.valueZ, out.valueW]);
  assert.ok(near(angle, 20, 0.01), `halfway between 0° and 40° is 20°, got ${angle}`);
  const s = slerp([0, 0, 0, 1], [0, -Math.sin(Math.PI / 4), 0, -Math.cos(Math.PI / 4)], 0.5);
  assert.ok(near(quatAngle([0, 0, 0, 1], s), 45, 0.01), 'double cover handled');
});

test('pops: the one fast segment is found, even motion is not', () => {
  const even = Array.from({ length: 8 }, (_, i) => pos(i, i));
  assert.equal(findPops(even).length, 0);
  const keys = [pos(0, 0), pos(1, 1), pos(2, 2), pos(2.1, 7), pos(3, 8), pos(4, 9), pos(5, 10)];
  const pops = findPops(keys);
  assert.equal(pops.length, 1);
  assert.equal(pops[0].index, 2);
  assert.ok(pops[0].ratio > 20);
});

test('pop culprit: the spike key, not its neighbours', () => {
  const keys = [pos(0, 0), pos(1, 0.1), pos(2, 0.2), pos(2.2, 1.4), pos(3, 0.4), pos(4, 0.5), pos(5, 0.6)];
  const pops = findPops(keys);
  assert.deepEqual(popCulprits(keys, pops), [3]);
  const fixed = smoothKeys(keys, new Set([3]), 1).get(3).valueX;
  assert.ok(near(fixed, 0.24), `back on the line between 0.2 and 0.4 at t=2.2 → 0.24, got ${fixed}`);
  // a step (one fast segment that then holds): the key that's off its neighbours' line
  const step = [pos(0, 0), pos(1, 0.1), pos(2, 0.2), pos(2.1, 3), pos(3, 3.1), pos(4, 3.2), pos(5, 3.3)];
  const c = popCulprits(step, findPops(step));
  assert.equal(c.length, 1);
});

test('foot sliding: planted foot moving sideways is reported, a step is not', () => {
  const times = Array.from({ length: 21 }, (_, i) => i * 0.05);
  // height 1.6: on the ground (y=0) sliding 0.5 units/s for the first half, then lifted (y=0.3) moving fast
  const slide = times.map((t) => (t <= 0.5 ? [t * 0.5, 0, 0] : [0.25 + (t - 0.5) * 3, 0.3, 0]));
  const ranges = footSlides(times, { cf_j_foot_L: slide }, 1.6);
  assert.equal(ranges.length, 1);
  assert.ok(near(ranges[0].t0, 0) && near(ranges[0].t1, 0.5), JSON.stringify(ranges));
  const planted = times.map(() => [0, 0, 0]);
  assert.equal(footSlides(times, { cf_j_foot_R: planted }, 1.6).length, 0);
});

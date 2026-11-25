// Grading tone curves: parse / format, smooth through the points, never overshooting (no Studio needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { curveFn, formatCurve, isIdentity, parseCurve } from '../../app/src/lib/toneCurve.ts';

test('parse and format round-trip; bad input falls back to a straight line', () => {
  assert.deepEqual(parseCurve('0,0 0.5,0.6 1,1'), [[0, 0], [0.5, 0.6], [1, 1]]);
  assert.equal(formatCurve([[1, 1], [0, 0.1]]), '0,0.1 1,1');
  assert.deepEqual(parseCurve('nonsense'), [[0, 0], [1, 1]]);
  assert.ok(isIdentity('0,0 1,1'));
  assert.ok(!isIdentity('0,0.1 1,1'));
});

test('passes through every point', () => {
  const f = curveFn(parseCurve('0,0 0.25,0.4 0.75,0.6 1,1'));
  for (const [x, y] of [[0, 0], [0.25, 0.4], [0.75, 0.6], [1, 1]]) assert.ok(Math.abs(f(x) - y) < 1e-6, `${x} → ${f(x)}`);
});

test('monotone between points (no wiggles above or below)', () => {
  const f = curveFn(parseCurve('0,0 0.3,0.8 0.35,0.82 1,1'));
  let last = -1;
  for (let i = 0; i <= 100; i++) {
    const y = f(i / 100);
    assert.ok(y >= last - 1e-9, `drops at ${i / 100}`);
    assert.ok(y <= 1 && y >= 0);
    last = y;
  }
});

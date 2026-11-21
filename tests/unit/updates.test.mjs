// Version comparison behind the update notice (the app's and the main process's copies must agree).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { compareVersions, parseVersion } from '../../app/src/lib/updates.ts';

const main = createRequire(import.meta.url)('../../app/electron/updates.cjs');

test('release tags parse to numbers', () => {
  assert.deepEqual(parseVersion('v0.1.1-beta'), [0, 1, 1]);
  assert.deepEqual(parseVersion('0.10.2'), [0, 10, 2]);
  assert.equal(parseVersion('beta'), null);
  assert.equal(parseVersion(null), null);
  assert.deepEqual(main.parse('v1.2.3-rc.1'), [1, 2, 3]);
  assert.equal(main.parse('nightly'), null);
});

test('newer, older and the same', () => {
  const cases = [
    ['0.1.1', '0.1.0', 1],
    ['0.1.0', '0.1.1', -1],
    ['v0.1.1-beta', '0.1.1', 0],
    ['0.10.0', '0.9.9', 1], // numbers, not text
    ['1.0.0', '0.99.99', 1],
  ];
  for (const [a, b, sign] of cases) {
    assert.equal(Math.sign(compareVersions(a, b)), sign, `${a} vs ${b}`);
    assert.equal(Math.sign(main.compare(main.parse(a), main.parse(b))), sign, `main: ${a} vs ${b}`);
  }
  assert.equal(compareVersions('x', '0.1.0'), null);
});

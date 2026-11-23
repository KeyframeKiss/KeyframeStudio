// Shot track editing: move, trim / move the cut, swap, reorder, split, duplicate, gaps and overlaps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { covered, duplicateShot, fixOverlaps, moveShot, newShotAt, pastEnd, problems, reorder, room, shotAt, snapTime, splitShot, swapWith, trimShot, trimToEnd } from '../../app/src/lib/shots.ts';

const S = (id, start, end) => ({ id, name: id.toUpperCase(), start, end });
const at = (list, id) => list.find((s) => s.id === id);
const span = (s) => [s.start, s.end];

test('snapping: frames, or a nearby target', () => {
  assert.equal(snapTime(1.013, 30), 1);
  assert.equal(snapTime(1.013, 30, [1.02], 0.02), 1.02);
  assert.equal(snapTime(1.5, 30, [1.9], 0.1), 1.5);
});

test('moving stays between the neighbours', () => {
  const l = [S('a', 0, 2), S('b', 3, 4), S('c', 6, 8)];
  assert.deepEqual(room(l, 'b', 10), { lo: 2, hi: 6 });
  assert.deepEqual(span(at(moveShot(l, 'b', 4.5, 10), 'b')), [4.5, 5.5]);
  assert.deepEqual(span(at(moveShot(l, 'b', 9, 10), 'b')), [5, 6]); // stops at c
  assert.deepEqual(span(at(moveShot(l, 'b', -5, 10), 'b')), [2, 3]); // stops at a
  assert.deepEqual(span(at(moveShot(l, 'c', 20, 10), 'c')), [8, 10]); // stops at the end
});

test('trimming: a shared cut moves both shots, a free edge stops at the neighbour', () => {
  const l = [S('a', 0, 2), S('b', 2, 4), S('c', 5, 8)];
  const cut = trimShot(l, 'b', 'start', 1.5, 10);
  assert.deepEqual([span(at(cut, 'a')), span(at(cut, 'b'))], [[0, 1.5], [1.5, 4]]);
  const free = trimShot(l, 'b', 'end', 9, 10);
  assert.deepEqual(span(at(free, 'b')), [2, 5]);
  assert.deepEqual(span(at(free, 'c')), [5, 8]);
  const tiny = trimShot(l, 'b', 'end', 2, 10);
  assert.ok(Math.abs(at(tiny, 'b').end - 2.1) < 1e-6, 'never shorter than a tenth of a second');
});

test('swapping neighbours keeps lengths and the gap between them', () => {
  const l = [S('a', 0, 2), S('b', 3, 4)];
  const r = swapWith(l, 'a', 1);
  assert.deepEqual(span(at(r, 'b')), [0, 1]);
  assert.deepEqual(span(at(r, 'a')), [2, 4]);
  assert.equal(swapWith(l, 'b', 1), l, 'the last shot has nothing after it');
});

test('reordering lays shots back to back from the first start', () => {
  const l = [S('a', 1, 3), S('b', 3, 4), S('c', 5, 6)];
  const r = reorder(l, ['c', 'a', 'b'], 10);
  assert.deepEqual([span(at(r, 'c')), span(at(r, 'a')), span(at(r, 'b'))], [[1, 2], [2, 4], [4, 5]]);
});

test('split and duplicate', () => {
  const l = [S('a', 0, 4), S('b', 6, 8)];
  const s = splitShot(l, 'a', 1.5, 'n');
  assert.deepEqual([span(at(s, 'a')), span(at(s, 'n'))], [[0, 1.5], [1.5, 4]]);
  assert.equal(at(s, 'n').name, 'A B');
  assert.equal(splitShot(l, 'a', 0.05, 'n'), null, 'too close to the edge');
  const d = duplicateShot(l, 'a', 'n', 10);
  assert.deepEqual(span(at(d, 'n')), [4, 6], 'fits the gap before b');
  assert.equal(duplicateShot([S('a', 0, 2), S('b', 2, 4)], 'a', 'n', 10), null, 'no room');
});

test('a new shot fills from the playhead to the next shot', () => {
  const l = [S('a', 0, 2), S('b', 5, 8)];
  assert.deepEqual(newShotAt(l, 2.5, 10), { start: 2.5, end: 5 });
  assert.deepEqual(newShotAt(l, 1, 10), { start: 2, end: 5 }, 'inside a shot: starts after it');
  assert.deepEqual(newShotAt(l, 8, 10), { start: 8, end: 10 });
  assert.equal(newShotAt([S('a', 0, 10)], 9.99, 10), null);
});

test('gaps, overlaps, coverage, the shot under the playhead', () => {
  const l = [S('a', 0, 2), S('b', 1.5, 3), S('c', 4, 5)];
  const p = problems(l);
  assert.deepEqual(p.map((x) => [x.kind, x.start, x.end]), [['overlap', 1.5, 2], ['gap', 3, 4]]);
  assert.equal(covered(l), 4);
  assert.deepEqual(span(at(fixOverlaps(l), 'a')), [0, 1.5]);
  assert.equal(shotAt(l, 1.7).id, 'b', 'a later shot wins an overlap');
  assert.equal(shotAt(l, 5).id, 'c', 'the very end belongs to the last shot');
  assert.equal(shotAt(l, 3.5), null);
});

test('a timeline made shorter than the shots', () => {
  const l = [S('a', 0, 3), S('b', 3, 6), S('c', 6, 8)];
  assert.deepEqual(pastEnd(l, 5).map((x) => x.id), ['b', 'c']);
  const t = trimToEnd(l, 5);
  assert.deepEqual(t.map((x) => [x.id, x.start, x.end]), [['a', 0, 3], ['b', 3, 5]], 'b ends at the end, c (past it) is left out');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { shuffle, selectWinners } from '../lib/raffle-draw.ts';

test('shuffle never mutates the input array', () => {
  const input = [1, 2, 3, 4, 5];
  const copy = [...input];
  shuffle(input, () => 0.5);
  assert.deepEqual(input, copy);
});

test('shuffle preserves every element (same multiset, different order allowed)', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const shuffled = shuffle(input, Math.random);
  assert.deepEqual([...shuffled].sort(), [...input].sort());
});

test('shuffle with a deterministic RNG (always 0) produces a fixed, reproducible order', () => {
  const input = ['a', 'b', 'c', 'd'];
  const result1 = shuffle(input, () => 0);
  const result2 = shuffle(input, () => 0);
  assert.deepEqual(result1, result2);
});

test('selectWinners: winnerCount 0 selects nobody', () => {
  const { winners, notSelected } = selectWinners([1, 2, 3], 0);
  assert.deepEqual(winners, []);
  assert.equal(notSelected.length, 3);
});

test('selectWinners: winnerCount >= entries.length selects everyone as a winner', () => {
  const { winners, notSelected } = selectWinners([1, 2, 3], 10);
  assert.equal(winners.length, 3);
  assert.equal(notSelected.length, 0);
});

test('selectWinners: winners + notSelected partition the full entry set with no overlap or loss', () => {
  const entries = Array.from({ length: 20 }, (_, i) => `entry-${i}`);
  const { winners, notSelected } = selectWinners(entries, 6);
  assert.equal(winners.length, 6);
  assert.equal(notSelected.length, 14);
  const combined = [...winners, ...notSelected].sort();
  assert.deepEqual(combined, [...entries].sort());
  // no entry appears in both
  const winnerSet = new Set(winners);
  for (const n of notSelected) assert.equal(winnerSet.has(n), false);
});

test('selectWinners: a negative or non-finite winnerCount is treated as 0, never throws', () => {
  assert.deepEqual(selectWinners([1, 2, 3], -5).winners, []);
  assert.deepEqual(selectWinners([1, 2, 3], NaN).winners, []);
  assert.deepEqual(selectWinners([1, 2, 3], Infinity).winners.length, 3);
});

test('selectWinners: an empty entry list never throws and selects nobody', () => {
  const { winners, notSelected } = selectWinners([], 5);
  assert.deepEqual(winners, []);
  assert.deepEqual(notSelected, []);
});

test('selectWinners: a fractional winnerCount is floored', () => {
  const { winners } = selectWinners([1, 2, 3, 4, 5], 2.9);
  assert.equal(winners.length, 2);
});

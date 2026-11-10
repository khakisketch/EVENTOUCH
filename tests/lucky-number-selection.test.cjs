'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { drawUniqueNumbers } = require('../server/lucky-number-draw');

test('every ordered draw from a fragmented pool has one equally likely path', () => {
  const outcomes = new Set();
  for (let first = 0; first < 3; first += 1) {
    for (let second = 0; second < 2; second += 1) {
      const draws = [first, second];
      const result = drawUniqueNumbers({ min: 5, max: 9 }, new Set([6, 8]), 2, max => {
        assert.equal(max, draws.length === 2 ? 3 : 2);
        return draws.shift();
      });
      assert.equal(new Set(result).size, 2);
      assert.ok(result.every(value => [5, 7, 9].includes(value)));
      outcomes.add(result.join(','));
    }
  }
  assert.equal(outcomes.size, 6);
});

test('a full draw, the last available number and genuinely exhausted pools are exact', () => {
  const filled = drawUniqueNumbers({ min: 100, max: 999 }, new Set(), 900);
  assert.equal(filled.length, 900);
  assert.equal(new Set(filled).size, 900);
  assert.ok(filled.every(number => number >= 100 && number <= 999));
  const occupied = new Set(Array.from({ length: 899 }, (_, index) => index + 100));
  assert.deepEqual(drawUniqueNumbers({ min: 100, max: 999 }, occupied, 1), [999]);
  assert.equal(drawUniqueNumbers({ min: 100, max: 999 }, occupied, 2), null);
  assert.deepEqual(drawUniqueNumbers({ min: 1, max: 1 }, new Set([1]), 0), []);
  assert.deepEqual(drawUniqueNumbers({ min: 5, max: 5 }, new Set([4, 6]), 1), [5]);
});

test('every small occupancy pattern can allocate precisely its remaining numbers', () => {
  for (let width = 1; width <= 9; width += 1) {
    for (let mask = 0; mask < 2 ** width; mask += 1) {
      const occupied = new Set(), expected = [];
      for (let offset = 0; offset < width; offset += 1) {
        if (mask & (1 << offset)) occupied.add(20 + offset);
        else expected.push(20 + offset);
      }
      const result = drawUniqueNumbers({ min: 20, max: 19 + width }, occupied, expected.length);
      assert.deepEqual(result.sort((a, b) => a - b), expected);
    }
  }
});

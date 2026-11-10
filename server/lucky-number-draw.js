'use strict';

const crypto = require('node:crypto');

// Draw ranks from the currently available numbers with a sparse
// Fisher-Yates shuffle. Each rank is selected uniformly without replacement;
// unlike repeated random guesses, a nearly full pool cannot fail by chance.
function drawUniqueNumbers(range, taken, count, randomInt = crypto.randomInt) {
  const size = range.max - range.min + 1;
  const occupied = [...taken].filter(number => number >= range.min && number <= range.max).sort((a, b) => a - b);
  const available = size - occupied.length;
  if (count > available) return null;
  const swaps = new Map();
  const assigned = [];
  for (let index = 0; index < count; index += 1) {
    const last = available - index - 1;
    const pick = randomInt(last + 1);
    const rank = swaps.has(pick) ? swaps.get(pick) : pick;
    const replacement = swaps.has(last) ? swaps.get(last) : last;
    if (pick !== last) swaps.set(pick, replacement);
    swaps.delete(last);

    // Find how many occupied numbers precede the selected available rank.
    let low = 0, high = occupied.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const availableBefore = occupied[middle] - range.min - middle;
      if (availableBefore <= rank) low = middle + 1;
      else high = middle;
    }
    assigned.push(range.min + rank + low);
  }
  return assigned;
}

module.exports = { drawUniqueNumbers };

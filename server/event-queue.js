'use strict';

// Writes to one event are serialized by its row lock. Waiting for that lock inside a
// transaction holds a pool connection, so a venue's opening rush used up the pool and failed
// every other request. These queues make requests wait in memory instead. The database lock
// still decides correctness; a second API process would only lose the smoothing.

const { failure } = require('./commands/shared.ts');

const WAITING_LIMIT = 2000;
const busy = () => failure(503, '요청이 몰리고 있습니다. 잠시 후 같은 버튼을 다시 눌러 주세요.', undefined, 'EVENT_BUSY');

// At most `width` tasks per key at a time, the rest in arrival order. A width below the pool
// size leaves connections for the desks and everyone else.
function createGate({ width = 1, limit = WAITING_LIMIT } = {}) {
  const lines = new Map();
  return async function gate(key, task) {
    const line = lines.get(key) || { running: 0, waiting: [] };
    if (line.running + line.waiting.length >= limit) throw busy();
    lines.set(key, line);
    // A waiting task is handed the finished task's place.
    if (line.running < width) line.running += 1;
    else await new Promise((resolve) => line.waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = line.waiting.shift();
      if (next) next();
      else if (!(line.running -= 1)) lines.delete(key);
    }
  };
}

// Everything waiting for one key is handled together. `run(key, items)` returns one
// `{ value }` or `{ error }` per item; if it throws, the whole batch gets that error.
function createBatchQueue(run, { size = 100, limit = WAITING_LIMIT } = {}) {
  const lines = new Map();
  async function drain(key, line) {
    await new Promise((resolve) => setImmediate(resolve));
    while (line.length) {
      const batch = line.splice(0, size);
      try {
        const outcomes = await run(key, batch.map((entry) => entry.item));
        batch.forEach((entry, index) => (outcomes[index].error
          ? entry.reject(outcomes[index].error) : entry.resolve(outcomes[index].value)));
      } catch (error) {
        batch.forEach((entry) => entry.reject(error));
      }
    }
    lines.delete(key);
  }
  return function enqueue(key, item) {
    return new Promise((resolve, reject) => {
      let line = lines.get(key);
      if (line && line.length >= limit) return reject(busy());
      if (!line) {
        line = [];
        lines.set(key, line);
        void drain(key, line);
      }
      line.push({ item, resolve, reject });
    });
  };
}

module.exports = { createBatchQueue, createGate };

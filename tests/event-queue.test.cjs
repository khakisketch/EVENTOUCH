'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBatchQueue, createGate } = require('../server/event-queue');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('tasks for one key run one at a time by default, in order, and survive a failure', async () => {
  const serial = createGate();
  const log = [];
  let running = 0;
  const task = (name, fail) => async () => {
    running += 1;
    assert.equal(running, 1);
    await tick();
    running -= 1;
    log.push(name);
    if (fail) throw new Error(name);
    return name;
  };
  const results = await Promise.allSettled([serial('a', task('1')), serial('a', task('2', true)), serial('a', task('3'))]);
  assert.deepEqual(log, ['1', '2', '3']);
  assert.deepEqual(results.map((item) => item.status), ['fulfilled', 'rejected', 'fulfilled']);
});

test('a wider gate runs that many at once and no more', async () => {
  const gate = createGate({ width: 3 });
  let running = 0;
  let most = 0;
  const order = [];
  await Promise.all(Array.from({ length: 10 }, (_, i) => gate('a', async () => {
    order.push(i);
    running += 1;
    most = Math.max(most, running);
    await tick();
    running -= 1;
  })));
  assert.equal(most, 3);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('a full line is refused instead of growing', async () => {
  const serial = createGate({ limit: 1 });
  const first = serial('a', tick);
  await assert.rejects(serial('a', tick), { status: 503, code: 'EVENT_BUSY' });
  await first;
  await serial('a', tick);
  const batch = createBatchQueue(async (key, items) => items.map((value) => ({ value })), { limit: 1 });
  const held = batch('a', 1);
  await assert.rejects(batch('a', 2), { status: 503 });
  assert.equal(await held, 1);
});

test('items waiting together are run together; one refusal does not fail the others', async () => {
  const batches = [];
  const enqueue = createBatchQueue(async (key, items) => {
    batches.push(items);
    await tick();
    return items.map((value) => (value === 'bad' ? { error: new Error('refused') } : { value }));
  }, { size: 3 });
  const results = await Promise.allSettled(['a', 'bad', 'c', 'd'].map((value) => enqueue('event', value)));
  assert.deepEqual(batches, [['a', 'bad', 'c'], ['d']]);
  assert.deepEqual(results.map((item) => item.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
});

test('a failed batch rejects its items and the next one still runs', async () => {
  let calls = 0;
  const enqueue = createBatchQueue(async (key, items) => {
    calls += 1;
    if (calls === 1) throw new Error('database');
    return items.map((value) => ({ value }));
  });
  await assert.rejects(enqueue('event', 1), /database/);
  assert.equal(await enqueue('event', 2), 2);
});

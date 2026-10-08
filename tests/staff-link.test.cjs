'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = path.join(__dirname, '..', 'assets', 'js', 'core.js');

function loadCore() {
  const window = {
    ET: null,
    crypto: { randomUUID: () => 'id-fixed' },
    location: { href: 'http://product.test/#/console/agency/events' },
  };
  vm.runInNewContext(fs.readFileSync(SOURCE, 'utf8'), { window, Date, JSON, Number, Math, String, Object });
  return window.ET;
}

test('staffURLFor builds the assignment link from the explicit event id', () => {
  const E = loadCore();
  assert.equal(E.staffURLFor('event-a', { id: 'as-1' }), '#/staff/event-a/as-1');
  assert.equal(E.staffURLFor('event-b', { id: 'as-2' }), '#/staff/event-b/as-2');
});

test('staffURL keeps the same-event shortcut and throws without an event context', () => {
  const E = loadCore();
  E.state = { events: [{ id: 'event-a' }], workspaces: {}, activeEventId: 'event-a' };
  E.route = { eventId: 'event-a' };
  assert.equal(E.staffURL({ id: 'as-1' }), '#/staff/event-a/as-1');
  E.route = { scope: 'console' };
  assert.throws(() => E.staffURL({ id: 'as-1' }), /Cannot read properties of null/);
});

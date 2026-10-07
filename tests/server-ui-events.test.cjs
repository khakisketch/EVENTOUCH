'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const listeners = {};
  const E = { esc: String, ui: { filters: {} }, actions: {}, forms: {} };
  const document = { addEventListener(name, fn) { listeners[name] = fn; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/ui.js'), 'utf8'), {
    window: { ET: E, addEventListener() {} }, document,
  });
  return { E, listeners };
}

test('removing a focused search input cannot reenter render through its same-value change event', () => {
  const { E, listeners } = load();
  const target = { dataset: { filter: 'events' }, value: '없는 행사', selectionStart: 5, closest: () => null };
  let renders = 0;
  E.render = () => {
    renders += 1;
    if (renders > 1) throw Error('reentrant DOM replacement');
    listeners.change({ target });
  };
  listeners.input({ target });
  assert.equal(renders, 1);
  assert.equal(E.ui.filters.events, target.value);
});

test('changed select filters still trigger exactly one render', () => {
  const { E, listeners } = load();
  let renders = 0;
  E.render = () => { renders += 1; };
  listeners.change({ target: { dataset: { filter: 'eventStatus' }, value: 'LIVE' } });
  assert.equal(renders, 1);
  assert.equal(E.ui.filters.eventStatus, 'LIVE');
});

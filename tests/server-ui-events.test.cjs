'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(location = { hash: '' }) {
  const listeners = {};
  const E = { esc: String, ui: { filters: {} }, actions: {}, forms: {} };
  const document = {
    addEventListener(name, fn) { listeners[name] = fn; },
    querySelector() { return null; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/ui.js'), 'utf8'), {
    window: { ET: E, location, addEventListener() {} }, document,
  });
  return { E, listeners };
}

function submitFormFixture() {
  const summary = { textContent: '', tabIndex: 0 };
  const submit = { textContent: '저장', disabled: false };
  const form = {
    dataset: { form: 'attendee-register' },
    elements: [],
    isConnected: true,
    matches: () => true,
    getAttribute: () => null,
    querySelector(selector) {
      return selector === '.error-summary' ? summary : selector === '[type=submit]' ? submit : null;
    },
    setAttribute() {},
    removeAttribute() {},
  };
  return { form, submit };
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

test('successful form navigation does not show a generic toast on the destination screen', async () => {
  const location = { hash: '#/event/demo/register' };
  const { E, listeners } = load(location);
  const { form } = submitFormFixture();
  let toast = null;
  E.validateInput = () => true;
  E.formData = () => ({ name: '테스트 참가자' });
  E.draftKey = () => 'public|register';
  E.toast = message => { toast = message; };
  E.forms['attendee-register'] = async () => {
    location.hash = '#/event/demo/ticket?ticket=issued-ticket';
  };

  await listeners.submit({ target: form, preventDefault() {} });

  assert.equal(location.hash, '#/event/demo/ticket?ticket=issued-ticket');
  assert.equal(toast, null);
});

test('successful forms that stay on the same route retain generic feedback', async () => {
  const { E, listeners } = load({ hash: '#/console/events/demo/settings' });
  const { form } = submitFormFixture();
  let toast = null;
  E.validateInput = () => true;
  E.formData = () => ({});
  E.draftKey = () => 'admin|settings';
  E.toast = message => { toast = message; };
  E.forms['attendee-register'] = async () => {};

  await listeners.submit({ target: form, preventDefault() {} });

  assert.equal(toast, '처리 결과를 반영했습니다.');
});

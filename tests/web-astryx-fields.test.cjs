'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { React, renderComponent } = require('./helpers/render-web-component.cjs');

test('native text input preserves external form and native attributes', () => {
  const input = renderComponent('ProductInput', {
    id: 'name', name: 'name', form: 'profile-form', onChange() {}, value: 'Ada', type: 'text', required: true,
    autoComplete: 'name', inputMode: 'text', 'aria-describedby': 'name-help', 'data-field': 'profile',
  }).querySelector('input');
  for (const [key, value] of Object.entries({ id: 'name', name: 'name', form: 'profile-form', value: 'Ada', type: 'text', required: '', autoComplete: 'name', inputMode: 'text', 'aria-describedby': 'name-help', 'data-field': 'profile' })) {
    assert.equal(input.getAttribute(key), value, key);
  }
});

test('native input types preserve checkbox values and disabled required semantics', () => {
  const checkbox = renderComponent('ProductInput', { type: 'checkbox', name: 'choice', value: 'custom', checked: true, onChange() {} }).querySelector('input');
  assert.equal(checkbox.getAttribute('value'), 'custom');
  assert.equal(checkbox.hasAttribute('checked'), true);
  const disabled = renderComponent('ProductInput', { name: 'locked', value: 'x', disabled: true, required: true }).querySelector('input');
  assert.equal(disabled.hasAttribute('disabled'), true);
  assert.equal(disabled.hasAttribute('required'), true);
  assert.equal(disabled.getAttribute('name'), 'locked');
});

test('select remains a native select with options and external form association', () => {
  const select = renderComponent('ProductSelect', { id: 'status', name: 'status', form: 'edit-form', value: 'ready', onChange() {}, required: true },
    React.createElement('option', { value: 'ready' }, 'Ready'), React.createElement('option', { value: 'hold' }, 'Hold')).querySelector('select');
  assert.equal(select.getAttribute('form'), 'edit-form');
  assert.equal(select.getAttribute('name'), 'status');
  assert.equal(select.getAttribute('required'), '');
  assert.equal(select.querySelector('option[selected]').getAttribute('value'), 'ready');
});

test('textarea remains native and preserves external form, rows, and value', () => {
  const textarea = renderComponent('ProductTextarea', { id: 'notes', name: 'notes', form: 'edit-form', rows: 5, onChange() {}, value: 'hello', required: true }).querySelector('textarea');
  assert.equal(textarea.getAttribute('form'), 'edit-form');
  assert.equal(textarea.getAttribute('rows'), '5');
  assert.equal(textarea.textContent, 'hello');
  assert.equal(textarea.hasAttribute('required'), true);
});

test('explicitly labeled supported text input uses Astryx TextInput', () => {
  const doc = renderComponent('ProductInput', { label: 'Email', labelMode: 'astryx', type: 'email', name: 'email', onChange() {}, value: 'a@b.test', required: true, autoComplete: 'email' });
  const input = doc.querySelector('input');
  assert.ok(doc.querySelector('.astryx-text-input'));
  assert.equal(input.getAttribute('name'), 'email');
  assert.equal(input.getAttribute('aria-required'), 'true');
  assert.equal(input.getAttribute('autoComplete'), 'email');
});

test('labeled Astryx entry retains native required validation', () => {
  const input = renderComponent('ProductInput', { labelMode: 'astryx', label: 'Email', type: 'email', value: '', required: true, onChange() {} }).querySelector('input');
  assert.equal(input.hasAttribute('required'), true);
});

test('disabling labeled entry keeps its label and native disabled attribute', () => {
  const doc = renderComponent('ProductInput', { labelMode: 'astryx', label: 'Email', type: 'email', name: 'email', value: '', disabled: true, onChange() {} });
  assert.match(doc.body.textContent, /Email/);
  assert.equal(doc.querySelector('input').hasAttribute('disabled'), true);
  assert.equal(doc.querySelector('input').getAttribute('name'), 'email');
});

test('compatibility fallback retains an explicit label and custom native capitalization', () => {
  const doc = renderComponent('ProductInput', { labelMode: 'astryx', label: '코드', value: 'TEST', autoCapitalize: 'custom', size: 10, onChange() {} });
  assert.match(doc.body.textContent, /코드/);
  assert.equal(doc.querySelector('input').getAttribute('autoCapitalize'), 'custom');
  assert.equal(doc.querySelector('input').getAttribute('size'), '10');
});

test('labeled entry keeps its external form and native read-only semantics', () => {
  const input = renderComponent('ProductInput', { labelMode: 'astryx', label: '이메일', value: 'a@b.test', name: 'email', form: 'outer', readOnly: true, 'aria-describedby': 'email-help' }).querySelector('input');
  assert.equal(input.getAttribute('form'), 'outer');
  assert.equal(input.getAttribute('name'), 'email');
  assert.equal(input.hasAttribute('readOnly'), true);
  assert.equal(input.getAttribute('aria-describedby'), 'email-help');
});

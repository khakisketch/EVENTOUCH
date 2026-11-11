'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const auditPath = path.join(__dirname, '..', 'scripts', 'web-event-card-a2-audit.cjs');
const source = fs.readFileSync(auditPath, 'utf8');
// Load the browser-serializable measurement without running its DB/UI audit.
const helpers = source.slice(0, source.indexOf('\nasync function main() {'));
const sandbox = {
  require: createRequire(auditPath),
  __dirname: path.dirname(auditPath),
  process: { env: { ...process.env } },
  getComputedStyle: (element) => element.computedStyle,
};
vm.createContext(sandbox);
vm.runInContext(`${helpers}\nthis.measure = typeof effectiveBackground === 'function' ? effectiveBackground : null;`, sandbox);

function element(backgroundColor, parentElement = null, extra = {}) {
  return { parentElement, computedStyle: { backgroundColor, backgroundImage: 'none', opacity: '1', ...extra } };
}

function measure(target) {
  assert.equal(typeof sandbox.measure, 'function', 'audit needs effective ancestor background measurement');
  return Array.from(sandbox.measure(target));
}

test('transparent row children inherit the actual white ledger, not transparent black', () => {
  const workspace = element('rgb(244, 245, 247)');
  const row = element('rgb(255, 255, 255)', workspace);
  const link = element('rgba(0, 0, 0, 0)', row);
  assert.deepEqual(measure(element('rgba(0, 0, 0, 0)', link)), [255, 255, 255]);
});

test('opaque black is measured as black rather than assumed white', () => {
  assert.deepEqual(measure(element('rgb(0, 0, 0)', element('rgb(255, 255, 255)'))), [0, 0, 0]);
});

test('a transparent row on the neutral workspace cannot pass the white surface assertion', () => {
  assert.deepEqual(measure(element('rgba(0, 0, 0, 0)', element('rgb(244, 245, 247)'))), [244, 245, 247]);
});

test('translucent paint composites against its ancestor in front-to-back order', () => {
  const white = element('rgb(255, 255, 255)');
  assert.deepEqual(measure(element('rgba(0, 0, 0, 0.5)', white)), [128, 128, 128]);
  const blue = element('rgba(0, 0, 255, 0.5)', white);
  assert.deepEqual(measure(element('rgba(255, 0, 0, 0.5)', blue)), [191, 64, 128]);
});

test('missing opaque backing fails instead of inventing a white canvas', () => {
  assert.throws(() => measure(element('rgba(0, 0, 0, 0)')), /opaque background/i);
});

test('image-backed paint fails closed instead of reporting an unsupported contrast result', () => {
  assert.throws(() => measure(element('rgb(255, 255, 255)', null, { backgroundImage: 'linear-gradient(red, blue)' })), /background image/i);
});

test('group opacity fails closed even when a descendant has an opaque fill', () => {
  const faded = element('rgb(255, 255, 255)', null, { opacity: '0.5' });
  assert.throws(() => measure(element('rgb(255, 255, 255)', faded)), /opacity/i);
});

test('unrecognized computed color cannot silently become black or white', () => {
  assert.throws(() => measure(element('not-a-color')), /rgb color/i);
});

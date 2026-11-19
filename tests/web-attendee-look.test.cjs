'use strict';

// Attendee design system, screen application (2026-11-20): which look an event
// gets. a1 (white ground, the event color as the accent) is the default; a2 (the
// agency's own ground color, white cards on it) switches on by itself when a
// ground color was chosen in 참가자 페이지. The product default sky blue is the
// value an untouched page stores, not a choice, and white or near-white is a
// white ground to the eye, so both stay a1. Every attendee page wraps itself in
// AttendeeSurface with this look.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const WEB = path.join(__dirname, '..', 'apps/web');
const webRequire = createRequire(path.join(WEB, 'package.json'));
const ts = webRequire('typescript');

function load(file, shims = {}) {
  const source = fs.readFileSync(path.join(WEB, file), 'utf8');
  const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(out, { module, exports: module.exports, require: (id) => (id in shims ? shims[id] : webRequire(id)) }, { filename: file });
  return module.exports;
}

const home = load('lib/attendee-home.ts');
const palette = load('lib/event-palette.ts', { './attendee-home': home });
const { attendeeLook } = load('app/event/[slug]/attendee-look.ts', {
  '../../../lib/attendee-home': home,
  '../../../lib/event-palette': palette,
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const style = (backgroundColor) => ({ ...plain(home.DEFAULT_HOME_STYLE), backgroundColor });

test('an untouched page (the product default ground) is a1 with the brand accent', () => {
  assert.deepEqual(plain(attendeeLook(home.DEFAULT_HOME_STYLE, null)), { mode: 'a1', color: '#EA552E', ground: null });
  assert.deepEqual(plain(attendeeLook(undefined, null)), { mode: 'a1', color: '#EA552E', ground: null }, 'no style at all reads as the default');
});

test('the published 강조색 is the accent in both modes', () => {
  assert.equal(attendeeLook(home.DEFAULT_HOME_STYLE, '#2b62ee').color, '#2B62EE');
  assert.equal(attendeeLook(style('#14161C'), '#9AA7FF').color, '#9AA7FF');
  assert.equal(attendeeLook(home.DEFAULT_HOME_STYLE, 'not a color').color, '#EA552E', 'an invalid accent falls back to the brand');
});

test('a chosen ground color turns a2 on and becomes the ground', () => {
  for (const ground of ['#2B62EE', '#FFD43B', '#14161C', '#1F8A5B', '#F3E3D3']) {
    const look = attendeeLook(style(ground), '#E76D26');
    assert.equal(look.mode, 'a2', `${ground} is a2`);
    assert.equal(look.ground, ground);
  }
});

test('white and near-white grounds stay a1', () => {
  for (const ground of ['#FFFFFF', '#FDFDFD', '#FAFAFA']) {
    assert.deepEqual(plain(attendeeLook(style(ground), '#E76D26')), { mode: 'a1', color: '#E76D26', ground: null }, `${ground} is a1`);
  }
});

test('without a published accent the chosen ground is the event color', () => {
  assert.deepEqual(plain(attendeeLook(style('#2B62EE'), null)), { mode: 'a2', color: '#2B62EE', ground: '#2B62EE' });
});

test('every attendee page wraps itself in AttendeeSurface with the look', () => {
  const app = path.join(WEB, 'app/event/[slug]');
  for (const file of ['page.tsx', 'home/HomeShell.tsx', 'home/AttendeeHomeLanding.tsx', 'register/page.tsx', 'ticket/page.tsx', 'ticket/recover/page.tsx', 'engage/EngageClient.tsx']) {
    const source = fs.readFileSync(path.join(app, file), 'utf8');
    assert.match(source, /<AttendeeSurface\b|surface\(/u, `${file} renders an AttendeeSurface`);
    assert.match(source, /attendeeLook\(/u, `${file} derives the look`);
  }
});

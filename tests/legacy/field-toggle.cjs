const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function fresh() {
  for (const m of ['../features/checkin.js']) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  require('../features/checkin.js');
  return globalThis.ETKO;
}

function freshFull() {
  const files = ['../app.js', '../features/agency.js', '../features/participants.js', '../features/checkin.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('shell exposes an online toggle for the check-in desk', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /data-online-toggle/, 'check-in section must offer an online toggle');
});

test('setOnline flips connectivity and keeps workspace queue visible', () => {
  const ETKO = fresh();
  assert.equal(ETKO.setOnline(false), false);
  assert.equal(ETKO.online, false);
  assert.equal(ETKO.setOnline(true), true);
  const box = { innerHTML: '' };
  ETKO.renderCheckin(box);
  assert.match(box.innerHTML, /온라인|오프라인/, 'panel must show connectivity in Korean');
});

test('shell delegates panel-inner toggles to the panel (no double flip)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /checkin-mount/, 'guard must reference the panel mount');
  assert.match(html, /never flips twice|panel owns its own/, 'double-flip guard must be documented');
});

test('offline queue survives an online flip and re-render', () => {
  const ETKO = freshFull();
  ETKO.switchEvent('evt-1');
  const target = ETKO.workspace().participants.find((p) => p.status !== 'IN');
  assert.equal(ETKO.scan({ code: target.code, direction: 'IN', online: false }).key, 'queued');
  ETKO.setOnline(true);
  const box = { innerHTML: '' };
  ETKO.renderCheckin(box);
  assert.match(box.innerHTML, /대기 목록 1건/, 'queued entry must stay visible after flip + re-render');
});

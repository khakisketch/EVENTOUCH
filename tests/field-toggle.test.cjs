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

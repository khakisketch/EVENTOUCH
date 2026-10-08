const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('overview offers report creation wired to the snapshot store', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /data-report-create/, 'overview must offer report creation');
  assert.match(html, /ETKO\.createReport/, 'shell must call the snapshot store, not a toast');
});

test('report snapshot is titled and VIEWER denial is Korean', () => {
  for (const m of ['../app.js', '../features/agency.js', '../features/results.js']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  delete globalThis.ETKO;
  require('../app.js');
  require('../features/agency.js');
  require('../features/results.js');
  const ETKO = globalThis.ETKO;
  ETKO.setRole('AGENCY');
  const r = ETKO.createReport({ title: '행사 결과 보고서' });
  assert.match(r.title, /결과 보고서/);
  assert.ok(Object.isFrozen(r));
  ETKO.setRole('VIEWER');
  assert.throws(() => ETKO.createReport({ title: '무단 보고서' }), /권한을 확인하세요/);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /data-report-error/, 'denial must surface into a marked alert mount');
  assert.match(html, /보고서를 생성하지 못했습니다/, 'fallback copy must be Korean');
});

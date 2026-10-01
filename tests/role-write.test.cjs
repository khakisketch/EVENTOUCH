const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  for (const m of ['../app.js','../features/agency.js','../features/results.js']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  delete globalThis.ETKO;
  require('../app.js');
  require('../features/agency.js');
  require('../features/results.js');
  return globalThis.ETKO;
}

test('VIEWER cannot create reports', () => {
  const ETKO = fresh();
  ETKO.setRole('VIEWER');
  assert.equal(ETKO.canRoute('VIEWER', 'results'), true);
  assert.throws(() => ETKO.createReport({ title: '무단 보고서' }), /권한/);
});

test('AGENCY can create reports, STAFF participant route untouched', () => {
  const ETKO = fresh();
  ETKO.setRole('AGENCY');
  const r = ETKO.createReport({ title: '정상 보고서' });
  assert.ok(r.id);
  assert.equal(ETKO.canRoute('STAFF', 'participant'), false);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  try { delete require.cache[require.resolve('../features/views.js')]; } catch {}
  delete globalThis.ETKO;
  require('../features/views.js');
  return globalThis.ETKO;
}

test('registry lists the six shell views in nav order', () => {
  const ETKO = fresh();
  const reg = ETKO.viewRegistry();
  assert.deepEqual(reg.map((v) => v.id), ['overview', 'participants', 'checkin', 'booth', 'participant', 'stage']);
  for (const v of reg) {
    assert.ok(v.section, `missing section for ${v.id}`);
    assert.ok(v.labelKey, `missing labelKey for ${v.id}`);
  }
});

test('section and mount lookups resolve known views, null otherwise', () => {
  const ETKO = fresh();
  assert.equal(ETKO.sectionFor('checkin'), 'checkin-view');
  assert.equal(ETKO.mountFor('checkin'), 'checkin-mount');
  assert.equal(ETKO.sectionFor('nope'), null);
  assert.equal(ETKO.mountFor('nope'), null);
});

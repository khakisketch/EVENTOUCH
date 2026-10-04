const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  try { delete require.cache[require.resolve('../features/views.js')]; } catch {}
  delete globalThis.ETKO;
  require('../features/views.js');
  return globalThis.ETKO;
}

test('registry lists the shell views in nav order', () => {
  const ETKO = fresh();
  const reg = ETKO.viewRegistry();
  assert.deepEqual(reg.map((v) => v.id), ['agency-home', 'agency-events', 'agency-clients', 'agency-team', 'overview', 'participants', 'checkin', 'booth', 'participant', 'engage', 'content', 'messages', 'stage', 'screen']);
  for (const v of reg) {
    assert.ok(v.section, `missing section for ${v.id}`);
    assert.ok(v.labelKey, `missing labelKey for ${v.id}`);
  }
});

test('navigation layers group all canonical views in product order', () => {
  const ETKO = fresh();
  assert.deepEqual(ETKO.layerRegistry(), [
    {
      id: 'agency',
      label: '전체 현장',
      defaultView: 'agency-home',
      views: ['agency-home', 'agency-events', 'agency-clients'],
    },
    {
      id: 'event',
      label: '준비',
      defaultView: 'overview',
      views: ['overview', 'agency-team', 'participants', 'content', 'messages'],
    },
    {
      id: 'onsite',
      label: '당일 운영',
      defaultView: 'checkin',
      views: ['checkin', 'booth', 'engage', 'stage'],
    },
    {
      id: 'participant',
      label: '참가자',
      defaultView: 'participant',
      views: ['participant'],
    },
    {
      id: 'screen',
      label: '관객 화면',
      defaultView: 'screen',
      views: ['screen'],
    },
  ]);
  assert.deepEqual(
    ETKO.viewRegistry().map((view) => [view.id, view.layer]),
    [
      ['agency-home', 'agency'],
      ['agency-events', 'agency'],
      ['agency-clients', 'agency'],
      ['agency-team', 'event'],
      ['overview', 'event'],
      ['participants', 'event'],
      ['checkin', 'onsite'],
      ['booth', 'onsite'],
      ['participant', 'participant'],
      ['engage', 'onsite'],
      ['content', 'event'],
      ['messages', 'event'],
      ['stage', 'onsite'],
      ['screen', 'screen'],
    ]
  );
  assert.equal(ETKO.layerForView('not-a-view'), null);
  assert.equal(ETKO.defaultViewForLayer('not-a-layer'), null);
});

test('section and mount lookups resolve known views, null otherwise', () => {
  const ETKO = fresh();
  assert.equal(ETKO.sectionFor('checkin'), 'checkin-view');
  assert.equal(ETKO.mountFor('checkin'), 'checkin-mount');
  assert.equal(ETKO.sectionFor('nope'), null);
  assert.equal(ETKO.mountFor('nope'), null);
});

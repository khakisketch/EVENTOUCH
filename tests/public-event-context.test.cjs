'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

const web = path.resolve(__dirname, '../apps/web');
const webRequire = createRequire(path.join(web, 'package.json'));
const ts = webRequire('typescript');
const originalTsLoader = require.extensions['.ts'];

require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(require('node:fs').readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(output.outputText, filename);
};

const { readPublicEventContext } = require('../apps/web/lib/public-event-context.ts');

if (originalTsLoader) require.extensions['.ts'] = originalTsLoader;
else delete require.extensions['.ts'];

function workspace(published = {}, venue = {}) {
  return {
    venue,
    pageExperience: { published },
  };
}

const event = {
  date: '2026-11-20',
  start: '09:30',
  end: '17:00',
  features: ['venue'],
};

test('public event context uses the published schedule and visible venue', () => {
  assert.deepEqual(
    readPublicEventContext(event, workspace({}, { name: '포럼홀', address: '서울 성동구 연무장길 18' })),
    {
      date: '2026년 11월 20일 (금)',
      dateTime: '2026-11-20',
      time: '09:30–17:00',
      place: '포럼홀',
      hasVenueGuide: true,
    },
  );
});

test('the schedule visibility switch hides the date and time, including malformed values', () => {
  const hiddenEvent = { ...event, date: '2026-19-88', start: '27:89' };
  const context = readPublicEventContext(
    hiddenEvent,
    workspace({ showSchedule: false }, { name: '포럼홀', address: '서울 성동구 연무장길 18' }),
  );
  assert.equal(context.date, '');
  assert.equal(context.dateTime, '');
  assert.equal(context.time, '');
  assert.equal(context.place, '포럼홀');
  assert.equal(context.hasVenueGuide, true);
});

test('venue name, address and guide require both the venue feature and published visibility', () => {
  const venue = { name: '비공개 장소', address: '비공개 주소' };
  for (const [features, published] of [
    [[], {}],
    [['venue'], { showVenue: false }],
  ]) {
    const context = readPublicEventContext({ ...event, features }, workspace(published, venue));
    assert.equal(context.place, '');
    assert.equal(context.hasVenueGuide, false);
  }
});

test('invalid event time and date and malformed unpublished map data do not produce extra details', () => {
  const context = readPublicEventContext(
    { ...event, date: '2026-02-30', start: '8:30', end: '18:70' },
    workspace({}, { map: { image: { fileId: '../private' }, alt: 'private map' } }),
  );
  assert.equal(context.date, '');
  assert.equal(context.dateTime, '');
  assert.equal(context.time, '');
  assert.equal(context.place, '');
  assert.equal(context.hasVenueGuide, false);
});

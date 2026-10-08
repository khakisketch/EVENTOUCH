const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/persist.js', '../features/participants.js', '../features/content.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  globalThis.ETKO = {};
  for (const m of files) require(m);
  return globalThis.ETKO;
}

const PEOPLE = [
  { id: 'p1', name: '김민준', email: 'a@x.kr', ticket: 'GENERAL', status: 'registered', code: 'EVT-1' },
];

test('VIEWER cannot open participant detail or move views', () => {
  const ETKO = fresh();
  ETKO.setRole('VIEWER');
  const before = ETKO.currentView;
  assert.throws(() => ETKO.openParticipantDetail('p1'), /권한/);
  assert.equal(ETKO.homeParticipantId || null, null);
  assert.equal(ETKO.currentView, before);
});

test('STAFF opens participant detail through the bypass', () => {
  const ETKO = fresh();
  ETKO.setRole('STAFF');
  assert.equal(ETKO.openParticipantDetail('p1'), 'participant');
  assert.equal(ETKO.homeParticipantId, 'p1');
});

test('VIEWER bulk check-in is refused without touching statuses', () => {
  const ETKO = fresh();
  ETKO.setRole('VIEWER');
  const people = PEOPLE.map((p) => ({ ...p }));
  ETKO.toggleSelect('p1');
  assert.throws(() => ETKO.bulkCheckIn(people), /권한/);
  assert.equal(people[0].status, 'registered');
});

test('AGENCY bulk check-in still marks selected participants', () => {
  const ETKO = fresh();
  ETKO.setRole('AGENCY');
  const people = PEOPLE.map((p) => ({ ...p }));
  ETKO.toggleSelect('p1');
  assert.equal(ETKO.bulkCheckIn(people), 1);
  assert.equal(people[0].status, 'IN');
});

test('directory hides detail and bulk controls from read-only roles', () => {
  const ETKO = fresh();
  ETKO.setRole('VIEWER');
  const box = { innerHTML: '' };
  ETKO.renderPeople(box, PEOPLE.map((p) => ({ ...p })));
  assert.match(box.innerHTML, /김민준/);
  assert.doesNotMatch(box.innerHTML, /data-detail/);
  assert.doesNotMatch(box.innerHTML, /data-bulk-in/);
});

test('directory keeps detail and bulk controls for staff roles', () => {
  const ETKO = fresh();
  ETKO.setRole('STAFF');
  const box = { innerHTML: '' };
  ETKO.renderPeople(box, PEOPLE.map((p) => ({ ...p })));
  assert.match(box.innerHTML, /data-detail="p1"/);
  assert.match(box.innerHTML, /data-bulk-in/);
});

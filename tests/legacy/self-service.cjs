const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fresh() {
  for (const m of ['../app.js', '../features/agency.js', '../features/registration.js', '../features/booth.js', '../features/booths.js']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  delete globalThis.ETKO;
  globalThis.ETKO = {};
  try {
    globalThis.ETKO.sample = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'data', 'sample.json'), 'utf8')
    );
  } catch (err) {}
  require('../app.js');
  require('../features/agency.js');
  require('../features/registration.js');
  require('../features/booth.js');
  require('../features/booths.js');
  return globalThis.ETKO;
}

function freshEvent(ETKO) {
  ETKO.setRole('AGENCY');
  const id = ETKO.createEvent({ name: '셀프 테스트', date: '2026-11-01', venue: '홀' });
  ETKO.switchEvent(id);
  return id;
}

test('VIEWER can self-register without admin write grant', () => {
  const ETKO = fresh();
  freshEvent(ETKO);
  ETKO.setRole('VIEWER');
  const p = ETKO.registerSelf({ name: '셀프참가', phone: '010-0000-0101' });
  assert.ok(/^p\d+$/.test(p.id));
  assert.equal(ETKO.workspace().participants.length, 1);
});

test('self-register still rejects duplicates and full capacity', () => {
  const ETKO = fresh();
  freshEvent(ETKO);
  ETKO.setRole('VIEWER');
  ETKO.registerSelf({ name: '중복참가', phone: '010-0000-0102' });
  assert.throws(() => ETKO.registerSelf({ name: '중복참가', phone: '010-0000-0102' }), /이미 등록한 참가자/);
  const ev = ETKO.store.events.find((e) => e && e.id === ETKO.store.activeEventId);
  ev.capacity = 1;
  assert.throws(() => ETKO.registerSelf({ name: '다음참가', phone: '010-0000-0103' }), /마감/);
});

test('SELF mode allows self stamp; STAFF mode refuses it', () => {
  const ETKO = fresh();
  freshEvent(ETKO);
  ETKO.setRole('AGENCY');
  const booth = ETKO.saveBooth({ name: '체험부스', capacity: 10, limit: 1, status: 'OPEN' });
  const person = ETKO.register({ name: '스탬프참가', phone: '010-0000-0104' });
  ETKO.setRole('VIEWER');
  const visit = ETKO.stampSelf({ boothId: booth.id, participantId: person.id });
  assert.equal(visit.boothId, booth.id);
  assert.throws(() => ETKO.stampSelf({ boothId: booth.id, participantId: person.id }), /횟수/);
});

test('STAFF mode refuses self stamp', () => {
  const ETKO = fresh();
  freshEvent(ETKO);
  ETKO.setRole('AGENCY');
  ETKO.setEventBoothMode('STAFF', { acknowledge: true });
  const booth = ETKO.saveBooth({ name: '직원부스', capacity: 10, limit: 1, status: 'OPEN' });
  ETKO.setRole('VIEWER');
  const person = ETKO.registerSelf({ name: '둘째참가', phone: '010-0000-0105' });
  assert.throws(() => ETKO.stampSelf({ boothId: booth.id, participantId: person.id }), /직원/);
});

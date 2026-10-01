const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshFull() {
  const files = ['../app.js','../features/agency.js','../features/participants.js','../features/checkin.js','../features/booth.js','../features/registration.js','../features/desks.js','../features/booths.js','../features/engagement.js','../features/media.js','../features/messaging.js','../features/content.js','../features/stage.js','../features/results.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('C1 VIEWER blocked on field writes', () => {
  const ETKO = freshFull();
  ETKO.setRole('VIEWER');
  assert.throws(() => ETKO.saveUnit({ name: 'x', action: 'IN', mode: 'desk' }), /권한/);
  assert.throws(() => ETKO.vote('p1', 0), /권한|마감|찾을/);
});

test('C2 bypass scoped to participant only', () => {
  const ETKO = freshFull();
  ETKO.setRole('STAFF');
  ETKO.navigate('overview');
  ETKO.detailBypass = true;
  assert.equal(ETKO.navigate('stage'), 'overview');
});

test('C4 seeds repair everIn', () => {
  const ETKO = freshFull();
  const p3 = ETKO.workspace().participants.find((p) => p.id === 'p3');
  assert.equal(p3.status, 'IN');
  assert.equal(p3.everIn, true);
});

test('C5 switch clears selection', () => {
  const ETKO = freshFull();
  ETKO.selectedIds.add('p1');
  const id2 = ETKO.createEvent({ name: '제2행사', date: '2026-11-01', venue: 'B홀' });
  ETKO.switchEvent(id2);
  assert.equal(ETKO.selectedIds.has('p1'), false);
});

test('I9 AGENCY can navigate to results via canRoute', () => {
  const ETKO = freshFull();
  ETKO.setRole('AGENCY');
  ETKO.navigate('overview');
  assert.equal(ETKO.navigate('results'), 'results');
});

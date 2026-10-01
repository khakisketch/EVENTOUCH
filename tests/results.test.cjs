const { test } = require('node:test');
const assert = require('node:assert');

globalThis.ETKO = globalThis.ETKO || {};
require('../features/agency.js');
require('../features/results.js');

const ETKO = globalThis.ETKO;

test('createReport requires a Korean-titled report', () => {
  assert.throws(() => ETKO.createReport({ title: '' }), /보고서 제목/);
  assert.throws(() => ETKO.createReport({}), /보고서 제목/);
});

test('snapshot immutability: later state changes never mutate a created report', () => {
  const r = ETKO.createReport({ title: '결산', summary: '총평' });
  const before = JSON.stringify(r.metrics);
  ETKO.workspace().participants.push({ id: 'px', name: '추가', status: 'IN', everIn: true });
  assert.equal(JSON.stringify(r.metrics), before);
  ETKO.workspace().participants.pop();
});

test('report snapshot is deep-frozen', () => {
  const r = ETKO.createReport({ title: '결산', summary: '총평' });
  assert.ok(Object.isFrozen(r), 'report must be frozen');
  assert.ok(Object.isFrozen(r.metrics), 'metrics must be frozen');
  assert.ok(Object.isFrozen(r.photos), 'photos must be frozen');
});

test('eventSummary counts checked via everIn and inside case-insensitively', () => {
  const ws = ETKO.workspace();
  ws.participants.push({ id: 't-in', name: '입장', status: 'in', everIn: true });
  ws.participants.push({ id: 't-out', name: '퇴장', status: 'OUT', everIn: true });
  const s = ETKO.eventSummary();
  const active = ws.participants.filter((p) => p && !p.cancelled);
  const checked = active.filter((p) => p.everIn === true).length;
  const inside = active.filter(
    (p) => String((p && p.status) || '').trim().toLowerCase() === 'in'
  ).length;
  assert.equal(s.total, active.length);
  assert.equal(s.checked, checked);
  assert.equal(s.inside, inside);
  assert.equal(s.notArrived, s.total - s.checked);
  assert.equal(s.rate, s.total ? +(s.checked / s.total * 100).toFixed(1) : 0);
  ws.participants.pop();
  ws.participants.pop();
});

test('updateEvent validates name/date/venue/status/capacity in Korean', () => {
  assert.throws(() => ETKO.updateEvent({ name: '' }), /행사 이름/);
  assert.throws(() => ETKO.updateEvent({ venue: '' }), /행사 장소/);
  assert.throws(() => ETKO.updateEvent({ status: 'nope' }), /행사 상태/);
  assert.throws(() => ETKO.updateEvent({ capacity: -1 }), /정원/);
  const ev = ETKO.updateEvent({ name: '가을 축제', capacity: 100 });
  assert.equal(ev.name, '가을 축제');
  assert.equal(ev.capacity, 100);
  ETKO.updateEvent({ name: 'EVENTOUCH 운영 샘플' });
});

test('setEventFeatures stores known feature flags', () => {
  assert.throws(() => ETKO.setEventFeatures({ unknown: true }), /기능/);
  const features = ETKO.setEventFeatures({ poll: true, quiz: false });
  assert.equal(features.poll, true);
  assert.equal(features.quiz, false);
});

test('results renderers stay Korean with no raw status keys', () => {
  const results = { innerHTML: '' };
  ETKO.renderResults(results);
  assert.match(results.innerHTML, /[가-힣]/);
  const settings = { innerHTML: '' };
  ETKO.renderSettings(settings);
  assert.match(settings.innerHTML, /[가-힣]/);
  for (const html of [results.innerHTML, settings.innerHTML]) {
    const visible = html.replace(/<[^>]*>/g, ' ');
    assert.ok(!/SELF|STAFF|PENDING/.test(visible), 'renderers must not leak raw keys');
  }
});

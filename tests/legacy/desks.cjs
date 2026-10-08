const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
globalThis.ETKO = globalThis.ETKO || {};
try {
  globalThis.ETKO.sample = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'sample.json'), 'utf8')
  );
} catch (err) {}
require('../features/agency.js');
require('../features/registration.js');
require('../features/desks.js');

const ETKO = globalThis.ETKO;

function freshEvent() {
  const id = ETKO.createEvent({
    name: '데스크 테스트 행사',
    date: '2026-11-02',
    venue: '테스트홀',
  });
  ETKO.switchEvent(id);
  return id;
}

function addUnit(action) {
  return ETKO.saveUnit({ name: '등록 데스크', action: action || 'IN', mode: 'desk' });
}

test('brief: empty unit name throws a Korean desk-name error', () => {
  freshEvent();
  assert.throws(() => ETKO.saveUnit({ name: '', action: 'IN', mode: 'desk' }), /데스크 이름/);
});

test('saveUnit creates a unit and updates it by id', () => {
  freshEvent();
  const created = ETKO.saveUnit({ name: '등록 데스크 01', action: 'IN', mode: 'desk' });
  assert.ok(created.id, 'created unit must carry an id');
  assert.equal(created.name, '등록 데스크 01');
  const updated = ETKO.saveUnit({ id: created.id, name: '등록 데스크 02', action: 'OUT', mode: 'tablet' });
  assert.equal(updated.id, created.id, 'update must keep the same id');
  assert.equal(ETKO.workspace().units.length, 1, 'update must not append a second unit');
  assert.equal(ETKO.workspace().units[0].name, '등록 데스크 02');
});

test('saveUnit rejects bad action/mode and unknown id in Korean', () => {
  freshEvent();
  assert.throws(() => ETKO.saveUnit({ name: '데스크', action: 'SIDEWAYS', mode: 'desk' }), /입장|퇴장|구분/);
  assert.throws(() => ETKO.saveUnit({ name: '데스크', action: 'IN', mode: 'watch' }), /모드/);
  assert.throws(() => ETKO.saveUnit({ id: 'u-없음', name: '데스크', action: 'IN', mode: 'desk' }), /데스크/);
});

test('recordScan IN sets status IN + everIn and stores before/after', () => {
  freshEvent();
  const unit = addUnit('IN');
  const p = ETKO.register({ name: '김입장', phone: '010-3000-0001' });
  assert.equal(p.status, 'registered');
  const log = ETKO.recordScan({ participantId: p.id, action: 'IN', unitId: unit.id });
  const after = ETKO.workspace().participants.find((x) => x.id === p.id);
  assert.equal(after.status, 'IN');
  assert.equal(after.everIn, true);
  assert.equal(log.before, 'registered');
  assert.equal(log.after, 'IN');
  assert.equal(log.participantId, p.id);
});

test('recordScan duplicate IN throws already-handled Korean', () => {
  freshEvent();
  const unit = addUnit('IN');
  const p = ETKO.register({ name: '김중복', phone: '010-3000-0002' });
  ETKO.recordScan({ participantId: p.id, action: 'IN', unitId: unit.id });
  assert.throws(
    () => ETKO.recordScan({ participantId: p.id, action: 'IN', unitId: unit.id }),
    /이미 처리되었습니다/
  );
  assert.equal(ETKO.workspace().logs.length, 1, 'duplicate must not append a log');
});

test('recordScan OUT sets OUT; OUT without IN throws Korean', () => {
  freshEvent();
  const inUnit = addUnit('IN');
  const outUnit = ETKO.saveUnit({ name: '퇴장 데스크', action: 'OUT', mode: 'desk' });
  const p = ETKO.register({ name: '김퇴장', phone: '010-3000-0003' });
  assert.throws(
    () => ETKO.recordScan({ participantId: p.id, action: 'OUT', unitId: outUnit.id }),
    /입장 기록/
  );
  ETKO.recordScan({ participantId: p.id, action: 'IN', unitId: inUnit.id });
  const log = ETKO.recordScan({ participantId: p.id, action: 'OUT', unitId: outUnit.id });
  assert.equal(log.before, 'IN');
  assert.equal(log.after, 'OUT');
  const after = ETKO.workspace().participants.find((x) => x.id === p.id);
  assert.equal(after.status, 'OUT');
  assert.equal(after.everIn, true, 'exited participant must keep everIn');
});

test('recordScan refuses unknown participant/unit in Korean', () => {
  freshEvent();
  const unit = addUnit('IN');
  const p = ETKO.register({ name: '김확인', phone: '010-3000-0004' });
  assert.throws(() => ETKO.recordScan({ participantId: 'p-없음', action: 'IN', unitId: unit.id }), /참가자/);
  assert.throws(() => ETKO.recordScan({ participantId: p.id, action: 'IN', unitId: 'u-없음' }), /데스크/);
});

test('history is newest-first and returns immutable copies', () => {
  freshEvent();
  const inUnit = addUnit('IN');
  const outUnit = ETKO.saveUnit({ name: '퇴장 데스크', action: 'OUT', mode: 'desk' });
  const p = ETKO.register({ name: '김순서', phone: '010-3000-0005' });
  ETKO.recordScan({ participantId: p.id, action: 'IN', unitId: inUnit.id });
  ETKO.recordScan({ participantId: p.id, action: 'OUT', unitId: outUnit.id });
  const logs = ETKO.history();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].after, 'OUT', 'newest entry must come first');
  assert.equal(logs[1].after, 'IN');
  logs[0].after = '조작됨';
  assert.notEqual(ETKO.workspace().logs[0].after, '조작됨', 'history copies must not alias the store');
});

test('correctLog validates reason length in Korean', () => {
  freshEvent();
  const unit = addUnit('IN');
  const p = ETKO.register({ name: '김정정', phone: '010-3000-0006' });
  const log = ETKO.recordScan({ participantId: p.id, action: 'IN', unitId: unit.id });
  assert.throws(() => ETKO.correctLog(log.id, '짧음'), /정정 사유/);
  assert.throws(() => ETKO.correctLog('log-없음', '정정 사유를 적습니다'), /기록/);
});

test('correctLog refuses non-latest logs, restores before and unshifts CORRECTION', () => {
  freshEvent();
  const inUnit = addUnit('IN');
  const outUnit = ETKO.saveUnit({ name: '퇴장 데스크', action: 'OUT', mode: 'desk' });
  const p = ETKO.register({ name: '김최신', phone: '010-3000-0007' });
  const first = ETKO.recordScan({ participantId: p.id, action: 'IN', unitId: inUnit.id });
  const second = ETKO.recordScan({ participantId: p.id, action: 'OUT', unitId: outUnit.id });
  assert.throws(() => ETKO.correctLog(first.id, '첫 기록을 정정합니다'), /가장 최근/);
  const entry = ETKO.correctLog(second.id, '퇴장 처리를 잘못 입력했습니다');
  assert.equal(entry.action, 'CORRECTION');
  const after = ETKO.workspace().participants.find((x) => x.id === p.id);
  assert.equal(after.status, 'IN', 'correction must restore the before state');
  const logs = ETKO.history();
  assert.equal(logs[0].action, 'CORRECTION', 'CORRECTION entry must be newest');
  assert.equal(logs[0].after, 'IN');
});

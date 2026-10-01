const { test } = require('node:test');
const assert = require('node:assert');
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

const ETKO = globalThis.ETKO;

function freshEvent() {
  const id = ETKO.createEvent({
    name: '등록 테스트 행사',
    date: '2026-11-01',
    venue: '테스트홀',
  });
  ETKO.switchEvent(id);
  return id;
}

function activeEvent() {
  return ETKO.store.events.find((ev) => ev && ev.id === ETKO.store.activeEventId);
}

test('brief: empty name signup throws a Korean name error', () => {
  ETKO.switchEvent('evt-1');
  assert.throws(() => ETKO.register({ name: '', phone: '' }), /이름/);
});

test('default form has required name/phone plus optional company/email', () => {
  freshEvent();
  const fields = ETKO.formFields();
  const byId = {};
  fields.forEach((f) => {
    byId[f.id] = f;
  });
  assert.equal(byId.name.required, true);
  assert.equal(byId.phone.required, true);
  assert.equal(byId.company.required, false);
  assert.equal(byId.email.required, false);
});

test('setFields rejects a select with fewer than two options', () => {
  freshEvent();
  assert.throws(
    () =>
      ETKO.setFields([
        { id: 'name', label: '이름', type: 'text', required: true },
        { id: 'phone', label: '연락처', type: 'text', required: true },
        { id: 'meal', label: '식사', type: 'select', required: false, options: ['한식'] },
      ]),
    /선택/
  );
});

test('setFields refuses to drop name/phone', () => {
  freshEvent();
  assert.throws(
    () => ETKO.setFields([{ id: 'name', label: '이름', type: 'text', required: true }]),
    /이름|연락처|필수/
  );
});

test('setFields bumps formVersion and validateSignup returns it', () => {
  freshEvent();
  const before = ETKO.workspace().formVersion;
  ETKO.setFields([
    { id: 'name', label: '이름', type: 'text', required: true },
    { id: 'phone', label: '연락처', type: 'text', required: true },
    { id: 'company', label: '소속', type: 'text', required: false },
    { id: 'email', label: '이메일', type: 'email', required: false },
  ]);
  assert.equal(ETKO.workspace().formVersion, before + 1);
  const result = ETKO.validateSignup({ name: '김참가', phone: '010-0000-0001' });
  assert.equal(result.formVersion, before + 1);
});

test('validateSignup rejects bad email and invalid select in Korean', () => {
  freshEvent();
  ETKO.setFields([
    { id: 'name', label: '이름', type: 'text', required: true },
    { id: 'phone', label: '연락처', type: 'text', required: true },
    { id: 'email', label: '이메일', type: 'email', required: false },
    { id: 'meal', label: '식사', type: 'select', required: false, options: ['한식', '양식'] },
  ]);
  assert.throws(
    () => ETKO.validateSignup({ name: '김참가', phone: '010-0000-0002', email: 'not-an-email' }),
    /이메일/
  );
  assert.throws(
    () => ETKO.validateSignup({ name: '김참가', phone: '010-0000-0002', meal: '중식' }),
    /선택/
  );
});

test('register creates p<N>, rejects duplicate name+phone in Korean', () => {
  freshEvent();
  const first = ETKO.register({ name: '김참가', phone: '010-0000-0003' });
  assert.ok(/^p\d+$/.test(first.id));
  assert.throws(
    () => ETKO.register({ name: '김참가', phone: '010-0000-0003' }),
    /이미 등록한 참가자입니다/
  );
});

test('register refuses over capacity in Korean', () => {
  freshEvent();
  activeEvent().capacity = 1;
  ETKO.register({ name: '첫참가', phone: '010-0000-0004' });
  assert.throws(
    () => ETKO.register({ name: '둘참가', phone: '010-0000-0005' }),
    /등록 정원이 마감되었습니다/
  );
});

test('register without email succeeds and stores empty string', () => {
  freshEvent();
  const p = ETKO.register({ name: '무메일', phone: '010-0000-0006' });
  assert.equal(p.email, '');
});

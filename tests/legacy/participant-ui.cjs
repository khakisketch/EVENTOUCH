const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/participants.js', '../features/checkin.js', '../features/booth.js', '../features/content.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

function lookupFormBox(values) {
  const handlers = {};
  const fields = {};
  Object.keys(values).forEach((attr) => {
    fields[attr] = { value: values[attr], focused: false, focus() { this.focused = true; } };
  });
  const button = { addEventListener(type, fn) { if (type === 'click') handlers.submit = fn; } };
  return {
    handlers, fields, innerHTML: '',
    querySelector(selector) {
      const match = /^\[([^\]]+)\]$/.exec(selector);
      return match ? fields[match[1]] || null : null;
    },
    querySelectorAll(selector) { return selector === '[data-lookup-submit]' ? [button] : []; },
  };
}

test('participant mount renders next action, schedule and ticket', () => {
  const ETKO = fresh();
  ETKO.saveProgram({ title: '개회식', time: '09:00', end: '09:30', location: 'A홀' });
  ETKO.homeParticipantId = 'p1';
  const box = { innerHTML: '' };
  ETKO.renderParticipant(box);
  assert.match(box.innerHTML, /data-home-cta/);
  assert.match(box.innerHTML, /개회식/);
  assert.match(box.innerHTML, /내 티켓/);
  assert.match(box.innerHTML, /EVT-1001/);
  assert.doesNotMatch(box.innerHTML, /DEMO-/);
  assert.doesNotMatch(box.innerHTML, /seoyeon\.lee@example\.kr/);
  assert.doesNotMatch(box.innerHTML, /haneul\.jung@example\.kr/);
  assert.doesNotMatch(box.innerHTML, /EVT-1002/);
});

test('unbound home shows lookup, never another ticket', () => {
  const ETKO = fresh();
  const box = { innerHTML: '' };
  ETKO.renderParticipant(box);
  assert.doesNotMatch(box.innerHTML, /EVT-1001/);
  assert.doesNotMatch(box.innerHTML, /체크인 QR 코드/);
});

test('ticket lookup keeps labels associated with a telephone input', () => {
  const ETKO = fresh();
  const lookup = { innerHTML: '' };
  const box = {
    innerHTML: '',
    querySelector(sel) { return sel === '[data-lookup-embed]' ? lookup : null; },
  };
  ETKO.renderParticipant(box);
  assert.match(lookup.innerHTML, /<label>연락처<input data-lookup-phone type="tel"/);
  assert.match(lookup.innerHTML, /autocomplete="tel"/);
});

test('ticket lookup keeps entered contact and focuses missing name error', () => {
  const ETKO = fresh();
  const box = lookupFormBox({
    'data-lookup-name': '',
    'data-lookup-phone': '010-0000-0000',
  });
  ETKO.renderLookup(box);
  box.handlers.submit();
  assert.match(box.innerHTML, /data-lookup-name[^>]*aria-invalid="true"/);
  assert.match(box.innerHTML, /id="lookup-name-error"[^>]*>등록 정보를 찾을 수 없습니다. 이름과 연락처를 확인하세요/);
  assert.match(box.innerHTML, /value="010-0000-0000"/);
  assert.equal(box.fields['data-lookup-name'].focused, true);
  assert.equal(ETKO.homeParticipantId, undefined);
});

test('empty roster shows signup guidance, stale detail falls back', () => {
  const ETKO = fresh();
  const id2 = ETKO.createEvent({ name: '빈행사', date: '2026-11-01', venue: 'B홀' });
  ETKO.switchEvent(id2);
  const box = { innerHTML: '' };
  ETKO.renderParticipant(box);
  assert.match(box.innerHTML, /참가 신청/);
  ETKO.homeParticipantId = 'ghost';
  const box2 = { innerHTML: '' };
  ETKO.renderParticipant(box2);
  assert.match(box2.innerHTML, /참가 신청/);
});

test('operator roster heading names the managed list', () => {
  const ETKO = fresh();
  const box = { innerHTML: '' };
  ETKO.renderPeople(box);
  assert.match(box.innerHTML, /참가자 명단/, 'roster misses the operator-list heading');
  assert.match(box.innerHTML, /참가 신청은 참가자 웹/, 'roster misses the self-service pointer');
});

test('participant directory keeps actions but shows table on desktop and cards on mobile', () => {
  const ETKO = fresh();
  const box = { innerHTML: '' };
  ETKO.renderPeople(box);
  assert.match(box.innerHTML, /<table/);
  assert.match(box.innerHTML, /class="cards"/);
  assert.match(box.innerHTML, /data-detail=/);
  assert.match(box.innerHTML, /data-bulk-in/);

  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'theme.css'), 'utf8');
  assert.match(css, /#participants-view\s+#people-list\s*>\s*\.cards\s*\{[^}]*display:\s*none/);
  assert.match(css, /@media\s*\(max-width:\s*800px\)[\s\S]*?#participants-view\s+#people-list\s*>\s*\.table-wrap\s*\{[^}]*display:\s*none/);
  assert.match(css, /@media\s*\(max-width:\s*800px\)[\s\S]*?#participants-view\s+#people-list\s*>\s*\.cards\s*\{[^}]*display:\s*grid/);
});

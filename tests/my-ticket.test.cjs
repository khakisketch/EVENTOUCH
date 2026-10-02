const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/registration.js', '../features/booth.js', '../features/booths.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  globalThis.ETKO = {};
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('findMyTicket returns my own record by exact name+phone', () => {
  const ETKO = fresh();
  const mine = ETKO.registerSelf({ name: '본인참가', phone: '010-0000-0401' });
  ETKO.registerSelf({ name: '다른참가', phone: '010-0000-0402' });
  const found = ETKO.findMyTicket({ name: '  본인참가 ', phone: '010-0000-0401' });
  assert.equal(found.id, mine.id);
  assert.equal(found.code, mine.code);
});

test('findMyTicket refuses unknown or cancelled records in Korean', () => {
  const ETKO = fresh();
  const mine = ETKO.registerSelf({ name: '취소참가', phone: '010-0000-0403' });
  assert.throws(() => ETKO.findMyTicket({ name: '없는참가', phone: '010-0000-0403' }), /등록 정보/);
  assert.throws(() => ETKO.findMyTicket({ name: '본인참가', phone: '010-0000-0401' }), /등록 정보/);
  mine.cancelled = true;
  assert.throws(() => ETKO.findMyTicket({ name: '취소참가', phone: '010-0000-0403' }), /등록 정보/);
});

function outerStub() {
  const embeds = {};
  const box = {
    innerHTML: '',
    querySelector(sel) {
      if (!embeds[sel]) embeds[sel] = { innerHTML: '', querySelector() { return null; }, querySelectorAll() { return []; } };
      return embeds[sel];
    },
  };
  return { box, embeds };
}

test('participant home without selection shows lookup, never another ticket', () => {
  const ETKO = fresh();
  const { box, embeds } = outerStub();
  ETKO.renderParticipant(box);
  assert.match(embeds['[data-lookup-embed]'].innerHTML, /내 티켓 찾기/);
  assert.match(box.innerHTML, /본인 티켓만/);
  assert.doesNotMatch(box.innerHTML, /내 스탬프/);
  assert.doesNotMatch(box.innerHTML, /체크인 QR 코드/);
});

test('stale selection shows lookup instead of the first record', () => {
  const ETKO = fresh();
  ETKO.homeParticipantId = 'ghost';
  const { box, embeds } = outerStub();
  ETKO.renderParticipant(box);
  assert.equal(ETKO.homeParticipantId, null);
  assert.match(embeds['[data-lookup-embed]'].innerHTML, /내 티켓 찾기/);
  assert.doesNotMatch(box.innerHTML, /체크인 QR 코드/);
});

test('lookup receive binds my ticket and shows it', () => {
  const ETKO = fresh();
  const mine = ETKO.registerSelf({ name: '찾기참가', phone: '010-0000-0404' });
  const handlers = {};
  const lookupBox = {
    innerHTML: '',
    querySelectorAll(sel) {
      if (sel !== '[data-lookup-submit]') return [];
      return [{ tagName: 'BUTTON', getAttribute() { return ''; }, addEventListener(t, fn) { handlers.find = fn; } }];
    },
    querySelector(sel) {
      if (/data-lookup-name/.test(sel)) return { value: '찾기참가' };
      if (/data-lookup-phone/.test(sel)) return { value: '010-0000-0404' };
      return null;
    },
  };
  const outer = { innerHTML: '', querySelector(s) { return /data-lookup-embed/.test(s) ? lookupBox : null; } };
  ETKO.renderParticipant(outer);
  assert.ok(handlers.find, 'find must wire');
  handlers.find();
  assert.equal(ETKO.homeParticipantId, mine.id);
  assert.match(outer.innerHTML, new RegExp(mine.code));
});

test('lookup receive with a bad record surfaces a Korean alert', () => {
  const ETKO = fresh();
  ETKO.registerSelf({ name: '찾기참가', phone: '010-0000-0405' });
  const handlers = {};
  const lookupBox = {
    innerHTML: '',
    querySelectorAll(sel) {
      if (sel !== '[data-lookup-submit]') return [];
      return [{ tagName: 'BUTTON', getAttribute() { return ''; }, addEventListener(t, fn) { handlers.find = fn; } }];
    },
    querySelector(sel) {
      if (/data-lookup-name/.test(sel)) return { value: '없는사람' };
      if (/data-lookup-phone/.test(sel)) return { value: '010-0000-0405' };
      return null;
    },
  };
  const outer = { innerHTML: '', querySelector(s) { return /data-lookup-embed/.test(s) ? lookupBox : null; } };
  ETKO.renderParticipant(outer);
  handlers.find();
  assert.ok(!ETKO.homeParticipantId);
  assert.match(ETKO.lastLookupError, /등록 정보/);
});

test('event switch clears the lookup error', () => {
  const ETKO = fresh();
  ETKO.lastLookupError = '등록 정보를 찾을 수 없습니다';
  const id = ETKO.createEvent({ name: '다음행사', date: '2026-12-01', venue: 'B홀' });
  ETKO.switchEvent(id);
  assert.equal(ETKO.lastLookupError, null);
});

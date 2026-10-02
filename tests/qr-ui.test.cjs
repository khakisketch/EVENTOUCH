const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/qrcode.js', '../features/registration.js', '../features/booth.js', '../features/booths.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  delete globalThis.ETQR;
  globalThis.ETKO = {};
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('participant ticket renders a scannable QR of the ticket code', () => {
  const ETKO = fresh();
  const mine = ETKO.registerSelf({ name: 'QR참가', phone: '010-0000-0601' });
  ETKO.homeParticipantId = mine.id;
  const box = { innerHTML: '', querySelector() { return null; } };
  ETKO.renderParticipant(box);
  assert.match(box.innerHTML, /<svg[^>]*viewBox="0 0 29 29"/);
  assert.match(box.innerHTML, new RegExp(mine.code));
});

test('signup success renders a scannable QR of the issued ticket', () => {
  const ETKO = fresh();
  ETKO.lastSignupTicket = 'EVT-1001';
  const box = { innerHTML: '', querySelector() { return null; }, querySelectorAll() { return []; } };
  ETKO.renderSignup(box);
  assert.match(box.innerHTML, /<svg[^>]*viewBox="0 0 29 29"/);
  ETKO.lastSignupTicket = null;
});

test('QR figures are size-capped by stylesheet', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'tokens.css'), 'utf8');
  assert.match(css, /\.qr svg[\s\S]*?width:\s*180px/);
  assert.match(css, /\.qr svg[\s\S]*?max-width:\s*100%/);
});

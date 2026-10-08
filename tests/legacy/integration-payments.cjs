// Historical ETKO payment-intent characterization, superseded by the v9
// PostgreSQL product and the approved payment-simulation UI removal (c92915e).
// Non-runnable text reference: original imports/startup paths remain unchanged.
// Not a current product acceptance suite; do not silently re-enable.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  const files = ['../app.js', '../features/agency.js', '../features/integrations.js'];
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  for (const m of files) require(m);
  return globalThis.ETKO;
}

test('payment intents are simulated and never charged', () => {
  const ETKO = fresh();
  const intent = ETKO.createPaymentIntent({ amount: 5000, description: '참가비' });
  assert.equal(intent.status, 'SIMULATION_ONLY');
  assert.equal(intent.charged, false);
  assert.equal(intent.amount, 5000);
  assert.equal(ETKO.paymentStatus(intent.id).id, intent.id);
});

test('intents are scoped to the active event', () => {
  const ETKO = fresh();
  const a = ETKO.createPaymentIntent({ amount: 1000 });
  assert.equal(ETKO.paymentStatus(a.id).amount, 1000);
  const id2 = ETKO.createEvent({ name: '제2행사', date: '2026-11-01', venue: 'B홀' });
  ETKO.switchEvent(id2);
  assert.throws(() => ETKO.paymentStatus(a.id), /결제 내역/);
});
test('bad amounts and unknown intents are rejected in Korean', () => {
  const ETKO = fresh();
  assert.throws(() => ETKO.createPaymentIntent({ amount: 12.5 }), /결제 금액/);
  assert.throws(() => ETKO.paymentStatus('pi-999'), /결제 내역/);
});
